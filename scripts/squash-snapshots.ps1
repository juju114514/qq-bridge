# 把真机仓库里成堆的 auto snapshot 合并成"一个"快照提交（0.4.101）
#
# 背景：D:\deepseek工作区\qq-bridge 是个 git 仓库，历史上被自动快照塞进了 113 个
# "auto snapshot (11-01 07:40:00)" 提交（每 10 分钟一个）。清理动作：
#   · 把当前工作区内容做成**一个**提交
#   · 提交时间由你指定（-Date）
#   · 旧历史先打 bundle 备份 + tag，出问题能整体还原
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\squash-snapshots.ps1 -Date "2026-11-01 08:00"            # 演练
#   powershell -ExecutionPolicy Bypass -File scripts\squash-snapshots.ps1 -Date "2026-11-01 08:00" -Apply     # 真做
#
# 注意：自动快照很可能是 DSH 工作区自己的检查点机制，合并完**还会继续产生新的**。
# 想彻底停掉要关掉那个机制（不是这个仓库的事）。
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Date,
  [string]$Message = 'snapshot: 历史合并（日期由用户指定）',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
# git 会把正常提示（Switched to a new branch …）写到 stderr；
# 在 Stop 模式下 PowerShell 会把它当错误抛出，导致脚本中断。
# 所以调用原生命令的那几处用 Continue。
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$git = 'git'

function Run([string[]]$argv) {
  $out = & $git -C $root @argv 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw ("git " + ($argv -join ' ') + " 失败($code): " + ($out | Out-String)) }
  return ($out | Out-String)
}

# 0) 解析日期
$when = $null
try { $when = [datetime]::Parse($Date) } catch { throw "日期解析不了：$Date（示例：2026-11-01 08:00）" }
$iso = $when.ToString('yyyy-MM-ddTHH:mm:sszzz')

Write-Output "仓库：$root"
Write-Output "新提交时间：$iso"
Write-Output "提交信息：$Message"

# 1) 工作区必须干净
$dirty = Run @('status', '--porcelain')
if ($dirty.Trim()) {
  Write-Output ''
  Write-Output '✗ 工作区有未提交改动，先处理（或告诉我，我帮你一起提交）：'
  ($dirty -split "`n" | Select-Object -First 10) | ForEach-Object { Write-Output ("   " + $_.Trim()) }
  exit 1
}

# 2) 统计
$total = (Run @('rev-list', '--count', 'HEAD')).Trim()
$snap = (Run @('rev-list', '--count', '--grep=auto snapshot', 'HEAD')).Trim()
Write-Output "现有提交：$total 个，其中 auto snapshot：$snap 个"

if (-not $Apply) {
  Write-Output ''
  Write-Output '演练：加 -Apply 才会真正合并（会先 bundle 备份 + 打 pre-squash tag）'
  exit 0
}

# 3) 备份：bundle + tag
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bakDir = Join-Path $root 'state'
New-Item -ItemType Directory -Path $bakDir -Force | Out-Null
$bundle = Join-Path $bakDir ("pre-squash-$stamp.bundle")
Run @('bundle', 'create', $bundle, '--all') | Out-Null
Write-Output "已备份全部历史 → $bundle"
Run @('tag', "pre-squash-$stamp", 'HEAD') | Out-Null
Write-Output "已打 tag：pre-squash-$stamp（随时可 git reset --hard pre-squash-$stamp）"

# 4) 折成一个提交（orphan 分支）
$ErrorActionPreference = 'Continue'
& $git -C $root checkout --orphan "__squash_$stamp" 2>&1 | Out-Null
$ErrorActionPreference = 'Stop'
& $git -C $root add -A 2>&1 | Out-Null
$env:GIT_AUTHOR_DATE = $iso
$env:GIT_COMMITTER_DATE = $iso
$env:GIT_AUTHOR_NAME = (& $git -C $root config user.name)
$env:GIT_AUTHOR_EMAIL = (& $git -C $root config user.email)
$msg = "`"$Message`""
& $git -C $root commit -m $Message 2>&1 | Out-Null
Remove-Item Env:GIT_AUTHOR_DATE, Env:GIT_COMMITTER_DATE -ErrorAction SilentlyContinue

# 5) 用新分支替换 main
& $git -C $root branch -D main 2>&1 | Out-Null
& $git -C $root branch -m main 2>&1 | Out-Null
& $git -C $root branch -u origin/main 2>&1 | Out-Null

$log = (& $git -C $root log --oneline -1) -join ''
$cnt = (& $git -C $root rev-list --count HEAD) -join ''
Write-Output ''
Write-Output "✓ 合并完成：现在只有 $cnt 个提交"
Write-Output "  $log"
Write-Output ''
Write-Output "回滚：git -C `"$root`" reset --hard pre-squash-$stamp"
Write-Output "恢复全部历史：git -C `"$root`" bundle unbundle `"$bundle`""
