#Requires -Version 5.1
<#
.SYNOPSIS
  qq-bridge 一键启动：起守护 → 守护拉起桥接 → 打印状态。附带 stop / status / 开机自启。

.DESCRIPTION
  ============================ 契约（给接手的 AI 看） ============================
  这个脚本是**唯一推荐的人工入口**，它只做四件事：
      start（默认） 起 scripts\bridge-supervisor.ps1（守护），守护再去起 bridge.js
      -Stop         写 state\supervisor.stop，让守护优雅收尾（必要时兜底 kill）
      -Status       打印「谁在跑、哪个端口、SnowLuma 起没起」的一张表
      -InstallStartup / -RemoveStartup
                    注册/移除登录自启（计划任务 qq-bridge-supervisor，只对当前用户）

  依赖关系（别弄反）：
      start-bridge.ps1  →  scripts\bridge-supervisor.ps1  →  node src\bridge.js
      （SnowLuma 不在这条链上：它是第三方程序，用户自己启动；本脚本只探测 :3000/:3001）

  为什么需要守护：
      桥接是长跑进程，会因 DSH 重启/网络抖动/异常输入退出。裸跑 `node src\bridge.js`
      崩了没人管；守护负责退避重启、单实例、退出码分类（见 supervisor 的契约块）。

  退出码：
      0  已启动 / 已停止 / 状态打印完成
      1  -Stop 超时（守护没在 15 秒内收尾，兜底 kill 后仍失败）
      3  已有一个守护在跑（本脚本 -Start 时提示并打印状态）
      4  SnowLuma 未就绪（守护退出码透传）
      5  环境不满足（找不到 node / 缺 config.json）

.EXAMPLE
  .\start-bridge.ps1
  # 起守护（前台，日志直接看得到；Ctrl+C 会连桥接一起停）

.EXAMPLE
  .\start-bridge.ps1 -Hidden
  # 起守护并立刻返回（日志进 state\logs\supervisor.log 与 bridge.out.log）

.EXAMPLE
  .\start-bridge.ps1 -Status
  .\start-bridge.ps1 -Stop
  .\start-bridge.ps1 -InstallStartup      # 登录自动起（计划任务）
  .\start-bridge.ps1 -RemoveStartup
#>
param(
  [switch]$Hidden,
  [switch]$Stop,
  [switch]$Status,
  [switch]$InstallStartup,
  [switch]$RemoveStartup,
  [int]$WaitSnowlumaSec = 600,
  [string]$Node = '',
  # 启动前**自动拉起依赖**（SnowLuma / DSH）。opt-in：显式给这个开关，或 config.json 的
  # launcher.autoStartDeps=true。默认关闭 —— 见 RULES.md 的设计不变量 L6'。
  [switch]$StartDeps,
  # 结束时停一下，别让窗口一闪就没（双击快捷方式时传 -Pause）
  [switch]$Pause,
  # 强制不停（脚本/计划任务用）
  [switch]$NoPause
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateDir = Join-Path $Root 'state'
$LockFile = Join-Path $StateDir 'supervisor.lock'
$ChildPidFile = Join-Path $StateDir 'bridge.pid'
$StopFile = Join-Path $StateDir 'supervisor.stop'
$Supervisor = Join-Path $Root 'scripts\bridge-supervisor.ps1'
$TaskName = 'qq-bridge-supervisor'

function Ok($n, $d) { Write-Host ("  [OK]   {0,-18} {1}" -f $n, $d) -ForegroundColor Green }
function Wo($n, $d) { Write-Host ("  [WARN] {0,-18} {1}" -f $n, $d) -ForegroundColor Yellow }
function No($n, $d) { Write-Host ("  [FAIL] {0,-18} {1}" -f $n, $d) -ForegroundColor Red }
function Info($m) { Write-Host ("         $m") -ForegroundColor DarkGray }

function Find-NodeExe {
  if ($Node -and (Test-Path $Node)) { return $Node }
  if ($env:QQBOT_NODE -and (Test-Path $env:QQBOT_NODE)) { return $env:QQBOT_NODE }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  foreach ($c in @(
      (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
      (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
    )) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}
function Test-TcpPort([int]$Port, [int]$TimeoutMs = 800) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($iar); return $true
  } catch { return $false } finally { $client.Close() }
}
function Read-Pid($file) {
  if (-not (Test-Path $file)) { return 0 }
  $n = 0
  if ([int]::TryParse(([string](Get-Content $file -Raw -ErrorAction SilentlyContinue)).Trim(), [ref]$n)) { return $n }
  return 0
}
function Test-Alive([int]$ProcessId) {
  if (-not $ProcessId) { return $false }
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}
function Get-SupervisorPid {
  if (-not (Test-Path $LockFile)) { return 0 }
  try { return [int](Get-Content $LockFile -Raw | ConvertFrom-Json).pid } catch { return 0 }
}

# ── 状态 ──────────────────────────────────────────────────────────────────
function Show-Status {
  Write-Host ''
  Write-Host '  qq-bridge 运行状态' -ForegroundColor Cyan
  Info "目录: $Root"

  $supPid = Get-SupervisorPid
  if ($supPid -and (Test-Alive $supPid)) { Ok '守护进程' "pid=$supPid（在跑）" }
  elseif ($supPid) { Wo '守护进程' "锁里写着 pid=$supPid，但进程已不在（残留锁）" }
  else { Wo '守护进程' '未运行' }

  $bridgePid = Read-Pid $ChildPidFile
  if ($bridgePid -and (Test-Alive $bridgePid)) { Ok '桥接进程' "pid=$bridgePid（在跑）" }
  else { Wo '桥接进程' '未运行' }

  if (Test-TcpPort 3100) {
    # 顺手取一次状态，失败也不影响
    $token = ''
    $tokenFile = Join-Path $StateDir 'console-token'
    if (Test-Path $tokenFile) { $token = (Get-Content $tokenFile -Raw).Trim() }
    try {
      $st = Invoke-RestMethod 'http://127.0.0.1:3100/api/status' -Headers @{ 'X-Console-Token' = $token } -TimeoutSec 6
      Ok '控制台 3100' "在听；mode=$($st.mode) role=$($st.role) dshReady=$($st.dshReady)"
      Ok '上游' "snowluma.connected=$($st.snowluma.connected) accountOnline=$($st.snowluma.accountOnline) 心跳=$($st.snowluma.lastPacketAgoMs)ms"
    } catch { Ok '控制台 3100' '在听（取状态失败：可能需要令牌）' }
  } else { Wo '控制台 3100' '没有监听（桥接没起来？）' }

  if ((Test-TcpPort 3000) -and (Test-TcpPort 3001)) { Ok 'SnowLuma' ':3000/:3001 在听' }
  else { Wo 'SnowLuma' ':3000/:3001 未就绪（第三方程序，需你自行启动并登录）' }

  if ((Test-TcpPort 3002) -or $false) { } # 占位：SnowLuma WS 用 3001，无 3002
  if (Test-TcpPort 5099) { Info 'SnowLuma WebUI :5099 在听（扫码登录用）' }

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Ok '登录自启' "计划任务 $TaskName = $($task.State)"
  } else {
    # 兜底安装走的是「启动文件夹里的 vbs」（不需要管理员），这里必须一起认，
    # 否则明明装好了却报「未注册登录自启」——用户会以为自启没生效。
    $vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'qq-bridge-supervisor.vbs'
    if (Test-Path $vbs) { Ok '登录自启' "启动文件夹：qq-bridge-supervisor.vbs" }
    else { Info '未注册登录自启（需要时装：.\start-bridge.ps1 -InstallStartup）' }
  }
  Write-Host ''
}

# ── 停止 ──────────────────────────────────────────────────────────────────
function Stop-All {
  Write-Host ''
  Write-Host '  停止 qq-bridge' -ForegroundColor Cyan
  $supPid = Get-SupervisorPid
  $bridgePid = Read-Pid $ChildPidFile
  if (-not (Test-Alive $supPid) -and -not (Test-Alive $bridgePid)) {
    Wo '状态' '没有在跑的守护或桥接'
    Remove-Item $StopFile, $LockFile, $ChildPidFile -Force -ErrorAction SilentlyContinue
    Write-Host ''
    return 0
  }
  # 先礼：写停止信号，等守护自己收尾
  Set-Content -Path $StopFile -Value ('stop requested at ' + (Get-Date).ToString('o')) -Encoding UTF8
  Info '已写停止信号，等守护收尾（最多 15 秒）…'
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-Alive (Get-SupervisorPid)) -and -not (Test-Alive (Read-Pid $ChildPidFile))) { break }
    Start-Sleep -Milliseconds 500
  }
  # 后兵：兜底 kill
  if (Test-Alive (Get-SupervisorPid)) { Stop-Process -Id (Get-SupervisorPid) -Force -ErrorAction SilentlyContinue; Wo '守护' '15 秒未收尾，已强杀' }
  if (Test-Alive (Read-Pid $ChildPidFile)) { Stop-Process -Id (Read-Pid $ChildPidFile) -Force -ErrorAction SilentlyContinue; Wo '桥接' '已强杀' }
  Start-Sleep -Seconds 1
  Remove-Item $StopFile, $LockFile, $ChildPidFile -Force -ErrorAction SilentlyContinue
  if (Test-TcpPort 3100) { No '停止' '端口 3100 仍在监听（可能有别的实例）'; Write-Host ''; return 1 }
  Ok '停止' '守护与桥接都已退出'
  Write-Host ''
  return 0
}

# ── 登录自启 ──────────────────────────────────────────────────────────────
function Install-Startup {
  $ps = (Get-Command powershell.exe).Source
  # ── 方案 A：计划任务（需要管理员）。注册后**必须回读验证** ——
  #    Register-ScheduledTask 是「非终止错误」，不加 -ErrorAction Stop 时
  #    权限不足只会打印一行红字，脚本照样往下走并报 OK（这坑踩过）。
  try {
    $action = New-ScheduledTaskAction -Execute $ps `
      -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Supervisor`"" `
      -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
      -Description 'qq-bridge supervisor: start bridge at logon (SnowLuma must be started separately)' `
      -Force -ErrorAction Stop | Out-Null
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    if (-not $task) { throw '注册后读不到任务' }
    Ok '登录自启' "已注册计划任务 $TaskName（状态=$($task.State)）"
    Info '它只拉起桥接；SnowLuma 仍由你自己启动（本项目不代启第三方程序）'
    return 0
  } catch {
    Wo '登录自启' "计划任务注册失败：$($_.Exception.Message)"
    Info '多半是没提权（计划任务需要管理员）。改用启动文件夹方案（无需提权）…'
  }

  # ── 方案 B：启动文件夹放一个 .vbs（无需管理员，等价效果）
  #
  # 为什么是 .vbs 而不是 .bat：
  #   .bat 由 cmd.exe 按**系统 OEM 代码页**读（中文系统是 936/GBK）。把含中文的仓库路径
  #   写进 .bat，只要编码对不上就会变成 `D:\<中文目录>???\...` —— 路径直接废掉，而且
  #   要到下次开机才发现（这个坑刚踩过，第一版就是 ASCII 写入的 .bat）。
  #   .vbs 由 WSH 读，支持 UTF-16LE，中文路径原样保留；顺便还没有黑窗闪现。
  try {
    $startupDir = [Environment]::GetFolderPath('Startup')
    if (-not $startupDir -or -not (Test-Path $startupDir)) { throw '找不到启动文件夹' }
    $file = Join-Path $startupDir 'qq-bridge-supervisor.vbs'

    # 用 Chr(34) 拼引号，而不是在 VBS 里写 ""。
    # 原因：VBScript 用 "" 表示字符串内的引号，PowerShell 双引号串里也用 "" 表示一个引号，
    # 两层叠在一起极易数错 —— 第一版就少写了一个闭合引号，生成出
    # 「未结束的字符串常量」，用户开机时会直接看到 VBScript 报错弹窗。
    # Chr(34) 把"我要一个引号"写成代码，生成时不需要任何转义推理。
    $runLine = 'CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & "' + $Supervisor + '" & Chr(34), 0, False'
    $vbs = @(
      "' Generated by start-bridge.ps1 -InstallStartup (Startup folder fallback, no admin needed)."
      "' It only supervises qq-bridge; SnowLuma must be started separately by the user."
      "' Written as UTF-16LE so non-ASCII paths survive (cmd.exe would mangle them)."
      $runLine
    ) -join "`r`n"
    Set-Content -Path $file -Value ($vbs + "`r`n") -Encoding Unicode -ErrorAction Stop
    if (-not (Test-Path $file)) { throw '写入后文件不存在' }
    # 顺手清掉历史上可能生成的 .bat（编码坏的版本），避免两份同时启动
    $staleBat = Join-Path $startupDir 'qq-bridge-supervisor.bat'
    if (Test-Path $staleBat) { Remove-Item $staleBat -Force -ErrorAction SilentlyContinue }
    Ok '登录自启' "已写入启动文件夹：$file"
    Info '它只拉起桥接；SnowLuma 仍由你自己启动（本项目不代启第三方程序）'
    Info '撤销：.\start-bridge.ps1 -RemoveStartup'
    return 0
  } catch {
    No '登录自启' "启动文件夹方案也失败：$($_.Exception.Message)"
    Info '可手动把 start-bridge.ps1 -Hidden 的快捷方式放进 shell:startup'
    return 1
  }
}

function Remove-Startup {
  $removed = 0
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop; Ok '登录自启' '已移除计划任务'; $removed += 1 }
    catch { Wo '登录自启' "移除计划任务失败（需要管理员）：$($_.Exception.Message)" }
  }
  $startupDir = [Environment]::GetFolderPath('Startup')
  foreach ($name in @('qq-bridge-supervisor.vbs', 'qq-bridge-supervisor.bat')) {
    $file = if ($startupDir) { Join-Path $startupDir $name } else { $null }
    if ($file -and (Test-Path $file)) {
      try { Remove-Item $file -Force -ErrorAction Stop; Ok '登录自启' "已删除启动文件夹条目：$name"; $removed += 1 }
      catch { No '登录自启' "删除 $name 失败：$($_.Exception.Message)" }
    }
  }
  if ($removed -eq 0) { Wo '登录自启' '没有注册过（计划任务与启动文件夹都没有）' }
  return 0
}

# ── 依赖自动启动（opt-in）──────────────────────────────────────────────────
# 为什么需要：双击桌面快捷方式时，最常卡住的是"SnowLuma 没起来"——桥接守护只探测、不代启，
# 于是一个窗口挂在那里等，用户看到的就是"启动不起来"。
#
# 为什么仍然默认关闭：SnowLuma 是第三方程序（许可边界见 NOTICE.md），代启会带来
# "它自己也在开机自启 → 起两份"的风险。所以这里做成**显式 opt-in**：
#   · 命令行 -StartDeps
#   · 或 config.json 里 launcher.autoStartDeps = true
# 而且**只启动、不安装、不停止、不改配置**；已经在跑的依赖一律跳过。
$DependencyDefaults = @(
  @{
    name = 'SnowLuma'
    command = 'D:\QQBot\snowluma\node.exe'
    args = 'index.mjs'
    cwd = 'D:\QQBot\snowluma'
    ports = @(3000, 3001)
    # 实测首启要 ~180s（含首屏/登录），留一倍余量；不要设太小，否则日志里全是"还没就绪"
    waitMs = 300000
  },
  @{
    name = 'DSH'
    command = 'D:\DEEPSEEK\DeepSeek Harness.exe'
    args = ''
    cwd = ''
    process = 'DeepSeek Harness'
    waitMs = 60000
  }
)

function Get-Deps {
  # 配置优先；没配或配置为空就用内置默认（本机路径）。
  $list = @()
  $cfgPath = Join-Path $Root 'config.json'
  if (Test-Path $cfgPath) {
    try {
      $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.launcher -and $cfg.launcher.deps) { $list = @($cfg.launcher.deps) }
    } catch { }
  }
  if (-not $list.Count) { return $DependencyDefaults }
  return $list
}

function Test-DepReady($dep) {
  if ($dep.ports -and @($dep.ports).Count) {
    foreach ($p in @($dep.ports)) { if (-not (Test-TcpPort ([int]$p))) { return $false } }
    return $true
  }
  if ($dep.process) { return [bool](Get-Process -Name $dep.process -ErrorAction SilentlyContinue) }
  return $false
}

function Start-Deps {
  Write-Host ''
  Write-Host '  依赖（opt-in 自动启动）' -ForegroundColor Cyan
  $deps = Get-Deps
  foreach ($dep in $deps) {
    $name = [string]$dep.name
    if (-not $name) { continue }
    if (Test-DepReady $dep) { Ok $name '已在运行，跳过'; continue }
    $cmd = [string]$dep.command
    if (-not $cmd -or -not (Test-Path $cmd)) {
      Wo $name "找不到可执行文件：$cmd"
      Info '  └─ 下一步：在 config.json 的 launcher.deps 里改 command，或手动启动它'
      continue
    }
    try {
      $argList = @()
      if ($dep.args) { $argList = @([string]$dep.args) }
      $sp = @{ FilePath = $cmd; ArgumentList = $argList; WindowStyle = 'Hidden'; PassThru = $true }
      if ($dep.cwd -and (Test-Path ([string]$dep.cwd))) { $sp.WorkingDirectory = [string]$dep.cwd }
      $proc = Start-Process @sp
      Info "已启动 $name（pid=$($proc.Id)），等它就绪…"
    } catch {
      Wo $name "启动失败：$($_.Exception.Message)"
      continue
    }
    $waitMs = if ([int]$dep.waitMs -gt 0) { [int]$dep.waitMs } else { 60000 }
    $deadline = (Get-Date).AddMilliseconds($waitMs)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
      if (Test-DepReady $dep) { $ready = $true; break }
      Start-Sleep -Milliseconds 1500
    }
    if ($ready) { Ok $name '已就绪' }
    else {
      Wo $name "等了 $([math]::Round($waitMs / 1000))s 还没就绪"
      Info '  └─ 下一步：SnowLuma 首启可能要扫码登录（WebUI :5099）。守护会继续等（每 60 秒探一次），登录后自动接上'
    }
  }
}

function Wait-Before-Exit {
  # 双击快捷方式时窗口一闪就没，用户看不到任何信息。
  # 默认**不停**（脚本/计划任务里调用不能卡住）；只在显式 -Pause 时停，-NoPause 优先。
  if (-not $Pause -or $NoPause) { return }
  if (-not [Environment]::UserInteractive) { return }
  try {
    Write-Host ''
    Write-Host '  按任意键关闭…' -ForegroundColor DarkGray
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
  } catch { }
}

# ── 主流程 ────────────────────────────────────────────────────────────────
if ($Status) { Show-Status; Wait-Before-Exit; exit 0 }
if ($Stop) { exit (Stop-All) }
if ($InstallStartup) { exit (Install-Startup) }
if ($RemoveStartup) { exit (Remove-Startup) }

# 默认：启动
if (-not (Test-Path $Supervisor)) { No '启动' "缺少 $Supervisor"; exit 5 }
$nodeExe = Find-NodeExe
if (-not $nodeExe) { No '启动' '找不到 node.exe（装 Node >= 22.13，或设 QQBOT_NODE）'; exit 5 }
if (-not (Test-Path (Join-Path $Root 'config.json'))) { No '启动' '缺少 config.json（先跑 .\setup.ps1）'; exit 5 }

# 依赖自动启动：显式开关或配置里打开才做（L6'）
$autoDeps = $StartDeps.IsPresent
if (-not $autoDeps) {
  try {
    $cfgLaunch = (Get-Content (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json).launcher
    if ($cfgLaunch -and $cfgLaunch.autoStartDeps -eq $true) { $autoDeps = $true }
  } catch { }
}
if ($autoDeps) { Start-Deps }

$supPid = Get-SupervisorPid
if ($supPid -and (Test-Alive $supPid)) {
  Wo '启动' "已有守护在跑（pid=$supPid），不重复启动"
  Show-Status
  Wait-Before-Exit
  exit 3
}

Remove-Item $StopFile -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host '  启动 qq-bridge' -ForegroundColor Cyan
Info "守护: $Supervisor"
Info "node: $nodeExe"
if ($autoDeps) {
  Info "等待 SnowLuma 上限: ${WaitSnowlumaSec}s（-StartDeps 已开启依赖自动启动：只启动，不安装不停止）"
} else {
  Info "等待 SnowLuma 上限: ${WaitSnowlumaSec}s（本脚本不代启 SnowLuma；要自动拉起加 -StartDeps）"
}
Write-Host ''

if ($Hidden) {
  $ps = (Get-Command powershell.exe).Source
  $args = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $Supervisor)
  if ($Node) { $args += @('-Node', $Node) }
  $args += @('-WaitSnowlumaSec', "$WaitSnowlumaSec")
  Start-Process -FilePath $ps -ArgumentList $args -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 3
  Show-Status
  Info '守护已在后台运行；看日志：state\logs\supervisor.log、state\logs\bridge.out.log'
  Wait-Before-Exit
  exit 0
}

# 前台：直接把守护跑在当前窗口（Ctrl+C 会停掉守护与桥接）
$fp = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Supervisor, '-Foreground', '-WaitSnowlumaSec', "$WaitSnowlumaSec")
if ($Node) { $fp += @('-Node', $Node) }
& (Get-Command powershell.exe).Source @fp
exit $LASTEXITCODE
