#Requires -Version 5.1
<#
.SYNOPSIS
  杀软（卡巴斯基等）干扰诊断：探测杀软状态、本机端口、外网延迟，并打印该加白名单的路径。

.DESCRIPTION
  只读脚本：不修改任何杀软设置。加排除项需要图形界面操作，见 docs/guides/KASPERSKY.md。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\kaspersky-diagnose.ps1
#>
param(
  [switch]$Verbose,
  [switch]$StartAV
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$warn = 0
$fail = 0
function Ok($n, $d)   { Write-Host ("  [OK]   {0,-26} {1}" -f $n, $d) -ForegroundColor Green }
function Wo($n, $d)   { Write-Host ("  [WARN] {0,-26} {1}" -f $n, $d) -ForegroundColor Yellow; $script:warn++ }
function No($n, $d)   { Write-Host ("  [FAIL] {0,-26} {1}" -f $n, $d) -ForegroundColor Red;    $script:fail++ }
function Info($m)     { Write-Host ("         $m") -ForegroundColor DarkGray }

Write-Host ""
Write-Host "杀软干扰诊断" -ForegroundColor Cyan
Write-Host ("  目录: {0}" -f $Root) -ForegroundColor DarkGray
Write-Host ""

# ── 1. 杀软探测 ────────────────────────────────────────────────────────────
# -StartAV：把被关掉的杀软服务拉起来（配好排除项后再用这个验证）
if ($StartAV) {
  $svc = Get-Service -Name 'AVP21.25' -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -ne 'Running') {
    Write-Host "  → 尝试启动 AVP21.25（需要管理员）…" -ForegroundColor Yellow
    try { Start-Service -Name 'AVP21.25' -ErrorAction Stop; Start-Sleep -Seconds 6; Ok 'Kaspersky' "已启动：$((Get-Service AVP21.25).Status)" }
    catch { No 'Kaspersky 启动失败' $_.Exception.Message }
  }
}

$avs = @(
  @{ Name = 'Kaspersky'; Svc = 'AVP21.25'; Proc = 'avp'; Paths = @('C:\Program Files (x86)\Kaspersky Lab','C:\Program Files\Kaspersky Lab') },
  @{ Name = '360安全卫士'; Svc = '360rp'; Proc = '360tray|ZhuDongFangYu'; Paths = @('C:\Program Files (x86)\360') },
  @{ Name = '火绒'; Svc = 'HipsDaemon'; Proc = 'HipsTray|usysdiag'; Paths = @('C:\Program Files\Huorong') },
  @{ Name = 'Defender'; Svc = 'WinDefend'; Proc = 'MsMpEng'; Paths = @('C:\Program Files\Windows Defender') }
)

$running = @()
foreach ($av in $avs) {
  $svc = Get-Service -Name $av.Svc -ErrorAction SilentlyContinue
  $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match ("^(" + $av.Proc + ")$") }
  $installed = ($svc -ne $null) -or ($proc -ne $null) -or ($av.Paths | Where-Object { Test-Path $_ })
  if (-not $installed) { continue }
  $state = if ($proc) { '运行中' } elseif ($svc -and $svc.Status -eq 'Running') { '服务运行（无进程）' } elseif ($svc) { "已安装但服务 $($svc.Status)" } else { '已安装' }
  if ($proc -or ($svc -and $svc.Status -eq 'Running')) { $running += $av.Name }
  Ok $av.Name $state
}

# Kaspersky 详情
$ksvc = Get-Service -Name 'AVP21.25' -ErrorAction SilentlyContinue
if ($ksvc) {
  $avp = Get-ChildItem 'C:\Program Files (x86)\Kaspersky Lab','C:\Program Files\Kaspersky Lab' -Recurse -Filter 'avp.com' -ErrorAction SilentlyContinue -Depth 3 | Select-Object -First 1
  if ($avp) { Info ("avp.com: " + $avp.FullName) }
  if ($ksvc.Status -ne 'Running') {
    Wo 'Kaspersky 服务' "当前 $($ksvc.Status)（如果是为了跑 DSH 才关的，说明还没配排除项）"
    Info '启动：Start-Service AVP21.25（管理员）'
  }
}

if ($running.Count -eq 0) {
  Wo '杀软' '没检测到正在运行的杀软（或全部被关）'
  Info '如果是因为 DSH 不工作才关的，请按 docs/guides/KASPERSKY.md 配排除项后再开回来'
} else {
  Ok '在跑的杀软' ($running -join '、')
}

# ── 2. 端口探测 ────────────────────────────────────────────────────────────
function Test-Port([int]$p) {
  try { $t = New-Object Net.Sockets.TcpClient; $r = $t.ConnectAsync('127.0.0.1', $p).Wait(700); $t.Close(); return $r } catch { return $false }
}

$cfg = $null
if (Test-Path (Join-Path $Root 'config.json')) {
  try { $cfg = [IO.File]::ReadAllText((Join-Path $Root 'config.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { }
}

$consolePort = if ($cfg -and $cfg.consolePort) { [int]$cfg.consolePort } else { 3100 }
$dshPort = if ($cfg -and $cfg.dsh.baseUrl -match ':(\d+)$') { [int]$Matches[1] } else { 0 }
$wsPort = if ($cfg -and $cfg.snowluma.wsUrl -match ':(\d+)$') { [int]$Matches[1] } else { 3001 }
$httpPort = if ($cfg -and $cfg.snowluma.httpUrl -match ':(\d+)$') { [int]$Matches[1] } else { 3000 }

foreach ($p in @(@{n='桥接控制台';p=$consolePort}, @{n='SnowLuma HTTP';p=$httpPort}, @{n='SnowLuma WS';p=$wsPort})) {
  if (Test-Port $p.p) { Ok $p.n "$($p.p) 可连" } else { No $p.n "$($p.p) 连不上" }
}
if ($dshPort -gt 0) {
  if (Test-Port $dshPort) { Ok 'DSH' "$dshPort 可连" } else { No 'DSH' "$dshPort 连不上（DSH 没开？或被拦？）" }
}

# ── 3. 外网延迟（加密连接扫描的体感指标）──────────────────────────────────
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
  $null = Invoke-WebRequest 'https://api.github.com/zen' -UseBasicParsing -TimeoutSec 20
  $ms = $sw.ElapsedMilliseconds
  if ($ms -lt 3000) { Ok '外网 HTTPS' "$ms ms" }
  else { Wo '外网 HTTPS' "$ms ms（偏慢，可能是「加密连接扫描」在解密）" }
} catch {
  No '外网 HTTPS' '请求失败（代理/防火墙/加密扫描都可能）'
}

# ── 4. 桥接状态冒烟 ────────────────────────────────────────────────────────
try {
  $hdr = @{}
  $tokFile = Join-Path $Root 'state\console-token'
  if (Test-Path $tokFile) { $hdr['X-Console-Token'] = ([IO.File]::ReadAllText($tokFile)).Trim() }
  $st = Invoke-RestMethod -Uri "http://127.0.0.1:$consolePort/api/status" -Headers $hdr -TimeoutSec 10
  if ($st.dshReady) { Ok 'DSH 就绪' 'true' } else { No 'DSH 就绪' 'false' }
  if ($st.snowluma.good) { Ok 'QQ 在线' 'true' } else { No 'QQ 在线' 'false' }
} catch {
  $code = $null
  try { $code = [int]$_.Exception.Response.StatusCode } catch { }
  if ($code -eq 401) { Wo '桥接状态' '401（token 不匹配，通常不是杀软问题）' }
  else { Wo '桥接状态' '取不到 /api/status（桥接没跑？）' }
}

# ── 5. 打印该加白名单的路径 ────────────────────────────────────────────────
Write-Host ""
Write-Host "  ── 建议加进杀软「排除项 / 受信任应用程序」的路径 ──" -ForegroundColor Cyan

$paths = [System.Collections.Generic.List[string]]::new()
$add = { param($p) if ($p -and (Test-Path $p) -and -not $paths.Contains($p)) { $paths.Add($p) } }

# 项目目录 + 上层
& $add $Root
& $add (Split-Path -Parent $Root)

# DSH 安装与数据目录
if (Test-Path 'D:\DEEPSEEK') { & $add 'D:\DEEPSEEK' }
& $add (Join-Path $env:USERPROFILE '.dsh')

# 配置里出现过的项目外目录
if ($cfg -and $cfg.snowluma.homeDir) { & $add $cfg.snowluma.homeDir }
if ($cfg -and $cfg.snowluma.launcherPath) { & $add (Split-Path -Parent $cfg.snowluma.launcherPath) }

# node.exe（所有已知路径）
$nodeCands = @()
$c = Get-Command node -ErrorAction SilentlyContinue
if ($c) { $nodeCands += $c.Source }
$nodeCands += @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")
$nodeCands += @(Get-ChildItem (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes') -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'node[\\/]bin[\\/]node\.exe$' } | Select-Object -ExpandProperty FullName)
foreach ($n in ($nodeCands | Select-Object -Unique)) { & $add $n }

# ffmpeg / ffprobe（PATH 里 + 项目内 + 相邻目录）
foreach ($exe in 'ffmpeg','ffprobe') {
  $cmd = Get-Command $exe -ErrorAction SilentlyContinue
  if ($cmd) { & $add $cmd.Source }
  foreach ($rel in @("$exe\$exe.exe", "bin\$exe.exe", "..\ffmpeg\$exe.exe")) {
    & $add (Join-Path $Root $rel)
  }
}

foreach ($p in $paths) { Write-Host ("    " + $p) -ForegroundColor White }

Write-Host ""
Write-Host "    ↑ 复制到：卡巴斯基 → 设置 → 安全设置 → 威胁与排除 → 管理排除项 / 指定受信任应用程序" -ForegroundColor DarkGray
Write-Host "      详细步骤见 docs/guides/KASPERSKY.md" -ForegroundColor DarkGray

# ── 汇总 ───────────────────────────────────────────────────────────────────
Write-Host ""
if ($fail -eq 0 -and $warn -eq 0) { Write-Host "诊断通过：杀软与本项目共存正常。" -ForegroundColor Green; exit 0 }
if ($fail -eq 0) { Write-Host "有 $warn 项警告（多半是需要补排除项）。" -ForegroundColor Yellow; exit 2 }
Write-Host "有 $fail 项失败。" -ForegroundColor Red
exit 1
