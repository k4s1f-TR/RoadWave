@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install Node.js 22 or later.
  pause
  exit /b 1
)
echo Checking SoundWave dependencies...
node scripts\setup.mjs
if errorlevel 1 (
  echo Setup failed. Review the message above and try again.
  pause
  exit /b 1
)
echo Starting SoundWave. To stop the application, use Ctrl+C in this window.
node server.mjs --open
if errorlevel 1 pause
