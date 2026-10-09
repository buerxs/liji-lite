/* 端到端自检：oss.js ↔ 本地 S3 模拟服务（真实 HTTP 往返 + 真实 SigV4 校验）
 * 覆盖：PUT / GET / HEAD / DELETE / 连通性探针 / 错误密钥被拒 / 错误信息可读性。
 * 用法：node tools/test-oss-e2e.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { start, verify, verifyCos, xmlError, ACCESS_KEY, SECRET_KEY, COS_ACCESS_KEY, COS_SECRET_KEY } = require('./mock-s3');

/* fetch 从外面注入：真网络用 globalThis.fetch；需要绕开 DNS 时换成下面的桩 */
function loadOss(fetchImpl) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'oss.js'), 'utf8');
  const w = {};
  new Function('window', 'crypto', 'btoa', 'atob', 'TextEncoder', 'URL', 'fetch', src)(
    w, globalThis.crypto, globalThis.btoa, globalThis.atob, TextEncoder, URL, fetchImpl || globalThis.fetch);
  return w.LiJiOSS;
}
/* 虚拟主机风格（bucket.xxx.com）在本机解析不了域名，但签名必须验 ——
   用桩 fetch 拦下请求，交给 mock-s3 里那套独立实现的 SigV4 校验。 */
function stubFetch(store) {
  return async function (url, opts) {
    const u = new URL(url);
    /* 真实浏览器/undici 会自动带 host；桩里必须补上，否则校验端看到的 host 是空的 */
    const headers = Object.assign({}, opts.headers);
    headers.host = u.host;
    const req = { method: opts.method, url: u.pathname + u.search, headers: headers };
    const bodyBuf = Buffer.from(opts.body === undefined ? '' : opts.body);
    const isCos = (headers.authorization || '').indexOf('q-sign-algorithm=') === 0;
    const v = isCos ? verifyCos(req) : verify(req, bodyBuf);
    if (!v.ok) return new Response(xmlError(v.code, v.msg), { status: 403, headers: { 'Content-Type': 'application/xml' } });
    if (req.method === 'PUT') { store[u.pathname] = bodyBuf; return new Response('', { status: 200, headers: { ETag: '"stub"' } }); }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const b = store[u.pathname];
      if (!b) return new Response(xmlError('NoSuchKey', 'no such key'), { status: 404 });
      return new Response(req.method === 'HEAD' ? '' : b, { status: 200, headers: { ETag: '"stub"' } });
    }
    if (req.method === 'DELETE') { delete store[u.pathname]; return new Response(null, { status: 204 }); }
    return new Response('', { status: 405 });
  };
}

let fail = 0;
function check(name, cond, extra) {
  if (!cond) fail++;
  console.log((cond ? '[OK]   ' : '[FAIL] ') + name + (cond ? '' : (extra ? '\n       ' + extra : '')));
}

(async () => {
  const srv = await start(0);
  const OSS = loadOss();
  const cfg = OSS.normalize({
    provider: 's3', endpoint: srv.url, bucket: 'liji-bucket', region: 'cn-north-1',
    ak: srv.accessKey, sk: srv.secretKey, prefix: 'liji/', pathStyle: true
  });

  console.log('===== 端到端：' + srv.url + ' （bucket liji-bucket，路径风格）=====');

  /* 1) 写入一篇带中文、换行、特殊字符的文档库 */
  const big = JSON.stringify({
    v: 1, updatedAt: Date.now(),
    documents: [{ id: 1, title: '秋季产品计划 / 关键里程碑', desc: '含「引号」与 \n 换行与 / 斜杠 & 与号', nodes: [{ id: 11, text: '产品目标', level: 1 }] }],
    folders: [{ id: 9, name: '工作' }]
  });
  let r = await OSS.put(cfg, 'documents.json', big);
  check('PUT 文档库（签名被接受）', r.ok, JSON.stringify(r));

  /* 2) 读回来必须逐字节一致 —— 中文有没有被编码错、换行有没有被吃掉，都在这里暴露 */
  const g = await OSS.get(cfg, 'documents.json');
  check('GET 内容与写入一致', g.text === big, '长度 ' + g.text.length + ' vs ' + big.length);
  const back = JSON.parse(g.text);
  check('GET 中文标题无损', back.documents[0].title === '秋季产品计划 / 关键里程碑', back.documents[0].title);
  check('GET 换行与特殊字符无损', back.documents[0].desc.indexOf('\n') >= 0 && back.documents[0].desc.indexOf('&') >= 0);

  /* 3) HEAD：存在的对象应命中，不存在的应报 missing 而不是抛错 */
  const h1 = await OSS.head(cfg, 'documents.json');
  check('HEAD 已存在的对象', h1.ok, JSON.stringify(h1));
  const h2 = await OSS.head(cfg, 'nope.json');
  check('HEAD 不存在的对象 → missing', h2.ok === false && h2.missing === true, JSON.stringify(h2));

  /* 4) 连通性探针：写 + 删，删完不留垃圾 */
  const before = srv.size();
  const t = await OSS.test(cfg);
  check('连通性探针通过', t.ok, t.msg);
  check('探针对象已清理', srv.size() === before, '剩余 ' + srv.dump().join(','));

  /* 5) 删除 */
  const d = await OSS.del(cfg, 'documents.json');
  check('DELETE 成功', d.ok);
  check('DELETE 后 GET 报 404', await OSS.get(cfg, 'documents.json').then(() => false, e => e.status === 404));

  /* 6) 错误密钥必须被拒，且错误信息要说人话（不能只甩一段 XML） */
  const bad = OSS.normalize(Object.assign({}, cfg, { sk: 'wrong-secret' }));
  let err = null;
  try { await OSS.put(bad, 'documents.json', '{}'); } catch (e) { err = e; }
  check('错误密钥被拒', !!err && err.status === 403, err ? err.message : '竟然通过了');
  check('错误信息是人话（含处置建议）', !!err && /密钥不对|时间差太多/.test(err.message), err ? err.message : '');
  /* 文案里不得混入原始 XML 标签：parseErr 曾把外层 <Error> 吞进 Message，
   * 用户看到的是「SignatureDoesNotMatch · <Code>…</Code> <Message>…」这种半生不熟的东西 */
  check('错误信息不含 XML 标签', !!err && !/<[A-Za-z]/.test(err.message), err ? err.message : '');

  /* 7) 配置不完整时不发请求（本地拦下，别浪费一次网络往返） */
  let e2 = null;
  try { await OSS.put({ provider: 's3', ak: 'a', sk: 'b' }, 'x.json', '{}'); } catch (e) { e2 = e; }
  check('缺 bucket 时本地拦截', !!e2 && /Bucket/.test(e2.message), e2 ? e2.message : '');

  /* 8) 虚拟主机风格（bucket.endpoint）同样要能签过：
   *    签名里的 host 是 bucket 前缀域名，漏掉它是最常见的「本地能过、线上 403」。 */
  const store = {};
  const OSS2 = loadOss(stubFetch(store));
  const vcfg = OSS2.normalize({
    provider: 's3', endpoint: 'https://s3.cn-north-1.amazonaws.com', bucket: 'liji-bucket',
    region: 'cn-north-1', ak: ACCESS_KEY, sk: SECRET_KEY, prefix: 'liji/'
  });
  let vok = false, verr = '';
  try { vok = (await OSS2.put(vcfg, 'vh.json', '{"a":1}')).ok; } catch (e) { verr = e.message; }
  check('虚拟主机风格也能签过', vok, verr);
  check('虚拟主机风格 key 带前缀', Object.keys(store)[0] === '/liji/vh.json', JSON.stringify(Object.keys(store)));
  const vget = await OSS2.get(vcfg, 'vh.json');
  check('虚拟主机风格 GET 往返一致', vget.text === '{"a":1}', vget.text);

  /* 9) 中文对象名：URL 里编码过，签名必须按编码后的算（两边不一致就是 403） */
  let cok = false, cerr = '';
  try { cok = (await OSS2.put(vcfg, '文档/笔记.json', '{"cn":1}')).ok; } catch (e) { cerr = e.message; }
  check('中文对象名能签过', cok, cerr);

  /* 10) 腾讯云 COS：q-sign-algorithm=sha1 全链路（stubFetch 里的 verifyCos 按「实际收到的头」重算）。
   *   ★ 重点盯 2026-10-06 修的 bug：无 body 的 GET / HEAD / DELETE 不发 content-type，
   *     q-header-list 必须跟着变 —— 旧代码无条件签 content-type;host，服务端重算必 403。 */
  console.log('===== 腾讯云 COS（虚拟主机风格 + 独立验签）=====');
  const cosCfg = OSS2.normalize({
    provider: 'cos', endpoint: 'https://cos.ap-guangzhou.myqcloud.com', bucket: 'liji-docs-1318323661',
    region: 'ap-guangzhou', ak: COS_ACCESS_KEY, sk: COS_SECRET_KEY, prefix: 'liji/'
  });
  check('COS URL 是 bucket.cos.地域 形式', cosCfg ? new URL(OSS2.objectUrl(cosCfg, 'x.json')).host === 'liji-docs-1318323661.cos.ap-guangzhou.myqcloud.com' : false, OSS2.objectUrl(cosCfg, 'x.json'));
  let p1 = null;
  try { p1 = await OSS2.put(cosCfg, 'documents.json', '{"docs":2}'); } catch (e) { p1 = { ok: false, msg: e.message }; }
  check('COS PUT（有 body，签 content-type;host）', p1.ok === true, JSON.stringify(p1));
  let g1 = null;
  try { g1 = await OSS2.get(cosCfg, 'documents.json'); } catch (e) { g1 = { ok: false, msg: e.message }; }
  check('COS GET（无 body，只签 host —— 旧 bug 会在这里 403）', g1.ok === true && g1.text === '{"docs":2}', JSON.stringify(g1));
  let h3 = null;
  try { h3 = await OSS2.head(cosCfg, 'documents.json'); } catch (e) { h3 = { ok: false, msg: e.message }; }
  check('COS HEAD（无 body）', h3.ok === true, JSON.stringify(h3));
  let d1 = null;
  try { d1 = await OSS2.del(cosCfg, 'documents.json'); } catch (e) { d1 = { ok: false, msg: e.message }; }
  check('COS DELETE（无 body）', d1.ok === true, JSON.stringify(d1));
  const cosBad = OSS2.normalize(Object.assign({}, cosCfg, { sk: 'wrong' }));
  let cErr = null;
  try { await OSS2.get(cosBad, 'documents.json'); } catch (e) { cErr = e; }
  check('COS 错误密钥被拒', !!cErr && cErr.status === 403, cErr ? cErr.message : '竟然通过了');

  /* 网页部署已改为 Cloudflare Pages（控制台拖拽「网页部署包」文件夹），COS 静态网站通道
   * （deploy-web.js / 部署网页.bat / 部署配置.txt）已于 2026-10-06 移除——
   * 腾讯 COS 默认域名对新桶强制下载（x-cos-force-download），静态网站默认域名又只有
   * 3 小时带 token 预览，两条路都走不通，相关用例一并删除。 */

  /* 11) 版本控制 / 回收站（2026-10-09）：mock 桶开版本控制 → 探测/列举/读旧版本/删指定版本全链路 */
  console.log('===== 版本控制 / 回收站（S3 与 COS 各一遍）=====');
  srv.setVersioning(true);
  const pvOn = await OSS.probeVersioning(cfg);
  check('版本控制探测：开着 → true', pvOn === true, String(pvOn));
  /* 写两版再删 → GET 404；列举能看到 2 个版本 + 1 个删除标记；读旧版本能拿回内容 */
  await OSS.put(cfg, 'docs/工作/计划.md', '# v1');
  await OSS.put(cfg, 'docs/工作/计划.md', '# v2');
  await OSS.del(cfg, 'docs/工作/计划.md');
  check('删除后 GET 404（版本控制开着 = 打了删除标记）',
    await OSS.get(cfg, 'docs/工作/计划.md').then(() => false, e => e.status === 404));
  const lv = await OSS.listVersions(cfg, 'docs/');
  const mine = lv.filter(x => x.key === 'liji/docs/工作/计划.md');
  check('列举带配置前缀的 key（2 版本 + 1 标记）', mine.length === 3, JSON.stringify(mine));
  check('最新态是删除标记', mine.filter(x => x.isLatest)[0] && mine.filter(x => x.isLatest)[0].marker === true);
  check('旧版本可读（isLatest=false 的 Version）',
    mine.some(x => !x.marker && x.isLatest === false && x.lastModified > 0), JSON.stringify(mine));
  const oldV = mine.filter(x => !x.marker).sort((a, b) => b.lastModified - a.lastModified)[1];
  check('存在可读的旧版本', !!oldV, JSON.stringify(mine));
  if (!oldV) { console.log('全部通过'.replace('全部通过', fail + ' 项失败')); process.exit(1); }
  const gotOld = await OSS.getVersion(cfg, 'docs/工作/计划.md', oldV.versionId);
  check('按 versionId 读回第一版内容', gotOld.text === '# v1', gotOld.text);
  /* 删指定版本（摘掉删除标记）→ 对象复活，GET 回到最新版本内容 */
  const markerEntry = mine.filter(x => x.marker)[0];
  await OSS.delVersion(cfg, 'docs/工作/计划.md', markerEntry.versionId);
  const revived = await OSS.get(cfg, 'docs/工作/计划.md');
  check('摘掉删除标记后对象复活（内容=最新版本）', revived.text === '# v2', revived.text);
  /* 版本控制关着：探测必须判「没开」（应用据此提示用户去开） */
  srv.setVersioning(false);
  await OSS.put(cfg, 'docs/temp.md', 'x');
  await OSS.del(cfg, 'docs/temp.md');
  const pvOff = await OSS.probeVersioning(cfg);
  check('版本控制探测：没开 → false', pvOff === false, String(pvOff));
  /* COS：q-url-param-list 修复（旧代码恒为空，?versions 一上必 403）走真实 HTTP 验签 */
  const cosSrvCfg = OSS.normalize({
    provider: 'cos', endpoint: srv.url, bucket: 'cos-bucket-1250000000',
    region: 'ap-guangzhou', ak: srv.cosAccessKey, sk: srv.cosSecretKey, prefix: 'liji/', pathStyle: true
  });
  srv.setVersioning(true);
  const pvCos = await OSS.probeVersioning(cosSrvCfg);
  check('COS 版本控制探测（验证 q-url-param-list 修复）', pvCos === true, String(pvCos));
  let cosList = null;
  try {
    await OSS.put(cosSrvCfg, 'docs/a.md', '# cos');
    await OSS.del(cosSrvCfg, 'docs/a.md');
    cosList = await OSS.listVersions(cosSrvCfg, 'docs/');
  } catch (e) { cosList = { err: e.message }; }
  const cosA = Array.isArray(cosList) ? cosList.filter(x => x.key === 'liji/docs/a.md') : [];
  check('COS 列举版本 + 删除标记', cosA.length === 2
    && cosA.filter(x => x.marker).length === 1, JSON.stringify(cosList));
  const cosNonMarker = cosA.filter(x => !x.marker).sort((a, b) => b.lastModified - a.lastModified)[0];
  const cosVer = await OSS.getVersion(cosSrvCfg, 'docs/a.md', cosNonMarker.versionId);
  check('COS 按 versionId 读回内容', cosVer.text === '# cos', cosVer.text);
  /* 对照实验：把 signOssV1 的白名单子资源过滤打断成「全量 query 拼接」（旧 bug 形态），
   * 同一请求的签名必须**改变**——证明 V1 只签白名单、多签普通参数就是签名错误。
   * （符合阿里规范的最终判据是真桶验证：2026-10-09 真桶 ?versions 全链路通过。） */
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'oss.js'), 'utf8');
    const anchor = "const subKeys = Object.keys(query || {}).filter(k => SUBRES[k] === true || k.indexOf('response-') === 0).sort();";
    check('对照实验锚点唯一', src.split(anchor).length === 2);
    const broken = src.replace(anchor, 'const subKeys = Object.keys(query || {}).sort();');
    const mk = code => {
      const w = {};
      new Function('window', 'crypto', 'btoa', 'atob', 'TextEncoder', 'URL', 'fetch', code)(
        w, globalThis.crypto, globalThis.btoa, globalThis.atob, TextEncoder, URL, globalThis.fetch);
      return w.LiJiOSS;
    };
    const OSSA = mk(src), OSSB = mk(broken);
    const ocfg = { provider: 'oss', endpoint: 'https://b.example', bucket: 'b1', region: 'cn-hangzhou', ak: 'ak', sk: 'sk', prefix: 'liji/', ossSign: 'v1' };
    const u = new URL('https://b.example/liji/');
    const q = { 'versions': '', 'max-keys': '1000', 'prefix': 'docs/' };
    const sigA = (await OSSA._sign.signOssV1(ocfg, 'GET', u, '/b1/liji/', q, {}, 'H')).authorization;
    const sigB = (await OSSB._sign.signOssV1(ocfg, 'GET', u, '/b1/liji/', q, {}, 'H')).authorization;
    check('对照实验：打断 V1 子资源拼接 → 签名必变', sigA !== sigB);
    const sigNoQ = (await OSSA._sign.signOssV1(ocfg, 'GET', u, '/b1/liji/', {}, {}, 'H')).authorization;
    check('V1 签名确实包含子资源（与无 query 版本不同）', sigA !== sigNoQ);
  }

  await srv.close();
  console.log('\n' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
  process.exit(fail === 0 ? 0 : 1);
})();
