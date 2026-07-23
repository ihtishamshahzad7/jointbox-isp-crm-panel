@echo off
REM ── Jointbox: start backend + frontend together ──────────────
echo Starting Jointbox...

start "Jointbox Backend"  cmd /k "cd /d ""F:\Jointbox panel\backend""  && npm run start:dev"
start "Jointbox Frontend" cmd /k "cd /d ""F:\Jointbox panel\frontend"" && npm run dev"

echo.
echo Two windows opened (Backend + Frontend).
echo   Admin panel : http://localhost:3000   or  http://192.168.51.253:3000
echo   Portal      : http://localhost:3000/portal
echo   Backend API : http://localhost:3001
echo.
echo Close those two windows to stop the servers.
