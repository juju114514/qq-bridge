# 计划任务/守护启动桥接：找 node → 守护循环 → 结构化日志（0.4.42/0.4.43）
#
# 日志（state/runner.log，每行一个 JSON）：
#   runner.start       本次启动（runnerPid / nodePath）
#   runner.child_exit  node 退出（nodePid / exitCode / uptimeMs / how）
#   runner.restart     即将重试（attempt / delayMs / reason）
#   runner.shutdown    收到停止信号
#
# 为什么用 JSON：`state/exit.log` 那种纯文本"有启动没退出"要靠肉眼比对；
# JSON 行可以直接和任务计划历史对齐，判断是"崩溃"还是"整进程被结束"。
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $dir
$log = Join-Path $dir 'state\runner.log'

function Write-Event([string]$event, [hashtable]$fields) {
  $obj = [ordered]@{ event = $event; time = (Get-Date).ToString('o'); runnerPid = $PID }
  foreach ($k in $fields.Keys) { $obj[$k] = $fields[$k] }
  try { ($obj | ConvertTo-Json -Compress) | Out-File $log -Append -Encoding utf8 } catch {}
}

function Resolve-Node {
  if ($env:QQB_NODE -and (Test-Path $env:QQB_NODE)) { return $env:QQB_NODE }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe'
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $rt = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path $rt) {
    $hit = Get-ChildItem $rt -Recurse -Filter node.exe -Depth 6 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

$node = Resolve-Node
if (-not $node) {
  Write-Event 'runner.fatal' @{ reason = 'node-not-found' }
  exit 1
}
Write-Event 'runner.start' @{ nodePath = $node; taskPid = $PID }

$attempt = 0
while ($true) {
  $attempt += 1
  $t0 = Get-Date
  & $node 'src/bridge.js'
  $code = $LASTEXITCODE
  $ms = [int](((Get-Date) - $t0).TotalMilliseconds)

  $how = switch ($code) {
    0 { 'graceful' }
    2 { 'already-running' }
    default { 'crash' }
  }
  Write-Event 'runner.child_exit' @{ nodePid = $null; exitCode = $code; uptimeMs = $ms; how = $how; attempt = $attempt }

  if ($code -eq 2) {
    # 已有实例：不要跟它抢，退出让 watchdog/任务处理
    Write-Event 'runner.shutdown' @{ reason = 'already-running'; attempt = $attempt }
    exit 2
  }
  $delay = if ($code -eq 0) { 1 } else { 5 }
  Write-Event 'runner.restart' @{ attempt = $attempt; delayMs = $delay * 1000; reason = "exitCode=$code" }
  Start-Sleep -Seconds $delay
}