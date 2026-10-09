/* 本地 S3 模拟服务（仅供自检，不参与交付）
 * ------------------------------------------------------------------
 * 目的：让「签名到底对不对」这件只能靠真实对象存储才能验的事，在本机就能验。
 * 校验逻辑用 Node 内置 crypto **独立**写一遍 SigV4 —— 与 oss.js 不共用任何代码，
 * 两边对上才说明签名确实符合 AWS 规范；共用代码的自检等于没自检。
 *
 * 用法：node tools/mock-s3.js [port]  →  返回 JSON {port}
 * 也作为模块使用：const { start } = require('./mock-s3'); const srv = await start(0);
 */
'use strict';
const http = require('http');
const crypto = require('crypto');

const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

/* 腾讯 COS 用另一对测试密钥（q-sign-algorithm=sha1） */
const COS_ACCESS_KEY = 'AKIDCOSTESTEXAMPLE';
const COS_SECRET_KEY = 'cosSecretTestExample/123';

function rfc3986(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/* 腾讯 COS 验签（按官方算法独立实现，不与 oss.js 共用代码）。
 * ★ 关键判据：q-header-list 必须与**实际收到的头**完全一致 ——
 *   客户端把没发的头签进去（或反过来）就是 403 SignatureNotMatch。 */
function verifyCos(req) {
  const auth = req.headers['authorization'] || '';
  const parts = {};
  auth.split('&').forEach(p => { const i = p.indexOf('='); if (i > 0) parts[p.slice(0, i)] = p.slice(i + 1); });
  if (parts['q-sign-algorithm'] !== 'sha1') return { ok: false, code: 'AccessDenied', msg: '不是 COS 签名格式' };
  if (parts['q-ak'] !== COS_ACCESS_KEY) return { ok: false, code: 'InvalidAccessKeyId', msg: 'AccessKey 不存在' };
  const url = new URL(req.url, 'http://localhost');
  /* ★ q-url-param-list 验证（2026-10-09 回收站功能补的）：官方 SDK 把参数名**统一小写**后参与
   *   签名，HttpString 的参数行也用小写 key。声称列表、参数行、实际 query 三方必须一致。 */
  const params = {};
  Array.from(url.searchParams.keys()).forEach(k => { params[k.toLowerCase()] = url.searchParams.get(k) || ''; });
  const paramKeys = Object.keys(params).sort();
  const claimedParams = (parts['q-url-param-list'] || '').split(';').filter(Boolean);
  if (claimedParams.join(';') !== paramKeys.join(';')) {
    return { ok: false, code: 'SignatureNotMatch', msg: 'q-url-param-list 与实际 query 不一致（声称 [' + claimedParams.join(';') + ']，实际 [' + paramKeys.join(';') + ']）' };
  }
  const paramLine = paramKeys.map(k => rfc3986(k) + '=' + rfc3986(params[k])).join('&');
  const hdrs = { host: req.headers['host'] };
  if (req.headers['content-type'] !== undefined) hdrs['content-type'] = req.headers['content-type'];
  /* COS 规定 x-cos-* 头必须全部参与签名（如 x-cos-acl）——漏签在真桶就是 403 */
  Object.keys(req.headers).forEach(k => {
    if (k.indexOf('x-cos-') === 0) hdrs[k] = req.headers[k];
  });
  const keys = Object.keys(hdrs).sort();
  const claimed = (parts['q-header-list'] || '').split(';').filter(Boolean);
  if (claimed.join(';') !== keys.join(';')) {
    return { ok: false, code: 'SignatureNotMatch', msg: 'q-header-list 与实际头不一致（声称 [' + claimed.join(';') + ']，实际 [' + keys.join(';') + ']）' };
  }
  /* ★ HttpString 的 pathname 用**解码后的原始路径**（2026-10-09 对齐官方 SDK 源码：
   *   cos-js-sdk-v5 util.getAuth 的 formatString 第二段直接放 raw pathname，
   *   中文/空格不编码 —— 编码路径签 ASCII 碰巧相等，中文 key 必 403）。 */
  const httpString = [req.method.toLowerCase(), decodeURIComponent(url.pathname), paramLine, keys.map(k => k + '=' + rfc3986(hdrs[k])).join('&'), ''].join('\n');
  const keyTime = parts['q-sign-time'] || '';
  const stringToSign = ['sha1', keyTime, crypto.createHash('sha1').update(httpString).digest('hex'), ''].join('\n');
  const signKey = crypto.createHmac('sha1', COS_SECRET_KEY).update(keyTime).digest('hex');
  /* ★ 密钥用 SignKey 十六进制字符串本身（COS 规范：字符串形式，非原始二进制） */
  const sig = crypto.createHmac('sha1', Buffer.from(signKey, 'utf8')).update(stringToSign).digest('hex');
  if (sig !== parts['q-signature']) {
    return { ok: false, code: 'SignatureNotMatch', msg: '签名不一致\n  httpString:\n' + httpString + '\n  期望 ' + sig + '\n  收到 ' + parts['q-signature'] };
  }
  return { ok: true };
}

function hmac(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest(); }
function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
/* AWS SigV4 规范：kSecret → kDate → kRegion → kService → kSigning */
function signingKey(sk, dateStamp, region, service) {
  let k = Buffer.from('AWS4' + sk, 'utf8');
  k = hmac(k, dateStamp); k = hmac(k, region); k = hmac(k, service);
  return hmac(k, 'aws4_request');
}

function verify(req, bodyBuf) {
  const auth = req.headers['authorization'] || '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^,]+), ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]+)$/.exec(auth);
  if (!m) return { ok: false, code: 'AccessDenied', msg: '缺少或非法的 Authorization 头：' + auth };
  const credParts = m[1].split('/');
  const ak = credParts[0], dateStamp = credParts[1], region = credParts[2], service = credParts[3];
  const signedHeaders = m[2].split(';');
  const gotSig = m[3];

  if (ak !== ACCESS_KEY) return { ok: false, code: 'InvalidAccessKeyId', msg: 'AccessKey 不存在' };

  const url = new URL(req.url, 'http://localhost');
  const canonicalUri = url.pathname;                       // 客户端已按段编码，原样参与签名
  const canonicalQuery = url.searchParams.toString()
    ? Array.from(url.searchParams.entries()).sort().map(([k, v]) =>
      encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&')
    : '';
  const canonicalHeaders = signedHeaders.map(h => {
    const v = h === 'host' ? req.headers['host'] : req.headers[h];
    return h + ':' + String(v === undefined ? '' : v).trim() + '\n';
  }).join('');
  const payloadHash = req.headers['x-amz-content-sha256'] || sha256hex(Buffer.alloc(0));
  /* 服务端也要验载荷：客户端声称的 hash 与实际 body 不符就是篡改 */
  const realHash = sha256hex(bodyBuf);
  if (payloadHash !== realHash && payloadHash !== 'UNSIGNED-PAYLOAD') {
    return { ok: false, code: 'XAmzContentSHA256Mismatch', msg: '载荷摘要不匹配' };
  }
  const canonicalRequest = [req.method, canonicalUri, canonicalQuery, canonicalHeaders,
    signedHeaders.join(';'), payloadHash].join('\n');
  const scope = [dateStamp, region, service, 'aws4_request'].join('/');
  const sts = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], scope, sha256hex(Buffer.from(canonicalRequest, 'utf8'))].join('\n');
  const want = hmac(signingKey(SECRET_KEY, dateStamp, region, service), sts).toString('hex');
  if (want !== gotSig) {
    return { ok: false, code: 'SignatureDoesNotMatch', msg: '签名不一致\n  canonical:\n' + canonicalRequest + '\n  期望 ' + want + '\n  收到 ' + gotSig };
  }
  return { ok: true };
}

function xmlError(code, msg) {
  return '<?xml version="1.0" encoding="UTF-8"?><Error><Code>' + code + '</Code><Message>'
    + String(msg).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</Message></Error>';
}

/* 跨域：浏览器直连对象存储必须过这一关，真实桶也要在控制台配同样的东西。
 * 放在这里是为了让自检的链路跟真实环境一致（否则浏览器里根本发不出去）。
 * 只需放行 Origin / Methods / Headers —— 不需要 Expose-Headers，
 * 因为变化检测走 meta.json，不读 ETag / Last-Modified。 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,HEAD,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '600'
};

async function start(port) {
  /* key -> 版本数组（时间序）。每条 {vid, body, contentType, marker, lm}：
   * versioning 关着时 PUT 覆盖单条、DELETE 清空；开着时 PUT 追加、DELETE 追加删除标记，
   * 与真实桶的行为一致 —— 回收站的「列删除标记 / 读旧版本 / 删指定版本」就在这条链路上验。 */
  const store = new Map();
  const state = { versioning: false };
  let vidSeq = 0;
  /* ★ S3 语义：对象是否「活着」只看**最后一条**——是删除标记就是删除态，
     不存在「跳过标记拿旧版本」这种读法（旧版本只能靠 versionId 读）。 */
  const LIVE = arr => { const l = arr[arr.length - 1]; return (l && !l.marker) ? l : null; };

  function versionsXml(prefix) {
    const rows = [];
    const keys = Array.from(store.keys()).sort().filter(k => k.indexOf(prefix) === 0);
    keys.forEach(k => {
      const arr = store.get(k) || [];
      /* 桶存的 key 是 URL 编码形态（pathname 原样），列举里还原成 UTF-8（与真桶一致） */
      let raw = k;
      try { raw = decodeURIComponent(k); } catch (e) { }
      arr.forEach((v, i) => {
        const tag = v.marker ? 'DeleteMarker' : 'Version';
        rows.push('<' + tag + '><Key>' + raw.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</Key><VersionId>' + v.vid + '</VersionId>'
          + '<IsLatest>' + (i === arr.length - 1 ? 'true' : 'false') + '</IsLatest>'
          + '<LastModified>' + new Date(v.lm).toISOString() + '</LastModified></' + tag + '>');
      });
    });
    return '<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult>' + rows.join('') + '</ListVersionsResult>';
  }

  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      /* 预检：带自定义签名头的 PUT 一定会先来一次 OPTIONS */
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(''); }
      const bodyBuf = Buffer.concat(chunks);
      const isCos = (req.headers['authorization'] || '').indexOf('q-sign-algorithm=') === 0;
      const v = isCos ? verifyCos(req) : verify(req, bodyBuf);
      if (!v.ok) {
        res.writeHead(403, Object.assign({ 'Content-Type': 'application/xml' }, CORS));
        return res.end(xmlError(v.code, v.msg));
      }
      const url = new URL(req.url, 'http://localhost');
      /* 路径风格：/bucket/key...（第一层是 bucket 名） */
      const key = url.pathname.replace(/^\/+/, '').replace(/^[^/]+\//, '');
      const vid = url.searchParams.get('versionId');
      const wantVersions = url.searchParams.has('versions');

      /* 桶级列举（GET /bucket/?versions&prefix=…）—— 回收站的列表与版本探测走这里。
       * ★ 与真桶同口径：versions 列举只在 key 路径为空时成立（prefix 走 query），
       *   把前缀拼进路径的写法在这里直接 404，跟真桶一样不宽容。 */
      if (req.method === 'GET' && wantVersions && !key) {
        const prefix = url.searchParams.get('prefix') || '';
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/xml' }, CORS));
        return res.end(versionsXml(prefix));
      }
      if (req.method === 'PUT') {
        const entry = { vid: ++vidSeq, body: Buffer.from(bodyBuf), contentType: req.headers['content-type'] || '', marker: false, lm: Date.now() };
        if (!store.has(key)) store.set(key, []);
        const arr = store.get(key);
        if (state.versioning) arr.push(entry);
        else store.set(key, [entry]);
        res.writeHead(200, Object.assign({ ETag: '"' + sha256hex(bodyBuf) + '"' }, CORS));
        return res.end('');
      }
      if (req.method === 'GET') {
        const arr = store.get(key);
        if (vid) {
          const hit = (arr || []).filter(x => String(x.vid) === vid)[0];
          if (!hit || hit.marker) { res.writeHead(404, Object.assign({ 'Content-Type': 'application/xml' }, CORS)); return res.end(xmlError('NoSuchVersion', 'no such version ' + vid)); }
          res.writeHead(200, Object.assign({ ETag: '"' + sha256hex(hit.body) + '"', 'Content-Type': hit.contentType || 'application/octet-stream' }, CORS));
          return res.end(hit.body);
        }
        const live = arr ? LIVE(arr) : null;
        if (!live) { res.writeHead(404, Object.assign({ 'Content-Type': 'application/xml' }, CORS)); return res.end(xmlError('NoSuchKey', 'no such key ' + key)); }
        res.writeHead(200, Object.assign({ ETag: '"' + sha256hex(live.body) + '"', 'Content-Type': live.contentType || 'application/octet-stream' }, CORS));
        return res.end(live.body);
      }
      if (req.method === 'HEAD') {
        const arr = store.get(key);
        const live = arr ? LIVE(arr) : null;
        if (!live) { res.writeHead(404, CORS); return res.end(''); }
        res.writeHead(200, Object.assign({ ETag: '"' + sha256hex(live.body) + '"' }, CORS));
        return res.end('');
      }
      if (req.method === 'DELETE') {
        const arr = store.get(key);
        if (vid) {
          /* 删指定版本：从历史里摘掉那一行（删掉删除标记 = 对象复活） */
          if (arr) store.set(key, arr.filter(x => String(x.vid) !== vid));
          res.writeHead(204, CORS); return res.end('');
        }
        if (state.versioning) {
          if (!arr) { res.writeHead(204, CORS); return res.end(''); }
          arr.push({ vid: ++vidSeq, body: Buffer.alloc(0), contentType: '', marker: true, lm: Date.now() });
        } else {
          store.delete(key);
        }
        res.writeHead(204, CORS); return res.end('');
      }
      res.writeHead(405, CORS); res.end('');
    });
  });
  await new Promise(r => srv.listen(port || 0, '127.0.0.1', r));
  return {
    port: srv.address().port,
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
    cosAccessKey: COS_ACCESS_KEY,
    cosSecretKey: COS_SECRET_KEY,
    url: 'http://127.0.0.1:' + srv.address().port,
    size: () => store.size,
    dump: () => Array.from(store.keys()),
    setVersioning: v => { state.versioning = !!v; },
    versioning: () => state.versioning,
    close: () => new Promise(r => srv.close(r))
  };
}

module.exports = { start, verify, verifyCos, xmlError, ACCESS_KEY, SECRET_KEY, COS_ACCESS_KEY, COS_SECRET_KEY };

if (require.main === module) {
  start(parseInt(process.argv[2], 10) || 0).then(s => {
    console.log(JSON.stringify({ port: s.port, url: s.url, accessKey: s.accessKey, secretKey: s.secretKey }));
  });
}
