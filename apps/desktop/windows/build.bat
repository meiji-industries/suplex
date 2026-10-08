@echo off
rem Builds the Windows desktop installer on the build VM: build.bat <arm64|x64>.
rem scripts/build-desktop-windows.sh copies the checkout to S:\suplex\checkout and the merged Tauri
rem configuration to .build\windows-<arch>\tauri.json before it runs this.
setlocal
set "ARCH=%~1"
if /i "%ARCH%"=="x64" (set "TARGET=x86_64-pc-windows-msvc") else (set "TARGET=aarch64-pc-windows-msvc")
call "%~dp0env.bat" %ARCH%
if errorlevel 1 exit 1
set "CARGO_TARGET_DIR=S:\suplex\target"
cd /d "S:\suplex\checkout\apps\desktop" || exit 1
rustup target add %TARGET% >nul 2>&1
cargo tauri build --ci --target %TARGET% --bundles nsis --config ".build\windows-%ARCH%\tauri.json"
if errorlevel 1 exit 1
