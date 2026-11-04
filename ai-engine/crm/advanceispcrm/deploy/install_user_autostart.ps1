# No-admin way to keep the CRM and Cloudflare tunnel running without VS Code:
# registers two tasks that start at sign-in for this Windows user and starts them now.
# Run from the project folder (normal PowerShell, no admin):
#   powershell -ExecutionPolicy Bypass -File deploy\install_user_autostart.ps1
# They stop when this user signs out; setup_remote.ps1 -Tunnel replaces them with Windows services.
$ErrorActionPreference = 'Stop'
$Deploy = $PSScriptRoot
$me = "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

# CRM copies started elsewhere (e.g. from VS Code) would share port 3000 with the task's copy; stop them first.
Get-CimInstance Win32_Process -Filter "Name='python.exe' AND CommandLine LIKE '%ispcrm.py%'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

foreach ($task in @(@{Name = 'ISP CRM (user)'; Script = 'run_user_crm.cmd'}, @{Name = 'ISP CRM Tunnel (user)'; Script = 'run_user_tunnel.cmd'})) {
    $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless cmd.exe /c `"$(Join-Path $Deploy $task.Script)`""
    Register-ScheduledTask -TaskName $task.Name -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $me) -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask $task.Name
}

$ready = $false
foreach ($i in 1..30) {
    try { Invoke-WebRequest http://localhost:3000 -UseBasicParsing -TimeoutSec 3 | Out-Null; $ready = $true; break } catch { Start-Sleep 2 }
}
if ($ready) { Write-Host 'CRM and tunnel are running and will start again each time you sign in. VS Code can be closed.' }
else { Write-Host "The CRM did not start; see $Deploy\logs\crm.log" }
