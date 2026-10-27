#Requires -Version 5.1
<#
.SYNOPSIS
  qq-bridge 全功能自测（对着**活的**桥接跑，会真的往 owner 私聊发消息）。

.DESCRIPTION
  ============================ 契约（给接手的 AI 看） ============================
  用途：改完代码后想知道「到底哪些功能还活着」，跑这一个脚本即可。
  它不是 test-audit 的一部分 —— 那 43 套是离线的；这个需要活的桥接、活的 SnowLuma、
  活的 DSH，并且**会真的发 QQ 消息**。

  安全约束（改这个脚本时不许破坏）：
    1. **只向 config.json 的 ownerQQ 私聊发送**，永不向群发送（群侧只做只读查询）
    2. 只做可逆写：临时角色卡测完删除、注入上限改完还原
    3. 跳过破坏性接口：workspace/reset、session/reset、tokens/reset、slang/clear、
       socialV2/reset、preset/restore、restart —— 那些是运维操作，不是功能自测
    4. 发送数量受 -MaxSends 限制（默认 12），每步之间留间隔，避免撞开发额度

  AI 最容易踩的坑（本脚本已处理）：
    · **AI 可能处于暂停状态**：此时所有 v2 工具返回 403「AI 已暂停」。
      脚本会先查 `GET /api/socialV2/activity` 的 paused，默认自动解除（-KeepPaused 可关）。
    · **v2 工具通道要求会话级 agentToken**（不是控制台令牌），从
      `state/social-v2.json` 的 `conversations[key].agentToken` 取。
    · 参数名各不相同：`slang/query` 与 `tokens/turns` 要 `key`，`sticker-pick` 与
      `qzone-feeds` 是 POST，`self-image` 要 `key`。

  退出码：0 = 全通过；1 = 有失败项（详见输出与报告）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\live-full-test.ps1

.EXAMPLE
  .\scripts\live-full-test.ps1 -MaxSends 4 -KeepPaused   # 少发几条、不动暂停状态
#>
param(
  [string]$Base = 'http://127.0.0.1:3100',
  [int]$MaxSends = 12,
  [switch]$KeepPaused,
  [string]$Root = ''
)

$ErrorActionPreference = 'Continue'
if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
$tokenFile = Join-Path $Root 'state\console-token'
$cfgFile = Join-Path $Root 'config.json'
if (-not (Test-Path $tokenFile)) { Write-Host "  [FAIL] 找不到 $tokenFile（桥接没启动过？）"; exit 1 }
if (-not (Test-Path $cfgFile)) { Write-Host "  [FAIL] 找不到 config.json"; exit 1 }

$token = (Get-Content $tokenFile -Raw).Trim()
$cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
$owner = [string]$cfg.ownerQQ
if (-not $owner) { Write-Host '  [FAIL] config.json 没有 ownerQQ —— 无法做 QQ 侧测试（也不会向群发）'; exit 1 }
$key = 'private:' + $owner

# 会话级 agentToken（v2 工具通道要求；控制台令牌不够）
$agentToken = ''
$v2File = Join-Path $Root 'state\social-v2.json'
if (Test-Path $v2File) {
  $v2 = Get-Content $v2File -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($v2.conversations -and $v2.conversations.PSObject.Properties.Name -contains $key) {
    $agentToken = [string]$v2.conversations.$key.agentToken
  }
}

$H = @{ 'X-Console-Token' = $token }
$HA = @{ 'X-Console-Token' = $token; 'x-agent-token' = $agentToken }
$results = New-Object System.Collections.Generic.List[object]
$sendCount = 0
$skipped = 0

function Record($name, $method, $path, $ok, $detail) {
  $results.Add([pscustomobject]@{ name = $name; method = $method; path = $path; ok = [bool]$ok; detail = [string]$detail })
  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Host ("  [{0}] {1,-32} {2,-4} {3}" -f $mark, $name, $method, $detail) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
}

function CallJson($name, $method, $path, $body = $null, [switch]$Agent, [switch]$ExpectFail) {
  $headers = if ($Agent) { $HA } else { $H }
  $url = $Base + $path
  try {
    if ($null -ne $body) {
      $json = $body | ConvertTo-Json -Compress -Depth 6
      $r = Invoke-WebRequest $url -Method $method -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes($json)) -Headers $headers -UseBasicParsing -TimeoutSec 60
    } else {
      $r = Invoke-WebRequest $url -Method $method -Headers $headers -UseBasicParsing -TimeoutSec 60
    }
    $text = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
    $obj = $null; try { $obj = $text | ConvertFrom-Json } catch { }
    $okField = if ($obj -and $obj.PSObject.Properties.Name -contains 'ok') { [bool]$obj.ok } else { $true }
    $ok = ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) -and ($okField -or $ExpectFail)
    $flat = $text -replace '\s+', ' '
    Record $name $method $path $ok ("HTTP {0} · {1}" -f $r.StatusCode, $flat.Substring(0, [Math]::Min(96, $flat.Length)))
    return $obj
  } catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'ERR' }
    $msg = ''
    if ($_.Exception.Response) { try { $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream()); $msg = ($sr.ReadToEnd() -replace '\s+', ' ') } catch { } }
    $ok = $ExpectFail -and ($code -in 400, 403, 404, 415)
    Record $name $method $path $ok ("HTTP {0} · {1}" -f $code, $msg.Substring(0, [Math]::Min(96, $msg.Length)))
    return $null
  }
}

function CallRaw($name, $method, $path, $expectStatus = 200) {
  try {
    $r = Invoke-WebRequest ($Base + $path) -Method $method -Headers $H -UseBasicParsing -TimeoutSec 30
    Record $name $method $path ($r.StatusCode -eq $expectStatus) ("HTTP {0} · {1} 字节" -f $r.StatusCode, $r.RawContentLength)
    return $r
  } catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'ERR' }
    Record $name $method $path ($code -eq $expectStatus) ("HTTP {0}" -f $code)
    return $null
  }
}

function Skip($name, $path, $why) {
  # 跳过**不是失败**：撞到 -MaxSends 上限时不该把整轮判红（第一版就是这么写的，
  # 结果小额度跑一遍全是 FAIL，看起来像坏了）。
  $script:skipped++
  $results.Add([pscustomobject]@{ name = $name; method = 'POST'; path = $path; ok = $true; detail = "SKIP · $why" })
  Write-Host ("  [SKIP] {0,-32} POST {1}" -f $name, $why) -ForegroundColor DarkGray
}

function SendQq($name, $path, $body, [switch]$Console) {
  if ($script:sendCount -ge $MaxSends) { Skip $name $path '已达 -MaxSends 上限（未测）'; return $null }
  $script:sendCount++
  $r = CallJson $name 'POST' $path $body -Agent:(-not $Console)
  Start-Sleep -Seconds 4
  return $r
}

Write-Host ''
Write-Host '  ── 0. 前置：暂停状态 / 上游健康 ────────────────────────────' -ForegroundColor Cyan
$act = CallJson '查暂停状态' 'GET' '/api/socialV2/activity'
Write-Host ("       paused = " + $act.paused) -ForegroundColor DarkGray
if ($act.paused -and -not $KeepPaused) {
  $null = CallJson '解除暂停（否则 v2 工具全 403）' 'POST' '/api/socialV2/activity' @{ paused = $false }
  Start-Sleep -Seconds 1
} elseif ($act.paused) {
  Write-Host '       ⚠️ 保持暂停：下面所有 v2 工具调用都会 403（-KeepPaused 是你选的）' -ForegroundColor Yellow
}
$st = CallJson '运行状态' 'GET' '/api/status'
Write-Host ("       mode=$($st.mode) role=$($st.role) roleId=$($st.roleId) dsh=$($st.dshReady) ws=$($st.snowluma.connected) online=$($st.snowluma.accountOnline)") -ForegroundColor DarkGray

Write-Host ''
Write-Host '  ── 1. 只读接口 ────────────────────────────────────────────' -ForegroundColor Cyan
$null = CallRaw '控制台首页' 'GET' '/'
$null = CallRaw 'favicon' 'GET' '/favicon.ico' 204
$roles = CallJson '人格列表' 'GET' '/api/roles'
$null = CallJson '人格内容（id）' 'GET' '/api/roles/content?name=xiaojingyu'
$null = CallJson '会话列表' 'GET' '/api/sessions'
$null = CallJson '黑话库' 'GET' '/api/slang'
$null = CallJson '黑话查询' 'GET' ('/api/socialV2/slang/query?key=' + [uri]::EscapeDataString($key) + '&q=%E7%89%9B')
$null = CallJson '社交状态' 'GET' '/api/social'
$stickers = CallJson '表情库' 'GET' '/api/stickers'
$null = CallJson '用量汇总' 'GET' '/api/tokens/summary'
$null = CallJson '用量最近' 'GET' '/api/tokens/recent'
$null = CallJson '用量序列' 'GET' '/api/tokens/series'
$null = CallJson '用量回合' 'GET' ('/api/tokens/turns?key=' + [uri]::EscapeDataString($key))
$null = CallJson '白名单' 'GET' '/api/whitelist'
$null = CallJson '安全状态' 'GET' '/api/security'
$null = CallJson '预设清单' 'GET' '/api/presets'
$null = CallJson '模型设置' 'GET' '/api/dsh/model'
$null = CallJson '仿真提示词' 'GET' '/api/preset/sim-prompt'
$null = CallJson '提示词备份' 'GET' '/api/preset/sim-prompt/backups'
$null = CallJson '待办回答' 'GET' '/api/pending'
$null = CallJson '二代状态总表' 'GET' '/api/socialV2/states'
$null = CallJson '当前会话状态' 'GET' ('/api/socialV2/state?key=' + [uri]::EscapeDataString($key))
$null = CallJson '我的最近消息' 'GET' ('/api/socialV2/my-recent?key=' + [uri]::EscapeDataString($key))
$null = CallJson '记忆' 'GET' ('/api/socialV2/memory?key=' + [uri]::EscapeDataString($key))
$null = CallJson '语音库' 'GET' '/api/socialV2/voices'
$null = CallJson '工具日志' 'GET' '/api/socialV2/tool-log'
$null = CallJson '反馈列表' 'GET' '/api/socialV2/feedback'
$null = CallJson 'AI 自画像' 'GET' ('/api/socialV2/self-image?key=' + [uri]::EscapeDataString($key))
$null = CallJson '表情挑选' 'POST' '/api/socialV2/sticker-pick' @{ key = $key; mood = '笑死'; count = 2 } -Agent
$null = CallJson 'QQ 空间动态' 'POST' '/api/socialV2/qzone-feeds' @{ key = $key; pos = 0; num = 2 } -Agent

Write-Host ''
Write-Host '  ── 2. 守卫（应被拒的请求）──────────────────────────────────' -ForegroundColor Cyan
try {
  $r = Invoke-WebRequest ($Base + '/api/status') -UseBasicParsing -TimeoutSec 10
  Record '无令牌应 401' 'GET' '/api/status' $false ("HTTP {0}（本该 401）" -f $r.StatusCode)
} catch {
  $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'ERR' }
  Record '无令牌应 401' 'GET' '/api/status' ($code -eq 401) ("HTTP {0}" -f $code)
}
try {
  $r = Invoke-WebRequest ($Base + '/api/role') -Method Post -ContentType 'text/plain' -Body 'x' -Headers $H -UseBasicParsing -TimeoutSec 10
  Record '非 JSON 应 415' 'POST' '/api/role' ($r.StatusCode -eq 415) ("HTTP {0}" -f $r.StatusCode)
} catch {
  $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'ERR' }
  Record '非 JSON 应 415' 'POST' '/api/role' ($code -eq 415) ("HTTP {0}" -f $code)
}
$null = CallJson '非法模式应被拒' 'POST' '/api/mode' @{ mode = '不存在的模式' } -ExpectFail

Write-Host ''
Write-Host '  ── 3. 人格（含角色卡 CRUD）────────────────────────────────' -ForegroundColor Cyan
$null = CallJson '切人格：按 id' 'POST' '/api/role' @{ role = 'xiaojingyu' }
$null = CallJson '切人格：按显示名' 'POST' '/api/role' @{ role = '小鲸鱼（已测试）' }
$null = CallJson '切人格：不存在应 400' 'POST' '/api/role' @{ role = '根本不存在的卡' } -ExpectFail
$tmp = '自测临时卡-' + (Get-Date).ToString('HHmmss')
$created = CallJson '新建角色卡' 'POST' '/api/roles/create' @{ name = $tmp; content = "# 自测`n临时卡。" }
if ($created -and $created.id) {
  $null = CallJson '改角色卡内容' 'POST' '/api/roles/update' @{ name = $created.id; content = "# 自测`n改过。" }
  $null = CallJson '角色卡改名' 'POST' '/api/roles/rename' @{ from = $created.id; to = $tmp + '-改' }
  $null = CallJson '删除角色卡' 'POST' '/api/roles/delete' @{ name = $created.id }
}
$null = CallJson '注入上限（改 9000）' 'POST' '/api/roles/limit' @{ maxInjectChars = 9000 }
$null = CallJson '注入上限（还原 20000）' 'POST' '/api/roles/limit' @{ maxInjectChars = 20000 }
$null = CallJson '表情库同步' 'POST' '/api/stickers/sync' @{}
$null = CallJson 'state 权限复查' 'POST' '/api/security' @{ rehardenStateDir = $true }

Write-Host ''
Write-Host '  ── 4. 真实 QQ 动作（只发 owner 私聊）──────────────────────' -ForegroundColor Cyan
$t1 = SendQq '文本（控制台通道）' '/api/test-send' @{ kind = 'private'; id = $owner; message = '【自测】控制台文本通道 OK' } -Console
$null = SendQq '文本（v2 工具通道）' '/api/socialV2/send-message' @{ key = $key; messages = @('【自测】v2 工具通道 OK') }
$null = SendQq '分条（burst）' '/api/socialV2/send-burst' @{ key = $key; messages = @('【自测】分条 1/2', '【自测】分条 2/2') }
$sid = @($stickers.stickers)[0].id
$null = SendQq '发表情包' '/api/socialV2/send-sticker' @{ key = $key; stickerId = $sid }
$null = SendQq '拍一拍' '/api/socialV2/send-poke' @{ key = $key; targetUserId = $owner }
$null = SendQq '语音（TTS）' '/api/socialV2/say' @{ key = $key; text = '自测语音功能'; mood = '正常' } -Console

Write-Host ''
Write-Host '  ── 5. 媒体 / 外部 ────────────────────────────────────────' -ForegroundColor Cyan
if ($t1 -and $t1.message_id) {
  $null = CallJson '按 id 查消息详情' 'GET' ('/api/socialV2/message-detail?key=' + [uri]::EscapeDataString($key) + '&messageId=' + $t1.message_id)
}
$null = SendQq '点歌（真实下载 10 秒）' '/api/socialV2/song' @{ key = $key; name = '晴天'; seconds = 10 } -Console

Write-Host ''
Write-Host '  ── 汇总 ─────────────────────────────────────────────────' -ForegroundColor Cyan
$pass = @($results | Where-Object { $_.ok -and $_.detail -notlike 'SKIP*' }).Count
$fail = @($results | Where-Object { -not $_.ok }).Count
$skipCount = @($results | Where-Object { $_.detail -like 'SKIP*' }).Count
Write-Host ("  共 {0} 项：PASS {1} / FAIL {2} / SKIP {3}（本次真实发送 {4} 次，上限 {5}）" -f $results.Count, $pass, $fail, $skipCount, $sendCount, $MaxSends) `
  -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Yellow' })
if ($fail -gt 0) {
  $results | Where-Object { -not $_.ok } | ForEach-Object { Write-Host ("    - {0}（{1} {2}）: {3}" -f $_.name, $_.method, $_.path, $_.detail) -ForegroundColor Red }
}
$reportPath = Join-Path $Root 'state\func-test-report.json'
[pscustomobject]@{ at = (Get-Date).ToString('o'); base = $Base; total = $results.Count; pass = $pass; fail = $fail; skipped = $skipCount; sends = $sendCount; results = $results } |
  ConvertTo-Json -Depth 5 | Set-Content -Path $reportPath -Encoding UTF8
Write-Host ("  报告: {0}" -f $reportPath) -ForegroundColor DarkGray
Write-Host ''
if ($fail -gt 0) { exit 1 } else { exit 0 }
