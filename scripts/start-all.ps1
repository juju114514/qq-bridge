# start-all.ps1 —— 一条命令把机器人拉起来（自动识别用哪个网关）
#
# 为什么需要它：
#   SnowLuma（主）与 NapCat（备）都占 3000/3001。以前要人工判断"现在该用谁、
#   token 是多少、QQ 客户端有没有抢登录"。这个脚本把判断做完，只留一个入口。
#
# 识别顺序（auto）：
#   1) 用 config.json 里的 SnowLuma token 探 3000
#   2) 用 NapCat 的 onebot11_*.json token 探 3000
#   3) 都不通 → 启动 SnowLuma 并等 40 秒
#   4) 还不通 → 启动 NapCat（会先退出 QQ 客户端，因为两者不能同时登录）
#   5) 按实际可用的网关**改写 live config 的 token**，再启动桥接
#
# 用法：
#   .\scripts\start-all.ps1                 # 自动
#   .\scripts\start-all.ps1 -Preferred snowluma
#   .\scripts\start-all.ps1 -Preferred napcat -Qq 123456789
#   .\scripts\start-all.ps1 -StatusOnly     # 只打印状态，不启动任何东西

[CmdletBinding()]
param(
  [ValidateSet('auto','snowluma','napcat')][string]$Preferred = 'auto',
  [string]$Qq = '',
  [switch]$StatusOnly,
  [int]$WaitSec = 40
)

$ErrorActionPreference = 'Stop'
$Repo   = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Live   = 'D:\deepseek工作区\qq-bridge'
if (-not (Test-Path (Join-Path $Live 'config.json'))) { $Live = $Repo }

function Get-Cfg { param($p) try { Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null } }

function Test-OneBot {
  param([string]$Token, [int]$Port = 3000)
  if (-not $Token) { return $false }
  try {
    $body = '{"action":"get_login_info","params":{}}'
    $r = Invoke-RestMethod "http://127.0.0.1:$Port/get_login_info" -Method Post `
      -Headers @{ Authorization = "Bearer $Token" } `
      -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 5
    return ($r.status -eq 'ok')
  } catch { return $false }
}

function Get-SnowLumaToken {
  # 注意：SnowLuma 每个账号一个 onebot_<QQ>.json，**别的账号那份可能是空 networks**。
  # 之前按"第一个有 networks 的文件"取值，结果拿到空 token → 桥接 401/1006。
  # 现在只认 httpServers 与 wsServers 都非空、且 token 也非空的配置。
  $files = Get-ChildItem 'D:\QQBot\snowluma\config\onebot_*.json' -EA SilentlyContinue |
    Where-Object { $_.Name -notlike '*.bak*' }
  foreach ($f in $files) {
    $j = Get-Cfg $f.FullName
    $hs = @($j.networks.httpServers) | Where-Object { $_ }
    $ws = @($j.networks.wsServers) | Where-Object { $_ }
    if ($hs.Count -gt 0 -and $ws.Count -gt 0 -and $hs[0].accessToken -and $ws[0].accessToken) {
      return $hs[0].accessToken
    }
  }
  return ''
}

function Get-NapCatToken {
  $files = Get-ChildItem 'D:\QQBot\tools\napcat\napcat\config\onebot11_*.json' -EA SilentlyContinue
  foreach ($f in $files) {
    $j = Get-Cfg $f.FullName
    if ($j.networks.httpServers) { return $j.networks.httpServers[0].accessToken }
  }
  return ''
}

$slToken = Get-SnowLumaToken
$ncToken = Get-NapCatToken
$slOk = Test-OneBot -Token $slToken
$ncOk = Test-OneBot -Token $ncToken

function Show-Status {
  Write-Host "`n  qq-bridge 启动状态" -ForegroundColor Cyan
  $bridge = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'src\\bridge\.js' } | Select-Object -First 1
  $ports = (Get-NetTCPConnection -State Listen -EA SilentlyContinue |
    Where-Object { $_.LocalPort -in 3000,3001,3100,5099 } | ForEach-Object { $_.LocalPort } | Sort-Object) -join ', '
  Write-Host ("    端口监听      {0}" -f ($(if ($ports) { $ports } else { '无' })))
  Write-Host ("    桥接进程      {0}" -f ($(if ($bridge) { "pid=$($bridge.ProcessId)" } else { '未运行' }))) -ForegroundColor $(if ($bridge) { 'Green' } else { 'Yellow' })
  Write-Host ("    SnowLuma      {0}" -f ($(if ($slOk) { '已就绪（3000 可用）' } else { '未就绪' }))) -ForegroundColor $(if ($slOk) { 'Green' } else { 'Yellow' })
  Write-Host ("    NapCat        {0}" -f ($(if ($ncOk) { '已就绪（3000 可用）' } else { '未就绪/未启动' }))) -ForegroundColor $(if ($ncOk) { 'Green' } else { 'Yellow' })
  Write-Host ''
}

if ($StatusOnly) { Show-Status; exit 0 }

$gateway = $null
if ($slOk -and $Preferred -ne 'napcat') { $gateway = 'snowluma' }
elseif ($ncOk -and $Preferred -ne 'snowluma') { $gateway = 'napcat' }

# ── 都没就绪：按优先级尝试拉起 ─────────────────────────────────────────────
if (-not $gateway) {
  if ($Preferred -ne 'napcat') {
    Write-Host '  SnowLuma 未就绪 → 尝试启动（需要账号已登录；未登录则要你在 5099 里注入 QQ）' -ForegroundColor Yellow
    if (Test-Path 'D:\QQBot\snowluma\launcher.bat') {
      Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','launcher.bat' -WorkingDirectory 'D:\QQBot\snowluma' -WindowStyle Normal
      for ($i = 0; $i -lt [Math]::Max(1, [int]($WaitSec / 3)); $i++) {
        Start-Sleep -Seconds 3
        if (Test-OneBot -Token $slToken) { $gateway = 'snowluma'; break }
      }
      if (-not $gateway) { Write-Host '  SnowLuma 起了但 OneBot 未就绪（多半是账号没登录/没注入 QQ）' -ForegroundColor Yellow }
    }
  }

  if (-not $gateway) {
    Write-Host '  改用 NapCat 备选（会先退出 QQ 客户端：两者不能同时登录）' -ForegroundColor Yellow
    $argList = @('-NoProfile','-ExecutionPolicy','Bypass','-File', (Join-Path $Repo 'scripts\start-napcat.ps1'))
    if ($Qq) { $argList += @('-Qq', $Qq) }
    & powershell.exe @argList 2>&1 | ForEach-Object { "    $_" }
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Seconds 3
      if (Test-OneBot -Token $ncToken) { $gateway = 'napcat'; break }
    }
  }
}

if (-not $gateway) {
  Write-Host "`n  ✗ 两个网关都没起来。下一步：" -ForegroundColor Red
  Write-Host '    · SnowLuma：打开 http://127.0.0.1:5099 → 进程注入 → 加载 QQ' -ForegroundColor Yellow
  Write-Host '    · 或直接跑： .\scripts\start-napcat.ps1 -Qq <机器人QQ>' -ForegroundColor Yellow
  Show-Status
  exit 4
}

Write-Host "`n  使用网关：$gateway" -ForegroundColor Green

# ── 按实际网关改写 live config 的 token（否则桥接会 401/1006）────────────────
$cfgPath = Join-Path $Live 'config.json'
$cfg = Get-Cfg $cfgPath
if ($cfg) {
  if ($gateway -eq 'snowluma') {
    $files = Get-ChildItem 'D:\QQBot\snowluma\config\onebot_*.json' | Where-Object { $_.Name -notlike '*.bak*' }
    foreach ($f in $files) {
      $j = Get-Cfg $f.FullName
      $hs = @($j.networks.httpServers) | Where-Object { $_ }
      $ws = @($j.networks.wsServers) | Where-Object { $_ }
      if ($hs.Count -gt 0 -and $ws.Count -gt 0 -and $hs[0].accessToken -and $ws[0].accessToken) {
        $cfg.snowluma.accessToken = $ws[0].accessToken
        $cfg.snowluma.httpToken   = $hs[0].accessToken
        break
      }
    }
  } else {
    # NapCat 的 HTTP 与 WS 用同一个 token
    $cfg.snowluma.accessToken = $ncToken
    $cfg.snowluma.httpToken   = $ncToken
  }
  ($cfg | ConvertTo-Json -Depth 32) | Set-Content $cfgPath -Encoding UTF8
  Write-Host "  已同步 $gateway 的 token 到 config.json" -ForegroundColor Green
}

# ── 启动桥接 ───────────────────────────────────────────────────────────────
$startScript = Join-Path $Live 'start-bridge.ps1'
if (Test-Path $startScript) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript -Hidden 2>&1 |
    Select-Object -Last 6 | ForEach-Object { "  $_" }
}

Start-Sleep -Seconds 5
Show-Status
Write-Host '  提示：控制台 http://127.0.0.1:3100（令牌在 state\console-token）' -ForegroundColor Gray