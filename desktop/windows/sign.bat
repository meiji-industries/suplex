@echo off
setlocal DisableDelayedExpansion
rem Signs files with Azure Trusted Signing (the VM provisioning VM installs signtool and the dlib).
rem Tauri calls it once per executable through bundle.windows.signCommand.
rem Usage: sign.bat <file1> [file2] ...
rem
rem Required env vars:
rem   AZURE_SIGNING_ENDPOINT    - e.g. https://eus.codesigning.azure.net/
rem   AZURE_SIGNING_ACCOUNT     - the Trusted Signing account
rem   AZURE_CERTIFICATE_PROFILE - its certificate profile

if "%~1"=="" (
    echo Usage: sign.bat ^<file1^> [file2] ...
    exit /b 1
)

if "%AZURE_SIGNING_ENDPOINT%"=="" (
    echo ERROR: AZURE_SIGNING_ENDPOINT not set
    exit /b 1
)
if "%AZURE_SIGNING_ACCOUNT%"=="" (
    echo ERROR: AZURE_SIGNING_ACCOUNT not set
    exit /b 1
)
if "%AZURE_CERTIFICATE_PROFILE%"=="" (
    echo ERROR: AZURE_CERTIFICATE_PROFILE not set
    exit /b 1
)

rem Write metadata JSON for Trusted Signing
set "METADATA_FILE=%TEMP%\trusted-signing-metadata.json"
(
echo {
echo   "Endpoint": "%AZURE_SIGNING_ENDPOINT%",
echo   "CodeSigningAccountName": "%AZURE_SIGNING_ACCOUNT%",
echo   "CertificateProfileName": "%AZURE_CERTIFICATE_PROFILE%"
echo }
) > "%METADATA_FILE%"

rem Locate signtool.exe from Windows SDK
set "SIGNTOOL="
set "WINDOWS_KITS_BIN=C:\Program Files (x86)\Windows Kits\10\bin"
for /f "delims=" %%v in ('dir /b /ad "%WINDOWS_KITS_BIN%\10.*" 2^>nul') do (
    if exist "%WINDOWS_KITS_BIN%\%%v\x64\signtool.exe" (
        set "SIGNTOOL=%WINDOWS_KITS_BIN%\%%v\x64\signtool.exe"
    )
)
if "%SIGNTOOL%"=="" (
    echo ERROR: signtool.exe not found in Windows SDK
    exit /b 1
)
echo Using signtool: %SIGNTOOL%

rem Locate Azure.CodeSigning.Dlib.dll (use x64 for signtool)
set "DLIB=C:\TrustedSigning\x64\Azure.CodeSigning.Dlib.dll"
if not exist "%DLIB%" (
    echo ERROR: Azure.CodeSigning.Dlib.dll not found at %DLIB%
    echo   Run install-trusted-signing.ps1 first
    exit /b 1
)
if exist "C:\dotnet\x64\dotnet.exe" (
    set "DOTNET_ROOT=C:\dotnet\x64"
    set "PATH=C:\dotnet\x64;%PATH%"
)

rem Sign each file
set ERRORS=0
:sign_loop
if "%~1"=="" goto sign_done

echo Signing: "%~1"
"%SIGNTOOL%" sign /v /fd SHA256 /tr "http://timestamp.acs.microsoft.com" /td SHA256 /dlib "%DLIB%" /dmdf "%METADATA_FILE%" "%~1"
if errorlevel 1 (
    echo ERROR: Failed to sign "%~1"
    set /a ERRORS+=1
    shift
    goto sign_loop
)

echo Verifying: "%~1"
"%SIGNTOOL%" verify /pa "%~1"
if errorlevel 1 (
    echo ERROR: Signature verification failed for "%~1"
    set /a ERRORS+=1
)

shift
goto sign_loop

:sign_done
del "%METADATA_FILE%" 2>nul

if %ERRORS% gtr 0 (
    echo.
    echo ERROR: %ERRORS% files failed signing
    exit /b 1
)

echo.
echo All files signed successfully
exit /b 0
