@echo off
setlocal EnableExtensions
title Zyron Miner Desktop Control Panel

where node.exe >nul 2>&1
if errorlevel 1 (
  echo [HATA] Windows Node.js bulunamadi.
  echo Bu gelistirme arayuzu icin Windows tarafinda Node.js 22 veya 24 kurulu olmali.
  echo.
  pause
  exit /b 1
)

node "%~dp0server.mjs"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [HATA] Zyron Miner arayuzu hata kodu %RC% ile kapandi.
  pause
)
exit /b %RC%
