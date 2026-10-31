# adopt-fork.ps1 —— 把「上游 qq-bridge」的安装目录换成「本 fork」（程序换新、数据不动）
#
# 设计原则：
#   1. **默认只预演**（DryRun），必须显式 -Apply 才会写盘
#   2. 只覆盖**程序文件**；config.json / state / node_modules / .git / cookies / logs 一律不碰
#   3. 动手前先备份（protected 文件 + git HEAD）
#   4. 输出「将被覆盖」与「被保护」两份清单，让用户先看清再决定
#
# 用法：
#   .\adopt-fork.ps1 -Source D:\下载\qq-bridge-fork -Target D:\deepseek工作区\qq-bridge
#   .\adopt-fork.ps1 -Source ... -Target ... -Apply
#
# 注意：PowerShell 5.1 读取本文件需要 UTF-8 BOM（本文件已带 BOM）。

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Target,
  [switch]$Apply,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$script:copied = 0
$script:skipped = 0
$script:warnings = @()

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Fail([string]$msg) { Say ("✗ " + $msg) 'Red'; exit 1 }
function Warn([string]$msg) { $script:warnings += $msg; Say ("⚠ " + $msg) 'Yellow' }

# 受保护：绝不覆盖/删除
$ProtectedNames = @(
  'config.json', 'config.json.bak', 'state', 'node_modules', '.git', '.github',
  'data', 'logs', 'audio', 'cookies.txt', 'cookies.json', 'package-lock.json.bak'
)
# 受保护的**前缀**（日志、草稿等）
$ProtectedPrefixes = @('_backup', '_rollback', 'plugin.log', 'bridge.log', 'state-')

Say "== adopt-fork ==" 'Cyan'
Say ("  源（本 fork）: " + $Source)
Say ("  目标（现有安装）: " + $Target)
Say ("  模式: " + $(if ($Apply) { '实盘写入（-Apply）' } else { '预演（DryRun，不写任何文件）' })) 'Cyan'

# ── 1) 目录校验 ─────────────────────────────────────────────────────────────
if (-not (Test-Path $Source)) { Fail "源目录不存在：$Source" }
if (-not (Test-Path $Target)) { Fail "目标目录不存在：$Target" }
$srcBridge = Join-Path $Source 'src\bridge.js'
$dstBridge = Join-Path $Target 'src\bridge.js'
if (-not (Test-Path $srcBridge)) { Fail "源目录不像本仓库（缺 src\bridge.js）：$Source" }
if (-not (Test-Path $dstBridge)) { Fail "目标目录不像 qq-bridge 安装（缺 src\bridge.js）：$Target" }

# ── 2) 收集要复制的条目（跳过受保护项）────────────────────────────────────────
$entries = @(Get-ChildItem -LiteralPath $Source -Force | Where-Object {
    $name = $_.Name
    if ($ProtectedNames -contains $name) { return $false }
    foreach ($p in $ProtectedPrefixes) { if ($name.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)) { return $false } }
    return $true
})

# 目标目录里现已存在的受保护项（只报告，不动）
$targetProtected = @(Get-ChildItem -LiteralPath $Target -Force | Where-Object {
    $name = $_.Name
    ($ProtectedNames -contains $name) -or ($ProtectedPrefixes | Where-Object { $name.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })
} | ForEach-Object { $_.Name })

Say ""
Say "-- 将复制（程序文件）--" 'Cyan'
$overwrite = 0
foreach ($e in $entries) {
    $dst = Join-Path $Target $e.Name
    $exists = Test-Path $dst
    if ($exists) { $overwrite++ }
    Say ("   " + $(if ($exists) { '[覆盖]' } else { '[新增]' }) + " " + $e.Name + $(if ($e.PSIsContainer) { '\' } else { '' }))
}
Say ("   合计 " + $entries.Count + " 项（其中 " + $overwrite + " 项会覆盖同名文件）")

Say ""
Say "-- 受保护，不动 --" 'Cyan'
if ($targetProtected.Count -eq 0) {
    Say "   （目标目录里没有检测到 config/state 等；如果是全新安装这正常）"
} else {
    $targetProtected | ForEach-Object { Say ("   " + $_) }
}

# ── 3) 预检：目标里有没有 qq-bridge 进程在跑 / 计划任务 -- ───────────────────
Say ""
Say "-- 预检 --" 'Cyan'
$listener = @(Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue)
if ($listener.Count -gt 0) {
    Warn ("目标端口 3100 正在被监听（pid " + ($listener | Select-Object -First 1).OwningProcess + "）—— 实盘写入前请先停任务：schtasks /end /tn qq-bridge")
} else {
    Say "   [OK] 3100 空闲（没有实例在跑）"
}
$task = schtasks /query /tn 'qq-bridge' 2>$null
if ($LASTEXITCODE -eq 0) { Say "   [i] 检测到计划任务 qq-bridge；切换后建议重跑 scripts\install-qq-bridge.ps1（动作路径可能指向旧目录）" }

# ── 4) 结果 ─────────────────────────────────────────────────────────────────
Say ""
if ($script:warnings.Count -gt 0) {
    Say ("⚠ 有 " + $script:warnings.Count + " 条警告，见上。") 'Yellow'
}

if (-not $Apply) {
    Say "预演结束：**没有写任何文件**。" 'Green'
    Say "确认无误后加 -Apply 执行；建议先退出 QQ/停止计划任务。" 'Green'
    exit 0
}

if (-not $Force) {
    $ans = Read-Host "即将覆盖 $Target 里的程序文件（config/state 不动）。输入 yes 继续"
    if ($ans -ne 'yes') { Fail "已取消（未输入 yes）" }
}

# ── 5) 备份 ────────────────────────────────────────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $Target ("_backup_switch_" + $stamp)
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($p in $ProtectedNames) {
    $full = Join-Path $Target $p
    if (Test-Path $full) {
        try { Copy-Item -LiteralPath $full -Destination $backup -Recurse -Force } catch { Warn ("备份失败（已跳过）：" + $p) }
    }
}
try {
    $head = & git -C $Target rev-parse --short HEAD 2>$null
    if ($head) { ("HEAD=" + $head) | Out-File (Join-Path $backup 'git-head.txt') -Encoding utf8 }
} catch { }
Say ("已备份到：" + $backup) 'Green'

# ── 6) 复制 ────────────────────────────────────────────────────────────────
Say ""
Say "-- 开始复制 --" 'Cyan'
foreach ($e in $entries) {
    $dst = Join-Path $Target $e.Name
    try {
        if ($e.PSIsContainer) {
            # 目标目录已存在时必须拷**内容**：Copy-Item -Recurse 到已存在的目录会再套一层
            # （变成 src\src\...），这是实测踩到的坑。
            if (Test-Path $dst) {
                Get-ChildItem -LiteralPath $e.FullName -Force | ForEach-Object {
                    Copy-Item -LiteralPath $_.FullName -Destination $dst -Recurse -Force
                }
            } else {
                Copy-Item -LiteralPath $e.FullName -Destination $dst -Recurse -Force
            }
        } else {
            Copy-Item -LiteralPath $e.FullName -Destination $dst -Force
        }
        $script:copied++
    } catch {
        $script:skipped++
        Warn ("复制失败：" + $e.Name + " —— " + $_.Exception.Message)
    }
}
Say ("复制完成：成功 " + $script:copied + " 项，失败 " + $script:skipped + " 项")

# ── 7) 后续步骤 ────────────────────────────────────────────────────────────
Say ""
Say "接下来（按顺序）：" 'Cyan'
Say "  1) 补依赖：cd `"$Target`"; npm ci --no-audit --no-fund"
Say "  2) 重装任务（动作路径可能还指向旧目录）：powershell -File scripts\install-qq-bridge.ps1"
Say "  3) 自检：powershell -File scripts\verify-qq-bridge.ps1   （期望 18/18）"
Say "  4) 起服务：schtasks /run /tn qq-bridge"
Say ""
Say "如果起不来：把 $backup 里的 config.json/state 拷回去，就能回到切换前的状态。" 'Yellow'
