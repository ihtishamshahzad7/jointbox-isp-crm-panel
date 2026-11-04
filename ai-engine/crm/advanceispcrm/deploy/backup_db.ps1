# Daily PostgreSQL backup of the CRM database; keeps the newest 14 dumps.
# Run by the "ISP CRM Backup" scheduled task (see setup_remote.ps1), or by hand.
param([string]$Target = (Join-Path $PSScriptRoot 'backups'), [int]$Keep = 14)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$config = Get-Content (Join-Path $Root 'database.local.json') | ConvertFrom-Json
$dbname = if ($config.database) { $config.database } elseif ($config.dbname) { $config.dbname } else { 'ispcrm' }
$pgdump = @("$env:LOCALAPPDATA\PostgreSQL16\pgsql\bin\pg_dump.exe", 'C:\ProgramData\ispcrm\pgsql\bin\pg_dump.exe') +
    (Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue | ForEach-Object FullName) |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $pgdump) { throw 'pg_dump.exe not found.' }

New-Item -ItemType Directory -Force $Target | Out-Null
$file = Join-Path $Target ("$dbname-" + (Get-Date -Format 'yyyy-MM-dd_HHmm') + '.dump')
$env:PGPASSWORD = $config.password
& $pgdump -h $(if ($config.host) { $config.host } else { 'localhost' }) -p $(if ($config.port) { $config.port } else { 5432 }) `
    -U $(if ($config.user) { $config.user } else { 'postgres' }) -Fc -f $file $dbname
if ($LASTEXITCODE -ne 0) { Remove-Item $file -ErrorAction SilentlyContinue; throw "pg_dump failed ($LASTEXITCODE)." }
Get-ChildItem $Target -Filter "$dbname-*.dump" | Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep | Remove-Item
Write-Host "Backup written: $file"
