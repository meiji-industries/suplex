@echo off
rem One-time setup of the Suplex build tools on the Windows build VM: the Tauri CLI on the S: disk.
call "%~dp0env.bat" arm64
if errorlevel 1 exit 1
if exist "S:\suplex\tools\bin\cargo-tauri.exe" exit /b 0
set "CARGO_TARGET_DIR=S:\suplex\tools-target"
cargo install tauri-cli --version 2.12.1 --locked --root S:\suplex\tools
if errorlevel 1 exit 1
cargo-tauri --version
