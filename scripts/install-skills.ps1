#Requires -Version 5.1
<#
.SYNOPSIS
  把仓库 skills\ 下的技能装到 agent 的技能目录（或卸载）。

.DESCRIPTION
  为什么需要脚本而不是几条 Copy-Item：不同 agent 的技能目录不一样，而且**猜错目录等于没装**
  （agent 读不到，用户以为装好了）。所以这里按顺序探测候选目录，先 dry-run 看清楚再落盘。

  候选目录（按优先级）：
    1) ~/.claude/skills            Claude Code 约定（DSH 也能通过 cc-plugin 那套读）
    2) ~/.dsh/skills               DSH 原生猜测
    3) <当前目录>/.claude/skills    项目级
  你也可以用 -Target 直接指定。

  安装只做一件事：把 `skills\<Name>\` 整目录复制过去。**不联网、不执行上游脚本**。

.PARAMETER Name
  技能目录名（对应仓库 `skills\<Name>\`）。默认 caveman。

.PARAMETER Target
  目标技能目录。不传则按上面顺序探测第一个已存在的父目录。

.PARAMETER DryRun
  只打印将要做什么，不落盘。

.PARAMETER Uninstall
  删除目标目录里的同名技能（只删那个子目录）。

.EXAMPLE
  powershell -File scripts\install-skills.ps1 -Name caveman -DryRun
  powershell -File scripts\install-skills.ps1 -Name caveman
  powershell -File scripts\install-skills.ps1 -Name caveman -Uninstall
#>
param(
  [string]$Name = 'caveman',
  [string]$Target = '',
  [switch]$DryRun,
  [switch]$Uninstall,
  [string]$Root = ''
)

$ErrorActionPreference = 'Continue'

function Info([string]$m) { Write-Host "  $m" }
function Ok([string]$m) { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Bad([string]$m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }

if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
$source = Join-Path $Root (Join-Path 'skills' $Name)
if (-not (Test-Path -LiteralPath $source)) { Bad "仓库里没有这个技能：$source"; exit 2 }
$skillFile = Join-Path $source 'SKILL.md'
if (-not (Test-Path -LiteralPath $skillFile)) { Bad "技能目录里没有 SKILL.md：$source"; exit 2 }

# 技能目录：显式指定 > 已存在的候选 > 新建 ~/.claude/skills
$candidates = @(
  (Join-Path $env:USERPROFILE '.claude\skills'),
  (Join-Path $env:USERPROFILE '.dsh\skills'),
  (Join-Path (Get-Location) '.claude\skills')
)
if (-not $Target) {
  $existing = @($candidates | Where-Object { Test-Path -LiteralPath $_ })
  if ($existing.Count -gt 0) {
    $Target = $existing[0]
    Info "探测到已存在的技能目录：$Target"
  } else {
    $Target = $candidates[0]
    Warn "没有现成的技能目录，将创建：$Target"
  }
}
$dest = Join-Path $Target $Name

Write-Host ''
Info "源：$source"
Info "目标：$dest"
Write-Host ''

if ($Uninstall) {
  if (-not (Test-Path -LiteralPath $dest)) { Warn "目标不存在，无需卸载：$dest"; exit 0 }
  if ($DryRun) { Info "（dry-run）将删除 $dest"; exit 0 }
  Remove-Item -LiteralPath $dest -Recurse -Force
  Ok "已卸载：$dest"
  Info '如果你正在用某个 agent，重载一次技能目录才会生效（DSH 可用 reload-skills）'
  exit 0
}

# 装了哪些文件、多大，先让人看清楚
$files = @(Get-ChildItem -LiteralPath $source -Recurse -File)
$totalKb = [math]::Round((($files | Measure-Object Length -Sum).Sum / 1KB), 1)
Info "将复制 $($files.Count) 个文件，共 $totalKb KB"
foreach ($f in $files) { Info ('  ' + $f.FullName.Substring($source.Length).TrimStart('\')) }

if ($DryRun) {
  Write-Host ''
  Info "（dry-run）没写任何文件。去掉 -DryRun 就会复制到上面那个目标。"
  exit 0
}

New-Item -ItemType Directory -Path $Target -Force | Out-Null
if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
Copy-Item -LiteralPath $source -Destination $dest -Recurse -Force
Ok "已安装到 $dest"

# 装完自检：目标里真的有 SKILL.md 且内容与源一致
$check = Join-Path $dest 'SKILL.md'
if (Test-Path -LiteralPath $check) {
  $a = (Get-FileHash -LiteralPath $skillFile -Algorithm SHA256).Hash
  $b = (Get-FileHash -LiteralPath $check -Algorithm SHA256).Hash
  if ($a -eq $b) { Ok '自检通过：SKILL.md 与源一致' } else { Bad '自检失败：SKILL.md 与源不一致' }
} else {
  Bad '自检失败：目标里没有 SKILL.md'
  exit 1
}
Info '让 agent 重载技能目录才生效（DSH: reload-skills；Claude Code: 重启会话）'
exit 0
