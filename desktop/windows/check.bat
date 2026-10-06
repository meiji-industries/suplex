@echo off
rem Runs the desktop shell's clippy and tests on the build VM, natively on Arm.
setlocal
call "%~dp0env.bat" arm64
if errorlevel 1 exit 1
set "CARGO_TARGET_DIR=S:\suplex\target-check"
cd /d "S:\suplex\checkout\desktop\src-tauri" || exit 1
cargo clippy --all-targets -- -D warnings
if errorlevel 1 exit 1
cargo test --all-targets
if errorlevel 1 exit 1
