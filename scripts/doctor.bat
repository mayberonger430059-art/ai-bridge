@echo off
REM AI Bridge — one-click environment diagnosis (Windows).
REM Run from D:\AI-Bridge. Does not run any model, does not print secrets.
cd /d %~dp0\..
node src\doctor.js
if errorlevel 1 (
  echo.
  echo Doctor FAILED — fix the FAIL lines above, then re-run this script.
  pause
  exit /b 1
)
echo.
echo Doctor PASSED.
pause
