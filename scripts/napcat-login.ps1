# napcat-login.ps1 —— 一键拉起 NapCat 登录，并把二维码放大成可扫的图
#
# 为什么要这个脚本：
#   NapCat 缓存的 cache\qrcode.png 只有 147x147，手机基本扫不动；
#   WebUI 里的高清二维码是 canvas 动态渲染的，抓不出来。
#   这里把缓存图用最近邻放大 4 倍（QR 是纯色块，放大不失真），存到 qr\ 目录并打开。
#
# 用法：
#   .\scripts\napcat-login.ps1 -Qq 123456789
#   .\scripts\napcat-login.ps1 -Qq 123456789 -NapCatDir D:\QQBot\tools\napcat

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Qq,
  [string]$NapCatDir = 'D:\QQBot\tools\napcat',
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'qr' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$launcher = Join-Path $NapCatDir 'napcat\launcher-win10.bat'
if (-not (Test-Path $launcher)) { $launcher = Join-Path $NapCatDir 'napcat\launcher-user.bat' }
if (-not (Test-Path $launcher)) { throw "找不到 NapCat 启动器（$NapCatDir）" }

$qr = Join-Path $NapCatDir 'napcat\cache\qrcode.png'
Remove-Item $qr -Force -ErrorAction SilentlyContinue

Write-Host "启动 NapCat（QQ=$Qq）…" -ForegroundColor Cyan
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$launcher`" -q $Qq" -WorkingDirectory (Split-Path $launcher)

# 等二维码出现（最多 40 秒）
$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 800
  if (Test-Path $qr) { break }
}
if (-not (Test-Path $qr)) { throw '二维码没等到：请检查 NapCat 窗口里有没有报错' }

# 放大 4 倍（最近邻，QR 放大不失真）
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($qr)
$size = $img.Width * 4
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$g.DrawImage($img, 0, 0, $size, $size)
$out = Join-Path $OutDir ("napcat-qr-{0}.png" -f (Get-Date -Format 'HHmmss'))
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $img.Dispose()

Write-Host "二维码已放大到 ${size}x${size}：$out" -ForegroundColor Green
Write-Host "用手机 QQ 扫这个文件（有效期约 2 分钟，过期重跑本脚本）"
Start-Process $out