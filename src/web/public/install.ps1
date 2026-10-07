# Installs the Suplex desktop app on Windows for the current user, then opens it.
#   irm https://suplex.sh/install.ps1 | iex
# Set $env:SUPLEX_NO_START = "1" to skip opening Suplex after the install.
# The Windows app connects to Suplex running on a Mac or Linux computer; it does not run a host itself.

# Everything runs from Install-Suplex, so a partial download cannot run half a script. Errors are thrown, not
# `exit`ed: under `iex`, exit would close the PowerShell window.
function Install-Suplex {
    $ErrorActionPreference = "Stop"
    # Windows PowerShell 5.1 draws download progress so slowly that it slows the download itself.
    $ProgressPreference = "SilentlyContinue"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    Write-Host @'
  _______ ___ ___ _______ ___     _______  ___ ___
 |   _   |   Y   |   _   |   |   |   _   |(   Y   )
 |   1___|.  |   |.  1   |.  |   |.  1___| \  1  /
 |____   |.  |   |.  ____|.  |___|.  __)_  /  _  \
 |:  1   |:  1   |:  |   |:  1   |:  1   |/:  |   \
 |::.. . |::.. . |::.|   |::.. . |::.. . (::. |:.  )
 `-------`-------`---'   `-------`-------'`--- ---'

'@

    # An x64 PowerShell on an Arm computer reports AMD64; PROCESSOR_ARCHITEW6432 names the real processor.
    $machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $arch = switch ($machine) {
        "ARM64" { "arm64" }
        "AMD64" { "x64" }
        default { throw "Suplex needs a 64-bit Arm or x64 computer, and this one reports $machine." }
    }

    # SUPLEX_DOWNLOAD_URL is for testing a build before it is published.
    $base = if ($env:SUPLEX_DOWNLOAD_URL) { $env:SUPLEX_DOWNLOAD_URL } else { "https://suplex.sh/download" }
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("suplex-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $temp | Out-Null
    try {
        $installer = Join-Path $temp "Suplex-setup.exe"
        Write-Host ">>> Downloading Suplex for Windows ($arch)..."
        Invoke-WebRequest -Uri "${base}?platform=windows-$arch" -OutFile $installer -UseBasicParsing

        $signature = Get-AuthenticodeSignature -FilePath $installer
        if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch '(^|, )O="Meiji Heavy Industries, Inc\."(,|$)') {
            throw "The download is not signed by Meiji Heavy Industries. Nothing was installed."
        }

        # The Windows app owns no host, so stopping it loses nothing; the installer cannot replace a running app.
        $running = Get-Process -Name Suplex -ErrorAction SilentlyContinue
        if ($running) {
            Write-Host ">>> Quitting Suplex..."
            $running | Stop-Process -Force
            $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
        }

        Write-Host ">>> Installing Suplex for $env:USERNAME..."
        $process = Start-Process -FilePath $installer -ArgumentList "/S" -Wait -PassThru
        $app = Join-Path $env:LOCALAPPDATA "Suplex\Suplex.exe"
        if ($process.ExitCode -ne 0 -or -not (Test-Path $app)) {
            throw "The Suplex installer did not finish (exit $($process.ExitCode))."
        }
        Write-Host ">>> Install complete. Suplex is in the Start menu."

        if ($env:SUPLEX_NO_START -ne "1") {
            Write-Host ">>> Opening Suplex..."
            Start-Process -FilePath $app
        }
    } finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

try {
    Install-Suplex
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
}
