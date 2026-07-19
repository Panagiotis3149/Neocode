@echo off
REM build-and-run-neocode.bat — build Neocode then run the CLI
REM
REM Usage:
REM   scripts\build-and-run-neocode.bat            # interactive mode
REM   scripts\build-and-run-neocode.bat --version  # pass-through any args
REM
REM This runs `bun run build` and then launches dist/cli.mjs with Node.
REM If the build fails the script exits before attempting to run.

setlocal

set "ROOT_DIR=%~dp0"

cd /d "%ROOT_DIR%"

echo Building Neocode...
bun run build
if errorlevel 1 exit /b %errorlevel%

echo Starting Neocode...
node "%ROOT_DIR%\dist\cli.mjs" --resume %*
