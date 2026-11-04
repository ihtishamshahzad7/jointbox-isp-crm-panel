@echo off
rem No-admin fallback, started at sign-in by the "ISP CRM (user)" task.
rem Starts the portable PostgreSQL in %LOCALAPPDATA%\PostgreSQL16, then keeps the CRM running.
rem setup_remote.ps1 replaces this with Windows services.
cd /d "%~dp0.."
if not exist "%~dp0logs" mkdir "%~dp0logs"
"%LOCALAPPDATA%\PostgreSQL16\pgsql\bin\pg_ctl.exe" -D "%LOCALAPPDATA%\PostgreSQL16\data" -l "%LOCALAPPDATA%\PostgreSQL16\server.log" -w start >nul 2>&1
:loop
"%LOCALAPPDATA%\Programs\Python\Python312\python.exe" ispcrm.py >> "%~dp0logs\crm.log" 2>&1
timeout /t 10 /nobreak > nul
goto loop
