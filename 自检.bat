@echo off
chcp 65001 >nul
cd /d "%~dp0"
title qq-bridge 自检
echo ============================================
echo   qq-bridge 自检（双击就能跑，不需要命令行）
echo ============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
    echo [X] 没找到 node —— 请先装 Node.js LTS ^(https://nodejs.org^)
    echo     装完记得关掉所有窗口重开，再双击本文件。
    echo.
    pause
    exit /b 1
)
node scripts\preflight.mjs
set code=%errorlevel%
echo.
if "%code%"=="0" echo [OK] 自检通过：依赖、配置、端口、DSH、SnowLuma、人格卡都没问题。
if "%code%"=="2" echo [!] 有警告：能跑，但建议按上面的提示逐条处理。
if "%code%"=="1" echo [X] 有致命问题：先按上面的提示修，修完再双击本文件重跑。
echo.
echo （退出码 %code%：0=通过 2=警告 1=致命）
pause