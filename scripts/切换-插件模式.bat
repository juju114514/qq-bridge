@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ── 路线 B：DSH 插件收 QQ（bridge 只当 sidecar）──
node scripts\switch-mode.mjs plugin
echo.
echo 已改好配置。请按上面的提示重启桥接与 DSH。
pause