#Requires -Version 5.1
<#
.SYNOPSIS
  版本兼容性检查：比对「当前环境」与 compat.json 里记录的被验证组合。

.DESCRIPTION
  检查项：
    · bridge 自身版本与 git commit（是否领先/落后于验证点）
    · Node 版本（require 下限）
    · DSH 版本（从 DeepSeek Harness.exe 的 FileVersion 读）
    · SnowLuma 版本（从其 package.json / release.json 读）
    · @snowluma/sdk 与 @snowluma/mcp 实际安装版本
    · @snowluma/sdk 的 postinstall 补丁是否已打

  退出码：0 完全匹配；1 有 WARN（可用但有差异）；2 有 FAIL（大概率报错）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\check-versions.ps1
#>
param(
  [string]$DshExe = "",
  [string]$SnowlumaHome = ""
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$warn = 0
$fail = 0
function Ok($n, $d) { Write-Host ("  [OK]   {0,-20} {1}" -f $n, $d) -ForegroundColor Green }
function Wo($n, $d) { Write-Host ("  [WARN] {0,-20} {1}" -f $n, $d) -ForegroundColor Yellow; $script:warn++ }
function No($n, $d) { Write-Host ("  [FAIL] {0,-20} {1}" -f $n, $d) -ForegroundColor Red;    $script:fail++ }
function Info($m)   { Write-Host ("         $m") -ForegroundColor DarkGray }

function Ver([string]$v) {
  if (-not $v) { return $null }
  $m = [regex]::Match($v, '\d+(\.\d+)*(-[0-9A-Za-z.\-]+)?')
  if (-not $m.Success) { return $null }
  return $m.Value
}

function CmpCore([string]$a, [string]$b) {
  # 只比数字段（忽略 -rc 后缀）；返回 -1/0/1
  $pa = ($a -split '[-+]')[0] -split '\.'
  $pb = ($b -split '[-+]')[0] -split '\.'
  $n = [Math]::Max($pa.Count, $pb.Count)
  for ($i = 0; $i -lt $n; $i++) {
    $x = if ($i -lt $pa.Count) { [int]$pa[$i] } else { 0 }
    $y = if ($i -lt $pb.Count) { [int]$pb[$i] } else { 0 }
    if ($x -lt $y) { return -1 }
    if ($x -gt $y) { return 1 }
  }
  return 0
}

function Satisfies([string]$actual, [string]$req) {
  if (-not $req) { return $true }
  $op = '>='
  $target = $req
  if ($req -match '^(>=|<=|>|<|=)\s*(.+)$') { $op = $Matches[1]; $target = $Matches[2] }
  $c = CmpCore (Ver $actual) (Ver $target)
  switch ($op) {
    '>=' { return $c -ge 0 }
    '<=' { return $c -le 0 }
    '>'  { return $c -gt 0 }
    '<'  { return $c -lt 0 }
    '='  { return $c -eq 0 }
  }
  return $true
}

Write-Host ""
Write-Host "版本兼容性检查" -ForegroundColor Cyan
Write-Host ("  目录: {0}" -f $Root) -ForegroundColor DarkGray
Write-Host ""

# ── compat.json ────────────────────────────────────────────────────────────
$compatPath = Join-Path $Root 'compat.json'
if (-not (Test-Path $compatPath)) {
  No 'compat.json' '缺失（本仓库应自带；你可以从上游重新拿一份）'
  $compat = @{ bridge = ''; testedWith = @{}; requires = @{} }
} else {
  try {
    $compat = [IO.File]::ReadAllText($compatPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    Ok 'compat.json' ("记录：bridge {0} / DSH {1} / SnowLuma {2}" -f $compat.bridge, $compat.testedWith.dsh, $compat.testedWith.snowluma)
  } catch {
    No 'compat.json' "解析失败：$($_.Exception.Message)"
    $compat = @{ bridge = ''; testedWith = @{}; requires = @{} }
  }
}

# ── 1. bridge 自身＋git ────────────────────────────────────────────────────
$pkgPath = Join-Path $Root 'package.json'
if (Test-Path $pkgPath) {
  $pkg = [IO.File]::ReadAllText($pkgPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($compat.bridge -and (Ver $pkg.version) -ne (Ver $compat.bridge)) {
    Wo 'bridge 版本' ("$($pkg.version) ≠ 验证点 $($compat.bridge)（上游更新过或你改了代码）")
  } else {
    Ok 'bridge 版本' ([string]$pkg.version)
  }
  # 依赖声明里的 sdk 范围
  $declaredSdk = $null
  if ($pkg.dependencies.'@snowluma/sdk') { $declaredSdk = [string]$pkg.dependencies.'@snowluma/sdk' }
  if ($declaredSdk) { Info ("package.json 声明 @snowluma/sdk " + $declaredSdk) }
}

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd -and (Test-Path (Join-Path $Root '.git'))) {
  $head = (& git -C $Root rev-parse --short HEAD 2>$null)
  $branch = (& git -C $Root rev-parse --abbrev-ref HEAD 2>$null)
  $dirty = (& git -C $Root status --porcelain 2>$null)
  if ($head) {
    $tag = (& git -C $Root describe --tags --always 2>$null)
    Ok 'git' ("{0}（{1}，{2}）" -f $head.Trim(), $branch.Trim(), $(if ($dirty) { '有未提交改动' } else { '干净' }))
    if ($dirty) { Info '有未提交改动时版本比对仅供参考；出问题先 commit 或 stash' }
  }
} else {
  Info '不在 git 仓库中（部署包/压缩包）——无法比对 commit'
}

# ── 2. Node ────────────────────────────────────────────────────────────────
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if ($p -and (Test-Path $p)) { $nodeExe = $p; break }
  }
  if (-not $nodeExe) {
    $n = Get-ChildItem (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes') -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match 'node[\\/]bin[\\/]node\.exe$' } | Select-Object -First 1
    if ($n) { $nodeExe = $n.FullName }
  }
}
if ($nodeExe) {
  $nodeVer = (& $nodeExe --version 2>$null).Trim().TrimStart('v')
  $req = [string]$compat.requires.node
  if ($req -and -not (Satisfies $nodeVer $req)) {
    No 'Node' ("$nodeVer 不满足 $req")
  } elseif ($compat.testedWith.node -and (CmpCore $nodeVer $compat.testedWith.node) -ne 0) {
    Wo 'Node' ("$nodeVer（验证点是 $($compat.testedWith.node)，能用但未验证）")
  } else {
    Ok 'Node' $nodeVer
  }
} else {
  No 'Node' '找不到 node'
}

# ── 3. DSH ─────────────────────────────────────────────────────────────────
if (-not $DshExe) {
  $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'DeepSeek' } | Select-Object -First 1
  if ($proc -and $proc.Path) { $DshExe = $proc.Path }
  elseif (Test-Path 'D:\DEEPSEEK\DeepSeek Harness.exe') { $DshExe = 'D:\DEEPSEEK\DeepSeek Harness.exe' }
}
if ($DshExe -and (Test-Path $DshExe)) {
  $dshVer = Ver ((Get-Item $DshExe).VersionInfo.FileVersion)
  $req = [string]$compat.requires.dsh
  if (-not $dshVer) {
    Wo 'DSH' '读不到版本号（可能是开发版/自定义构建）'
  } elseif ($req -and -not (Satisfies $dshVer $req)) {
    No 'DSH' ("$dshVer 不满足 $req —— 协议可能不兼容，升级 DSH 或回退本仓库版本")
  } elseif ($compat.testedWith.dsh -and (CmpCore $dshVer $compat.testedWith.dsh) -ne 0) {
    Wo 'DSH' ("$dshVer（验证点 $($compat.testedWith.dsh)：未验证，留意 inbox 投影 / 提示词变量变化）")
  } else {
    Ok 'DSH' $dshVer
  }
} else {
  Wo 'DSH' '没找到 DeepSeek Harness.exe（没装或不在默认路径）'
}

# ── 4. SnowLuma ────────────────────────────────────────────────────────────
if (-not $SnowlumaHome) {
  $cfgPath = Join-Path $Root 'config.json'
  if (Test-Path $cfgPath) {
    try {
      $cfg = [IO.File]::ReadAllText($cfgPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
      if ($cfg.snowluma.homeDir -and (Test-Path $cfg.snowluma.homeDir)) { $SnowlumaHome = $cfg.snowluma.homeDir }
    } catch { }
  }
  if (-not $SnowlumaHome) {
    $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*snowluma*index.mjs*' } | Select-Object -First 1
    if ($p -and $p.CommandLine -match '([A-Za-z]:\\[^"\s]*index\.mjs)') { $SnowlumaHome = Split-Path -Parent $Matches[1] }
  }
}
$slVer = $null
if ($SnowlumaHome) {
  foreach ($f in 'package.json','release.json') {
    $p = Join-Path $SnowlumaHome $f
    if (Test-Path $p) {
      try { $j = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8) | ConvertFrom-Json; if ($j.version) { $slVer = Ver $j.version; break } } catch { }
    }
  }
}
if ($slVer) {
  $req = [string]$compat.requires.snowluma
  if ($req -and -not (Satisfies $slVer $req)) {
    No 'SnowLuma' ("$slVer 不满足 $req")
  } elseif ($compat.testedWith.snowluma -and (CmpCore $slVer $compat.testedWith.snowluma) -ne 0) {
    Wo 'SnowLuma' ("$slVer（验证点 $($compat.testedWith.snowluma)）")
  } else {
    Ok 'SnowLuma' $slVer
  }
} else {
  Wo 'SnowLuma' '找不到版本文件（用 -SnowlumaHome 指定安装目录）'
}

# ── 5. 依赖版本 ────────────────────────────────────────────────────────────
$nm = Join-Path $Root 'node_modules'
# @snowluma/sdk 与 @snowluma/mcp 已于 2026-10-27 移除（改用自带的 src/onebot-ws.js），
# 因此不再检查它们的版本，也不再检查「sdk 补丁」—— 那是旧依赖才需要的东西。
$deps = [ordered]@{
  '@deepseek-ai/dsh-host-apiproxy' = 'dshHostApiproxy'
  '@deepseek-ai/schemastery'       = 'schemastery'
}
foreach ($name in $deps.Keys) {
  $p = Join-Path (Join-Path $nm ($name -replace '/', '\')) 'package.json'
  if (-not (Test-Path $p)) { No $name '未安装（先 npm install）'; continue }
  try { $v = Ver (([IO.File]::ReadAllText($p, [Text.Encoding]::UTF8) | ConvertFrom-Json).version) } catch { No $name '版本读取失败'; continue }
  $key = $deps[$name]
  $req = [string]$compat.requires.$key
  $tested = [string]$compat.testedWith.$key
  if ($req -and -not (Satisfies $v $req)) { No $name ("$v 不满足 $req") }
  elseif ($tested -and (CmpCore $v $tested) -ne 0) { Wo $name ("$v（验证点 $tested）") }
  else { Ok $name $v }
}

# ── 6. OneBot 客户端：自带实现是否就位（不再需要任何第三方补丁）─────────────
# 历史：旧版依赖 @snowluma/sdk，因为它发布的 dist 里相对导入缺 .js 扩展名，需要 postinstall
# 打补丁才能被纯 Node ESM 解析。现在协议层是本仓库的 src/onebot-ws.js（Node 内置 WebSocket），
# 所以这里检查两件事：文件在、且没有把 @snowluma/* 依赖又加回来。
$onebotWs = Join-Path $Root 'src\onebot-ws.js'
if (-not (Test-Path $onebotWs)) {
  No 'OneBot 客户端' '缺 src/onebot-ws.js（自带实现，不该被删）'
} else {
  Ok 'OneBot 客户端' 'src/onebot-ws.js（自带，无第三方补丁）'
}
foreach ($pkg in '@snowluma\sdk','@snowluma\mcp') {
  $p = Join-Path $nm (Join-Path $pkg 'package.json')
  if (Test-Path $p) { Wo "$pkg" '仍在 node_modules 里（已不依赖，可 npm prune 掉）' }
}

# ── 汇总 ───────────────────────────────────────────────────────────────────
Write-Host ""
if ($fail -eq 0 -and $warn -eq 0) {
  Write-Host "版本与验证点完全一致。" -ForegroundColor Green
  exit 0
}
if ($fail -eq 0) {
  Write-Host "有 $warn 项与验证点不同，但满足最低要求（可能正常，注意观察）。" -ForegroundColor Yellow
  Info '要把版本对齐到验证点：见 docs/OPERATIONS.md#供应链 与 SETUP.md'
  exit 1
}
Write-Host "有 $fail 项不满足最低要求，大概率会报错。" -ForegroundColor Red
Info '先对齐版本，再排查其它问题：docs/guides/SECURITY.md 不适用——看 TROUBLESHOOTING.md 的 J 段'
exit 2
