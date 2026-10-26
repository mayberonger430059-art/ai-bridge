@echo off
REM AI Bridge — dry-run plumbing test (Windows).
REM No model call, no Notion call. Proves: config -> local task -> marker file -> result.json.
REM Prerequisite: edit config.json so allowedWorkdirs contains D:\AI-Bridge\test-workdir,
REM and create that folder. Set BRIDGE_ALLOW_DRYRUN=1 for this test only.
cd /d %~dp0\..
if not exist test-workdir mkdir test-workdir
set BRIDGE_ALLOW_DRYRUN=1
node src\bridge.js --once --local-task examples\local-task-dryrun.json
if errorlevel 1 (
  echo.
  echo DRY-RUN FAILED — see the error above.
  pause
  exit /b 1
)
echo.
echo DRY-RUN PASSED — check test-workdir\AI_BRIDGE_DRYRUN_OK.txt and data\runs\ for result.json.
pause
