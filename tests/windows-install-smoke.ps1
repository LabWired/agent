#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$SessionRoot = Join-Path ([IO.Path]::GetTempPath()) ("labwired-windows-evidence-" + [guid]::NewGuid().ToString("n"))
$EvidenceDir = if ($env:LABWIRED_EVIDENCE_DIR) { $env:LABWIRED_EVIDENCE_DIR } else { Join-Path $SessionRoot "evidence" }
$Prefix = Join-Path $SessionRoot "prefix"
$UserBin = Join-Path $SessionRoot "user-bin"
$ConfigDir = Join-Path $SessionRoot "config"
$TestBin = Join-Path $SessionRoot "test-bin"
$Original = @{
  USERPROFILE = $env:USERPROFILE
  LABWIRED_HOME = $env:LABWIRED_HOME
  LABWIRED_BIN_DIR = $env:LABWIRED_BIN_DIR
  LABWIRED_AGENT_CONFIG_DIR = $env:LABWIRED_AGENT_CONFIG_DIR
  OPENCODE_CONFIG_DIR = $env:OPENCODE_CONFIG_DIR
  Path = $env:Path
}

function Write-Result([string]$Value) {
  Set-Content -LiteralPath (Join-Path $EvidenceDir "result.txt") -Value $Value -Encoding ASCII
}

function Invoke-Captured {
  param([scriptblock]$Command, [string]$OutputPath)
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $raw = & $Command 2>&1
    $status = $LASTEXITCODE
    if ($null -eq $status) { $status = if ($?) { 0 } else { 1 } }
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  @($raw | ForEach-Object { $_.ToString() }) | Set-Content -LiteralPath $OutputPath -Encoding UTF8
  return [int]$status
}

try {
  New-Item -ItemType Directory -Path $EvidenceDir, $TestBin -Force | Out-Null
  Write-Result "FAIL"
  @(
    "os=$([Runtime.InteropServices.RuntimeInformation]::OSDescription)"
    "os_architecture=$([Runtime.InteropServices.RuntimeInformation]::OSArchitecture)"
    "process_architecture=$([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture)"
    "powershell=$($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)"
  ) | Set-Content -LiteralPath (Join-Path $EvidenceDir "platform.txt") -Encoding UTF8

  @('@echo off', 'if "%1"=="--version" echo opencode 1.18.7', 'exit /b 0') |
    Set-Content -LiteralPath (Join-Path $TestBin "opencode.cmd") -Encoding ASCII
  @('@echo off', 'exit /b 0') |
    Set-Content -LiteralPath (Join-Path $TestBin "npx.cmd") -Encoding ASCII

  $env:USERPROFILE = Join-Path $SessionRoot "home"
  $env:LABWIRED_HOME = $Prefix
  $env:LABWIRED_BIN_DIR = $UserBin
  $env:LABWIRED_AGENT_CONFIG_DIR = $ConfigDir
  $env:OPENCODE_CONFIG_DIR = $ConfigDir
  $env:Path = "$TestBin;$UserBin;$($Original.Path)"
  New-Item -ItemType Directory -Path $env:USERPROFILE -Force | Out-Null

  $installer = Join-Path $Root "scripts\install.ps1"
  $installStatus = Invoke-Captured -OutputPath (Join-Path $EvidenceDir "install.txt") -Command {
    & $installer -Prefix $Prefix -UserBin $UserBin -AgentOnly -SkipOpenCode -SkipPathUpdate
  }
  if ($installStatus -ne 0) { throw "Windows source install failed with code $installStatus" }

  $dispatcher = Join-Path $Prefix "bin\labwired.ps1"
  $versionStatus = Invoke-Captured -OutputPath (Join-Path $EvidenceDir "version.txt") -Command {
    & $dispatcher agent version
  }
  if ($versionStatus -ne 0) { throw "labwired agent version failed with code $versionStatus" }

  $doctorStatus = Invoke-Captured -OutputPath (Join-Path $EvidenceDir "doctor.txt") -Command {
    & $dispatcher agent doctor
  }
  if ($doctorStatus -ne 0) { throw "labwired agent doctor failed with code $doctorStatus" }

  $cmd = Join-Path $UserBin "labwired.cmd"
  $cmdOutput = & cmd.exe /d /c "`"$cmd`" agent version" 2>&1
  if ($LASTEXITCODE -ne 0 -or (($cmdOutput -join "`n") -notmatch "LabWired Agent")) {
    throw "installed cmd dispatcher did not route agent version"
  }

  $combined = (Get-Content (Join-Path $EvidenceDir "version.txt") -Raw) + (Get-Content (Join-Path $EvidenceDir "doctor.txt") -Raw)
  if ($combined -match "Failed to change directory" -or $combined -match "(?im)(^|[^a-z])not ready([^a-z]|$)") {
    throw "installed Windows command dispatch or doctor output is not ready"
  }
  if ($combined -notmatch "LabWired Agent" -or $combined -notmatch "agent-runtime") {
    throw "Windows evidence is missing Agent version or doctor markers"
  }

  @(
    "simulator=$(if (Test-Path (Join-Path $Prefix 'tools\sim\labwired-sim.exe')) { 'present' } else { 'absent' })"
    "probe=$(if (Test-Path (Join-Path $Prefix 'tools\probe-rs\probe-rs.exe')) { 'present' } else { 'absent' })"
    "verification_fallback=hosted-or-wsl"
  ) | Set-Content -LiteralPath (Join-Path $EvidenceDir "capabilities.txt") -Encoding UTF8
  Write-Result "PASS"
  Write-Host "ok   windows-install-smoke PASS"
} finally {
  foreach ($key in $Original.Keys) {
    [Environment]::SetEnvironmentVariable($key, $Original[$key], "Process")
  }
  if (Test-Path -LiteralPath $SessionRoot) {
    Remove-Item -LiteralPath $SessionRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
