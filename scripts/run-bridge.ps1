# 用计划任务/守护方式启动桥接：先找到 node，再进守护循环。
# 为什么需要：任务计划里的 PATH 往往不含 node（实测 `where node` 为空），
# 直接跑 start.bat 会 5 秒重启一次、永远起不来。
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)   # scripts/ 的上一级
Set-Location $dir

function Resolve-Node {
  if ($env:QQB_NODE -and (Test-Path $env:QQB_NODE)) { return $env:QQB_NODE }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe'
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  # DSH runtime 目录名带哈希时兜底扫描
  $rt = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path $rt) {
    $hit = Get-ChildItem $rt -Recurse -Filter node.exe -Depth 6 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

$node = Resolve-Node
$log = Join-Path $dir 'state\runner.log'
$stamp = { Get-Date -Format 'yyyy-MM-dd HH:mm:ss' }
if (-not $node) {
  "[$(& $stamp)] 找不到 node.exe：请设 QQB_NODE 或把 node 加进 PATH" | Out-File $log -Append -Encoding utf8
  exit 1
}
"[$(& $stamp)] 使用 node: $node" | Out-File $log -Append -Encoding utf8

while ($true) {
  "[$(& $stamp)] 启动 bridge" | Out-File $log -Append -Encoding utf8
  & $node 'src/bridge.js'
  $code = $LASTEXITCODE
  if ($code -eq 2) {
    "[$(& $stamp)] 已有实例在跑（code 2），退出守护" | Out-File $log -Append -Encoding utf8
    exit 2
  }
  "[$(& $stamp)] bridge 退出（code $code），5 秒后重启" | Out-File $log -Append -Encoding utf8
  Start-Sleep -Seconds 5
}