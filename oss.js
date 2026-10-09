/* =====================================================================
 * 理记 · 轻享版 —— 对象存储客户端（零依赖）
 * ---------------------------------------------------------------------
 * 轻享版没有服务端，文档存本机；「云端」由用户自己的对象存储承担。
 * 浏览器（含桌面端窗口）直连对象存储，签名在本地算完再发，不走任何中转。
 *
 * 已支持三家协议：
 *   s3  —— AWS S3 / MinIO / Cloudflare R2 / 自建 Ceph（AWS SigV4）
 *   oss —— 阿里云 OSS（V1 签名，另提供 V4 供新地域 bucket 使用）
 *   cos —— 腾讯云 COS（q-sign-algorithm=sha1）
 *
 * 设计要点（都是踩过或必然踩的坑，别简化掉）：
 *   1. 变化检测以 **meta.json 为准**，不依赖 ETag / Last-Modified。
 *      理由：跨域读不到 ETag —— 它不在默认暴露头里，要用户在 bucket 上
 *      额外配 Expose-Headers；多配一项就多一批「配好了但连不上」的工单。
 *      meta.json 是普通对象，GET 就能拿到，零额外配置。
 *   2. 规范路径 canonicalPath() 只算一次，签名与 URL 共用 ——
 *      三家各写一份必然写歪（pathStyle / 编码 / 前缀，「签名对不上」的头号成因）。
 *   3. 签名时间一律用本地时钟；时钟偏太多服务端会直接 403，
 *      所以错误信息里要点名「本机时间不对」，别只回一个 403。
 *   4. crypto.subtle 只在安全上下文可用（https / localhost / file://）。
 *      万一拿不到（老 Electron、被改过的安全策略），回退到本文件里的纯 JS
 *      摘要实现 —— 宁可多 200 行，也不能让「配好了却签不出名」。
 * ===================================================================== */
(function () {
  'use strict';

  /* ============================== 基础工具 ============================== */
  const enc = new TextEncoder();
  const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  function utf8(s) { return enc.encode(String(s === undefined || s === null ? '' : s)); }
  function toHex(u8) {
    let out = '';
    for (let i = 0; i < u8.length; i++) out += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
    return out;
  }
  function toB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function fromB64(b64) {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function fromHex(hex) {
    const u = new Uint8Array(Math.floor(hex.length / 2));
    for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.substr(i * 2, 2), 16);
    return u;
  }
  /* RFC 3986：S3 要求 !'()* 也编码，encodeURIComponent 不管这几个 */
  function rfc3986(s) {
    return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }
  /* 对象 key 按段编码，段间的 '/' 必须保留 —— 整串编码会把目录吃掉 */
  function encodePath(p) {
    return String(p === undefined || p === null ? '' : p).split('/').map(rfc3986).join('/');
  }
  /* 规范查询串：按 key 排序，key / value 都编码（三家一致） */
  function canonicalQuery(qs) {
    const out = [];
    Object.keys(qs || {}).sort().forEach(k => {
      const v = qs[k];
      out.push(rfc3986(k) + '=' + rfc3986(v === undefined || v === null ? '' : v));
    });
    return out.join('&');
  }
  function trimSlash(s) { return String(s || '').replace(/\/+$/, ''); }
  function hostOf(url) {
    try { return new URL(url).host; } catch (e) { return String(url).replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /* S3 / OSS V4 用的紧凑时间：20261005T153400Z */
  function compactTime(d) {
    return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + 'T'
      + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
  }
  function httpDate(d) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return days[d.getUTCDay()] + ', ' + pad2(d.getUTCDate()) + ' ' + mon[d.getUTCMonth()] + ' '
      + d.getUTCFullYear() + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) + ' GMT';
  }
  /* 头名统一小写、值去首尾空格 —— 签名算的和实际发的必须是同一串 */
  function lowerHeaders(h) {
    const out = {};
    Object.keys(h || {}).forEach(k => { out[String(k).toLowerCase()] = String(h[k]).trim(); });
    return out;
  }

  /* ============================== 摘要：优先 Web Crypto，回退纯 JS ============================== */
  let subtleOk = null;
  function hasSubtle() {
    if (subtleOk !== null) return subtleOk;
    try {
      subtleOk = typeof crypto !== 'undefined' && !!crypto.subtle
        && typeof crypto.subtle.importKey === 'function';
    } catch (e) { subtleOk = false; }
    return subtleOk;
  }

  /* ---- 纯 JS SHA-256 ---- */
  const K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function sha256Bytes(msg) {
    const m = (msg instanceof Uint8Array) ? msg : utf8(msg);
    const len = m.length;
    const blocks = Math.ceil((len + 9) / 64) * 64;
    const buf = new Uint8Array(blocks);
    buf.set(m); buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    const bitLen = len * 8;
    dv.setUint32(blocks - 4, bitLen >>> 0);
    dv.setUint32(blocks - 8, Math.floor(bitLen / 4294967296));
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Uint32Array(64);
    for (let i = 0; i < blocks; i += 64) {
      for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
      for (let t = 16; t < 64; t++) {
        const s0 = ((w[t - 15] >>> 7) | (w[t - 15] << 25)) ^ ((w[t - 15] >>> 18) | (w[t - 15] << 14)) ^ (w[t - 15] >>> 3);
        const s1 = ((w[t - 2] >>> 17) | (w[t - 2] << 15)) ^ ((w[t - 2] >>> 19) | (w[t - 2] << 13)) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let t = 0; t < 64; t++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K256[t] + w[t]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    const out = new Uint8Array(32), ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
    return out;
  }
  /* ---- 纯 JS SHA-1 ---- */
  function sha1Bytes(msg) {
    const m = (msg instanceof Uint8Array) ? msg : utf8(msg);
    const len = m.length;
    const blocks = Math.ceil((len + 9) / 64) * 64;
    const buf = new Uint8Array(blocks);
    buf.set(m); buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    const bitLen = len * 8;
    dv.setUint32(blocks - 4, bitLen >>> 0);
    dv.setUint32(blocks - 8, Math.floor(bitLen / 4294967296));
    const H = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    const w = new Uint32Array(80);
    for (let i = 0; i < blocks; i += 64) {
      for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
      for (let t = 16; t < 80; t++) {
        const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
        w[t] = ((x << 1) | (x >>> 31)) >>> 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4];
      for (let t = 0; t < 80; t++) {
        const f = t < 20 ? ((b & c) | (~b & d)) : (t < 40 ? (b ^ c ^ d) : (t < 60 ? ((b & c) | (b & d) | (c & d)) : (b ^ c ^ d)));
        const k = t < 20 ? 0x5A827999 : (t < 40 ? 0x6ED9EBA1 : (t < 60 ? 0x8F1BBCDC : 0xCA62C1D6));
        const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
        e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = tmp;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0;
      H[3] = (H[3] + d) >>> 0; H[4] = (H[4] + e) >>> 0;
    }
    const out = new Uint8Array(20), ov = new DataView(out.buffer);
    for (let i = 0; i < 5; i++) ov.setUint32(i * 4, H[i]);
    return out;
  }
  /* ---- HMAC：块长 64，超长 key 先摘要 ---- */
  function hmacJs(hashFn, keyBytes, msgBytes) {
    let key = (keyBytes instanceof Uint8Array) ? keyBytes : utf8(keyBytes);
    if (key.length > 64) key = hashFn(key);
    const inner = hashFn(new Uint8Array(0));
    const ipad = new Uint8Array(64 + msgBytes.length);
    const opad = new Uint8Array(64 + inner.length);
    for (let i = 0; i < 64; i++) { ipad[i] = 0x36; opad[i] = 0x5c; }
    for (let i = 0; i < key.length; i++) { ipad[i] ^= key[i]; opad[i] ^= key[i]; }
    ipad.set(msgBytes instanceof Uint8Array ? msgBytes : utf8(msgBytes), 64);
    opad.set(hashFn(ipad), 64);
    return hashFn(opad);
  }
  async function hmac(hashName, keyBytes, msg) {
    const kb = (keyBytes instanceof Uint8Array) ? keyBytes : utf8(keyBytes);
    const mb = (msg instanceof Uint8Array) ? msg : utf8(msg);
    if (hasSubtle()) {
      try {
        const k = await crypto.subtle.importKey('raw', kb, { name: 'HMAC', hash: { name: hashName } }, false, ['sign']);
        return new Uint8Array(await crypto.subtle.sign('HMAC', k, mb));
      } catch (e) { /* 落回纯 JS */ }
    }
    return hashName === 'SHA-1' ? hmacJs(sha1Bytes, kb, mb) : hmacJs(sha256Bytes, kb, mb);
  }
  async function digestHex(hashName, msg) {
    const mb = (msg instanceof Uint8Array) ? msg : utf8(msg);
    if (hasSubtle()) {
      try { return toHex(new Uint8Array(await crypto.subtle.digest({ name: hashName }, mb))); }
      catch (e) { /* 落回纯 JS */ }
    }
    return toHex(hashName === 'SHA-1' ? sha1Bytes(mb) : sha256Bytes(mb));
  }
  async function hmacB64(hashName, keyBytes, msg) { return toB64(await hmac(hashName, keyBytes, msg)); }
  async function hmacHex(hashName, keyBytes, msg) { return toHex(await hmac(hashName, keyBytes, msg)); }

  /* ============================== 配置 ============================== */
  const PROVIDERS = {
    s3: { name: 'S3 兼容（AWS / MinIO / R2）' },
    oss: { name: '阿里云 OSS' },
    cos: { name: '腾讯云 COS' }
  };
  function normalize(cfg) {
    const c = cfg || {};
    const provider = PROVIDERS[c.provider] ? c.provider : 's3';
    return {
      provider: provider,
      endpoint: String(c.endpoint || '').trim(),
      region: String(c.region || '').trim(),
      bucket: String(c.bucket || '').trim(),
      ak: String(c.ak || '').trim(),
      sk: String(c.sk || '').trim(),
      prefix: String(c.prefix === undefined || c.prefix === null ? 'liji/' : c.prefix).trim(),
      /* S3 里自建 MinIO / Ceph 多半只认路径风格；OSS / COS 默认虚拟主机风格 */
      pathStyle: !!c.pathStyle,
      /* 阿里云新地域的 bucket 会拒 V1 签名（400 SignatureVersionNotSupported） */
      ossSign: (c.ossSign === 'v4') ? 'v4' : 'v1',
      sessionToken: String(c.sessionToken || '').trim()
    };
  }
  function validate(cfg) {
    const c = normalize(cfg);
    if (!c.bucket) return { ok: false, msg: '请填写 Bucket 名称' };
    if (!c.ak || !c.sk) return { ok: false, msg: '请填写 AccessKey ID 与 Secret' };
    if (c.provider === 'cos') {
      if (!c.region && !c.endpoint) return { ok: false, msg: '腾讯云 COS 需要填地域（如 ap-guangzhou）' };
    } else if (!c.endpoint && !c.region) {
      return { ok: false, msg: '请填写 Endpoint（或至少填地域）' };
    }
    return { ok: true, msg: '' };
  }
  function baseHost(c) {
    let ep = c.endpoint;
    if (!ep) {
      if (c.provider === 'oss') ep = 'https://oss-' + (c.region || 'cn-hangzhou') + '.aliyuncs.com';
      else if (c.provider === 'cos') ep = 'https://cos.' + (c.region || 'ap-guangzhou') + '.myqcloud.com';
      else ep = 'https://s3.' + (c.region || 'us-east-1') + '.amazonaws.com';
    }
    if (!/^https?:\/\//i.test(ep)) ep = 'https://' + ep;
    return trimSlash(ep);
  }
  /* ★ 规范路径：只在这里算一次，签名与 URL 共用（见文件头第 2 条）。
   *   key 传**未编码**的完整对象名（含 prefix）；输出已按段编码、不含 query。 */
  function canonicalPath(c, key) {
    const body = '/' + encodePath(key);
    return c.pathStyle ? '/' + rfc3986(c.bucket) + body : body;
  }
  /* 完整 URL：虚拟主机风格 = bucket 提到域名前缀；路径风格 = 跟在域名后面 */
  function objectUrl(c, key, query) {
    const base = baseHost(c);
    let host = base;
    if (!c.pathStyle) host = base.replace(hostOf(base), c.bucket + '.' + hostOf(base));
    const qs = canonicalQuery(query);
    return host + canonicalPath(c, key) + (qs ? '?' + qs : '');
  }
  function fullKey(c, key) {
    const p = String(c.prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
    return (p ? p + '/' : '') + String(key).replace(/^\/+/, '');
  }
  function keyOf(c, name) { return fullKey(normalize(c), name); }

  /* ============================== 三家签名 ==============================
   * 入参统一：(cfg, method, url, cpath, query, headers, payloadHash)
   * 出参：要发出去的头（含 authorization）。host 由调用方摘掉（浏览器不让设）。
   * ==================================================================== */
  async function signS3(c, method, url, cpath, query, headers, payloadHash) {
    const u = new URL(url);
    const now = new Date();
    const amzDate = compactTime(now);
    const dateStamp = amzDate.slice(0, 8);
    const region = c.region || 'us-east-1';
    const h = lowerHeaders(headers);
    h['host'] = u.host;
    h['x-amz-content-sha256'] = payloadHash;
    h['x-amz-date'] = amzDate;
    if (c.sessionToken) h['x-amz-security-token'] = c.sessionToken;
    const signedKeys = Object.keys(h).sort();
    const canonicalHeaders = signedKeys.map(k => k + ':' + h[k] + '\n').join('');
    const canonicalRequest = [method, cpath, canonicalQuery(query),
      canonicalHeaders, signedKeys.join(';'), payloadHash].join('\n');
    const scope = dateStamp + '/' + region + '/s3/aws4_request';
    const sts = ['AWS4-HMAC-SHA256', amzDate, scope, await digestHex('SHA-256', canonicalRequest)].join('\n');
    let k = utf8('AWS4' + c.sk);
    const parts = [dateStamp, region, 's3', 'aws4_request'];
    for (let i = 0; i < parts.length; i++) k = await hmac('SHA-256', k, parts[i]);
    const sig = await hmacHex('SHA-256', k, sts);
    const out = Object.assign({}, h);
    out['authorization'] = 'AWS4-HMAC-SHA256 Credential=' + c.ak + '/' + scope
      + ', SignedHeaders=' + signedKeys.join(';') + ', Signature=' + sig;
    return out;
  }

  /* 阿里云 OSS 签名 V1：VERB + MD5 + Content-Type + Date + x-oss-* 头 + 资源路径
   * ★ CanonicalizedOSSHeaders 和 CanonicalizedResource 之间**没有**分隔换行：
   *   头行自带的行尾 \n 就是它们的分隔（2026-10-07 踩过：join('\n') 多出一个 \n，
   *   真桶 403 SignatureDoesNotMatch，服务端回显 StringToSign 与我们的一比对就现形）。 */
  async function signOssV1(c, method, url, cpath, query, headers, payloadHash, _now) {
    const date = httpDate(_now || new Date());
    const h = lowerHeaders(headers);
    h['x-oss-date'] = date;                       // 用它代替 Date 头：少一个要被 CORS 放行的头
    if (c.sessionToken) h['x-oss-security-token'] = c.sessionToken;
    const ossHeaders = Object.keys(h).filter(k => k.indexOf('x-oss-') === 0)
      .sort().map(k => k + ':' + h[k] + '\n').join('');
    /* ★ CanonicalizedResource 只签**白名单子资源**（versions / versionId / acl / response-* 等），
     *   按 key 排序、有值带值无值只写 key —— prefix / max-keys 这类普通 query 参数**不进**签名。
     *   （2026-10-09 真桶验证抓到：第一版把全部 query 都拼进去，?versions 一上就 SignatureDoesNotMatch。
     *   注意这与 S3 SigV4 / 阿里 V4 的「全量 query 参与签名」口径相反，别互相照抄。） */
    /* ★ CanonicalizedResource 里的对象路径用**解码后**的原始 key（服务端先把收到的
     *   URL 路径 decode 再验签）：ASCII key 编码前后恰好相等，所以纯英文名一直没暴露；
     *   中文 / 空格 / 全角字符的 key 按编码路径签就是 403 SignatureDoesNotMatch
     *   （2026-10-09 源文件镜像全线失败踩到，真桶变体对拍确认：编码签 403、解码签 OK）。
     *   bucket 段是字母数字与连字符，解码不受影响。 */
    let resource = '/' + c.bucket + decodeURIComponent(cpath);
    const SUBRES = {};
    ['acl', 'uploads', 'location', 'cors', 'logging', 'website', 'referer', 'lifecycle', 'delete',
      'append', 'tagging', 'objectMeta', 'uploadId', 'partNumber', 'security-token', 'position',
      'img', 'style', 'styleName', 'replication', 'replicationProgress', 'replicationLocation',
      'cname', 'bucketInfo', 'comp', 'requestPayment', 'x-oss-traffic-limit', 'versions', 'versionId'
    ].forEach(k => { SUBRES[k] = true; });
    const subKeys = Object.keys(query || {}).filter(k => SUBRES[k] === true || k.indexOf('response-') === 0).sort();
    if (subKeys.length) resource += '?' + subKeys.map(k => k + (query[k] === '' ? '' : '=' + String(query[k]))).join('&');
    const strToSign = [method, '', h['content-type'] || '', date, ossHeaders].join('\n') + resource;
    const sig = await hmacB64('SHA-1', c.sk, strToSign);
    const out = Object.assign({}, h);
    out['authorization'] = 'OSS ' + c.ak + ':' + sig;
    return out;
  }

  /* 阿里云 OSS 签名 V4：与 SigV4 同构，换前缀、换头名。
   * ★ 与 AWS SigV4 相反：Canonical URI **必须带 bucket 前缀**（/bucket/key），
   *   哪怕 URL 是虚拟主机风格（2026-10-07 踩过：用 cpath 少了 /bucket，403）。
   * ★ x-oss-content-sha256 只认「UNSIGNED-PAYLOAD」（真桶实测：填真实 payload 哈希 400）。
   * ★ content-type / x-oss-* 本来就自动参与签名，AdditionalHeaders 留空并整体省略
   *   （照抄 ali-oss SDK 的 fixAdditionalHeaders：它把 x-oss-* 全过滤掉）。 */
  async function signOssV4(c, method, url, cpath, query, headers, payloadHash, _now) {
    const now = _now || new Date();
    const ts = compactTime(now);
    const dateStamp = ts.slice(0, 8);
    const region = c.region || 'cn-hangzhou';
    const h = lowerHeaders(headers);
    h['x-oss-content-sha256'] = 'UNSIGNED-PAYLOAD';
    h['x-oss-date'] = ts;
    if (c.sessionToken) h['x-oss-security-token'] = c.sessionToken;
    const signedKeys = Object.keys(h).sort();
    const canonicalHeaders = signedKeys.map(k => k + ':' + h[k] + '\n').join('');
    const uri = c.pathStyle ? cpath : '/' + c.bucket + cpath;
    const canonicalRequest = [method, uri, canonicalQuery(query),
      canonicalHeaders, '', 'UNSIGNED-PAYLOAD'].join('\n');
    const scope = dateStamp + '/' + region + '/oss/aliyun_v4_request';
    const sts = ['OSS4-HMAC-SHA256', ts, scope, await digestHex('SHA-256', canonicalRequest)].join('\n');
    let k = utf8('aliyun_v4' + c.sk);
    const parts = [dateStamp, region, 'oss', 'aliyun_v4_request'];
    for (let i = 0; i < parts.length; i++) k = await hmac('SHA-256', k, parts[i]);
    const sig = await hmacHex('SHA-256', k, sts);
    const out = Object.assign({}, h);
    out['authorization'] = 'OSS4-HMAC-SHA256 Credential=' + c.ak + '/' + scope + ', Signature=' + sig;
    return out;
  }

  /* 腾讯云 COS：sha1 + KeyTime 派生签名密钥；
   * 参与签名的头只放 content-type 与 host —— 放得越多，CORS 要放行的头越多。 */
  async function signCos(c, method, url, cpath, query, headers, payloadHash) {
    const u = new URL(url);
    const nowSec = Math.floor(Date.now() / 1000);
    const keyTime = (nowSec - 60) + ';' + (nowSec + 3600);
    const h = lowerHeaders(headers);
    /* ★ q-header-list 必须与「实际发出去的头」完全一致：腾讯服务端按它收到的头重算签名，
     *   头列表对不上就是 403 SignatureNotMatch。GET / HEAD / DELETE 没有 body、不发 content-type，
     *   所以这里不能无条件把 content-type 签进去 —— 只签真实存在的头（host 浏览器自动带）。 */
    const signed = { host: u.host };
    if (h['content-type'] !== undefined) signed['content-type'] = h['content-type'];
    const signKeys = Object.keys(signed).sort();
    const httpHeaders = signKeys.map(k => k + '=' + rfc3986(signed[k])).join('&');
    /* ★ COS 官方 SDK 签名时把 URL 参数名统一小写（versionId→versionid），HttpString
     *   的参数行与 q-url-param-list 都用小写 key —— 大小写不一致就是 403。
     *   URL 里发送的参数名保持原样（服务端收得到），只在签名口径上小写。 */
    const cosParams = {};
    Object.keys(query || {}).forEach(k => { cosParams[String(k).toLowerCase()] = query[k]; });
    const paramKeys = Object.keys(cosParams).sort();
    const paramLine = paramKeys
      .map(k => rfc3986(k) + '=' + rfc3986(cosParams[k] === undefined || cosParams[k] === null ? '' : cosParams[k]))
      .join('&');
    const httpString = [method.toLowerCase(), cpath, paramLine, httpHeaders, ''].join('\n');
    const stringToSign = ['sha1', keyTime, await digestHex('SHA-1', httpString), ''].join('\n');
    const signKey = await hmacHex('SHA-1', c.sk, keyTime);
    /* ★ COS 与 S3 V4 的关键差异：第二次 HMAC 的密钥是 SignKey 的**十六进制字符串本身**
     *   （官方文档步骤四原文：「以 SignKey 为密钥（字符串形式，非原始二进制）」）。
     *   之前按 S3 习惯 fromHex 解码成原始字节，真桶实测 403 SignatureDoesNotMatch。 */
    const sig = await hmacHex('SHA-1', utf8(signKey), stringToSign);
    const out = Object.assign({}, h);
    out['authorization'] = ['q-sign-algorithm=sha1', 'q-ak=' + c.ak, 'q-sign-time=' + keyTime,
      'q-key-time=' + keyTime, 'q-header-list=' + signKeys.join(';'), 'q-url-param-list=' + paramKeys.join(';'),
      'q-signature=' + sig].join('&');
    return out;
  }

  /* ============================== 请求 ============================== */
  /* 服务端的错误是 XML；翻成人话，别让用户对着一段 XML 猜。
   * ★ Code 和 Message 要**各自单独**提取：旧写法的正则交替项里有 Error，
   *   会先匹配到外层 <Error> 开标签、把整段内层 XML 当成 Message 带进文案。 */
  function parseErr(text, status) {
    let msg = '';
    try {
      const c = /<Code>([\s\S]*?)<\/Code>/i.exec(text);
      const m = /<Message>([\s\S]*?)<\/Message>/i.exec(text);
      if (c) msg = c[1].trim() + (m ? ' · ' + m[1].trim() : '');
      else if (m) msg = m[1].trim();
    } catch (e) { }
    if (!msg) msg = String(text || '').slice(0, 200);
    return { status: status, msg: msg };
  }
  /* 403 的几种常见成因得分开说，否则用户只会一遍遍检查密钥 */
  function humanError(status, msg) {
    const m = String(msg || '');
    if (/RequestTimeTooSkewed/i.test(m)) return '本机时间与服务端差太多 —— 请同步系统时间后重试。（' + m + '）';
    if (/SignatureVersionNotSupported/i.test(m)) return '这个 Bucket 要求 V4 签名 —— 在配置里把「OSS 签名版本」切成 V4。（' + m + '）';
    if (status === 403 || /SignatureDoesNotMatch|AccessDenied|InvalidAccessKeyId|SignatureNotMatch/i.test(m)) {
      return '密钥不对、或本机时间与标准时间差太多（对象存储要求误差在 15 分钟内）。（' + m + '）';
    }
    if (/NoSuchBucket/i.test(m)) return 'Bucket 不存在 —— 检查名称与地域是否匹配。（' + m + '）';
    if (status === 404 || /NoSuchKey/i.test(m)) return '对象不存在（' + (m || '404') + '）';
    if (status === 0) return '连不上：多半是跨域（CORS）没配，或地址写错。请在控制台给这个 Bucket 放行本页来源，并允许 GET / PUT / HEAD / DELETE。（' + m + '）';
    if (status >= 500) return '服务端返回 ' + status + '（' + m + '）';
    return m || ('请求失败 ' + status);
  }
  /* 浏览器不让脚本设这几个头（静默丢弃、还可能触发预检失败），签完就摘掉 */
  function noForbidden(h) {
    const out = {};
    Object.keys(h).forEach(k => {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'content-length' || lk === 'connection') return;
      out[k] = h[k];
    });
    return out;
  }
  async function request(c, method, key, body, extraQuery) {
    const cfg = normalize(c);
    const v = validate(cfg);
    if (!v.ok) throw new Error(v.msg);
    const k = fullKey(cfg, key);
    const url = objectUrl(cfg, k, extraQuery);
    const cpath = canonicalPath(cfg, k);
    const query = extraQuery || {};
    const hasBody = !(body === undefined || body === null);
    const baseHeaders = {};
    if (hasBody) baseHeaders['content-type'] = 'application/json; charset=utf-8';
    const payloadHash = hasBody
      ? await digestHex('SHA-256', body instanceof Uint8Array ? body : utf8(body))
      : (cfg.provider === 's3' ? EMPTY_SHA256 : EMPTY_SHA256);

    let headers;
    if (cfg.provider === 'oss') {
      headers = cfg.ossSign === 'v4'
        ? await signOssV4(cfg, method, url, cpath, query, baseHeaders, payloadHash)
        : await signOssV1(cfg, method, url, cpath, query, baseHeaders, payloadHash);
    } else if (cfg.provider === 'cos') {
      headers = await signCos(cfg, method, url, cpath, query, baseHeaders, payloadHash);
    } else {
      headers = await signS3(cfg, method, url, cpath, query, baseHeaders, payloadHash);
    }

    let res, text = '';
    try {
      res = await fetch(url, {
        method: method,
        headers: noForbidden(headers),
        body: hasBody ? (body instanceof Uint8Array ? body : String(body)) : undefined
      });
    } catch (e) {
      /* fetch 直接抛 = 请求没发出去（DNS、CORS 预检失败、混合内容），状态码当作 0 */
      const err = new Error(humanError(0, (e && e.message) ? e.message : '网络错误'));
      err.status = 0; throw err;
    }
    try { text = await res.text(); } catch (e) { text = ''; }
    if (!res.ok) {
      const p = parseErr(text, res.status);
      const err = new Error(humanError(res.status, p.msg));
      err.status = res.status; err.raw = text;
      throw err;
    }
    return {
      ok: true, status: res.status, text: text,
      etag: (res.headers.get('etag') || '').replace(/"/g, ''),
      lastModified: res.headers.get('last-modified') || ''
    };
  }

  /* ============================== 对外 API ============================== */
  async function head(c, key) {
    try {
      const r = await request(c, 'HEAD', key);
      return { ok: true, etag: r.etag, lastModified: r.lastModified, status: r.status };
    } catch (e) {
      if (e.status === 404) return { ok: false, missing: true, msg: '对象不存在' };
      return { ok: false, msg: e.message, status: e.status };
    }
  }
  async function get(c, key) {
    const r = await request(c, 'GET', key);
    return { ok: true, text: r.text, etag: r.etag, lastModified: r.lastModified, status: r.status };
  }
  async function put(c, key, text) {
    const body = (text instanceof Uint8Array) ? text : String(text === undefined || text === null ? '' : text);
    const r = await request(c, 'PUT', key, body);
    return { ok: true, etag: r.etag, status: r.status };
  }
  async function del(c, key) {
    const r = await request(c, 'DELETE', key);
    return { ok: true, status: r.status };
  }
  /* 连通性自检：写入探针再删掉 —— 只读的 HEAD 验不出「能写」 */
  async function test(c) {
    const probe = '__liji_probe__.txt';
    try {
      await put(c, probe, 'ok');
      try { await del(c, probe); } catch (e) { /* 探针残留无妨 */ }
      return { ok: true, msg: '连接成功：读、写、删除都通过' };
    } catch (e) {
      return { ok: false, msg: e.message, status: e.status };
    }
  }

  /* ============================== 版本控制 / 回收站（2026-10-09） ==============================
   * 三家（S3 / 阿里 / 腾讯）的版本列举都是 GET /?versions，返回 S3 兼容的
   * <Version> / <DeleteMarker> 条目；读指定版本 GET ?versionId=…；删指定版本 DELETE ?versionId=…。
   * 「版本控制开着没」没法用管理 API 问（要管理员权限、CORS 也不放行），改用行为探测：
   *   写一个探针对象 → 删掉 → 列举它的版本 —— 开着能看到 Version + DeleteMarker，没开就是空。 */
  function xmlDecode(s) {
    return String(s || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }
  function parseVersions(xml) {
    const out = [];
    const grab = (tag, isMarker) => {
      const re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'g');
      let m;
      while ((m = re.exec(xml)) !== null) {
        const b = m[1];
        const k = /<Key>([\s\S]*?)<\/Key>/.exec(b);
        const vid = /<VersionId>([\s\S]*?)<\/VersionId>/.exec(b);
        const lm = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(b);
        out.push({
          key: xmlDecode(k ? k[1] : ''),
          versionId: xmlDecode(vid ? vid[1] : ''),
          isLatest: /<IsLatest>\s*true\s*<\/IsLatest>/i.test(b),
          lastModified: Date.parse(xmlDecode(lm ? lm[1] : '')) || 0,
          marker: isMarker
        });
      }
    };
    grab('Version', false);
    grab('DeleteMarker', true);
    return out;
  }
  async function listVersions(c, prefix) {
    /* ★ 列举是**桶级**请求：路径必须是 /bucket/?versions（key 路径为空），prefix 只作为
     *   query 参数 —— 把前缀拼进路径的话真桶会当成「列举某个 object」报 NoSuchKey
     *   （2026-10-09 真桶验证抓到；mock 对 versions 分支不看 key，验不出这个差别）。
     *   prefix 参数值仍要带配置前缀（桶里的 key 全名以它开头）。 */
    const cfg = normalize(c);
    const c2 = Object.assign({}, cfg, { prefix: '' });
    const full = fullKey(cfg, prefix || '');
    const r = await request(c2, 'GET', '', null, { 'versions': '', 'max-keys': '1000', 'prefix': full });
    return parseVersions(r.text);
  }
  async function getVersion(c, key, versionId) {
    const r = await request(c, 'GET', key, null, { 'versionId': versionId });
    return { ok: true, text: r.text, status: r.status };
  }
  async function delVersion(c, key, versionId) {
    await request(c, 'DELETE', key, null, { 'versionId': versionId });
    return { ok: true };
  }
  /* 行为探测（见上）：探针留在固定前缀下，有 1 字节残留也无妨（应用自身不用这个前缀）。
   * ★ 列举返回的 Key 带**配置前缀**（如 liji/__liji_probe__/...），而 put/get/del/delVersion
   *   收的是相对 key（内部再补前缀）—— 对比与二次删除前必须先剥掉，否则探针永远判「没开」。 */
  async function probeVersioning(c) {
    const cfg = normalize(c);
    const pre = cfg.prefix || '';
    const strip = k => (k.indexOf(pre) === 0 ? k.slice(pre.length) : k);
    const probe = '__liji_probe__/version.txt';
    await put(c, probe, 'probe');
    try { await del(c, probe); } catch (e) { }
    const list = await listVersions(c, '__liji_probe__/');
    const seen = list.filter(v => strip(v.key) === probe);
    for (let i = 0; i < seen.length; i++) {
      try { await delVersion(c, strip(seen[i].key), seen[i].versionId); } catch (e) { }
    }
    if (seen.some(v => v.marker)) {
      try { await del(c, probe); } catch (e) { }
    }
    return seen.length > 0;
  }

  window.LiJiOSS = {
    PROVIDERS: PROVIDERS,
    normalize: normalize,
    validate: validate,
    objectUrl: objectUrl,
    canonicalPath: canonicalPath,
    keyOf: keyOf,
    head: head,
    get: get,
    put: put,
    del: del,
    test: test,
    listVersions: listVersions,
    getVersion: getVersion,
    delVersion: delVersion,
    probeVersioning: probeVersioning,
    parseVersions: parseVersions,
    cryptoOk: hasSubtle,
    /* 自检要用：把摘要与签名底子暴露出来做离线比对（不联网也能验算法对不对） */
    _sign: {
      hmacHex: hmacHex, hmacB64: hmacB64, digestHex: digestHex,
      compactTime: compactTime, httpDate: httpDate,
      sha1Bytes: sha1Bytes, sha256Bytes: sha256Bytes,
      signCos: signCos, signOssV1: signOssV1, signOssV4: signOssV4
    }
  };
})();
