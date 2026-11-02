@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS, then double-click this file again.
  echo https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0scripts\start-web.mjs"
if errorlevel 1 (
  pause
  exit /b 1
)
