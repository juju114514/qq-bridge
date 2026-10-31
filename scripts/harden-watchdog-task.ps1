# 修 watchdog 任务的「每 5 分钟弹一个可见窗口」（0.4.47）
#
# 根因：主任务早在 0.4.43 就加了 -WindowStyle Hidden，
#       但 **watchdog 任务的参数一直没加** —— 它每 5 分钟（PT5M）跑一次 keepalive.ps1，
#       每次都弹一个可见 PowerShell 窗口。这就是"一直在弹"的来源。
#
# 做法：备份 → 用 XML 重新注册（保留原有触发器 PT5M 与设置），只在参数里加 -WindowStyle Hidden。
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$taskName = 'qq-bridge-watchdog'
$script = Join-Path $root 'scripts\keepalive.ps1'

$backup = Join-Path $root ("state\task-backup-watchdog-{0}.xml" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$cur = schtasks /query /tn "\$taskName" /xml 2>$null
if ($LASTEXITCODE -eq 0) { $cur | Out-File $backup -Encoding Unicode; Write-Output "备份 → $backup" }

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><URI>\$taskName</URI></RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>$env:USERDOMAIN\$env:USERNAME</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
  </Settings>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>2026-10-31T12:46:19+08:00</StartBoundary>
      <Repetition><Interval>PT5M</Interval><StopAtDurationEnd>true</StopAtDurationEnd></Repetition>
    </TimeTrigger>
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
$probe = Join-Path $root 'state\task-proposed-watchdog.xml'
[IO.File]::WriteAllText($probe, $xml, (New-Object Text.UnicodeEncoding($false, $true)))
Write-Output "拟用 XML → $probe"

if (-not $Apply) { Write-Output "演练（未改动）。唯一变更：参数加 -WindowStyle Hidden"; exit 0 }

$tmp = Join-Path $env:TEMP ("wd-{0}.xml" -f (Get-Date -Format 'HHmmss'))
[IO.File]::WriteAllText($tmp, $xml, (New-Object Text.UnicodeEncoding($false, $true)))
$out = & schtasks /create /tn "\$taskName" /xml $tmp /f 2>&1 | Out-String
Write-Output ("schtasks: " + $out.Trim())
if ($LASTEXITCODE -ne 0) { throw "注册失败（exit $LASTEXITCODE）" }
Write-Output "已重注册。回滚：schtasks /create /tn `"\$taskName`" /xml `"$backup`" /f"