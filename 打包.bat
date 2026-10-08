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
