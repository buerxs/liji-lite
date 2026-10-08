/*
 * 理记 · 轻享版 —— 桌面端真实窗口截图
 * ============================================================================
 * 做什么：用**源码态的 Electron 起一个真实窗口**（不是无头浏览器），连 CDP 真点几下，
 *         把首页 / 模板浮层 / 同步与存储 三张界面图存到 _e2e-shots/。
 *
 * 为什么要在源码态跑而不是跑打好的 exe：
 *   ① 便携版 exe **不转发 --remote-debugging-port**（实测端口起不来），连不上 CDP；
 *      源码态可以，而源码态加载的 electron/web/ 就是打包时暂存的那一份，内容与包内一致。
 *   ② 冒烟（--smoke）是不建窗口的，看不出界面长什么样；这个脚本补的就是「有窗口」这一环。
 *
 * ★ 环境限制（本机实测，2026-10-06）：这台机器上任何 Electron 进程会在约 6 秒后
 *   被环境终止（退出码 9，与 --no-sandbox / --disable-gpu / --compat 都无关）。
 *   冒烟之所以「成功」，是因为它在这 6 秒内就跑完断言并写好结果文件 ——
 *   它的退出码从来没被检查过（tools/build-exe.js 只看结果文件）。
 *   所以本脚本一切都要快：连端口 → 等渲染 → 截图，都在那几秒里完成。
 *
 * 用法： node tools/shot-desktop.js
 * 依赖： electron/node_modules（没装就先 npm install，见 打包.bat）
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const electronEnv = require('./electron-env');

const gbk = require('./gbk');
if (gbk.patchWindowsStdout) gbk.patchWindowsStdout();

const ROOT = electronEnv.ROOT;
const APP = path.join(ROOT, 'electron');
const OUT = path.join(ROOT, '_e2e-shots');
const PORT = 9502;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failed = 0;
function check(name, ok, extra) {
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (extra ? '  ' + extra : ''));
  if (!ok) failed++;
}

(async () => {
  const electron = electronEnv.electronPath();
  if (!fs.existsSync(electron)) {
    console.log('  没找到 electron（先跑 打包.bat 或进 electron 目录 npm install），跳过截图');
    process.exit(0);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const env = Object.assign({}, process.env);
  /* 不删这个变量的话，electron.exe 会被当成 node 跑，直接执行 main.js 报 app.setName 未定义 */
  delete env.ELECTRON_RUN_AS_NODE;
  env.LIJI_TEST_NO_SANDBOX = '1';                  // 受限环境里 Chromium 沙箱子进程会被杀

  console.log('\n===== 桌面端真实窗口截图 =====\n');
  const child = spawn(electron, [APP, '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(require('os').tmpdir(), 'liji-shot-' + Date.now().toString(36))],
    { cwd: APP, env, stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (e) { }
    if (!target) await sleep(120);
  }
  if (!target) { check('连上真实窗口的调试端口', false, '端口 ' + PORT + ' 没起来'); try { child.kill(); } catch (e) { } process.exit(1); }
  check('连上真实窗口的调试端口', true, '端口 ' + PORT);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params) => new Promise(res => {
    const myId = ++id; pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
  });
  const ev = async (code) => {
    const r = await send('Runtime.evaluate', { expression: `(()=>{${code}})()`, returnByValue: true });
    return (r.result && r.result.result) ? r.result.result.value : undefined;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (!s.result || !s.result.data) return null;
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'));
    return { file: file, bytes: Buffer.from(s.result.data, 'base64').length };
  };
  const clickSel = async (sel) => {
    const box = await ev(`
      var e = document.querySelector('${sel}');
      if (!e) return null;
      var r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) };`);
    if (!box || !box.w) return false;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    return true;
  };
  const clickText = async (sel, text) => {
    const box = await ev(`
      var list = Array.prototype.slice.call(document.querySelectorAll('${sel}'));
      var e = null;
      for (var i = 0; i < list.length; i++) if ((list[i].textContent || '').indexOf(${JSON.stringify(text)}) >= 0) { e = list[i]; break; }
      if (!e) return null;
      var r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) };`);
    if (!box || !box.w) return false;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    return true;
  };

  await send('Page.enable'); await send('Runtime.enable');

  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    const n = await ev(`return (document.getElementById('app') && document.getElementById('app').childElementCount) || 0;`);
    if (n > 0) ready = true; else await sleep(120);
  }
  check('真实窗口里页面渲染出内容', ready === true);
  const info = await ev(`return { title: document.title, docs: (window.__liji && window.__liji.S.documents || []).length };`);
  check('窗口里标题是「理记-轻享版」', info && info.title === '理记-轻享版', info ? info.title : '(没拿到)');

  let s = await shot('desktop-首页.png');
  check('首页截图已生成', !!s && s.bytes > 5000, s ? (s.bytes + ' B  ' + path.basename(s.file)) : '失败');

  /* 真点一次「＋ 新建文档」——证明窗口里的按钮真能点，顺便截浮层 */
  const clicked = await clickSel('.side-new');
  await sleep(450);
  const sheetOn = await ev(`return !!document.querySelector('.sheet .tpl-row');`);
  check('窗口里真点「＋ 新建文档」弹出模板浮层', clicked === true && sheetOn === true);
  if (sheetOn) {
    s = await shot('desktop-模板浮层.png');
    check('模板浮层截图已生成', !!s && s.bytes > 5000, s ? (s.bytes + ' B') : '失败');
  }
  await ev(`window.__liji.S.showTemplateSheet = false; window.__liji.render(); return true;`);
  await sleep(300);

  /* 同步与存储页（2026-10-06 修过滚动的那一屏） */
  const toSync = await clickText('.side-item', '同步与存储');
  await sleep(600);
  const onSync = await ev(`return !!document.querySelector('.profile-scroll');`);
  check('窗口里能切到「同步与存储」', toSync === true && onSync === true);
  if (onSync) {
    s = await shot('desktop-同步与存储.png');
    check('同步与存储截图已生成', !!s && s.bytes > 5000, s ? (s.bytes + ' B') : '失败');
  }

  ws.close(); try { child.kill(); } catch (e) { }
  console.log('');
  console.log(failed === 0 ? '  截图完成，见 _e2e-shots/' : '  有 ' + failed + ' 项失败');
  console.log('');
  process.exit(failed === 0 ? 0 : 1);
})();
