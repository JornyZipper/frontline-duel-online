@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required. Install it, then run this file again.
  pause
  exit /b 1
)
start "" "http://localhost:3000/"
node server.js
pause
