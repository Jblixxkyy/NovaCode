@echo off
cd /d "%~dp0packages\desktop"
echo Building Desktop App...
call bun run build
if %errorlevel% neq 0 (
    echo Build failed. Skipping packaging.
    pause
    exit /b %errorlevel%
)
echo Packaging Desktop App...
call bun run package:win
