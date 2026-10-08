# Tauri runs this for each file to sign (bundle.windows.signCommand). signtool needs Windows DPAPI, which an
# SSH key logon cannot unlock, so the signature runs in a scheduled task that logs on with the VM user's
# password. scripts/build-desktop-windows.sh writes the credentials this reads, and deletes them after the build.
param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = "Stop"
$task = Get-Content S:\suplex\windows\sign-task.json -Raw | ConvertFrom-Json
Set-Content -Path S:\suplex\tmp\sign-request.txt -Value $File -NoNewline
Remove-Item S:\suplex\tmp\sign.log -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c S:\suplex\windows\sign-request.bat"
Register-ScheduledTask -TaskName SuplexSign -Action $action -User $task.user -Password $task.password -RunLevel Limited -Force | Out-Null
try {
  Start-ScheduledTask -TaskName SuplexSign
  $finished = $false
  for ($i = 0; $i -lt 150 -and -not $finished; $i++) {
    Start-Sleep -Seconds 2
    $finished = (Test-Path S:\suplex\tmp\sign.log) -and (Select-String -Path S:\suplex\tmp\sign.log -Pattern "^exit=" -Quiet)
  }
} finally {
  Unregister-ScheduledTask -TaskName SuplexSign -Confirm:$false
}
if (-not $finished) { "Signing $File did not finish within 5 minutes."; exit 1 }
Get-Content S:\suplex\tmp\sign.log
if (-not (Select-String -Path S:\suplex\tmp\sign.log -Pattern "^exit=0" -Quiet)) { exit 1 }
