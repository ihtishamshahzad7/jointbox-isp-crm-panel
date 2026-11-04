@echo off
rem No-admin fallback, started at sign-in by the "ISP CRM Tunnel (user)" task.
rem Uses %USERPROFILE%\.cloudflared\config.yml; setup_remote.ps1 -Tunnel replaces this with the Cloudflared service.
if not exist "%~dp0logs" mkdir "%~dp0logs"
:loop
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --no-autoupdate run ispcrm >> "%~dp0logs\tunnel.log" 2>&1
timeout /t 10 /nobreak > nul
goto loop
