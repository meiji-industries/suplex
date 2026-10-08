@echo off
rem The build environment on the Windows build VM: MSVC for %1 (arm64 or x64), Rust, and the S: build disk.
rem C: on the VM has little free space, so Cargo's cache, temporary files, and tools live on S:.
set "CARGO_HOME=S:\suplex\cargo"
set "TEMP=S:\suplex\tmp"
set "TMP=S:\suplex\tmp"
if not exist "%TEMP%" mkdir "%TEMP%"
set "PATH=S:\suplex\tools\bin;%USERPROFILE%\.cargo\bin;%PATH%"
set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
rem The VM is Arm: x64 builds use the arm64-hosted cross compiler.
if /i "%~1"=="x64" (call "%VCVARS%" arm64_amd64 >nul) else (call "%VCVARS%" arm64 >nul)
if errorlevel 1 (
  echo vcvarsall failed for %~1
  exit /b 1
)
