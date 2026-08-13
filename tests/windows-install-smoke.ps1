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
$LifecycleFile = Join-Path $EvidenceDir "lifecycle.txt"
$OwnershipSnapshot = Join-Path $SessionRoot "installed-ownership.manifest"
$LifecyclePhase = "not-started"
$LifecycleStarted = $false
$PowerShellExe = if ($PSVersionTable.PSEdition -eq "Core") {
  Join-Path $PSHOME "pwsh.exe"
} else {
  Join-Path $PSHOME "powershell.exe"
}
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

function Start-LifecyclePhase([string]$Name) {
  $script:LifecyclePhase = $Name
  if (-not $script:LifecycleStarted) {
    [IO.File]::WriteAllText($LifecycleFile, "", (New-Object Text.UTF8Encoding($false)))
    $script:LifecycleStarted = $true
  }
  Add-Content -LiteralPath $LifecycleFile -Value "phase=$Name" -Encoding ASCII
}

function Complete-LifecyclePhase([string]$Name) {
  if ($Name -ne $script:LifecyclePhase) {
    throw "lifecycle phase mismatch: active=$($script:LifecyclePhase) passed=$Name"
  }
  if ($env:LABWIRED_TEST_FAIL_PHASE -eq $Name) {
    throw "injected lifecycle failure: $Name"
  }
  Add-Content -LiteralPath $LifecycleFile -Value "$Name=PASS" -Encoding ASCII
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

function Test-JsonProperty([object]$Object, [string]$Name) {
  return ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name])
}

function Assert-OwnedConfigRemoved([string]$ConfigRoot, [string]$ManifestPath) {
  $configPath = Join-Path $ConfigRoot "opencode.json"
  $config = if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  } else {
    [pscustomobject]@{}
  }

  foreach ($entry in @(Get-Content -LiteralPath $ManifestPath)) {
    if (-not $entry) { continue }
    if ($entry -eq "opencode.json") { continue }
    if ($entry.StartsWith("json-file:tui.json:")) {
      $property = $entry.Substring("json-file:tui.json:".Length)
      $tui = Get-Content -LiteralPath (Join-Path $ConfigRoot "tui.json") -Raw | ConvertFrom-Json
      if (Test-JsonProperty $tui $property) { throw "owned TUI JSON entry remains: $property" }
      continue
    }
    if ($entry -eq "json-array:tui.json:plugin") {
      $tui = Get-Content -LiteralPath (Join-Path $ConfigRoot "tui.json") -Raw | ConvertFrom-Json
      if (@($tui.plugin) -contains "./plugins/labwired-brand.tsx") {
        throw "owned TUI plugin remains"
      }
      continue
    }
    if ($entry.StartsWith("json-array-value:opencode.json:")) {
      $parts = @($entry -split ":", 4)
      $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
      if (@($config.PSObject.Properties[$parts[2]].Value) -contains $parts[3]) {
        throw "owned config array value remains: $($parts[2])=$($parts[3])"
      }
      continue
    }
    if ($entry.StartsWith("json:")) {
      $jsonPath = $entry.Substring(5)
      $parts = @($jsonPath -split "\.")
      if (-not $jsonPath -or @($parts | Where-Object { -not $_ }).Count -gt 0) {
        throw "invalid owned JSON entry: $entry"
      }
      $node = $config
      $found = $true
      foreach ($part in $parts) {
        if (-not (Test-JsonProperty $node $part)) {
          $found = $false
          break
        }
        $node = $node.PSObject.Properties[$part].Value
      }
      if ($found) { throw "owned JSON entry remains: $jsonPath" }
      continue
    }

    if ([IO.Path]::IsPathRooted($entry) -or @($entry -split "[\\/]" | Where-Object { $_ -in @("", ".", "..") }).Count -gt 0) {
      throw "invalid owned file entry: $entry"
    }
    $ownedPath = Join-Path $ConfigRoot ($entry -replace "/", "\")
    if (Test-Path -LiteralPath $ownedPath) { throw "owned file remains: $entry" }
  }
}

function Assert-UserConfigPreserved {
  $prefixSentinel = Join-Path $Prefix "user-data\lifecycle-sentinel.txt"
  $configSentinel = Join-Path $ConfigDir "lifecycle-sentinel.txt"
  if ((Get-Content -LiteralPath $prefixSentinel -Raw).Trim() -ne "keep-prefix-data") {
    throw "prefix sentinel was not preserved"
  }
  if ((Get-Content -LiteralPath $configSentinel -Raw).Trim() -ne "keep-user-config") {
    throw "config sentinel was not preserved"
  }
  $config = Get-Content -LiteralPath (Join-Path $ConfigDir "opencode.json") -Raw | ConvertFrom-Json
  if ($config.user_lifecycle.sentinel -ne "keep-user-config" -or $config.user_setting -ne "unrelated-value") {
    throw "unrelated user config was not preserved"
  }
}

function Assert-UserStatePreserved {
  Assert-UserConfigPreserved
  $tui = Get-Content -LiteralPath (Join-Path $ConfigDir "tui.json") -Raw | ConvertFrom-Json
  if ($tui.user_tui -ne "unrelated-value" -or @($tui.plugin) -notcontains "./plugins/user-plugin.tsx") {
    throw "unrelated user TUI config was not preserved"
  }
  if ($tui.theme -ne "user-custom-theme" -or $tui.pre_migration_user -ne "preserved") {
    throw "pre-migration user TUI changes were not preserved"
  }
}

function Assert-AgentConfigPresent([string]$ExpectedTheme = "labwired") {
  $config = Get-Content -LiteralPath (Join-Path $ConfigDir "opencode.json") -Raw | ConvertFrom-Json
  if (-not (Test-JsonProperty $config "model")) { throw "Agent model config is missing" }
  if (-not (Test-JsonProperty $config "default_agent")) { throw "Agent default_agent config is missing" }
  if (-not (Test-JsonProperty $config "agent")) { throw "Agent persona config is missing" }
  if (-not (Test-JsonProperty $config "mcp") -or -not (Test-JsonProperty $config.mcp "labwired")) {
    throw "Agent MCP config is missing"
  }
  if (-not (Test-JsonProperty $config "provider") -or -not (Test-JsonProperty $config.provider "labwired-local")) {
    throw "Agent provider config is missing"
  }
  $tui = Get-Content -LiteralPath (Join-Path $ConfigDir "tui.json") -Raw | ConvertFrom-Json
  if ($tui.theme -ne $ExpectedTheme -or @($tui.plugin) -notcontains "./plugins/labwired-brand.tsx") {
    throw "Agent TUI config is missing"
  }
}

try {
  New-Item -ItemType Directory -Path $EvidenceDir, $TestBin, $ConfigDir, (Join-Path $Prefix "user-data") -Force | Out-Null
  Write-Result "FAIL"
  @(
    "os=$([Runtime.InteropServices.RuntimeInformation]::OSDescription)"
    "os_architecture=$([Runtime.InteropServices.RuntimeInformation]::OSArchitecture)"
    "process_architecture=$([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture)"
    "powershell=$($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)"
  ) | Set-Content -LiteralPath (Join-Path $EvidenceDir "platform.txt") -Encoding UTF8
  foreach ($file in @("install.txt", "version.txt", "doctor.txt", "lifecycle.txt", "capabilities.txt")) {
    Set-Content -LiteralPath (Join-Path $EvidenceDir $file) -Value "not-run" -Encoding ASCII
  }

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

  Set-Content -LiteralPath (Join-Path $Prefix "user-data\lifecycle-sentinel.txt") -Value "keep-prefix-data" -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $ConfigDir "lifecycle-sentinel.txt") -Value "keep-user-config" -Encoding ASCII
  [IO.File]::WriteAllText(
    (Join-Path $ConfigDir "opencode.json"),
    '{"user_lifecycle":{"sentinel":"keep-user-config"},"user_setting":"unrelated-value"}',
    (New-Object Text.UTF8Encoding($false))
  )
  $installer = Join-Path $Root "scripts\install.ps1"
  $installArgs = @("-Prefix", $Prefix, "-UserBin", $UserBin, "-AgentOnly", "-SkipOpenCode", "-SkipPathUpdate")
  Start-LifecyclePhase "initial-install"
  $installStatus = Invoke-Captured -OutputPath (Join-Path $EvidenceDir "install.txt") -Command {
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $installer @installArgs
  }
  if ($installStatus -ne 0) { throw "Windows source install failed with code $installStatus" }
  $dispatcher = Join-Path $Prefix "bin\labwired.ps1"
  $cmd = Join-Path $UserBin "labwired.cmd"
  if (-not (Test-Path -LiteralPath (Join-Path $Prefix "agent\bin\labwired-agent.ps1") -PathType Leaf)) {
    throw "Agent launcher was not installed"
  }
  if (-not (Test-Path -LiteralPath $dispatcher -PathType Leaf) -or -not (Test-Path -LiteralPath $cmd -PathType Leaf)) {
    throw "Agent dispatchers were not installed"
  }
  Assert-AgentConfigPresent
  Assert-UserConfigPreserved
  Complete-LifecyclePhase "initial-install"

  Start-LifecyclePhase "initial-version"
  $versionStatus = Invoke-Captured -OutputPath (Join-Path $EvidenceDir "version.txt") -Command {
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $dispatcher agent version
  }
  if ($versionStatus -ne 0) { throw "labwired agent version failed with code $versionStatus" }
  $versionText = Get-Content -LiteralPath (Join-Path $EvidenceDir "version.txt") -Raw
  if ($versionText -notmatch "LabWired Agent" -or $versionText -notmatch "(?m)^version  ") {
    throw "initial Agent version output is incomplete"
  }
  Complete-LifecyclePhase "initial-version"

  Start-LifecyclePhase "initial-doctor"
  $doctorStatus = Invoke-Captured -OutputPath (Join-Path $EvidenceDir "doctor.txt") -Command {
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $dispatcher agent doctor
  }
  if ($doctorStatus -ne 0) { throw "labwired agent doctor failed with code $doctorStatus" }
  $doctorText = Get-Content -LiteralPath (Join-Path $EvidenceDir "doctor.txt") -Raw
  if ($doctorText -notmatch "agent-runtime" -or $doctorText -notmatch "ready") {
    throw "initial Agent doctor output is incomplete"
  }
  Complete-LifecyclePhase "initial-doctor"

  Start-LifecyclePhase "legacy-tui-ownership-migration"
  $manifestPath = Join-Path $ConfigDir "labwired-agent.manifest"
  $legacyManifest = @(
    Get-Content -LiteralPath $manifestPath | Where-Object {
      -not $_.StartsWith("json-file:tui.json:") -and $_ -ne "json-array:tui.json:plugin"
    }
  ) + "tui.json"
  $legacyManifest | Set-Content -LiteralPath $manifestPath -Encoding ASCII
  $legacyTuiPath = Join-Path $ConfigDir "tui.json"
  $legacyTui = Get-Content -LiteralPath $legacyTuiPath -Raw | ConvertFrom-Json
  $legacyTui | Add-Member -NotePropertyName theme -NotePropertyValue "user-custom-theme" -Force
  $legacyTui | Add-Member -NotePropertyName pre_migration_user -NotePropertyValue "preserved" -Force
  if (Test-JsonProperty $legacyTui '$schema') { $legacyTui.PSObject.Properties.Remove('$schema') }
  $legacyTui | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $legacyTuiPath -Encoding UTF8
  $migrationOutputPath = Join-Path $SessionRoot "migration-install.txt"
  $migrationStatus = Invoke-Captured -OutputPath $migrationOutputPath -Command {
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $installer @installArgs
  }
  if ($migrationStatus -ne 0) { throw "legacy TUI ownership migration install failed with code $migrationStatus" }
  $migratedOwnership = @(Get-Content -LiteralPath $manifestPath)
  if ($migratedOwnership -contains "tui.json") { throw "legacy whole-file TUI ownership was not removed" }
  foreach ($marker in @('json-array:tui.json:plugin')) {
    if ($migratedOwnership -notcontains $marker) { throw "missing migrated granular TUI ownership: $marker" }
  }
  foreach ($marker in @('json-file:tui.json:theme', 'json-file:tui.json:$schema')) {
    if ($migratedOwnership -contains $marker) { throw "user-modified TUI field remained Agent-owned: $marker" }
  }
  Complete-LifecyclePhase "legacy-tui-ownership-migration"

  Start-LifecyclePhase "post-install-user-tui"
  $tuiPath = Join-Path $ConfigDir "tui.json"
  $tui = Get-Content -LiteralPath $tuiPath -Raw | ConvertFrom-Json
  $tui | Add-Member -NotePropertyName user_tui -NotePropertyValue "unrelated-value" -Force
  $plugins = @($tui.plugin) + "./plugins/user-plugin.tsx"
  $tui | Add-Member -NotePropertyName plugin -NotePropertyValue $plugins -Force
  $tui | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $tuiPath -Encoding UTF8
  Assert-UserStatePreserved
  Complete-LifecyclePhase "post-install-user-tui"

  Start-LifecyclePhase "initial-cmd-dispatch"
  $cmdOutput = & cmd.exe /d /c "`"$cmd`" agent version" 2>&1
  if ($LASTEXITCODE -ne 0 -or (($cmdOutput -join "`n") -notmatch "LabWired Agent")) {
    throw "installed cmd dispatcher did not route agent version"
  }
  Complete-LifecyclePhase "initial-cmd-dispatch"

  Start-LifecyclePhase "ownership-snapshot"
  $manifest = Join-Path $ConfigDir "labwired-agent.manifest"
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw "Agent ownership manifest is missing" }
  Copy-Item -LiteralPath $manifest -Destination $OwnershipSnapshot
  $ownershipEntries = @(Get-Content -LiteralPath $OwnershipSnapshot | Where-Object { $_ })
  if (-not @($ownershipEntries | Where-Object { $_.StartsWith("json:") }).Count) {
    throw "Agent ownership manifest has no merged JSON entries"
  }
  if (-not @($ownershipEntries | Where-Object { -not $_.StartsWith("json:") }).Count) {
    throw "Agent ownership manifest has no owned files"
  }
  Complete-LifecyclePhase "ownership-snapshot"

  # Required records include phase=uninstall and phase=reinstall. The uninstall
  # command is agent package uninstall --yes in a nested matching PowerShell so
  # the launcher's exit cannot terminate this evidence process.
  Start-LifecyclePhase "uninstall"
  $uninstallOutputPath = Join-Path $SessionRoot "uninstall.txt"
  $uninstallStatus = Invoke-Captured -OutputPath $uninstallOutputPath -Command {
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $dispatcher agent package uninstall --yes
  }
  Get-Content -LiteralPath $uninstallOutputPath | Add-Content -LiteralPath $LifecycleFile -Encoding UTF8
  if ($uninstallStatus -ne 0) { throw "Agent uninstall failed with code $uninstallStatus" }
  foreach ($ownedKitPath in @(
    (Join-Path $Prefix "agent"),
    (Join-Path $Prefix "state\agent"),
    (Join-Path $Prefix "bin\labwired.ps1"),
    (Join-Path $Prefix "bin\labwired.cmd"),
    (Join-Path $Prefix "bin\labwired-agent.ps1"),
    (Join-Path $UserBin "labwired.cmd")
  )) {
    if (Test-Path -LiteralPath $ownedKitPath) { throw "Agent-owned kit path remains: $ownedKitPath" }
  }
  Assert-OwnedConfigRemoved $ConfigDir $OwnershipSnapshot
  if (Test-Path -LiteralPath $manifest) { throw "Agent ownership manifest remains after uninstall" }
  Assert-UserStatePreserved
  Complete-LifecyclePhase "uninstall"

  Start-LifecyclePhase "reinstall"
  $reinstallOutputPath = Join-Path $SessionRoot "reinstall.txt"
  $reinstallStatus = Invoke-Captured -OutputPath $reinstallOutputPath -Command {
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $installer @installArgs
  }
  Get-Content -LiteralPath $reinstallOutputPath | Add-Content -LiteralPath (Join-Path $EvidenceDir "install.txt") -Encoding UTF8
  if ($reinstallStatus -ne 0) { throw "Windows source reinstall failed with code $reinstallStatus" }
  if (-not (Test-Path -LiteralPath (Join-Path $Prefix "agent\bin\labwired-agent.ps1") -PathType Leaf)) {
    throw "Agent launcher did not return after reinstall"
  }
  if (-not (Test-Path -LiteralPath $dispatcher -PathType Leaf) -or -not (Test-Path -LiteralPath $cmd -PathType Leaf)) {
    throw "Agent dispatchers did not return after reinstall"
  }
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw "Agent ownership manifest did not return" }
  Assert-AgentConfigPresent "user-custom-theme"
  Assert-UserStatePreserved
  Complete-LifecyclePhase "reinstall"

  Start-LifecyclePhase "reinstalled-version"
  $reinstalledVersionPath = Join-Path $SessionRoot "reinstalled-version.txt"
  $versionStatus = Invoke-Captured -OutputPath $reinstalledVersionPath -Command {
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $dispatcher agent version
  }
  Get-Content -LiteralPath $reinstalledVersionPath | Add-Content -LiteralPath (Join-Path $EvidenceDir "version.txt") -Encoding UTF8
  if ($versionStatus -ne 0) { throw "reinstalled labwired agent version failed with code $versionStatus" }
  $versionText = Get-Content -LiteralPath $reinstalledVersionPath -Raw
  if ($versionText -notmatch "LabWired Agent" -or $versionText -notmatch "(?m)^version  ") {
    throw "reinstalled Agent version output is incomplete"
  }
  Complete-LifecyclePhase "reinstalled-version"

  Start-LifecyclePhase "reinstalled-doctor"
  $reinstalledDoctorPath = Join-Path $SessionRoot "reinstalled-doctor.txt"
  $doctorStatus = Invoke-Captured -OutputPath $reinstalledDoctorPath -Command {
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $dispatcher agent doctor
  }
  Get-Content -LiteralPath $reinstalledDoctorPath | Add-Content -LiteralPath (Join-Path $EvidenceDir "doctor.txt") -Encoding UTF8
  if ($doctorStatus -ne 0) { throw "reinstalled labwired agent doctor failed with code $doctorStatus" }
  $doctorText = Get-Content -LiteralPath $reinstalledDoctorPath -Raw
  if ($doctorText -notmatch "agent-runtime" -or $doctorText -notmatch "ready") {
    throw "reinstalled Agent doctor output is incomplete"
  }
  $combined = (
    (Get-Content -LiteralPath (Join-Path $EvidenceDir "version.txt") -Raw) +
    (Get-Content -LiteralPath (Join-Path $EvidenceDir "doctor.txt") -Raw)
  )
  if ($combined -match "Failed to change directory" -or $combined -match "(?im)(^|[^a-z])not ready([^a-z]|$)") {
    throw "installed Windows command dispatch or doctor output is not ready"
  }
  Assert-AgentConfigPresent "user-custom-theme"
  Assert-UserStatePreserved
  Complete-LifecyclePhase "reinstalled-doctor"

  Start-LifecyclePhase "final-evidence"
  @(
    "simulator=$(if (Test-Path (Join-Path $Prefix 'tools\sim\labwired-sim.exe')) { 'present' } else { 'absent' })"
    "probe=$(if (Test-Path (Join-Path $Prefix 'tools\probe-rs\probe-rs.exe')) { 'present' } else { 'absent' })"
    "verification_fallback=hosted-or-wsl"
  ) | Set-Content -LiteralPath (Join-Path $EvidenceDir "capabilities.txt") -Encoding UTF8
  Assert-UserStatePreserved
  foreach ($file in @("platform.txt", "install.txt", "version.txt", "doctor.txt", "lifecycle.txt", "capabilities.txt", "result.txt")) {
    $evidencePath = Join-Path $EvidenceDir $file
    if (-not (Test-Path -LiteralPath $evidencePath -PathType Leaf) -or (Get-Item -LiteralPath $evidencePath).Length -eq 0) {
      throw "required evidence is empty: $file"
    }
  }
  Complete-LifecyclePhase "final-evidence"
  Add-Content -LiteralPath $LifecycleFile -Value "prefix_sentinel=preserved" -Encoding ASCII
  Add-Content -LiteralPath $LifecycleFile -Value "config_sentinel=preserved" -Encoding ASCII
  Add-Content -LiteralPath $LifecycleFile -Value "result=PASS" -Encoding ASCII
  Write-Result "PASS"
  Write-Host "ok   windows-install-smoke PASS"
} catch {
  Write-Result "FAIL"
  if ($LifecycleStarted) {
    Add-Content -LiteralPath $LifecycleFile -Value "failed_phase=$LifecyclePhase" -Encoding ASCII
    Add-Content -LiteralPath $LifecycleFile -Value "result=FAIL" -Encoding ASCII
  }
  throw
} finally {
  foreach ($key in $Original.Keys) {
    [Environment]::SetEnvironmentVariable($key, $Original[$key], "Process")
  }
  if (Test-Path -LiteralPath $SessionRoot) {
    Remove-Item -LiteralPath $SessionRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
