@echo off
chcp 65001 >nul
rem One-click launcher for the wargame server (double-click me).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Please install Node.js 18+ first.
  pause
  exit /b 1
)
echo ==================================================
echo   Wargame Du Kou   http://localhost:8080
echo   Close this window or press Ctrl+C to stop.
echo ==================================================
start "" /min cmd /c "timeout /t 2 /nobreak >nul"
node server.js
pause
