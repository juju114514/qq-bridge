#Requires -Version 5.1
<#
.SYNOPSIS
  探测哪个浏览器能被 yt-dlp 读出可用 cookie，并用它试跑一次视频抽取。

.DESCRIPTION
  抖音/小红书这类站点要求 fresh cookies。能不能读出来取决于浏览器版本和是否在运行：
    · Chrome/Edge 127+ 用 app-bound 加密 → yt-dlp 报 Failed to decrypt with DPAPI
    · 浏览器正在运行 → cookie 库被锁 → Could not copy Chrome cookie database
    · Firefox 通常能读（本机可能没装）
  所以别猜，直接实测。

.PARAMETER Url
  要测的视频链接（默认是用户给的那条抖音分享短链）。

.PARAMETER Browsers
  依次尝试的浏览器（默认 edge, chrome, firefox）。

.PARAMETER YtDlp
  yt-dlp 路径（默认自动找 D:\QQBot\tts\Scripts\yt-dlp.exe 或 PATH）。

.EXAMPLE
  powershell -File scripts\probe-video-cookies.ps1
  powershell -File scripts\probe-video-cookies.ps1 -Url "https://v.douyin.com/xxx/" -Browsers firefox

.NOTES
  退出码：0 = 至少一个浏览器可用；1 = 都不可用（会打印下一步建议）。
#>
param(
  [string]$Url = 'https://v.douyin.com/9mapTsybjbY/',
  [string[]]$Browsers = @('edge', 'chrome', 'firefox'),
  [string]$YtDlp = ''
)

$ErrorActionPreference = 'Continue'

function Info([string]$m) { Write-Host "  $m" }
function Ok([string]$m) { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Bad([string]$m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }

if (-not $YtDlp) {
  $candidates = @(
    'D:\QQBot\tts\Scripts\yt-dlp.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\yt-dlp\yt-dlp.exe')
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { $YtDlp = $c; break }
  }
  if (-not $YtDlp) {
    $cmd = Get-Command yt-dlp -ErrorAction SilentlyContinue
    if ($cmd) { $YtDlp = $cmd.Source }
  }
}
if (-not $YtDlp) { Bad '找不到 yt-dlp（用 -YtDlp 指定路径）'; exit 1 }
Info "yt-dlp: $YtDlp"

$procNames = @{ edge = 'msedge'; chrome = 'chrome'; firefox = 'firefox' }
$exePaths = @{
  edge    = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
  chrome  = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
  firefox = 'C:\Program Files\Mozilla Firefox\firefox.exe'
}

Write-Host ''
Info "目标链接: $Url"
Write-Host ''

$found = ''
foreach ($b in $Browsers) {
  $procName = if ($procNames.ContainsKey($b)) { $procNames[$b] } else { $b }
  $running = [bool](Get-Process -Name $procName -ErrorAction SilentlyContinue | Select-Object -First 1)
  $ver = ''
  if ($exePaths.ContainsKey($b) -and (Test-Path -LiteralPath $exePaths[$b])) {
    $ver = (Get-Item -LiteralPath $exePaths[$b]).VersionInfo.ProductVersion
  }
  $tag = if ($running) { '运行中(可能锁库)' } else { '未运行' }
  $head = "== " + $b + "  [" + $tag + "]"
  if ($ver) { $head = $head + "  " + $ver }
  Write-Host $head

  # stderr 写文件：PowerShell 的 2>&1 会把原生命令 stderr 包成 ErrorRecord，
  # 输出里混进 "+ FullyQualifiedErrorId : NativeCommandError"，把真正那句 ERROR 盖掉。
  $stamp = [guid]::NewGuid().ToString('N').Substring(0, 8)
  $outFile = Join-Path $env:TEMP "ytdlp-$stamp.out"
  $errFile = Join-Path $env:TEMP "ytdlp-$stamp.err"
  & $YtDlp --no-warnings --no-progress --simulate --print "%(title)s | %(duration)ss | %(width)sx%(height)s" `
    --cookies-from-browser $b -- $Url 1> $outFile 2> $errFile
  $code = $LASTEXITCODE
  $stdout = ''
  $stderr = ''
  if (Test-Path -LiteralPath $outFile) { $stdout = [string](Get-Content -LiteralPath $outFile -Raw -Encoding UTF8) }
  if (Test-Path -LiteralPath $errFile) { $stderr = [string](Get-Content -LiteralPath $errFile -Raw -Encoding UTF8) }
  Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue

  if ($code -eq 0 -and $stdout.Trim()) {
    Ok (($stdout.Trim() -split "`r?`n") | Select-Object -Last 1)
    $found = $b
    break
  }
  $errLines = @(($stderr -split "`r?`n") | Where-Object { $_ -cmatch '^ERROR|could not|Failed to|not found' })
  if ($errLines.Count -gt 0) { Bad (($errLines | Select-Object -First 2) -join ' / ') }
  else { Bad ("退出码 " + $code + "，无输出") }
}

Write-Host ''
if ($found) {
  Ok "可用的浏览器：$found"
  Info "写进 config.json：socialV2.media.video.links.cookiesFromBrowser = `"$found`""
  exit 0
}

Bad '所有浏览器都取不到可用 cookie'
Info '下一步（按成功率排序）：'
Info '  1) 完全退出浏览器（确认任务管理器里没有 msedge/chrome）再跑一次'
Info '  2) 浏览器扩展「Get cookies.txt LOCALLY」导出 douyin.com 的 cookies.txt，'
Info '     再把 socialV2.media.video.links.cookiesPath 指向它（本仓库支持，优先于 cookiesFromBrowser）'
Info '  3) 装 Firefox 登录一次抖音后重跑（Firefox 的 cookie 库不加密）'
Info '  4) 最省事：直接把视频文件发到 QQ'
exit 1
