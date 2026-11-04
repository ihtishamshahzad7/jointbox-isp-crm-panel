@echo off
cd /d "%~dp0"
echo ISP CRM - laptop hosted demo sharing
echo Keep this window running. The current link is saved in DEMO_LINK.txt.
python start_demo_share.py
if errorlevel 1 pause
