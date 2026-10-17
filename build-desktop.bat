@echo off
cd /d "%~dp0packages\desktop"
echo Building Desktop App...
call bun run build
