@echo off
chcp 65001 >nul
cd /d %~dp0
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0release.ps1" %*
echo.
pause
