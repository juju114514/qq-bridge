@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ── 路线 A：常驻 bridge 收 QQ（插件让出通道）──
node scripts\switch-mode.mjs bridge
echo.
echo 已改好配置。请按上面的提示重启 DSH 与桥接。
pause