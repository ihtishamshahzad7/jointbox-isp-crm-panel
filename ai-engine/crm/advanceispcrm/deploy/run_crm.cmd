@echo off
rem Started at boot by the "ISP CRM" scheduled task (see setup_remote.ps1).
rem Restarts the CRM if it stops, e.g. when PostgreSQL is still starting after a reboot.
cd /d "%~dp0.."
:loop
"C:\Program Files\Python312\python.exe" ispcrm.py >> "%~dp0logs\crm.log" 2>&1
timeout /t 10 /nobreak > nul
goto loop
