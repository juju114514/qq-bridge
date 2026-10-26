#Requires -Version 5.1
<#
.SYNOPSIS
  花费熔断器：统计当天 token 花费，超上限就自动停掉 AI 回复并通知管理员。

.DESCRIPTION
  桥接自带的 token 账本**只记不拦**。本脚本在外部做硬熔断：
    当天花费 >= 上限 → POST /api/socialV2/config {enabled:false} → 私聊通知管理员

  适合用 Windows 计划任务每 10~30 分钟跑一次。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\guard.ps1

.EXAMPLE
  # 超限就熔断（建议放计划任务）
  .\scripts\guard.ps1 -Apply -DailyCostLimit 5

.EXAMPLE
  # 解熔断
  .\scripts\guard.ps1 -Resume
#>
param(
  [switch]$Apply,
  [switch]$Resume,
  [double]$DailyCostLimit = 0
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Ok($n, $d) { Write-Host ("  [OK]   {0,-20} {1}" -f $n, $d) -ForegroundColor Green }
function Wo($n, $d) { Write-Host ("  [WARN] {0,-20} {1}" -f $n, $d) -ForegroundColor Yellow }
function No($n, $d) { Write-Host ("  [FAIL] {0,-20} {1}" -f $n, $d) -ForegroundColor Red }
function Info($m)   { Write-Host ("         $m") -ForegroundColor DarkGray }

$cfgPath = Join-Path $Root 'config.json'
$cfg = $null
if (Test-Path $cfgPath) {
  try { $cfg = [IO.File]::ReadAllText($cfgPath, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { }
}

if ($DailyCostLimit -le 0) {
  if ($cfg -and $cfg.guard -and $cfg.guard.dailyCostLimitCNY) { $DailyCostLimit = [double]$cfg.guard.dailyCostLimitCNY }
  else { $DailyCostLimit = 5 }
}

$port = if ($cfg -and $cfg.consolePort) { [int]$cfg.consolePort } else { 3100 }
$tokFile = Join-Path $Root 'state\console-token'
$headers = @{}
if (Test-Path $tokFile) { $headers['X-Console-Token'] = ([IO.File]::ReadAllText($tokFile)).Trim() }

function Invoke-Console($method, $path, $body) {
  $uri = "http://127.0.0.1:$port$path"
  if ($null -eq $body) { return Invoke-RestMethod -Uri $uri -Headers $headers -Method $method -TimeoutSec 10 }
  $json = $body | ConvertTo-Json -Depth 6 -Compress
  return Invoke-RestMethod -Uri $uri -Headers $headers -Method $method `
    -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 10
}

Write-Host ""
Write-Host "花费熔断器" -ForegroundColor Cyan
Write-Host ("  目录: {0}  上限: ￥{1}/天" -f $Root, $DailyCostLimit) -ForegroundColor DarkGray
Write-Host ""

# ── 解熔断 ─────────────────────────────────────────────────────────────────
if ($Resume) {
  try {
    $r = Invoke-Console 'POST' '/api/socialV2/config' @{ enabled = $true }
    Ok '已恢复' 'AI 回复重新开启（socialV2.enabled=true）'
  } catch {
    No '恢复失败' $_.Exception.Message
    Info '手动改 config.json 的 socialV2.enabled=true，然后重启桥接'
    exit 1
  }
  exit 0
}

# ── 统计当天花费 ───────────────────────────────────────────────────────────
$today = (Get-Date).Date
$usage = Join-Path $Root 'state\token-usage.jsonl'
$cost = 0.0
$records = 0
if (Test-Path $usage) {
  foreach ($line in [IO.File]::ReadLines($usage)) {
    if (-not $line.Trim()) { continue }
    try { $o = $line | ConvertFrom-Json } catch { continue }
    $t = 0
    if ($o.t) { $t = [double]$o.t }
    elseif ($o.ts) { $t = [double]$o.ts }
    if ($t -le 0) { continue }
    # 毫秒时间戳
    $dt = if ($t -gt 1e12) { [DateTimeOffset]::FromUnixTimeMilliseconds([long]$t).LocalDateTime } else { [DateTimeOffset]::FromUnixTimeSeconds([long]$t).LocalDateTime }
    if ($dt -lt $today) { continue }
    $c = 0.0
    if ($null -ne $o.cost) { $c = [double]$o.cost }
    elseif ($null -ne $o.c) { $c = [double]$o.c }
    $cost += $c
    $records++
  }
}

Ok '今日记录' ("{0} 条 / ￥{1:N4}" -f $records, $cost)
Ok '上限' ("￥{0:N2}/天（{1}）" -f $DailyCostLimit, $(if ($cost -ge $DailyCostLimit) { '已超' } else { '正常' }))

$stateFile = Join-Path $Root 'state\guard-state.json'
$over = $cost -ge $DailyCostLimit

if (-not $Apply) {
  Info '只报告。要启用熔断：-Apply（建议放计划任务每 30 分钟跑）'
  exit $(if ($over) { 2 } else { 0 })
}

if (-not $over) {
  exit 0
}

# ── 超限：熔断 ─────────────────────────────────────────────────────────────
Wo '超限' ("今日 ￥{0:N4} ≥ 上限 ￥{1:N2}，开始熔断" -f $cost, $DailyCostLimit)

$paused = $false
try {
  $null = Invoke-Console 'POST' '/api/socialV2/config' @{ enabled = $false }
  Ok '已停 AI' 'socialV2.enabled=false（立即生效，无需重启）'
  $paused = $true
} catch {
  No '停 AI 失败' $_.Exception.Message
}

# 通知管理员
$owner = if ($cfg -and $cfg.ownerQQ) { [string]$cfg.ownerQQ } else { '' }
if ($owner) {
  try {
    $msg = "【花费熔断】今天已花 ￥$([math]::Round($cost,4))，超过上限 ￥${DailyCostLimit}。`nAI 回复已自动关闭。`n确认后运行 scripts\guard.ps1 -Resume 恢复。"
    $null = Invoke-Console 'POST' '/api/send/private' @{ userId = [long]$owner; message = $msg }
    Ok '已通知' "私聊 $owner"
  } catch { Wo '通知失败' $_.Exception.Message }
}

# 落盘状态
$state = [ordered]@{
  at = (Get-Date).ToString('s')
  date = $today.ToString('yyyy-MM-dd')
  costCNY = [math]::Round($cost, 6)
  limitCNY = $DailyCostLimit
  paused = $paused
}
if (Test-Path $stateFile) {
  try {
    $old = [IO.File]::ReadAllText($stateFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $state['history'] = @($old.history) + @($old) | Select-Object -Last 20
  } catch { }
}
([IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false))))

$logFile = Join-Path $Root 'state\guard.log'
Add-Content -Path $logFile -Value ("{0}  熔断  cost=￥{1:N4} limit=￥{2:N2} paused={3}" -f (Get-Date).ToString('s'), $cost, $DailyCostLimit, $paused) -Encoding UTF8

Write-Host ""
Write-Host "已熔断。恢复：.\scripts\guard.ps1 -Resume" -ForegroundColor Yellow
exit 2
