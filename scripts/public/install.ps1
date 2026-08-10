# LabWired Agent — one-line install (Windows, Cursor-style)
#
#   irm https://labwired.com/install/agent.ps1 | iex
#   irm 'https://labwired.com/install?win32=true' | iex
#
# That's it. Then: labwired agent
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$RepoSlug = if ($env:LABWIRED_AGENT_REPO_SLUG) { $env:LABWIRED_AGENT_REPO_SLUG } else { "LabWired/agent" }
$RepoUrl = if ($env:LABWIRED_AGENT_REPO) { $env:LABWIRED_AGENT_REPO } else { "https://github.com/$RepoSlug.git" }
$RepoRef = if ($env:LABWIRED_AGENT_REF) { $env:LABWIRED_AGENT_REF } else { "main" }
$Prefix = if ($env:LABWIRED_HOME) { $env:LABWIRED_HOME } else { Join-Path $env:USERPROFILE ".labwired" }
$AgentHome = Join-Path $Prefix "agent"
$StageRoot = Join-Path $env:TEMP ("labwired-agent-stage-" + [guid]::NewGuid().ToString("n"))
$InstallSource = $null

function Say([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Die([string]$m) { throw "labwired install: $m" }
function Assert-SafePath([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Die "refusing reparse-point path: $current" }
    }
    $parent = Split-Path -Parent $current
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
}

Say "Installing LabWired Agent…"
Say "  → $Prefix"

Assert-SafePath $Prefix
Assert-SafePath $StageRoot
if (-not (Test-Path $Prefix)) {
  New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
}

$env:LABWIRED_HOME = $Prefix
$env:LABWIRED_AGENT_HOME = $AgentHome

# Prefer zip from codeload (no git required). Git fallback.
function Install-KitFromZip {
  $zipUrl = "https://codeload.github.com/$RepoSlug/zip/refs/heads/$RepoRef"
  $tmp = Join-Path $StageRoot "zip"
  Assert-SafePath $tmp
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $zip = Join-Path $tmp "kit.zip"
  try {
    Say "downloading kit…"
    Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $top = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -ne $null } | Select-Object -First 1
    if (-not $top -or
        -not (Test-Path -LiteralPath (Join-Path $top.FullName "scripts\install.ps1") -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $top.FullName "bin\labwired-agent.ps1") -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $top.FullName "VERSION") -PathType Leaf)) {
      return $false
    }
    $script:InstallSource = $top.FullName
    return $true
  } catch {
    return $false
  }
}

function Install-KitFromGit {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Die "need git on PATH (https://git-scm.com/download/win) — or fix network for zip download"
  }
  $gitStage = Join-Path $StageRoot "git"
  try {
    git clone --depth 1 --branch $RepoRef $RepoUrl $gitStage
    if ($LASTEXITCODE -ne 0) { throw "git clone failed with code $LASTEXITCODE" }
  } catch {
    Assert-SafePath $gitStage
    Remove-Item -LiteralPath $gitStage -Recurse -Force -ErrorAction SilentlyContinue
    git clone --depth 1 $RepoUrl $gitStage
    if ($LASTEXITCODE -ne 0) { Die "git clone failed with code $LASTEXITCODE" }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $gitStage "scripts\install.ps1") -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $gitStage "bin\labwired-agent.ps1") -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $gitStage "VERSION") -PathType Leaf)) {
    Die "staged git checkout is incomplete"
  }
  $script:InstallSource = $gitStage
}

try {
  if ($env:LABWIRED_SKIP_KIT_UPDATE -eq "1" -and (Test-Path (Join-Path $AgentHome "scripts\install.ps1"))) {
    Say "keeping existing kit"
    $InstallSource = $AgentHome
  } else {
    if (-not (Install-KitFromZip)) {
      Say "zip failed — trying git"
      Install-KitFromGit
    }
  }

  $installer = Join-Path $InstallSource "scripts\install.ps1"
  if (-not (Test-Path $installer)) { Die "install.ps1 missing at $installer" }

  Say "finishing install…"
  & $installer -Prefix $Prefix -AgentOnly
} finally {
  Assert-SafePath $StageRoot
  Remove-Item -LiteralPath $StageRoot -Recurse -Force -ErrorAction SilentlyContinue
}
