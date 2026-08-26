@echo off
REM ============================================================================
REM  Jointbox — start backend + frontend for local development.
REM
REM  WHY THIS APPLIES MIGRATIONS FIRST
REM  The SERVER already syncs its database on every deploy (update-jointbox.sh
REM  runs scripts/db-deploy.sh). Nothing did that locally: "npm run start:dev"
REM  regenerates the Prisma CLIENT but never touches the local DATABASE. So
REM  after pulling a change that adds a column, the client expected a column
REM  Postgres did not have, and the first query that touched it failed at
REM  runtime with an error that looks like a code bug instead of a stale schema.
REM
REM  Paths come from %~dp0 (this file's own folder), so the repo can be moved
REM  or cloned anywhere without editing this script.
REM ============================================================================
setlocal
cd /d "%~dp0"

echo.
echo  Applying any new database migrations...
echo.

pushd backend
call npx prisma migrate deploy
if errorlevel 1 goto migratefailed

REM Regenerate the client so the running code matches the schema just applied.
call npx prisma generate
if errorlevel 1 goto generatefailed
popd

echo.
echo  Database is up to date. Starting Jointbox...
echo.

start "Jointbox Backend"  cmd /k "cd /d ""%~dp0backend""  && npm run start:dev"
start "Jointbox Frontend" cmd /k "cd /d ""%~dp0frontend"" && npm run dev"

echo Two windows opened (Backend + Frontend).
echo   Admin panel : http://localhost:3000   or  http://192.168.51.253:3000
echo   Portal      : http://localhost:3000/portal
echo   Backend API : http://localhost:3001
echo.
echo Close those two windows to stop the servers.
goto :eof

:migratefailed
popd
echo.
echo  ****************************************************************
echo   MIGRATION FAILED - Jointbox was NOT started.
echo.
echo   Starting anyway would run new code against an old database,
echo   which fails later with an error that looks like a code bug.
echo.
echo   Common causes:
echo     * Postgres is not running, or DATABASE_URL in backend\.env
echo       points somewhere unreachable.
echo     * This database was first built with "prisma db push", so it
echo       has the tables but an empty migration history. Baseline it:
echo         cd backend
echo         npx prisma migrate resolve --applied 20260708101202_init
echo       ...then run this script again. The server does this
echo       baselining automatically via scripts\db-deploy.sh.
echo     * A migration conflicts with local schema edits - check
echo       "npx prisma migrate status".
echo  ****************************************************************
echo.
pause
exit /b 1

:generatefailed
popd
echo.
echo  ****************************************************************
echo   PRISMA GENERATE FAILED - Jointbox was NOT started.
echo   The migrations applied, but the client could not be rebuilt, so
echo   the code would not see the new columns. Fix the error above and
echo   run this script again.
echo  ****************************************************************
echo.
pause
exit /b 1
