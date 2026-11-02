# 注册「网关（SnowLuma）」计划任务（0.4.131）
#
# 为什么用计划任务而不是让桥接 spawn：
#   · 网关是独立程序，由 Windows 托管 → 桥接重启不会把它带走
#   · 用户点控制台按钮 = 触发这个任务（schtasks /run），桥接不参与进程管理
#
# 用法（管理员不需要，当前用户即可）：
#   powershell -ExecutionPolicy Bypass -File scripts\install-snowluma-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-snowluma-task.ps1 -Uninstall
# 参数：
#   -Dir   SnowLuma 安装目录（默认 D:\QQBot\snowluma，或环境变量 QQB_SNOWLUMA_DIR）
#   -User  任务以哪个账户运行（默认当前用户）

#Requires -Version 5.1
param(
  [string]$Dir = '',
  [string]$User = "$env:USERDOMAIN\$env:USERNAME",
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName = 'qq-snowluma'

if ($Uninstall) {
  $existing = schtasks /query /tn $TaskName 2>$null
  if ($LASTEXITCODE -eq 0) {
    schtasks /delete /tn $TaskName /f | Out-Null
    Write-Host "[OK] 已删除计划任务 $TaskName" -ForegroundColor Green
  } else {
    Write-Host "[i] 计划任务 $TaskName 本来就不存在" -ForegroundColor DarkGray
  }
  exit 0
}

if (-not $Dir) { $Dir = if ($env:QQB_SNOWLUMA_DIR) { $env:QQB_SNOWLUMA_DIR } else { 'D:\QQBot\snowluma' } }
$nodeExe = Join-Path $Dir 'node.exe'
$entry = Join-Path $Dir 'index.mjs'

if (-not (Test-Path $nodeExe)) { Write-Host "[X] 找不到 $nodeExe（用 -Dir 指定 SnowLuma 目录）" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $entry)) { Write-Host "[X] 找不到 $entry" -ForegroundColor Red; exit 1 }

# 任务动作：node.exe index.mjs，工作目录 = 安装目录（不改工作目录会找不到 config/）
$action = "`"$nodeExe`" index.mjs"
$tr = "schtasks /create /tn `"$TaskName`" /tr `"$action`" /sc once /st 00:00 /sd 2000/01/01 /ru `"$User`" /rl LIMITED /f"
Write-Host "[i] 创建计划任务：$TaskName" -ForegroundColor Cyan
Write-Host "    $nodeExe index.mjs   (cwd=$Dir)"
cmd /c $tr | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "[X] schtasks /create 失败（code $LASTEXITCODE）" -ForegroundColor Red; exit 1 }

# schtasks 不能直接设工作目录 → 用一个 .cmd 包一层（cwd 由 cmd 的 cd /d 决定）
$wrapper = Join-Path $Dir 'run-task.cmd'
$lines = @(
  '@echo off',
  "cd /d `"$Dir`"",
  "`"$nodeExe`" index.mjs",
  ''
)
[IO.File]::WriteAllText($wrapper, ($lines -join "`r`n"), [Text.Encoding]::ASCII)

$tr2 = "schtasks /create /tn `"$TaskName`" /tr `"`"$wrapper`"`" /sc once /st 00:00 /sd 2000/01/01 /ru `"$User`" /rl LIMITED /f"
cmd /c $tr2 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "[X] 注册包装脚本任务失败（code $LASTEXITCODE）" -ForegroundColor Red; exit 1 }

# 只登记不启动（避免现在就把已经在跑的实例重复拉起）
schtasks /change /tn $TaskName /disable | Out-Null
schtasks /change /tn $TaskName /enable | Out-Null

Write-Host "[OK] 计划任务 $TaskName 已注册（启动方式：schtasks /run /tn $TaskName）" -ForegroundColor Green
Write-Host "     控制台「调试与运维 → 网关」里的按钮就是触发它" -ForegroundColor DarkGray
Write-Host "     包装脚本：$wrapper" -ForegroundColor DarkGray
