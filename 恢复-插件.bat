@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "state\plugin-kill" (
  del /q "state\plugin-kill"
  echo 已删除熔断标记。现在重启 DSH 即可恢复插件模式。
) else (
  echo 没有熔断标记（插件本来就没被熔断）。
)
pause