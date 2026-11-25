@echo off
chcp 65001 >nul
rem Run all self-test suites: rules engine + UI click chain + LAN server + lobby.
cd /d "%~dp0"
node test\engine.test.js
if errorlevel 1 (
  echo.
  echo [FAILED] engine tests
  pause
  exit /b 1
)
node test\ui.test.js
if errorlevel 1 (
  echo.
  echo [FAILED] UI tests
  pause
  exit /b 1
)
node test\net.test.js
if errorlevel 1 (
  echo.
  echo [FAILED] network tests
  pause
  exit /b 1
)
node test\lobby.test.js
if errorlevel 1 (
  echo.
  echo [FAILED] lobby tests
  pause
  exit /b 1
)
pause
