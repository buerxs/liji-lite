/*
 * 理记 Windows 客户端 —— .bat 生成器（必须用它来生成/修改 .bat）
 * ============================================================================
 * 为什么需要它：
 *   .bat 由 cmd.exe 按「当前代码页」逐字节解析。本机（中文 Windows）代码页是 936(GBK)，
 *   若把含中文的 .bat 存成 UTF-8：
 *     1) cmd 读到多字节字符时会错位，把 node.exe" 读成 de.exe"、https:// 读成 tp:，
 *        报「不是内部或外部命令」；
 *     2) 在批处理中途 chcp 切代码页，会让 cmd 的文件读取偏移算错，症状一样。
 *   另外 .bat 必须用 CRLF 换行（LF 会让 if(...) 之类多行结构解析错位）。
 *   所以：UTF-8 源 → GBK + CRLF 落盘，是唯一稳定做法。
 *
 * 用法：
 *   node tools/make-bat.js          只生成并回读校验
 *   node tools/make-bat.js --dry    额外做一次「干跑」解析自检（把开窗口/等待换成 echo）
 *
 * 改 .bat 的正确姿势：改本文件里的 SRC，再跑一次，不要直接用编辑器改 .bat。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/* ============================ .bat 内容（UTF-8 源） ============================ */
const SRC = {};

SRC['启动.bat'] = String.raw`
@echo off
chcp 936 >nul
cd /d "%~dp0"

REM ===== 定位 Node：优先 PATH，其次本机已安装的固定路径 =====
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=C:\Users\lenovo\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"
if not exist "%NODE%" if /i not "%NODE%"=="node" set "NODE=node"

"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js，无法启动本地服务。
  echo   请先安装 Node.js（https://nodejs.org），或直接双击 index.html 使用离线模式。
  echo.
  pause
  exit /b 1
)

REM ===== 启动本地静态服务：只发文件，不存数据、没有账号接口 =====
start "理记服务端" cmd /k ""%NODE%" "%~dp0server.js""

REM ===== 等服务就绪再打开浏览器（最多等 12 秒）；没就绪就不开，并给出排查方向 =====
"%NODE%" "%~dp0tools\healthcheck.js" --wait 12000
if errorlevel 1 (
  echo   服务端没有就绪，已停止打开浏览器。
  echo   请查看标题为「理记服务端」的窗口里打印的报错。
  echo.
  pause
  exit /b 1
)

REM 打开客户端（加 --no-open 可只起服务、不开浏览器）
REM 用 127.0.0.1 而不是 localhost：个别环境下 localhost 会先解析到 IPv6 的 ::1 而连不上
if /i not "%~1"=="--no-open" start "" "http://127.0.0.1:5173"

echo.
echo   理记 · 轻享版 已启动
echo   -----------------------------------------
echo   客户端       http://127.0.0.1:5173
echo.
echo   文档存在本机浏览器里；想多设备同步，到「同步与存储」里填一次对象存储。
echo   浏览器打不开：双击「诊断.bat」查原因
echo   停止服务：关掉标题为「理记服务端」的那个窗口，或在该窗口按 Ctrl+C
echo.
pause
`;

SRC['手机访问.bat'] = String.raw`
@echo off
chcp 936 >nul
cd /d "%~dp0"

REM ===== 定位 Node：优先 PATH，其次本机已安装的固定路径 =====
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=C:\Users\lenovo\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"
if not exist "%NODE%" if /i not "%NODE%"=="node" set "NODE=node"

"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js，无法启动本地服务。
  echo   请先安装 Node.js（https://nodejs.org）。
  echo.
  pause
  exit /b 1
)

REM ===== 局域网模式：绑 0.0.0.0，同一 Wi-Fi 里的手机 / 平板可以访问 =====
REM 只发静态文件，没有账号 / 数据库 / api 接口；文档存在各自设备的浏览器里。
set "HOST=0.0.0.0"
start "理记手机服务" cmd /k ""%NODE%" "%~dp0server.js""

"%NODE%" "%~dp0tools\healthcheck.js" --wait 12000
if errorlevel 1 (
  echo   服务端没有就绪，请看标题为「理记手机服务」的窗口里打印的报错。
  echo.
  pause
  exit /b 1
)

echo.
echo   理记 · 轻享版 · 手机访问模式 已启动
echo   -----------------------------------------
echo   电脑自己用    http://127.0.0.1:5173
echo   手机 / 平板   连同一个 Wi-Fi，用手机浏览器打开：
echo                 http://电脑IP:5173   （具体 IP 看「理记手机服务」窗口）
echo.
echo   ★ 首次启动若弹出 Windows 防火墙提示，务必勾选「专用网络」并点「允许访问」，
echo     否则手机连不上（关掉重来一次就会再弹）。
echo.
echo   注意：手机浏览器里的文档与电脑互不相通。想两边看到同一份文档，
echo   在两台设备的「同步与存储」里填同一个对象存储（腾讯 COS / 阿里云 OSS 等）。
echo   停止服务：关掉标题为「理记手机服务」的窗口，或在该窗口按 Ctrl+C
echo.
pause
`;

/* 部署网页.bat 已移除（2026-10-06）：网页版改用 Cloudflare Pages 托管
 * （https://liji-web.pages.dev，控制台拖拽「网页部署包」文件夹），
 * 腾讯 COS 静态网站对新桶默认域名强制下载 + 3 小时预览限制，通道废弃。 */

SRC['自检.bat'] = String.raw`
@echo off
chcp 936 >nul
cd /d "%~dp0"

REM ===== 定位 Node：优先 PATH，其次本机已安装的固定路径 =====
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=C:\Users\lenovo\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"
if not exist "%NODE%" if /i not "%NODE%"=="node" set "NODE=node"

"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js，无法运行自检。
  echo   请先安装 Node.js（https://nodejs.org）后重试。
  echo.
  pause
  exit /b 1
)

echo.
echo   理记 · 轻享版 自检
echo   全程只读：不改本机文档，只在临时目录里读写探针对象
echo   =========================================
echo.
echo   [1/3] 对象存储签名（离线）           tools\test-oss.js
echo   -----------------------------------------
"%NODE%" tools\test-oss.js
set "R1=%errorlevel%"
echo.
echo   [2/3] 对象存储端到端（本地模拟服务） tools\test-oss-e2e.js
echo   -----------------------------------------
"%NODE%" tools\test-oss-e2e.js
set "R2=%errorlevel%"
echo.
echo   [3/3] 真浏览器端到端                 tools\test-lite.js
echo         （需要 Edge 或 Chrome；没装会自动跳过）
echo   -----------------------------------------
"%NODE%" tools\test-lite.js
set "R3=%errorlevel%"
echo.
echo   =========================================
if "%R1%%R2%%R3%"=="000" (
  echo   结果：全部自检通过
) else (
  echo   结果：存在失败项（签名 exit=%R1%，对象存储 exit=%R2%，浏览器 exit=%R3%）
  echo   请向上翻看标了 [x] 或 [FAIL] 的条目与最后打印的失败清单。
)
echo   =========================================
echo.
pause
`;

SRC['诊断.bat'] = String.raw`
@echo off
chcp 936 >nul
cd /d "%~dp0"

REM ===== 定位 Node：优先 PATH，其次本机已安装的固定路径 =====
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=C:\Users\lenovo\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"
if not exist "%NODE%" if /i not "%NODE%"=="node" set "NODE=node"

echo.
echo   理记 · 连接诊断
echo   =========================================
echo.
echo   [1/3] Node 版本
"%NODE%" -v 2>nul
if errorlevel 1 echo         未找到 Node.js —— 请先安装 Node.js（https://nodejs.org）
echo.
echo   [2/3] 5173 端口监听情况
netstat -ano | findstr /C:":5173" | findstr /C:"LISTENING"
if errorlevel 1 echo         没有程序在监听 5173 —— 服务没有启动
echo.
echo   [3/3] 首页可达性
"%NODE%" "%~dp0tools\healthcheck.js"
echo.
echo   =========================================
echo   本诊断由 Node 直连，不经过浏览器。
echo   若上面显示「可达」但浏览器仍打不开，问题在浏览器侧：
echo     1) 浏览器 / 系统代理或 VPN 拦了本机地址，把 localhost 与 127.0.0.1 加入例外
echo     2) 广告拦截、隐私类插件拦了本机请求，可开无痕窗口试试
echo     3) 访问 http://127.0.0.1:5173 而不是 localhost
echo   =========================================
echo.
pause
`;

SRC['打包.bat'] = String.raw`
@echo off
chcp 936 >nul
cd /d "%~dp0"

REM ===== 定位 Node：优先 PATH，其次本机已安装的固定路径 =====
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=C:\Users\lenovo\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"
if not exist "%NODE%" if /i not "%NODE%"=="node" set "NODE=node"

"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js，无法打包。
  echo   请先安装 Node.js（https://nodejs.org）后重试。
  echo.
  pause
  exit /b 1
)

REM ===== 打包依赖（electron / electron-builder）只在第一次需要装 =====
if not exist "electron\node_modules\electron\dist\electron.exe" (
  echo.
  echo   [1/2] 首次打包，正在安装打包依赖（走国内镜像，约 1-3 分钟）...
  echo   -----------------------------------------
  pushd electron
  call npm install --no-audit --no-fund
  popd
  if not exist "electron\node_modules\electron\dist\electron.exe" (
    echo.
    echo   [错误] 依赖安装失败，请检查网络后重试。
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   [2/2] 开始打包（图标 - 暂存 - 出 exe - 冒烟自检）
echo   =========================================
"%NODE%" tools\build-exe.js %*
set "R=%errorlevel%"

echo.
if "%R%"=="0" (
  echo   打包完成，产物在 dist 目录。
  start "" "%~dp0dist"
) else (
  echo   打包失败（exit=%R%），请看上面的 [FAIL] 条目。
)
echo   可选参数： --no-icon 跳过图标  --no-smoke 跳过冒烟  --nsis 额外出安装包
echo.
pause
exit /b %R%
`;

SRC['重置数据.bat'] = String.raw`
@echo off
chcp 936 >nul
cd /d "%~dp0"

REM ===== 定位 Node：优先 PATH，其次本机已安装的固定路径 =====
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=C:\Users\lenovo\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"
if not exist "%NODE%" if /i not "%NODE%"=="node" set "NODE=node"

"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js，无法运行本工具。
  echo.
  pause
  exit /b 1
)

echo.
echo   理记 · 轻享版 · 清理本机文档
echo   =========================================
echo   轻享版没有服务端，文档存在**浏览器自己的存储**里（localStorage），
echo   不在这个目录，所以批处理脚本没法替你删 —— 请在浏览器里清：
echo.
echo     1) 打开 http://127.0.0.1:5173 ，按 F12 打开开发者工具
echo     2) Application（应用） → Local Storage → 选中本站
echo     3) 删掉 liji_store:* 开头的键（文档）、liji_oss_config（对象存储配置）
echo.
echo   桌面端（exe）：删掉 %APPDATA%\理记\ 下的用户数据目录即可，
echo   那会连窗口布局一起清掉，请先确认不再需要。
echo.
pause
exit /b 0
echo.
pause
`;

/* ============================ GBK 编码器（见 tools/gbk.js） ============================ */
const gbk = require('./gbk');
const encodeGbk = gbk.encode;
const decodeGbk = gbk.decode;
const toCrlf = gbk.toCrlf;

/* ================================= 生成 + 校验 ================================= */
let failed = 0;
const check = (name, good, extra) => {
  console.log('  [' + (good ? 'PASS' : 'FAIL') + '] ' + name + (extra ? '  ' + extra : ''));
  if (!good) failed++;
};

const generated = {};
console.log('生成 .bat（目标编码 GBK / 换行 CRLF）');
for (const name of Object.keys(SRC)) {
  const text = toCrlf(SRC[name]);
  generated[name] = text;
  const { buf, unmappable } = encodeGbk(text);
  const dst = path.join(ROOT, name);
  const before = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
  const changed = !before || !before.equals(buf);
  fs.writeFileSync(dst, buf);

  const bytes = fs.readFileSync(dst);
  let loneLf = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0A && (i === 0 || bytes[i - 1] !== 0x0D)) loneLf++;
  const bom = bytes.length > 2 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;

  console.log('');
  console.log('  ' + name + '  ' + (before ? before.length + ' → ' : '') + bytes.length + ' 字节' + (changed ? '  (已更新)' : '  (无变化)'));
  check(name + ' 回读与源一致（GBK 往返无损）', decodeGbk(bytes) === text);
  check(name + ' 无 BOM', !bom);
  check(name + ' 全部 CRLF', loneLf === 0, loneLf ? '裸 LF ' + loneLf + ' 处' : '');
  check(name + ' 无非 GBK 字符', unmappable.length === 0, unmappable.length ? JSON.stringify([...new Set(unmappable)]) : '');
}

/* ====================== 干跑：把开窗口/等待替换成 echo，验证解析 ====================== */
if (process.argv.includes('--dry')) {
  const dry = generated['启动.bat']
    .replace('start "理记服务端" cmd /k ""%NODE%" "%~dp0server.js""', 'echo [DRY] 将启动服务端窗口')
    .replace('if /i not "%~1"=="--no-open" start "" "http://127.0.0.1:5173"', 'echo [DRY] 将打开客户端页面')
    .replace('"%NODE%" "%~dp0tools\\healthcheck.js" --wait 12000', 'echo [DRY] 将等服务就绪')
    .replace(/\r\npause\r\n/g, '\r\necho DRY_DONE\r\n');
  const dryPath = path.join(ROOT, '_dry.bat');
  fs.writeFileSync(dryPath, encodeGbk(dry).buf);

  const r = spawnSync('cmd.exe', ['/c', '_dry.bat'], { cwd: ROOT, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = decodeGbk(Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)]));
  fs.unlinkSync(dryPath);

  console.log('');
  console.log('  干跑输出（启动.bat）：');
  out.trimEnd().split(/\r?\n/).forEach(l => console.log('    | ' + l));
  console.log('');
  check('干跑无「不是内部或外部命令」', !out.includes('不是内部或外部命令'));
  check('干跑无「系统找不到」', !out.includes('系统找不到'));
  check('干跑无「不是可运行」', !out.includes('不是可运行'));
  check('中文横幅原样输出', out.includes('理记 · 轻享版 已启动'));
  check('客户端地址行正确', out.includes('http://127.0.0.1:5173'));
  check('启动文案不含后台管理', !out.includes('/admin'));
  check('干跑执行到最后一行', out.includes('DRY_DONE'));

  /* 诊断.bat 也干跑一遍，验证解析（把真实命令换成 echo） */
  const dry2 = generated['诊断.bat']
    .replace('"%NODE%" -v 2>nul', 'echo [DRY] 将查询 Node 版本')
    .replace('netstat -ano | findstr /C:":5173" | findstr /C:"LISTENING"', 'echo [DRY] 将检查端口监听')
    .replace('"%NODE%" "%~dp0tools\\healthcheck.js"', 'echo [DRY] 将做连通性自检')
    .replace(/\r\npause\r\n/g, '\r\necho DRY_DONE2\r\n');
  const dryPath2 = path.join(ROOT, '_dry2.bat');
  fs.writeFileSync(dryPath2, encodeGbk(dry2).buf);
  const r2 = spawnSync('cmd.exe', ['/c', '_dry2.bat'], { cwd: ROOT, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  const out2 = decodeGbk(Buffer.concat([r2.stdout || Buffer.alloc(0), r2.stderr || Buffer.alloc(0)]));
  fs.unlinkSync(dryPath2);

  console.log('');
  console.log('  干跑输出（诊断.bat）：');
  out2.trimEnd().split(/\r?\n/).forEach(l => console.log('    | ' + l));
  console.log('');
  check('诊断.bat 干跑无报错', !out2.includes('不是内部或外部命令') && !out2.includes('系统找不到'));
  check('诊断.bat 中文标题正确', out2.includes('理记 · 连接诊断'));
  check('诊断.bat 执行到最后一行', out2.includes('DRY_DONE2'));
}

console.log('');
console.log(failed === 0 ? '>>> 全部通过' : '>>> 有 ' + failed + ' 项失败');
process.exit(failed === 0 ? 0 : 1);
