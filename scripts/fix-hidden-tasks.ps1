# 把计划任务改成"真正不弹窗"（0.4.100）
#
# 症状：屏幕上偶尔闪一下 PowerShell 黑框。排查结论：
#   · qq-bridge-watchdog 每 5 分钟跑一次 keepalive.ps1
#   · 任务是 InteractiveToken（跑在你的桌面会话里）
#   · `powershell.exe -WindowStyle Hidden` **不能**阻止闪窗——窗口在 conhost 启动时就创建了，
#     -WindowStyle 是之后才生效的
#   · keepalive.ps1 里还用 `schtasks /end` / `schtasks /run` 起子进程，又各闪一次
#
# 做法：
#   1. 任务动作改成 wscript.exe //B hidden-launch.vbs "<原来的 powershell 命令行>"
#      —— wscript 用 window style 0 启动子进程，窗口从创建那一刻就是隐藏的
#   2. keepalive.ps1 里的 schtasks 调用换成 Start-ScheduledTask / Stop-ScheduledTask
#      —— PowerShell cmdlet 不新开控制台
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\fix-hidden-tasks.ps1            # 演练
#   powershell -ExecutionPolicy Bypass -File scripts\fix-hidden-tasks.ps1 -Apply     # 真改
[CmdletBinding()]
param(
  [switch]$Apply,
  [string[]]$Tasks = @('qq-bridge', 'qq-bridge-watchdog')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$vbs = Join-Path $root 'scripts\hidden-launch.vbs'

if (-not (Test-Path $vbs)) { throw "缺少 $vbs" }

function Get-TaskLimited([string]$name) {
  $xml = schtasks /query /tn "\$name" /xml 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return ($xml | Out-String)
}

foreach ($name in $Tasks) {
  $xml = Get-TaskLimited $name
  if (-not $xml) { Write-Output "跳过：任务 $name 不存在"; continue }

  # 现在要跑的命令行
  $m = [regex]::Match($xml, '<Arguments>(.*?)</Arguments>')
  if (-not $m.Success) { Write-Output "跳过：$name 没有 Arguments"; continue }
  $args0 = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value)

  $psExe = [regex]::Match($xml, '<Command>(.*?)</Command>').Groups[1].Value
  $full = "$psExe $args0"

  # 已经是 vbs 包装了就跳过
  if ($psExe -like '*wscript*') { Write-Output "已包装：$name"; continue }

  $newVbsArgs = "//B `"$vbs`" `"$($full -replace '"', '\"')`""
  Write-Output "── $name ──"
  Write-Output "  现在：$full"
  Write-Output "  改成：wscript.exe $newVbsArgs"

  if (-not $Apply) { continue }

  $backup = Join-Path $root ("state\task-backup-" + ($name -replace '[^\w-]', '_') + "-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".xml")
  New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
  $xml | Out-File $backup -Encoding Unicode
  Write-Output "  备份 → $backup"

  $tmp = [IO.Path]::GetTempFileName()
  try {
    # 直接改 XML 的 Command/Arguments
    $patched = $xml -replace '<Command>.*?</Command>', ('<Command>' + [System.Net.WebUtility]::HtmlEncode("$env:WINDIR\System32\wscript.exe") + '</Command>')
    $patched = $patched -replace '<Arguments>.*?</Arguments>', ('<Arguments>' + [System.Net.WebUtility]::HtmlEncode($newVbsArgs) + '</Arguments>')
    $patched | Out-File $tmp -Encoding Unicode
    $out = schtasks /create /tn "\$name" /xml $tmp /f 2>&1 | Out-String
    Write-Output ("  schtasks: " + $out.Trim())
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}

if (-not $Apply) {
  Write-Output ''
  Write-Output '演练模式：加 -Apply 才会真正改任务（会先备份 XML 到 state\）'
}
