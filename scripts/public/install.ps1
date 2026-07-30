# LabWired Agent — one-line install (Windows, Cursor-style)
#
#   irm https://labwired.com/install.ps1 | iex
#   irm 'https://labwired.com/install?win32=true' | iex
#
# That's it. Then: labwired
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$RepoSlug = if ($env:LABWIRED_AGENT_REPO_SLUG) { $env:LABWIRED_AGENT_REPO_SLUG } else { "LabWired/agent" }
$RepoUrl = if ($env:LABWIRED_AGENT_REPO) { $env:LABWIRED_AGENT_REPO } else { "https://github.com/$RepoSlug.git" }
$RepoRef = if ($env:LABWIRED_AGENT_REF) { $env:LABWIRED_AGENT_REF } else { "main" }
$Prefix = if ($env:LABWIRED_HOME) { $env:LABWIRED_HOME } else { Join-Path $env:USERPROFILE ".labwired" }
$AgentHome = Join-Path $Prefix "agent"

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Die([string]$m) { Write-Host "labwired install: $m" -ForegroundColor Red; exit 1 }

Say "Installing LabWired Agent…"
Say "  → $Prefix"

if (-not (Test-Path $Prefix)) {
  New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
}

$env:LABWIRED_HOME = $Prefix
$env:LABWIRED_AGENT_HOME = $AgentHome

# Prefer zip from codeload (no git required). Git fallback.
function Install-KitFromZip {
  $zipUrl = "https://codeload.github.com/$RepoSlug/zip/refs/heads/$RepoRef"
  $tmp = Join-Path $env:TEMP ("labwired-agent-" + [guid]::NewGuid().ToString("n"))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $zip = Join-Path $tmp "kit.zip"
  try {
    Say "downloading kit…"
    Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $top = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -ne $null } | Select-Object -First 1
    if (-not $top -or -not (Test-Path (Join-Path $top.FullName "scripts\install.ps1"))) {
      return $false
    }
    if (Test-Path $AgentHome) { Remove-Item $AgentHome -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path $AgentHome -Parent) -Force | Out-Null
    Move-Item $top.FullName $AgentHome
    return $true
  } catch {
    return $false
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-KitFromGit {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Die "need git on PATH (https://git-scm.com/download/win) — or fix network for zip download"
  }
  if (Test-Path (Join-Path $AgentHome ".git")) {
    Say "updating kit"
    git -C $AgentHome fetch --depth 1 origin $RepoRef 2>$null
    git -C $AgentHome checkout -q FETCH_HEAD 2>$null
  } else {
    if (Test-Path $AgentHome) { Remove-Item $AgentHome -Recurse -Force }
    try {
      git clone --depth 1 --branch $RepoRef $RepoUrl $AgentHome
    } catch {
      git clone --depth 1 $RepoUrl $AgentHome
    }
  }
}

if ($env:LABWIRED_SKIP_KIT_UPDATE -eq "1" -and (Test-Path (Join-Path $AgentHome "scripts\install.ps1"))) {
  Say "keeping existing kit"
} else {
  if (-not (Install-KitFromZip)) {
    Say "zip failed — trying git"
    Install-KitFromGit
  }
}

$installer = Join-Path $AgentHome "scripts\install.ps1"
if (-not (Test-Path $installer)) { Die "install.ps1 missing at $installer" }

Say "finishing install…"
& $installer -Prefix $Prefix -Full
