@echo off
chcp 65001 >nul
rem One-click launcher: starts the game server and opens the correct URL in the browser.
rem Optional: start.bat 8085  -> use 8085 as the first port (default 8090).
rem Tunnel mode (fixed 8090, no auto port change): see docs/CLOUDFLARE.md
cd /d "%~dp0"
if not "%~1"=="" set PORT=%~1
set DUKOU_OPEN=1
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Please install Node.js 18+ first.
  pause
  exit /b 1
)
echo ==================================================
echo   Wargame Du Kou  v0.3  (LAN)
echo   Starts on 8090; if busy, auto-tries 8091-8099.
echo   The browser will open automatically at the right URL.
echo   LAN: use the address printed below / the invite link.
echo   Cloudflare Tunnel: use fixed 8090, see docs/CLOUDFLARE.md
echo   Close this window or press Ctrl+C to stop.
echo ==================================================
node server.js
pause
