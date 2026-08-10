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
    (Join-Path $HomeDir "tools\sim\labwired-sim.exe")
  )) {
    if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
  }
  return $null
}

function ConvertTo-WindowsNativeArgument([AllowEmptyString()][string]$Value) {
  # Quote when empty, whitespace/quotes present, or cmd.exe metacharacters so
  # values like a&b survive CreateProcess -> cmd (.cmd/.bat Core launchers).
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"&|<>()^%!]') { return $Value }
  $encoded = New-Object Text.StringBuilder
  $backslash = [char]92
  $quote = [char]34
  [void]$encoded.Append($quote)
  $slashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq $backslash) {
      $slashes++
    } elseif ($character -eq $quote) {
      [void]$encoded.Append($backslash, (($slashes * 2) + 1))
      [void]$encoded.Append($quote)
      $slashes = 0
    } else {
      if ($slashes -gt 0) { [void]$encoded.Append($backslash, $slashes); $slashes = 0 }
      [void]$encoded.Append($character)
    }
  }
  if ($slashes -gt 0) { [void]$encoded.Append($backslash, ($slashes * 2)) }
  [void]$encoded.Append($quote)
  return $encoded.ToString()
}

function Invoke-NativeComponent {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $false)][AllowEmptyString()][AllowEmptyCollection()][string[]]$Arguments = @()
  )
  $argv = if ($null -eq $Arguments) { @() } else { [string[]]@($Arguments) }
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Path
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  # Prefer ArgumentList when present (pwsh / .NET Core) - it preserves empty argv.
  $argList = $null
  try { $argList = $startInfo.ArgumentList } catch { $argList = $null }
  if ($null -ne $argList) {
    foreach ($a in $argv) { [void]$argList.Add([string]$a) }
  } else {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($a in $argv) { [void]$parts.Add((ConvertTo-WindowsNativeArgument ([string]$a))) }
    $startInfo.Arguments = ($parts -join ' ')
  }
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { return 1 }
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  [Console]::Out.Write($stdout.Result)
  [Console]::Error.Write($stderr.Result)
  return $process.ExitCode
}

function Invoke-Component {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $false)][AllowEmptyString()][AllowEmptyCollection()][string[]]$Arguments = @()
  )
  $argv = if ($null -eq $Arguments) { @() } else { [string[]]@($Arguments) }
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    [Console]::Error.WriteLine("labwired: LabWired $Name is not installed.")
    $overrideName = "LABWIRED_{0}_BIN" -f $Name.ToUpperInvariant()
    [Console]::Error.WriteLine("Install it, or set $overrideName to its executable.")
    exit 1
  }
  $ext = [IO.Path]::GetExtension($Path)
  # Native launch preserves empty args and cmd metacharacters. PowerShell splat
  # drops "" and mishandles some quote edges when calling another .ps1.
  if ($ext -ieq ".exe" -or $ext -ieq ".cmd" -or $ext -ieq ".bat") {
    exit (Invoke-NativeComponent -Path $Path -Arguments $argv)
  }
  if ($ext -ieq ".ps1") {
    $psExe = if ($PSVersionTable.PSEdition -eq "Core") {
      (Get-Command pwsh -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
    } else { $null }
    if (-not $psExe) { $psExe = Join-Path $PSHOME "powershell.exe" }
    # -File mangles empty args and embedded quotes on the CreateProcess command
    # line. Re-hydrate argv from base64 inside -EncodedCommand instead.
    $path64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Path))
    $argLiterals = @(
      $argv | ForEach-Object {
        "'" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_)) + "'"
      }
    ) -join ","
    $command = @"
`$script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$path64'))
`$encoded = @($argLiterals)
`$argv = @(foreach (`$item in `$encoded) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(`$item)) })
& `$script @argv
if (`$null -ne `$LASTEXITCODE) { exit `$LASTEXITCODE }
if (-not `$?) { exit 1 }
exit 0
"@
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    exit (Invoke-NativeComponent -Path $psExe -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encodedCommand))
  }
  & $Path @argv
  if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }
  if (-not $?) { exit 1 }
  exit 0
}

$command = if ($Rest -and $Rest.Count -gt 0) { $Rest[0] } else { "" }
# Force a real string[] so empty argv elements are not stripped by binding.
$arguments = if ($Rest -and $Rest.Count -gt 1) { [string[]]@($Rest[1..($Rest.Count - 1)]) } else { [string[]]@() }
$legacyCore = @("test", "chips", "machine", "asset", "run", "snapshot", "coverage", "tier1-matrix", "cosim-step", "fuzz")

switch ($command) {
  { $_ -in @("", "help", "--help", "-h") } { Show-Help; exit 0 }
  "agent" { Invoke-Component -Path (Get-AgentBin) -Name "Agent" -Arguments $arguments }
  "core" { Invoke-Component -Path (Get-CoreBin) -Name "Core" -Arguments $arguments }
  "editor" {
    [Console]::Error.WriteLine("LabWired Editor is not installed.")
    [Console]::Error.WriteLine("Install LabWired Editor, then run: labwired editor")
    exit 1
  }
  { $_ -in $legacyCore } { Invoke-Component -Path (Get-CoreBin) -Name "Core" -Arguments ([string[]]@($Rest)) }
  default {
    [Console]::Error.WriteLine("labwired: unknown command: $command")
    [Console]::Error.WriteLine("Run: labwired --help")
    exit 2
  }
}
