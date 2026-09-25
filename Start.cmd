@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install Node.js 22 or later.
  pause
  exit /b 1
)
if not exist "tools\ffmpeg\ffmpeg.exe" goto install
if not exist "tools\ffmpeg\ffprobe.exe" goto install
goto launch
:install
  echo Running first-time setup. This step requires an internet connection...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-engine.ps1"
  if errorlevel 1 (
    echo Installation failed. Check your internet connection.
    pause
    exit /b 1
  )
:launch
echo Starting SoundWave. To stop the application, use Ctrl+C in this window.
node server.mjs --open
if errorlevel 1 pause
