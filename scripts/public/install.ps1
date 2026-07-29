# LabWired Agent — Windows install entry (Cursor CLI style)
#
# Host as:  https://labwired.com/install?win32=true
#           or https://labwired.com/install.ps1
# Usage:    irm 'https://labwired.com/install?win32=true' | iex
#           irm https://labwired.com/agent-install.ps1 | iex
#
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:LABWIRED_AGENT_REPO) { $env:LABWIRED_AGENT_REPO } else { "https://github.com/LabWired/agent.git" }
$RepoRef = if ($env:LABWIRED_AGENT_REF) { $env:LABWIRED_AGENT_REF } else { "main" }
$Prefix = if ($env:LABWIRED_HOME) { $env:LABWIRED_HOME } else { Join-Path $env:USERPROFILE ".labwired" }
$AgentHome = Join-Path $Prefix "agent"

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Die([string]$m) { Write-Host "labwired install: $m" -ForegroundColor Red; exit 1 }

Say "LabWired Agent — install (Windows)"
Say "prefix: $Prefix  ref: $RepoRef"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Die "need git on PATH (https://git-scm.com/download/win)"
}

if (-not (Test-Path $Prefix)) {
  New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
}

$env:LABWIRED_HOME = $Prefix
$env:LABWIRED_AGENT_HOME = $AgentHome

if (Test-Path (Join-Path $AgentHome ".git")) {
  Say "updating existing kit"
  git -C $AgentHome fetch --depth 1 origin $RepoRef
  git -C $AgentHome checkout -q FETCH_HEAD
} else {
  Say "cloning $RepoUrl"
  if (Test-Path $AgentHome) { Remove-Item $AgentHome -Recurse -Force }
  try {
    git clone --depth 1 --branch $RepoRef $RepoUrl $AgentHome
  } catch {
    git clone --depth 1 $RepoUrl $AgentHome
  }
}

$installer = Join-Path $AgentHome "scripts\install.ps1"
if (-not (Test-Path $installer)) { Die "install.ps1 missing at $installer" }

Say "running installer"
& $installer -Prefix $Prefix -Full
