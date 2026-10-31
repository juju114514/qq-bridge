@echo off
rem qq-bridge launcher entry. ASCII only + CRLF on purpose:
rem cmd.exe misparses LF-only files and UTF-8 BOM, and non-ASCII text
rem breaks depending on the console code page. Chinese lives in launcher.mjs.
setlocal
cd /d "%~dp0"
set "NODEEXE="

if defined QQB_NODE if exist "%QQB_NODE%" set "NODEEXE=%QQB_NODE%"

if not defined NODEEXE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODEEXE set "NODEEXE=%%i"

if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

rem DSH bundles its own node runtime
if not defined NODEEXE for /d %%d in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do if not defined NODEEXE if exist "%%d\dependencies\node\bin\node.exe" set "NODEEXE=%%d\dependencies\node\bin\node.exe"

if not defined NODEEXE goto NONODE

"%NODEEXE%" "%~dp0scripts\launcher.mjs"
set RC=%ERRORLEVEL%
if not "%RC%"=="0" echo.
if not "%RC%"=="0" echo   (exit %RC%)
pause
exit /b %RC%

:NONODE
echo.
echo   [X] node not found.
echo.
echo   Options:
echo     1) Install Node 22+  https://nodejs.org/  then reopen this window
echo     2) Point QQB_NODE at any node.exe, e.g.
echo        setx QQB_NODE "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
echo     3) Run manually:  ^<node^> scripts\launcher.mjs
echo.
pause
exit /b 1