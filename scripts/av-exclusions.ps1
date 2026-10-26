#Requires -Version 5.1
<#
.SYNOPSIS
  杀软排除项助手：自动识别当前杀软，为 qq-bridge / DSH 相关路径加排除。

.DESCRIPTION
  背景（实测）：
    · Kaspersky 免费版 **没有**「排除项 / 受信任应用程序」界面 → 只能取消自动删除或换杀软
    · Windows Defender **支持**排除项，且可用 PowerShell 全自动配置
    · 若装了 Kaspersky 且其服务在跑，Defender 会处于被动模式（排除项不生效）

  本脚本默认只**打印**该加什么；加 -Apply 才会真的写 Defender 排除项（需要管理员）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\av-exclusions.ps1

.EXAMPLE
  # 真的应用（管理员 PowerShell）
  .\scripts\av-exclusions.ps1 -Apply
#>
param(
  [switch]$Apply,
  [string[]]$ExtraPaths = @()
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Ok($n, $d) { Write-Host ("  [OK]   {0,-24} {1}" -f $n, $d) -ForegroundColor Green }
function Wo($n, $d) { Write-Host ("  [WARN] {0,-24} {1}" -f $n, $d) -ForegroundColor Yellow }
function No($n, $d) { Write-Host ("  [FAIL] {0,-24} {1}" -f $n, $d) -ForegroundColor Red }
function Info($m)   { Write-Host ("         $m") -ForegroundColor DarkGray }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ""
Write-Host "杀软排除项助手" -ForegroundColor Cyan
Write-Host ("  管理员: {0}" -f $isAdmin) -ForegroundColor DarkGray
Write-Host ""

# ── 1. 识别杀软 ────────────────────────────────────────────────────────────
$kav = Get-Service -Name 'AVP21.25' -ErrorAction SilentlyContinue
$kavRunning = $kav -and $kav.Status -eq 'Running'
$kavExe = Get-ChildItem 'C:\Program Files (x86)\Kaspersky Lab','C:\Program Files\Kaspersky Lab' -Recurse -Filter 'avpui.exe' -ErrorAction SilentlyContinue -Depth 3 | Select-Object -First 1
$defender = $null
try { $defender = Get-MpComputerStatus -ErrorAction Stop } catch { }

if ($kav) {
  if ($kavRunning) { Ok 'Kaspersky' "运行中（$($kav.Name)）" } else { Wo 'Kaspersky' "已安装但服务 $($kav.Status)" }
  if ($kavExe) { Info ("版本目录: " + (Split-Path -Parent $kavExe.FullName)) }
  Wo 'Kaspersky 排除项' '免费版不提供该功能（设置里搜「排除」「信任」均无结果）'
  Info '三条出路：① 升级到标准版/Plus ② 卸载后改用 Defender（本脚本可自动配 Defender 排除项） ③ 取消自动删除可疑工具（仍会扫描，可能仍卡）'
} else {
  Ok 'Kaspersky' '未安装'
}

if ($defender) {
  Ok 'Defender' ("实时保护={0} 反病毒={1}" -f $defender.RealTimeProtectionEnabled, $defender.AntivirusEnabled)
} else {
  Wo 'Defender' '状态读不到（可能被第三方杀软接管）'
}

Write-Host ""

# ── 2. 收集要排除的路径 ────────────────────────────────────────────────────
$paths = [System.Collections.Generic.List[string]]::new()
$procs = [System.Collections.Generic.List[string]]::new()
$add = { param($p) if ($p -and (Test-Path $p) -and -not $paths.Contains($p)) { $paths.Add($p) } }

& $add $Root
& $add (Split-Path -Parent $Root)
if (Test-Path 'D:\DEEPSEEK') { & $add 'D:\DEEPSEEK' }
& $add (Join-Path $env:USERPROFILE '.dsh')

$cfg = $null
if (Test-Path (Join-Path $Root 'config.json')) {
  try { $cfg = [IO.File]::ReadAllText((Join-Path $Root 'config.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json } catch { }
}
if ($cfg) {
  if ($cfg.snowluma.homeDir) { & $add $cfg.snowluma.homeDir }
  if ($cfg.snowluma.launcherPath) { & $add (Split-Path -Parent $cfg.snowluma.launcherPath) }
}

foreach ($n in @(
  (Get-Command node -ErrorAction SilentlyContinue).Source,
  "$env:ProgramFiles\nodejs",
  "$env:LOCALAPPDATA\Programs\nodejs"
)) { if ($n -and (Test-Path $n)) { & $add $n; if ($n -like '*node.exe') { $procs.Add('node.exe') } } }

# DSH 自带的 node 运行时（目录整包排除更省事）
& $add (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes')

foreach ($p in $ExtraPaths) { & $add $p }

# DSH 自带 node 的具体目录（整包排除之外再精确一条）
$dshNode = Get-ChildItem (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes') -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'node[\\/]bin[\\/]node\.exe$' } | Select-Object -First 1
if ($dshNode) { & $add (Split-Path -Parent (Split-Path -Parent $dshNode.FullName)) }

foreach ($e in 'node.exe','ffmpeg.exe','ffprobe.exe','QQ.exe','QQEX.exe') { if (-not $procs.Contains($e)) { $procs.Add($e) } }

Write-Host "  ── 建议排除的路径 ──" -ForegroundColor Cyan
$paths | ForEach-Object { Write-Host "    $_" -ForegroundColor White }
Write-Host "  ── 建议排除的进程 ──" -ForegroundColor Cyan
$procs | ForEach-Object { Write-Host "    $_" -ForegroundColor White }

# ── 3. 应用（仅 Defender）──────────────────────────────────────────────────
Write-Host ""
if (-not $Apply) {
  Info '只打印，未修改。要真的写入 Defender 排除项：加 -Apply（管理员 PowerShell）'
  Info '示例：.\scripts\av-exclusions.ps1 -Apply'
  exit 0
}

if (-not $isAdmin) {
  No '应用失败' '需要管理员权限。右键 PowerShell「以管理员身份运行」后重试'
  exit 1
}
if (-not $defender) {
  No '应用失败' '读不到 Defender 状态（被第三方杀软接管了？先卸载或停用第三方杀软）'
  exit 1
}

try {
  foreach ($p in $paths) { Add-MpPreference -ExclusionPath $p -ErrorAction Stop }
  Ok '排除路径' "已写入 $($paths.Count) 条"
} catch {
  No '排除路径' $_.Exception.Message
}
try {
  foreach ($e in $procs) { Add-MpPreference -ExclusionProcess $e -ErrorAction Stop }
  Ok '排除进程' "已写入 $($procs.Count) 条"
} catch {
  No '排除进程' $_.Exception.Message
}

# ── 4. 回读验证 ────────────────────────────────────────────────────────────
Write-Host ""
$pref = Get-MpPreference
Ok '当前排除路径数' ([string](@($pref.ExclusionPath).Count))
Ok '当前排除进程数' ([string](@($pref.ExclusionProcess).Count))
Write-Host ""
Write-Host "完成。建议再跑一次体检：.\verify.ps1" -ForegroundColor Cyan
