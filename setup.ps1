# 配置向导：从 config.example.json 生成 config.json
# 用法：powershell -ExecutionPolicy Bypass -File .\setup.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$example = Join-Path $here 'config.example.json'
$target = Join-Path $here 'config.json'

Write-Host ''
Write-Host '════════ QQ ↔ DeepSeek Harness 配置向导 ════════' -ForegroundColor Cyan
Write-Host '这个机器人本身不存 DeepSeek 密钥，密钥在你自己的 DSH 里。' -ForegroundColor DarkGray
Write-Host ''

if (-not (Test-Path $example)) { Write-Host "找不到 config.example.json" -ForegroundColor Red; exit 1 }
if (Test-Path $target) {
    $ans = Read-Host "config.json 已存在，覆盖吗？(y/N)"
    if ($ans -notmatch '^[yY]') { Write-Host '已取消'; exit 0 }
}

$cfg = Get-Content $example -Raw -Encoding UTF8 | ConvertFrom-Json

function Ask($prompt, $default) {
    $v = Read-Host "$prompt$(if ($default) { " [$default]" })"
    if ([string]::IsNullOrWhiteSpace($v)) { return $default }
    return $v.Trim()
}

# 1) DSH
$dshUrl = Ask '1/4 DSH 地址（DSH 窗口里显示的 http 地址）' $cfg.dsh.baseUrl
$cfg.dsh.baseUrl = $dshUrl

# 可选：探测 DSH 是否在线
try {
    $probe = Invoke-WebRequest $dshUrl -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop
    Write-Host "   ✓ 能连到 DSH（HTTP $($probe.StatusCode)）" -ForegroundColor Green
} catch {
    Write-Host "   ⚠ 连不上 $dshUrl —— 先把 DSH 打开再试，或者确认端口" -ForegroundColor Yellow
}

# 2) SnowLuma
$ws = Ask '2/4 SnowLuma WebSocket 地址' $cfg.snowluma.wsUrl
$http = Ask '      SnowLuma HTTP 地址' $cfg.snowluma.httpUrl
$cfg.snowluma.wsUrl = $ws
$cfg.snowluma.httpUrl = $http
$token = Ask '      SnowLuma access token（WebUI 里复制，可留空）' ''
if ($token) { $cfg.snowluma.accessToken = $token }

# 3) 权限
$owner = Ask '3/4 你的 QQ 号（管理员，只有它能用管理命令）' ''
if ($owner -match '^\d{5,12}$') { $cfg.ownerQQ = [long]$owner } else { Write-Host '   ⚠ QQ 号格式不对，先留空，之后手改 config.json' -ForegroundColor Yellow }

$groups = Ask '      允许的群号（逗号分隔，留空=不放行任何群）' ''
$privates = Ask '      允许的私聊 QQ（逗号分隔，留空=不放行）' ''
if ($groups) { $cfg.allow.groups = @($groups -split '[,，\s]+' | Where-Object { $_ -match '^\d{5,12}$' } | ForEach-Object { [long]$_ }) }
if ($privates) { $cfg.allow.private = @($privates -split '[,，\s]+' | Where-Object { $_ -match '^\d{5,12}$' } | ForEach-Object { [long]$_ }) }

# 4) 模式
Write-Host ''
Write-Host '4/4 运行模式：' -ForegroundColor Cyan
Write-Host '   1 = chat        正常聊天（最简单）'
Write-Host '   2 = reserved2   二代仿真（会自己潜水/自己决定说不说话，需要模型支持工具调用）'
$modeAns = Ask '   选一个' '1'
$mode = if ($modeAns -eq '2') { 'reserved2' } else { 'chat' }
if ($mode -eq 'reserved2') {
    if (-not $cfg.PSObject.Properties['mode']) { $cfg | Add-Member -NotePropertyName mode -NotePropertyValue $mode }
    else { $cfg.mode = $mode }
}

# 控制台随机 token
$cfg.consoleToken = -join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })

$cfg | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $target -Encoding UTF8
Write-Host ''
Write-Host "✓ 已生成 $target" -ForegroundColor Green
Write-Host ''
Write-Host '下一步：npm start' -ForegroundColor Cyan
Write-Host '如果登录 QQ 的是小号，记得用你的大号给这个小号发消息测试。' -ForegroundColor DarkGray
Write-Host ''
