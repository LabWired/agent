#Requires -Version 5.1
<#
  LabWired Agent launcher (Windows)
  Installed under $LABWIRED_HOME\agent\bin; invoked as `labwired agent`.
#>
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [AllowEmptyString()]
  [string[]]$Rest
)

$ErrorActionPreference = "Stop"

function Get-LabwiredHome {
  if ($env:LABWIRED_HOME -and (Test-Path $env:LABWIRED_HOME)) { return $env:LABWIRED_HOME }
  $candidate = Join-Path $env:USERPROFILE ".labwired"
  if (Test-Path $candidate) { return $candidate }
  # sibling of this script: .../agent/bin/labwired.ps1 → .../ = prefix or agent
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
  $agentRoot = Resolve-Path (Join-Path $here "..") -ErrorAction SilentlyContinue
  if ($agentRoot -and (Test-Path (Join-Path $agentRoot "lib"))) {
    $prefix = Split-Path -Parent $agentRoot.Path
    if (Test-Path (Join-Path $prefix "MANIFEST.json")) { return $prefix }
    return $agentRoot.Path  # running from kit only
  }
  return $candidate
}

$HomeDir = Get-LabwiredHome
$env:LABWIRED_HOME = $HomeDir
$AgentHome = if (Test-Path (Join-Path $HomeDir "agent")) { Join-Path $HomeDir "agent" } else { $HomeDir }
$env:LABWIRED_AGENT_HOME = $AgentHome

$envPs1 = Join-Path $HomeDir "env.ps1"
if (Test-Path $envPs1) { . $envPs1 }

# Prefer prefix tools
$sim = Join-Path $HomeDir "tools\sim\labwired-sim.exe"
if (Test-Path $sim) {
  $env:LABWIRED_CLI = $sim
  $env:LABWIRED_SIM = $sim
}
$prs = Join-Path $HomeDir "tools\probe-rs\probe-rs.exe"
if (Test-Path $prs) { $env:LABWIRED_PROBE_RS = $prs }

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Fail([string]$m) { Write-Host "labwired: $m" -ForegroundColor Red; exit 1 }

$cmd = if ($Rest -and $Rest.Count -gt 0) { $Rest[0] } else { "" }
$argsRest = if ($Rest -and $Rest.Count -gt 1) { $Rest[1..($Rest.Count - 1)] } else { @() }

function Show-Help {
  @"
LabWired Agent (Windows)

Usage:
  labwired agent                 Start agent (OpenCode)
  labwired agent doctor          Check install
  labwired agent update          Self-update kit + tools
  labwired agent version         Version
  labwired agent package info    Portable prefix info
  labwired agent package path    Print LABWIRED_HOME
  labwired agent install-deps    Refresh tools into prefix
  labwired agent help

Env:
  LABWIRED_HOME            Install root (default %USERPROFILE%\.labwired)
  LABWIRED_CLI / LABWIRED_SIM   Simulator
  LABWIRED_PROBE_RS        probe-rs.exe
"@
}

function Cmd-Version {
  $ver = "0.0.0"
  $vf = Join-Path $AgentHome "VERSION"
  if (Test-Path $vf) { $ver = (Get-Content $vf -Raw).Trim() }
  Write-Host "LabWired Agent"
  Write-Host "version  $ver"
  Write-Host "home     $AgentHome"
  Write-Host "prefix   $HomeDir"
  Write-Host "platform windows"
  if (Get-Command opencode -ErrorAction SilentlyContinue) {
    Write-Host "opencode $((& opencode --version 2>&1 | Select-Object -First 1))"
  } else {
    Write-Host "opencode (missing — install Node + npm i -g opencode-ai)"
  }
}

function Cmd-Doctor {
  $ok = 0
  Write-Host "LabWired Agent"
  Say "home $AgentHome"
  Say "prefix $HomeDir"

  if (Get-Command opencode -ErrorAction SilentlyContinue) {
    Say "ok  opencode: $((Get-Command opencode).Source)"
  } else {
    Write-Host "FAIL opencode not on PATH" -ForegroundColor Red
    $ok = 1
  }

  if ($env:LABWIRED_CLI -and (Test-Path $env:LABWIRED_CLI)) {
    Say "ok  labwired-sim: $($env:LABWIRED_CLI)"
  } elseif (Test-Path $sim) {
    Say "ok  labwired-sim: $sim"
  } else {
    Write-Host "warn labwired-sim: no Windows prebuild — use hosted MCP verify or WSL" -ForegroundColor Yellow
  }

  if (Get-Command npm -ErrorAction SilentlyContinue -or Get-Command npx -ErrorAction SilentlyContinue) {
    Say "ok  node/npm present"
  } else {
    Write-Host "FAIL node/npm missing" -ForegroundColor Red
    $ok = 1
  }

  $cfg = Join-Path $env:USERPROFILE ".config\opencode"
  if (Test-Path (Join-Path $cfg "opencode.json")) {
    Say "ok  config: $cfg\opencode.json"
  } else {
    Write-Host "FAIL config missing — re-run install.ps1" -ForegroundColor Red
    $ok = 1
  }

  $skills = @(
    "verify-firmware", "diagnose-firmware", "inspect-evidence",
    "board-bringup", "scaffold-firmware", "report-evidence", "flash-firmware",
    "firmware-repair-loop", "hw-promote"
  )
  foreach ($s in $skills) {
    $p = Join-Path $cfg "skills\$s\SKILL.md"
    if (-not (Test-Path $p)) { $p = Join-Path $AgentHome "skills\$s\SKILL.md" }
    if (Test-Path $p) { Say "ok  skill: $s" }
    else { Write-Host "FAIL skill: $s" -ForegroundColor Red; $ok = 1 }
  }

  if (Test-Path $prs) {
    Say "ok  probe-backend: $prs"
  } else {
    Write-Host "warn probe-rs missing — re-run install.ps1" -ForegroundColor Yellow
  }

  if ($ok -eq 0) { Say "ready"; exit 0 }
  Write-Host "`nnot ready — fix FAILs above" -ForegroundColor Red
  exit 1
}

function Cmd-Package {
  $sub = if ($argsRest.Count -gt 0) { $argsRest[0] } else { "info" }
  switch ($sub) {
    "path" { Write-Output $HomeDir }
    "env" {
      $e = Join-Path $HomeDir "env.ps1"
      if (Test-Path $e) { Get-Content $e } else { Fail "no env.ps1" }
    }
    "uninstall" {
      if ($argsRest -notcontains "--yes") { Fail "re-run: labwired agent package uninstall --yes" }
      Remove-Item (Join-Path $HomeDir "agent") -Recurse -Force -ErrorAction SilentlyContinue
      Say "uninstalled Agent from $HomeDir (shared Core, tools, data, and dispatcher retained)"
    }
    default {
      Write-Host "LABWIRED_HOME=$HomeDir"
      $m = Join-Path $HomeDir "MANIFEST.json"
      if (Test-Path $m) { Get-Content $m -Raw }
      else { Write-Host "manifest=(missing)" }
    }
  }
}

function Cmd-InstallDeps {
  $install = Join-Path $AgentHome "scripts\install.ps1"
  if (-not (Test-Path $install)) { Fail "install.ps1 missing at $install" }
  & $install -Prefix $HomeDir -Full
}

function Cmd-Update {
  # Cursor-style: agent update → re-fetch kit + reinstall into prefix
  Say "LabWired self-update (Windows)"
  $repo = if ($env:LABWIRED_AGENT_REPO) { $env:LABWIRED_AGENT_REPO } else { "https://github.com/LabWired/agent.git" }
  $ref = if ($env:LABWIRED_AGENT_REF) { $env:LABWIRED_AGENT_REF } else { "main" }
  if (Test-Path (Join-Path $AgentHome ".git")) {
    Say "git fetch $ref"
    git -C $AgentHome fetch --depth 1 origin $ref
    git -C $AgentHome checkout -q FETCH_HEAD
  } elseif (Get-Command git -ErrorAction SilentlyContinue) {
    Say "cloning kit"
    $tmp = Join-Path $env:TEMP ("lw-upd-" + [guid]::NewGuid().ToString("n"))
    git clone --depth 1 --branch $ref $repo $tmp
    if (Test-Path $AgentHome) { Remove-Item $AgentHome -Recurse -Force }
    Move-Item $tmp $AgentHome
  } else {
    Fail "git required for update"
  }
  $install = Join-Path $AgentHome "scripts\install.ps1"
  if (-not (Test-Path $install)) { Fail "install.ps1 missing after update" }
  & $install -Prefix $HomeDir -AgentOnly
  Say "update complete — run: labwired agent doctor"
}

switch ($cmd) {
  "doctor" { Cmd-Doctor }
  "version" { Cmd-Version }
  "--version" { Cmd-Version }
  "-V" { Cmd-Version }
  "help" { Show-Help }
  "--help" { Show-Help }
  "-h" { Show-Help }
  "package" { Cmd-Package }
  "pkg" { Cmd-Package }
  "install-deps" { Cmd-InstallDeps }
  "deps" { Cmd-InstallDeps }
  "update" { Cmd-Update }
  "self-update" { Cmd-Update }
  "upgrade" { Cmd-Update }
  "" {
    if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
      $pin = if ($env:OPENCODE_PIN) { $env:OPENCODE_PIN } else { "1.18.7" }
      Fail "'opencode' not found. Install Node 18+, then: npm i -g opencode-ai@$pin"
    }
    if (-not $env:LABWIRED_CLI) {
      Write-Host "labwired: note — no local sim; hosted MCP verify still works." -ForegroundColor Yellow
    }
    & opencode @argsRest
  }
  default {
    if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
      Fail "unknown command '$cmd' and opencode missing"
    }
    & opencode @Rest
  }
}
