/* 离线自检：只验「签名算得对不对」，不联网。
 * 两层：① 与 RFC 4231 / RFC 2202 的标准向量比；② 关掉 crypto.subtle 再跑一遍，
 *       确认纯 JS 回退与 Web Crypto 两条路结果完全一致。 */
'use strict';
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

function loadOss(disableSubtle) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'oss.js'), 'utf8');
  const sandboxWindow = {};
  const run = new Function('window', 'crypto', 'btoa', 'atob', 'TextEncoder', 'URL', 'fetch', src);
  const fakeCrypto = disableSubtle ? {} : globalThis.crypto;
  run(sandboxWindow, fakeCrypto, globalThis.btoa, globalThis.atob, TextEncoder, URL, globalThis.fetch);
  return sandboxWindow.LiJiOSS;
}

let fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) fail++;
  console.log((ok ? '[OK]   ' : '[FAIL] ') + name + (ok ? '' : '\n       got  ' + got + '\n       want ' + want));
}

(async () => {
  /* ---- 交叉比对用的参考实现（Node 内置 OpenSSL，可信） ---- */
  const refHmac = (alg, key, msg) => nodeCrypto.createHmac(alg, Buffer.from(key)).update(Buffer.from(msg)).digest('hex');
  const refDigest = (alg, msg) => nodeCrypto.createHash(alg).update(Buffer.from(msg)).digest('hex');

  for (const mode of [{ subtle: false, tag: '纯JS回退' }, { subtle: true, tag: 'WebCrypto' }]) {
    const OSS = loadOss(mode.subtle);
    const s = OSS._sign;
    console.log('\n===== ' + mode.tag + '（crypto.subtle ' + (mode.subtle ? '可用' : '已禁用') + '）=====');

    /* 标准向量 */
    check('HMAC-SHA256 RFC4231 #1', await s.hmacHex('SHA-256', Buffer.alloc(20, 0x0b), 'Hi There'),
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
    check('HMAC-SHA256 RFC4231 #2', await s.hmacHex('SHA-256', 'Jefe', 'what do ya want for nothing?'),
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
    check('HMAC-SHA1   RFC2202 #1', await s.hmacHex('SHA-1', Buffer.alloc(20, 0x0b), 'Hi There'),
      'b617318655057264e28bc0b6fb378c8ef146be00');
    check('HMAC-SHA1   RFC2202 #2', await s.hmacHex('SHA-1', 'Jefe', 'what do ya want for nothing?'),
      'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79');
    check('SHA-256("abc")', await s.digestHex('SHA-256', 'abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    check('SHA-256("") = 空载荷常量', await s.digestHex('SHA-256', ''),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    check('SHA-1("abc")', await s.digestHex('SHA-1', 'abc'),
      'a9993e364706816aba3e25717850c26c9cd0d89d');

    /* 与 Node crypto 交叉比对：中文 / 超长 key（会走 key 先摘要那条分支）/ 二进制 */
    const cases = [
      ['中文内容', '密钥🔑', '理记大纲：产品目标 / 关键里程碑'],
      ['超长 key（>64 字节）', 'x'.repeat(200), 'payload'],
      ['含换行与斜杠', 'sk/with+chars=', 'a\nb/c\n'],
      ['空消息', 'key', '']
    ];
    for (const [label, key, msg] of cases) {
      check('交叉 HMAC-SHA256 ' + label, await s.hmacHex('SHA-256', key, msg), refHmac('sha256', key, msg));
      check('交叉 HMAC-SHA1   ' + label, await s.hmacHex('SHA-1', key, msg), refHmac('sha1', key, msg));
    }
    check('交叉 SHA-256 长文本', await s.digestHex('SHA-256', '理记'.repeat(500)), refDigest('sha256', '理记'.repeat(500)));

    /* base64 版（OSS V1 用） */
    const b64 = await s.hmacB64('SHA-1', 'Jefe', 'what do ya want for nothing?');
    check('HMAC-SHA1 base64 = hex 的 base64 形式', b64,
      Buffer.from('effcdf6ae5eb2fa2d27416d5f184df9c259a7c79', 'hex').toString('base64'));

    /* 时间格式 */
    const d = new Date(Date.UTC(2026, 9, 5, 15, 34, 0));
    check('compactTime', s.compactTime(d), '20261005T153400Z');
    check('httpDate', s.httpDate(d), 'Mon, 05 Oct 2026 15:34:00 GMT');
  }

  /* ---- 配置与 URL ---- */
  const OSS = loadOss(true);
  console.log('\n===== 配置 / URL =====');
  const cfg = OSS.normalize({ provider: 's3', endpoint: 'http://127.0.0.1:9000', bucket: 'liji', region: 'cn-north-1', ak: 'AK', sk: 'SK', prefix: 'liji/' });
  check('keyOf 拼前缀', OSS.keyOf(cfg, 'documents.json'), 'liji/documents.json');
  check('虚拟主机风格 URL', OSS.objectUrl(cfg, 'liji/documents.json'), 'http://liji.127.0.0.1:9000/liji/documents.json');
  const pcfg = OSS.normalize({ provider: 's3', endpoint: 'http://127.0.0.1:9000', bucket: 'liji', ak: 'AK', sk: 'SK', prefix: '', pathStyle: true });
  check('路径风格 URL', OSS.objectUrl(pcfg, 'documents.json'), 'http://127.0.0.1:9000/liji/documents.json');
  check('中文 key 被编码', OSS.objectUrl(pcfg, '文档/笔记.json'), 'http://127.0.0.1:9000/liji/' + encodeURIComponent('文档') + '/' + encodeURIComponent('笔记') + '.json');
  check('OSS 默认 endpoint', OSS.objectUrl(OSS.normalize({ provider: 'oss', bucket: 'b', region: 'cn-hangzhou', ak: 'a', sk: 's', prefix: '' }), 'x.json'),
    'https://b.oss-cn-hangzhou.aliyuncs.com/x.json');
  check('COS 默认 endpoint', OSS.objectUrl(OSS.normalize({ provider: 'cos', bucket: 'b-1250000000', region: 'ap-guangzhou', ak: 'a', sk: 's', prefix: '' }), 'x.json'),
    'https://b-1250000000.cos.ap-guangzhou.myqcloud.com/x.json');
  check('校验：缺 bucket 应报错', String(OSS.validate({ provider: 's3', ak: 'a', sk: 's', endpoint: 'http://x' }).ok), 'false');
  check('校验：缺密钥应报错', String(OSS.validate({ provider: 's3', bucket: 'b', endpoint: 'http://x' }).ok), 'false');
  check('校验：完整配置应通过', String(OSS.validate(cfg).ok), 'true');

  /* ---- 腾讯 COS 签名 ----
   * 基准一：官方文档算例（product/436/7778 示例二）。文档把 Signature 末 4 位打码成
   * 「1234」，所以只比未打码的前 36 位；曾因把 SignKey 解码成原始字节参与 HMAC 而翻车，
   * 前缀比对能一字不差地分辨两种写法（实测旧写法整串都对不上）。 */
  console.log('\n===== 腾讯 COS 签名 =====');
  const docSignKey = '937914bf490e9e8c189836aad2052e4feeb35eaf';
  const docSts = 'sha1\n1557989753;1557996953\n54ecfe22f59d3514fdc764b87a32d8133ea611e6\n';
  check('COS 文档算例：SignKey 按字符串参与最终 HMAC（前 36 位）',
    (await OSS._sign.hmacHex('SHA-1', docSignKey, docSts)).slice(0, 36),
    '01681b8c9d798a678e43b685a9f1bba0f6c0');

  /* 基准二：冻结时间直调 signCos，外部按文档算法独立复算整条链。
   * 这是接线测试 —— 若将来有人把 SignKey 再改成 fromHex（S3 习惯），这里会红。 */
  const cosCfg = OSS.normalize({ provider: 'cos', bucket: 'b-1250000000', region: 'ap-guangzhou', ak: 'AKIDexample', sk: 'secret/plus', prefix: '' });
  const RealDate = Date;
  const fixedMs = RealDate.UTC(2026, 9, 6, 3, 0, 0);
  globalThis.Date = class extends RealDate { static now() { return fixedMs; } };
  let auth = '';
  try {
    const out = await OSS._sign.signCos(cosCfg, 'put',
      'https://b-1250000000.cos.ap-guangzhou.myqcloud.com/liji/probe.txt', '/liji/probe.txt',
      {}, { 'content-type': 'application/json; charset=utf-8' }, '');
    auth = out.authorization;
  } finally { globalThis.Date = RealDate; }
  {
    const sec = Math.floor(fixedMs / 1000);
    const keyTime = (sec - 60) + ';' + (sec + 3600);
    const httpHeaders = 'content-type=application%2Fjson%3B%20charset%3Dutf-8&host=b-1250000000.cos.ap-guangzhou.myqcloud.com';
    const httpString = 'put\n/liji/probe.txt\n\n' + httpHeaders + '\n';
    const signKey = nodeCrypto.createHmac('sha1', 'secret/plus').update(keyTime).digest('hex');
    const sts = 'sha1\n' + keyTime + '\n' + nodeCrypto.createHash('sha1').update(httpString).digest('hex') + '\n';
    const expectSig = nodeCrypto.createHmac('sha1', Buffer.from(signKey, 'utf8')).update(sts).digest('hex');
    const m = /q-signature=([0-9a-f]{40})/.exec(auth);
    check('COS signCos 全链路（冻结时间复算）', m ? m[1] : '(无 q-signature)', expectSig);
  }

  /* COS 签名的真桶行为由 test-oss-e2e.js 的 mock 服务端按「实际收到的头」重算 q-signature 对比。 */

  /* ---- 阿里云 OSS 签名 ----
   * 两个真桶踩出来的坑（2026-10-07，403 SignatureDoesNotMatch，服务端回显 StringToSign 定位）：
   * ① V1：CanonicalizedOSSHeaders 与 CanonicalizedResource 之间**没有**分隔换行 ——
   *    join('\n') 会在头块（自带行尾 \n）和资源路径之间多插一个 \n；
   * ② V4：Canonical URI 必须带 bucket 前缀（/bucket/key），与 AWS SigV4 相反；
   *    且 x-oss-content-sha256 只认 UNSIGNED-PAYLOAD，AdditionalHeaders 省略。
   * 断言方式：冻结时间直调签名函数，用 Node crypto 按官方文档**独立复算**整条链；
   * 再各加一条对照实验 —— 按旧 bug 的形态复算，签名必须**不同**（回归旧写法时这里先红）。 */
  console.log('\n===== 阿里云 OSS 签名 =====');
  const ossCfg = OSS.normalize({ provider: 'oss', bucket: 'liji-docx', region: 'cn-hangzhou',
    endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', ak: 'AKexample', sk: 'secret/plus', prefix: 'lij/' });
  const ossNow = new Date(Date.UTC(2026, 9, 7, 4, 0, 0));
  const ossDate = 'Wed, 07 Oct 2026 04:00:00 GMT';
  const ossTs = '20261007T040000Z';

  /* V1：GET（无 content-type） */
  const v1out = await OSS._sign.signOssV1(ossCfg, 'GET',
    'https://liji-docx.oss-cn-hangzhou.aliyuncs.com/lij/probe.txt', '/lij/probe.txt', {}, {}, '', ossNow);
  const m1 = /OSS AKexample:(.+)$/.exec(v1out.authorization);
  const v1StsOk = 'GET\n\n\n' + ossDate + '\nx-oss-date:' + ossDate + '\n/liji-docx/lij/probe.txt';
  check('OSS V1 全链路（头块与 resource 之间无分隔 \\n）',
    m1 ? m1[1] : v1out.authorization,
    nodeCrypto.createHmac('sha1', 'secret/plus').update(v1StsOk).digest('base64'));
  const v1StsOld = 'GET\n\n\n' + ossDate + '\nx-oss-date:' + ossDate + '\n\n/liji-docx/lij/probe.txt';
  check('对照：多一个 \\n 的旧 sts 签名必须不同',
    String(m1[1] !== nodeCrypto.createHmac('sha1', 'secret/plus').update(v1StsOld).digest('base64')), 'true');
  /* V1：PUT（content-type 参与签名） */
  const v1put = await OSS._sign.signOssV1(ossCfg, 'PUT',
    'https://liji-docx.oss-cn-hangzhou.aliyuncs.com/lij/probe.txt', '/lij/probe.txt', {},
    { 'content-type': 'application/json; charset=utf-8' }, '', ossNow);
  const m1p = /OSS AKexample:(.+)$/.exec(v1put.authorization);
  const v1putSts = 'PUT\n\napplication/json; charset=utf-8\n' + ossDate
    + '\nx-oss-date:' + ossDate + '\n/liji-docx/lij/probe.txt';
  check('OSS V1 PUT（content-type 参与签名）',
    m1p ? m1p[1] : v1put.authorization,
    nodeCrypto.createHmac('sha1', 'secret/plus').update(v1putSts).digest('base64'));

  /* V4：GET */
  const v4out = await OSS._sign.signOssV4(ossCfg, 'GET',
    'https://liji-docx.oss-cn-hangzhou.aliyuncs.com/lij/probe.txt', '/lij/probe.txt', {}, {}, '', ossNow);
  const m4 = /Signature=([0-9a-f]{64})$/.exec(v4out.authorization);
  const v4Cr = ['GET', '/liji-docx/lij/probe.txt', '',
    'x-oss-content-sha256:UNSIGNED-PAYLOAD\nx-oss-date:' + ossTs + '\n', '', 'UNSIGNED-PAYLOAD'].join('\n');
  const v4Sts = ['OSS4-HMAC-SHA256', ossTs, '20261007/cn-hangzhou/oss/aliyun_v4_request',
    nodeCrypto.createHash('sha256').update(v4Cr).digest('hex')].join('\n');
  let v4Key = nodeCrypto.createHmac('sha256', 'aliyun_v4secret/plus').update('20261007').digest();
  for (const p of ['cn-hangzhou', 'oss', 'aliyun_v4_request']) {
    v4Key = nodeCrypto.createHmac('sha256', v4Key).update(p).digest();
  }
  check('OSS V4 全链路（Canonical URI 带 bucket 前缀）',
    m4 ? m4[1] : v4out.authorization,
    nodeCrypto.createHmac('sha256', v4Key).update(v4Sts).digest('hex'));
  const v4CrOld = v4Cr.replace('/liji-docx/lij/probe.txt', '/lij/probe.txt');
  const v4StsOld = v4Sts.replace(
    nodeCrypto.createHash('sha256').update(v4Cr).digest('hex'),
    nodeCrypto.createHash('sha256').update(v4CrOld).digest('hex'));
  check('对照：URI 少 bucket 的旧 CR 签名必须不同',
    String(m4[1] !== nodeCrypto.createHmac('sha256', v4Key).update(v4StsOld).digest('hex')), 'true');
  check('V4 authorization 不带 AdditionalHeaders（x-oss-* 本就自动参与）',
    String(v4out.authorization.indexOf('AdditionalHeaders') === -1), 'true');

  console.log('\n' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
  process.exit(fail === 0 ? 0 : 1);
})();
