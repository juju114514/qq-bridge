# t2i 侧车启动器（0.4.119）—— 纯 ASCII，避免 PowerShell 编码问题
# 用途：在用户会话里常驻一个 headless Edge，桥接通过 CDP(:9222) 连它截图。
# 为什么不用 cmd 的 start：在某些父进程下会卡住/不分离。

param(
  [int]$Port = 9222,
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Continue'

$pf86 = ${env:ProgramFiles(x86)}
$pf = $env:ProgramFiles
$lf = $env:LOCALAPPDATA
$candidates = @(
  (Join-Path $pf86 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $pf 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $pf 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $pf86 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $lf 'Google\Chrome\Application\chrome.exe')
)
$edge = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $edge) {
  Write-Output '[t2i] Edge/Chrome not found; sidecar not started'
  exit 1
}

$profileDir = Join-Path $Root 'state\t2i-sidecar-profile'
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null

# 已经在跑就不重复起
try {
  $v = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
  if ($v.Browser) { Write-Output "[t2i] sidecar already running: $($v.Browser)"; exit 0 }
} catch { }

$args = @(
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--hide-scrollbars',
  "--remote-debugging-port=$Port",
  '--remote-allow-origins=*',
  "--user-data-dir=$profileDir",
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-component-update',
  'about:blank'
)

$p = Start-Process -FilePath $edge -ArgumentList $args -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
try {
  $v = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 5
  Write-Output "[t2i] sidecar started (pid=$($p.Id)): $($v.Browser)"
} catch {
  Write-Output "[t2i] sidecar launch failed: $($_.Exception.Message)"
  exit 1
}
