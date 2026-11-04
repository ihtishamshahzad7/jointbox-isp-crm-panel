# One-time setup of the ISP CRM on an always-on Windows PC. Run in an Administrator PowerShell
# from the project folder, either with a static public IP (Caddy serves HTTPS; ports 80/443 forwarded):
#   powershell -ExecutionPolicy Bypass -File deploy\setup_remote.ps1 -PublicIP 203.0.113.10
# or with a Cloudflare Tunnel already created by `cloudflared tunnel login/create/route dns` (no port forwarding):
#   powershell -ExecutionPolicy Bypass -File deploy\setup_remote.ps1 -Tunnel
param([string]$PublicIP, [switch]$Tunnel)
$ErrorActionPreference = 'Stop'
$Deploy = $PSScriptRoot
$Root = Split-Path $Deploy -Parent
$Python = 'C:\Program Files\Python312\python.exe'
$Cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')) {
    throw 'Run this script from an Administrator PowerShell window.'
}
if ($Tunnel -eq [bool]$PublicIP) { throw 'Pass either -PublicIP <address> or -Tunnel.' }
if ($Tunnel) {
    $tunnelConfig = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
    if (-not (Test-Path $Cloudflared) -or -not (Test-Path $tunnelConfig)) { throw "Install cloudflared and create the tunnel first ($tunnelConfig not found)." }
} else {
    [void][Net.IPAddress]::Parse($PublicIP)
}
$config = Join-Path $Root 'database.local.json'
if (-not (Test-Path $config)) { throw 'Copy database.example.json to database.local.json and set a strong password first.' }
$password = (Get-Content $config | ConvertFrom-Json).password
if (-not $password) { throw 'database.local.json has no password.' }

Write-Host '1/7 Python 3.12'
if (-not (Test-Path $Python)) {
    winget install --id Python.Python.3.12 -e --scope machine --silent --accept-package-agreements --accept-source-agreements --override '/quiet InstallAllUsers=1 PrependPath=1'
}
& $Python -m pip install -q -r (Join-Path $Root 'requirements.txt')

# Services replace the no-admin sign-in tasks from install_user_autostart.ps1.
foreach ($name in 'ISP CRM (user)', 'ISP CRM Tunnel (user)') {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask $name; Unregister-ScheduledTask $name -Confirm:$false
    }
}
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host '2/7 PostgreSQL 16 (Windows service, starts automatically)'
# A portable PostgreSQL from an earlier no-admin install holds the existing CRM data;
# move it to a machine-wide folder and run it as a service instead of installing an empty one.
$portable = Join-Path $env:LOCALAPPDATA 'PostgreSQL16'
$pgHome = 'C:\ProgramData\ispcrm'
if (-not (Get-Service postgresql*, ispcrm-postgres -ErrorAction SilentlyContinue) -and (Test-Path "$portable\data\PG_VERSION")) {
    & "$portable\pgsql\bin\pg_ctl.exe" -D "$portable\data" status | Out-Null
    if ($LASTEXITCODE -eq 0) { & "$portable\pgsql\bin\pg_ctl.exe" -D "$portable\data" -m fast -w stop }
    robocopy "$portable\pgsql" "$pgHome\pgsql" /E /NFL /NDL /NJH /NJS /XD 'pgAdmin 4' symbols StackBuilder | Out-Null
    robocopy "$portable\data" "$pgHome\data" /E /NFL /NDL /NJH /NJS /XF postmaster.pid | Out-Null
    icacls "$pgHome\data" /grant '*S-1-5-20:(OI)(CI)F' /T /Q | Out-Null
    & "$pgHome\pgsql\bin\pg_ctl.exe" register -N ispcrm-postgres -U 'NT AUTHORITY\NetworkService' -D "$pgHome\data" -S auto
    Start-Service ispcrm-postgres
    Write-Host "Existing database moved to $pgHome (original left in $portable)."
}
if (-not (Get-Service postgresql*, ispcrm-postgres -ErrorAction SilentlyContinue)) {
    winget install --id PostgreSQL.PostgreSQL.16 -e --silent --accept-package-agreements --accept-source-agreements --override "--mode unattended --unattendedmodeui none --superpassword `"$password`" --serverport 5432 --disable-components stackbuilder"
}

New-Item -ItemType Directory -Force (Join-Path $Deploy 'logs') | Out-Null
if ($Tunnel) {
    Write-Host '3/7 Cloudflare Tunnel (Windows service)'
    # The service runs as SYSTEM, so give it its own copy of the config and credentials, readable only by admins.
    $cfHome = 'C:\ProgramData\ispcrm\cloudflared'
    New-Item -ItemType Directory -Force $cfHome | Out-Null
    icacls $cfHome /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
    $yaml = Get-Content $tunnelConfig -Raw
    $credentials = [regex]::Match($yaml, '(?m)^credentials-file:\s*(.+?)\s*$').Groups[1].Value
    Copy-Item $credentials $cfHome -Force
    $yaml.Replace($credentials, (Join-Path $cfHome (Split-Path $credentials -Leaf))) | Set-Content "$cfHome\config.yml" -Encoding ascii
    if (-not (Get-Service Cloudflared -ErrorAction SilentlyContinue)) { & $Cloudflared service install }
    sc.exe config Cloudflared binPath= "`"$Cloudflared`" --config `"$cfHome\config.yml`" --no-autoupdate tunnel run" start= auto | Out-Null
} else {
    Write-Host '3/7 Caddy (HTTPS)'
    New-Item -ItemType Directory -Force (Join-Path $Deploy 'bin') | Out-Null
    $caddy = Join-Path $Deploy 'bin\caddy.exe'
    if (-not (Test-Path $caddy)) {
        Invoke-WebRequest 'https://caddyserver.com/api/download?os=windows&arch=amd64' -OutFile $caddy -UseBasicParsing
    }
    (Get-Content (Join-Path $Deploy 'Caddyfile') -Raw).Replace('CRM_PUBLIC_IP', $PublicIP) |
        Set-Content (Join-Path $Deploy 'Caddyfile.local') -Encoding ascii
    & $caddy validate --config (Join-Path $Deploy 'Caddyfile.local') --adapter caddyfile
}

Write-Host '4/7 Startup tasks'
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$system = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$tasks = @(@{Name = 'ISP CRM'; Script = 'run_crm.cmd'})
if (-not $Tunnel) { $tasks += @{Name = 'ISP CRM HTTPS'; Script = 'run_caddy.cmd'} }
foreach ($task in $tasks) {
    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$(Join-Path $Deploy $task.Script)`""
    Register-ScheduledTask -TaskName $task.Name -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $system -Settings $settings -Force | Out-Null
}
$backup = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Deploy 'backup_db.ps1')`""
Register-ScheduledTask -TaskName 'ISP CRM Backup' -Action $backup -Trigger (New-ScheduledTaskTrigger -Daily -At 2am) -Principal $system -Force | Out-Null
# A CRM started by hand would share port 3000 with the task's copy (Windows allows both to bind); stop it.
Get-CimInstance Win32_Process -Filter "Name='python.exe' AND CommandLine LIKE '%ispcrm.py%'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask 'ISP CRM'
$ready = $false
foreach ($i in 1..30) {
    try { Invoke-WebRequest http://localhost:3000 -UseBasicParsing -TimeoutSec 3 | Out-Null; $ready = $true; break } catch { Start-Sleep 2 }
}
if (-not $ready) { throw "The CRM did not start. See $Deploy\logs\crm.log" }

Write-Host '5/7 Administrator account'
Write-Host 'The first visitor to a new CRM creates the administrator, so do this BEFORE it goes public.'
Write-Host 'On THIS PC open http://localhost:3000, create the administrator account, then return here.'
Read-Host 'Press Enter once the administrator account exists'

Write-Host '6/7 Firewall and sleep'
if (-not $Tunnel) {
    foreach ($port in 80, 443) {
        if (-not (Get-NetFirewallRule -DisplayName "ISP CRM $port" -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -DisplayName "ISP CRM $port" -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null
        }
    }
}
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

Write-Host '7/7 Going live'
Write-Host ''
if ($Tunnel) {
    Restart-Service Cloudflared
    Write-Host 'Done. The CRM is served through the Cloudflare Tunnel at the hostname in config.yml.'
} else {
    Start-ScheduledTask 'ISP CRM HTTPS'
    Write-Host "Done. Forward TCP ports 80 and 443 on the router to this PC, then open https://$PublicIP"
}
Write-Host "Logs: $Deploy\logs"
