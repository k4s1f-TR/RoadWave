@echo off
cd /d "%~dp0"
node scripts\install-youtube.mjs --update
if errorlevel 1 pause
