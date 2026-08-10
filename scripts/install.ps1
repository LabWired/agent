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
  [string]$CoreVersion = $(if ($env:LABWIRED_CORE_VERSION) { $env:LABWIRED_CORE_VERSION } else { "latest" }),
  [string]$CoreRepo = $(if ($env:LABWIRED_CORE_REPO) { $env:LABWIRED_CORE_REPO } else { "w1ne/labwired-core" }),
  [string]$UserBin = $(if ($env:LABWIRED_BIN_DIR) { $env:LABWIRED_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "LabWired\bin" })
)

$ErrorActionPreference = "Stop"
$Src = Resolve-Path (Join-Path $PSScriptRoot "..")
$OpenCodePin = if ($env:OPENCODE_PIN) { $env:OPENCODE_PIN } else { "1.18.7" }
if (-not $Full -and -not $Minimal -and -not $AgentOnly) { $AgentOnly = $true }

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn([string]$m) { Write-Host "warn: $m" -ForegroundColor Yellow }
function Ok([string]$m) { Write-Host "ok  $m" -ForegroundColor Green }
function Die([string]$m) { Write-Host "error: $m" -ForegroundColor Red; exit 1 }

function Get-PlatformId {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  switch ($arch) {
    "x64" { "windows-x86_64" }
    "arm64" { "windows-aarch64" }
    default { "windows-$arch" }
  }
}

function Ensure-Dir([string]$p) {
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
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

function Assert-SafeComponentPath {
  # Canonical registration target: $Prefix\components\core\bin.
  $components = Join-Path $Prefix "components"
  $core = Join-Path $components "core"
  $coreBin = Join-Path $core "bin"
  Assert-NoReparseAncestors $coreBin
  foreach ($path in @($Prefix, $components, $core, $coreBin)) {
    if (Test-ReparsePoint $path) { Die "refusing reparse-point component path: $path" }
    Ensure-Dir $path
  }
  return $coreBin
}

function Test-ProductionCore([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Test-ReparsePoint $Path)) { return $false }
  try {
    $output = (& $Path --version 2>&1 | Out-String)
    return ($LASTEXITCODE -eq 0 -and $output -match '(?im)^(LabWired Core|labwired-core)(?:\s|$)')
  } catch { return $false }
}

function Test-LegacyAgentLauncher([string]$Path) {
  if ([IO.Path]::GetExtension($Path) -ne ".cmd") { return $false }
  try {
    $content = Get-Content -LiteralPath $Path -Raw
    return ($content -match 'LABWIRED_AGENT_HOME' -or $content -match 'LabWired product dispatcher')
  } catch { return $false }
}

function Register-ExistingCore {
  $prefixBin = Join-Path $Prefix "bin"
  foreach ($candidate in @(
    (Join-Path $prefixBin "labwired.exe"),
    (Join-Path $prefixBin "labwired.cmd"),
    (Join-Path $UserBin "labwired.exe"),
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
    $destination = Join-Path $coreBin ([IO.Path]::GetFileName($candidate))
    if (Test-ReparsePoint $destination) { Die "refusing reparse-point Core destination: $destination" }
    $staged = Join-Path $coreBin (".labwired-core-" + [guid]::NewGuid().ToString("n") + [IO.Path]::GetExtension($candidate))
    try {
      Copy-Item -LiteralPath $candidate -Destination $staged
      if (-not (Test-ProductionCore $staged)) { Die "staged Core verification failed: $candidate" }
      if (Test-Path -LiteralPath $destination) {
        [IO.File]::Replace($staged, $destination, $null)
      } else {
        Move-Item -LiteralPath $staged -Destination $destination
      }
    } finally {
      Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    }
    if ([IO.Path]::GetExtension($candidate) -eq ".exe") { Remove-Item -LiteralPath $candidate -Force }
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
    try { $simVer = (& $sim --version 2>$null | Select-Object -First 1) } catch { $simVer = "installed" }
  }
  $probeVer = ""
  $prs = Join-Path $Prefix "tools\probe-rs\probe-rs.exe"
  if (Test-Path $prs) {
    try { $probeVer = (& $prs --version 2>$null | Select-Object -First 1) } catch { $probeVer = "installed" }
  }
  $obj = [ordered]@{
    schema         = 1
    product        = "labwired-agent"
    agent_version  = $agentVer
    platform       = (Get-PlatformId)
    prefix         = $Prefix
    components     = @{
      sim       = $simVer
      probe_rs  = $probeVer
      platformio = ""
      twin_path = $(if (Test-Path $sim) { "local-sim" } else { "hosted-mcp-or-wsl" })
    }
    updated_at     = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    portable       = $true
    contained      = $true
    os             = "windows"
  }
  $obj | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $Prefix "MANIFEST.json") -Encoding UTF8
  Set-Content -Path (Join-Path $Prefix "PREFIX_VERSION") -Value $agentVer -Encoding UTF8
}

function Write-EnvPs1 {
  $envPath = Join-Path $Prefix "env.ps1"
  $bin = Join-Path $Prefix "bin"
  $sim = Join-Path $Prefix "tools\sim\labwired-sim.exe"
  $prs = Join-Path $Prefix "tools\probe-rs\probe-rs.exe"
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
}

function Install-Sim {
  $tools = Join-Path $Prefix "tools\sim"
  $bin = Join-Path $Prefix "bin"
  Ensure-Dir $tools
  Ensure-Dir $bin
  $dest = Join-Path $tools "labwired-sim.exe"
  if (Test-Path $dest) {
    Ok "simulator already in prefix: $dest"
    Copy-Item $dest (Join-Path $bin "labwired-sim.exe") -Force
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
  Ensure-Dir $cache
  $zip = Join-Path $cache $asset
  Say "downloading simulator $asset"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

  $tmp = Join-Path $env:TEMP ("lw-sim-" + [guid]::NewGuid().ToString("n"))
  Ensure-Dir $tmp
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
  Copy-Item $exe.FullName $dest -Force
  Copy-Item $dest (Join-Path $bin "labwired-sim.exe") -Force
  Set-Content (Join-Path $tools "VERSION") $tag
  Ok "simulator → $dest"
  return $true
}

function Install-ProbeRs {
  $tools = Join-Path $Prefix "tools\probe-rs"
  $bin = Join-Path $Prefix "bin"
  Ensure-Dir $tools
  Ensure-Dir $bin
  $dest = Join-Path $tools "probe-rs.exe"
  if (Test-Path $dest) {
    Ok "probe-rs already in prefix"
    Copy-Item $dest (Join-Path $bin "probe-rs.exe") -Force
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
  Ensure-Dir $cache
  $zip = Join-Path $cache $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
  $tmp = Join-Path $env:TEMP ("lw-prs-" + [guid]::NewGuid().ToString("n"))
  Ensure-Dir $tmp
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $exe = Get-ChildItem -Path $tmp -Recurse -Filter "probe-rs.exe" | Select-Object -First 1
  if (-not $exe) {
    Warn "probe-rs.exe not in archive"
    return $false
  }
  Copy-Item $exe.FullName $dest -Force
  Copy-Item $dest (Join-Path $bin "probe-rs.exe") -Force
  Ok "probe-rs → $dest"
  return $true
}

function Install-AgentKit {
  $agent = Join-Path $Prefix "agent"
  Say "installing agent kit → $agent"
  Ensure-Dir $agent
  # Copy kit (exclude git/node_modules)
  $robocopyArgs = @(
    "$Src", "$agent", "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np",
    "/XD", ".git", "node_modules", ".grok", "dist"
  )
  & robocopy @robocopyArgs | Out-Null
  # robocopy exit 0-7 are success
  if ($LASTEXITCODE -ge 8) { Die "robocopy failed with code $LASTEXITCODE" }

  $bin = Join-Path $Prefix "bin"
  Assert-NoReparseAncestors $bin
  Ensure-Dir $bin

  foreach ($launcher in @("labwired.cmd", "labwired.ps1", "labwired-agent.ps1")) {
    $launcherSrc = Join-Path $Src "bin\$launcher"
    if (Test-Path $launcherSrc) {
      Copy-Item $launcherSrc (Join-Path $bin $launcher) -Force
    }
  }
}

function Install-UserShim {
  Assert-NoReparseAncestors $UserBin
  Ensure-Dir $UserBin
  $srcCmd = Join-Path $Prefix "bin\labwired.cmd"
  $dstCmd = Join-Path $UserBin "labwired.cmd"
  if (Test-ReparsePoint $dstCmd) { Die "refusing reparse-point user shim: $dstCmd" }
  Copy-Item $srcCmd $dstCmd -Force
  Ok "user shim → $dstCmd"

  # Persist user PATH if missing
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -notlike "*$UserBin*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserBin;$userPath", "User")
    $env:Path = "$UserBin;" + $env:Path
    Ok "added $UserBin to user PATH (new shells pick this up)"
  }
}

function Install-OpenCodeConfig {
  $cfg = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".config\opencode" }
  Ensure-Dir (Join-Path $cfg "skills")
  $agent = Join-Path $Prefix "agent"
  $srcCfg = Join-Path $agent "config\opencode.json"
  if ($Airgap -and (Test-Path (Join-Path $agent "config\opencode.airgap.json"))) {
    $srcCfg = Join-Path $agent "config\opencode.airgap.json"
  }
  if ((Test-Path $srcCfg) -and -not (Test-Path (Join-Path $cfg "opencode.json"))) {
    Copy-Item $srcCfg (Join-Path $cfg "opencode.json") -Force
  }
  if ((Test-Path (Join-Path $agent "config\AGENTS.md")) -and -not (Test-Path (Join-Path $cfg "AGENTS.md"))) {
    Copy-Item (Join-Path $agent "config\AGENTS.md") (Join-Path $cfg "AGENTS.md") -Force
  }
  if (Test-Path (Join-Path $agent "skills")) {
    Get-ChildItem (Join-Path $agent "skills") -Directory | ForEach-Object {
      $destination = Join-Path (Join-Path $cfg "skills") $_.Name
      if (-not (Test-Path $destination)) { Copy-Item $_.FullName $destination -Recurse }
    }
  }
  if (Test-Path (Join-Path $agent "branding")) {
    Ensure-Dir (Join-Path $cfg "branding")
    Get-ChildItem (Join-Path $agent "branding") -File | ForEach-Object {
      $destination = Join-Path (Join-Path $cfg "branding") $_.Name
      if (-not (Test-Path $destination)) { Copy-Item $_.FullName $destination }
    }
  }
  Ok "OpenCode config → $cfg"
}

# ── main ─────────────────────────────────────────────────────────────────────
Say "LabWired Agent Windows install"
Say "prefix: $Prefix  platform: $(Get-PlatformId)"

Assert-NoReparseAncestors $Prefix
Assert-NoReparseAncestors $UserBin
Ensure-Dir $Prefix
Ensure-Dir (Join-Path $Prefix "bin")
Ensure-Dir (Join-Path $Prefix "tools")
Ensure-Dir (Join-Path $Prefix "cache")
Ensure-Dir (Join-Path $Prefix "agent")

$env:LABWIRED_HOME = $Prefix
$env:LABWIRED_AGENT_HOME = Join-Path $Prefix "agent"

Install-OpenCode
Register-ExistingCore
Install-AgentKit

if ($Full) {
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

$env:Path = "$UserBin;" + $env:Path

Write-Host ""
Write-Host "✓ LabWired Agent installed" -ForegroundColor Green
Write-Host ""
Write-Host "  Run:     labwired agent"
Write-Host "  Check:   labwired agent doctor"
Write-Host "  Update:  irm https://labwired.com/install/agent.ps1 | iex"
Write-Host ""
