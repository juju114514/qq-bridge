#Requires -Version 5.1
<#
.SYNOPSIS
  qq-bridge 日常维护：加密备份、日志裁剪、凭据轮换、ACL 硬化、孤儿会话报告。

.DESCRIPTION
  默认只**报告**，不改任何东西。加 -Apply 才真正执行清理/备份。
  备份用 Windows DPAPI 加密（只有当前用户+本机可解密），不会留下明文令牌。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\maintain.ps1

.EXAMPLE
  # 真跑：备份 + 裁日志 + 清理用量记录
  .\scripts\maintain.ps1 -Apply

.EXAMPLE
  # 轮换控制台令牌（会重启提示）
  .\scripts\maintain.ps1 -Apply -RotateConsoleToken
#>
param(
  [switch]$Apply,
  [switch]$Backup,
  [switch]$TrimLogs,
  [switch]$PruneUsage,
  [switch]$HardenAcl,
  [switch]$RotateConsoleToken,
  [int]$KeepLogDays = 7
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Ok($n, $d) { Write-Host ("  [OK]   {0,-22} {1}" -f $n, $d) -ForegroundColor Green }
function Wo($n, $d) { Write-Host ("  [WARN] {0,-22} {1}" -f $n, $d) -ForegroundColor Yellow }
function Info($m)   { Write-Host ("         $m") -ForegroundColor DarkGray }
function Step($m)     { Write-Host ("  → {0}" -f $m) -ForegroundColor Cyan }

if (-not $Apply -and -not ($Backup -or $TrimLogs -or $PruneUsage -or $HardenAcl -or $RotateConsoleToken)) {
  $reportOnly = $true
} else {
  $reportOnly = -not $Apply
}
# 未指定具体动作时，-Apply 默认做：备份 + 裁日志 + 清用量
$anyAction = $Backup -or $TrimLogs -or $PruneUsage -or $HardenAcl -or $RotateConsoleToken
if ($Apply -and -not $anyAction) { $Backup = $true; $TrimLogs = $true; $PruneUsage = $true }

$stateDir = Join-Path $Root 'state'
$logDir = Join-Path $Root 'logs'
$backupDir = Join-Path (Split-Path -Parent $Root) 'qq-bridge-backups'

Write-Host ""
Write-Host "qq-bridge 维护" -ForegroundColor Cyan
Write-Host ("  目录: {0}" -f $Root) -ForegroundColor DarkGray
Write-Host ("  模式: {0}" -f $(if ($reportOnly) { '只报告（加 -Apply 才执行）' } else { '执行' })) -ForegroundColor DarkGray
Write-Host ""

if (-not (Test-Path $stateDir)) {
  Write-Host "  [x] 找不到 state/ 目录，确认在本项目根目录运行" -ForegroundColor Red
  exit 1
}

# ── 1. 现状盘点 ────────────────────────────────────────────────────────────
$logs = @(Get-ChildItem $stateDir,$logDir -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '\.log(\.\d+)?$|token-usage\.jsonl$' })
$logBytes = ($logs | Measure-Object Length -Sum).Sum
Ok '日志占用' ("{0} 个文件 / {1:N1} MB" -f $logs.Count, ($logBytes / 1MB))

$sessFile = Join-Path $stateDir 'sessions.json'
if (Test-Path $sessFile) {
  try {
    $sess = [IO.File]::ReadAllText($sessFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $n = if ($sess.sessions) { @($sess.sessions.PSObject.Properties).Count } else { 0 }
    Ok '会话映射' "$n 条（孤儿会话会拖慢唤醒，见 docs/OPERATIONS.md）"
  } catch { Wo '会话映射' '读取失败（JSON 可能损坏）' }
}

# ── 2. ACL 硬化检查 ────────────────────────────────────────────────────────
$acl = icacls $stateDir 2>$null | Out-String
$hasUsers = $acl -match 'BUILTIN\\Users:|Everyone|Users:\('
if ($hasUsers) { Wo 'state ACL' '包含 Users/Everyone，本机其他用户可能读到令牌与聊天记录' }
else { Ok 'state ACL' '仅 Administrators / SYSTEM / 当前用户（已硬化）' }

if ($HardenAcl -and -not $reportOnly) {
  Step '硬化 state/ 权限（移除继承，只留 Administrators/SYSTEM/当前用户）'
  $me = "$env:USERDOMAIN\$env:USERNAME"
  icacls $stateDir /inheritance:r /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "${me}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -eq 0) { Ok 'ACL' '已硬化' } else { Wo 'ACL' 'icacls 失败（需要管理员）' }
}

# ── 3. 加密备份（DPAPI）────────────────────────────────────────────────────
if ($Backup) {
  $need = @('config.json') + @(
    (Get-ChildItem $stateDir -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^(console-token|current-role\.json|roles-by-key\.json|role-setup\.json|social-v2\.json|slang\.json|stickers\.json|sessions\.json)$' } |
      ForEach-Object { $_.FullName })
  ) | Where-Object { $_ }
  $roles = @(Get-ChildItem (Join-Path $Root 'roles') -Filter '*.md' -File -ErrorAction SilentlyContinue)

  if ($reportOnly) {
    Ok '待备份' ("{0} 个关键文件 + {1} 张角色卡 → DPAPI 加密" -f $need.Count, $roles.Count)
    Info '备份文件只有「当前 Windows 用户 + 本机」能解密；拷到别的机器会解不开（跨机灾备见 docs/OPERATIONS.md）'
  } else {
    if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stage = Join-Path $env:TEMP ("qqbridge-backup-$ts")
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stage 'state') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stage 'roles') -Force | Out-Null
    if (Test-Path 'config.json') { Copy-Item 'config.json' $stage -Force }
    foreach ($f in $need) {
      if ($f -eq 'config.json') { continue }
      Copy-Item $f (Join-Path $stage 'state') -Force -ErrorAction SilentlyContinue
    }
    foreach ($r in $roles) { Copy-Item $r.FullName (Join-Path $stage 'roles') -Force }
    # 明文清单（不含内容）方便日后核对
    $manifest = [ordered]@{
      createdAt = (Get-Date).ToString('s')
      root = $Root
      files = @(Get-ChildItem $stage -Recurse -File | ForEach-Object { [ordered]@{ path = $_.FullName.Substring($stage.Length + 1); bytes = $_.Length } })
    }
    ($manifest | ConvertTo-Json -Depth 5) | Set-Content (Join-Path $stage 'manifest.json') -Encoding UTF8

    $zip = Join-Path $env:TEMP ("qqbridge-backup-$ts.zip")
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
    # DPAPI 加密
    Add-Type -AssemblyName System.Security
    $bytes = [IO.File]::ReadAllBytes($zip)
    $enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $out = Join-Path $backupDir ("qq-bridge-$ts.zip.dpapi")
    [IO.File]::WriteAllBytes($out, $enc)
    # 安全删除明文（覆盖一次再删）
    try {
      $fs = [IO.File]::Open($zip, 'Open', 'ReadWrite')
      $buf = New-Object byte[] ([Math]::Min(1MB, $fs.Length))
      for ($i = 0; $i -lt $fs.Length; $i += $buf.Length) { $fs.Write($buf, 0, $buf.Length) }
      $fs.Close()
    } catch { }
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Ok '已备份' ("{0}（{1:N1} MB，DPAPI 加密）" -f $out, ((Get-Item $out).Length / 1MB))
    Info '解密命令见 docs/OPERATIONS.md#如何恢复加密备份'
  }
}

# ── 4. 日志裁剪 ────────────────────────────────────────────────────────────
if ($TrimLogs) {
  $old = @($logs | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepLogDays) })
  $oldBytes = ($old | Measure-Object Length -Sum).Sum
  if ($old.Count -eq 0) {
    Ok '日志裁剪' "没有超过 $KeepLogDays 天的日志"
  } elseif ($reportOnly) {
    Ok '待裁剪' ("{0} 个文件 / {1:N1} MB（超过 {2} 天）" -f $old.Count, ($oldBytes / 1MB), $KeepLogDays)
  } else {
    $old | Remove-Item -Force -ErrorAction SilentlyContinue
    Ok '已裁剪' ("{0} 个文件，释放 {1:N1} MB" -f $old.Count, ($oldBytes / 1MB))
  }
}

# ── 5. 用量记录 ────────────────────────────────────────────────────────────
$usage = Join-Path $stateDir 'token-usage.jsonl'
if ($PruneUsage -and (Test-Path $usage)) {
  $mb = (Get-Item $usage).Length / 1MB
  if ($reportOnly) {
    Ok '用量记录' ("{0:N2} MB（可清；关闭=删除，桥接会重建）" -f $mb)
  } else {
    Remove-Item $usage -Force -ErrorAction SilentlyContinue
    Ok '用量记录' ("已清（原 {0:N2} MB）" -f $mb)
  }
}

# ── 6. 控制台令牌轮换 ──────────────────────────────────────────────────────
$tokFile = Join-Path $stateDir 'console-token'
if ($RotateConsoleToken) {
  if ($reportOnly) {
    Ok '令牌轮换' '将生成新 console-token（旧令牌立即失效，需重启桥接）'
  } else {
    if (Test-Path $tokFile) { Copy-Item $tokFile "$tokFile.old-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force }
    $new = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36)) -replace '[^A-Za-z0-9]', ''
    [IO.File]::WriteAllText($tokFile, $new, (New-Object Text.UTF8Encoding($false)))
    Ok '令牌轮换' '已写入新 console-token → 现在重启桥接生效（restart.bat）'
  }
} else {
  if (Test-Path $tokFile) {
    $age = (Get-Date) - (Get-Item $tokFile).LastWriteTime
    if ($age.TotalDays -gt 90) { Wo '令牌年龄' ("{0:N0} 天没换过（建议 -RotateConsoleToken）" -f $age.TotalDays) }
    else { Ok '令牌年龄' ("{0:N0} 天" -f $age.TotalDays) }
  }
}

# ── 7. 日志隐私提醒 ────────────────────────────────────────────────────────
Ok '日志隐私' '日志含完整 QQ 消息内容；分享日志前先脱敏（见 docs/OPERATIONS.md#日志隐私）'

Write-Host ""
if ($reportOnly) {
  Write-Host "以上为报告。执行：.\scripts\maintain.ps1 -Apply" -ForegroundColor Cyan
} else {
  Write-Host "维护完成。建议随后跑 .\verify.ps1" -ForegroundColor Cyan
}
