#Requires -Version 5.1
<#
.SYNOPSIS
  qq-bridge 首次运行引导：体检 → 装依赖 → 生成/校验配置 → 装 DSH preset →（可选）启动。

.DESCRIPTION
  ============================ 契约（给接手的 AI 看） ============================
  定位：**一条命令走完"别人把仓库 clone 下来之后的全部准备动作"**。
  它自己不做判断，而是把每一步交给对应的权威工具，并在失败时给出文档锚点：

    步骤 1  环境体检      → node scripts/preflight.mjs        （只读）
    步骤 2  依赖          → npm install                        （--SkipNpm 可跳）
    步骤 3  配置          → 复制 config.example.json           （**绝不覆盖已有 config.json**）
    步骤 4  DSH preset    → node scripts/setup-dsh.mjs          （--SkipPreset 可跳）
    步骤 5  启动（可选）  → start-bridge.ps1                    （--Start 才做）

  不许做的事（设计不变量，测试会拦）：
    · **不启动、不安装、不停止 SnowLuma**（第三方程序；L6）
    · **不覆盖已存在的 config.json**（用户配置永远是用户的）
    · 不写任何密钥：config.json 来自 example，令牌由桥接首次启动自己生成
    · 不静默继续：任一步失败就停，并打印「下一步看哪一节」

  退出码：
    0  全部完成（或 DryRun 成功）
    1  某一步失败（输出里已给出原因 + 文档锚点）
    2  环境不满足（找不到 Node / Node 太旧 / 目录不对）
    3  用户放弃（交互式回答 n）

  幂等：重复跑是安全的 —— 依赖已装就跳过、config 已存在就不动、preset 安装本身幂等。

.EXAMPLE
  .\scripts\first-run.ps1 -DryRun
  # 只看会做什么（仍会跑只读体检），不装、不改、不启动

.EXAMPLE
  .\scripts\first-run.ps1
  # 正常走完 1~4 步，最后问你要不要启动

.EXAMPLE
  .\scripts\first-run.ps1 -NonInteractive -Start
  # 无人值守：全部默认，最后直接启动（适合脚本/远程装机）
#>
param(
  [switch]$DryRun,
  [switch]$SkipNpm,
  [switch]$SkipPreset,
  [switch]$Start,
  [switch]$NonInteractive,
  [string]$Root = '',
  [string]$Node = ''
)

$ErrorActionPreference = 'Continue'
if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
$Root = (Resolve-Path -LiteralPath $Root).Path

function Head($t) { Write-Host ''; Write-Host "  ── $t" -ForegroundColor Cyan }
function Ok($n, $d) { Write-Host ("  [OK]   {0,-14} {1}" -f $n, $d) -ForegroundColor Green }
function Wo($n, $d) { Write-Host ("  [WARN] {0,-14} {1}" -f $n, $d) -ForegroundColor Yellow }
function No($n, $d) { Write-Host ("  [FAIL] {0,-14} {1}" -f $n, $d) -ForegroundColor Red }
function Info($m) { Write-Host ("         $m") -ForegroundColor DarkGray }
function Next($m) { Write-Host ("         └─ 下一步：{0}" -f $m) -ForegroundColor Yellow }

function Find-NodeExe {
  if ($Node -and (Test-Path $Node)) { return $Node }
  if ($env:QQBOT_NODE -and (Test-Path $env:QQBOT_NODE)) { return $env:QQBOT_NODE }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  foreach ($c in @(
      (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
      (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
    )) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}
function Find-NpmCmd {
  $cmd = Get-Command npm -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  foreach ($c in @(
      (Join-Path $env:ProgramFiles 'nodejs\npm.cmd'),
      (Join-Path $env:APPDATA 'npm\npm.cmd')
    )) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}
function Confirm-Step($question) {
  if ($NonInteractive) { return $true }
  $answer = Read-Host ("         " + $question + " [Y/n]")
  if ([string]::IsNullOrWhiteSpace($answer)) { return $true }
  return ($answer -match '^(y|yes|是|好)')
}

Write-Host ''
Write-Host '  qq-bridge 首次运行引导' -ForegroundColor Cyan
Info "目录: $Root"
if ($DryRun) { Info '模式: DryRun（只体检 + 打印计划，不装不改不启动）' }

# ── 前置：目录与 Node ────────────────────────────────────────────────────
Head '前置检查'
if (-not (Test-Path (Join-Path $Root 'src\bridge.js'))) {
  No '目录' "这里不像仓库根目录（缺 src\bridge.js）：$Root"
  Next '把 -Root 指向 qq-bridge 仓库根，或在仓库根里运行本脚本'
  exit 2
}
$nodeExe = Find-NodeExe
if (-not $nodeExe) {
  No 'Node' '找不到 node.exe'
  Next '装 Node >= 22.13（官方安装包自带 npm）；或设 QQBOT_NODE 指向 node.exe'
  Next 'TROUBLESHOOTING.md#a1-找不到-node请先装-nodejs-22-lts'
  exit 2
}
$verText = (& $nodeExe -v) 2>$null
Ok 'Node' "$verText ($nodeExe)"
$verNum = [version](($verText -replace '^v', '') -replace '-.*$', '')
if ($verNum -lt [version]'22.13.0') {
  No 'Node 版本' "$verText 低于 22.13（没有内置 WebSocket）"
  Next 'TROUBLESHOOTING.md#a2-node-版本太低v18x需要--22130'
  exit 2
}

# ── 步骤 1：体检（只读，DryRun 也跑）─────────────────────────────────────
Head '步骤 1/5  环境体检（只读）'
$preflight = Join-Path $Root 'scripts\preflight.mjs'
$preflightOk = $false
if (Test-Path $preflight) {
  & $nodeExe $preflight --dir $Root
  $code = $LASTEXITCODE
  if ($code -eq 0 -or $code -eq 2) { $preflightOk = $true; Ok '体检' "通过（退出码 $code：0=全绿 2=仅 WARN）" }
  else {
    No '体检' "有 FAIL 项（退出码 $code）"
    Next '先按上面每条 FAIL 的「下一步」修；全新机器对照 docs/guides/FRESH-INSTALL.md'
    Next '修完重跑本脚本（幂等，已完成的步骤会跳过）'
    if ($DryRun) {
      # DryRun 也要如实反映环境状态：打印完计划后仍然以 1 退出，
      # 否则 CI/引导脚本会把「环境没准备好」当成成功。
      Info '（DryRun 仍以 1 退出：体检有 FAIL）'
    } else { exit 1 }
  }
} else {
  Wo '体检' '没有 scripts/preflight.mjs（仓库不完整？）'
}

if ($DryRun) {
  Head 'DryRun：接下来的计划'
  Info '2) npm install（若已装则跳过）'
  Info '3) 若无 config.json → 从 config.example.json 复制，然后交互式补 ownerQQ/白名单'
  Info '4) node scripts/setup-dsh.mjs（把 qq-chat / qq-chat-v2 preset 装进 DSH）'
  Info '5) 询问是否启动（等价 .\start-bridge.ps1）'
  Info ''
  Info '真跑：.\scripts\first-run.ps1'
  Write-Host ''
  if ($preflightOk) { exit 0 } else { exit 1 }
}

# ── 步骤 2：依赖 ─────────────────────────────────────────────────────────
Head '步骤 2/5  安装依赖'
$nm = Join-Path $Root 'node_modules'
if ($SkipNpm) { Wo '依赖' '按 -SkipNpm 跳过' }
elseif (Test-Path (Join-Path $nm 'js-yaml')) { Ok '依赖' '已安装，跳过' }
else {
  $npmCmd = Find-NpmCmd
  if (-not $npmCmd) {
    No 'npm' '找不到 npm（精简版/绿色版 Node 常见）'
    Next '装官方 Node（自带 npm）后重开终端；或临时补 PATH：$env:Path = "C:\Program Files\nodejs;" + $env:Path'
    Next 'TROUBLESHOOTING.md#a8-npm-本身不存在npm--无法将npm项识别为'
    exit 1
  }
  if (-not (Confirm-Step '现在执行 npm install？（可能需要几分钟）')) { No '依赖' '用户取消'; exit 3 }
  Push-Location $Root
  try {
    & $npmCmd install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      No 'npm install' "失败（退出码 $LASTEXITCODE）"
      Next 'TROUBLESHOOTING.md#a3-npm-install-卡住或超时 / #a4'
      exit 1
    }
  } finally { Pop-Location }
  if (-not (Test-Path (Join-Path $nm 'js-yaml'))) {
    No '依赖' '装完仍找不到 js-yaml'
    Next '删掉 node_modules 重装：TROUBLESHOOTING.md#a4'
    exit 1
  }
  Ok '依赖' '安装完成'
}

# ── 步骤 3：配置 ─────────────────────────────────────────────────────────
Head '步骤 3/5  配置 config.json'
$cfgPath = Join-Path $Root 'config.json'
$examplePath = Join-Path $Root 'config.example.json'
if (Test-Path $cfgPath) {
  Ok 'config.json' '已存在，**不做任何覆盖**'
  try {
    $cfgObj = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $cfgObj.ownerQQ) { Wo 'ownerQQ' '为空：审批/管理命令/closed-agent 不可用（见 TROUBLESHOOTING G1）' }
    if (-not ($cfgObj.allow.private + $cfgObj.allow.groups | Where-Object { $_ })) {
      Wo '白名单' '为空：不会响应任何消息（见 TROUBLESHOOTING E3）'
    }
  } catch {
    No 'config.json' "解析失败：$($_.Exception.Message)"
    Next 'TROUBLESHOOTING.md#a7-config-json-解析失败unexpected-utf-8-bom'
    exit 1
  }
} elseif (-not (Test-Path $examplePath)) {
  No 'config.example.json' '模板缺失，无法生成配置'
  Next '仓库不完整：重新 clone（A4）'
  exit 1
} else {
  Copy-Item $examplePath $cfgPath
  Ok 'config.json' '已从 config.example.json 生成'
  if (-not $NonInteractive) {
    Info '下面几项可以现在填，也可以稍后在控制台「访问与安全」页填：'
    $owner = Read-Host '         管理员 QQ（直接回车跳过）'
    if (-not [string]::IsNullOrWhiteSpace($owner) -and $owner -match '^\d{5,12}$') {
      $raw = Get-Content $cfgPath -Raw -Encoding UTF8
      $obj = $raw | ConvertFrom-Json
      $obj.ownerQQ = [int]$owner
      ($obj | ConvertTo-Json -Depth 10) | Set-Content $cfgPath -Encoding UTF8
      Ok 'ownerQQ' "已写入：$owner"
    } elseif (-not [string]::IsNullOrWhiteSpace($owner)) {
      Wo 'ownerQQ' '看起来不是 QQ 号（5~12 位数字），跳过；稍后手动填'
    }
    $groups = Read-Host '         允许的群号（逗号分隔，直接回车跳过）'
    if (-not [string]::IsNullOrWhiteSpace($groups)) {
      $list = @($groups -split '[,，\s]+' | Where-Object { $_ -match '^\d{5,12}$' })
      if ($list.Count) {
        $obj = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $obj.allow.groups = $list
        ($obj | ConvertTo-Json -Depth 10) | Set-Content $cfgPath -Encoding UTF8
        Ok 'allow.groups' ("已写入 {0} 个群" -f $list.Count)
      } else { Wo 'allow.groups' '没有合法群号，跳过' }
    }
  }
  Info '还需要手填：dsh.baseUrl（DSH 端口每次重启可能变）、snowluma.accessToken（SnowLuma WebUI 里的）'
}

# ── 步骤 4：DSH preset ───────────────────────────────────────────────────
Head '步骤 4/5  DSH preset'
$setupDsh = Join-Path $Root 'scripts\setup-dsh.mjs'
if ($SkipPreset) { Wo 'preset' '按 -SkipPreset 跳过' }
elseif (-not (Test-Path $setupDsh)) { Wo 'preset' '没有 scripts/setup-dsh.mjs，跳过'; Next 'TROUBLESHOOTING.md#c3b' }
else {
  if (-not (Confirm-Step '现在把 qq-chat / qq-chat-v2 preset 装进 DSH？')) { Wo 'preset' '跳过（AI 行为会不正常，见 TROUBLESHOOTING C3b）' }
  else {
    Push-Location $Root
    try {
      & $nodeExe $setupDsh
      if ($LASTEXITCODE -ne 0) {
        Wo 'preset' "安装脚本退出码 $LASTEXITCODE（DSH 没装/没登录时会这样）"
        Next 'TROUBLESHOOTING.md#c3b-dshreadyt好但工具不对--行为像没接-qqpreset-没装'
        Next 'docs/guides/DSH_SETUP.md'
      } else { Ok 'preset' '已安装（幂等，可重复跑）' }
    } finally { Pop-Location }
  }
}

# ── 步骤 5：启动（可选）─────────────────────────────────────────────────
Head '步骤 5/5  启动'
$launcher = Join-Path $Root 'start-bridge.ps1'
$doStart = $Start
if (-not $doStart -and -not $NonInteractive) {
  if (Test-Path $launcher) { $doStart = Confirm-Step '现在启动桥接？' }
}
if (-not $doStart) {
  Wo '启动' '跳过。手动启动：.\start-bridge.ps1'
} elseif (-not (Test-Path $launcher)) {
  Wo '启动' '没有 start-bridge.ps1，手动：node src\bridge.js'
} else {
  Info '提示：SnowLuma 必须自己启动并登录（本项目不代启，设计不变量 L6）'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher
}

Write-Host ''
Write-Host '  首次运行引导结束' -ForegroundColor Cyan
Info '控制台: http://127.0.0.1:3100  （令牌在 state\console-token）'
Info '状态:   .\start-bridge.ps1 -Status'
Info '体检:   node scripts/preflight.mjs'
Info '遇到问题: TROUBLESHOOTING.md / docs/guides/FRESH-INSTALL.md'
Write-Host ''
exit 0
