# 计划任务硬化（0.4.42/0.4.43）：按 XML 重注册，**删除 RestartOnFailure 节点**
#
# 为什么要删节点而不是 Count=0：
#   Task Scheduler 的 XML 要求 RestartOnFailure 的 Count >= 1、Interval >= PT1M；
#   Count=0 不是"关闭"，而是非法值（注册会被拒或行为未定义）。正确做法是让整个节点不存在。
#
# 另一处语义纠正：
#   Settings.Hidden=true 只影响"任务计划程序里是否隐藏这个任务"，
#   **不影响弹出的窗口**。真正不弹窗口的是启动参数里的 -WindowStyle Hidden。
#
# 实测现状（2026-10-31 导出的 XML）：
#   qq-bridge：MultipleInstancesPolicy 已是 IgnoreNew，ExecutionTimeLimit 已是 PT0S，
#              Triggers 只有 LogonTrigger —— 这些都不用改。
#              只需要：① 删 RestartOnFailure ② 参数加 -WindowStyle Hidden
#   qq-bridge-watchdog：无 RestartOnFailure，每 5 分钟触发（PT5M），无需改任务本身；
#              要改的是 keepalive.ps1 的行为（见 scripts/keepalive.ps1）。
#
# 用法（管理员）：powershell -ExecutionPolicy Bypass -File scripts\harden-scheduled-task.ps1 -Apply
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$taskName = 'qq-bridge'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$script = Join-Path $root 'scripts\run-bridge.ps1'
if (-not (Test-Path $script)) { throw "找不到 run-bridge.ps1：$script" }

# 备份原任务 XML（回滚用）
$backup = Join-Path $root ("state\task-backup-{0}.xml" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path (Split-Path $backup) | Out-Null
$current = schtasks /query /tn "\$taskName" /xml 2>$null
if ($LASTEXITCODE -eq 0) { $current | Out-File -FilePath $backup -Encoding Unicode; Write-Output "已备份原任务 → $backup" }

$userId = "$env:USERDOMAIN\$env:USERNAME"
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <URI>\$taskName</URI>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>$userId</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
  </Settings>
  <Triggers>
    <LogonTrigger />
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$script"</Arguments>
      <WorkingDirectory>$root</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$probe = Join-Path $root 'state\task-proposed.xml'
[IO.File]::WriteAllText($probe, $xml, (New-Object Text.UnicodeEncoding($false, $true)))
Write-Output "拟用 XML 已写到：$probe"

if (-not $Apply) {
  Write-Output "演练模式（未改动）。加 -Apply 才会重注册。"
  Write-Output "  变更点：删除 RestartOnFailure；参数加 -WindowStyle Hidden；其余保持不变"
  exit 0
}

# 用 XML 注册（会替换现有任务）
$tmp = Join-Path $env:TEMP ("qq-bridge-task-{0}.xml" -f (Get-Date -Format 'HHmmss'))
[IO.File]::WriteAllText($tmp, $xml, (New-Object Text.UnicodeEncoding($false, $true)))
$out = & schtasks /create /tn "\$taskName" /xml $tmp /f 2>&1 | Out-String
Write-Output ("schtasks /create 输出：" + $out.Trim())
if ($LASTEXITCODE -ne 0) { throw "schtasks /create 失败（exit $LASTEXITCODE）" }
Write-Output "已重注册任务 $taskName"
$x = [xml](schtasks /query /tn "\$taskName" /xml 2>$null)
Write-Output ("  RestartOnFailure: " + $(if ($x.Task.Settings.RestartOnFailure) { "仍存在！" } else { "已删除 ✅" }))
Write-Output ("  Arguments: " + $x.Task.Actions.Exec.Arguments)
Write-Output ("  MultipleInstancesPolicy: " + $x.Task.Settings.MultipleInstancesPolicy)
Write-Output ("  ExecutionTimeLimit: " + $x.Task.Settings.ExecutionTimeLimit)