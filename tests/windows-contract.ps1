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
$OriginalPath = $env:Path
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

function Invoke-Installer([string[]]$Arguments) {
  $output = & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $Installer @Arguments 2>&1 | Out-String
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
  $result = Invoke-Dispatcher @("core", "test", "quoted value", "trail\", "100%", "bang!", "a&b", "(group)")
  Assert-True ($result.Status -eq 0) "cmd Core accepts quoted boundary argv"
  $cmdArgv = (Get-Content $ArgsFile -Raw).Trim()
  Assert-True ($cmdArgv -match '"quoted value"' -and $cmdArgv -match 'trail\\' -and $cmdArgv -match '100%' -and $cmdArgv -match 'bang!' -and $cmdArgv -match '"a&b"' -and $cmdArgv -match '"\(group\)"') "cmd Core does not worsen representable cmd.exe argv"
  # Windows PowerShell 5.1 cannot represent an empty native-process argument
  # reliably. Empty argv is therefore asserted on the script component and
  # public cmd shim below; all representable native/cmd boundaries are covered.

  $result = Invoke-Dispatcher @("agent", "capture", "spaced value", "", "say`"hi", "tail")
  Assert-True ($result.Status -eq 0) "Agent argv capture exits zero"
  $actual = @(Get-Content $ArgsFile)
  Assert-True (($actual -join '|') -eq '<capture>|<spaced value>|<>|<say"hi>|<tail>') "script component preserves spaced, empty, and quoted argv"

  Remove-Item $ArgsFile -Force
  $shimCommand = '"{0}" agent capture "spaced value" "" tail' -f $Shim
  $shimOutput = & cmd.exe /d /s /c $shimCommand 2>&1 | Out-String
  Assert-True ($LASTEXITCODE -eq 0) "cmd shim exits zero"
  $actual = @(Get-Content $ArgsFile)
  Assert-True (($actual -join '|') -eq '<capture>|<spaced value>|<>|<tail>') "cmd shim preserves spaced and empty argv"

  $env:LABWIRED_CORE_BIN = $PowerShellExe
  $result = Invoke-Dispatcher @("core", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Agent, "native", "spaced value", "trail\", "100%", "bang!", "a&b", "(group)")
  Assert-True ($result.Status -eq 0) "native Core executable route exits zero"
  $actual = @(Get-Content $ArgsFile)
  Assert-True (($actual -join '|') -eq '<native>|<spaced value>|<trail\>|<100%>|<bang!>|<a&b>|<(group)>') "native Core preserves representable argv boundaries"
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
  @'
@echo off
REM LabWired Core launcher
REM LABWIRED_CORE_COMMAND_CONTRACT=argv-v1
echo migrated-core:%*
exit /b 0
'@ | Set-Content (Join-Path $installPrefix "bin\labwired.cmd") -Encoding ASCII
  $env:LABWIRED_WINDOWS_TEST_MODE = "1"
  $env:LABWIRED_TEST_CORE_CMD = Join-Path $installPrefix "bin\labwired.cmd"
  $env:OPENCODE_CONFIG_DIR = $configDir
  $installArgs = @("-Prefix", $installPrefix, "-UserBin", $userBin, "-AgentOnly", "-SkipOpenCode", "-SkipPathUpdate")
  $result = Invoke-Installer $installArgs
  Assert-True ($result.Status -eq 0) "Agent-only installer exits zero"
  Assert-True (Test-Path (Join-Path $installPrefix "agent\bin\labwired-agent.ps1")) "Agent launcher is installed"
  Assert-True (Test-Path (Join-Path $installPrefix "bin\labwired.ps1")) "dispatcher is installed"
  Assert-True (Test-Path (Join-Path $userBin "labwired.cmd")) "public cmd shim is installed"
  $installedHelp = & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installPrefix "bin\labwired.ps1") --help 2>&1 | Out-String
  Assert-True ($LASTEXITCODE -eq 0 -and $installedHelp -match 'labwired agent') "installed dispatcher runs"
  Assert-True (Test-Path (Join-Path $installPrefix "components\core\bin\labwired.cmd")) "static-identified Core is registered"
  $migratedCore = & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installPrefix "bin\labwired.ps1") core test "installed board" 2>&1 | Out-String
  Assert-True ($LASTEXITCODE -eq 0 -and $migratedCore -match 'migrated-core:test "installed board"') "migrated Core executes from registered layout"
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
  if ($junction -and (Test-Path $junction)) { $null = & cmd.exe /d /c rmdir $junction }
  Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  if ($outside) { Remove-Item $outside -Recurse -Force -ErrorAction SilentlyContinue }
}
