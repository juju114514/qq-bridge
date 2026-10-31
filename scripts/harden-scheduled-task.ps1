# 计划任务硬化：消除「窗口自动关闭又弹出」的根因（0.4.42）
#
# 根因（2026-10-31 实测）：
#   qq-bridge 任务带 RestartOnFailure=PT1M × 999，且**没有隐藏窗口**。
#   于是任何一次任务实例结束（手动 /end、node 退出、PowerShell 报错）都会在 1 分钟后
#   重新拉起一个**可见的** PowerShell 窗口，并把完整启动日志再打一遍。
#
# 本脚本做四件事（可重复执行）：
#   1. 关掉 RestartOnFailure（脚本里已有 5 秒守护循环，任务级重启是重复兜底）
#   2. 参数加 -WindowStyle Hidden（看不见窗口，日志照写）
#   3. MultipleInstances=IgnoreNew（杜绝两个实例抢 3100）
#   4. ExecutionTimeLimit 设为 0（常驻任务不该被 3 天超时杀掉）
#
# 用法（管理员）：powershell -ExecutionPolicy Bypass -File scripts\harden-scheduled-task.ps1 -Apply
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$taskName = 'qq-bridge'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$script = Join-Path $root 'scripts\run-bridge.ps1'
if (-not (Test-Path $script)) { throw "找不到 run-bridge.ps1：$script" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`"" `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 0
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest

if ($Apply) {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-Output "已重写计划任务 $taskName：RestartCount=0 / Hidden / IgnoreNew / 无超时"
  $t = Get-ScheduledTask -TaskName $taskName
  $x = [xml](Export-ScheduledTask -TaskName $taskName)
  Write-Output ("  参数: " + $x.Task.Actions.Exec.Arguments)
  Write-Output ("  RestartOnFailure: " + $(if ($x.Task.Settings.RestartOnFailure) { "$($x.Task.Settings.RestartOnFailure.Interval) x $($x.Task.Settings.RestartOnFailure.Count)" } else { '（无）' }))
  Write-Output ("  MultipleInstances: " + $x.Task.Settings.MultipleInstances)
  Write-Output ("  ExecutionTimeLimit: " + $x.Task.Settings.ExecutionTimeLimit)
} else {
  Write-Output "演练模式（未改动）。加 -Apply 才会重写任务。"
  Write-Output ("  将设置: 参数=" + "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`"")
  Write-Output "  RestartOnFailure: 关闭 / MultipleInstances: IgnoreNew / ExecutionTimeLimit: 0"
}