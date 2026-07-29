#Requires -Version 5.1
<#
  LabWired Firmware Agent — one-command Windows bootstrap
  https://labwired.com/agent-install.ps1

  Usage:
    irm https://labwired.com/agent-install.ps1 | iex
    irm https://labwired.com/agent-install.ps1 | iex ; install -Prefix D:\labwired
#>
[CmdletBinding()]
param(
  [string]$RepoUrl = $(if ($env:LABWIRED_AGENT_REPO) { $env:LABWIRED_AGENT_REPO } else { "https://github.com/LabWired/agent.git" }),
  [string]$RepoRef = $(if ($env:LABWIRED_AGENT_REF) { $env:LABWIRED_AGENT_REF } else { "main" }),
  [string]$Prefix = $(if ($env:LABWIRED_HOME) { $env:LABWIRED_HOME } else { Join-Path $env:USERPROFILE ".labwired" })
)

$ErrorActionPreference = "Stop"
function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Die([string]$m) { Write-Host "labwired-agent-install: $m" -ForegroundColor Red; exit 1 }

$AgentHome = Join-Path $Prefix "agent"
Say "LabWired Firmware Agent — full stack (Windows portable prefix)"
Say "prefix: $Prefix  ref: $RepoRef"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Die "need git on PATH (https://git-scm.com/download/win)"
}

if (Test-Path (Join-Path $AgentHome ".git")) {
  Say "updating existing install"
  git -C $AgentHome fetch --depth 1 origin $RepoRef
  git -C $AgentHome checkout -q FETCH_HEAD
} else {
  Say "cloning $RepoUrl"
  $parent = Split-Path $AgentHome -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  if (Test-Path $AgentHome) { Remove-Item $AgentHome -Recurse -Force }
  try {
    git clone --depth 1 --branch $RepoRef $RepoUrl $AgentHome
  } catch {
    git clone --depth 1 $RepoUrl $AgentHome
  }
}

$installer = Join-Path $AgentHome "scripts\install.ps1"
if (-not (Test-Path $installer)) { Die "install.ps1 missing in $AgentHome" }

Say "running installer"
& $installer -Prefix $Prefix -Full @args
