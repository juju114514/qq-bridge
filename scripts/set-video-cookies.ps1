#Requires -Version 5.1
<#
.SYNOPSIS
  把一份导出的 cookies.txt 接进视频链接管线，并用它试跑一次抽取。

.DESCRIPTION
  为什么需要这个脚本：抖音/小红书要求 fresh cookies，而 Chrome/Edge 127+ 的 app-bound 加密
  让 yt-dlp 的 `--cookies-from-browser` 直接失败（实测 156 版报 Failed to decrypt with DPAPI）。
  所以最可靠的路是**浏览器扩展导出 cookies.txt**：

    1) Edge/Chrome 装扩展「Get cookies.txt LOCALLY」
    2) 打开 douyin.com（已登录状态），点扩展 → Export → 存成 cookies.txt
    3) 跑本脚本：powershell -File scripts\set-video-cookies.ps1 -File D:\QQBot\temp\douyin-cookies.txt

  本脚本做四件事：
    · 校验文件形态（Netscape 格式、看起来属于目标站点、行数够）
    · 复制到 state\cookies\（**state 已被 .gitignore 排除**，cookie 不会进仓库）
    · 把 config.json 的 socialV2.media.video.links.cookiesPath 指过去
    · 立刻用 yt-dlp 试跑一次，打印是真能抽到还是还缺什么

.PARAMETER File
  导出的 cookies.txt 路径。

.PARAMETER Url
  用于试跑的视频链接（默认用户给的抖音短链）。

.PARAMETER Site
  期望的域名片段（默认 douyin.com）。

.EXAMPLE
  powershell -File scripts\set-video-cookies.ps1 -File D:\QQBot\temp\douyin-cookies.txt

.NOTES
  退出码：0 = 配置好且试跑成功；1 = cookies 无效/试跑失败；2 = 参数或环境问题。
#>
param(
  [Parameter(Mandatory = $true)][string]$File,
  [string]$Url = 'https://v.douyin.com/9mapTsybjbY/',
  [string]$Site = 'douyin.com',
  [string]$Root = ''
)

$ErrorActionPreference = 'Continue'

function Info([string]$m) { Write-Host "  $m" }
function Ok([string]$m) { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Bad([string]$m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }

if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }

# ── 1. 校验 cookies.txt ──────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $File)) { Bad "找不到文件：$File"; exit 2 }
$lines = @(Get-Content -LiteralPath $File -Encoding UTF8)
$dataLines = @($lines | Where-Object { $_ -and -not $_.StartsWith('#') })
Info "文件：$File（$($dataLines.Count) 条 cookie）"
if ($dataLines.Count -eq 0) { Bad '文件里没有 cookie 行（是不是导出了个空文件？）'; exit 1 }
if ($dataLines.Count -lt 3) { Bad "只有 $($dataLines.Count) 条，太少了 —— 抖音至少需要 ttwid 等几条"; exit 1 }

$hitSite = @($dataLines | Where-Object { $_ -match [regex]::Escape($Site) })
if ($hitSite.Count -eq 0) {
  Bad "文件里没有 $Site 的 cookie（导出时请在 $Site 页面上点导出）"
  Info '前两条域名示例：'
  $dataLines | Select-Object -First 2 | ForEach-Object { Info ('  ' + (($_ -split "`t")[0])) }
  exit 1
}
$isNetscape = @($dataLines | Where-Object { ($_ -split "`t").Count -ge 6 }).Count -ge 1
if (-not $isNetscape) { Bad '不是 Netscape 格式（每行应有 7 个 tab 分隔字段）'; exit 1 }
Ok "形态看起来对（含 $($hitSite.Count) 条 $Site cookie，Netscape 格式）"

# ── 2. 复制进 state（不进仓库）─────────────────────────────────────────────
$destDir = Join-Path $Root 'state\cookies'
New-Item -ItemType Directory -Path $destDir -Force | Out-Null
$dest = Join-Path $destDir 'site-cookies.txt'
# 关键：**去掉 BOM、统一成 LF**。yt-dlp 用严格解析，带 BOM 的文件会直接报
# "does not look like a Netscape format cookies file"（实测：PowerShell 的
# Set-Content -Encoding UTF8 在 5.1 下会写 BOM，导出的文件也常见 BOM）。
$clean = ($dataLines -join "`n") + "`n"
[IO.File]::WriteAllText($dest, "# Netscape HTTP Cookie File`n" + $clean, (New-Object Text.UTF8Encoding($false)))
$bom = [IO.File]::ReadAllBytes($dest)[0..2] -join ','
Ok "已复制到 $dest（去 BOM、LF；state 已被 .gitignore 排除，不会进仓库）"

# 顺便确认真的被忽略：免得哪天 state 规则被改，cookie 跟着提交上去
$git = @('D:\Git\cmd\git.exe', 'git.exe') | Where-Object {
  if ($_ -like '*\*') { Test-Path -LiteralPath $_ } else { Get-Command $_ -ErrorAction SilentlyContinue }
} | Select-Object -First 1
if ($git) {
  $ignored = & $git -C (Split-Path -Parent $destDir) check-ignore $dest 2>$null
  if (-not $ignored) { Bad "⚠ state\cookies 没被 git 忽略！提交前务必确认（cookie 等于账号）" }
  else { Info '已确认：这个路径被 .gitignore 忽略' }
}

# ── 3. 写 config.json ────────────────────────────────────────────────────
$cfgPath = Join-Path $Root 'config.json'
if (-not (Test-Path -LiteralPath $cfgPath)) { Bad "找不到 $cfgPath"; exit 2 }
Copy-Item -LiteralPath $cfgPath -Destination ($cfgPath + '.bak-cookies-') -Force -ErrorAction SilentlyContinue
try {
  $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $cfg.socialV2) { $cfg | Add-Member -NotePropertyName socialV2 -NotePropertyValue ([pscustomobject]@{}) -Force }
  if (-not $cfg.socialV2.media) { $cfg.socialV2 | Add-Member -NotePropertyName media -NotePropertyValue ([pscustomobject]@{}) -Force }
  if (-not $cfg.socialV2.media.video) { $cfg.socialV2.media | Add-Member -NotePropertyName video -NotePropertyValue ([pscustomobject]@{}) -Force }
  if (-not $cfg.socialV2.media.video.links) { $cfg.socialV2.media.video | Add-Member -NotePropertyName links -NotePropertyValue ([pscustomobject]@{}) -Force }
  $cfg.socialV2.media.video.links | Add-Member -NotePropertyName cookiesPath -NotePropertyValue $dest -Force
  $cfg.socialV2.media.video.links | Add-Member -NotePropertyName cookiesFromBrowser -NotePropertyValue '' -Force
  $json = $cfg | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($cfgPath, $json + "`n", (New-Object Text.UTF8Encoding($false)))
  Ok "config.json 已设 links.cookiesPath（并清空 cookiesFromBrowser，避免两条路打架）"
} catch {
  Bad "写 config.json 失败：$($_.Exception.Message)"
  exit 2
}

# ── 4. 试跑一次 ──────────────────────────────────────────────────────────
$ytdlp = ''
foreach ($c in @('D:\QQBot\tts\Scripts\yt-dlp.exe')) { if (Test-Path -LiteralPath $c) { $ytdlp = $c; break } }
if (-not $ytdlp) { $cmd = Get-Command yt-dlp -ErrorAction SilentlyContinue; if ($cmd) { $ytdlp = $cmd.Source } }
if (-not $ytdlp) { Bad '找不到 yt-dlp'; exit 2 }

Info "试跑（yt-dlp --cookies …）: $Url"
$stamp = [guid]::NewGuid().ToString('N').Substring(0, 8)
$outFile = Join-Path $env:TEMP "cookies-$stamp.out"
$errFile = Join-Path $env:TEMP "cookies-$stamp.err"
& $ytdlp --no-warnings --no-progress --simulate --print "%(title)s | %(duration)ss | %(width)sx%(height)s" `
  --cookies $dest -- $Url 1> $outFile 2> $errFile
$code = $LASTEXITCODE
$stdout = if (Test-Path -LiteralPath $outFile) { [string](Get-Content -LiteralPath $outFile -Raw -Encoding UTF8) } else { '' }
$stderr = if (Test-Path -LiteralPath $errFile) { [string](Get-Content -LiteralPath $errFile -Raw -Encoding UTF8) } else { '' }
Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue

if ($code -eq 0 -and $stdout.Trim()) {
  Ok ("抽取成功：" + (($stdout.Trim() -split "`r?`n") | Select-Object -Last 1))
  Info '现在可以重启桥接（或直接调用 qq_open_video）——它会用这份 cookies 下载'
  exit 0
}
Bad '试跑失败'
$errLines = @(($stderr -split "`r?`n") | Where-Object { $_ -cmatch '^ERROR|could not|Failed to|not found' })
if ($errLines.Count -gt 0) { $errLines | Select-Object -First 3 | ForEach-Object { Info $_ } }
Info '可能原因：cookie 已过期（重新导出）/ 导出的不是 douyin.com / 这条视频需要登录'
exit 1
