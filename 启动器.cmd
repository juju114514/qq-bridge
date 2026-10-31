@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] 找不到 node。先装 Node 22 或更高版本：https://nodejs.org/
  echo       装完关掉这个窗口，重新双击。
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\launcher.mjs"
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo   ^(退出码 %RC%^)
)
pause
