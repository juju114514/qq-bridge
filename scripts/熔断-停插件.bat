@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo   QQ 插件熔断开关
echo ================================================
echo.
echo 正在写入熔断标记 state\plugin-kill ...
> "state\plugin-kill" echo kill
if errorlevel 1 (
  echo [失败] 写不进 state\plugin-kill
  pause
  exit /b 1
)
echo.
echo 已写入。插件会在 2 秒内：
echo   - 断开 QQ 通道
echo   - 释放通道认领
echo   - 不再收发任何 QQ 消息
echo.
echo 验证：看 state\plugin.log 是否出现「检测到 plugin-kill」
echo.
echo 恢复方法：删除 state\plugin-kill，然后重启 DSH
echo.
pause