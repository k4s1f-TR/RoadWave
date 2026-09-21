@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi. Once Node.js 22 veya daha yeni bir surumu kurun.
  pause
  exit /b 1
)
if not exist "tools\ffmpeg\ffmpeg.exe" goto install
if not exist "tools\ffmpeg\ffprobe.exe" goto install
goto launch
:install
  echo Ilk kurulum yapiliyor. Bu adim internet gerektirir...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-engine.ps1"
  if errorlevel 1 (
    echo Kurulum tamamlanamadi. Internet baglantinizi kontrol edin.
    pause
    exit /b 1
  )
:launch
echo Roadwave baslatiliyor. Uygulamayi kapatmak icin bu pencerede Ctrl+C kullanin.
node server.mjs --open
if errorlevel 1 pause
