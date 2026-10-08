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
