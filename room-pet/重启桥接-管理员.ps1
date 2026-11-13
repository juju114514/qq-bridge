# restart qq-bridge (needs admin)
$ErrorActionPreference = 'Continue'
Write-Host '==== restart qq-bridge ====' -ForegroundColor Cyan
$conn = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 3100 } | Select-Object -First 1
if ($conn) {
  Write-Host ("  kill pid=" + $conn.OwningProcess)
  try { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction Stop } catch { Write-Host ("  kill failed: " + $_.Exception.Message) -ForegroundColor Red }
}
Start-Sleep -Seconds 3
$still = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 3100 }
if ($still) { Write-Host '  port 3100 still busy, abort' -ForegroundColor Yellow; Read-Host 'press enter'; exit 1 }
Set-Location (Split-Path -Parent $PSScriptRoot)   # 本文件在 room-pet/ 里，仓库根是上一级
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Split-Path -Parent $PSScriptRoot) 'start-bridge.ps1')
Start-Sleep -Seconds 10
$new = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 3100 } | Select-Object -First 1
if ($new) { Write-Host ("  new pid=" + $new.OwningProcess) -ForegroundColor Green } else { Write-Host '  port 3100 down' -ForegroundColor Red }
Read-Host 'press enter to close'