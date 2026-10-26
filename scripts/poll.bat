@echo off
REM AI Bridge — polling service (Windows, foreground).
REM Polls Notion every pollIntervalMs (default 30s), runs one task at a time.
REM Keep this window open. Ctrl+C stops it; restart recovery is handled on next start.
REM Do NOT expose this machine to the internet: the bridge only makes outbound
REM calls to api.notion.com and to local CLIs. It opens no listening port.
cd /d %~dp0\..
node src\bridge.js --poll
pause
