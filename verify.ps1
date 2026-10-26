#Requires -Version 5.1
<#
.SYNOPSIS
  qq-bridge 体检脚本：随时检查运行环境是否正常（只读，不改任何东西）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\verify.ps1

.EXAMPLE
  # 自动重启桥接（如果它没在跑）
  .\verify.ps1 -Restart

.NOTES
  退出码：0 = 全部通过；1 = 有致命问题（桥接跑不起来）；
  2 = 能跑但有警告（例如 QQ 掉线）。
#>
param(
  [switch]$Restart,
  [string]$DshUrl = ""
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$fails = 0
$warns = 0

function Line([string]$level, [string]$name, [string]$detail) {
  switch ($level) {
    'OK'   { Write-Host ("  [OK]   {0,-22} {1}" -f $name, $detail) -ForegroundColor Green }
    'WARN' { Write-Host ("  [WARN] {0,-22} {1}" -f $name, $detail) -ForegroundColor Yellow; $script:warns++ }
    'FAIL' { Write-Host ("  [FAIL] {0,-22} {1}" -f $name, $detail) -ForegroundColor Red;    $script:fails++ }
  }
}

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

Write-Host ""
Write-Host "qq-bridge 体检" -ForegroundColor Cyan
Write-Host ("  目录: {0}" -f $Root) -ForegroundColor DarkGray
Write-Host ("  时间: {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor DarkGray
Write-Host ""

# ── 1. Node ────────────────────────────────────────────────────────────────
$nodeExe = $null
$c = Get-Command node -ErrorAction SilentlyContinue
if ($c) { $nodeExe = $c.Source }
else {
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if ($p -and (Test-Path $p)) { $nodeExe = $p; break }
  }
  if (-not $nodeExe) {
    $n = Get-ChildItem (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes') -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match 'node[\\/]bin[\\/]node\.exe$' } | Select-Object -First 1
    if ($n) { $nodeExe = $n.FullName }
  }
}
if (-not $nodeExe) {
  Line FAIL 'Node' '找不到 node（请装 Node 22 LTS）'
} else {
  $env:PATH = (Split-Path -Parent $nodeExe) + ';' + $env:PATH
  $v = (& $nodeExe --version 2>$null).Trim()
  $maj = [int]($v.TrimStart('v').Split('.')[0]); $min = [int]($v.TrimStart('v').Split('.')[1])
  if ($maj -lt 22 -or ($maj -eq 22 -and $min -lt 13)) { Line FAIL 'Node' "$v（需要 >= 22.13.0）" }
  else { Line OK 'Node' "$v" }
}

# ── 2. 依赖 ────────────────────────────────────────────────────────────────
$sdk = Join-Path $Root 'node_modules\@snowluma\sdk'
if (Test-Path $sdk) { Line OK '依赖' 'node_modules/@snowluma/sdk 存在' }
else { Line FAIL '依赖' '缺 node_modules，先跑 npm install 或 install.ps1' }

# ── 3. config.json ─────────────────────────────────────────────────────────
$cfgPath = Join-Path $Root 'config.json'
$cfg = $null
if (-not (Test-Path $cfgPath)) {
  Line FAIL 'config.json' '不存在（先跑 install.ps1 或复制 config.example.json）'
} else {
  try {
    $cfg = Read-JsonFile $cfgPath
    Line OK 'config.json' ("可解析，{0} 字节" -f (Get-Item $cfgPath).Length)
  } catch {
    Line FAIL 'config.json' ("JSON 解析失败：{0}" -f $_.Exception.Message)
  }
}

if ($cfg) {
  # ownerQQ
  if ($cfg.ownerQQ) { Line OK 'ownerQQ' ([string]$cfg.ownerQQ) }
  else { Line FAIL 'ownerQQ' '未设置（管理命令全不可用）' }

  # DSH 地址
  $dshBase = if ($DshUrl) { $DshUrl } else { [string]$cfg.dsh.baseUrl }
  if (-not $dshBase) { Line FAIL 'DSH 地址' 'config.json 里 dsh.baseUrl 为空' }
  elseif ($dshBase -notmatch ':(\d+)$') { Line FAIL 'DSH 地址' "格式不对：$dshBase" }
  else {
    $p = [int]$Matches[1]
    if (Test-Port $p) { Line OK 'DSH 端口' "$p 可达（$dshBase）" }
    else { Line FAIL 'DSH 端口' "$p 不通（DSH 没开或端口变了）" }
  }

  # SnowLuma
  $wsPort = 3001; $httpPort = 3000
  if ($cfg.snowluma.wsUrl -match ':(\d+)') { $wsPort = [int]$Matches[1] }
  if ($cfg.snowluma.httpUrl -match ':(\d+)') { $httpPort = [int]$Matches[1] }
  $okWs = Test-Port $wsPort; $okHttp = Test-Port $httpPort
  if ($okWs -and $okHttp) { Line OK 'SnowLuma' "$httpPort / $wsPort 都可达" }
  elseif ($okHttp) { Line WARN 'SnowLuma' "$wsPort 不通，只能 HTTP（收消息会断）" }
  elseif ($okWs) { Line WARN 'SnowLuma' "$httpPort 不通，只能 WS（发消息会失败）" }
  else { Line FAIL 'SnowLuma' "$httpPort / $wsPort 都不通（SnowLuma 没开）" }

  if ($cfg.snowluma.accessToken) { Line OK 'OneBot token' ("已配置（{0}…）" -f $cfg.snowluma.accessToken.Substring(0, [Math]::Min(4, $cfg.snowluma.accessToken.Length))) }
  else { Line WARN 'OneBot token' '为空（桥接会尝试自愈）' }

  if ($cfg.snowluma.homeDir -and (Test-Path $cfg.snowluma.homeDir)) {
    Line OK 'SnowLuma 目录' $cfg.snowluma.homeDir
  } elseif ($cfg.snowluma.homeDir) {
    Line WARN 'SnowLuma 目录' ("配置了但不存在：{0}" -f $cfg.snowluma.homeDir)
  } else {
    Line WARN 'SnowLuma 目录' '未配置（能跑，但 token 自愈会弱一些）'
  }

  # 白名单
  $np = @($cfg.allow.private).Count
  $ng = @($cfg.allow.groups).Count
  if ($np + $ng -eq 0 -and -not $cfg.allowAllWhenEmpty) {
    Line WARN '白名单' '私聊/群都为空 → 谁都不能触发（除非 allowAllWhenEmpty=true）'
  } else {
    Line OK '白名单' ("私聊 {0} 个，群 {1} 个" -f $np, $ng)
  }
}

# ── 4. 角色卡 ──────────────────────────────────────────────────────────────
$rolesDir = Join-Path $Root 'roles'
if (Test-Path $rolesDir) {
  $n = @(Get-ChildItem $rolesDir -Filter '*.md' -File | Where-Object { $_.Name -ne 'README.md' }).Count
  if ($n -gt 0) { Line OK '角色卡' "$n 张" } else { Line WARN '角色卡' '0 张（只能按默认人格说话）' }
} else { Line WARN '角色卡' 'roles/ 目录不存在' }

# ── 5. 桥接进程与状态 ──────────────────────────────────────────────────────
$port = if ($cfg) { [int]$cfg.consolePort } else { 3100 }
if (-not $port) { $port = 3100 }
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue

if (-not $listening) {
  Line FAIL '桥接进程' "$port 端口没在监听"
  if ($Restart -and $nodeExe) {
    Write-Host "  → 正在重启桥接…" -ForegroundColor Yellow
    Start-Process -FilePath $nodeExe -ArgumentList 'src\bridge.js' -WorkingDirectory $Root -WindowStyle Hidden
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 1500
      if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { break }
    }
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { Line OK '桥接进程' '已重启' }
    else { Line FAIL '桥接进程' '重启失败，看 logs/ 日志' }
  } else {
    Write-Host "  → 启动：.\\start.bat   或用 .\\verify.ps1 -Restart" -ForegroundColor DarkGray
  }
} else {
  $pid2 = ($listening | Select-Object -First 1).OwningProcess
  Line OK '桥接进程' "监听 $port（PID $pid2）"
}

# ── 6. /api/status ─────────────────────────────────────────────────────────
try {
  $hdr = @{}
  $tokFile = Join-Path $Root 'state\console-token'
  if (Test-Path $tokFile) { $hdr['X-Console-Token'] = ([IO.File]::ReadAllText($tokFile)).Trim() }
  $st = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/status" -Headers $hdr -TimeoutSec 10
  if ($st.dshReady) { Line OK 'DSH 就绪' ("mode=$($st.mode)") }
  else { Line FAIL 'DSH 就绪' 'dshReady=false（DSH 未登录或地址不对）' }

  if ($st.snowluma.good) { Line OK 'QQ 在线' 'snowluma.good=true' }
  else { Line FAIL 'QQ 在线' 'snowluma.good=false（到 SnowLuma 重新扫码）' }

  if ($st.socialV2 -and $st.socialV2.paused) { Line WARN 'AI 暂停' 'socialV2.paused=true（AI 不会回话）' }
  else { Line OK 'AI 暂停' '未暂停' }
} catch {
  $code = $null
  try { $code = [int]$_.Exception.Response.StatusCode } catch { }
  if ($code -eq 401) {
    Line WARN '状态接口' '返回 401：桥接在线，但本目录的 console-token 与该实例不匹配（可能不是同一份安装）'
  } else {
    Line FAIL '状态接口' ("/api/status 请求失败：{0}" -f $_.Exception.Message)
  }
}

# ── 7. 日志可写 ────────────────────────────────────────────────────────────
$logsDir = Join-Path $Root 'logs'
try {
  if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }
  $probe = Join-Path $logsDir ('.verify-' + [guid]::NewGuid().ToString('N') + '.tmp')
  [IO.File]::WriteAllText($probe, 'ok')
  Remove-Item $probe -Force
  Line OK '日志目录' '可写'
} catch {
  Line WARN '日志目录' '不可写（检查权限/磁盘）'
}

# ── 汇总 ───────────────────────────────────────────────────────────────────
Write-Host ""
if ($fails -eq 0 -and $warns -eq 0) { Write-Host "全部通过。" -ForegroundColor Green; exit 0 }
if ($fails -eq 0) { Write-Host "可用，但有 $warns 项警告。" -ForegroundColor Yellow; exit 2 }
Write-Host "有 $fails 项致命问题，$warns 项警告。" -ForegroundColor Red
exit 1
