@echo off
REM install-neocode.bat — make `neocode` available as a global command
REM
REM Strategy:
REM   1. Build the CLI (dist/cli.mjs + bin/neocode must exist after).
REM   2. Link this package globally via `bun link` so `neocode` resolves from
REM      any directory on PATH.
REM
REM After running this script you can use `neocode` from any terminal:
REM   neocode --version
REM   neocode
REM
REM Prerequisites:
REM   - Bun installed and on PATH
REM   - This script run from the repo root (or any path inside the repo)

setlocal

set "ROOT_DIR=%~dp0"

cd /d "%ROOT_DIR%"

echo Step 1/2: Building Neocode...
bun run build
if errorlevel 1 exit /b %errorlevel%

echo Step 2/2: Linking neocode globally via bun link...
bun link

echo.
echo Done. You can now run Neocode from anywhere:
echo   neocode --version
echo   neocode
echo.
echo If 'neocode' is not found on PATH, ensure Bun's global bin directory
echo is on your PATH. You can find it with:  bun pm bin -g
