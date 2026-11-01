@echo off
rem ============================================================
rem ============================================================
setlocal
set "ROOT=%~dp0.."
set "PROFILE=%ROOT%\state\t2i-sidecar-profile"

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%EDGE%" (
  echo [t2i] Edge/Chrome not found
  exit /b 1
)

if not exist "%PROFILE%" mkdir "%PROFILE%"

start "t2i-sidecar" /min "%EDGE%" ^
  --headless=new --no-sandbox --disable-gpu --hide-scrollbars ^
  --remote-debugging-port=9222 ^
  --remote-allow-origins=* ^
  --user-data-dir="%PROFILE%" ^
  --no-first-run --no-default-browser-check --disable-extensions ^
  --disable-background-networking --disable-sync --disable-component-update ^
  about:blank

echo [t2i] sidecar started athttp://127.0.0.1:9222
endlocal
