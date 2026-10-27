#Requires -Version 5.1
<#
.SYNOPSIS
  真机验证「视频理解」：给一个会话 key + 消息 id，跑一遍桥接的视频端点，打印结果（可选保存故事板）。

.DESCRIPTION
  为什么要有这个脚本：
    视频理解这条链路有 5 段（下载 → ffprobe → 抽帧拼图 → 抽音轨 → ASR），任何一段坏掉，
    模型看到的都只是「读不了」。用 curl 一条条试很痛苦，这里一步到位：
      · 自动从 state/ 读控制台令牌与会话 agentToken（reserved2 下工具通道要后者）
      · 打印 HTTP 状态、耗时、条目数、kind/mimeType/体积、说明文本（含转写或"没有转写的原因"）
      · -Out 指定路径时把故事板存成 jpg，方便人眼确认"抽的帧对不对"
      · 失败时打印服务端 JSON 错误体（不是只给一个状态码）

  典型用法：
    # 1) 先看这条消息到底有没有媒体、被认成什么
    node scripts/test-audit.mjs 之外，最快的办法是直接看 state：
    (Get-Content .\state\social-v2.json -Raw | ConvertFrom-Json).conversations.'private:123'.recentMessages |
      Where-Object media | Select-Object seq,messageId,media

    # 2) 拿 seq 或 messageId 验一条
    powershell -File scripts\verify-video-live.ps1 -Key "private:123456789" -MessageId 31 -Out D:\tmp\board.jpg

  退出码：0 = 拿到故事板或转写；1 = 服务端明确报错；2 = 环境问题（缺令牌/连不上/参数不对）
#>
param(
  [Parameter(Mandatory = $true)][string]$Key,
  [Parameter(Mandatory = $true)][string]$MessageId,
  [string]$Base = 'http://127.0.0.1:3100',
  [string]$Mode = '',
  [string]$Out = '',
  [string]$Root = ''
)

$ErrorActionPreference = 'Continue'
if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }

function Fail($msg) { Write-Host "  [FAIL] $msg" -ForegroundColor Red; exit 2 }
function Ok($msg) { Write-Host "  [OK]   $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "         $msg" -ForegroundColor DarkGray }

$tokenFile = Join-Path $Root 'state\console-token'
if (-not (Test-Path $tokenFile)) { Fail "找不到 $tokenFile（桥接没启动过？）" }
$token = (Get-Content $tokenFile -Raw).Trim()

# reserved2 下工具通道要会话级 agentToken；取不到就只用控制台令牌（可能出现 403）
$agent = ''
$v2File = Join-Path $Root 'state\social-v2.json'
if (Test-Path $v2File) {
  try {
    $v2 = Get-Content $v2File -Raw -Encoding UTF8 | ConvertFrom-Json
    $conv = $v2.conversations.$Key
    if ($conv -and $conv.agentToken) { $agent = [string]$conv.agentToken }
  } catch { }
}

$headers = @{ 'X-Console-Token' = $token }
if ($agent) { $headers['x-agent-token'] = $agent } else { Info '没取到 agentToken（工具通道可能 403；控制台通道通常仍可用）' }

$query = 'key=' + [uri]::EscapeDataString($Key) + '&messageId=' + [uri]::EscapeDataString($MessageId)
if ($Mode) { $query += '&mode=' + [uri]::EscapeDataString($Mode) }
$url = $Base.TrimEnd('/') + '/api/socialV2/video?' + $query

Write-Host ''
Info "GET $url"
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
  $resp = Invoke-WebRequest $url -Headers $headers -UseBasicParsing -TimeoutSec 300
  $sw.Stop()
  $json = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray()) | ConvertFrom-Json
} catch {
  $sw.Stop()
  $code = ''
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  $body = ''
  if ($_.Exception.Response) {
    try { $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream()); $body = $sr.ReadToEnd() } catch { }
  }
  Write-Host ("  [FAIL] HTTP $code（$([math]::Round($sw.Elapsed.TotalSeconds,1))s）") -ForegroundColor Red
  if ($body) { Info $body }
  exit 1
}

Ok ("HTTP " + $resp.StatusCode + "  耗时 " + [math]::Round($sw.Elapsed.TotalSeconds, 1) + "s  条目 " + @($json.images).Count)
$index = 0
$saved = 0
foreach ($item in @($json.images)) {
  $index++
  $kb = 0
  if ($item.data) { $kb = [math]::Round(([string]$item.data).Length / 1365, 0) }
  Write-Host ("  条目 #" + $index + "  kind=" + $item.kind + "  mime=" + $item.mimeType + "  约 " + $kb + "KB")
  if ($item.text) { foreach ($line in ([string]$item.text -split "`n")) { Info $line } }
  if ($Out -and $item.data -and $saved -eq 0) {
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllBytes($Out, [Convert]::FromBase64String([string]$item.data))
    Info "故事板已保存：$Out"
    $saved++
  }
}

if (@($json.images).Count -eq 0) {
  Write-Host '  [WARN] 这条消息里没有识别到视频/图片媒体' -ForegroundColor Yellow
  if ($json.note) { Info $json.note }
  exit 1
}
exit 0
