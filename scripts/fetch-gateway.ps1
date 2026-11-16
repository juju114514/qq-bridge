# 取网关安装包（SnowLuma / NapCat），带镜像回退与 SHA256 校验
#
# 为什么需要这个脚本：
#   2026-11 起上游仓库相继消失 ——
#     · SnowLuma/SnowLuma  2026-11-09 转 private（社区称因律师函）
#     · NapNeko/NapCatQQ   2026-11-12 源码清空（README 只剩 "Ending"）
#   官方下载链接全 404，新同学装环境时会卡在"网关下不了"。
#
# 本脚本只做三件事：从**镜像**下载 → 校验 SHA256 → 解压到指定目录。
# 它不启动、不配置、不改网关（那是使用者自己的事，见 docs/guides/GATEWAY.md）。
#
# 用法：
#   # 取 SnowLuma v2.4.2（Windows x64，41MB）
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-gateway.ps1 -Kind snowluma -To D:\QQBot\snowluma
#
#   # 取 NapCat v4.18.42（Windows Shell + Node，118MB）
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-gateway.ps1 -Kind napcat -To D:\QQBot\napcat
#
#   # 只看会从哪下、不下
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-gateway.ps1 -Kind snowluma -DryRun
#
# 参数：
#   -Kind        snowluma | napcat | list
#   -To          解压目标目录（默认当前目录下 .\gateway）
#   -Mirror      自建镜像的直链（优先使用；团队可以把自己的 release 资产放这里）
#   -DryRun      只打印计划
#   -Force       目标非空也照做（默认拒绝，避免覆盖正在用的网关）

param(
    [ValidateSet('snowluma', 'napcat', 'list')]
    [string]$Kind = 'list',
    [string]$To = '',
    [string]$Mirror = '',
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# 每个条目：镜像链（按顺序试）、期望的 SHA256、解压后应该出现的标志文件
$Catalog = @{
    snowluma = @{
        title = 'SnowLuma v2.4.2（OneBot v11 协议端，Windows x64）'
        file  = 'SnowLuma-v2.4.2-win-x64.zip'
        sha256 = '0912926c5e73260f35b000278a8658493fc9452f36782c32fa86f0e825bad81a'
        mark  = 'package.json'
        urls  = @(
            'https://github.com/juju114514/snowluma-mirror/releases/download/v2.4.2/SnowLuma-v2.4.2-win-x64.zip',
            'https://github.com/TomyJan/SnowLuma/releases/download/v2.4.2/SnowLuma-v2.4.2-win-x64.zip',
            'https://github.com/zhx57/SnowLuma/releases/download/v2.4.2/SnowLuma-v2.4.2-win-x64.zip',
            'https://github.com/venti1112/snowluma/releases/download/v2.4.2/SnowLuma-v2.4.2-win-x64.zip'
        )
    }
    napcat = @{
        title = 'NapCat v4.18.42（NTQQ 协议端，Windows Shell + Node）'
        file  = 'NapCat.Shell.Windows.Node.zip'
        sha256 = '77397ac38d66f46383e48f08f35d5f9d37ec575c22069f62d6c600e73b4521ed'
        mark  = 'napcat.mjs'
        urls  = @(
            'https://github.com/juju114514/napcat-mirror/releases/download/v4.18.42/NapCat.Shell.Windows.Node.zip',
            'https://github.com/19901115/NapCatQQ/releases/download/v4.18.42/NapCat.Shell.Windows.Node.zip',
            'https://github.com/talentestors/NapCatQQ/releases/download/v4.18.42/NapCat.Shell.Windows.Node.zip'
        )
    }
}

function Write-Step($m) { Write-Host "  $m" }

if ($Kind -eq 'list') {
    Write-Host ''
    Write-Host '  可用网关安装包（上游已下架，这里走社区镜像）' -ForegroundColor Cyan
    foreach ($k in $Catalog.Keys) {
        $c = $Catalog[$k]
        Write-Step ("{0,-9} {1}" -f $k, $c.title)
        Write-Step ("          文件 {0}  sha256 {1}" -f $c.file, $c.sha256.Substring(0, 16) + '…')
        foreach ($u in $c.urls) { Write-Step "          镜像 $u" }
    }
    Write-Host ''
    Write-Host '  用法：scripts\fetch-gateway.ps1 -Kind snowluma -To D:\QQBot\snowluma' -ForegroundColor DarkGray
    exit 0
}

$c = $Catalog[$Kind]
if (-not $To) { $To = Join-Path (Get-Location).Path 'gateway' }

Write-Host ''
Write-Host "  目标：$($c.title)" -ForegroundColor Cyan
Write-Step "解压到：$To"
Write-Step "文件：$($c.file)"

$urls = @()
if ($Mirror) { $urls += $Mirror }
$urls += $c.urls

if ($DryRun) {
    Write-Step '计划（DryRun）：'
    foreach ($u in $urls) { Write-Step "  尝试 $u" }
    Write-Step "  校验 sha256 = $($c.sha256)"
    Write-Step "  解压到 $To（应出现 $($c.mark)）"
    exit 0
}

if ((Test-Path $To) -and -not $Force) {
    $existing = Get-ChildItem $To -Force -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existing) {
        Write-Step "✗ 目标目录非空：$To"
        Write-Step '  网关可能正在运行，直接覆盖会打断它。确认要覆盖请加 -Force，或换 -To。'
        exit 2
    }
}
New-Item -ItemType Directory -Force -Path $To | Out-Null

$tmp = Join-Path ([IO.Path]::GetTempPath()) $c.file
$ok = $false
foreach ($u in $urls) {
    Write-Step "下载 $u"
    if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    $code = & curl.exe -sS -L --fail --connect-timeout 20 --max-time 900 -o $tmp $u 2>&1
    if (-not (Test-Path $tmp)) { Write-Step '  × 没拿到文件，换下一个镜像'; continue }
    $h = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $c.sha256) {
        Write-Step "  × SHA256 不匹配（$($h.Substring(0,16))…），换下一个镜像"
        continue
    }
    Write-Step '  ✓ 下载完成，SHA256 一致'
    $ok = $true
    break
}
if (-not $ok) {
    Write-Step '✗ 所有镜像都失败。可以：'
    Write-Step ' 1) 自行找镜像后用 -Mirror <直链>'
    Write-Step ' 2) 或手动下载 zip 后直接解压到目标目录'
    exit 1
}

Write-Step '解压…'
Expand-Archive -LiteralPath $tmp -DestinationPath $To -Force
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

$mark = Get-ChildItem $To -Recurse -Filter $c.mark -ErrorAction SilentlyContinue | Select-Object -First 1
if ($mark) { Write-Step "✓ 完成：$($mark.FullName)" }
else { Write-Step "⚠ 解压完成，但没找到 $($c.mark)，请检查压缩包结构" }

Write-Step ''
Write-Step '下一步：'
Write-Step '  1) 按 docs/guides/GATEWAY.md 启动网关并扫码登录 QQ'
Write-Step '  2) 确认 config.json 的 gateway.httpUrl/wsUrl 指向它（SnowLuma 默认 :3000/:3001，NapCat 默认 :6199）'
Write-Step '  3) 网关起来后桥接会自动连上；连不上跑 node scripts/doctor-gateway.mjs'
exit 0
