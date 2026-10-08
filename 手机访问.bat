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
