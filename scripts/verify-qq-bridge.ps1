# 验证修改是否到位（只读）——0.4.45 实施包
# 覆盖外部评审给的 11 条验收标准
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$taskName = 'qq-bridge'
$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Output ("  [OK]   " + $name + $(if ($detail) { "  ($detail)" } else { '' })) }
  else { $script:fail++; Write-Output ("  [FAIL] " + $name + $(if ($detail) { "  ($detail)" } else { '' })) }
}

# 1) 任务 XML
$xmlText = schtasks /query /tn "\$taskName" /xml 2>$null | Out-String
$xml = $null; try { $xml = [xml]$xmlText } catch {}
Check 'RestartOnFailure 已完全消失' (-not ($xmlText -match '<RestartOnFailure>'))
Check 'WindowStyle Hidden 已生效' ([bool]($xmlText -match 'WindowStyle Hidden'))
Check 'MultipleInstancesPolicy = IgnoreNew' ([bool]($xmlText -match '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'))
Check 'ExecutionTimeLimit = PT0S' ([bool]($xmlText -match '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>'))
$trigCount = ([regex]::Matches($xmlText, '<LogonTrigger')).Count
$otherTrig = ([regex]::Matches($xmlText, '<TimeTrigger|<CalendarTrigger|<BootTrigger|<IdleTrigger')).Count
Check '主任务只保留 LogonTrigger' ($trigCount -ge 1 -and $otherTrig -eq 0) "logon=$trigCount other=$otherTrig"

# 1b) watchdog 任务本身也必须隐藏（0.4.47：它每 5 分钟跑一次，漏了 -WindowStyle Hidden 就会一直弹窗）
$wdXml = schtasks /query /tn "\qq-bridge-watchdog" /xml 2>$null | Out-String
Check 'watchdog 任务也带 WindowStyle Hidden' ([bool]($wdXml -match 'WindowStyle Hidden'))
Check 'watchdog 任务无 RestartOnFailure' (-not ($wdXml -match '<RestartOnFailure>'))
Check 'watchdog 仍每 5 分钟触发' ([bool]($wdXml -match '<Interval>PT5M</Interval>'))

# 2) watchdog
$keep = Get-Content (Join-Path $root 'scripts\keepalive.ps1') -Raw -ErrorAction SilentlyContinue
Check 'watchdog 不再调用 start.bat' (-not ($keep -match 'start\.bat'))
Check 'watchdog 连续故障计数持久化' ([bool]($keep -match 'watchdog-state\.json'))
Check 'watchdog 有 15 分钟持续不可用判定' ([bool]($keep -match '15 \* 60 \* 1000|UNHEALTHY_WINDOW_MS'))

# 3) 进程与健康
$listener = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
$nodeCount = (Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'bridge\.js' }).Count
Check '只有一个 bridge 进程' ($nodeCount -le 1) "count=$nodeCount"
$health = $null
try { $health = (Invoke-WebRequest -Uri 'http://127.0.0.1:3100/health/detail' -TimeoutSec 5 -UseBasicParsing).Content | ConvertFrom-Json } catch {}
Check '/health/detail 可访问' ($null -ne $health)
if ($health) {
  Check 'live=true' ([bool]$health.live)
  $buildOk = $false
  try {
    $nodeBin = (Get-Command node -ErrorAction Stop).Source
  } catch { $nodeBin = $env:QQB_NODE }
  Check 'buildId 非空' ([bool]$health.buildId) $health.buildId
  Check 'ownerId 非空' ([bool]$health.process.ownerId)
  Check 'channel.epoch 存在' ($null -ne $health.channel.epoch) ("epoch=" + $health.channel.epoch)
}

# 4) 日志
Check 'runner.log 有 runner.start 事件' ([bool](Select-String -Path (Join-Path $root 'state\runner.log') -Pattern '"event":"runner.start"' -ErrorAction SilentlyContinue))
Check 'watchdog 状态文件可写路径存在' (Test-Path (Join-Path $root 'state'))

Write-Output ""
Write-Output ("结果：" + $pass + " 项通过, " + $fail + " 项失败")
if ($fail -gt 0) { exit 1 }