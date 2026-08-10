#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Dispatcher = Join-Path $Root "bin\labwired.ps1"
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("labwired-windows-contract-" + [guid]::NewGuid().ToString("n"))
$Prefix = Join-Path $TempRoot "prefix"
$Agent = Join-Path $TempRoot "fake-agent.ps1"
$Core = Join-Path $TempRoot "fake-core.cmd"
$ShimDir = Join-Path $TempRoot "shim"
$Shim = Join-Path $ShimDir "labwired.cmd"
$ArgsFile = Join-Path $TempRoot "args.txt"
$PowerShellExe = if ($PSVersionTable.PSEdition -eq "Core") {
  Join-Path $PSHOME "pwsh.exe"
} else {
  Join-Path $PSHOME "powershell.exe"
}

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "FAIL: $Message" }
  Write-Host "ok   $Message"
}

function Invoke-Dispatcher([string[]]$Arguments) {
  $output = & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $Dispatcher @Arguments 2>&1 | Out-String
  return @{ Output = $output; Status = $LASTEXITCODE }
}

try {
  New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
  @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
[System.IO.File]::WriteAllLines($env:LABWIRED_TEST_ARGS, @($Rest | ForEach-Object { "<$($_)>" }))
if ($Rest.Count -gt 0 -and $Rest[0] -eq "doctor") { Write-Output "agent-doctor" }
exit 0
'@ | Set-Content -Path $Agent -Encoding UTF8
  @'
@echo off
> "%LABWIRED_TEST_ARGS%" echo %*
echo core:%*
exit /b 0
'@ | Set-Content -Path $Core -Encoding ASCII
  New-Item -ItemType Directory -Path $ShimDir | Out-Null
  Copy-Item (Join-Path $Root "bin\labwired.cmd") $Shim
  Copy-Item $Dispatcher (Join-Path $ShimDir "labwired.ps1")

  $env:LABWIRED_HOME = $Prefix
  $env:LABWIRED_AGENT_BIN = $Agent
  $env:LABWIRED_CORE_BIN = $Core
  $env:LABWIRED_TEST_ARGS = $ArgsFile

  $result = Invoke-Dispatcher @()
  Assert-True ($result.Status -eq 0) "plain dispatcher help exits zero"
  Assert-True ($result.Output -match 'labwired agent') "help includes Agent"
  Assert-True ($result.Output -match 'labwired core') "help includes Core"
  Assert-True ($result.Output -match 'labwired editor') "help includes Editor"

  $result = Invoke-Dispatcher @("agent", "doctor")
  Assert-True ($result.Status -eq 0 -and $result.Output -match 'agent-doctor') "agent doctor routes to Agent"
  Assert-True ((Get-Content $ArgsFile -Raw).Trim() -eq '<doctor>') "agent prefix is removed"

  $result = Invoke-Dispatcher @("core", "test", "board one")
  Assert-True ($result.Status -eq 0 -and $result.Output -match 'core:test') "core test routes to Core"
  Assert-True ((Get-Content $ArgsFile -Raw).Trim() -eq 'test "board one"') "Core receives a spaced argv intact"
  $result = Invoke-Dispatcher @("test", "board two")
  Assert-True ($result.Status -eq 0 -and $result.Output -match 'core:test') "legacy test routes to Core"

  $result = Invoke-Dispatcher @("agent", "capture", "spaced value", "", "tail")
  Assert-True ($result.Status -eq 0) "Agent argv capture exits zero"
  $actual = @(Get-Content $ArgsFile)
  Assert-True (($actual -join '|') -eq '<capture>|<spaced value>|<>|<tail>') "spaced and empty argv are preserved"

  Remove-Item $ArgsFile -Force
  $shimCommand = '"{0}" agent capture "spaced value" "" tail' -f $Shim
  $shimOutput = & cmd.exe /d /s /c $shimCommand 2>&1 | Out-String
  Assert-True ($LASTEXITCODE -eq 0) "cmd shim exits zero"
  $actual = @(Get-Content $ArgsFile)
  Assert-True (($actual -join '|') -eq '<capture>|<spaced value>|<>|<tail>') "cmd shim preserves spaced and empty argv"

  $env:LABWIRED_AGENT_BIN = Join-Path $TempRoot "missing-agent.ps1"
  $result = Invoke-Dispatcher @("agent", "doctor")
  Assert-True ($result.Status -eq 1 -and $result.Output -match 'LabWired Agent is not installed') "missing Agent is clear"
  $env:LABWIRED_AGENT_BIN = $Agent

  $env:LABWIRED_CORE_BIN = Join-Path $TempRoot "missing-core.cmd"
  $result = Invoke-Dispatcher @("core", "test")
  Assert-True ($result.Status -eq 1 -and $result.Output -match 'LabWired Core is not installed') "missing Core is clear"

  $result = Invoke-Dispatcher @("not-a-command")
  Assert-True ($result.Status -eq 2 -and $result.Output -match 'unknown command') "unknown command exits two with a clear message"
  Write-Host "ok   windows-contract PASS"
} finally {
  Remove-Item Env:LABWIRED_AGENT_BIN -ErrorAction SilentlyContinue
  Remove-Item Env:LABWIRED_CORE_BIN -ErrorAction SilentlyContinue
  Remove-Item Env:LABWIRED_TEST_ARGS -ErrorAction SilentlyContinue
  Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
