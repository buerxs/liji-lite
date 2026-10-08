/* 真浏览器端到端自检（轻享版）
 * ------------------------------------------------------------------
 * 验的是那几条需求本身，不是「页面能打开」：
 *   ① 打开就能用 —— 没有登录页、没有账号入口
 *   ② 文档存本机 —— 新建 / 刷新 / 仍在
 *   ③ 不碰服务器 —— 全程不发任何 /api 请求
 *   ④ 配了对象存储就自动同步 —— 改动上传、云端改了打开时自动拉回
 *
 * 用法：node tools/test-lite.js      （需要本机 Edge 或 Chrome；没装会跳过并退出 0）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];

let fail = 0;
function check(name, ok, extra) {
  if (!ok) fail++;
  console.log((ok ? '[OK]   ' : '[FAIL] ') + name + (ok ? '' : (extra ? '\n       ' + extra : '')));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- CDP 连接 ---------- */
function makeCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  });
  const ready = new Promise(r => ws.addEventListener('open', r));
  async function send(method, params) {
    await ready;
    const myId = ++id;
    return new Promise((resolve) => {
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method: method, params: params || {} }));
    });
  }
  return {
    send: send,
    events: events,
    /* 结果嵌两层：msg.result.result.value */
    async eval(code) {
      /* ★ 传入的代码**必须自己 return**：这里包的是 `(()=>{ ... })()`，
       *   花括号是函数体、没有隐式返回 —— 不写 return 就永远拿到 undefined，
       *   轮询会一直等到超时（排查时会误以为是页面没加载）。 */
      const r = await send('Runtime.evaluate', {
        expression: `(()=>{${code}})()`, returnByValue: true
      });
      if (!r.result) return { __err: 'CDP 没返回结果：' + JSON.stringify(r.error || r) };
      if (r.result.exceptionDetails) {
        return { __err: (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) || '页面内抛错' };
      }
      return r.result.result ? r.result.result.value : undefined;
    },
    /* 轮询到真值为止。返回 { ok, last } —— 失败时把最后一次拿到的值带出去，
       否则排查时只能看到「超时了」，看不到「它其实一直返回 false / 一直抛错」。 */
    async waitFor(code, timeout) {
      const deadline = Date.now() + (timeout || 8000);
      let last = null;
      await sleep(300);                       // 先给导航一点时间，别撞上上下文切换
      let i = 0;
      while (Date.now() < deadline) {
        last = await this.eval(code);
        if (process.env.LIJI_DEBUG) console.log('    waitFor#' + (i++) + ' → ' + JSON.stringify(last));
        if (last && !last.__err) return { ok: true, last: last };
        await sleep(200);
      }
      return { ok: false, last: last };
    },
    close: () => { try { ws.close(); } catch (e) { } }
  };
}

(async () => {
  const bin = BROWSERS.find(p => fs.existsSync(p));
  if (!bin) { console.log('没有找到 Edge / Chrome，跳过浏览器自检（其余自检不受影响）'); process.exit(0); }

  /* ---------- 起服务：静态站点 + 本地对象存储模拟服务 ---------- */
  process.env.PORT = '5199';
  process.env.LIJI_QUIET = '1';
  const site = require('../server.js');
  site.start();
  await new Promise(r => site.server.once('listening', r));
  const sitePort = site.server.address().port;

  const { start } = require('./mock-s3');
  const srv = await start(0);

  /* Node 侧的 OSS 客户端：用来扮演「另一台设备」往云端写东西 */
  const ossSrc = fs.readFileSync(path.join(__dirname, '..', 'oss.js'), 'utf8');
  const w = {};
  new Function('window', 'crypto', 'btoa', 'atob', 'TextEncoder', 'URL', 'fetch', ossSrc)(
    w, globalThis.crypto, globalThis.btoa, globalThis.atob, TextEncoder, URL, globalThis.fetch);
  const OSS = w.LiJiOSS;
  const nodeCfg = OSS.normalize({
    provider: 's3', endpoint: srv.url, bucket: 'liji-bucket', region: 'cn-north-1',
    ak: srv.accessKey, sk: srv.secretKey, prefix: 'liji/', pathStyle: true
  });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'liji-lite-'));
  const CDP_PORT = 9433;
  const child = spawn(bin, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--no-proxy-server', '--proxy-bypass-list=<-loopback>',
    'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
    } catch (e) { }
    if (!target) await sleep(200);
  }
  if (!target) { console.log('浏览器没起来，跳过'); child.kill(); process.exit(0); }

  const cdp = makeCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  const base = 'http://127.0.0.1:' + sitePort + '/';
  console.log('\n===== 真浏览器端到端：' + base + ' =====\n');

  const apiHits = [];
  const pageErrors = [];
  function collectErrors() {
    for (const ev of cdp.events.splice(0)) {
      if (ev.method === 'Network.requestWillBeSent') {
        const u = ev.params.request.url;
        if (u.indexOf('/api/') >= 0) apiHits.push(u);
      } else if (ev.method === 'Runtime.exceptionThrown') {
        const d = ev.params.exceptionDetails || {};
        pageErrors.push((d.exception && d.exception.description) || d.text || '未知');
      } else if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
        const t = (ev.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ');
        if (!/favicon|Failed to load resource/i.test(t)) pageErrors.push('console.error: ' + t);
      }
    }
  }

  await cdp.send('Page.navigate', { url: base });
  const loaded = await cdp.waitFor(`return !!(document.title && document.getElementById('app') && document.getElementById('app').childElementCount > 0);`, 15000);
  check('页面加载完成且渲染出内容', loaded.ok, JSON.stringify(loaded.last));

  /* ---------- ① 没有账号这一层 ---------- */
  const noLogin = await cdp.eval(`
    var t = document.body.innerText || '';
    return {
      title: document.title,
      hasLoginForm: !!document.querySelector('.login-form'),
      hasOfflineNote: t.indexOf('离线体验') >= 0,
      tabs: Array.from(document.querySelectorAll('.side-item .lb')).map(function(e){return e.textContent;}),
      hasOss: !!window.LiJiOSS,
      providers: window.LiJiOSS ? Object.keys(window.LiJiOSS.PROVIDERS) : []
    };`);
  check('标题是「理记-轻享版」', noLogin.title === '理记-轻享版', noLogin.title);
  check('没有登录表单', noLogin.hasLoginForm === false);
  check('没有「离线体验」这类账号兜底入口', noLogin.hasOfflineNote === false);
  check('侧边导航只剩三页（无公告 / 无账号）',
    JSON.stringify(noLogin.tabs) === JSON.stringify(['我的文档', '社区', '同步与存储']), JSON.stringify(noLogin.tabs));
  check('对象存储客户端已加载（三家协议）', noLogin.hasOss && noLogin.providers.length === 3, JSON.stringify(noLogin.providers));

  /* ---------- ② 文档存本机：新建 → 刷新 → 仍在 ---------- */
  const before = await cdp.eval(`return window.__liji.S.documents.length;`);
  await cdp.eval(`
    window.__liji.createDocument('空白文档');
    window.__liji.S.documents[window.__liji.S.documents.length-1].title = '本机新建的文档';
    window.__liji.saveNow();
    return true;`);
  const after = await cdp.eval(`return window.__liji.S.documents.length;`);
  check('新建文档成功', after === before + 1, before + ' → ' + after);

  await sleep(600);
  await cdp.send('Page.navigate', { url: base });
  await cdp.waitFor(`document.getElementById('app') && document.getElementById('app').childElementCount > 0`, 15000);
  const kept = await cdp.eval(`
    var L = window.__liji;
    return { n: L.S.documents.length, titles: L.S.documents.map(function(d){return d.title;}) };`);
  check('刷新后文档还在（存在本机）', kept.n === before + 1 && kept.titles.indexOf('本机新建的文档') >= 0,
    kept.n + ' 篇：' + kept.titles.join(' / '));

  /* ---------- ③ 全程没有服务端请求 ---------- */
  collectErrors();
  check('没有发出任何 /api 请求（无服务器化）', apiHits.length === 0, apiHits.join(', '));

  /* ---------- ④ 配置对象存储：UI 表单字段齐全 ---------- */
  const form = await cdp.eval(`
    var L = window.__liji;
    L.S.tab = '个人中心'; L.S.ossFormOpen = true; L.S.ossDraft = null; L.render();
    var q = function(s){ return document.querySelectorAll(s).length; };
    return {
      selects: q('.vip-card select'),
      inputs: q('.vip-card input'),
      password: q('.vip-card input[type=password]'),
      text: (document.body.innerText || '').indexOf('连接我的对象存储') >= 0
    };`);
  check('配置面板有服务商下拉（3 家）', form.selects >= 1, 'select ×' + form.selects);
  check('配置面板有 Bucket / AK / SK 输入框', form.inputs >= 6, 'input ×' + form.inputs);
  check('Secret 用密码框（不明文显示）', form.password >= 1);
  check('面板标题说的是「连接我的对象存储」', form.text === true);

  /* ---------- ⑤ 保存配置 → 自动上传到云端 ---------- */
  const saved = await cdp.eval(`
    var L = window.__liji;
    L.ossSaveConfig({ provider:'s3', endpoint: ${JSON.stringify(srv.url)}, region:'cn-north-1',
      bucket:'liji-bucket', ak: ${JSON.stringify(srv.accessKey)}, sk: ${JSON.stringify(srv.secretKey)},
      prefix:'liji/', pathStyle:true });
    return true;`);
  check('保存配置未抛错', saved === true);
  const uploaded = await cdp.waitFor(`return !!(window.__liji.S.cloudState === 'synced' && window.__liji.S.lastSyncAt > 0);`, 12000);
  check('同步完成（状态 = synced）', uploaded.ok, JSON.stringify(uploaded.last));

  const cloud1 = JSON.parse((await OSS.get(nodeCfg, 'documents.json')).text);
  check('云端对象里就是本机那批文档',
    cloud1.documents.length === kept.n && cloud1.documents.some(d => d.title === '本机新建的文档'),
    '云端 ' + cloud1.documents.length + ' 篇');
  const meta1 = JSON.parse((await OSS.get(nodeCfg, 'meta.json')).text);
  check('云端写了 meta（用于检测变化）', meta1 && meta1.updatedAt > 0, JSON.stringify(meta1));

  const cfgPersisted = await cdp.eval(`
    var raw = localStorage.getItem('liji_oss_config');
    if (!raw) return { stored:false };
    var c = JSON.parse(raw);
    return { stored:true, enabled:c.enabled, bucket:c.bucket, hasSk: !!c.sk };`);
  check('配置落到了本机（刷新后仍生效）', cfgPersisted.stored && cfgPersisted.enabled === true && cfgPersisted.hasSk,
    JSON.stringify(cfgPersisted));

  /* ---------- ⑥ 改动自动上传 ---------- */
  const pushed = await cdp.eval(`
    var L = window.__liji;
    L.S.documents.push({ id: 987654, title:'改动后新增的一篇', template:'文档', nodes:[{id:1,text:'a',level:1}] });
    L.saveNowAndPush();
    return { ok: true, dirty: L.isDocsDirty() };`);
  check('改动后本机标记为「有未上传的改动」', pushed && pushed.ok === true && pushed.dirty === true, JSON.stringify(pushed));
  await sleep(2500);
  const cloud2 = JSON.parse((await OSS.get(nodeCfg, 'documents.json')).text);
  check('本机改动自动上传到了云端',
    cloud2.documents.some(d => d.title === '改动后新增的一篇'), '云端 ' + cloud2.documents.length + ' 篇');

  /* ---------- ⑦ 云端被别的设备改了 → 打开时自动拉回 ---------- */
  const remoteDocs = {
    v: 1, app: 'liji-lite', updatedAt: Date.now(), device: '另一台设备',
    documents: [{ id: 555001, title: '另一台设备写的文档', template: '文档', nodes: [{ id: 1, text: '来自云端', level: 1 }] }],
    folders: []
  };
  await OSS.put(nodeCfg, 'documents.json', JSON.stringify(remoteDocs));
  await OSS.put(nodeCfg, 'meta.json', JSON.stringify({
    v: 1, updatedAt: Date.now(), docs: 1, bytes: JSON.stringify(remoteDocs).length, device: '另一台设备'
  }));

  await cdp.send('Page.navigate', { url: base });
  const pulled = await cdp.waitFor(`return !!window.__liji.S.documents.some(function(d){return d.title === '另一台设备写的文档';});`, 15000);
  check('打开时自动检测到云端变化并同步到本地', pulled.ok, JSON.stringify(pulled.last));
  const afterPull = await cdp.eval(`return { n: window.__liji.S.documents.length, titles: window.__liji.S.documents.map(function(d){return d.title;}) };`);
  check('本地已换成云端那份', afterPull.titles.indexOf('另一台设备写的文档') >= 0, afterPull.titles.join(' / '));
  const backup = await cdp.eval(`return !!localStorage.getItem('liji_store:ossBackup');`);
  check('覆盖本机前留了备份（可一键找回）', backup === true);

  /* ---------- ⑦b 多设备冲突：乐观锁 + 三方按文档合并 ----------
   * 用户报的病根：两台设备绑同一个桶，B 停在旧快照上再推，旧文件把云端新数据整个盖掉。
   * 先单测合并函数（纯逻辑，直接在页面里调 window.__liji.mergeLibrary），
   * 再跑全链路：云端被别的设备改了 + 本机同时有脏改动 → 推送必须合并而不是覆盖。 */
  const unit = await cdp.eval(`
    var L = window.__liji;
    var base = {
      1: L.docHash({ id: 1, title: 'A', nodes: [{ id: 1, text: 'x', level: 1 }] }),
      2: L.docHash({ id: 2, title: 'B', nodes: [] }),
      3: L.docHash({ id: 3, title: 'C', nodes: [] })
    };
    var local = [
      { id: 1, title: 'A', nodes: [{ id: 1, text: 'local', level: 1 }] },  // 两边都改 → 保双份
      { id: 2, title: 'B', nodes: [{ id: 2, text: 'local', level: 1 }] },  // 只有本机改 → 本机赢
      { id: 4, title: 'D', nodes: [] }                                      // 本机新增 → 保留
    ];
    var cloud = [
      { id: 1, title: 'A', nodes: [{ id: 1, text: 'cloud', level: 1 }] },   // 云端也改了
      { id: 3, title: 'C', nodes: [{ id: 3, text: 'cloud-changed', level: 1 }] }, // 本机删了、云端又改了 → 抢救
      { id: 5, title: 'E', nodes: [] }                                      // 云端新增 → 收下
    ];
    var r = L.mergeLibrary(local, cloud, base);
    var texts = [];
    r.documents.forEach(function (d) { if (d.nodes[0] && d.nodes[0].text) texts.push(d.nodes[0].text); });
    return {
      n: r.documents.length,
      hasLocalA: texts.indexOf('local') >= 0,
      hasCloudCopy: r.documents.some(function (d) { return d.id !== 1 && d.title.indexOf('云端副本') >= 0 && d.nodes[0].text === 'cloud'; }),
      onlyLocalWins: (function () { var x = r.documents.filter(function (d) { return d.id === 2; })[0]; return !!x && x.nodes[0].text === 'local'; })(),
      deletedRescued: r.documents.some(function (d) { return d.title.indexOf('本机已删') >= 0; }),
      localNewKept: r.documents.some(function (d) { return d.id === 4; }),
      cloudNewTaken: r.documents.some(function (d) { return d.id === 5; }),
      dup: r.stats.dup
    };`);
  check('合并：两边都改 → 保双份（本机原文 + 云端副本）', unit.hasLocalA && unit.hasCloudCopy, JSON.stringify(unit));
  check('合并：只有本机改 → 本机赢', unit.onlyLocalWins === true);
  check('合并：本机删了但云端又改了 → 抢救回来', unit.deletedRescued === true);
  check('合并：本机新增保留、云端新增收下', unit.localNewKept && unit.cloudNewTaken, JSON.stringify(unit));
  check('合并：冲突计数 = 2（改冲突 1 + 删改冲突 1）', unit.dup === 2, 'dup=' + unit.dup);

  /* 全链路：先模拟「另一台设备」改了同一篇 + 新增一篇（rev 推到 5），
     本机停在旧快照上还改了同一篇 → saveNowAndPush 必须触发合并，不得覆盖云端改动 */
  const remoteDocs2 = {
    v: 1, app: 'liji-lite', updatedAt: Date.now(), device: '另一台设备',
    documents: [
      { id: 555001, title: '另一台设备写的文档', template: '文档', nodes: [{ id: 1, text: '云端改过的行', level: 1 }] },
      { id: 555002, title: '云端新增的文档', template: '文档', nodes: [{ id: 1, text: '云端的第二篇', level: 1 }] }
    ],
    folders: []
  };
  await OSS.put(nodeCfg, 'documents.json', JSON.stringify(remoteDocs2));
  await OSS.put(nodeCfg, 'meta.json', JSON.stringify({
    v: 2, rev: 5, updatedAt: Date.now(), docs: 2, bytes: JSON.stringify(remoteDocs2).length, device: '另一台设备'
  }));
  const conflictEdit = await cdp.eval(`
    var L = window.__liji;
    var d = null;
    L.S.documents.forEach(function (x) { if (x.id === 555001) d = x; });
    if (!d) return { err: 'no 555001' };
    d.nodes[0].text = '本机改过的行';
    L.saveNowAndPush();
    return { ok: true };`);
  check('冲突场景：本机脏改动就位', conflictEdit.ok === true, JSON.stringify(conflictEdit));
  const conflictPushed = await cdp.waitFor(`
    var st = JSON.parse(localStorage.getItem('liji_oss_state') || '{}');
    return st.rev >= 6;`, 15000);
  check('冲突推送完成（rev 从 5 前进到 6）', conflictPushed.ok, JSON.stringify(conflictPushed.last));
  const mergedLocal = await cdp.eval(`
    var L = window.__liji;
    var texts = [], hasCopy = false;
    L.S.documents.forEach(function (d) {
      if (d.nodes[0] && d.nodes[0].text) texts.push(d.nodes[0].text);
      if (d.title.indexOf('云端副本') >= 0) hasCopy = true;
    });
    return {
      bothSides: texts.indexOf('本机改过的行') >= 0 && texts.indexOf('云端改过的行') >= 0,
      cloudNewDoc: L.S.documents.some(function (d) { return d.id === 555002; }),
      hasCopy: hasCopy, n: L.S.documents.length
    };`);
  check('合并结果：本机改动和云端改动**都在**（没有被覆盖）',
    mergedLocal.bothSides === true, JSON.stringify(mergedLocal));
  check('合并结果：云端新增的文档也收下来了', mergedLocal.cloudNewDoc === true);
  check('合并结果：同改的那篇保留了云端副本', mergedLocal.hasCopy === true);
  const mergedCloud = JSON.parse((await OSS.get(nodeCfg, 'documents.json')).text);
  const mergedMeta = JSON.parse((await OSS.get(nodeCfg, 'meta.json')).text);
  const mergedCloudTexts = [];
  mergedCloud.documents.forEach(function (d) { if (d.nodes[0] && d.nodes[0].text) mergedCloudTexts.push(d.nodes[0].text); });
  check('云端上也是两份都在（本机没把云端盖掉）',
    mergedCloudTexts.indexOf('本机改过的行') >= 0 && mergedCloudTexts.indexOf('云端改过的行') >= 0,
    JSON.stringify(mergedCloudTexts));
  check('meta 带版本号且 rev 正确递增（乐观锁生效）', mergedMeta.rev === 6, JSON.stringify(mergedMeta));
  const copies3 = mergedCloud.documents.filter(d => d.title.indexOf('云端副本') >= 0).length;

  /* rev 对齐之后的普通推送：不该再触发合并（不多出副本）、rev 继续前进 */
  const nBefore2 = await cdp.eval(`return window.__liji.S.documents.length;`);
  await cdp.eval(`
    var L = window.__liji;
    L.S.documents.push({ id: 555003, title: '第二台设备的另一篇', template: '文档', nodes: [] });
    L.saveNowAndPush();
    return true;`);
  const pushed2 = await cdp.waitFor(`return (JSON.parse(localStorage.getItem('liji_oss_state') || '{}').rev) >= 7;`, 15000);
  check('rev 对齐后普通推送完成（rev → 7）', pushed2.ok, JSON.stringify(pushed2.last));
  const cloud4 = JSON.parse((await OSS.get(nodeCfg, 'documents.json')).text);
  const copies4 = cloud4.documents.filter(function (d) { return d.title.indexOf('云端副本') >= 0; }).length;
  check('普通推送没有误触发合并（副本数量不变）', copies4 === copies3, '副本 ' + copies3 + ' → ' + copies4);
  check('普通推送把本机新文档带上去了', cloud4.documents.some(function (d) { return d.id === 555003; }),
    '云端 ' + cloud4.documents.length + ' 篇（推送前 ' + nBefore2 + ' 篇）');

  /* ---------- ⑧ 文档功能没被改坏（这轮改的是同步，不是编辑器） ---------- */
  const docFn = await cdp.eval(`
    var L = window.__liji;
    var d = L.S.documents[0];
    L.openDocument(d.id);
    L.render();
    var rows = document.querySelectorAll('.row-input').length;
    L.S.editorView = '导图';
    L.render();
    var mapScroll = !!document.querySelector('.map-scroll');
    /* 布局的返回形状可能是数组，也可能是 { nodes, ... }：两种都认，别把断言写死在一种上 */
    var layout = -1;
    try {
      var lay = L.currentLayout();
      if (Array.isArray(lay)) layout = lay.length;
      else if (lay && Array.isArray(lay.nodes)) layout = lay.nodes.length;
      else if (lay && typeof lay === 'object') layout = Object.keys(lay).length;
    } catch (e) { layout = -1; }
    /* 改一行文字，确认「改 → 存」这条最短链路仍然通 */
    var nodeId = L.S.documents[0].nodes[0].id;
    L.updateNodeText(nodeId, '改过的第一行');
    var savedText = L.S.documents[0].nodes[0].text;
    L.S.showEditor = false; L.render();
    return { rows: rows, mapScroll: mapScroll, layout: layout, savedText: savedText };`);
  check('编辑器渲染出大纲行', docFn.rows > 0, 'rows=' + docFn.rows);
  check('导图能渲染（布局节点 > 0）', docFn.layout > 0 && docFn.mapScroll, 'layout=' + docFn.layout + ' map=' + docFn.mapScroll);
  check('改文字能落到文档上', docFn.savedText === '改过的第一行', docFn.savedText);

  /* ---------- ⑨ 真点击：走用户真正的入口，一个内部 API 都不调 ----------
   * 前面几节为了隔离变量，新建文档是直接调 L.newDoc() —— 那条路绕开了三个真实问题：
   * 按钮还在不在、点了有没有反应、键盘输入进不进得去。
   * （2026-09 的教训：断言绕开用户入口，会出现「API 全绿、界面其实点不动」。）
   * 所以这一节全部用 CDP 真指针 + 真键盘走一遍：点按钮 → 弹浮层 → 选模板 → 打字 → 切导图。
   *
   * ★ 这一节演的是「没配对象存储的纯本机用户」：先断开再重载。
   * 不这么做的话，上一节留在 mock 桶里的那份会在重载时把本机覆盖掉，
   * 最后两条持久化断言会假失败（看着像没存住，其实是被云端覆盖）。 */
  await cdp.eval(`window.__liji.ossClearConfig(); return true;`);
  await cdp.send('Page.navigate', { url: base });
  await cdp.waitFor(`return !!document.getElementById('app') && document.getElementById('app').childElementCount > 0;`, 15000);
  await sleep(800);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  /* 按「用户看到的文字」找元素再点：比 nth-of-type 稳，class 改名也不会误中点别的 */
  const clickByText = async (sel, text) => {
    const box = await cdp.eval(`
      var list = Array.from(document.querySelectorAll('${sel}'));
      var e = null;
      for (var i = 0; i < list.length; i++) {
        if ((list[i].textContent || '').indexOf(${JSON.stringify(text)}) >= 0) { e = list[i]; break; }
      }
      if (!e) return null;
      var r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) };`);
    if (!box || box.w === 0) return false;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    return true;
  };
  const clickSel = async (sel) => {
    const box = await cdp.eval(`
      var e = document.querySelector('${sel}');
      if (!e) return null;
      var r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) };`);
    if (!box || box.w === 0) return false;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    return true;
  };
  const typeText = async (t) => {
    for (const ch of t) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
  };

  /* 上一节停在编辑器里，先回首页（回首页也是点侧栏，顺带再走一次用户入口） */
  await clickByText('.side-item', '我的文档');
  await sleep(600);

  /* 2026-10-08：左下角「＋ 新建文档」已删，新建入口只剩 Header 的「＋ 新建」 */
  const sideNewGone = await cdp.eval(`return document.querySelectorAll('.side-new').length;`);
  check('侧栏左下角不再有「＋ 新建文档」按钮', sideNewGone === 0, 'count=' + sideNewGone);
  const clickedNew = await clickSel('.new-btn');
  check('真点 Header「＋ 新建」按钮有反应', clickedNew === true);
  const sheetShown = await cdp.waitFor(`return !!document.querySelector('.sheet .tpl-row');`, 6000);
  check('模板浮层真的弹出来了', sheetShown.ok, JSON.stringify(sheetShown.last));

  const nBefore = (await cdp.eval(`return window.__liji.S.documents.length;`)) || 0;
  const clickedTpl = await clickSel('.sheet .tpl-row');
  const nAfter = await cdp.waitFor(`var n = window.__liji.S.documents.length; return n > ${nBefore} ? n : false;`, 8000);
  check('真点模板真的建出了新文档', clickedTpl === true && nAfter.ok, nBefore + ' → ' + JSON.stringify(nAfter.last));
  const editorReady = await cdp.waitFor(`return document.querySelectorAll('.row-input').length > 0;`, 8000);
  check('新建后自动进入编辑页', editorReady.ok, JSON.stringify(editorReady.last));

  await clickSel('.row-input');
  await typeText('真点击验收');
  await sleep(900);
  const typed = await cdp.eval(`
    var L = window.__liji;
    var d = null;
    for (var i = 0; i < L.S.documents.length; i++) if (L.S.documents[i].id === L.S.activeDocId) d = L.S.documents[i];
    var hit = !!(d && (d.nodes || []).some(function (n) { return (n.text || '').indexOf('真点击验收') >= 0; }));
    var store = '';
    try { store = localStorage.getItem('liji_store:documents') || ''; } catch (e) { }
    return { hit: hit, inStore: store.indexOf('真点击验收') >= 0 };`);
  check('真键盘打的字进了当前文档', typed.hit === true, JSON.stringify(typed));
  check('字已经落到本机存储', typed.inStore === true, JSON.stringify(typed));

  const clickedMap = await clickByText('.seg .opt', '导图');
  await sleep(1200);
  const mapSeen = await cdp.eval(`
    var boxes = document.querySelectorAll('.map-box');
    var txt = Array.from(boxes).map(function (b) { return b.textContent || ''; }).join('|');
    return { boxes: boxes.length, hasText: txt.indexOf('真点击验收') >= 0 };`);
  check('真点「导图」切过去且画出了主题框', clickedMap === true && mapSeen.boxes > 0, 'boxes=' + mapSeen.boxes);
  check('导图里的文字完整（没被截断）', mapSeen.hasText === true, JSON.stringify(mapSeen));

  await cdp.send('Page.navigate', { url: base });
  await cdp.waitFor(`return !!document.getElementById('app') && document.getElementById('app').childElementCount > 0;`, 15000);
  await sleep(1500);
  const kept2 = await cdp.eval(`
    var L = window.__liji;
    return { n: L.S.documents.length,
             hit: L.S.documents.some(function (d) { return (d.nodes || []).some(function (x) { return (x.text || '').indexOf('真点击验收') >= 0; }); }) };`);
  check('重开后真点建的那篇还在（存本机）', kept2.hit === true, JSON.stringify(kept2));

  /* ---------- ⑩ 「同步与存储」页能滚到底 ----------
   * 2026-10-06 用户报的 bug：这一屏滚不动。根因是 .main 为 overflow:hidden，
   * 而这一屏的内容直接堆在 .screen 上没有滚动容器 —— 超出视口的部分被裁掉且滚不动，
   * 「本机存储」那张卡永远看不见。
   * ★ 必须把视口压矮再测：大视口下内容装得下，「滚不动」这个毛病根本不会暴露。 */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 620, deviceScaleFactor: 1, mobile: false });
  await cdp.eval(`window.__liji.S.showEditor = false; window.__liji.render(); return true;`);  // 只为回到导航态，被测的是下面的滚动
  await sleep(400);
  await clickByText('.side-item', '同步与存储');
  await sleep(800);
  const scroller = await cdp.eval(`
    var box = document.querySelector('.profile-scroll');
    if (!box) return { has: false };
    var cards = document.querySelectorAll('.profile-scroll .vip-card');
    var last = cards.length ? cards[cards.length - 1] : null;
    return { has: true, sh: box.scrollHeight, ch: box.clientHeight,
             overflowY: getComputedStyle(box).overflowY,
             cards: cards.length,
             lastBottom: last ? Math.round(last.getBoundingClientRect().bottom) : -1,
             viewport: window.innerHeight };`);
  check('有滚动容器且 overflow-y:auto', scroller.has === true && scroller.overflowY === 'auto', JSON.stringify(scroller));
  check('内容确实超出视口（这条不成立就白测了）', scroller.sh > scroller.ch + 2, scroller.sh + ' / ' + scroller.ch);

  /* 真滚轮：位置必须真的动，光有 overflow:auto 不够（父级裁切也会让它白搭） */
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: 2000 });
  await sleep(700);
  const scrolled = await cdp.eval(`
    var box = document.querySelector('.profile-scroll');
    var cards = document.querySelectorAll('.profile-scroll .vip-card');
    var last = cards.length ? cards[cards.length - 1] : null;
    return { top: box ? box.scrollTop : -1,
             lastVisible: last ? (last.getBoundingClientRect().bottom <= window.innerHeight + 2) : false };`);
  check('滚轮真的把这一屏滚下去了', scrolled.top > 0, 'scrollTop=' + scrolled.top);
  check('滚到底能看见最后一张卡（本机存储）', scrolled.lastVisible === true, JSON.stringify(scrolled));

  /* ---------- ⑪ 矮窗口下贴底浮层不能被裁 ----------
   * 同一个根因的另一半：浮层是 align-self:flex-end **向上生长**的，超高时裁的是**顶部**，
   * 而「最底元素能不能滚到」这条判据测不出来（浮层本来就贴着底）。
   * 实测 360px 高时模板浮层标题被顶到视口外 -22px，连关闭 × 都够不着。
   * 修法是给浮层加 .sheet.tall（max-height:88% + overflow-y:auto）—— 这个样式以前写了没人用。 */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 360, deviceScaleFactor: 1, mobile: false });
  await cdp.eval(`window.__liji.S.showEditor = false; window.__liji.S.tab = '首页'; window.__liji.render(); return true;`);
  await sleep(500);
  await clickSel('.new-btn');
  const sheetOpen = await cdp.waitFor(`return !!document.querySelector('.sheet');`, 6000);
  await clickByText('.tpl-row', '自定义');      // 展开自定义表单，内容最高
  await sleep(600);
  const sheet = await cdp.eval(`
    var s = document.querySelector('.sheet');
    if (!s) return { has: false };
    var r = s.getBoundingClientRect();
    var first = s.firstElementChild;
    return { has: true, top: Math.round(r.top), h: Math.round(r.height),
             sh: s.scrollHeight, ch: s.clientHeight, oy: getComputedStyle(s).overflowY,
             firstTop: first ? Math.round(first.getBoundingClientRect().top) : null,
             vh: window.innerHeight };`);
  check('矮窗口下模板浮层打开了', sheetOpen.ok === true && sheet.has === true, JSON.stringify(sheet));
  /* ★ 参照物必须是**视口**，不能是浮层自己：浮层没高度上限时它会一路长到 589px
   * （视口只有 360），最后一个元素的 bottom 仍等于浮层自己的 bottom —— 拿浮层当参照
   * 会得到「都看得见」的假结论（对照实验里这条就没红）。多出来的 229px 落在视口下面，
   * 父级 #app 又是 overflow:hidden，于是彻底滚不到。 */
  const sheetBottom = await cdp.eval(`
    var s = document.querySelector('.sheet');
    if (!s) return { has: false };
    s.scrollTop = 99999;
    var kids = s.children;
    var last = kids[kids.length - 1];
    var lr = last.getBoundingClientRect();
    return { has: true, scrollTop: s.scrollTop, oy: getComputedStyle(s).overflowY,
             sh: s.scrollHeight, ch: s.clientHeight,
             lastBottom: Math.round(lr.bottom), vh: window.innerHeight,
             lastInViewport: lr.bottom <= window.innerHeight + 2,
             lastText: (last.textContent || '').trim().slice(0, 16) };`);
  /* 防白测：内容得真的比视口高。参照物用视口而不是浮层自己 ——
   * 没有高度上限时浮层会长到跟内容一样高（sh === ch），拿自己比会误判成「没超出」。 */
  check('浮层内容确实比视口高（这条不成立就白测了）', sheetBottom.sh > sheetBottom.vh + 2, sheetBottom.sh + ' / 视口' + sheetBottom.vh);
  check('浮层里的内容滚到底能全看见（没被吞在视口下面）',
    sheetBottom.has === true && sheetBottom.lastInViewport === true, JSON.stringify(sheetBottom));
  check('浮层自己能滚（超高时内部滚，不是被裁掉）', sheet.oy === 'auto' && sheet.sh > sheet.ch, JSON.stringify(sheet));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 300, deltaX: 0, deltaY: 600 });
  await sleep(500);
  const sheetMoved = await cdp.eval(`var s = document.querySelector('.sheet'); return { top: s ? s.scrollTop : -1 };`);
  check('浮层里滚轮真的能用', sheetMoved.top > 0, 'scrollTop=' + sheetMoved.top);

  /* ---------- ⑫½ Markdown 导入 / 导出（2026-10-07，与 LiJi-Cloud 同步的功能）---------- */
  const mdBtn = await cdp.eval(`var b = Array.prototype.filter.call(document.querySelectorAll('.folder-new'), function (x) { return (x.textContent || '').indexOf('导入') >= 0; })[0]; return b ? b.textContent.trim() : '';`);
  check('首页有「⤓ 导入」按钮', mdBtn.indexOf('导入') >= 0, JSON.stringify(mdBtn));
  const mdRound = await cdp.eval(`var L = window.__liji; if (!L || !L.parseMarkdownToNodes || !L.serializeNodesToMd) return 'missing';
    var src = '# 甲\\n正文\\n## 乙\\n### 丙';
    var nodes = L.parseMarkdownToNodes(src);
    var back = L.serializeNodesToMd(nodes);
    var again = L.parseMarkdownToMd ? [] : L.parseMarkdownToNodes(back);
    return JSON.stringify({ lv: nodes.map(function (n) { return n.level; }), round: again.map(function (n) { return [n.level, n.text]; }) });`);
  check('md 解析/导出函数在位且往返一致（1/2/3 级不变）',
    mdRound.indexOf('"lv":[1,2,3]') >= 0 && mdRound.indexOf('[[1,"甲\\n正文"],[2,"乙"],[3,"丙"]]') >= 0, mdRound);

  /* ---------- ⑫¼ 按钮改版 / 首主题一级 / 删除归并（2026-10-08，与 LiJi-Cloud 同步）---------- */
  const btnTxt = await cdp.eval(`var b = document.querySelectorAll('.folder-new')[0]; return b ? b.textContent.trim() : '';`);
  check('「新建文件夹」按钮文案干净（图标是 SVG，没有多余前缀）', btnTxt === '新建文件夹', JSON.stringify(btnTxt));
  const svgCnt = await cdp.eval(`return document.querySelectorAll('.folder-new svg').length;`);
  check('两个首页按钮都渲染出了线性 SVG 图标', svgCnt >= 2, 'svg=' + svgCnt);
  const newFeat = await cdp.eval(`var L = window.__liji; if (!L || !L.normalizeFirstLevel || !L.deleteRow) return 'missing';
    var a = L.parseMarkdownToNodes('### 三级开头\\n#### 四级跟屁\\n# 一级');
    var doc = { id: 9527, title: 't', nodes: [
      { id: 1, text: 'A', level: 1, children: [] }, { id: 2, text: 'B', level: 2, children: [] },
      { id: 3, text: 'C', level: 2, children: [] }, { id: 4, text: 'C1', level: 3, children: [] },
      { id: 5, text: 'D', level: 1, children: [] } ] };
    L.S.documents = L.S.documents.filter(function (d) { return d.id !== 9527; }).concat([
      { id: 9527, title: 't', nodes: [
        { id: 1, text: 'A', level: 1, children: [] }, { id: 2, text: 'B', level: 2, children: [] },
        { id: 3, text: 'C', level: 2, children: [] }, { id: 4, text: 'C1', level: 3, children: [] },
        { id: 5, text: 'D', level: 1, children: [] } ] }]);
    L.S.activeDocId = 9527;
    var r = L.deleteRow(3);
    /* commitNodes 会整体替换文档对象 —— 必须从 S.documents 重新取，别信删之前抓的引用 */
    var after = L.S.documents.filter(function (d) { return d.id === 9527; })[0].nodes
      .map(function (n) { return n.level + ':' + n.text; }).join('|');
    return JSON.stringify({ imp: a.map(function (n) { return n.level; }), r: r, after: after });`);
  check('以 ### 开头的 md：首主题钳成一级、跳级拉平（1/2/1）',
    newFeat.indexOf('"imp":[1,2,1]') >= 0, newFeat);
  check('删 C：子主题级别不变、归到前一个母主题 B 名下（sibling）',
    newFeat.indexOf('"r":{"kids":1,"mode":"sibling"}') >= 0 && newFeat.indexOf('1:A|2:B|3:C1|1:D') >= 0, newFeat);
  await cdp.eval(`window.__liji.S.documents = window.__liji.S.documents.filter(function (d) { return d.id !== 9527; });
    window.__liji.S.activeDocId = window.__liji.S.documents.length ? window.__liji.S.documents[0].id : 0; return true;`);

  /* ---------- ⑫ 收尾：页面没有报错 ---------- */
  collectErrors();
  const real = pageErrors.filter(e => !/favicon|net::ERR_/.test(e));
  check('页面运行期无 JS 报错', real.length === 0, real.slice(0, 3).join(' | '));
  check('结束后仍没有 /api 请求', apiHits.length === 0, apiHits.join(', '));

  cdp.close();
  child.kill();
  await srv.close();
  try { site.server.close(); } catch (e) { }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }

  console.log('\n' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('自检自身出错：', e && e.stack || e);
  process.exit(1);
});
