@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/3] 停掉当前占用 3100 的桥接进程（如果有）...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue; if ($p) { foreach ($c in $p) { try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop; Write-Host ('  stopped pid ' + $c.OwningProcess) } catch { Write-Host ('  skip pid ' + $c.OwningProcess) } } } else { Write-Host '  (3100 空闲)' }"
timeout /t 2 /nobreak >nul
echo [2/3] 清理过期的通道认领文件...
if exist "state\channel-mode.json" del /q "state\channel-mode.json"
echo [3/3] 用守护循环启动（关掉这个窗口才会停）...
echo.
start "" cmd /k "cd /d ""%~dp0"" && start.bat"
echo 已在新窗口启动。这个窗口可以关掉。
timeout /t 4 /nobreak >nul