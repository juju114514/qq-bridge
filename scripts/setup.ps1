# setup.ps1 - one-stop installer for qq-bridge.
#
# Why this file exists: the manual README path has four places where normal
# people get stuck (Node 22 / DSH path / SnowLuma QR / official AppID+Secret).
# This script walks through them in order, fixes what it can, and tells you
# exactly what to do for the parts it cannot (SnowLuma is an external app).
#
# Design rules:
#   * ASCII only  -> no BOM/encoding traps on Windows PowerShell 5.1
#   * idempotent  -> safe to run again; never overwrites an existing config.json
#   * no surprises-> anything destructive is printed and skipped unless -Force
#
# Usage:
#   .\scripts\setup.ps1                 # guided
#   .\scripts\setup.ps1 -Yes            # accept defaults (CI / unattended)
#   .\scripts\setup.ps1 -SkipOfficial   # do not touch official channel
#   .\scripts\setup.ps1 -Docker         # print the Docker path instead of installing

[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$SkipOfficial,
  [switch]$Docker,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Head($msg) { Write-Host ''; Write-Host "== $msg ==" -ForegroundColor Cyan }
function Ask($prompt, $default = '') {
  if ($Yes) { return $default }
  $v = Read-Host "$prompt$(if ($default) { " [$default]" })"
  if ([string]::IsNullOrWhiteSpace($v)) { return $default }
  return $v.Trim()
}
function Confirm-Yes($prompt, $default = $true) {
  if ($Yes) { return $default }
  $hint = if ($default) { 'Y/n' } else { 'y/N' }
  $v = Read-Host "$prompt ($hint)"
  if ([string]::IsNullOrWhiteSpace($v)) { return $default }
  return $v -match '^(y|yes)$'
}

Say '' 
Say '  qq-bridge setup  (guided installer)' 'White'
Say '  ------------------------------------' 'DarkGray'

# ---------------------------------------------------------------- 0) Docker path
if ($Docker) {
  Head 'Docker path'
  Say '  Docker is the "no Node, no npm" route:'
  Say '    docker compose up -d'
  Say '  First edit config.json (or copy config.example.json) and put your allow list in it.'
  Say '  Docs: docs/guides/DOCKER.md'
  exit 0
}

# ---------------------------------------------------------------- 1) Node >= 22
Head 'Step 1/5  Node.js'
$nodeOk = $false
try {
  $v = (& node --version) 2>$null
  if ($v -match '^v(\d+)\.') {
    $major = [int]$Matches[1]
    Say "  found Node $v"
    if ($major -ge 22) { $nodeOk = $true } else { Say "  Node $major is too old (need >= 22)" 'Yellow' }
  }
} catch { Say '  node not found on PATH' 'Yellow' }

if (-not $nodeOk) {
  $tools = Join-Path $Root 'tools'
  $portable = Join-Path $tools 'node\node.exe'
  if (Test-Path $portable) {
    $env:PATH = (Join-Path $tools 'node') + ';' + $env:PATH
    Say '  using portable Node from tools\node'
    $nodeOk = $true
  } else {
    Say '  Options:' -ForegroundColor Yellow
    Say '    1. winget install OpenJS.NodeJS.LTS   (then reopen the terminal)'
    Say '    2. let this script download a portable Node into tools\node (~30 MB)'
    if (Confirm-Yes '  Download portable Node 22 now?') {
      $url = 'https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip'
      $zip = Join-Path $env:TEMP 'node-portable.zip'
      New-Item -ItemType Directory -Force -Path $tools | Out-Null
      Say "  downloading $url"
      try {
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath $tools -Force
        $inner = Get-ChildItem $tools -Directory | Where-Object { $_.Name -like 'node-v*-win-x64' } | Select-Object -First 1
        if ($inner) {
          if (Test-Path (Join-Path $tools 'node')) { Remove-Item (Join-Path $tools 'node') -Recurse -Force }
          Move-Item $inner.FullName (Join-Path $tools 'node')
        }
        $nodeOk = Test-Path $portable
        if ($nodeOk) {
          $env:PATH = (Join-Path $tools 'node') + ';' + $env:PATH
          Say '  portable Node ready (tools\node)' 'Green'
        }
      } catch {
        Say "  download failed: $($_.Exception.Message)" 'Red'
        Say '  fall back to: winget install OpenJS.NodeJS.LTS' 'Yellow'
      }
    }
  }
}

if (-not $nodeOk) {
  Say ''
  Say '  Node >= 22 is required. Install it and run setup.ps1 again.' 'Red'
  exit 1
}

# ---------------------------------------------------------------- 2) deps
Head 'Step 2/5  dependencies'
if (Test-Path (Join-Path $Root 'node_modules')) {
  Say '  node_modules already present (skip). Use -Force to reinstall.' 'DarkGray'
  if ($Force) { & npm ci --omit=dev } else { Say '  npm ci skipped' }
} else {
  Say '  running npm ci --omit=dev (a few minutes on first run)'
  & npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { Say '  npm ci failed; trying npm install' 'Yellow'; & npm install --omit=dev }
}

# ---------------------------------------------------------------- 3) config
Head 'Step 3/5  config.json'
$cfgPath = Join-Path $Root 'config.json'
$example = Join-Path $Root 'config.example.json'
if (Test-Path $cfgPath) {
  Say '  config.json exists (never overwritten)'
} else {
  Copy-Item $example $cfgPath
  Say '  created config.json from example'
}

""
$groups = Ask '  allowed QQ group numbers (comma separated, blank = whitelist empty)' ''
if ($groups) {
  $ids = $groups.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+$' }
  if ($ids.Count -gt 0) {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    if (-not $cfg.allow) { $cfg | Add-Member -NotePropertyName allow -NotePropertyValue ([pscustomobject]@{ private = @(); groups = @() }) }
    $cfg.allow.groups = @($ids)
    ($cfg | ConvertTo-Json -Depth 20) | Set-Content $cfgPath -Encoding UTF8
    Say "  allow.groups = $($ids -join ', ')" 'Green'
    Say '  (keep the group list in sync with what the bot should answer)'
  }
} else {
  Say '  skipped (edit config.json -> allow.groups later; empty whitelist = answers nobody)' 'DarkGray'
}

# ---------------------------------------------------------------- 4) official channel
Head 'Step 4/5  official QQ bot (optional)'
if ($SkipOfficial) {
  Say '  skipped (-SkipOfficial)'
} else {
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  $already = ($cfg.official -and $cfg.official.appid -and $cfg.official.secret)
  if ($already) {
    Say '  already configured (config.official.appid present)'
  } elseif (Confirm-Yes '  Do you have a QQ official bot AppID + AppSecret (q.qq.com)?' $false) {
    $appid = Ask '  AppID' ''
    $secret = Ask '  AppSecret' ''
    if ($appid -and $secret) {
      Say '  verifying against bots.qq.com ...'
      try {
        $body = @{ appId = $appid; clientSecret = $secret } | ConvertTo-Json -Compress
        $resp = Invoke-RestMethod -Method Post -Uri 'https://bots.qq.com/app/getAppAccessToken' `
          -ContentType 'application/json' -Body $body -TimeoutSec 20
        if ($resp.access_token) {
          Say '  credentials OK (access_token received)' 'Green'
          $cfg.official.enabled = $true
          $cfg.official.appid = $appid
          $cfg.official.secret = $secret
          ($cfg | ConvertTo-Json -Depth 20) | Set-Content $cfgPath -Encoding UTF8
          Say '  written to config.json (official.enabled=true)'
          Say '  next: put your group id into official.allow (run the bot once, it logs the openid)'
        } else {
          Say '  unexpected response; not saved' 'Yellow'
        }
      } catch {
        Say "  verification failed: $($_.Exception.Message)" 'Red'
        Say '  common causes: typo in secret, app id mismatch, or the bot is not published yet' 'Yellow'
        Say '  credentials were NOT written; fix them and re-run, or edit config.json by hand'
      }
    }
  } else {
    Say '  skipped (you can add config.official later, or run setup.ps1 again)' 'DarkGray'
  }
}

# ---------------------------------------------------------------- 5) SnowLuma
Head 'Step 5/5  SnowLuma (personal QQ channel)'
$snow = $null
foreach ($p in 5099, 3000, 3001) {
  try {
    $c = Test-NetConnection -ComputerName 127.0.0.1 -Port $p -InformationLevel Quiet -WarningAction SilentlyContinue
  } catch { $c = $false }
  if (-not $c) {
    try { $c = (Test-Connection -ComputerName 127.0.0.1 -Count 1 -Quiet) -and $false } catch { }
  }
  if ($c) { $snow = $p; break }
}
if ($snow) {
  Say "  SnowLuma detected on port $snow" 'Green'
  if ($snow -eq 5099) {
    Say '  opening the QR page: http://127.0.0.1:5099'
    Start-Process 'http://127.0.0.1:5099'
    Say '  scan the QR with your QQ account, then come back here'
  }
} else {
  Say '  SnowLuma is not running (it is a separate app, this repo does not install it)' 'Yellow'
  Say '  download: https://github.com/SnowLuma/SnowLuma  (or whatever release you use)'
  Say '  after it starts: open http://127.0.0.1:5099 and scan the QR'
}

# ---------------------------------------------------------------- done
Head 'Done - health check'
& node (Join-Path $Root 'src\doctor.js')
$rc = $LASTEXITCODE

Write-Host ''
Say '  next steps:' 'White'
Say '    1. edit config.json  -> allow.groups / allow.private / persona'
Say '    2. start the bridge -> node src\bridge.js   (or scripts\start.ps1 if present)'
Say '    3. open the console -> http://127.0.0.1:3100 (token in state\console-token)'
Write-Host ''
if ($rc -ne 0) { Say '  doctor reported blocking problems (see marks above)' 'Yellow' }
exit $rc
