@echo off
title ZyronChain Local Devnet
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0l1\scripts\start-devnet.ps1"
if errorlevel 1 echo Startup failed. The error above explains which stage failed.
pause
