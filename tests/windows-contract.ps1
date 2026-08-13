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
$Installer = Join-Path $Root "scripts\install.ps1"
$Harness = Join-Path $Root ".github\workflows\harness.yml"
$OriginalPath = $env:Path
$InstallSmoke = Join-Path $Root "tests\windows-install-smoke.ps1"
$PowerShellExe = if ($PSVersionTable.PSEdition -eq "Core") {
  Join-Path $PSHOME "pwsh.exe"
} else {
  Join-Path $PSHOME "powershell.exe"
}

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "FAIL: $Message" }
  Write-Host "ok   $Message"
}

function Invoke-NativePowerShell([string[]]$ArgumentList) {
  # Call with call-operator (preserves argv). Soften ErrorAction so plain-text
  # nested stderr does not become a terminating CLIXML error; keep LASTEXITCODE
  # before any further pipeline processing.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $raw = & $PowerShellExe @ArgumentList 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  $text = @(
    $raw | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() }
      else { "$_" }
    }
  ) -join "`n"
  return @{ Output = $text; Status = $code }
}

function Invoke-Dispatcher([string[]]$Arguments) {
  return (Invoke-NativePowerShell (@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Dispatcher) + @($Arguments)))
}

function Invoke-DispatcherWithExactArgs([string[]]$Arguments) {
  $path64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Dispatcher))
  $encodedArgs = @($Arguments | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_)) })
  $literals = @($encodedArgs | ForEach-Object { "'$_'" }) -join ","
  $command = @"
`$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$path64'))
`$encoded = @($literals)
`$argv = @(`$encoded | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(`$_)) })
& `$path @argv
if (`$null -ne `$LASTEXITCODE) { exit `$LASTEXITCODE }
if (-not `$?) { exit 1 }
exit 0
"@
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  return (Invoke-NativePowerShell @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encodedCommand))
}

function Invoke-Installer([string[]]$Arguments) {
  return (Invoke-NativePowerShell (@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Installer) + @($Arguments)))
}

try {
  Assert-True (Test-Path -LiteralPath $InstallSmoke -PathType Leaf) "Windows install evidence script exists"
  $installSmokeText = Get-Content -LiteralPath $InstallSmoke -Raw
  foreach ($marker in @(
    "LABWIRED_EVIDENCE_DIR",
    "agent version",
    "agent doctor",
    "capabilities.txt",
    "lifecycle.txt",
    "result.txt",
    "PowerShellExe",
    "-File `$installer",
    "installed-ownership.manifest",
    "agent package uninstall --yes",
    "phase=uninstall",
    "phase=reinstall",
    "post-install-user-tui",
    "failed_phase=",
    'Write-Result "FAIL"',
    "Complete-LifecyclePhase",
    "prefix_sentinel=preserved",
    "config_sentinel=preserved"
  )) {
    Assert-True ($installSmokeText.Contains($marker)) "Windows install evidence includes $marker"
  }
  foreach ($file in @(
    (Join-Path $Root "bin\labwired.ps1"),
    (Join-Path $Root "bin\labwired-agent.ps1"),
    (Join-Path $Root "scripts\agent-install.ps1"),
    (Join-Path $Root "scripts\install.ps1"),
    (Join-Path $Root "tests\windows-contract.ps1"),
    (Join-Path $Root "tests\windows-install-smoke.ps1")
  )) {
    $bytes = [IO.File]::ReadAllBytes($file)
    Assert-True (-not ($bytes | Where-Object { $_ -gt 127 })) "$file is ASCII-compatible for Windows PowerShell 5.1"
  }
  $agentLauncherText = Get-Content -LiteralPath (Join-Path $Root "bin\labwired-agent.ps1") -Raw
  Assert-True ($agentLauncherText.Contains('(Get-Command npm -ErrorAction SilentlyContinue) -or (Get-Command npx -ErrorAction SilentlyContinue)')) "Windows doctor groups command availability checks"
  Assert-True ($agentLauncherText.Contains('Remove-AgentOwnedConfig')) "Windows uninstall removes only recorded Agent config ownership"
  Assert-True ($agentLauncherText.Contains('Remove-AgentKit')) "Windows uninstall removes the Agent kit through a safe lifecycle helper"
  Assert-True ($agentLauncherText.Contains('Assert-NoReparseTree')) "Windows uninstall rejects descendant reparse points before recursive deletion"
  Assert-True ($agentLauncherText.Contains('Assert-AgentUninstallSafe')) "Windows uninstall validates every target before mutation"
  Assert-True ($agentLauncherText.Contains('Join-Path $env:USERPROFILE ".config\opencode"')) "Windows install and uninstall share the default config path"
  Assert-True ($agentLauncherText.Contains('json-array:')) "Windows uninstall supports granular array ownership"
  $installerText = Get-Content -LiteralPath $Installer -Raw
  Assert-True ($installerText.Contains('labwired-agent.manifest')) "Windows installer records Agent config ownership"
  Assert-True ($installerText.Contains('json:')) "Windows installer records merged JSON ownership"
  Assert-True ($installerText.Contains('json-array:')) "Windows installer records granular TUI array ownership"
  Assert-True (-not $installerText.Contains('Add-OwnedEntry (Get-ConfigRelativePath $tuiDst)')) "fresh Windows TUI config uses granular ownership"
  $harnessText = Get-Content -LiteralPath $Harness -Raw
  Assert-True ($harnessText.Contains('windows\powershell') -and $harnessText.Contains('windows\pwsh')) "Windows engines write independent evidence directories"
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
  $result = Invoke-DispatcherWithExactArgs @("core", "test", "quoted value", "trail\", "100%", "bang!", "a&b", "(group)")
  Assert-True ($result.Status -eq 0) "cmd Core accepts quoted boundary argv"
  $cmdArgv = (Get-Content $ArgsFile -Raw).Trim()
  Assert-True ($cmdArgv -match '"quoted value"' -and $cmdArgv -match 'trail\\' -and $cmdArgv -match '100%' -and $cmdArgv -match 'bang!' -and $cmdArgv -match '"a&b"' -and $cmdArgv -match '"\(group\)"') "cmd Core does not worsen representable cmd.exe argv"
  # Invoke-Dispatcher uses powershell -File, which drops empty argv on the outer
  # hop. ExactArgs rehydrates the full vector so this contract is about the
  # product dispatcher, not the test harness launcher.
  $result = Invoke-DispatcherWithExactArgs @("agent", "capture", "spaced value", "", "say`"hi", "tail")
  Assert-True ($result.Status -eq 0) "Agent argv capture exits zero"
  $actual = @(Get-Content $ArgsFile)
  $joined = ($actual -join '|')
  $expected = '<capture>|<spaced value>|<>|<say"hi>|<tail>'
  if ($joined -ne $expected) {
    Write-Host "DEBUG agent argv actual=[$joined] expected=[$expected] raw-out=[$($result.Output)]" -ForegroundColor Yellow
  }
  Assert-True ($joined -eq $expected) "script component preserves spaced, empty, and quoted argv"

  Remove-Item $ArgsFile -Force
  $shimCommand = '"{0}" agent capture "spaced value" "" tail' -f $Shim
  $shimOutput = & cmd.exe /d /s /c $shimCommand 2>&1 | Out-String
  Assert-True ($LASTEXITCODE -eq 0) "cmd shim exits zero"
  $actual = @(Get-Content $ArgsFile)
  Assert-True (($actual -join '|') -eq '<capture>|<spaced value>|<>|<tail>') "cmd shim preserves spaced and empty argv"

  $nativeEcho = Join-Path $TempRoot "native-argv-echo.exe"
  $nativeSourcePath = Join-Path $TempRoot "native-argv-echo.cs"
  $nativeSource = @'
using System;
using System.Text;
public static class NativeArgvEcho {
  public static int Main(string[] args) {
    if (args.Length == 1 && args[0].StartsWith("--exit=")) return Int32.Parse(args[0].Substring(7));
    if (args.Length == 1 && args[0] == "--streams") { Console.Out.Write("native-out"); Console.Error.Write("native-err"); return 0; }
    foreach (string value in args) Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(value)));
    return 0;
  }
}
'@
  [IO.File]::WriteAllText($nativeSourcePath, $nativeSource, (New-Object Text.UTF8Encoding($false)))
  $cscCandidates = @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
  )
  $csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  Assert-True ([bool]$csc) "C# compiler fixture dependency is available"
  & $csc /nologo /target:exe "/out:$nativeEcho" $nativeSourcePath
  Assert-True ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $nativeEcho -PathType Leaf)) "native argv fixture compiles"
  $env:LABWIRED_CORE_BIN = $nativeEcho
  # Empty "" is covered by Agent/.ps1 and cmd-shim contracts. Native .exe launch
  # via ProcessStartInfo.Arguments (Windows PowerShell 5.1) cannot reliably encode
  # an empty argv slot; ArgumentList (pwsh) can, but this job also runs WinPS.
  $nativeArgs = @("spaced value", "say`"hi", "trail\", "slashes\\`"quote", "100%", "bang!", "a&b", "(group)")
  $result = Invoke-DispatcherWithExactArgs @(@("core") + $nativeArgs)
  Assert-True ($result.Status -eq 0) "native Core executable route exits zero"
  $expectedNative = @($nativeArgs | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_)) })
  $actualNative = @($result.Output -split "`r?`n" | Where-Object { $_.Length -gt 0 })
  $nativeJoined = ($actualNative -join '|')
  $nativeExpectedJoined = ($expectedNative -join '|')
  if ($nativeJoined -ne $nativeExpectedJoined) {
    $decoded = @($actualNative | ForEach-Object {
      try { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) } catch { "<bad:$_>" }
    })
    Write-Host ("DEBUG native actual=[{0}] decoded=[{1}]" -f $nativeJoined, ($decoded -join '|')) -ForegroundColor Yellow
  }
  Assert-True ($nativeJoined -eq $nativeExpectedJoined) "native Core preserves all argv boundaries"
  $result = Invoke-DispatcherWithExactArgs @("core", "--exit=23")
  Assert-True ($result.Status -eq 23) "native Core nonzero exit is propagated exactly"
  $result = Invoke-DispatcherWithExactArgs @("core", "--streams")
  # stdout must always surface. stderr is written to Console.Error by the
  # dispatcher; nesting another powershell in the harness often loses plain
  # stderr to CLIXML framing, so require stdout and best-effort stderr.
  Assert-True ($result.Status -eq 0 -and $result.Output -match 'native-out') "native Core stdout is forwarded"
  if ($result.Output -notmatch 'native-err') {
    Write-Host "warn: nested harness did not surface Core stderr (CLIXML)" -ForegroundColor Yellow
  }
  $env:LABWIRED_CORE_BIN = $Core

  $env:LABWIRED_AGENT_BIN = Join-Path $TempRoot "missing-agent.ps1"
  $result = Invoke-Dispatcher @("agent", "doctor")
  Assert-True ($result.Status -eq 1 -and $result.Output -match 'LabWired Agent is not installed') "missing Agent is clear"
  $env:LABWIRED_AGENT_BIN = $Agent

  $env:LABWIRED_CORE_BIN = Join-Path $TempRoot "missing-core.cmd"
  $result = Invoke-Dispatcher @("core", "test")
  Assert-True ($result.Status -eq 1 -and $result.Output -match 'LabWired Core is not installed') "missing Core is clear"

  $result = Invoke-Dispatcher @("not-a-command")
  Assert-True ($result.Status -eq 2 -and $result.Output -match 'unknown command') "unknown command exits two with a clear message"

  # Exercise the installed layout without network or user PATH mutation.
  $installPrefix = Join-Path $TempRoot "installed"
  $userBin = Join-Path $TempRoot "user-bin"
  $configDir = Join-Path $TempRoot "config"
  New-Item -ItemType Directory -Path (Join-Path $installPrefix "bin") -Force | Out-Null
  New-Item -ItemType Directory -Path $configDir -Force | Out-Null
  Set-Content (Join-Path $configDir "opencode.json") '{"user_owned":true}' -Encoding UTF8
  $coreCmdPath = Join-Path $installPrefix "bin\labwired.cmd"
  $coreCmdBody = "@echo off`nREM LabWired Core launcher`nREM LABWIRED_CORE_COMMAND_CONTRACT=argv-v1`necho migrated-core:%*`nexit /b 0`n"
  [IO.File]::WriteAllText($coreCmdPath, $coreCmdBody, (New-Object Text.UTF8Encoding($false)))
  $env:LABWIRED_WINDOWS_TEST_MODE = "1"
  $env:LABWIRED_TEST_CORE_CMD = [IO.Path]::GetFullPath($coreCmdPath)
  $env:OPENCODE_CONFIG_DIR = $configDir
  $installArgs = @("-Prefix", $installPrefix, "-UserBin", $userBin, "-AgentOnly", "-SkipOpenCode", "-SkipPathUpdate")
  $result = Invoke-Installer $installArgs
  if ($result.Status -ne 0) {
    Write-Host ("DEBUG installer status={0} mode={1} corecmd={2} out=[{3}]" -f $result.Status, $env:LABWIRED_WINDOWS_TEST_MODE, $env:LABWIRED_TEST_CORE_CMD, $result.Output) -ForegroundColor Yellow
  }
  Assert-True ($result.Status -eq 0) "Agent-only installer exits zero"
  Assert-True (Test-Path (Join-Path $installPrefix "agent\bin\labwired-agent.ps1")) "Agent launcher is installed"
  Assert-True (Test-Path (Join-Path $installPrefix "bin\labwired.ps1")) "dispatcher is installed"
  Assert-True (Test-Path (Join-Path $userBin "labwired.cmd")) "public cmd shim is installed"
  $installedHelp = & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installPrefix "bin\labwired.ps1") --help 2>&1 | Out-String
  Assert-True ($LASTEXITCODE -eq 0 -and $installedHelp -match 'labwired agent') "installed dispatcher runs"
  $registeredTestCore = Join-Path $installPrefix "components\core\bin\labwired.cmd"
  Assert-True (Test-Path $registeredTestCore) "static-identified test Core is registered"
  $env:LABWIRED_CORE_BIN = $registeredTestCore
  $migratedCore = & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installPrefix "bin\labwired.ps1") core test "installed board" 2>&1 | Out-String
  Assert-True ($LASTEXITCODE -eq 0 -and $migratedCore -match 'migrated-core:test "installed board"') "migrated Core executes from registered layout"
  $env:LABWIRED_CORE_BIN = $Core
  Assert-True ((Get-Content (Join-Path $configDir "opencode.json") -Raw) -match 'user_owned') "existing config is preserved"
  Assert-True (-not (Test-Path (Join-Path $installPrefix "tools"))) "Agent-only does not create tools"
  Assert-True (-not (Test-Path (Join-Path $installPrefix "cache"))) "Agent-only does not create cache"
  Assert-True ((Get-Content (Join-Path $installPrefix "MANIFEST.json") -Raw) -match 'not-installed') "manifest records absent components"

  Set-Content (Join-Path $installPrefix "agent\VERSION") "old-working" -Encoding ASCII
  Set-Content (Join-Path $installPrefix "bin\labwired.ps1") "# old-dispatcher" -Encoding ASCII
  $result = Invoke-Installer @($installArgs + "-TestFailAfterAgentSwap")
  Assert-True ($result.Status -ne 0 -and $result.Output -match 'injected failure') "injected post-swap failure is reported"
  Assert-True ((Get-Content (Join-Path $installPrefix "agent\VERSION") -Raw).Trim() -eq 'old-working') "failed install restores prior Agent"
  Assert-True ((Get-Content (Join-Path $installPrefix "bin\labwired.ps1") -Raw).Trim() -eq '# old-dispatcher') "failed install restores shared dispatcher state"
  Assert-True ((Get-Content (Join-Path $configDir "opencode.json") -Raw) -match 'user_owned') "failed install preserves shared config"

  $fakeGitBin = Join-Path $TempRoot "fake-git-bin"
  New-Item -ItemType Directory -Path $fakeGitBin | Out-Null
  Set-Content (Join-Path $fakeGitBin "git.cmd") "@echo off`nexit /b 7" -Encoding ASCII
  $savedPath = $env:Path
  $env:Path = "$fakeGitBin;$savedPath"
  $env:LABWIRED_HOME = $installPrefix
  $updateOutput = & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "bin\labwired-agent.ps1") update 2>&1 | Out-String
  $env:Path = $savedPath
  Assert-True ($LASTEXITCODE -ne 0 -and $updateOutput -match 'git clone failed') "failed self-update reports native git failure"
  Assert-True ((Get-Content (Join-Path $installPrefix "agent\VERSION") -Raw).Trim() -eq 'old-working') "failed self-update leaves Agent runnable"

  $result = Invoke-Installer @("-Prefix", (Join-Path $TempRoot "bad-mode"), "-UserBin", $userBin, "-AgentOnly", "-Full", "-SkipOpenCode", "-SkipPathUpdate")
  Assert-True ($result.Status -ne 0 -and $result.Output -match 'mutually exclusive') "component modes are mutually exclusive"

  $randomPrefix = Join-Path $TempRoot "random-core"
  New-Item -ItemType Directory -Path (Join-Path $randomPrefix "bin") -Force | Out-Null
  Set-Content (Join-Path $randomPrefix "bin\labwired.cmd") "@echo off`necho not-core" -Encoding ASCII
  $result = Invoke-Installer @("-Prefix", $randomPrefix, "-UserBin", (Join-Path $TempRoot "random-bin"), "-AgentOnly", "-SkipOpenCode", "-SkipPathUpdate")
  Assert-True ($result.Status -ne 0 -and $result.Output -match 'not an identified LabWired Core') "random launcher is rejected without execution"
  Assert-True ((Get-Content (Join-Path $randomPrefix "bin\labwired.cmd") -Raw) -match 'not-core') "rejected launcher is not overwritten"

  $spoofAgentPrefix = Join-Path $TempRoot "spoofed-agent-wrapper"
  New-Item -ItemType Directory -Path (Join-Path $spoofAgentPrefix "bin") -Force | Out-Null
  $spoofAgentCmd = Join-Path $spoofAgentPrefix "bin\labwired.cmd"
  $spoofContent = (Get-Content (Join-Path $Root "bin\labwired.cmd") -Raw) + "`r`necho destructive-extra-command`r`n"
  Set-Content $spoofAgentCmd $spoofContent -Encoding ASCII
  $result = Invoke-Installer @("-Prefix", $spoofAgentPrefix, "-UserBin", (Join-Path $TempRoot "spoof-agent-bin"), "-AgentOnly", "-SkipOpenCode", "-SkipPathUpdate")
  Assert-True ($result.Status -ne 0 -and $result.Output -match 'not an identified LabWired Core or Agent dispatcher') "spoofed canonical Agent wrapper is rejected"
  Assert-True ((Get-Content $spoofAgentCmd -Raw) -match 'destructive-extra-command') "spoofed Agent wrapper is preserved"

  $priorAgentPrefix = Join-Path $TempRoot "prior-agent-wrapper"
  New-Item -ItemType Directory -Path (Join-Path $priorAgentPrefix "bin") -Force | Out-Null
  $priorAgentContent = (Get-Content (Join-Path $Root "bin\labwired.cmd") -Raw).Replace(
    "REM LabWired product dispatcher - Windows entry (cmd.exe)",
    "REM LabWired Agent - Windows entry (cmd.exe)"
  )
  [IO.File]::WriteAllText((Join-Path $priorAgentPrefix "bin\labwired.cmd"), $priorAgentContent, (New-Object Text.UTF8Encoding($true)))
  $result = Invoke-Installer @("-Prefix", $priorAgentPrefix, "-UserBin", (Join-Path $TempRoot "prior-agent-bin"), "-AgentOnly", "-SkipOpenCode", "-SkipPathUpdate")
  Assert-True ($result.Status -eq 0) "exact prior canonical Agent wrapper is accepted"

  $spoofPrefix = Join-Path $TempRoot "spoofed-core"
  New-Item -ItemType Directory -Path (Join-Path $spoofPrefix "bin") -Force | Out-Null
  Set-Content (Join-Path $spoofPrefix "bin\labwired.cmd") "@echo off`nREM LabWired Core launcher`nREM LABWIRED_CORE_COMMAND_CONTRACT=argv-v1`necho spoofed" -Encoding ASCII
  $result = Invoke-Installer @("-Prefix", $spoofPrefix, "-UserBin", (Join-Path $TempRoot "spoof-bin"), "-AgentOnly", "-SkipOpenCode", "-SkipPathUpdate")
  Assert-True ($result.Status -ne 0 -and $result.Output -match 'not an identified LabWired Core') "marker-spoofed launcher is rejected"

  $outside = $TempRoot + "-outside"
  $junction = Join-Path $TempRoot "junction-prefix"
  New-Item -ItemType Directory -Path $outside | Out-Null
  Set-Content (Join-Path $outside "sentinel.txt") "keep" -Encoding ASCII
  $null = & cmd.exe /d /c mklink /J $junction $outside
  Assert-True ($LASTEXITCODE -eq 0) "test junction created"
  $result = Invoke-Installer @("-Prefix", $junction, "-UserBin", $userBin, "-AgentOnly", "-SkipOpenCode", "-SkipPathUpdate")
  Assert-True ($result.Status -ne 0 -and $result.Output -match 'reparse-point') "installer rejects junction prefix"
  Assert-True ((Get-Content (Join-Path $outside "sentinel.txt") -Raw).Trim() -eq 'keep') "junction rejection preserves external sentinel"

  $uninstallPrefix = Join-Path $TempRoot "uninstall-prefix"
  New-Item -ItemType Directory -Path $uninstallPrefix | Out-Null
  $agentJunction = Join-Path $uninstallPrefix "agent"
  $null = & cmd.exe /d /c mklink /J $agentJunction $outside
  $env:LABWIRED_HOME = $uninstallPrefix
  $uninstallOutput = & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "bin\labwired-agent.ps1") package uninstall --yes 2>&1 | Out-String
  Assert-True ($LASTEXITCODE -ne 0 -and $uninstallOutput -match 'reparse-point') "uninstall rejects junction Agent target"
  Assert-True ((Get-Content (Join-Path $outside "sentinel.txt") -Raw).Trim() -eq 'keep') "uninstall preserves external sentinel"

  if (Test-Path $agentJunction) { $null = & cmd.exe /d /c rmdir $agentJunction }
  $agentJunction = $null
  New-Item -ItemType Directory -Path (Join-Path $uninstallPrefix "agent\nested") -Force | Out-Null
  $descendantJunction = Join-Path $uninstallPrefix "agent\nested\outside"
  $null = & cmd.exe /d /c mklink /J $descendantJunction $outside
  Assert-True ($LASTEXITCODE -eq 0) "test descendant junction created"
  $uninstallOutput = & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "bin\labwired-agent.ps1") package uninstall --yes 2>&1 | Out-String
  Assert-True ($LASTEXITCODE -ne 0 -and $uninstallOutput -match 'reparse-point') "uninstall rejects descendant junction before recursive removal"
  Assert-True ((Get-Content (Join-Path $outside "sentinel.txt") -Raw).Trim() -eq 'keep') "descendant junction rejection preserves external sentinel"
  Write-Host "ok   windows-contract PASS"
} finally {
  Remove-Item Env:LABWIRED_AGENT_BIN -ErrorAction SilentlyContinue
  Remove-Item Env:LABWIRED_CORE_BIN -ErrorAction SilentlyContinue
  Remove-Item Env:LABWIRED_TEST_ARGS -ErrorAction SilentlyContinue
  Remove-Item Env:OPENCODE_CONFIG_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:LABWIRED_WINDOWS_TEST_MODE -ErrorAction SilentlyContinue
  Remove-Item Env:LABWIRED_TEST_CORE_CMD -ErrorAction SilentlyContinue
  $env:Path = $OriginalPath
  if ($agentJunction -and (Test-Path $agentJunction)) { $null = & cmd.exe /d /c rmdir $agentJunction }
  if ($descendantJunction -and (Test-Path $descendantJunction)) { $null = & cmd.exe /d /c rmdir $descendantJunction }
  if ($junction -and (Test-Path $junction)) { $null = & cmd.exe /d /c rmdir $junction }
  Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  if ($outside) { Remove-Item $outside -Recurse -Force -ErrorAction SilentlyContinue }
}
