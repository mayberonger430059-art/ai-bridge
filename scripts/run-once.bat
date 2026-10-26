@echo off
REM AI Bridge — single poll pass (Windows). Runs all Queued tasks once, then exits.
cd /d %~dp0\..
node src\bridge.js --once
pause
