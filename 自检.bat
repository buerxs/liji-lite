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
