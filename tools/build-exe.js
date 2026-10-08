/*
 * 理记 · 打包 Windows exe
 * ============================================================================
 * 做的事（按顺序）：
 *   1) 生成图标        tools/make-icon.js   -> electron/build/icon.png
 *   2) 暂存运行文件    electron/web/        <- 从项目根目录挑出真正要发布的那几个文件
 *   3) 调 electron-builder 出 exe           -> dist/理记-轻享版-<版本>.exe
 *                      （2026-09-22 起产物名去掉了「云端版」后缀，见第 3 步的名字检查）
 *   4) 冒烟自检        用 electron 跑 --smoke（起服务 + 加载页面 + 断言），
 *                      顺便直接运行刚打出来的 exe 验一遍，确认「打出来的东西真能跑」
 *                      ★ 每种各跑**云端 + 本地**两遍：云端模式的窗口加载的是远程页面，
 *                        对包里那份前端毫无证明力（见第 5 步的注释）。
 *
 * 为什么要有第 2 步的「暂存」：
 *   electron-builder 只接受「应用目录内部」的文件通配（../ 这种越界路径不可靠），
 *   而项目根目录是网页版和桌面版的公共源码，里面还有 test-*.js、演示截图等不该进包的东西。
 *   所以把要发布的那几个文件复制一份到 electron/web/，再按 electron/ 打包。
 *   electron/web 是纯构建产物，可以随时删，永远不要直接改它。
 *
 * 用法：
 *   node tools/build-exe.js              完整流程（图标 + 暂存 + 打包 + 冒烟）
 *   node tools/build-exe.js --no-smoke   只打包，不跑冒烟
 *   node tools/build-exe.js --no-icon    跳过图标生成（图标没改时省时间）
 *   node tools/build-exe.js --stage-only 只做暂存，不打包
 *   PORTABLE=0 或 --nsis                 额外/改为出安装包（NSIS）
 *
 * 镜像：按 .npmrc 的 electron_mirror / electron_builder_binaries_mirror 走，
 *       国内直连 GitHub 拉 Electron 与 NSIS 二进制会失败。
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const electronEnv = require('./electron-env');

const gbk = require('./gbk');
if (gbk.patchWindowsStdout) gbk.patchWindowsStdout();

const ROOT = electronEnv.ROOT;
const APP_DIR = path.join(ROOT, 'electron');
const STAGE = path.join(APP_DIR, 'web');
const DIST = path.join(ROOT, 'dist');

/* ====================== 要发布进 exe 的文件清单 ======================
 * 只列运行真正需要的：客户端三件套 + 后台三件套 + 服务端 + GBK 工具。
 * test-*.js、演示图片、README 之类一律不进包。 */
const FILES = [
  'index.html', 'styles.css', 'app.js', 'oss.js',   // oss.js：对象存储客户端，app.js 启动就要用
  'icon.svg',                               // 网页端 / 桌面端共用的 favicon（缺了会 404）
  'server.js'                               // 内嵌静态服务（轻享版只有静态，没有 /api）
];
const SUB_FILES = [
  ['tools/gbk.js', 'tools/gbk.js']          // server.js 依赖它做控制台编码适配
];

const argv = process.argv.slice(2);
const NO_SMOKE = argv.includes('--no-smoke');
const NO_ICON = argv.includes('--no-icon');
const STAGE_ONLY = argv.includes('--stage-only');

let failed = 0;
function check(name, ok, extra) {
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (extra ? '  ' + extra : ''));
  if (!ok) failed++;
}
function step(title) {
  console.log('');
  console.log('  ' + title);
  console.log('  ' + '─'.repeat(60));
}
function fmtSize(bytes) {
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}
/* 子进程输出要按 UTF-8 收：本脚本自己的 stdout 已被转成 GBK（给 cmd 看），
 * 若子进程也吐 GBK 字节，我们按 UTF-8 解码就成乱码，再编码一次会更乱。
 * 所以统一让子 Node 进程走 UTF-8（LIJI_UTF8=1），拿到字符串后由本进程转 GBK。 */
function childEnv(extra) {
  return electronEnv.cleanEnv(Object.assign({ LIJI_UTF8: '1' }, extra || {}));
}

console.log('');
console.log('  理记 · 打包 Windows 客户端');
console.log('  ============================================================');
console.log('  项目目录    ' + ROOT);
console.log('  应用目录    ' + APP_DIR);
console.log('  产物目录    ' + DIST);

/* ============================== 1. 图标 ============================== */
step('[1/5] 生成应用图标');
const ICON = path.join(APP_DIR, 'build', 'icon.png');
if (NO_ICON && fs.existsSync(ICON)) {
  console.log('  跳过（--no-icon，沿用已有图标）');
} else {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'make-icon.js')], {
    cwd: ROOT, encoding: 'utf8', env: childEnv()
  });
  process.stdout.write(r.stdout || '');
  if (r.status !== 0) {
    process.stdout.write(r.stderr || '');
    /* 图标没重生成不该让整个打包失败：徽标没改的时候旧图标一样能用。
     * 但完全没有图标就必须停 —— 否则打出来的 exe 会是 Electron 默认图标。 */
    if (fs.existsSync(ICON)) {
      console.log('  [注意] 图标重新生成失败，沿用已有图标继续打包。');
    } else {
      console.log('  图标生成失败且没有可用图标，终止打包。');
      process.exit(1);
    }
  }
}
check('图标文件就绪', fs.existsSync(ICON), fs.existsSync(ICON) ? fmtSize(fs.statSync(ICON).size) : '缺失');
if (!fs.existsSync(ICON)) process.exit(1);

/* ============================== 2. 暂存源码 ============================== */
step('[2/5] 暂存运行文件 → electron/web');
/* 不整目录删：一是没必要（下面按清单覆盖），二是宿主/杀软常对批量删除设阈值，
 * 整删一个目录会被拦。做法改为「覆盖清单内文件 + 删掉清单外的残留」，
 * 既保证不会有上次构建的旧文件混进包里，正常情况一次删除都不会发生。 */
const EXPECTED = new Set(FILES.concat(SUB_FILES.map((s) => s[1])));
function prune(dir, removed) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(STAGE, full).split(path.sep).join('/');
    if (fs.statSync(full).isDirectory()) {
      prune(full, removed);
      if (!EXPECTED.has(rel) && fs.readdirSync(full).length === 0) { fs.rmdirSync(full); removed.n++; }
    } else if (!EXPECTED.has(rel)) {
      fs.unlinkSync(full);
      removed.n++;
      console.log('  清掉残留 ' + rel);
    }
  }
}
fs.mkdirSync(STAGE, { recursive: true });
const removed = { n: 0 };
prune(STAGE, removed);

let copied = 0;
for (const rel of FILES) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) { check('存在 ' + rel, false); continue; }
  fs.copyFileSync(src, path.join(STAGE, rel));
  check(rel, true, fmtSize(fs.statSync(src).size));
  copied++;
}
for (const [from, to] of SUB_FILES) {
  const src = path.join(ROOT, from);
  const dst = path.join(STAGE, to);
  if (!fs.existsSync(src)) { check('存在 ' + from, false); continue; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  check(to, true, fmtSize(fs.statSync(src).size));
  copied++;
}
check('主进程 main.js', fs.existsSync(path.join(APP_DIR, 'main.js')));
check('共暂存 ' + copied + ' 个源码文件', copied === FILES.length + SUB_FILES.length);
check('暂存目录无残留旧文件', removed.n === 0, removed.n ? '清掉 ' + removed.n + ' 个' : '');

/* 发布包里绝不能出现的东西，顺手挡一道 */
const forbidden = fs.readdirSync(STAGE).filter((n) => /^test-|^_|\.bak/i.test(n));
check('暂存目录无测试/临时文件', forbidden.length === 0, forbidden.join(', '));

if (STAGE_ONLY) {
  console.log('');
  console.log('  --stage-only：只做暂存，未打包。');
  process.exit(failed === 0 ? 0 : 1);
}

/* ============================== 3. 打包 ============================== */
step('[3/5] electron-builder 打包');
/* 先预置 winCodeSign 缓存：不然 7-Zip 会卡在「不能创建符号链接」上（详见
 * tools/prepare-build-cache.js 里的说明），而开开发者模式/管理员权限都要求改系统设置。 */
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'prepare-build-cache.js')], {
    cwd: ROOT, encoding: 'utf8', env: childEnv()
  });
  process.stdout.write(r.stdout || '');
  if (r.status !== 0) {
    process.stdout.write(r.stderr || '');
    console.log('  缓存预置失败，终止打包。');
    process.exit(1);
  }
}

/* 用 node 直接跑 CLI 入口，不走 node_modules/.bin/*.cmd：
 * Node 从安全修复版起就不允许不带 shell 直接 spawn .cmd/.bat（会 EINVAL / 状态 null），
 * 而开 shell 又要处理引号转义，直接跑 js 最省事。 */
/* 打包前的产物时间戳：第 4 步靠它判断「exe 确实是本次新生成的」 */
/* ★ 产物名跟着 package.json 走，不在这里写死：写死版本就会有人只改一处，
 *   打出来的 exe 名和这里校验的名字对不上（见 package.json 的 portable.artifactName）。 */
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
const EXE_NAME = pkg.build.portable.artifactName.replace('${version}', pkg.version);
const PORTABLE_EXE = path.join(DIST, EXE_NAME);
const exeBeforeAt = fs.existsSync(PORTABLE_EXE) ? fs.statSync(PORTABLE_EXE).mtimeMs : 0;
const builderCli = path.join(APP_DIR, 'node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(builderCli)) {
  console.log('  找不到 electron-builder。请先执行： cd electron && npm install');
  process.exit(1);
}

const wantNsis = argv.includes('--nsis');
const builderArgs = ['--win'];
if (wantNsis) builderArgs.push('nsis');

/* 想让国内镜像生效：electron-builder 认这两个环境变量（也认 .npmrc 里的下划线小写形式） */
const buildEnv = childEnv({
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://registry.npmmirror.com/-/binary/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/',
  npm_config_electron_mirror: 'https://registry.npmmirror.com/-/binary/electron/',
  npm_config_electron_builder_binaries_mirror: 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'
});

/* ⚠ 这个调用在受限环境里可能安静地跑 20 分钟以上（复制 ~200MB Electron 运行时 + 打 asar +
 * NSIS 压缩出 68MB 的便携包）。期间日志一行不动、app-builder.exe 的 CPU 时间很低，**都是正常的**。
 * 千万不要因为「看起来卡住了」去结束 app-builder.exe —— 那会让 electron-builder exit=1，
 * 而下一步仍会看到上一轮留下的旧 exe 并「核对通过」，得出完全错误的结论。（2026-09-19 真踩过） */
const b = spawnSync(process.execPath, [builderCli].concat(builderArgs), {
  cwd: APP_DIR,
  stdio: 'inherit',
  env: buildEnv
});
check('electron-builder 正常退出', b.status === 0, 'exit=' + b.status);

/* ============================== 4. 产物核对 ============================== */
step('[4/5] 核对产物');
if (!fs.existsSync(DIST)) {
  console.log('  产物目录不存在：' + DIST);
  process.exit(1);
}
const artifacts = fs.readdirSync(DIST)
  .filter((n) => n.toLowerCase().endsWith('.exe'))
  .map((n) => ({ name: n, size: fs.statSync(path.join(DIST, n)).size }))
  .sort((a, b2) => b2.size - a.size);

artifacts.forEach((a) => console.log('  ' + a.name + '    ' + fmtSize(a.size)));
check('至少产出一个 exe', artifacts.length > 0);
/* 「存在且够大」不足以证明产物是本次生成的：打包失败时上一轮的 exe 还在原地。
 * 所以拿打包前记下的时间戳比一比（见第 3 步开头）。 */
if (fs.existsSync(PORTABLE_EXE)) {
  const now = fs.statSync(PORTABLE_EXE);
  check('产物是本次新生成的（时间戳已前进）', now.mtimeMs > exeBeforeAt,
    (exeBeforeAt ? new Date(exeBeforeAt).toLocaleTimeString() : '此前不存在') + ' → ' + now.mtime.toLocaleTimeString());
}
check('目标产物 ' + path.basename(PORTABLE_EXE) + ' 存在', fs.existsSync(PORTABLE_EXE));

/* 需求 #2「客户端名称里去掉『云端版』」在**文件层面**的守卫：
 * 名字一改回去、或者 dist 里留了个旧的 `…-云端版.exe`，用户看到的就是旧名字。
 * 实测 2026-09-22 那次改名之后，dist 里那个旧包是唯一还带着这三个字的地方。 */
check('目标产物名里没有「云端版」（桌面端名称已去掉这三个字）',
  !/云端版/.test(path.basename(PORTABLE_EXE)), path.basename(PORTABLE_EXE));

/* ⚠ 旧名字的 exe 必须手动清掉：第 5 步原来取的是「体积最大的那个 exe」，
 * 两个包体积接近时完全可能挑到上一轮的旧包 —— 于是冒烟全绿，测的却是旧代码。
 * 改成优先认死目标文件名，同时把旧包列出来提醒人。
 * 覆盖两类旧名：旧品牌「礼记-」与旧后缀「云端版」。 */
const stale = artifacts.filter((a) => /^礼记-|云端版/.test(a.name));
if (stale.length) {
  console.log('');
  console.log('  [提醒] dist 里还有旧名字的包（旧品牌「礼记」或旧后缀「云端版」），请自行确认后删除（不会被自动清理）：');
  stale.forEach((a) => console.log('         ' + a.name + '    ' + fmtSize(a.size)));
}

const biggest = artifacts[0];
check('exe 体积合理（含 Electron 运行时，>40MB）', !!biggest && biggest.size > 40 * 1024 * 1024,
  biggest ? fmtSize(biggest.size) : '');
const SMOKE_EXE = fs.existsSync(PORTABLE_EXE) ? PORTABLE_EXE : (biggest ? path.join(DIST, biggest.name) : null);

/* ★ 产物取证（2026-09-22 加）：证明「跑过自检的那份源码」就是「打进 exe 的那一份」。
 * 为什么不能只 grep 符号：命中只能说明「包里提到了这个名字」，
 * 说明不了「跑的就是这一份」—— 暂存目录残留旧文件、asar 缓存没刷、改了源码忘重打，
 * 这三种情况都会让符号照样命中，而跑的是旧代码。
 * 逐字节比 sha1 才是硬证据。抽成独立工具是为了排查时能单独跑，不用整条重打一遍。 */
const v = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'verify-asar.js')], {
  cwd: ROOT, encoding: 'utf8', env: childEnv()
});
process.stdout.write(v.stdout || '');
if (v.status !== 0) process.stdout.write(v.stderr || '');
check('包内文件与本地源码逐字节一致（tools/verify-asar.js）', v.status === 0, 'exit=' + v.status);

/* ============================== 5. 冒烟自检 ============================== */
step('[5/5] 冒烟自检');
if (NO_SMOKE) {
  console.log('  跳过（--no-smoke）');
} else {
  fs.mkdirSync(DIST, { recursive: true });
  const electron = electronEnv.electronPath();

  /* 跑一次冒烟，断言以结果文件为准（便携版 exe 的 stdout / 退出码都可能不转发）。
   * 不删旧结果文件，而是记下开始时间、只认「本次跑出来的」那一份：
   * 一是免得误删（宿主/杀软对批量删除有阈值保护），二是空壳 exe 这类情况能留下证据。 */
  const runSmoke = (label, cmd, args, cwd, resultFile, extraSmokeEnv) => {
    const startedAt = Date.now();
    console.log('  ▸ ' + label);
    /* ★ 冒烟必须用**自己的 userData 目录**。
     * Electron 的单实例锁是按 userData 加的，而开发态与便携版共用同一个应用名。
     * 用户此刻如果正开着「理记」（很常见），冒烟进程会被判成「第二个实例」，
     * 在 app.requestSingleInstanceLock() 处直接 app.quit() —— 表现为
     * 「没有任何输出、没有结果文件、退出码 0」，看起来像冒烟挂了，其实是它压根没跑。
     * 2026-09-22 实测踩到：用户开着理记时两条冒烟全报「没拿到本次结果」。
     * 给一个临时 userData 就绕开了，顺带也让冒烟永远不会碰到用户自己的标记文件。 */
    const profile = path.join(os.tmpdir(), 'liji-smoke-profile-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7));
    const r = spawnSync(cmd, args.concat(['--user-data-dir=' + profile]), {
      cwd,
      encoding: 'utf8',
      timeout: 240000,
      /* LIJI_TEST_NO_SANDBOX 只在这里注入：本工具链跑在受限环境里，Chromium 的
       * 沙箱子进程会被杀。正式运行不带这两个开关，所以自检跑的仍是真实路径。 */
      env: childEnv(Object.assign({ LIJI_SMOKE_OUT: resultFile, LIJI_TEST_NO_SANDBOX: '1' }, extraSmokeEnv || {}))
    });
    const lines = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/)
      .filter((l) => /PASS|FAIL|冒烟自检|服务已就绪|启动失败/.test(l));
    lines.forEach((l) => console.log('    ' + l));
    /* 临时 profile 用完就清（删不掉也不影响结果，不用管） */
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }

    let result = null;
    if (fs.existsSync(resultFile) && fs.statSync(resultFile).mtimeMs >= startedAt - 2000) {
      try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { }
    }
    if (!result) {
      check(label + ' 产出冒烟结果', false, '没拿到本次结果（exit=' + r.status + '）');
      return;
    }
    result.checks.filter((c) => !c.ok).forEach((c) => console.log('    [FAIL] ' + c.name + '  ' + c.extra));
    check(label + ' 冒烟 ' + result.passed + '/' + result.total, result.ok);
  };

  /* ★ 为什么同一个东西要跑两遍（云端 + 本地）—— 这不是凑数，是补一个真实存在的盲区。
   * 本副本是「云端版」：`REMOTE_BASE` 非空，窗口走 `loadURL(REMOTE_BASE)`，
   * 页面里的 index.html / app.js / styles.css **全部是服务器发过来的**。
   * 于是「云端模式」那两条冒烟验的是「进程起得来、连得上后端、远程页面渲染正常」，
   * 对**包里那份前端**一个字都没验 —— 包内 app.js 全烂掉它照样 9/9。
   * 2026-09-22 就是因此踩到：包内标题已经改成「理记-网页端」，冒烟却报「理记 · Windows 客户端」
   * （读的是没重新部署的远程页面），差点被当成「标题改漏了」。
   * 解法：再跑一遍本地模式（`LIJI_REMOTE=''` → 退回内嵌服务端 → 加载包内 web/）,
   * 那才是包内前端真正被执行的一次；标题那条断言在本地模式下也改成了精确比对。 */

  /* 轻享版只有本地模式：它根本不加载远程页面，
   * 所以原副本那套「云端 + 本地跑两遍」（防的是「包内前端烂了、冒烟却读远程页面」）没有盲区可补。 */
  runSmoke('源码态 · 本地模式（验包内前端）', electron, [APP_DIR, '--smoke'], APP_DIR,
    path.join(DIST, 'smoke-result-src.json'), { LIJI_REMOTE: '' });

  /* 直接跑打出来的 exe —— 这才是「用户双击的那个东西」 */
  if (SMOKE_EXE) {
    runSmoke('成品 exe（' + path.basename(SMOKE_EXE) + ' --smoke）', SMOKE_EXE, ['--smoke'], DIST,
      path.join(DIST, 'smoke-result-exe.json'), { LIJI_REMOTE: '' });
  }
}

/* ============================== 收尾 ============================== */
console.log('');
console.log('  ============================================================');
if (failed === 0) {
  console.log('  打包完成；产物在 ' + DIST);
  artifacts.forEach((a) => console.log('    ' + path.join(DIST, a.name)));
  console.log('');
  /* 云端版与本机版的收尾提示不一样，别把用户往错的方向引。
   * 从 main.js 源码里把 REMOTE_BASE 抠出来打印（不要去 require 它 —— 那会连带加载 electron）。 */
  let remoteBase = '';
  try {
    const src = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
    const m = src.match(/LIJI_REMOTE[\s\S]{0,120}?'(https?:\/\/[^']*)'/);
    remoteBase = m ? m[1] : '';
  } catch (e) { }
  console.log('  双击即可运行，不需要装 Node，也不需要另开「启动.bat」。');
  if (remoteBase) {
    console.log('  ★ 已指向远程地址 ' + remoteBase + '（轻享版默认不走远程，检查 LIJI_REMOTE 是否被设过）');
  } else {
    console.log('  ★ 轻享版：没有账号、没有后台、不连服务器。');
    console.log('  文档存在本机浏览器存储里；多设备同步在「同步与存储」里填对象存储。');
  }
} else {
  console.log('  打包流程有 ' + failed + ' 项失败，请看上面的 [FAIL]。');
}
console.log('  ============================================================');
console.log('');
process.exit(failed === 0 ? 0 : 1);
