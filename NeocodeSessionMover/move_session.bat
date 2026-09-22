@echo off
REM Wrapper to run the Neocode session mover script
REM Usage: move_session.bat --session-id <id> --new-cwd <path> [--dry-run] [--backup]

set SCRIPT_DIR=%~dp0
python "%SCRIPT_DIR%move_session.py" %*