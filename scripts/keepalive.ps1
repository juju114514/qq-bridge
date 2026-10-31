# 保活：如果 3100 没在听，就用守护循环拉起来。
# 由计划任务 qq-bridge-watchdog 每 5 分钟跑一次（也在登录时跑）。
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $PSScriptRoot
$listening = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
if ($listening) { exit 0 }
$log = Join-Path $dir 'state\watchdog.log'
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 3100 未监听，重启桥接" | Out-File -FilePath $log -Append -Encoding utf8
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "cd /d `"$dir`" && start.bat" -WindowStyle Hidden