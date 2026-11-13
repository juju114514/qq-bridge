@echo off
cd /d "%~dp0"
start "" /min python "%~dp0server.py" 8796
timeout /t 2 >nul
start "" http://127.0.0.1:8796/