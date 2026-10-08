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
