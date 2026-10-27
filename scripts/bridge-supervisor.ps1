#Requires -Version 5.1
<#
.SYNOPSIS
  qq-bridge 进程守护（Windows）。崩溃自动拉起、退避重启、单实例、优雅停止。

.DESCRIPTION
  ============================ 契约（给接手的 AI 看） ============================
  职责边界（**违反即设计错误**）：
    · 本脚本只守护 `node src\bridge.js`，**不启动、不停止、不安装 SnowLuma**
      —— SnowLuma 是第三方程序，桥接与它只有「探测端口 + 读配置」的关系（设计不变量 L6）。
    · 本脚本不读不写 config.json 里的业务配置，只传环境变量与参数。
    · 本脚本不写 state/ 下的业务文件，只维护三样运行态：
        state\supervisor.lock   守护自身锁（JSON：pid / startedAt / root）
        state\bridge.pid        当前被守护的桥接进程号
        state\supervisor.stop   停止信号（存在即优雅退出，由 start-bridge.ps1 -Stop 写入）

  启动顺序（固定）：
    1) 探测 SnowLuma 的 127.0.0.1:3000 与 :3001 是否在听（只探测）
    2) 起 `node src\bridge.js`（cwd = 仓库根）
    3) 桥接首连大概率报一次 1006，随后自愈 token 连上 —— 这是正常路径

  SnowLuma 等待策略（2026-10-27 改）：
    · 前 -WaitSnowlumaSeconds 秒（默认 600）每 3 秒快探一次
    · 超时后**不再退出**，转入慢速轮询（-SnowlumaPollSeconds，默认 60 秒一次），
      一旦 SnowLuma 起来就立刻启动桥接
    · 想恢复旧行为（超时即放弃）：-SnowlumaPollSeconds 0
    为什么改：开机自启时 SnowLuma 往往还没扫码登录，旧行为等 600 秒就 exit 4，
    之后没有任何东西会再拉起守护 —— 表现为「开机后机器人一直不回，手动跑一次才好」。

  退出码：
    0  正常收尾（-Stop 生效 / 检测到已有实例 / 子进程正常退出且无需重启）
    1  连续快速崩溃超过上限，守护放弃（避免无限重启掩盖真问题）
    3  已有一个守护在跑（单实例）
    4  SnowLuma 未就绪且等待超时（提示人工去启动，绝不代启）
    5  环境不满足（找不到 node / 缺 config.json）

  重启策略：
    · 子进程退出码 2 → 端口被占（已有实例）→ 守护直接退出，不再重启
    · 子进程退出码 0 → 正常退出（例如控制台点了「重启桥接」）→ 1 秒后重启
    · 其他 → 崩溃：60 秒内算「快速崩溃」，退避 5/10/20/40/60 秒；
      连续快速崩溃超过 -MaxFastCrashes 次就放弃并 exit 1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\bridge-supervisor.ps1

.EXAMPLE
  # 前端调试：前台跑，日志直接打到当前控制台
  .\scripts\bridge-supervisor.ps1 -Foreground

.EXAMPLE
  # 不等 SnowLuma：没就绪立刻退 4（给任务计划/CI 用）
  .\scripts\bridge-supervisor.ps1 -WaitSnowlumaSec 0
#>
param(
  [string]$Node = '',
  [switch]$Foreground,
  [int]$WaitSnowlumaSec = 600,
  # 快速等待窗口用完后，每隔多少秒慢探一次；0 = 不轮询（旧行为：超时即 exit 4）
  [int]$SnowlumaPollSeconds = 60,
  [int]$MaxFastCrashes = 5,
  [int]$FastCrashSeconds = 60
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$StateDir = Join-Path $Root 'state'
$LogDir = Join-Path $StateDir 'logs'
$LockFile = Join-Path $StateDir 'supervisor.lock'
$ChildPidFile = Join-Path $StateDir 'bridge.pid'
$StopFile = Join-Path $StateDir 'supervisor.stop'

foreach ($d in @($StateDir, $LogDir)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }

function Say($level, $msg) {
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  $line = "$stamp [supervisor] [$level] $msg"
  Write-Host $line
  try { Add-Content -Path (Join-Path $LogDir 'supervisor.log') -Value $line -Encoding UTF8 } catch { }
}

function Find-NodeExe {
  if ($Node -and (Test-Path $Node)) { return $Node }
  if ($env:QQBOT_NODE -and (Test-Path $env:QQBOT_NODE)) { return $env:QQBOT_NODE }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  $cands = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
  )
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

function Test-TcpPort([int]$Port, [int]$TimeoutMs = 800) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch { return $false } finally { $client.Close() }
}

function Get-ChildPid {
  if (-not (Test-Path $ChildPidFile)) { return 0 }
  $raw = (Get-Content $ChildPidFile -Raw -ErrorAction SilentlyContinue)
  $n = 0
  if ([int]::TryParse(([string]$raw).Trim(), [ref]$n)) { return $n }
  return 0
}

function Test-PidAlive([int]$ProcessId) {
  if (-not $ProcessId) { return $false }
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

# ── 单实例：已有守护在跑就直接退 3 ─────────────────────────────────────────
if (Test-Path $LockFile) {
  $old = 0
  try { $old = [int](Get-Content $LockFile -Raw | ConvertFrom-Json).pid } catch { $old = 0 }
  if (Test-PidAlive $old) {
    Say 'WARN' "已有一个守护在跑（pid=$old），本实例退出。要停：start-bridge.ps1 -Stop"
    exit 3
  }
  Say 'WARN' "发现残留锁（pid=$old 已不在），清掉后继续"
  Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
}

# ── 环境检查 ──────────────────────────────────────────────────────────────
$nodeExe = Find-NodeExe
if (-not $nodeExe) { Say 'FAIL' '找不到 node.exe：装 Node >= 22.13，或设 QQBOT_NODE 指向它'; exit 5 }
$entry = Join-Path $Root 'src\bridge.js'
if (-not (Test-Path $entry)) { Say 'FAIL' "缺少入口：$entry（是不是在错误的目录下跑？）"; exit 5 }
if (-not (Test-Path (Join-Path $Root 'config.json'))) {
  Say 'FAIL' '缺少 config.json：先跑 .\setup.ps1 或复制 config.example.json'
  exit 5
}

# ── 锁 ────────────────────────────────────────────────────────────────────
(@{ pid = $PID; startedAt = (Get-Date).ToString('o'); root = $Root } | ConvertTo-Json -Compress) |
  Set-Content -Path $LockFile -Encoding UTF8
Remove-Item $StopFile -Force -ErrorAction SilentlyContinue
Say 'OK' "守护启动（supervisor pid=$PID，node=$nodeExe，root=$Root）"

# ── 等 SnowLuma（只探测，绝不代启）────────────────────────────────────────
function Wait-Snowluma([int]$Seconds) {
  if ($Seconds -le 0) {
    if ((Test-TcpPort 3000) -and (Test-TcpPort 3001)) { return $true }
    Say 'FAIL' 'SnowLuma 未就绪（:3000/:3001 没有监听）。本守护不会代你启动它——请先启动 SnowLuma 并完成登录。'
    return $false
  }
  $deadline = (Get-Date).AddSeconds($Seconds)
  $notified = $false
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $StopFile) { return $false }
    if ((Test-TcpPort 3000) -and (Test-TcpPort 3001)) { return $true }
    if (-not $notified) {
      Say 'WAIT' "SnowLuma 还没起来（:3000/:3001）。等它就绪，最多 $Seconds 秒…（本守护不代启 SnowLuma）"
      $notified = $true
    }
    Start-Sleep -Seconds 3
  }
  if ($SnowlumaPollSeconds -le 0) {
    Say 'FAIL' "等了 $Seconds 秒 SnowLuma 仍未就绪。先把 SnowLuma 起来并登录（WebUI :5099），再重跑本守护。"
    return $false
  }
  # 慢速轮询：开机自启时 SnowLuma 往往还没登录，等完就走等于把机器人永久撂下。
  # 这里不放弃，一直等着；SnowLuma 一就绪立刻返回，让桥接起来。
  Say 'WAIT' "等了 $Seconds 秒仍未就绪，转入慢速轮询（每 $SnowlumaPollSeconds 秒探一次）。SnowLuma 一就绪就启动桥接；要停就 -Stop 或 Ctrl+C。"
  while ($true) {
    if (Test-Path $StopFile) { return $false }
    if ((Test-TcpPort 3000) -and (Test-TcpPort 3001)) {
      Say 'OK' 'SnowLuma 已就绪，继续启动桥接'
      return $true
    }
    Start-Sleep -Seconds $SnowlumaPollSeconds
  }
}

if (-not (Wait-Snowluma $WaitSnowlumaSec)) {
  Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
  exit 4
}

# ── 主循环 ────────────────────────────────────────────────────────────────
$child = $null
$fastCrashes = 0
$childOut = Join-Path $LogDir 'bridge.out.log'
$childErr = Join-Path $LogDir 'bridge.err.log'

function Stop-Child {
  if ($script:child -and -not $script:child.HasExited) {
    Say 'INFO' "结束桥接进程（pid=$($script:child.Id)）"
    try { Stop-Process -Id $script:child.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
}

try {
  while ($true) {
    if (Test-Path $StopFile) { Say 'OK' '收到停止信号，守护退出'; break }

    Say 'OK' '启动桥接…'
    if ($Foreground) {
      $child = Start-Process -FilePath $nodeExe -ArgumentList @('src\bridge.js') -WorkingDirectory $Root -NoNewWindow -PassThru
    } else {
      $child = Start-Process -FilePath $nodeExe -ArgumentList @('src\bridge.js') -WorkingDirectory $Root `
        -RedirectStandardOutput $childOut -RedirectStandardError $childErr -WindowStyle Hidden -PassThru
    }
    $child.Id | Set-Content -Path $ChildPidFile -Encoding UTF8
    $startedAt = Get-Date
    Say 'OK' "桥接已启动（pid=$($child.Id)）"

    # 等子进程退出（顺带响应停止信号）
    while (-not $child.HasExited) {
      Start-Sleep -Milliseconds 500
      if (Test-Path $StopFile) { Stop-Child; break }
    }
    $child.WaitForExit()
    # PowerShell 5.1 在进程被强杀（或被别的进程结束）时常常取不到 ExitCode：
    # 直接读会是 $null，日志就变成 "code=" 这种没用的输出。统一归一成 -1，
    # 并且按「崩溃」处理（退避重启），而不是误判成"正常退出"。
    $code = $null
    try { $code = $child.ExitCode } catch { $code = $null }
    if ($null -eq $code) { $code = -1 }
    $uptime = [int]((Get-Date) - $startedAt).TotalSeconds
    $suffix = ''
    if ($code -eq -1) { $suffix = '（-1 = 取不到退出码，通常是被强杀/被别的进程结束）' }
    Say 'INFO' "桥接退出：code=$code$suffix，运行了 $uptime 秒"

    if (Test-Path $StopFile) { Say 'OK' '收到停止信号，守护退出'; break }

    if ($code -eq 2) {
      Say 'WARN' '退出码 2 = 控制台端口被占（已有实例在跑）。守护退出，避免双开。'
      break
    }
    if ($code -eq 0) {
      Say 'INFO' '正常退出（可能是控制台点了「重启桥接」）。1 秒后重启。'
      Start-Sleep -Seconds 1
      continue
    }

    if ($uptime -lt $FastCrashSeconds) { $fastCrashes += 1 } else { $fastCrashes = 0 }
    if ($fastCrashes -gt $MaxFastCrashes) {
      Say 'FAIL' "连续 $fastCrashes 次快速崩溃（code=$code）。放弃重启——先看 state\logs\bridge.err.log 与 state\bridge.log"
      exit 1
    }
    $delay = [Math]::Min(60, 5 * [Math]::Pow(2, [Math]::Max(0, $fastCrashes - 1)))
    Say 'WARN' "崩溃重启：第 $fastCrashes 次，$delay 秒后重试"
    Start-Sleep -Seconds $delay
  }
}
finally {
  if ($child -and -not $child.HasExited) {
    Say 'INFO' '守护收尾：结束桥接进程'
    try { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
  Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
  Remove-Item $ChildPidFile -Force -ErrorAction SilentlyContinue
  Say 'OK' '守护已退出'
}

# 显式成功退出：契约里的 exit 0（走到这里说明是 -Stop 生效或端口被占后主动收尾）
exit 0
