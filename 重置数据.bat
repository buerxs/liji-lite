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
