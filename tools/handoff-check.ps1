# 外包/交接前的一键只读巡检（给别的 AI 或同事用）
#
# 设计原则：**只读**。不改代码、不装依赖、不重启服务、不碰 state/ 里的锁。
# 输出：state/handoff-report.txt（完整），屏幕上打最后 20 行。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\tools\handoff-check.ps1
#   powershell -ExecutionPolicy Bypass -File .\tools\handoff-check.ps1 -SkipAudit   # 省时间

param(
  [switch]$SkipAudit
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root 'state'
$report = Join-Path $stateDir 'handoff-report.txt'
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }

$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$s) { $lines.Add($s); Write-Host $s }

function Find-Node {
  if ($env:QQB_NODE -and (Test-Path $env:QQB_NODE)) { return $env:QQB_NODE }
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @(
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
    'C:\Program Files\nodejs\node.exe'
  )) { if (Test-Path $p) { return $p } }
  return ''
}

Say ("=" * 72)
Say ("交接巡检  " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Say ("仓库: " + $root)
Say ("=" * 72)

$node = Find-Node
if (-not $node) {
  Say "[FAIL] 找不到 node —— 先装 Node >= 22.13"
  $lines | Set-Content -Path $report -Encoding utf8
  exit 1
}
Say ("[OK]   node: " + $node + "  (" + (& $node --version) + ")")
Say ''

# 1) 工具体检
Say '── 1/4 工具体检（tools/doctor-tools.mjs）────────────────────────'
$doctorScript = Join-Path $root 'tools\doctor-tools.mjs'
if (Test-Path $doctorScript) {
  $out = & $node $doctorScript 2>&1
  $code = $LASTEXITCODE
  foreach ($l in $out) { Say ("  " + $l) }
  Say ("  → 退出码: $code（0=没有 FAIL）")
} else {
  Say '  [WARN] 没有 tools/doctor-tools.mjs（老版本仓库？）'
}
Say ''

# 2) 隐私守卫
Say '── 2/4 隐私守卫（scripts/check-privacy.mjs）─────────────────────'
$priv = Join-Path $root 'scripts\check-privacy.mjs'
if (Test-Path $priv) {
  $out = & $node $priv 2>&1
  foreach ($l in $out) { Say ("  " + $l) }
  Say ("  → 退出码: $LASTEXITCODE")
} else {
  Say '  [WARN] 没有 check-privacy.mjs'
}
Say ''

# 3) 离线审计
Say '── 3/4 离线审计（scripts/test-audit.mjs）────────────────────────'
if ($SkipAudit) {
  Say '  （-SkipAudit：跳过）'
} else {
  $audit = Join-Path $root 'scripts\test-audit.mjs'
  if (Test-Path $audit) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $out = & $node $audit 2>&1
    $sw.Stop()
    $summary = ($out | Select-String -Pattern 'Audit suite' | Select-Object -First 1)
    if ($summary) { Say ("  " + $summary.Line.Trim()) } else { Say '  [WARN] 没抓到 "Audit suite" 汇总行' }
    $failed = $out | Select-String -Pattern '^  FAILED' | Select-Object -First 8
    foreach ($f in $failed) { Say ("  " + $f.Line.Trim()) }
    Say ("  → 用时 " + [math]::Round($sw.Elapsed.TotalSeconds, 0) + " 秒")
  } else {
    Say '  [WARN] 没有 test-audit.mjs'
  }
}
Say ''

# 4) 运行时现场（只读）
Say '── 4/4 运行时现场（只读）──────────────────────────────────────'
try {
  $ports = 3000, 3001, 3100
  foreach ($p in $ports) {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { Say ("  [OK]   :" + $p + " 在听（pid=" + $c.OwningProcess + "）") }
    else { Say ("  [WARN] :" + $p + " 没人听") }
  }
} catch { Say '  [WARN] 端口查询失败（非 Windows？）' }

$sl = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'snowluma' }
$slCount = ($sl | Measure-Object).Count
if ($slCount -le 1) { Say ("  [OK]   SnowLuma 进程数: " + $slCount + "（>1 就是重复拉起，见 TROUBLESHOOTING）") }
else { Say ("  [WARN] SnowLuma 进程数: " + $slCount + "（重复拉起，见 TROUBLESHOOTING「SnowLuma 窗口越堆越多」）") }

$log = Join-Path $stateDir 'bridge.log'
if (Test-Path $log) {
  $tail = Get-Content $log -Tail 200 -ErrorAction SilentlyContinue
  $bad = $tail | Select-String -Pattern 'is not defined|ReferenceError|事件流中断|启动不完整'
  if ($bad) {
    Say '  [WARN] 日志里有异常关键词：'
    foreach ($b in ($bad | Select-Object -First 3)) { Say ("         " + $b.Line.Trim()) }
  } else {
    Say '  [OK]   日志尾部 200 行没有异常关键词'
  }
} else {
  Say '  [WARN] 没有 state/bridge.log（桥接还没跑过？）'
}
Say ''

Say ("报告已写入: " + $report)
$lines | Set-Content -Path $report -Encoding utf8

Write-Host ''
Write-Host '── 最后 20 行 ──'
$lines | Select-Object -Last 20 | ForEach-Object { Write-Host $_ }
