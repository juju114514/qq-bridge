# 创建桌面 / 开始菜单快捷方式（0.4.83）
#
# 为什么需要：每次找启动器/控制台要点进仓库目录，很麻烦。
# 这个脚本把两个入口放到桌面（可选开始菜单）：
#   · 「QQ 桥接控制台」→ http://127.0.0.1:<consolePort>/
#   · 「QQ 桥接启动器」→ 仓库根的 启动器.cmd
#
# 用法：
#   powershell -File scripts\make-shortcut.ps1              # 桌面 + 开始菜单
#   powershell -File scripts\make-shortcut.ps1 -NoStartMenu  # 只桌面
#   powershell -File scripts\make-shortcut.ps1 -Remove       # 删除这两个快捷方式

[CmdletBinding()]
param(
  [switch]$NoDesktop,
  [switch]$NoStartMenu,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'QQ 桥接'

$consolePort = 3100
$cfgPath = Join-Path $root 'config.json'
if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.consolePort) { $consolePort = [int]$cfg.consolePort }
  } catch { /* 配置坏了就用默认端口 */ }
}

# 优先「排错程序.exe」（GUI，12 个按钮）；没有才退回命令行版
$launcher = Join-Path $root '排错程序.exe'
if (-not (Test-Path $launcher)) { $launcher = Join-Path $root '启动器.exe' }
if (-not (Test-Path $launcher)) { $launcher = Join-Path $root '启动器.cmd' }
if (-not (Test-Path $launcher)) { $launcher = Join-Path $root 'scripts\launcher.mjs' }
$url = "http://127.0.0.1:$consolePort/"

function New-Lnk([string]$path, [string]$target, [string]$args = '', [string]$icon = '', [string]$desc = '') {
  $dir = Split-Path -Parent $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($path)
  $lnk.TargetPath = $target
  if ($args) { $lnk.Arguments = $args }
  $lnk.WorkingDirectory = $root
  if ($icon) { $lnk.IconLocation = $icon }
  if ($desc) { $lnk.Description = $desc }
  $lnk.WindowStyle = 7  # 最小化启动，别一开就挡屏幕
  $lnk.Save()
  Write-Output ("  已创建：" + $path)
}

function Remove-Lnk([string]$path) {
  if (Test-Path $path) { Remove-Item $path -Force; Write-Output ("  已删除：" + $path) }
}

$targets = @()
if (-not $NoDesktop) {
  $targets += [pscustomobject]@{ Name = 'QQ 桥接控制台.lnk'; Url = $true;  Path = Join-Path $desktop 'QQ 桥接控制台.lnk' }
  $targets += [pscustomobject]@{ Name = 'QQ 桥接排错程序.lnk'; Url = $false; Path = Join-Path $desktop 'QQ 桥接排错程序.lnk' }
}
if (-not $NoStartMenu) {
  $targets += [pscustomobject]@{ Name = 'QQ 桥接控制台.lnk'; Url = $true;  Path = Join-Path $startMenu 'QQ 桥接控制台.lnk' }
  $targets += [pscustomobject]@{ Name = 'QQ 桥接排错程序.lnk'; Url = $false; Path = Join-Path $startMenu 'QQ 桥接排错程序.lnk' }
}

Write-Output "仓库：$root"
Write-Output "控制台：$url"

if ($Remove) {
  foreach ($t in $targets) { Remove-Lnk $t.Path }
  exit 0
}

foreach ($t in $targets) {
  if ($t.Url) {
    New-Lnk -path $t.Path -target $url -desc '打开 QQ 桥接控制台（工作台）'
  } else {
    New-Lnk -path $t.Path -target $launcher -desc '排错程序：体检 / 日志 / 自检 / 更新'
  }
}

Write-Output ''
Write-Output '完成。桌面上现在有「QQ 桥接控制台」和「QQ 桥接启动器」两个图标。'
Write-Output '不想要了：powershell -File scripts\make-shortcut.ps1 -Remove'
