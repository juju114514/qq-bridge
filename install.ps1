#Requires -Version 5.1
<#
.SYNOPSIS
  qq-bridge 一键安装：自动探测 DSH 与 SnowLuma，生成 config.json，启动并健康检查。

.DESCRIPTION
  只做本机能做的事。需要人工完成的只有两件：登录 DSH、扫码登录 QQ 小号。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -OwnerQQ 123456789

.EXAMPLE
  .\install.ps1 -OwnerQQ 123456789 -Groups "111,222" -NoStart
#>
param(
  [Parameter(Mandatory = $true)][string]$OwnerQQ,
  [string]$Groups = "",
  [string]$Privates = "",
  [string]$DshUrl = "",
  [string]$SnowlumaHome = "",
  [string]$Token = "",
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Ok($m)   { Write-Host "[ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!]  $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[x]  $m" -ForegroundColor Red }
function Info($m) { Write-Host "     $m" -ForegroundColor DarkGray }

function Test-Port([int]$p) {
  try {
    $t = New-Object Net.Sockets.TcpClient
    $ok = $t.ConnectAsync('127.0.0.1', $p).Wait(700)
    $t.Close()
    return $ok
  } catch { return $false }
}

function Read-JsonFile([string]$path) {
  return [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json
}

function Write-JsonFile([string]$path, $obj) {
  $json = $obj | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding($false)))
}

# ── 1. Node ────────────────────────────────────────────────────────────────
function Resolve-Node {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $cands = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )
  $dshNode = Get-ChildItem (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes') -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'node[\\/]bin[\\/]node\.exe$' } |
    Sort-Object FullName -Descending | Select-Object -First 1
  if ($dshNode) { $cands += $dshNode.FullName }
  foreach ($p in $cands) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

$nodeExe = Resolve-Node
if (-not $nodeExe) {
  Fail "找不到 node。请先装 Node.js 22 LTS：https://nodejs.org/en/download"
  exit 1
}
$nodeDir = Split-Path -Parent $nodeExe
if ($env:PATH -notlike "*$nodeDir*") { $env:PATH = $nodeDir + ";" + $env:PATH }
$nodeVer = (& $nodeExe --version 2>$null).Trim()
$major = [int]($nodeVer.TrimStart('v').Split('.')[0])
$minor = [int]($nodeVer.TrimStart('v').Split('.')[1])
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 13)) {
  Fail "Node 版本太低（$nodeVer），需要 >= 22.13.0"
  exit 1
}
Ok "Node $nodeVer（$nodeExe）"

# ── 2. 探测 DSH ───────────────────────────────────────────────────────────
$dshBase = $DshUrl
if (-not $dshBase) {
  $ports = @()
  $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'DeepSeek|dsh' }
  if ($procs) {
    $pids = @($procs | ForEach-Object { $_.Id })
    $ports += (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $pids -contains $_.OwningProcess } |
      Select-Object -ExpandProperty LocalPort -Unique)
  }
  if (Test-Path (Join-Path $Root 'config.json')) {
    try {
      $prev = Read-JsonFile (Join-Path $Root 'config.json')
      if ($prev.dsh.baseUrl -match ':(\d+)$') { $ports += [int]$Matches[1] }
    } catch { }
  }
  $ports += 3080
  foreach ($p in ($ports | Select-Object -Unique)) {
    if (Test-Port $p) { $dshBase = "http://127.0.0.1:$p"; break }
  }
}
if (-not $dshBase) {
  Fail "探测不到 DSH。请先打开 DeepSeek Harness 并登录，再用 -DshUrl 指定"
  exit 1
}
Ok "DSH 地址 $dshBase"

# ── 3. 探测 SnowLuma ──────────────────────────────────────────────────────
function Resolve-SnowLumaHome {
  if ($SnowlumaHome -and (Test-Path $SnowlumaHome)) { return $SnowlumaHome }
  if ($env:SNOWLUMA_HOME -and (Test-Path $env:SNOWLUMA_HOME)) { return $env:SNOWLUMA_HOME }
  # 从正在运行的 SnowLuma 进程取安装目录
  $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*snowluma*index.mjs*' } | Select-Object -First 1
  if ($p) {
    $m = [regex]::Match($p.CommandLine, '([A-Za-z]:\\[^"\s]*index\.mjs)')
    if ($m.Success) {
      $dir = Split-Path -Parent $m.Groups[1].Value
      if ($dir -and (Test-Path (Join-Path $dir 'config'))) { return $dir }
    }
  }
  foreach ($c in @("D:\QQBot\snowluma", "$env:LOCALAPPDATA\SnowLuma", "$env:USERPROFILE\SnowLuma", "$env:ProgramFiles\SnowLuma")) {
    if ($c -and (Test-Path (Join-Path $c 'config'))) { return $c }
  }
  return $null
}

$slHome = Resolve-SnowLumaHome
$wsToken = ""; $wsPort = 3001; $httpToken = ""; $httpPort = 3000
if ($slHome) {
  $cfgDir = Join-Path $slHome 'config'
  # 逐个读 onebot_*.json，挑「真的有 token」的那份（空配置的账号文件很常见）
  $files = @(Get-ChildItem $cfgDir -Filter 'onebot_*.json' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike '*.bak*' })
  foreach ($f in $files) {
    try { $j = Read-JsonFile $f.FullName } catch { continue }
    if (-not $j.networks) { continue }
    $ws = @($j.networks.wsServers) | Where-Object { $_ } | Select-Object -First 1
    $ht = @($j.networks.httpServers) | Where-Object { $_ } | Select-Object -First 1
    $wt = if ($ws) { [string]$ws.accessToken } else { "" }
    $hkt = if ($ht) { [string]$ht.accessToken } else { "" }
    if ($wt -or $hkt) {
      $wsToken = $wt; $httpToken = $hkt
      if ($ws -and $ws.port) { $wsPort = [int]$ws.port }
      if ($ht -and $ht.port) { $httpPort = [int]$ht.port }
      Info "SnowLuma 账号配置：$($f.Name)"
      break
    }
  }
}
if ($slHome) { Ok "SnowLuma 目录 $slHome" }
else { Warn "没找到 SnowLuma 目录（可用 -SnowlumaHome 指定）" }

$httpUrl = "http://127.0.0.1:$httpPort"
$wsUrl = "ws://127.0.0.1:$wsPort"
if (-not (Test-Port $httpPort) -or -not (Test-Port $wsPort)) {
  Fail "SnowLuma 端口不可达（$httpPort/$wsPort）。请先打开 SnowLuma 并扫码登录 QQ 小号"
  exit 1
}
Ok "SnowLuma $httpPort/$wsPort 可达"

if (-not $Token) { $Token = $httpToken }   # 桥接的 accessToken 存 HTTP 那份
if ($Token) { Ok "已取得 OneBot HTTP token（$($Token.Substring(0,4))…）" }
else { Warn "没取到 OneBot token，先留空（桥接启动后会自愈重试）" }
if ($wsToken) { Info "另取到 WS token（$($wsToken.Substring(0,4))…），桥接会自动使用" }

# ── 4. 装依赖 ─────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $Root 'node_modules\@snowluma\sdk'))) {
  Info "npm install（首次会下依赖，可能要几分钟）"
  & (Join-Path $nodeDir 'npm.cmd') install
  if ($LASTEXITCODE -ne 0) {
    Warn "换镜像重试一次"
    & (Join-Path $nodeDir 'npm.cmd') install --registry=https://registry.npmmirror.com
    if ($LASTEXITCODE -ne 0) { Fail "依赖装不上，检查网络"; exit 1 }
  }
}
Ok "依赖就绪"

# ── 5. 写 config.json ─────────────────────────────────────────────────────
$cfgPath = Join-Path $Root 'config.json'
$example = Join-Path $Root 'config.example.json'
if (Test-Path $cfgPath) {
  Copy-Item $cfgPath (Join-Path $Root ("config.backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".json")) -Force
  $cfg = Read-JsonFile $cfgPath
  Info "已有 config.json，在原有基础上更新（已备份）"
} else {
  $cfg = Read-JsonFile $example
  Info "从 config.example.json 生成"
}

$cfg.dsh.baseUrl = $dshBase
$cfg.snowluma.httpUrl = $httpUrl
$cfg.snowluma.wsUrl = $wsUrl
if ($Token) { $cfg.snowluma.accessToken = $Token }
if ($slHome) { $cfg.snowluma.homeDir = $slHome }
$cfg.ownerQQ = [long]$OwnerQQ
if ($Groups)   { $cfg.allow.groups  = @($Groups   -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { [long]$_ }) }
if ($Privates) { $cfg.allow.private = @($Privates -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { [long]$_ }) }
$priv = @($cfg.allow.private)
if ($priv -notcontains [long]$OwnerQQ) { $cfg.allow.private = @($priv + [long]$OwnerQQ) }

Write-JsonFile $cfgPath $cfg
Ok "已写 config.json（ownerQQ=$OwnerQQ，DSH=$dshBase）"

if ($NoStart) {
  Warn "按要求不启动。手动启动：.\start.bat"
  exit 0
}

# ── 6. 启动桥接 ───────────────────────────────────────────────────────────
$listening = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
if ($listening) { Warn "3100 已被占用（桥接可能已在运行），跳过启动" }
else {
  Start-Process -FilePath $nodeExe -ArgumentList 'src\bridge.js' -WorkingDirectory $Root -WindowStyle Hidden
  Info "已拉起 node src\bridge.js"
}

# ── 7. 健康检查 ───────────────────────────────────────────────────────────
$status = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 1500
  try {
    $hdr = @{}
    $tokFile = Join-Path $Root 'state\console-token'
    if (Test-Path $tokFile) { $hdr['X-Console-Token'] = ([IO.File]::ReadAllText($tokFile)).Trim() }
    $status = Invoke-RestMethod -Uri 'http://127.0.0.1:3100/api/status' -Headers $hdr -TimeoutSec 8
    if ($status.dshReady) { break }
  } catch { }
}
if (-not $status) {
  Fail "桥接没起来（/api/status 无响应），看 logs\ 最新日志"
  exit 1
}
$good = $status.snowluma.good
Ok "dshReady=$($status.dshReady) snowluma.good=$good mode=$($status.mode)"
if (-not $status.dshReady) {
  Fail "DSH 未就绪：确认 DSH 已登录；或检查 config.json 的 dsh.baseUrl"
  exit 1
}
if (-not $good) { Warn "QQ 未在线：到 SnowLuma 重新扫码，桥接会自动重连" }

Write-Host ""
Write-Host "装好了。接下来：" -ForegroundColor Cyan
Write-Host "  1. 用管理员 QQ（$OwnerQQ）私聊机器人发一句「你好」"
Write-Host "  2. 机器人会问要哪个人设，回 1/2/3"
Write-Host "  3. 发 /指令 看完整功能"
Write-Host ""
Write-Host "控制台：http://127.0.0.1:3100" -ForegroundColor DarkGray
