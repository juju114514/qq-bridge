# 保活：检查主任务与 /health/detail，**连续 3 次（15 分钟）不可用才受控重启**
#
# 为什么不直接 schtasks /run：
#   任务的 MultipleInstancesPolicy=IgnoreNew —— 如果任务显示 Running 但服务已死，
#   /run 会被直接忽略，等于什么都没做。
#   所以必须先 /end（停掉卡住的实例）→ 等进程真退出 → 再 /run。
#
# 为什么不启动 start.bat：
#   那会绕过任务计划，形成第二个启动器（历史上因此出现过多实例抢 3100）。
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $PSScriptRoot
$stateFile = Join-Path $dir 'state\watchdog-fails.json'

function Read-Fails {
  try { if (Test-Path $stateFile) { return [int](Get-Content $stateFile -Raw) } } catch {}
  return 0
}
function Write-Fails([int]$n) { try { $n | Out-File $stateFile -Encoding utf8 -NoNewline } catch {} }

# 1) /health/detail 可用 → 清零退出
$healthy = $false
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3100/health/detail' -TimeoutSec 5 -UseBasicParsing
  if ($r.StatusCode -eq 200 -and $r.Content -match '"ok"\s*:\s*true') { $healthy = $true }
} catch { $healthy = $false }

if ($healthy) { Write-Fails 0; exit 0 }

# 2) 不可用：累计失败次数
$fails = (Read-Fails) + 1
Write-Fails $fails
if ($fails -lt 3) {
  "[$(Get-Date -Format 'o')] health 不可用（连续第 $fails 次），暂不重启" |
    Out-File (Join-Path $dir 'state\watchdog.log') -Append -Encoding utf8
  exit 0
}

# 3) 连续 3 次都不可用 → 受控重启
"[$(Get-Date -Format 'o')] health 连续 $fails 次不可用，受控重启主任务" |
  Out-File (Join-Path $dir 'state\watchdog.log') -Append -Encoding utf8
Write-Fails 0

& schtasks /end /tn "\qq-bridge" | Out-Null
Start-Sleep -Seconds 5
& schtasks /run /tn "\qq-bridge" | Out-Null