# start-napcat.ps1 —— 备选个人号网关（NapCat），SnowLuma 不可用时用这个
#
# 为什么单独一个脚本：
#   SnowLuma 偶尔连不上、或想换实现时，用 NapCat（同为 OneBot v11）。
#   两者**不能同时登录同一个 QQ**，所以这里会先检查端口占用再启动。
#
# 用法：
#   .\scripts\start-napcat.ps1                 # 用默认目录
#   .\scripts\start-napcat.ps1 -Qq 123456789   # 顺带快速登录（会先彻底退出 QQ）
#
# 启动后桥接的 config.json 需要指向：http://127.0.0.1:3000 / ws://127.0.0.1:3001

[CmdletBinding()]
param(
  [string]$Qq = '',
  [string]$NapCatDir = 'D:\QQBot\tools\napcat',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$launcher = Join-Path $NapCatDir 'napcat\launcher-win10.bat'
if (-not (Test-Path $launcher)) { $launcher = Join-Path $NapCatDir 'napcat\launcher-user.bat' }
if (-not (Test-Path $launcher)) { throw "找不到 NapCat：$NapCatDir（先下载解压到 tools\napcat）" }

# 1) 端口占用检查：3000/3001 已被占用说明 OneBot 已就绪
$busy = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 3000, 3001 } | Select-Object -First 1
if ($busy -and -not $Force) {
  Write-Host "NapCat 似乎已在运行（端口 $($busy.LocalPort) 被占用）。要重启请加 -Force" -ForegroundColor Yellow
  exit 0
}

# 2) 带 -q 时先彻底退出 QQ（NapCat 与 QQ 客户端不能同时登录）
if ($Qq) {
  Write-Host "彻底退出 QQ（含 QQProtect）…" -ForegroundColor Cyan
  foreach ($n in 'QQ', 'QQProtect', 'TXPlatform') {
    Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

# 3) 启动
Write-Host "启动 NapCat…" -ForegroundColor Cyan
if ($Qq) { Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$launcher`" -q $Qq" -WorkingDirectory (Split-Path $launcher) }
else     { Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$launcher`""        -WorkingDirectory (Split-Path $launcher) }

# 4) 等 OneBot 起来（最多 90 秒）
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $ls = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in 3000, 3001 } | ForEach-Object { $_.LocalPort }
  if ($ls) {
    Write-Host "OneBot 已就绪：$($ls -join ', ')（桥接 config 指向 3000/3001）" -ForegroundColor Green
    exit 0
  }
}

Write-Host "等了 90 秒还没起来：看 NapCat 窗口里的提示（多半需要扫码）" -ForegroundColor Yellow
Write-Host "扫码图：$NapCatDir\napcat\cache\qrcode.png（很小，可用 scripts\napcat-login.ps1 放大）"
exit 1
