@echo off
REM LabWired Agent — Windows entry (cmd.exe)
setlocal
if defined LABWIRED_HOME goto :run
set "LABWIRED_HOME=%USERPROFILE%\.labwired"
:run
set "LABWIRED_AGENT_HOME=%LABWIRED_HOME%\agent"
if exist "%LABWIRED_HOME%\tools\sim\labwired-sim.exe" set "LABWIRED_CLI=%LABWIRED_HOME%\tools\sim\labwired-sim.exe"
if exist "%LABWIRED_HOME%\tools\probe-rs\probe-rs.exe" set "LABWIRED_PROBE_RS=%LABWIRED_HOME%\tools\probe-rs\probe-rs.exe"

set "PS1=%~dp0labwired.ps1"
if not exist "%PS1%" set "PS1=%LABWIRED_AGENT_HOME%\bin\labwired.ps1"
if not exist "%PS1%" (
  echo labwired: launcher not found. Re-run install.ps1
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
exit /b %ERRORLEVEL%
