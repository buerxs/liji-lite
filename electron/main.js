/* =====================================================================
 * 理记 · Windows 桌面客户端 —— Electron 主进程
 * ---------------------------------------------------------------------
 * 这个文件干四件事：
 *   1) 把网页版客户端（index.html / app.js / styles.css）装进原生窗口里；
 *   2) 顺手把本地服务端（server.js）起在同一个进程里 —— 账号、会员、
 *      兑换码、云端文档、公告全都随开随用，不需要另外双击「启动.bat」；
 *   3) 决定数据放在哪（便携版放 exe 旁边，安装版放用户目录），
 *      文件都在，随时可以自己备份；
 *   4) 提供中文菜单：数据目录、开发者工具。
 *
 * ★ 客户端**不提供后台管理入口**：后台只给管理员用，普通用户连菜单都看不到。
 *   需要进后台时直接浏览器打开「服务地址 + /admin」。
 *
 * 数据目录优先级：
 *   LIJI_DATA_DIR 环境变量  >  便携版 exe 同级的「理记数据」目录  >  %APPDATA%\理记\data
 *
 * 命令行参数：
 *   --smoke   无界面冒烟自检：起服务、加载页面、断言关键元素，然后退出（供打包后回归用）
 *
 * ★★ 本副本是「轻享版」：没有远程后端，只有本地模式 ——
 *    起内嵌的静态服务、窗口加载包内 web/。不联网也能用；
 *    想多设备同步就在「同步与存储」里填自己的对象存储。
 * ===================================================================== */
'use strict';

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

/* 应用名要在 app ready 之前定下来：userData 路径由它决定。
 * 不设的话开发态会用 package.json 的 name（liji），打包态用 productName（理记），
 * 同一个应用出现两个数据目录，很坑。 */
app.setName('理记');

const IS_SMOKE = process.argv.includes('--smoke');
/* 诊断用：让自检也把窗口显示出来（定位「只在显示窗口时才崩」这类问题） */
const SMOKE_SHOW = process.env.LIJI_SMOKE_SHOW === '1';
/* 诊断用：禁用所有弹窗（定位「弹窗导致渲染进程崩溃」这类问题） */
const NO_DIALOG = process.env.LIJI_NO_DIALOG === '1';
const WEB_DIR = path.join(__dirname, 'web');          // 客户端静态文件（打包进 asar）
const DEFAULT_PORT = 5173;                            // 与「启动.bat」的开发服务保持一致
const FALLBACK_PORTS = [5174, 5175, 5176, 5180];      // 5173 被别的程序占用时的备选

/* ★ 轻享版**只有本地模式**：窗口加载包内 web/，由内嵌的 server.js（纯静态服务）托管。
 * 没有远程后端、没有账号接口 —— 云端是用户自己在「同步与存储」里填的对象存储。
 * 想临时指向别处才需要设 LIJI_REMOTE。 */
const REMOTE_BASE = (process.env.LIJI_REMOTE !== undefined
  ? process.env.LIJI_REMOTE
  : '').replace(/\/+$/, '');
const IS_CLOUD = !!REMOTE_BASE;

/* ============================== 显卡/沙箱兼容模式 ==============================
 * 症状与成因（本机实测结论，别再重复踩）：
 *   受限环境（容器、CI、被安全软件接管的会话）里 Chromium 的沙箱子进程会被杀，
 *   表现为 GPU 进程反复退出、页面直接 ERR_FAILED 白屏；
 *   只加 --disable-gpu 或 --disable-gpu-sandbox 都救不回来，会 FATAL
 *   「GPU process isn't usable. Goodbye.」；真正管用的是
 *   「disableHardwareAcceleration + --no-sandbox + --in-process-gpu」这一组。
 *
 * 策略（安全与可用性兼顾）：
 *   正式运行默认保持沙箱与硬件加速 —— 正常机器上这才是对的；
 *   只有在「自己遇到故障」时才切兼容模式，并写标记让后续启动直接生效：
 *     a) GPU 进程被打死 / 页面加载失败 → 自动写标记 + 用兼容模式重启一次；
 *     b) 测试夹具显式声明 LIJI_TEST_NO_SANDBOX=1（说明跑在受限环境）→ 直接兼容模式，
 *        这样自检脚本本身在任何环境都跑得通。
 *   用户手动控制： --compat 强制兼容、 --no-compat 忽略标记走正常模式。
 *   标记文件： <用户目录>\compat-mode.flag，删掉即恢复默认。 */
const COMPAT_FLAG = path.join(app.getPath('userData'), 'compat-mode.flag');
const COMPAT_NOTIFIED_FLAG = path.join(app.getPath('userData'), 'compat-mode-notified.flag');
const LAUNCH_STATE = path.join(app.getPath('userData'), 'launch-state.json');
const TEST_NO_SANDBOX = process.env.LIJI_TEST_NO_SANDBOX === '1';
let compatFlagExists = false;
try { compatFlagExists = fs.existsSync(COMPAT_FLAG); } catch (e) { }

/* 启动状态指纹：上次「起来了、页面也加载完了、还正常退出过」吗？
 * 三者缺一，就说明上次是异常收场的（可能是 GPU 崩溃快到来不及自救），
 * 这次直接进兼容模式。这是比「等崩溃事件」更靠得住的一道兜底。 */
function readLaunchState() {
  try { return JSON.parse(fs.readFileSync(LAUNCH_STATE, 'utf8')); } catch (e) { return {}; }
}
function writeLaunchState(patch) {
  try {
    fs.mkdirSync(path.dirname(LAUNCH_STATE), { recursive: true });
    fs.writeFileSync(LAUNCH_STATE, JSON.stringify(Object.assign(readLaunchState(), patch)));
  } catch (e) { }
}
const prevLaunch = readLaunchState();
const lastLaunchCrashed = !!(prevLaunch.startedAt && !prevLaunch.loadedAt && !prevLaunch.exitedAt);
if (!IS_SMOKE) writeLaunchState({ startedAt: Date.now(), loadedAt: 0, exitedAt: 0 });

const COMPAT = TEST_NO_SANDBOX
  || process.argv.includes('--compat')
  || lastLaunchCrashed
  || (compatFlagExists && !process.argv.includes('--no-compat'));

if (COMPAT) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('in-process-gpu');
}

function writeCompatFlag(reason) {
  try {
    fs.mkdirSync(path.dirname(COMPAT_FLAG), { recursive: true });
    fs.writeFileSync(COMPAT_FLAG, '理记已切换到兼容显示模式\n原因 ' + reason
      + '\n时间 ' + new Date().toISOString()
      + '\n恢复默认：删掉本文件\n');
  } catch (e) { }
}

/* 把启动异常也留一份可查的记录：白屏退出时用户看不到控制台，只能靠文件 */
function writeStartupTrouble(reason) {
  try {
    const dir = process.env.LIJI_DATA_DIR || app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, '启动异常记录.txt'),
      '[' + new Date().toISOString() + '] ' + reason + '\n');
  } catch (e) { }
}

/* 同步等待：兼容模式重启时，新实例必须先等旧实例把「单实例锁」和 5173 端口放掉，
 * 否则新实例要么被单实例锁挡回去直接退出，要么把旧实例还没关掉的服务当成「已在运行」而复用
 * —— 旧实例一退，服务就断了。Atomics.wait 是 Node 里唯一不带回调的同步 sleep。 */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, 5000)); } catch (e) { }
}

let mainWindow = null;
let childWindow = null;
let lijiModule = null;
let smokeTempDir = null;
let compatRelaunching = false;

/* 出故障时的统一自救：写兼容标记 → 立刻用兼容模式重启。
 * 为什么不在崩溃前弹窗问用户：GPU 进程连续崩溃后 Chromium 会直接 FATAL
 * （GPU process isn't usable. Goodbye.），进程一两秒内就没了，弹窗根本来不及交互。
 * 所以这里只做「写标记 + 立即重启」，重启后的实例自己会告诉用户发生了什么。 */
function recoverToCompatMode(reason) {
  if (IS_SMOKE) return;                        // 自检不做重启，由测试夹具判定
  writeStartupTrouble(reason);
  console.log('  [自救] ' + reason + ' → 切换到兼容模式并重启');

  if (COMPAT) {
    /* 已经在兼容模式还是不行：不再折腾，把话说清楚（能不能显示出来就看运气了） */
    try {
      dialog.showErrorBox('理记 · 启动异常',
        '页面仍然无法正常显示。\n\n原因：' + reason
        + '\n\n可以试这几步：\n'
        + '1. 关掉本窗口，重新打开一次；\n'
        + '2. 若装过杀毒/安全软件，把它对本程序放行；\n'
        + '3. 删掉兼容标记后重开：\n' + COMPAT_FLAG + '\n'
        + '4. 详细记录见数据目录下的「启动异常记录.txt」：\n' + (process.env.LIJI_DATA_DIR || ''));
    } catch (e) { }
    app.exit(1);
    return;
  }

  if (compatRelaunching) return;
  compatRelaunching = true;
  writeCompatFlag(reason);
  stopServer();                                // 先放开端口，见 sleepSync 的说明

  /* 只带上我们自己认的 -- 开关：argv[1] 在打包态是应用路径，传下去只会让日志更难读 */
  const args = process.argv.slice(1)
    .filter((a) => a.startsWith('--') && a !== '--compat' && a !== '--smoke' && !a.startsWith('--wait='))
    .concat(['--compat', '--wait=900']);
  const opts = { args };
  /* 便携版要重启「最初那个 exe」而不是解压出来的临时副本 ——
   * 否则临时目录随外壳退出被清掉，新进程连文件都没有了。 */
  if (process.env.PORTABLE_EXECUTABLE_FILE) opts.execPath = process.env.PORTABLE_EXECUTABLE_FILE;
  try { app.relaunch(opts); } catch (e) { console.log('  [自救] 重启失败：' + e.message); }
  app.exit(0);
}

/* GPU 进程被打死是最早出现的征兆，先记下来 */
app.on('child-process-gone', (event, details) => {
  if (!details || details.type !== 'GPU') return;
  console.log('  [警告] GPU 进程异常退出（reason=' + details.reason + '）');
  if (COMPAT || IS_SMOKE) return;
  /* 当前窗口大概率已经白屏，直接走兼容模式重启，别让用户盯着白屏等 */
  recoverToCompatMode('显卡进程反复异常退出（' + details.reason + '）');
});

/* 兼容模式已经跑通之后，再告诉用户一声（一次性）。
 * 放在「页面加载完成」之后提示，是因为这时窗口肯定已经能正常显示了，
 * 弹窗不会再和崩溃抢时间。 */
function notifyCompatIfNeeded() {
  if (NO_DIALOG) return;                       // 诊断用：完全跳过弹窗
  if (!COMPAT || IS_SMOKE || TEST_NO_SANDBOX) return;
  if (!compatFlagExists && !lastLaunchCrashed) return;   // 用户自己加 --compat 的不提示
  try { if (fs.existsSync(COMPAT_NOTIFIED_FLAG)) return; } catch (e) { }
  try { fs.writeFileSync(COMPAT_NOTIFIED_FLAG, new Date().toISOString()); } catch (e) { }
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '理记 · 兼容模式',
    message: '已用兼容模式启动，界面显示正常。',
    detail: '上次启动时检测到显示环境异常（显卡驱动或安全软件限制，导致 Chromium 渲染进程无法工作），'
      + '已自动切换为兼容模式。\n\n文字类应用基本感觉不到性能差别。\n\n'
      + '想恢复默认：删掉下面这个文件后重新打开\n' + COMPAT_FLAG,
    buttons: ['知道了']
  }).catch(() => { });
}

/* ============================== 数据目录 ============================== */
function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.writable-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (e) { return false; }
}

function resolveDataDir() {
  if (process.env.LIJI_DATA_DIR) return path.resolve(process.env.LIJI_DATA_DIR);

  if (IS_SMOKE) {
    /* 冒烟自检绝不能动用户的真实数据：用一个临时目录，跑完删掉 */
    smokeTempDir = path.join(os.tmpdir(), 'liji-smoke-' + process.pid);
    return smokeTempDir;
  }

  /* 便携版：数据放在 exe 旁边，U 盘/换电脑直接带走整个文件夹 */
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) {
    const candidate = path.join(portableDir, '理记数据');
    if (canWrite(candidate)) return candidate;
  }

  /* 安装版 / 开发态：用户目录 */
  return path.join(app.getPath('userData'), 'data');
}

/* ============================== 服务端 ============================== */
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1200 }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { }
        resolve(json && json.ok ? 'liji' : 'other');
      });
    });
    req.on('error', (e) => resolve(e.code === 'ECONNREFUSED' ? 'free' : 'other'));
    req.on('timeout', () => { try { req.destroy(); } catch (e) { } resolve('other'); });
  });
}

/* 返回 { base, reused }。reused=true 表示复用了已有服务（例如开发态开着「启动.bat」） */
async function bootServer(dataDir) {
  const first = await probe(DEFAULT_PORT);
  if (first === 'liji') {
    return { base: 'http://127.0.0.1:' + DEFAULT_PORT, reused: true };
  }

  let port = DEFAULT_PORT;
  if (first === 'other') {
    /* 5173 被别的程序占了（不是理记）：换一个空闲端口起自己的服务。
     * 端口一变，localStorage 的 origin 也变，所以只在确实冲突时才换。 */
    port = 0;
    for (const candidate of FALLBACK_PORTS) {
      if (await probe(candidate) === 'free') { port = candidate; break; }
    }
    if (!port) throw new Error('5173 端口被其它程序占用，备用端口（' + FALLBACK_PORTS.join('/') + '）也都被占用了。请关闭占用者后重试。');
  }

  process.env.PORT = String(port);
  process.env.LIJI_EMBEDDED = '1';        // 启动失败不要 process.exit —— 那会把窗口一起关掉
  process.env.LIJI_DATA_DIR = dataDir;
  /* 没有控制台（双击启动）时别往 stdout 写，日志仍然照常落 server.log */
  if (!process.stdout || !process.stdout.isTTY) process.env.LIJI_QUIET = '1';

  lijiModule = require(path.join(WEB_DIR, 'server.js'));
  await new Promise((resolve, reject) => {
    lijiModule.server.once('listening', resolve);
    lijiModule.server.once('liji-start-failed', reject);
    try { lijiModule.start(); } catch (e) { reject(e); }
  });
  const actual = lijiModule.server.address().port;
  return { base: 'http://127.0.0.1:' + actual, reused: false };
}

function stopServer() {
  if (!lijiModule || !lijiModule.server) return;
  try { lijiModule.server.close(); } catch (e) { }
  lijiModule = null;
}

/* ============================== 窗口 ============================== */
function createMainWindow(base) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#E6E9E4',
    title: '理记 · 轻享版',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  /* 窗口标题固定为「理记」，**不让页面标题覆盖它**（2026-09-22 实测后才加的）：
   * 窗口加载的是前端页面，而页面的 <title> 是「理记-网页端」（需求 #3 指定的名字）——
   * Electron 默认会让页面标题盖掉上面那个 `title: '理记'`，结果**桌面客户端的标题栏写着「网页端」**。
   * 实测（一次性探针真读 win.getTitle()）：建窗后是「理记」，页面加载完变成「理记-网页端」。
   * 拦掉之后两边各自正确：桌面窗口标题栏 = 「理记」，浏览器标签页标题 = 「理记-网页端」。
   * 冒烟里有一条断言钉住它 —— 注意断言必须读 `mainWindow.getTitle()`，
   * 读 `document.title` 只能证明页面标题，**证明不了窗口标题**。 */
  mainWindow.on('page-title-updated', (e) => { e.preventDefault(); });

  /* 公告里的站内链接落到独立小窗（不打断正在编辑的页面），站外链接交给系统浏览器 */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(base)) { openChildWindow(url); return { action: 'deny' }; }
    if (/^https?:/i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  mainWindow.once('ready-to-show', () => { if (!IS_SMOKE || SMOKE_SHOW) mainWindow.show(); });
  mainWindow.on('closed', () => { mainWindow = null; });

  /* 页面渲染出来了就先让窗口露脸；万一 ready-to-show 因为渲染异常一直不来，
   * 也不能让用户对着「什么都不出现」—— 三秒兜底显示一次。 */
  mainWindow.webContents.once('did-finish-load', () => {
    if (IS_SMOKE && !SMOKE_SHOW) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    notifyCompatIfNeeded();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    /* 页面真的加载出来了 —— 记下「这次启动是好的」，下次就不会误判为崩溃 */
    writeLaunchState({ loadedAt: Date.now() });
  });
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible() && (!IS_SMOKE || SMOKE_SHOW)) mainWindow.show();
  }, 3000);

  /* 页面没能加载出来（白屏）是最坏的用户体验，这里主动兜底切兼容模式 */
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return;                       // ERR_ABORTED：正常的导航被取消
    console.log('  [警告] 页面加载失败 ' + desc + ' (' + code + ') ' + url);
    recoverToCompatMode('页面加载失败：' + desc + ' (' + code + ')');
  });
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    console.log('  [警告] 渲染进程退出 reason=' + (details && details.reason)
      + ' exitCode=' + (details && details.exitCode));
    recoverToCompatMode('渲染进程异常退出（' + ((details && details.reason) || '未知') + '）');
  });

  return mainWindow.loadURL(base + '/');
}

/* 打开一个站内链接（公告正文里的链接、或页面里 target=_blank 的内部地址）。
 * 刻意不叫「后台管理」—— 普通用户不该在客户端里见到后台的任何入口。 */
function openChildWindow(url) {
  if (!url) return;
  if (childWindow && !childWindow.isDestroyed()) {
    childWindow.loadURL(url);
    childWindow.focus();
    return;
  }
  childWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#F4F6F3',
    title: '理记 · 轻享版',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  childWindow.setMenuBarVisibility(false);
  /* 与主窗同理：小窗标题栏也固定「理记」，别跟着页面标题变成「理记-网页端」。 */
  childWindow.on('page-title-updated', (e) => { e.preventDefault(); });
  childWindow.on('closed', () => { childWindow = null; });
  childWindow.loadURL(url);
}

function openDataDir() {
  const dir = process.env.LIJI_DATA_DIR;
  if (!dir) return;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
  shell.openPath(dir);
}

/* 兼容模式是「自救」留下的状态，用户得能自己撤掉 ——
 * 不能让一个 AppData 里的文件成为他永远搞不定的开关。 */
function resetCompatMode() {
  let removed = false;
  for (const f of [COMPAT_FLAG, COMPAT_NOTIFIED_FLAG]) {
    try { if (fs.existsSync(f)) { fs.unlinkSync(f); removed = true; } } catch (e) { }
  }
  dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    title: '理记 · 显示模式',
    message: removed ? '已恢复默认显示模式' : '当前就是默认显示模式',
    detail: (removed ? '请关掉理记再重新打开，新设置才会生效。' : '没有找到兼容模式标记文件。')
      + '\n\n如果重开后界面显示异常，理记会自动切回兼容模式，不影响使用。',
    buttons: ['知道了']
  }).catch(() => { });
}

/* ============================== 菜单 ============================== */
/* 菜单不再需要 base —— 关于框里已经不显示服务器地址了（2026-09-22） */
/* ★ 关于框的文案抽成纯函数 —— **这样做是为了让它能被自检断言**（2026-09-22）。
 * 原来这段文案内联在菜单项的 click 回调里，而 dialog 只在用户真去点菜单时才会弹，
 * 自检**根本碰不到它**。于是用户明确提过的两条要求一直处于「代码改了、但没有任何证据」的状态：
 *   ① 关于框里不许出现服务器 IP（地址属于运维细节，不该给最终用户看）；
 *   ② 客户端名称里不许带「云端版」三个字。
 * 抽成函数之后，冒烟可以直接调它并断言文案本身 —— 不需要真的弹一个对话框。 */
function aboutBoxText() {
  return {
    title: '关于理记',
    message: '理记 · 大纲与思维导图笔记',
    /* 关于框里**不显示服务器地址**（用户 2026-09-22 要求删除）：
     * 真要排查连不上，看启动日志的 `[启动] 云端模式，后端 = …` 就够了。 */
    detail: [
      '版本 ' + app.getVersion(),
      IS_CLOUD
        ? '数据保存在服务器上，登录同一账号即可与网页端互通。'
        : '数据目录 ' + (process.env.LIJI_DATA_DIR || '(未设置)'),
      '',
      IS_CLOUD
        ? '本机客户端只是外壳，编辑内容会同步到云端。'
        : '数据都在你自己电脑上，直接复制数据目录即可备份或迁移。'
    ].join('\n')
  };
}

function buildMenu() {
  const template = [
    {
      label: '理记',
      submenu: [
        /* 云端版数据在服务器上，本机没有数据目录可开 */
        ...(IS_CLOUD ? [] : [{ label: '打开数据目录', click: openDataDir }]),
        /* 只有确实进过兼容模式才显示，免得平时菜单里多一个看不懂的项 */
        ...(compatFlagExists ? [{ label: '恢复默认显示模式', click: resetCompatMode }] : []),
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        { label: '开发者工具', role: 'toggleDevTools' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于理记',
          click: () => {
            const about = aboutBoxText();
            dialog.showMessageBox(mainWindow || undefined, {
              type: 'info',
              title: about.title,
              message: about.message,
              detail: about.detail,
              buttons: ['好']
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ============================== 冒烟自检 ============================== */
/* --smoke：不显示窗口，加载页面后断言关键元素，跑完退出。
 * 用来验证「打包后的 exe 真的能起来」，而不是只看构建日志。 */
function writeSmokeResult(result) {
  const out = process.env.LIJI_SMOKE_OUT;
  if (!out) return;
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(result, null, 2));
  } catch (e) { console.error('  冒烟结果写盘失败：' + e.message); }
}

async function runSmoke(base) {
  const checks = [];
  const check = (name, ok, extra) => {
    checks.push({ name, ok: !!ok, extra: extra || '' });
    console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (extra ? '  ' + extra : ''));
  };

  const finish = () => {
    const failed = checks.filter(c => !c.ok);
    const result = {
      ok: failed.length === 0,
      passed: checks.length - failed.length,
      total: checks.length,
      base,
      dataDir: process.env.LIJI_DATA_DIR,
      compatMode: COMPAT,
      portableDir: process.env.PORTABLE_EXECUTABLE_FILE ? process.env.PORTABLE_EXECUTABLE_DIR : null,
      checks
    };
    /* 便携版 exe 是自解压外壳，stdout 未必转发得出来；把结果落盘，
     * 打包脚本照样能判成败（不依赖控制台输出，也不依赖退出码）。 */
    writeSmokeResult(result);
    console.log('');
    console.log('  冒烟自检：' + result.passed + '/' + result.total + ' 通过');
    return result.ok;
  };

  try {
    await createMainWindow(base);
    check('窗口创建并加载页面成功', !!mainWindow && !mainWindow.isDestroyed());

    const info = await mainWindow.webContents.executeJavaScript(`(function () {
      var out = { title: document.title };
      out.hasApp = !!document.getElementById('app');
      out.childCount = out.hasApp ? document.getElementById('app').childElementCount : -1;
      out.text = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200);
      try {
        localStorage.setItem('__liji_smoke__', 'v1');
        out.ls = localStorage.getItem('__liji_smoke__');
        localStorage.removeItem('__liji_smoke__');
      } catch (e) { out.ls = 'ERR:' + e.message; }
      out.cssLoaded = getComputedStyle(document.body).backgroundColor;
      return out;
    })()`);

    /* ★ 标题这条断言必须**分模式**，否则它会撒谎。
     * 云端模式下窗口是 `loadURL(REMOTE_BASE)` —— 页面的 index.html 是**服务器发过来的**，
     * 标题属于那边部署的那份前端，跟包里 web/ 里的东西没关系（打包脚本默认就跑云端模式）。
     * 2026-09-22 实测踩到：包内标题早已改成「理记-网页端」，冒烟却报出「理记 · Windows 客户端」，
     * 一查才发现它读的是远程页面 —— 也就是说这条断言当时对「包里的前端对不对」毫无证明力。
     * 本地模式（`LIJI_REMOTE=''`）加载的才是包内 web/，那时就必须精确比。 */
    if (IS_CLOUD) {
      check('页面标题含「理记」（云端模式：标题来自远程页面，不是包内的）', /理记/.test(info.title), info.title);
    } else {
      check('包内前端标题正好是「理记-轻享版」', info.title === '理记-轻享版', info.title);
    }

    /* ★ 上面那条读的是 `document.title` —— **那只是页面标题，不是窗口标题**。
     * 而用户能看见的是**标题栏**。实测（2026-09-22）：窗口加载页面后，页面标题会覆盖建窗时传的
     * `title: '理记'`，于是桌面客户端的标题栏写着「理记-网页端」。修法是拦 `page-title-updated`。
     * 这条两个模式都要看，且不依赖远程页面 —— 窗口标题是我们自己钉死的。 */
    const winTitle = mainWindow ? mainWindow.getTitle() : '(没有窗口)';
    check('窗口标题栏是「理记 · 轻享版」（不被页面标题覆盖）', winTitle === '理记 · 轻享版', winTitle);
    check('客户端根节点存在', info.hasApp && info.childCount > 0, '子节点 ' + info.childCount + ' 个');
    check('样式表已生效', info.cssLoaded && info.cssLoaded !== 'rgba(0, 0, 0, 0)', info.cssLoaded);
    check('localStorage 可读写', info.ls === 'v1', String(info.ls));

    /* ★ 用户明确提过的两条「文案要求」，以前只有代码没有证据（见 aboutBoxText 的注释）。
     * 放在冒烟里是因为它俩是**纯文本**，而纯文本恰好是最容易在改动里被悄悄带回来的东西
     * —— 比如以后有人重写 buildMenu 时顺手贴回一段旧文案。 */
    check('应用名以「理记」开头（轻享版后缀是允许的）', /^理记/.test(app.getName()), app.getName());
    const about = aboutBoxText();
    const aboutAll = about.title + '\n' + about.message + '\n' + about.detail;
    /* 判据取「任何形式的主机地址」而不只是那一个旧 IP：换个服务器地址同样不该出现在这里。
     * 注意 IP 正则要有 4 段 —— `版本 1.0.0` 只有 3 段，不会被误伤。
     * 本机模式下 detail 里有数据目录路径，那是给用户备份用的，属于合理出现。 */
    check('关于框里没有服务器地址', !/https?:\/\/|\d{1,3}(\.\d{1,3}){3}/.test(aboutAll),
      about.detail.split('\n').filter(Boolean).join(' / '));
    check('关于框里没有「云端版」三个字', aboutAll.indexOf('云端版') < 0, about.message);

    /* ★ 轻享版的两条「反面」断言：没有服务端接口、没有后台页面。
     * 光验「能打开」不够 —— 万一哪天有人把 /api 接回来，冒烟照样全绿，
     * 于是「无服务器」这条承诺就没人守了。 */
    const health = await mainWindow.webContents.executeJavaScript(
      `fetch('/api/health',{cache:'no-store'}).then(r=>r.status).catch(e=>-1)`
    );
    check('没有服务端接口（/api/health 应为 404）', health === 404, 'HTTP ' + health);

    const admin = await mainWindow.webContents.executeJavaScript(
      `fetch('/admin',{cache:'no-store'}).then(r=>r.status).catch(e=>-1)`
    );
    check('没有后台管理页面（/admin 应为 404）', admin === 404, 'HTTP ' + admin);

    /* 对象存储客户端必须真的随包加载：它是轻享版同步的地基 */
    const oss = await mainWindow.webContents.executeJavaScript(
      `(function(){ var O = window.LiJiOSS; return { has: !!O, providers: O ? Object.keys(O.PROVIDERS) : [] }; })()`
    );
    check('对象存储客户端已加载（三种协议可用）', oss.has && oss.providers.length === 3, oss.providers.join('/'));

    const rendered = await mainWindow.webContents.executeJavaScript(`(function(){
      return { len: (document.body.innerText || '').length };
    })()`);
    check('首页渲染出内容', rendered.len > 0, '可见文本 ' + rendered.len + ' 字');

    /* ★ 云端版专项：把「桌面端登录远程账号 → 拉到云端文档」这条链路也验掉。
     * 只在 IS_CLOUD 且显式给了 LIJI_SMOKE_ACCOUNT 时才跑 —— 日常打包不带这个变量，
     * 免得凭空在服务器上注册账号。用法见 README-云端部署.md。 */
    const smokeAcc = process.env.LIJI_SMOKE_ACCOUNT || '';
    if (IS_CLOUD && smokeAcc) {
      const smokePw = process.env.LIJI_SMOKE_PASSWORD || '';
      const smokeDoc = process.env.LIJI_SMOKE_DOC || '';
      const login = await mainWindow.webContents.executeJavaScript(`(async function () {
        try {
          var L = window.__liji;
          var app = document.getElementById('app');
          /* 回到登录页，然后走**真实的登录表单提交**（不是直接塞 token），
           * 这样 submitAuth -> onAuthSuccess -> pullCloudDocuments 整条链路都被覆盖。 */
          L.S.signedIn = false; L.S.user = null; L.S.authMode = '登录'; L.render();
          var a = app.querySelector('.login-form input[data-f="account"]');
          var p = app.querySelector('.login-form input[data-f="password"]');
          if (!a || !p) return { err: '登录表单没渲染出来' };
          a.value = ${JSON.stringify(smokeAcc)};
          p.value = ${JSON.stringify(smokePw)};
          L.submitAuth();
          for (var i = 0; i < 40; i++) {
            await new Promise(function (r) { setTimeout(r, 250); });
            if (L.S.user) break;
          }
          await new Promise(function (r) { setTimeout(r, 2000); });
          return {
            account: L.S.user ? L.S.user.account : '',
            online: !!L.S.online,
            titles: (L.S.documents || []).map(function (d) { return d.title; }),
            cloudMsg: L.S.cloudMsg || ''
          };
        } catch (e) { return { err: String((e && e.message) || e) }; }
      })()`);
      check('桌面端能登录远程账号', login.account === smokeAcc,
        login.err ? ('err=' + login.err)
          : ('account=' + login.account + ' online=' + login.online + ' ' + (login.cloudMsg || '')));
      check('桌面端能拉到云端文档', !!smokeDoc && (login.titles || []).indexOf(smokeDoc) >= 0,
        '云端文档=' + JSON.stringify(login.titles || []));
    }

    /* 空转一段时间再收尾：有些环境是「加载完几秒后才崩」（渲染/合成相关），
     * 跑完断言就立刻退出会漏掉这类问题。LIJI_SMOKE_DWELL_MS 可调，默认 4 秒。 */
    const dwell = parseInt(process.env.LIJI_SMOKE_DWELL_MS || '4000', 10);
    if (dwell > 0) {
      let alive = true;
      const mark = () => { alive = false; };
      mainWindow.webContents.once('render-process-gone', mark);
      mainWindow.once('closed', mark);
      await new Promise((r) => setTimeout(r, dwell));
      mainWindow.webContents.removeListener('render-process-gone', mark);
      check('空转 ' + dwell + 'ms 窗口存活未崩', alive, alive ? '' : '期间渲染进程异常退出');
    }

    return finish();
  } catch (e) {
    console.error('  [FAIL] 冒烟自检异常：' + (e && e.message));
    check('冒烟过程无异常', false, (e && e.message) || '');
    return finish();
  }
}

/* ============================== 启动 ============================== */
/* 兼容模式重启过来的实例：先等旧实例把单实例锁和端口放掉（顺序很重要，必须在抢锁之前） */
{
  const waitArg = process.argv.find((a) => a.startsWith('--wait='));
  if (waitArg) {
    const ms = parseInt(waitArg.split('=')[1], 10) || 0;
    console.log('  [启动] 兼容模式重启：等待旧实例退出 ' + ms + 'ms');
    sleepSync(ms);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const dataDir = resolveDataDir();
    process.env.LIJI_DATA_DIR = dataDir;
    console.log('  [启动] 兼容模式=' + COMPAT + '  数据目录=' + dataDir
      + '  argv=' + process.argv.slice(1).join(' '));

    /* 上次是异常收场（没加载完也没正常退出）→ 把兼容标记固化下来。
     * 这一条是最后的兜底，不能省：本机实测存在「Chromium 在 JS 起来之前就静默退出」
     * 的失败方式，那时 child-process-gone / render-process-gone 都还没挂上，
     * 什么都写不下来；只有靠下次启动读指纹才能救回来。
     * 若不固化，就会变成「一次能跑、一次静默死」的交替，用户双击一半概率没反应。
     * 误判面很小：只有「页面没加载完就被杀掉」才会命中；而且菜单里有「恢复默认显示模式」可撤销。 */
    if (lastLaunchCrashed && !compatFlagExists) {
      writeCompatFlag('上次启动异常收场（页面未加载完成）');
      compatFlagExists = true;
    }

    let base;
    if (IS_CLOUD) {
      /* 云端版：不启内嵌服务端，直接连远程后端。
       * 远程挂了也没关系 —— 页面自己会显示「未检测到服务端」并给出离线体验入口。 */
      base = REMOTE_BASE;
      console.log('  [启动] 云端模式，后端 = ' + base);
    } else try {
      const r = await bootServer(dataDir);
      base = r.base;
      console.log('  服务已就绪 ' + base + (r.reused ? '（复用了已运行的理记服务）' : ''));
    } catch (e) {
      const message = (e && e.message) || '未知错误';
      writeSmokeResult({
        ok: false, passed: 0, total: 1, base: null,
        dataDir: process.env.LIJI_DATA_DIR,
        checks: [{ name: '本地服务启动', ok: false, extra: message }]
      });
      if (!IS_SMOKE) {
        dialog.showErrorBox('理记启动失败', '本地服务没能启动：\n\n' + message
          + '\n\n如果提示端口被占用，请先关掉占用 5173 的程序（或关掉另一个理记窗口）再试。');
      } else {
        console.error('  [FAIL] 服务启动失败：' + message);
      }
      cleanupSmoke();
      if (IS_SMOKE) { app.exit(1); return; }
      app.quit();
      return;
    }

    buildMenu();

    if (IS_SMOKE) {
      const ok = await runSmoke(base);
      cleanupSmoke();
      app.exit(ok ? 0 : 1);
      return;
    }

    await createMainWindow(base);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow(base);
    });
  });

  app.on('window-all-closed', () => {
    stopServer();
    writeLaunchState({ exitedAt: Date.now() });     // 正常关窗 = 正常收场
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    stopServer();
    writeLaunchState({ exitedAt: Date.now() });
  });
}

function cleanupSmoke() {
  if (!smokeTempDir) return;
  try { fs.rmSync(smokeTempDir, { recursive: true, force: true }); } catch (e) { }
}
