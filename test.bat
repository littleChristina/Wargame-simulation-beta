@echo off
chcp 65001 >nul
rem Run the self-test suite (14 checks).
cd /d "%~dp0"
node test\engine.test.js
pause
