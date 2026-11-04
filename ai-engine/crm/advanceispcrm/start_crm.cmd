@echo off
cd /d "%~dp0"
echo Starting ISP CRM at http://localhost:3000
echo Keep this window open while using the CRM.
python ispcrm.py
if errorlevel 1 pause
