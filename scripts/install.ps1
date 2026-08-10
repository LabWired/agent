#Requires -Version 5.1
<#
.SYNOPSIS
  LabWired Agent — portable, contained install for Windows (native).

.DESCRIPTION
  Mirrors Unix install.sh:
    $env:LABWIRED_HOME\   (default: %USERPROFILE%\.labwired)
      agent\              kit
      tools\sim\          labwired-sim.exe when a Windows prebuild exists
      tools\probe-rs\     probe-rs.exe
      tools\pio\          optional PlatformIO
      bin\                shims
      env.ps1             activate PATH
      MANIFEST.json

  Twin verify on Windows:
    - If a Windows sim prebuild is published → install into prefix
    - Else → use hosted MCP verify (api.labwired.com) or WSL for local sim
      (agent + skills + probe-rs still work natively)

.PARAMETER Prefix
  Install root (LABWIRED_HOME).

.PARAMETER Minimal
  Agent kit only (skip sim/probe/pio).

.PARAMETER AgentOnly
  Install only the Agent and shared dispatcher. This is the default mode.

.PARAMETER Airgap
  Require LABWIRED_MCP_ENTRY or mcp\vendor.

.EXAMPLE
  irm https://labwired.com/install/agent.ps1 | iex
  .\scripts\install.ps1 -Prefix $env:USERPROFILE\.labwired
#>
[CmdletBinding()]
param(
  [string]$Prefix = $(if ($env:LABWIRED_HOME) { $env:LABWIRED_HOME } else { Join-Path $env:USERPROFILE ".labwired" }),
  [switch]$Minimal,
  [switch]$AgentOnly,
  [switch]$Full,
  [switch]$Airgap,
  [switch]$SkipOpenCode,
  [switch]$SkipPathUpdate,
  [switch]$TestFailAfterAgentSwap,
  [string]$CoreVersion = $(if ($env:LABWIRED_CORE_VERSION) { $env:LABWIRED_CORE_VERSION } else { "latest" }),
  [string]$CoreRepo = $(if ($env:LABWIRED_CORE_REPO) { $env:LABWIRED_CORE_REPO } else { "w1ne/labwired-core" }),
  [string]$UserBin = $(if ($env:LABWIRED_BIN_DIR) { $env:LABWIRED_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "LabWired\bin" })
)

$ErrorActionPreference = "Stop"
$Src = Resolve-Path (Join-Path $PSScriptRoot "..")
$OpenCodePin = if ($env:OPENCODE_PIN) { $env:OPENCODE_PIN } else { "1.18.7" }
$modeCount = 0
foreach ($selectedMode in @($Minimal.IsPresent, $AgentOnly.IsPresent, $Full.IsPresent)) {
  if ($selectedMode) { $modeCount++ }
}
if ($modeCount -gt 1) { throw "-Minimal, -AgentOnly, and -Full are mutually exclusive" }
if ($modeCount -eq 0) { $AgentOnly = $true }

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn([string]$m) { Write-Host "warn: $m" -ForegroundColor Yellow }
function Ok([string]$m) { Write-Host "ok  $m" -ForegroundColor Green }
function Die([string]$m) { throw "error: $m" }

function Get-PlatformId {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  switch ($arch) {
    "x64" { "windows-x86_64" }
    "arm64" { "windows-aarch64" }
    default { "windows-$arch" }
  }
}

function Ensure-Dir([string]$p) {
  Assert-NoReparseAncestors $p
  if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
  Assert-NoReparseAncestors $p
}

function Test-ReparsePoint([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  return [bool]((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Assert-NoReparseAncestors([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while ($current) {
    if ((Test-Path -LiteralPath $current) -and (Test-ReparsePoint $current)) {
      Die "refusing reparse-point path ancestor: $current"
    }
    $parent = Split-Path -Parent $current
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
}

function Remove-Safe([string]$Path, [switch]$Recurse) {
  Assert-NoReparseAncestors $Path
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if ($Recurse) { Remove-Item -LiteralPath $Path -Recurse -Force }
  else { Remove-Item -LiteralPath $Path -Force }
}

function Copy-Safe([string]$Source, [string]$Destination, [switch]$Recurse) {
  Assert-NoReparseAncestors $Destination
  if ($Recurse) { Copy-Item -LiteralPath $Source -Destination $Destination -Recurse }
  else { Copy-Item -LiteralPath $Source -Destination $Destination }
}

function Move-Safe([string]$Source, [string]$Destination) {
  Assert-NoReparseAncestors $Source
  Assert-NoReparseAncestors $Destination
  Move-Item -LiteralPath $Source -Destination $Destination
}

function Protect-Mutation([string]$Path) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  foreach ($snapshot in @($script:MutationSnapshots)) {
    if ($snapshot.Path -eq $fullPath) { return }
  }
  Assert-NoReparseAncestors $fullPath
  if (-not $script:MutationState) {
    $script:MutationState = Join-Path $Prefix (".install-state-" + [guid]::NewGuid().ToString("n"))
    Ensure-Dir $script:MutationState
  }
  $exists = Test-Path -LiteralPath $fullPath
  $backup = Join-Path $script:MutationState ([guid]::NewGuid().ToString("n"))
  if ($exists) {
    if ((Get-Item -LiteralPath $fullPath).PSIsContainer) { Copy-Safe $fullPath $backup -Recurse }
    else { Copy-Safe $fullPath $backup }
  }
  $script:MutationSnapshots += @(@{ Path = $fullPath; Backup = $backup; Existed = $exists })
}

function Restore-Mutations {
  $snapshots = @($script:MutationSnapshots)
  [array]::Reverse($snapshots)
  foreach ($snapshot in $snapshots) {
    if (Test-Path -LiteralPath $snapshot.Path) {
      if ((Get-Item -LiteralPath $snapshot.Path).PSIsContainer) { Remove-Safe $snapshot.Path -Recurse }
      else { Remove-Safe $snapshot.Path }
    }
    if ($snapshot.Existed) {
      if ((Get-Item -LiteralPath $snapshot.Backup).PSIsContainer) { Copy-Safe $snapshot.Backup $snapshot.Path -Recurse }
      else { Copy-Safe $snapshot.Backup $snapshot.Path }
    }
  }
}

function Complete-Mutations {
  if ($script:MutationState -and (Test-Path -LiteralPath $script:MutationState)) {
    try { Remove-Safe $script:MutationState -Recurse } catch { Warn "could not remove install transaction state: $_" }
  }
}

function Assert-SafeComponentPath {
  # Canonical registration target: $Prefix\components\core\bin.
  $components = Join-Path $Prefix "components"
  $core = Join-Path $components "core"
  $coreBin = Join-Path $core "bin"
  Assert-NoReparseAncestors $coreBin
  Protect-Mutation $components
  foreach ($path in @($Prefix, $components, $core, $coreBin)) {
    if (Test-ReparsePoint $path) { Die "refusing reparse-point component path: $path" }
    Ensure-Dir $path
  }
  return $coreBin
}

function Test-ProductionCore([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Test-ReparsePoint $Path)) { return $false }
  $extension = [IO.Path]::GetExtension($Path).ToLowerInvariant()
  if ($extension -eq ".cmd") {
    try {
      $content = (Get-Content -LiteralPath $Path -Raw) -replace "`r`n", "`n"
      $productionCanonical = @'
@echo off
REM LabWired Core launcher
REM LABWIRED_CORE_COMMAND_CONTRACT=argv-v1
setlocal
set "LABWIRED_CORE_EXE=%~dp0labwired-core.exe"
if not exist "%LABWIRED_CORE_EXE%" exit /b 1
"%LABWIRED_CORE_EXE%" %*
exit /b %ERRORLEVEL%
'@
      $testCanonical = @'
@echo off
REM LabWired Core launcher
REM LABWIRED_CORE_COMMAND_CONTRACT=argv-v1
echo migrated-core:%*
exit /b 0
'@
      if ($content.Trim() -ceq $productionCanonical.Trim()) { return $true }
      return ($env:LABWIRED_WINDOWS_TEST_MODE -eq "1" -and
        $env:LABWIRED_TEST_CORE_CMD -and
        [IO.Path]::GetFullPath($Path) -eq [IO.Path]::GetFullPath($env:LABWIRED_TEST_CORE_CMD) -and
        $content.Trim() -ceq $testCanonical.Trim())
    } catch { return $false }
  }
  if ($extension -ne ".exe" -or [IO.Path]::GetFileName($Path) -notin @("labwired.exe", "labwired-core.exe")) { return $false }
  try {
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 2 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { return $false }
    $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
    return ($info.ProductName -in @("LabWired Core", "LabWired Simulator") -and
      $info.InternalName -in @("labwired", "labwired.exe", "labwired-core", "labwired-core.exe", "labwired-sim", "labwired-sim.exe"))
  } catch { return $false }
}

function Test-LegacyAgentLauncher([string]$Path) {
  if ([IO.Path]::GetExtension($Path) -ne ".cmd") { return $false }
  try {
    $content = Get-Content -LiteralPath $Path -Raw
    return ($content -match '(?im)^REM LabWired (Agent|product dispatcher).*$' -and
      $content -match '(?im)^powershell -NoProfile -ExecutionPolicy Bypass -File ".+" %\*$')
  } catch { return $false }
}

function Register-ExistingCore {
  $prefixBin = Join-Path $Prefix "bin"
  foreach ($candidate in @(
    (Join-Path $prefixBin "labwired.exe"),
    (Join-Path $prefixBin "labwired-core.exe"),
    (Join-Path $prefixBin "labwired.cmd"),
    (Join-Path $UserBin "labwired.exe"),
    (Join-Path $UserBin "labwired-core.exe"),
    (Join-Path $UserBin "labwired.cmd")
  )) {
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    Assert-NoReparseAncestors $candidate
    if (Test-ReparsePoint $candidate) { Die "refusing reparse-point launcher: $candidate" }
    if (-not (Test-ProductionCore $candidate)) {
      if (Test-LegacyAgentLauncher $candidate) { continue }
      Die "existing launcher is not an identified LabWired Core or Agent dispatcher: $candidate"
    }
    $coreBin = Assert-SafeComponentPath
    if ([IO.Path]::GetExtension($candidate) -eq ".cmd" -and $env:LABWIRED_WINDOWS_TEST_MODE -ne "1") {
      $registeredCompanion = Join-Path $coreBin "labwired-core.exe"
      if (-not (Test-ProductionCore $registeredCompanion)) {
        Die "identified Core cmd requires a statically identified labwired-core.exe companion"
      }
    }
    $destination = Join-Path $coreBin ([IO.Path]::GetFileName($candidate))
    if (Test-ReparsePoint $destination) { Die "refusing reparse-point Core destination: $destination" }
    $staged = Join-Path $coreBin (".labwired-core-" + [guid]::NewGuid().ToString("n") + [IO.Path]::GetExtension($candidate))
    try {
      Protect-Mutation $destination
      Protect-Mutation $candidate
      $authorizedTestSnapshot = ($env:LABWIRED_WINDOWS_TEST_MODE -eq "1" -and
        $env:LABWIRED_TEST_CORE_CMD -and
        [IO.Path]::GetFullPath($candidate) -eq [IO.Path]::GetFullPath($env:LABWIRED_TEST_CORE_CMD))
      $sourceHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
      Copy-Safe $candidate $staged
      $stagedIdentified = Test-ProductionCore $staged
      if (-not $stagedIdentified -and $authorizedTestSnapshot) {
        $stagedIdentified = ((Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash -eq $sourceHash)
      }
      if (-not $stagedIdentified) { Die "staged Core verification failed: $candidate" }
      if (Test-Path -LiteralPath $destination) {
        Assert-NoReparseAncestors $staged
        Assert-NoReparseAncestors $destination
        [IO.File]::Replace($staged, $destination, $null)
      } else {
        Move-Safe $staged $destination
      }
    } finally {
      Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    }
    Remove-Safe $candidate
    Ok "registered existing LabWired Core → $destination"
  }
}

function Write-Manifest {
  $agentVer = "unknown"
  $verFile = Join-Path $Prefix "agent\VERSION"
  if (Test-Path $verFile) { $agentVer = (Get-Content $verFile -Raw).Trim() }
  $simVer = ""
  $sim = Join-Path $Prefix "tools\sim\labwired-sim.exe"
  if (Test-Path $sim) {
    $simVersionFile = Join-Path $Prefix "tools\sim\VERSION"
    $simVer = if (Test-Path -LiteralPath $simVersionFile -PathType Leaf) { (Get-Content $simVersionFile -Raw).Trim() } else { "installed" }
  }
  $probeVer = ""
  $prs = Join-Path $Prefix "tools\probe-rs\probe-rs.exe"
  if (Test-Path $prs) {
    $probeVersionFile = Join-Path $Prefix "tools\probe-rs\VERSION"
    $probeVer = if (Test-Path -LiteralPath $probeVersionFile -PathType Leaf) { (Get-Content $probeVersionFile -Raw).Trim() } else { "installed" }
  }
  $obj = [ordered]@{
    schema         = 1
    product        = "labwired-agent"
    agent_version  = $agentVer
    platform       = (Get-PlatformId)
    prefix         = $Prefix
    components     = @{
      sim       = $(if ($simVer) { $simVer } else { "not-installed" })
      probe_rs  = $(if ($probeVer) { $probeVer } else { "not-installed" })
      platformio = "not-installed"
      twin_path = $(if (Test-Path $sim) { "local-sim" } else { "hosted-mcp-or-wsl" })
    }
    updated_at     = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    portable       = $true
    contained      = $true
    os             = "windows"
  }
  $manifestPath = Join-Path $Prefix "MANIFEST.json"
  $versionPath = Join-Path $Prefix "PREFIX_VERSION"
  Assert-NoReparseAncestors $manifestPath
  Assert-NoReparseAncestors $versionPath
  Protect-Mutation $manifestPath
  Protect-Mutation $versionPath
  $obj | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding UTF8
  Set-Content -Path $versionPath -Value $agentVer -Encoding UTF8
}

function Write-EnvPs1 {
  $envPath = Join-Path $Prefix "env.ps1"
  $bin = Join-Path $Prefix "bin"
  $sim = Join-Path $Prefix "tools\sim\labwired-sim.exe"
  $prs = Join-Path $Prefix "tools\probe-rs\probe-rs.exe"
  Assert-NoReparseAncestors $envPath
  Protect-Mutation $envPath
  @"
# LabWired portable prefix (Windows) — generated by install.ps1
# Usage: . `$HOME\.labwired\env.ps1
`$env:LABWIRED_HOME = '$Prefix'
`$env:LABWIRED_AGENT_HOME = Join-Path `$env:LABWIRED_HOME 'agent'
`$bin = '$bin'
if (`$env:Path -notlike "*`$bin*") { `$env:Path = "`$bin;" + `$env:Path }
if (Test-Path '$sim') {
  `$env:LABWIRED_CLI = '$sim'
  `$env:LABWIRED_SIM = '$sim'
}
if (Test-Path '$prs') { `$env:LABWIRED_PROBE_RS = '$prs' }
"@ | Set-Content -Path $envPath -Encoding UTF8
}

function Install-OpenCode {
  if (Get-Command opencode -ErrorAction SilentlyContinue) {
    Say "opencode already on PATH: $((Get-Command opencode).Source)"
    return
  }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Warn "npm not found — install Node 18+ from https://nodejs.org then re-run"
    return
  }
  Say "installing opencode-ai@$OpenCodePin"
  npm install -g "opencode-ai@$OpenCodePin"
  if ($LASTEXITCODE -ne 0) { throw "npm install failed with code $LASTEXITCODE" }
}

function Install-Sim {
  $tools = Join-Path $Prefix "tools\sim"
  $bin = Join-Path $Prefix "bin"
  Assert-NoReparseAncestors $tools
  Assert-NoReparseAncestors $bin
  Ensure-Dir $tools
  Ensure-Dir $bin
  $dest = Join-Path $tools "labwired-sim.exe"
  Assert-NoReparseAncestors $dest
  if (Test-Path $dest) {
    Ok "simulator already in prefix: $dest"
    $binDest = Join-Path $bin "labwired-sim.exe"
    Assert-NoReparseAncestors $binDest
    Copy-Item $dest $binDest -Force
    return $true
  }

  $plat = Get-PlatformId
  # Map to possible GitHub asset names (when core publishes Windows builds)
  $candidates = @(
    "labwired-{0}-windows-x86_64.zip",
    "labwired-{0}-windows-x86_64.tar.gz",
    "labwired-{0}-pc-windows-msvc.zip",
    "labwired-{0}-x86_64-pc-windows-msvc.zip"
  )

  $tag = $CoreVersion
  if ($tag -eq "latest") {
    Say "resolving latest sim release ($CoreRepo)"
    try {
      $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$CoreRepo/releases/latest" -Headers @{ "User-Agent" = "labwired-agent-install" }
      $tag = $rel.tag_name
    } catch {
      Warn "could not resolve sim release: $_"
      return $false
    }
  }

  $assetNames = @()
  try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$CoreRepo/releases/tags/$tag" -Headers @{ "User-Agent" = "labwired-agent-install" }
    $assetNames = @($rel.assets | ForEach-Object { $_.name })
  } catch {
    Warn "could not list release assets for $tag"
  }

  $winAssets = $assetNames | Where-Object { $_ -match 'windows|msvc|win32' }
  if (-not $winAssets -or $winAssets.Count -eq 0) {
    Warn "No Windows prebuilt simulator for $tag yet (assets: $($assetNames -join ', '))"
    Warn "Twin path on Windows: hosted MCP (labwired_verify via api.labwired.com) or WSL2 + Unix install"
    Warn "Agent skills, OpenCode, and probe-rs still install natively."
    return $false
  }

  $asset = $winAssets | Select-Object -First 1
  $url = "https://github.com/$CoreRepo/releases/download/$tag/$asset"
  $cache = Join-Path $Prefix "cache"
  Assert-NoReparseAncestors $cache
  Ensure-Dir $cache
  $zip = Join-Path $cache $asset
  Say "downloading simulator $asset"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

  $tmp = Join-Path $env:TEMP ("lw-sim-" + [guid]::NewGuid().ToString("n"))
  Ensure-Dir $tmp
  try {
    if ($asset -match '\.zip$') {
      Expand-Archive -Path $zip -DestinationPath $tmp -Force
    } else {
      Warn "archive format not handled natively; extract manually to $tools"
      return $false
    }
    $exe = Get-ChildItem -Path $tmp -Recurse -Filter "labwired*.exe" | Select-Object -First 1
    if (-not $exe) { $exe = Get-ChildItem -Path $tmp -Recurse -Filter "labwired*" -File | Select-Object -First 1 }
    if (-not $exe) {
      Warn "no labwired binary in archive"
      return $false
    }
    Assert-NoReparseAncestors $dest
    Copy-Item $exe.FullName $dest -Force
    $binDest = Join-Path $bin "labwired-sim.exe"
    Assert-NoReparseAncestors $binDest
    Copy-Item $dest $binDest -Force
    $toolVersion = Join-Path $tools "VERSION"
    Assert-NoReparseAncestors $toolVersion
    Set-Content $toolVersion $tag
  } finally {
    Remove-Safe $tmp -Recurse
  }
  Ok "simulator → $dest"
  return $true
}

function Install-ProbeRs {
  $tools = Join-Path $Prefix "tools\probe-rs"
  $bin = Join-Path $Prefix "bin"
  Assert-NoReparseAncestors $tools
  Assert-NoReparseAncestors $bin
  Ensure-Dir $tools
  Ensure-Dir $bin
  $dest = Join-Path $tools "probe-rs.exe"
  Assert-NoReparseAncestors $dest
  if (Test-Path $dest) {
    Ok "probe-rs already in prefix"
    $binDest = Join-Path $bin "probe-rs.exe"
    Assert-NoReparseAncestors $binDest
    Copy-Item $dest $binDest -Force
    return $true
  }

  Say "installing probe-rs (Windows x86_64-msvc prebuild)"
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/probe-rs/probe-rs/releases/latest" -Headers @{ "User-Agent" = "labwired-agent-install" }
  $asset = $rel.assets | Where-Object { $_.name -eq "probe-rs-tools-x86_64-pc-windows-msvc.zip" } | Select-Object -First 1
  if (-not $asset) {
    Warn "probe-rs Windows zip not found on latest release"
    return $false
  }
  $cache = Join-Path $Prefix "cache"
  Assert-NoReparseAncestors $cache
  Ensure-Dir $cache
  $zip = Join-Path $cache $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
  $tmp = Join-Path $env:TEMP ("lw-prs-" + [guid]::NewGuid().ToString("n"))
  Ensure-Dir $tmp
  try {
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $exe = Get-ChildItem -Path $tmp -Recurse -Filter "probe-rs.exe" | Select-Object -First 1
    if (-not $exe) {
      Warn "probe-rs.exe not in archive"
      return $false
    }
    Assert-NoReparseAncestors $dest
    Copy-Item $exe.FullName $dest -Force
    $binDest = Join-Path $bin "probe-rs.exe"
    Assert-NoReparseAncestors $binDest
    Copy-Item $dest $binDest -Force
  } finally {
    Remove-Safe $tmp -Recurse
  }
  Ok "probe-rs → $dest"
  return $true
}

function Stage-AgentKit {
  $agent = Join-Path $Prefix "agent"
  $stage = Join-Path $Prefix (".agent-stage-" + [guid]::NewGuid().ToString("n"))
  Say "staging agent kit → $stage"
  Assert-NoReparseAncestors $agent
  Assert-NoReparseAncestors $stage
  Ensure-Dir $stage
  $complete = $false
  try {
    $robocopyArgs = @(
      "$Src", "$stage", "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np",
      "/XD", ".git", "node_modules", ".grok", "dist"
    )
    & robocopy @robocopyArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }
    $stagedReparse = Get-ChildItem -LiteralPath $stage -Recurse -Force | Where-Object {
      $_.Attributes -band [IO.FileAttributes]::ReparsePoint
    } | Select-Object -First 1
    if ($stagedReparse) { throw "staged Agent contains reparse point: $($stagedReparse.FullName)" }
    foreach ($required in @("VERSION", "bin\labwired-agent.ps1", "scripts\install.ps1")) {
      if (-not (Test-Path -LiteralPath (Join-Path $stage $required) -PathType Leaf)) {
        throw "staged Agent missing required file: $required"
      }
    }
    $complete = $true
    return $stage
  } finally {
    if (-not $complete -and (Test-Path -LiteralPath $stage)) { Remove-Safe $stage -Recurse }
  }
}

function Install-AgentKit {
  $agent = Join-Path $Prefix "agent"
  $stage = Stage-AgentKit
  $backup = Join-Path $Prefix (".agent-backup-" + [guid]::NewGuid().ToString("n"))
  Assert-NoReparseAncestors $agent
  Assert-NoReparseAncestors $backup
  try {
    if (Test-Path -LiteralPath $agent) { Move-Safe $agent $backup }
    Move-Safe $stage $agent
  } catch {
    if (Test-Path -LiteralPath $agent) { Remove-Safe $agent -Recurse }
    if (Test-Path -LiteralPath $backup) { Move-Safe $backup $agent }
    if (Test-Path -LiteralPath $stage) { Remove-Safe $stage -Recurse }
    throw
  }
  $script:AgentLive = $agent
  $script:AgentBackup = if (Test-Path -LiteralPath $backup) { $backup } else { $null }
  $script:AgentStage = $stage
  Say "installed agent kit → $agent"

  $bin = Join-Path $Prefix "bin"
  Assert-NoReparseAncestors $bin
  Ensure-Dir $bin

  foreach ($launcher in @("labwired.cmd", "labwired.ps1", "labwired-agent.ps1")) {
    $launcherSrc = Join-Path $Src "bin\$launcher"
    if (Test-Path $launcherSrc) {
      $launcherDest = Join-Path $bin $launcher
      Assert-NoReparseAncestors $launcherDest
      Protect-Mutation $launcherDest
      Copy-Item -LiteralPath $launcherSrc -Destination $launcherDest -Force
    }
  }
}

function Restore-AgentKit {
  if ($script:AgentLive -and (Test-Path -LiteralPath $script:AgentLive)) { Remove-Safe $script:AgentLive -Recurse }
  if ($script:AgentBackup -and (Test-Path -LiteralPath $script:AgentBackup)) {
    Assert-NoReparseAncestors $script:AgentLive
    Move-Safe $script:AgentBackup $script:AgentLive
  }
}

function Complete-AgentKit {
  if ($script:AgentBackup -and (Test-Path -LiteralPath $script:AgentBackup)) {
    try { Remove-Safe $script:AgentBackup -Recurse } catch { Warn "could not remove old Agent backup: $_" }
  }
}

function Install-UserShim {
  Assert-NoReparseAncestors $UserBin
  if (-not (Test-Path -LiteralPath $UserBin)) { Protect-Mutation $UserBin }
  Ensure-Dir $UserBin
  $srcCmd = Join-Path $Prefix "bin\labwired.cmd"
  $dstCmd = Join-Path $UserBin "labwired.cmd"
  if (Test-ReparsePoint $dstCmd) { Die "refusing reparse-point user shim: $dstCmd" }
  Protect-Mutation $dstCmd
  Copy-Item $srcCmd $dstCmd -Force
  Ok "user shim → $dstCmd"

  # Persist user PATH if missing
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $SkipPathUpdate -and $userPath -notlike "*$UserBin*") {
    if (-not $script:UserPathCaptured) {
      $script:OriginalUserPath = $userPath
      $script:UserPathCaptured = $true
    }
    [Environment]::SetEnvironmentVariable("Path", "$UserBin;$userPath", "User")
    $env:Path = "$UserBin;" + $env:Path
    Ok "added $UserBin to user PATH (new shells pick this up)"
  }
}

function Install-OpenCodeConfig {
  $cfg = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".config\opencode" }
  Assert-NoReparseAncestors $cfg
  if (-not (Test-Path -LiteralPath $cfg)) { Protect-Mutation $cfg }
  $skillsDir = Join-Path $cfg "skills"
  Protect-Mutation $skillsDir
  Ensure-Dir $skillsDir
  $agent = Join-Path $Prefix "agent"
  $srcCfg = Join-Path $agent "config\opencode.json"
  if ($Airgap -and (Test-Path (Join-Path $agent "config\opencode.airgap.json"))) {
    $srcCfg = Join-Path $agent "config\opencode.airgap.json"
  }
  if ((Test-Path $srcCfg) -and -not (Test-Path (Join-Path $cfg "opencode.json"))) {
    $destination = Join-Path $cfg "opencode.json"
    Protect-Mutation $destination
    Copy-Safe $srcCfg $destination
  }
  if ((Test-Path (Join-Path $agent "config\AGENTS.md")) -and -not (Test-Path (Join-Path $cfg "AGENTS.md"))) {
    $destination = Join-Path $cfg "AGENTS.md"
    Protect-Mutation $destination
    Copy-Safe (Join-Path $agent "config\AGENTS.md") $destination
  }
  if (Test-Path (Join-Path $agent "skills")) {
    Get-ChildItem (Join-Path $agent "skills") -Directory | ForEach-Object {
      $destination = Join-Path (Join-Path $cfg "skills") $_.Name
      if (-not (Test-Path $destination)) { Protect-Mutation $destination; Copy-Safe $_.FullName $destination -Recurse }
    }
  }
  if (Test-Path (Join-Path $agent "branding")) {
    $brandingDir = Join-Path $cfg "branding"
    Protect-Mutation $brandingDir
    Ensure-Dir $brandingDir
    Get-ChildItem (Join-Path $agent "branding") -File | ForEach-Object {
      $destination = Join-Path (Join-Path $cfg "branding") $_.Name
      if (-not (Test-Path $destination)) { Protect-Mutation $destination; Copy-Safe $_.FullName $destination }
    }
  }
  Ok "OpenCode config → $cfg"
}

# ── main ─────────────────────────────────────────────────────────────────────
Say "LabWired Agent Windows install"
Say "prefix: $Prefix  platform: $(Get-PlatformId)"

Assert-NoReparseAncestors $Prefix
Assert-NoReparseAncestors $UserBin
$script:PrefixCreated = -not (Test-Path -LiteralPath $Prefix)
Ensure-Dir $Prefix
$prefixBin = Join-Path $Prefix "bin"
Protect-Mutation $prefixBin
Ensure-Dir $prefixBin

$env:LABWIRED_HOME = $Prefix
$env:LABWIRED_AGENT_HOME = Join-Path $Prefix "agent"

try {
  if (-not $SkipOpenCode) { Install-OpenCode }
  Register-ExistingCore
  Install-AgentKit
  if ($TestFailAfterAgentSwap) { throw "injected failure after Agent swap" }

  if ($Full) {
    $toolsRoot = Join-Path $Prefix "tools"
    $cacheRoot = Join-Path $Prefix "cache"
    Protect-Mutation $toolsRoot
    Protect-Mutation $cacheRoot
    Ensure-Dir $toolsRoot
    Ensure-Dir $cacheRoot
    $null = Install-ProbeRs
    $hasSim = Install-Sim
    if (-not $hasSim) {
      Warn "Local twin binary not on Windows yet — use hosted verify or WSL for labwired-sim"
    }
  } else {
    Say "Agent-only install — skipped simulator, probe-rs, PlatformIO, and Editor"
  }

  Install-OpenCodeConfig
  Write-EnvPs1
  Write-Manifest
  Install-UserShim

  if (-not $SkipPathUpdate) { $env:Path = "$UserBin;" + $env:Path }
  $script:InstallCommitted = $true
} catch {
  Restore-AgentKit
  Restore-Mutations
  if ($script:UserPathCaptured) { [Environment]::SetEnvironmentVariable("Path", $script:OriginalUserPath, "User") }
  throw
} finally {
  if ($script:AgentStage -and (Test-Path -LiteralPath $script:AgentStage)) { Remove-Safe $script:AgentStage -Recurse }
  if ($script:InstallCommitted) {
    Complete-AgentKit
    Complete-Mutations
  } elseif ($script:MutationState -and (Test-Path -LiteralPath $script:MutationState)) {
    try { Remove-Safe $script:MutationState -Recurse } catch { Warn "could not remove rolled-back transaction state: $_" }
  }
  if (-not $script:InstallCommitted -and $script:PrefixCreated -and (Test-Path -LiteralPath $Prefix)) {
    try { Remove-Safe $Prefix } catch { Warn "could not remove empty failed-install prefix: $_" }
  }
}

Write-Host ""
Write-Host "✓ LabWired Agent installed" -ForegroundColor Green
Write-Host ""
Write-Host "  Run:     labwired agent"
Write-Host "  Check:   labwired agent doctor"
Write-Host "  Update:  irm https://labwired.com/install/agent.ps1 | iex"
Write-Host ""
