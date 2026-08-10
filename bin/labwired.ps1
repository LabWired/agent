#Requires -Version 5.1
<# LabWired product dispatcher (Windows). #>
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [AllowEmptyString()]
  [string[]]$Rest
)

$ErrorActionPreference = "Stop"
$HomeDir = if ($env:LABWIRED_HOME) { $env:LABWIRED_HOME } else { Join-Path $env:USERPROFILE ".labwired" }

function Show-Help {
  @"
LabWired - firmware development tools

  labwired agent [command]   Start or manage LabWired Agent
  labwired core <command>    Run LabWired Core tools
  labwired editor            Open LabWired Editor

Run 'labwired agent --help' or 'labwired core --help' for component help.
"@
}

function Get-AgentBin {
  if ($env:LABWIRED_AGENT_BIN) { return $env:LABWIRED_AGENT_BIN }
  return (Join-Path $HomeDir "agent\bin\labwired-agent.ps1")
}

function Get-CoreBin {
  if ($env:LABWIRED_CORE_BIN) { return $env:LABWIRED_CORE_BIN }
  foreach ($path in @(
    (Join-Path $HomeDir "components\core\bin\labwired.exe"),
    (Join-Path $HomeDir "components\core\bin\labwired.cmd"),
    (Join-Path $HomeDir "tools\sim\labwired-sim.exe")
  )) {
    if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
  }
  return $null
}

function Invoke-Component([string]$Path, [string]$Name, [string[]]$Arguments) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    [Console]::Error.WriteLine("labwired: LabWired $Name is not installed.")
    $overrideName = "LABWIRED_{0}_BIN" -f $Name.ToUpperInvariant()
    [Console]::Error.WriteLine("Install it, or set $overrideName to its executable.")
    exit 1
  }
  & $Path @Arguments
  if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }
  if (-not $?) { exit 1 }
  exit 0
}

$command = if ($Rest -and $Rest.Count -gt 0) { $Rest[0] } else { "" }
$arguments = if ($Rest -and $Rest.Count -gt 1) { @($Rest[1..($Rest.Count - 1)]) } else { @() }
$legacyCore = @("test", "chips", "machine", "asset", "run", "snapshot", "coverage", "tier1-matrix", "cosim-step", "fuzz")

switch ($command) {
  { $_ -in @("", "help", "--help", "-h") } { Show-Help; exit 0 }
  "agent" { Invoke-Component (Get-AgentBin) "Agent" $arguments }
  "core" { Invoke-Component (Get-CoreBin) "Core" $arguments }
  "editor" {
    [Console]::Error.WriteLine("LabWired Editor is not installed.")
    [Console]::Error.WriteLine("Install LabWired Editor, then run: labwired editor")
    exit 1
  }
  { $_ -in $legacyCore } { Invoke-Component (Get-CoreBin) "Core" @($Rest) }
  default {
    [Console]::Error.WriteLine("labwired: unknown command: $command")
    [Console]::Error.WriteLine("Run: labwired --help")
    exit 2
  }
}
