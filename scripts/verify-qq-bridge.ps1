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
# 0.4.57.1 起策略变了：RestartOnFailure 要**有**，但必须是 Count=1 / PT1M
# （只自动重启一次，避免无限重启把故障掩盖成"看起来在跑"）。早期"必须完全消失"的断言已过时。
$hasRestart = [bool]($xmlText -match '<RestartOnFailure>')
$restartOnce = [bool]($xmlText -match '<Interval>PT1M</Interval>') -and [bool]($xmlText -match '<Count>1</Count>')
Check 'RestartOnFailure 只重启一次（Count=1 / PT1M）' ($hasRestart -and $restartOnce)
Check 'MultipleInstancesPolicy = IgnoreNew' ([bool]($xmlText -match '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'))
Check 'ExecutionTimeLimit = PT0S' ([bool]($xmlText -match '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>'))
$trigCount = ([regex]::Matches($xmlText, '<LogonTrigger')).Count
$bootTrig = ([regex]::Matches($xmlText, '<BootTrigger')).Count
$otherTrig = ([regex]::Matches($xmlText, '<TimeTrigger|<CalendarTrigger|<IdleTrigger')).Count
# 0.4.57.1 起：登录触发 + 开机触发都要有（开机那层受 InteractiveToken 限制，见 WINDOWS-PROCESS-SUPERVISION §十三）
Check '主任务触发 = 登录 + 开机' ($trigCount -ge 1 -and $bootTrig -ge 1 -and $otherTrig -eq 0) "logon=$trigCount boot=$bootTrig other=$otherTrig"

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
# 注意：**不要用 CommandLine 找 bridge 进程** —— 桥接以管理员权限运行，
# 普通权限的脚本读 Get-CimInstance 的 CommandLine 会得到空值，count 永远 0（假通过/假失败）。
# 改用「3100 的监听者」与「/health/detail 报的 pid」互相印证，这个方法不需要提权。
$listener = @(Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue)
Check '3100 只有一个监听者' ($listener.Count -eq 1) "count=$($listener.Count)"
$listenerPid = ($listener | Select-Object -First 1).OwningProcess

$health = $null
try { $health = (Invoke-WebRequest -Uri 'http://127.0.0.1:3100/health/detail' -TimeoutSec 5 -UseBasicParsing).Content | ConvertFrom-Json } catch {}
Check '/health/detail 可访问' ($null -ne $health)
if ($health) {
  $healthPid = $health.process.pid
  Check 'health 报的 pid 就是 3100 的监听者' ($listenerPid -and $healthPid -and ([int]$listenerPid -eq [int]$healthPid)) "listen=$listenerPid health=$healthPid"
}
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