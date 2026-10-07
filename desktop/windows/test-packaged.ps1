# Checks a built Windows installer on the build VM: a silent per-user install, the suplex:// registration,
# then a launch against a test server. scripts/build-desktop-windows.sh copies the installer to
# S:\suplex\test\setup.exe and runs this with the feed the build compiled in, if any. Exits 1 when a check fails.
param([string]$Feed = "", [switch]$Signed)
$ErrorActionPreference = "Stop"
$failures = 0
function Check($name, $ok) { if ($ok) { "ok   $name" } else { "FAIL $name"; $script:failures++ } }

Get-Process Suplex -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process -FilePath S:\suplex\test\setup.exe -ArgumentList "/S" -Wait
$app = Join-Path $env:LOCALAPPDATA "Suplex\Suplex.exe"
Check "installed for this user at $app" (Test-Path $app)
Check "suplex:// registration" (Test-Path "Registry::HKEY_CURRENT_USER\Software\Classes\suplex\shell\open\command")
if ($Signed) {
  foreach ($file in "S:\suplex\test\setup.exe", $app) {
    Check "Authenticode signature on $file" ((Get-AuthenticodeSignature $file).Status -eq "Valid")
  }
}
if ($Feed) {
  $update = Join-Path $env:LOCALAPPDATA "Suplex\app-update.yml"
  Check "the app updates from $Feed" ((Test-Path $update) -and ((Get-Content $update) -contains "url: $Feed"))
}

$scratch = Join-Path S:\suplex\test ("run-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path "$scratch\site", "$scratch\app" | Out-Null
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
$server = Start-Process -FilePath python -ArgumentList "-m", "http.server", $port, "--bind", "127.0.0.1" -WorkingDirectory "$scratch\site" -RedirectStandardError "$scratch\http.log" -PassThru -WindowStyle Hidden
# A window needs a desktop. An SSH command runs in session 0; with a user signed in at the console, WebView2
# there fails with "Invalid window handle", so the app starts in that user's session through a scheduled task.
# With nobody signed in, it starts directly.
$console = (Get-CimInstance Win32_ComputerSystem).UserName
if ($console) {
  $command = "set ""SUPLEX_DESKTOP_USER_DATA=$scratch\app"" && ""$app"" --url http://127.0.0.1:$port/packaged"
  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $command"
  $principal = New-ScheduledTaskPrincipal -UserId $console -LogonType Interactive
  Register-ScheduledTask -TaskName SuplexPackagedLaunch -Action $action -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName SuplexPackagedLaunch
} else {
  $env:SUPLEX_DESKTOP_USER_DATA = "$scratch\app"
  Start-Process -FilePath $app -ArgumentList "--url", "http://127.0.0.1:$port/packaged" | Out-Null
}
$loaded = $false
for ($i = 0; $i -lt 60 -and -not $loaded; $i++) {
  Start-Sleep -Seconds 1
  $loaded = (Test-Path "$scratch\http.log") -and (Select-String -Path "$scratch\http.log" -Pattern "GET /packaged" -Quiet)
}
Check "app loads the requested host page" $loaded
$targets = if (Test-Path "$scratch\app\desktop.json") { Get-Content "$scratch\app\desktop.json" -Raw } else { "" }
Check "app remembers only the origin" ($targets -match [regex]::Escape("""targets"":[""http://127.0.0.1:$port/""]"))
Get-Process Suplex -ErrorAction SilentlyContinue | Stop-Process -Force
if ($console) { Unregister-ScheduledTask -TaskName SuplexPackagedLaunch -Confirm:$false -ErrorAction SilentlyContinue }
Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
if ($failures -gt 0) { "$failures packaged check(s) failed"; exit 1 }
"Packaged checks passed"
