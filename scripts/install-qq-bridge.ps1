# 安装/修复计划任务（管理员执行）——0.4.45 实施包
#
# 只做三件事：
#   1. 备份现有任务 XML
#   2. 用 task-proposed.xml 重新注册 qq-bridge（删除 RestartOnFailure + 加 -WindowStyle Hidden）
#   3. 打印验证结果
#
# 注意：schtasks /create /xml 要求文件是 **UTF-16**（带 BOM）；用 UTF-8 会失败。
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$taskName = 'qq-bridge'
$proposed = Join-Path $root 'state\task-proposed.xml'

if (-not (Test-Path $proposed)) { throw "缺少 $proposed：先运行 scripts\harden-scheduled-task.ps1 生成（不带 -Apply 即可）" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $root "state\task-backup-$stamp.xml"
$current = schtasks /query /tn "\$taskName" /xml 2>$null
if ($LASTEXITCODE -eq 0) { $current | Out-File $backup -Encoding Unicode; Write-Output "备份 → $backup" }

if (-not $Apply) {
  Write-Output "演练：将用 $proposed 重注册任务 $taskName（加 -Apply 才执行）"
  exit 0
}

$tmp = Join-Path $env:TEMP ("task-{0}.xml" -f $stamp)
Copy-Item $proposed $tmp -Force
$out = & schtasks /create /tn "\$taskName" /xml $tmp /f 2>&1 | Out-String
Write-Output ("schtasks: " + $out.Trim())
if ($LASTEXITCODE -ne 0) { throw "注册失败（exit $LASTEXITCODE）" }
Write-Output "已注册。回滚：schtasks /create /tn `"\$taskName`" /xml `"$backup`" /f"