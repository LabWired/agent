#Requires -Version 5.1
<# Upgrade evidence from an explicitly pinned, checksum-verified previous zip. #>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$SessionRoot = Join-Path ([IO.Path]::GetTempPath()) ("labwired-upgrade-evidence-" + [guid]::NewGuid().ToString("n"))
$EvidenceDir = if ($env:LABWIRED_EVIDENCE_DIR) {
  $env:LABWIRED_EVIDENCE_DIR
} else {
  Join-Path $Root ("evidence\upgrade-windows-" + $PSVersionTable.PSEdition.ToLowerInvariant())
}
$Prefix = Join-Path $SessionRoot "prefix"
$UserBin = Join-Path $SessionRoot "user-bin"
$ConfigDir = Join-Path $SessionRoot "config"
$TestBin = Join-Path $SessionRoot "test-bin"
$ExtractRoot = Join-Path $SessionRoot "extracted"
$LifecycleFile = Join-Path $EvidenceDir "lifecycle.txt"
$OwnershipSnapshot = Join-Path $SessionRoot "current-ownership.manifest"
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
  LABWIRED_FAST = $env:LABWIRED_FAST
  LABWIRED_INSTALL_PIO = $env:LABWIRED_INSTALL_PIO
  LABWIRED_ACCESS_TOKEN = $env:LABWIRED_ACCESS_TOKEN
  LABWIRED_PROJECT = $env:LABWIRED_PROJECT
  Path = $env:Path
}

function Set-Evidence([string]$Name, [string]$Value) {
  Set-Content -LiteralPath (Join-Path $EvidenceDir $Name) -Value $Value -Encoding ASCII
}

function Write-Result([string]$Value) {
  Set-Evidence "result.txt" $Value
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
  Add-Content -LiteralPath $LifecycleFile -Value "$Name=PASS" -Encoding ASCII
}

function Invoke-Captured {
  param([scriptblock]$Command, [string]$OutputPath, [string]$FailureLabel, [switch]$Append)
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $global:LASTEXITCODE = 0
    $raw = & $Command 2>&1
    $status = $LASTEXITCODE
    if ($null -eq $status) { $status = if ($?) { 0 } else { 1 } }
  } finally {
    $ErrorActionPreference = $oldPreference
  }
  $lines = @($raw | ForEach-Object { $_.ToString() })
  if ($lines.Count -eq 0) { $lines = @("$FailureLabel produced no output (exit $status)") }
  $temporaryPath = Join-Path (Split-Path -Parent $OutputPath) (".upgrade-evidence-" + [guid]::NewGuid().ToString("n") + ".tmp")
  $content = @()
  if ($Append -and (Test-Path -LiteralPath $OutputPath -PathType Leaf) -and (Get-Item -LiteralPath $OutputPath).Length -gt 0) {
    $content += @(Get-Content -LiteralPath $OutputPath)
    $content += @("", "== $FailureLabel ==")
  }
  $content += $lines
  $content | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
  if (Test-Path -LiteralPath $OutputPath -PathType Leaf) {
    [IO.File]::Replace($temporaryPath, $OutputPath, $null)
  } else {
    Move-Item -LiteralPath $temporaryPath -Destination $OutputPath
  }
  return [int]$status
}

function Test-JsonProperty([object]$Object, [string]$Name) {
  return ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name])
}

function Assert-ExactVersion([string]$Path, [string]$Expected) {
  $lines = @((Get-Content -LiteralPath $Path) | ForEach-Object { $_.ToString() })
  if ($lines -notcontains "LabWired Agent") { throw "version output does not identify LabWired Agent" }
  $versionLines = @($lines | Where-Object { $_ -match "^version  " })
  if ($versionLines.Count -ne 1 -or $versionLines[0] -cne "version  $Expected") {
    throw "version output does not exactly match $Expected"
  }
}

function ConvertTo-StableVersionTuple([string]$Value, [string]$Label) {
  if ($Value -notmatch "^[0-9]+\.[0-9]+\.[0-9]+$") {
    throw "$Label must be a stable numeric X.Y.Z version"
  }
  return @($Value.Split(".") | ForEach-Object { [uint64]::Parse($_, [Globalization.CultureInfo]::InvariantCulture) })
}

function Test-VersionOlder([uint64[]]$Previous, [uint64[]]$Current) {
  for ($index = 0; $index -lt 3; $index++) {
    if ($Previous[$index] -lt $Current[$index]) { return $true }
    if ($Previous[$index] -gt $Current[$index]) { return $false }
  }
  return $false
}

function Assert-UserSentinels {
  if ((Get-Content -LiteralPath (Join-Path $Prefix "user-data\upgrade-sentinel.txt") -Raw).Trim() -ne "keep-prefix-data") {
    throw "prefix sentinel was not preserved"
  }
  if ((Get-Content -LiteralPath (Join-Path $ConfigDir "upgrade-sentinel.txt") -Raw).Trim() -ne "keep-user-config") {
    throw "config sentinel was not preserved"
  }
  $config = Get-Content -LiteralPath (Join-Path $ConfigDir "opencode.json") -Raw | ConvertFrom-Json
  if ($config.user_upgrade.sentinel -ne "keep-user-config") {
    throw "user JSON sentinel was not preserved"
  }
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
      $tuiPath = Join-Path $ConfigRoot "tui.json"
      if (Test-Path -LiteralPath $tuiPath -PathType Leaf) {
        $tui = Get-Content -LiteralPath $tuiPath -Raw | ConvertFrom-Json
        if (Test-JsonProperty $tui $property) { throw "owned TUI JSON entry remains: $property" }
      }
      continue
    }
    if ($entry -eq "json-array:tui.json:plugin") {
      $tuiPath = Join-Path $ConfigRoot "tui.json"
      if (Test-Path -LiteralPath $tuiPath -PathType Leaf) {
        $tui = Get-Content -LiteralPath $tuiPath -Raw | ConvertFrom-Json
        if (@($tui.plugin) -contains "./plugins/labwired-brand.tsx") { throw "owned TUI plugin remains" }
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
        if (-not (Test-JsonProperty $node $part)) { $found = $false; break }
        $node = $node.PSObject.Properties[$part].Value
      }
      if ($found) { throw "owned JSON entry remains: $jsonPath" }
      continue
    }

    if ([IO.Path]::IsPathRooted($entry) -or @($entry -split "[\\/]" | Where-Object { $_ -in @("", ".", "..") }).Count -gt 0) {
      throw "invalid owned file entry: $entry"
    }
    if (Test-Path -LiteralPath (Join-Path $ConfigRoot ($entry -replace "/", "\"))) {
      throw "owned file remains: $entry"
    }
  }
}

function Get-SafeZipParts([string]$Name) {
  if (-not $Name -or @($Name.ToCharArray() | Where-Object { [int]$_ -lt 32 }).Count -gt 0) {
    throw "unsafe archive member name"
  }
  $normalized = $Name.Replace("\", "/")
  if ($normalized.StartsWith("/") -or $normalized -match "^[A-Za-z]:") {
    throw "unsafe archive member path: $Name"
  }
  $trimmed = $normalized.TrimEnd([char]47)
  $parts = @($trimmed -split "/")
  if (-not $trimmed -or @($parts | Where-Object { $_ -in @("", ".", "..") }).Count -gt 0) {
    throw "unsafe archive member path: $Name"
  }
  return $parts
}

function Expand-CheckedZip([string]$ArchivePath, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $separator = [IO.Path]::DirectorySeparatorChar
  $rootFull = [IO.Path]::GetFullPath($Destination).TrimEnd($separator) + $separator
  [IO.Compression.ZipArchive]$archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $checked = @()
    foreach ($entry in $archive.Entries) {
      $parts = @(Get-SafeZipParts $entry.FullName)
      $unixType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
      $windowsAttributes = ($entry.ExternalAttributes -band 0xFFFF)
      if ($unixType -eq 0xA000 -or ($windowsAttributes -band [int][IO.FileAttributes]::ReparsePoint)) {
        throw "unsafe archive link/reparse member: $($entry.FullName)"
      }
      $relative = $parts -join [IO.Path]::DirectorySeparatorChar
      $target = [IO.Path]::GetFullPath((Join-Path $Destination $relative))
      if (-not $target.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw "unsafe archive destination: $($entry.FullName)"
      }
      $checked += [pscustomobject]@{ Entry = $entry; Target = $target }
    }
    foreach ($item in $checked) {
      if ($item.Entry.FullName.EndsWith("/") -or $item.Entry.FullName.EndsWith("\")) {
        New-Item -ItemType Directory -Path $item.Target -Force | Out-Null
        continue
      }
      $parent = Split-Path -Parent $item.Target
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
      $inputStream = $item.Entry.Open()
      $outputStream = [IO.File]::Create($item.Target)
      try { $inputStream.CopyTo($outputStream) }
      finally { $outputStream.Dispose(); $inputStream.Dispose() }
    }
  } finally {
    $archive.Dispose()
  }
  $reparse = Get-ChildItem -LiteralPath $Destination -Recurse -Force | Where-Object {
    $_.Attributes -band [IO.FileAttributes]::ReparsePoint
  } | Select-Object -First 1
  if ($reparse) { throw "unsafe extracted reparse point: $($reparse.FullName)" }
}

try {
  New-Item -ItemType Directory -Path $EvidenceDir -Force | Out-Null
  foreach ($file in @(
    "platform.txt", "previous-version.txt", "current-version.txt", "upgrade-install.txt",
    "doctor.txt", "lifecycle.txt", "capabilities.txt", "result.txt"
  )) { Set-Evidence $file "not-run" }
  @(
    "os=$([Runtime.InteropServices.RuntimeInformation]::OSDescription)"
    "os_architecture=$([Runtime.InteropServices.RuntimeInformation]::OSArchitecture)"
    "process_architecture=$([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture)"
    "powershell=$($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)"
  ) | Set-Content -LiteralPath (Join-Path $EvidenceDir "platform.txt") -Encoding UTF8

  $archiveInput = $env:LABWIRED_PREVIOUS_AGENT_ARCHIVE
  $previousVersion = $env:LABWIRED_PREVIOUS_AGENT_VERSION
  $expectedSha256 = $env:LABWIRED_PREVIOUS_AGENT_SHA256
  if (-not $archiveInput -and -not $previousVersion -and -not $expectedSha256) {
    Write-Output "not run"
    return
  }

  Write-Result "FAIL"
  Start-LifecyclePhase "validate-inputs"
  if (-not $archiveInput) { throw "LABWIRED_PREVIOUS_AGENT_ARCHIVE is required" }
  if (-not $previousVersion) { throw "LABWIRED_PREVIOUS_AGENT_VERSION is required" }
  if (-not $expectedSha256) {
    throw "LABWIRED_PREVIOUS_AGENT_SHA256 is required when LABWIRED_PREVIOUS_AGENT_ARCHIVE is supplied"
  }
  if ($expectedSha256 -notmatch "^[0-9a-fA-F]{64}$") {
    throw "LABWIRED_PREVIOUS_AGENT_SHA256 must be exactly 64 hexadecimal characters"
  }
  $previousTuple = ConvertTo-StableVersionTuple $previousVersion "LABWIRED_PREVIOUS_AGENT_VERSION"
  $currentVersion = (Get-Content -LiteralPath (Join-Path $Root "VERSION") -Raw).Trim()
  $currentTuple = ConvertTo-StableVersionTuple $currentVersion "current VERSION"
  if (-not (Test-VersionOlder $previousTuple $currentTuple)) {
    throw "previous Agent version $previousVersion must be older than current version $currentVersion"
  }
  if (-not (Test-Path -LiteralPath $archiveInput -PathType Leaf)) {
    throw "LABWIRED_PREVIOUS_AGENT_ARCHIVE must name a regular file"
  }
  $archiveItem = Get-Item -LiteralPath $archiveInput -Force
  if ($archiveItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "LABWIRED_PREVIOUS_AGENT_ARCHIVE must not be a reparse point"
  }
  Complete-LifecyclePhase "validate-inputs"

  New-Item -ItemType Directory -Path $SessionRoot -Force | Out-Null
  Start-LifecyclePhase "verify-checksum"
  $archiveCopy = Join-Path $SessionRoot "previous-agent.zip"
  Copy-Item -LiteralPath $archiveInput -Destination $archiveCopy
  $actualSha256 = (Get-FileHash -LiteralPath $archiveCopy -Algorithm SHA256).Hash
  if ($actualSha256 -ine $expectedSha256) { throw "checksum mismatch for LABWIRED_PREVIOUS_AGENT_ARCHIVE" }
  Complete-LifecyclePhase "verify-checksum"

  Start-LifecyclePhase "validate-archive"
  Expand-CheckedZip $archiveCopy $ExtractRoot
  $sourceCandidates = @(Get-ChildItem -LiteralPath $ExtractRoot -Recurse -Filter "install.ps1" -File | Where-Object {
    $_.Directory.Name -eq "scripts" -and (Test-Path -LiteralPath (Join-Path $_.Directory.Parent.FullName "VERSION") -PathType Leaf)
  } | ForEach-Object { $_.Directory.Parent.FullName } | Select-Object -Unique)
  if ($sourceCandidates.Count -ne 1) {
    throw "archive must contain exactly one scripts\install.ps1 + VERSION root; found $($sourceCandidates.Count)"
  }
  $previousSource = $sourceCandidates[0]
  $archivedVersion = (Get-Content -LiteralPath (Join-Path $previousSource "VERSION") -Raw).Trim()
  if ($archivedVersion -cne $previousVersion) {
    throw "archive VERSION $archivedVersion does not match LABWIRED_PREVIOUS_AGENT_VERSION $previousVersion"
  }
  Complete-LifecyclePhase "validate-archive"

  New-Item -ItemType Directory -Path $TestBin, $ConfigDir, (Join-Path $SessionRoot "home") -Force | Out-Null
  @('@echo off', 'if "%1"=="--version" echo opencode 1.18.7', 'exit /b 0') |
    Set-Content -LiteralPath (Join-Path $TestBin "opencode.cmd") -Encoding ASCII
  @('@echo off', 'exit /b 0') | Set-Content -LiteralPath (Join-Path $TestBin "npx.cmd") -Encoding ASCII
  $env:USERPROFILE = Join-Path $SessionRoot "home"
  $env:LABWIRED_HOME = $Prefix
  $env:LABWIRED_BIN_DIR = $UserBin
  $env:LABWIRED_AGENT_CONFIG_DIR = $ConfigDir
  $env:OPENCODE_CONFIG_DIR = $ConfigDir
  $env:LABWIRED_FAST = "1"
  $env:LABWIRED_INSTALL_PIO = "0"
  $env:LABWIRED_ACCESS_TOKEN = $null
  $env:LABWIRED_PROJECT = $null
  $env:Path = "$TestBin;$UserBin;$($Original.Path)"
  $installArgs = @("-Prefix", $Prefix, "-UserBin", $UserBin, "-AgentOnly", "-SkipOpenCode", "-SkipPathUpdate")

  Start-LifecyclePhase "previous-install"
  $previousInstallStatus = Invoke-Captured -FailureLabel "previous Agent install" -OutputPath (Join-Path $EvidenceDir "upgrade-install.txt") -Command {
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $previousSource "scripts\install.ps1") @installArgs
  }
  if ($previousInstallStatus -ne 0) { throw "previous Agent install failed with code $previousInstallStatus" }
  Complete-LifecyclePhase "previous-install"

  $dispatcher = Join-Path $Prefix "bin\labwired.ps1"
  Start-LifecyclePhase "previous-version"
  $previousVersionStatus = Invoke-Captured -FailureLabel "previous Agent version" -OutputPath (Join-Path $EvidenceDir "previous-version.txt") -Command {
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $dispatcher agent version
  }
  if ($previousVersionStatus -ne 0) { throw "previous Agent version failed with code $previousVersionStatus" }
  Assert-ExactVersion (Join-Path $EvidenceDir "previous-version.txt") $previousVersion
  Complete-LifecyclePhase "previous-version"

  Start-LifecyclePhase "sentinel-setup"
  New-Item -ItemType Directory -Path (Join-Path $Prefix "user-data") -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $Prefix "user-data\upgrade-sentinel.txt") -Value "keep-prefix-data" -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $ConfigDir "upgrade-sentinel.txt") -Value "keep-user-config" -Encoding ASCII
  $configPath = Join-Path $ConfigDir "opencode.json"
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  $config | Add-Member -NotePropertyName user_upgrade -NotePropertyValue ([pscustomobject]@{ sentinel = "keep-user-config" }) -Force
  $config | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $configPath -Encoding UTF8
  Assert-UserSentinels
  Complete-LifecyclePhase "sentinel-setup"

  Start-LifecyclePhase "current-upgrade-install"
  $currentInstallStatus = Invoke-Captured -Append -FailureLabel "current Agent install" -OutputPath (Join-Path $EvidenceDir "upgrade-install.txt") -Command {
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\install.ps1") @installArgs
  }
  if ($currentInstallStatus -ne 0) { throw "current Agent install failed with code $currentInstallStatus" }
  Assert-UserSentinels
  $manifestPath = Join-Path $ConfigDir "labwired-agent.manifest"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "current ownership manifest is missing" }
  Complete-LifecyclePhase "current-upgrade-install"

  Start-LifecyclePhase "current-version"
  $currentVersionStatus = Invoke-Captured -FailureLabel "current Agent version" -OutputPath (Join-Path $EvidenceDir "current-version.txt") -Command {
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $dispatcher agent version
  }
  if ($currentVersionStatus -ne 0) { throw "current Agent version failed with code $currentVersionStatus" }
  Assert-ExactVersion (Join-Path $EvidenceDir "current-version.txt") $currentVersion
  Complete-LifecyclePhase "current-version"

  Start-LifecyclePhase "current-doctor"
  $doctorStatus = Invoke-Captured -FailureLabel "current Agent doctor" -OutputPath (Join-Path $EvidenceDir "doctor.txt") -Command {
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $dispatcher agent doctor
  }
  if ($doctorStatus -ne 0) { throw "current Agent doctor failed with code $doctorStatus" }
  $doctorText = Get-Content -LiteralPath (Join-Path $EvidenceDir "doctor.txt") -Raw
  if ($doctorText -notmatch "agent-runtime" -or $doctorText -notmatch "ready" -or $doctorText -match "not ready") {
    throw "current Agent doctor is not ready"
  }
  Complete-LifecyclePhase "current-doctor"

  @(
    "simulator=" + $(if (Test-Path -LiteralPath (Join-Path $Prefix "tools\sim\labwired-sim.exe")) { "present" } else { "absent" })
    "probe=" + $(if (Test-Path -LiteralPath (Join-Path $Prefix "tools\probe-rs\probe-rs.exe")) { "present" } else { "absent" })
    "verification_fallback=hosted"
  ) | Set-Content -LiteralPath (Join-Path $EvidenceDir "capabilities.txt") -Encoding ASCII

  Start-LifecyclePhase "ownership-snapshot"
  Copy-Item -LiteralPath $manifestPath -Destination $OwnershipSnapshot
  if (-not @(Get-Content -LiteralPath $OwnershipSnapshot | Where-Object { $_.StartsWith("json:") }).Count) {
    throw "ownership manifest has no Agent-owned JSON paths"
  }
  if (-not @(Get-Content -LiteralPath $OwnershipSnapshot | Where-Object { $_ -and -not $_.StartsWith("json:") }).Count) {
    throw "ownership manifest has no Agent-owned files"
  }
  Complete-LifecyclePhase "ownership-snapshot"

  # Run agent package uninstall --yes in the same engine family as this test.
  Start-LifecyclePhase "uninstall-current"
  $uninstallOutput = Join-Path $SessionRoot "uninstall.txt"
  $uninstallStatus = Invoke-Captured -FailureLabel "current Agent uninstall" -OutputPath $uninstallOutput -Command {
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $dispatcher agent package uninstall --yes
  }
  Get-Content -LiteralPath $uninstallOutput | Add-Content -LiteralPath $LifecycleFile -Encoding UTF8
  if ($uninstallStatus -ne 0) { throw "current Agent uninstall failed with code $uninstallStatus" }
  foreach ($ownedPath in @(
    (Join-Path $Prefix "agent"), (Join-Path $Prefix "state\agent"),
    (Join-Path $Prefix "bin\labwired.cmd"), (Join-Path $Prefix "bin\labwired.ps1"),
    (Join-Path $Prefix "bin\labwired-agent.ps1"), (Join-Path $UserBin "labwired.cmd")
  )) {
    if (Test-Path -LiteralPath $ownedPath) { throw "current Agent-owned path remains: $ownedPath" }
  }
  Assert-OwnedConfigRemoved $ConfigDir $OwnershipSnapshot
  if (Test-Path -LiteralPath $manifestPath) { throw "ownership manifest remains after uninstall" }
  Assert-UserSentinels
  Complete-LifecyclePhase "uninstall-current"

  Start-LifecyclePhase "final-evidence"
  foreach ($file in @(
    "platform.txt", "previous-version.txt", "current-version.txt", "upgrade-install.txt",
    "doctor.txt", "lifecycle.txt", "capabilities.txt", "result.txt"
  )) {
    $path = Join-Path $EvidenceDir $file
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) {
      throw "evidence file is missing or empty: $file"
    }
  }
  Complete-LifecyclePhase "final-evidence"
  @("prefix_sentinel=preserved", "config_sentinel=preserved", "ownership_cleanup=complete", "result=PASS") |
    Add-Content -LiteralPath $LifecycleFile -Encoding ASCII
  Write-Result "PASS"
  Write-Output "ok   windows-upgrade-smoke PASS"
} catch {
  if (Test-Path -LiteralPath $EvidenceDir) {
    Write-Result "FAIL"
    if ($script:LifecycleStarted) {
      @("failed_phase=$($script:LifecyclePhase)", "result=FAIL") |
        Add-Content -LiteralPath $LifecycleFile -Encoding ASCII
    }
  }
  Write-Error $_
  exit 1
} finally {
  foreach ($name in $Original.Keys) {
    Set-Item -Path "Env:$name" -Value $Original[$name]
  }
  if (Test-Path -LiteralPath $SessionRoot) {
    Remove-Item -LiteralPath $SessionRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
