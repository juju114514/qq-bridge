# 把仓库里的 room-pet 代码同步到「跑起来的那一份」
#
# 为什么需要：仓库里只有代码（素材太大、也有版权），实际运行的那份在自己机器上，
# 还带着 assets/ 和抓下来的 douyin/ 数据。两份并存就容易「改了仓库、跑的还是旧的」。
# 这个脚本只做一件事：仓库 → 运行目录，单向覆盖代码文件；不动素材、不删运行目录里的东西。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\scripts\sync-room-pet.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\sync-room-pet.ps1 -To "<运行目录>"
#   powershell -ExecutionPolicy Bypass -File .\scripts\sync-room-pet.ps1 -DryRun
#
# 退出码：0 = 同步成功（或无需同步）；1 = 目标目录不存在

param(
  [string]$To = $env:ROOM_PET_RUNTIME,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'room-pet'

if (-not $To) {
  Write-Host "[错误] 没指定运行目录：用 -To 或设环境变量 ROOM_PET_RUNTIME" -ForegroundColor Red
  Write-Host "       例：`$env:ROOM_PET_RUNTIME='<运行目录>'; .\scripts\sync-room-pet.ps1" -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path $To)) {
  Write-Host "[错误] 运行目录不存在：$To" -ForegroundColor Red
  Write-Host "       用 -To 指定，或设环境变量 ROOM_PET_RUNTIME" -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path $src)) {
  Write-Host "[错误] 仓库里没有 room-pet/ 目录：$src" -ForegroundColor Red
  exit 1
}

# 只同步代码/文档；素材与运行时数据永远不动
$patterns = @('*.py', '*.js', '*.html', '*.css', '*.md', '*.txt', '*.bat', '*.ps1')
$skipNames = @('README.md')   # 运行目录有自己的 README（深夜书房），别覆盖
$copied = @()
$same = 0

foreach ($p in $patterns) {
  Get-ChildItem $src -Filter $p -File -ErrorAction SilentlyContinue | ForEach-Object {
    if ($skipNames -contains $_.Name) { return }
    $target = Join-Path $To $_.Name
    $needCopy = $true
    if (Test-Path $target) {
      $a = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
      $b = (Get-FileHash $target -Algorithm SHA256).Hash
      if ($a -eq $b) { $needCopy = $false; $script:same++ }
    }
    if ($needCopy) {
      if (-not $DryRun) { Copy-Item $_.FullName $target -Force }
      $copied += $_.Name
    }
  }
}

Write-Host ""
Write-Host "仓库: $src"
Write-Host "运行: $To"
Write-Host ("改动 {0} 个，未变 {1} 个{2}" -f $copied.Count, $same, $(if ($DryRun) { "（DryRun：未写盘）" } else { "" }))
foreach ($n in $copied) { Write-Host ("  -> " + $n) }
if ($copied.Count -eq 0) { Write-Host "  已是最新，无需同步" }
