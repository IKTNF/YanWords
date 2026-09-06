@echo off
title YanCi Helper - KaoYan English I Vocabulary Workbench
cd /d "%~dp0"
set "PORT=8765"

where node >nul 2>nul
if not errorlevel 1 goto runNode
where python >nul 2>nul
if not errorlevel 1 goto runPython

echo.
echo  [ERROR] Node.js or Python not found.
echo  Please install Node.js: https://nodejs.org/zh-cn
echo  or Python 3: https://www.python.org/downloads/
echo  Then double-click this file again.
echo.
timeout /t 10 /nobreak >nul
exit /b 1

:runNode
set "CMD=node server.js"
goto start

:runPython
set "CMD=python server.py"

:start
echo Starting local server: http://127.0.0.1:%PORT%/  (browser will open automatically)
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:%PORT%/"
%CMD%
echo.
echo Server stopped. Closing in 5 seconds...
timeout /t 5 /nobreak >nul
exit /b 0
