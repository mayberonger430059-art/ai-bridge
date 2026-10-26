@echo off
REM start-bridge.bat -- single-click launcher for AI Bridge on Windows.
REM Adapted from the Notion Claude review bundle (start-bridge.bat) to this
REM repo's layout: this file lives in scripts\, so the repo root is %~dp0\..
REM Keep this file ASCII/ANSI; a UTF-8 BOM makes cmd.exe choke on the first line.
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0\.."
cd /d "%ROOT%"

where node >nul 2>nul
if errorlevel 1 (
  echo [AI-Bridge] Node.js not found on PATH. Install Node ^>= 20 and retry.
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%a in ('node -p "process.versions.node"') do set "NODEMAJOR=%%a"
if "%NODEMAJOR%"=="" for /f %%a in ('node -p "process.versions.node.split('.')[0]"') do set "NODEMAJOR=%%a"
if %NODEMAJOR% LSS 20 (
  echo [AI-Bridge] Node %NODEMAJOR% is too old. Need ^>= 20.
  pause
  exit /b 1
)

if not exist "%ROOT%\.env" (
  echo [AI-Bridge] Missing .env next to src\bridge.js. Copy .env.example and fill it in.
  pause
  exit /b 1
)

node --no-warnings "%ROOT%\src\bridge.js" --poll
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [AI-Bridge] exited with code %RC%.
  pause
)
endlocal & exit /b %RC%
