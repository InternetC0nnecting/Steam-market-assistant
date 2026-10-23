@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22.12 或更高版本，再运行本文件。
  pause
  exit /b 1
)
if not exist "node_modules\electron\package.json" (
  call npm ci --no-fund --no-audit
  if errorlevel 1 goto failed
)
node "node_modules\electron\install.js"
if errorlevel 1 goto failed
call npm start
if errorlevel 1 goto failed
exit /b 0
:failed
echo 启动未完成。请检查 Node.js 版本和网络连接，并查看上方提示。
pause
exit /b 1
