# 保活：健康检测 + 受控恢复主任务（0.4.45）
#
# 设计要点（外部评审确认）：
#   1. 用**持久化时间戳**判断"持续不可用"，不是"连续 3 次"（5 分钟一次，3 次只跨 10 分钟）
#   2. ready=false **不等于**进程死亡：DSH 断线让 bridge 自己重连，watchdog 不许杀进程
#   3. 恢复前必须确认「旧 Node PID 已退出 + 3100 不再被监听」，否则不启动新实例
#   4. 恢复后验证新实例（buildId/ownerId/epoch 变化 + /health/detail 可用）
#
# 状态文件：state/watchdog-state.json
#   { consecutiveFailures, firstFailureAt, lastFailureAt, lastRecoveryAt }
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $PSScriptRoot
$stateFile = Join-Path $dir 'state\watchdog-state.json'
$logFile = Join-Path $dir 'state\watchdog.log'
# 默认生产值；允许环境变量覆盖（仅供受控演练使用，不影响生产）
$UNHEALTHY_WINDOW_MS = if ($env:QQB_WATCHDOG_WINDOW_MS) { [int]$env:QQB_WATCHDOG_WINDOW_MS } else { 15 * 60 * 1000 }
$COOLDOWN_MS         = if ($env:QQB_WATCHDOG_COOLDOWN_MS) { [int]$env:QQB_WATCHDOG_COOLDOWN_MS } else { 15 * 60 * 1000 }
$TASK = if ($env:QQB_WATCHDOG_TASK) { $env:QQB_WATCHDOG_TASK } else { 'qq-bridge' }
$PORT = if ($env:QQB_WATCHDOG_PORT) { [int]$env:QQB_WATCHDOG_PORT } else { 3100 }

function Log([string]$msg) {
  "[$(Get-Date -Format 'o')] $msg" | Out-File $logFile -Append -Encoding utf8
}

function Read-State {
  try {
    if (Test-Path $stateFile) {
      $j = Get-Content $stateFile -Raw | ConvertFrom-Json
      return [ordered]@{
        consecutiveFailures = [int]$j.consecutiveFailures
        firstFailureAt      = [long]$j.firstFailureAt
        lastFailureAt       = [long]$j.lastFailureAt
        lastRecoveryAt      = [long]$j.lastRecoveryAt
        cooldownUntil       = [long]$j.cooldownUntil
        recoveryAttempts    = [int]$j.recoveryAttempts
      }
    }
  } catch {}
  return [ordered]@{ consecutiveFailures = 0; firstFailureAt = 0; lastFailureAt = 0; lastRecoveryAt = 0; cooldownUntil = 0; recoveryAttempts = 0 }
}

function Write-State($s) {
  try { ($s | ConvertTo-Json -Compress) | Out-File $stateFile -Encoding utf8 -NoNewline } catch {}
}

function Get-Health {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$PORT/health/detail" -TimeoutSec 5 -UseBasicParsing
    if ($r.StatusCode -ne 200) { return @{ ok = $false; kind = 'http' } }
    $j = $r.Content | ConvertFrom-Json
    if (-not $j -or -not $j.PSObject.Properties['ok'] -or -not $j.ok) { return @{ ok = $false; kind = 'json' } }
    return @{ ok = $true; live = [bool]$j.live; ready = [bool]$j.ready; epoch = $j.channel.epoch; buildId = $j.buildId; pid = $j.process.pid }
  } catch {
    return @{ ok = $false; kind = 'unreachable' }
  }
}

function Get-ListenerPid {
  try { return (Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess } catch { return 0 }
}

function Test-PidExists([int]$pid) {
  if (-not $pid -or $pid -le 0) { return $false }
  return [bool](Get-Process -Id $pid -ErrorAction SilentlyContinue)
}

$state = Read-State
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$h = Get-Health

# ── 健康判定 ────────────────────────────────────────────────
if ($h.ok -and $h.live) {
  # 进程活着就算健康：ready=false 只是 DSH/通道暂时不可用，让 bridge 自己重连
  if (-not $h.ready) { Log "live=true 但 ready=false（epoch=$($h.epoch)），不重启，等 bridge 自愈" }
  if ($state.consecutiveFailures -ne 0) { Log "健康恢复，清零失败计数（之前 $($state.consecutiveFailures) 次）" }
  Write-State ([ordered]@{ consecutiveFailures = 0; firstFailureAt = 0; lastFailureAt = 0; lastRecoveryAt = $state.lastRecoveryAt; cooldownUntil = $state.cooldownUntil; recoveryAttempts = 0 })
  exit 0
}

# ── 不可用：累计 ────────────────────────────────────────────
$state.consecutiveFailures += 1
$state.lastFailureAt = $now
if ($state.firstFailureAt -eq 0) { $state.firstFailureAt = $now }
# 时钟回拨：firstFailureAt 在未来 → 重置窗口（记录 clock_adjusted），避免负数/永久卡住
if ($state.firstFailureAt -gt $now) {
  Log "检测到系统时钟回拨（firstFailureAt 在未来），重置故障窗口（clock_adjusted）"
  $state.firstFailureAt = $now
  $state.consecutiveFailures = 1
}
$downtimeMs = $now - $state.firstFailureAt
if ($downtimeMs -lt 0) { $downtimeMs = 0 }
Write-State $state
Log "health 不可用（kind=$($h.kind)，第 $($state.consecutiveFailures) 次，持续 $([math]::Round($downtimeMs/1000))s）"

if ($downtimeMs -lt $UNHEALTHY_WINDOW_MS) { exit 0 }

# 冷却期：上次恢复失败后 COOLDOWN_MS 内不再动手（避免每 5 分钟杀一次）
if ($state.cooldownUntil -gt $now) {
  Log "仍在恢复冷却期（剩余 $([math]::Round(($state.cooldownUntil - $now)/60000,1)) 分钟），跳过本次恢复"
  exit 0
}

# ── 持续 15 分钟不可用：受控恢复 ────────────────────────────
Log "持续不可用 $([math]::Round($downtimeMs/60000,1)) 分钟，开始受控恢复"
$oldPid = Get-ListenerPid
$oldEpoch = $h.epoch
if ($oldPid) {
  $owner = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
  $ownerName = if ($owner) { $owner.ProcessName } else { 'unknown' }
  if ($ownerName -ne 'node') {
    # 端口被别的程序占着：这不是 bridge 的问题，重启只会无限失败
    Log "⚠️ port_conflict：端口 $PORT 被 $ownerName(pid=$oldPid) 占用，不是 bridge —— 不重启，请人工处理"
    $state.cooldownUntil = $now + $COOLDOWN_MS
    Write-State $state
    exit 1
  }
}
Log "旧监听 pid=$oldPid  epoch=$oldEpoch"

& schtasks /end /tn "\$TASK" | Out-Null

# 等旧 Node 真退出（最多 30s）—— 不能只等 PowerShell 退出
$freed = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  $stillListening = Get-ListenerPid
  $pidAlive = Test-PidExists $oldPid
  if (-not $stillListening -and -not $pidAlive) { $freed = $true; break }
}
if (-not $freed) {
  Log "⚠️ recovery_failed：旧进程未退出（pid=$oldPid 仍在/或端口仍被监听），不启动新实例"
  $state.cooldownUntil = $now + $COOLDOWN_MS
  $state.recoveryAttempts += 1
  Write-State $state
  exit 1
}
Log "旧进程已退出，端口 $PORT 已释放，启动主任务"

& schtasks /run /tn "\$TASK" | Out-Null

# 等新实例就绪（最多 60s）
$recovered = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  $h2 = Get-Health
  if ($h2.ok -and $h2.live -and $h2.ready) {
    $changed = ($h2.epoch -ne $oldEpoch) -or ($h2.pid -ne $oldPid)
    Log "恢复成功：新 pid=$($h2.pid) epoch=$($h2.epoch)（旧 pid=$oldPid epoch=$oldEpoch，变化=$changed）buildId=$($h2.buildId)"
    $recovered = $true
    break
  }
}
if (-not $recovered) {
  Log "⚠️ recovery_failed：已启动但 60s 内未 ready，进入冷却期等待人工确认"
  $state.cooldownUntil = $now + $COOLDOWN_MS
  $state.recoveryAttempts += 1
  Write-State $state
  exit 1
}

Write-State ([ordered]@{ consecutiveFailures = 0; firstFailureAt = 0; lastFailureAt = 0; lastRecoveryAt = $now; cooldownUntil = 0; recoveryAttempts = 0 })
exit 0