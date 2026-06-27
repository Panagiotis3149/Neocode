@echo off
REM run-neocode.bat — run the latest built Neocode CLI from dist/cli.mjs
REM
REM Usage:
REM   scripts\run-neocode.bat            # interactive mode
REM   scripts\run-neocode.bat --version  # pass-through any args
REM
REM Prerequisites:
REM   - `bun run build` has been run at least once (dist/cli.mjs must exist)

setlocal

set "ROOT_DIR=%~dp0"
set "CLI_PATH=%ROOT_DIR%\dist\cli.mjs"

if not exist "%CLI_PATH%" (
  echo Neocode: dist\cli.mjs not found.
  echo.
  echo Build first:
  echo   bun run build
  echo.
  echo Or run directly with Bun:
  echo   bun run dev
  exit /b 1
)

node "%CLI_PATH%" %*
