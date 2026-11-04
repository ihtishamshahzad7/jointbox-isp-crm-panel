@echo off
rem Started at boot by the "ISP CRM HTTPS" scheduled task (see setup_remote.ps1).
cd /d "%~dp0"
:loop
"%~dp0bin\caddy.exe" run --config "%~dp0Caddyfile.local" --adapter caddyfile >> "%~dp0logs\caddy.log" 2>&1
timeout /t 10 /nobreak > nul
goto loop
