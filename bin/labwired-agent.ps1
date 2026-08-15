#Requires -Version 5.1
<#
  LabWired Agent launcher (Windows)
  Installed under $LABWIRED_HOME\agent\bin; invoked as `labwired agent`.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [AllowEmptyString()]
  [string]$Out,
  [Parameter(ValueFromRemainingArguments = $true)]
  [AllowEmptyString()]
  [string[]]$Rest
)

# PowerShell reserves the `-OutBuffer`/`-OutVariable` common-parameter prefixes,
# so a literal `--out` is otherwise rejected as ambiguous before this launcher
# can forward it. Capture the exact public flag and put it back into argv.
if ($PSBoundParameters.ContainsKey('Out')) { $Rest += @('--out', $Out) }

$ErrorActionPreference = "Stop"

function Get-LabwiredHome {
  if ($env:LABWIRED_HOME -and (Test-Path $env:LABWIRED_HOME)) { return $env:LABWIRED_HOME }
  $candidate = Join-Path $env:USERPROFILE ".labwired"
  if (Test-Path $candidate) { return $candidate }
  # sibling of this script: .../agent/bin/labwired.ps1 -> .../ = prefix or agent
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

function Test-ReparsePoint([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  return [bool]((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Assert-SafePath([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while ($current) {
    if ((Test-Path -LiteralPath $current) -and (Test-ReparsePoint $current)) {
      Fail "refusing reparse-point path ancestor: $current"
    }
    $parent = Split-Path -Parent $current
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
}

function Assert-NoReparseTree([string]$Path) {
  Assert-SafePath $Path
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $pending = @([IO.Path]::GetFullPath($Path))
  while ($pending.Count -gt 0) {
    $current = $pending[0]
    $pending = @($pending | Select-Object -Skip 1)
    foreach ($child in @(Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop)) {
      if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Fail "refusing reparse-point Agent tree entry: $($child.FullName)"
      }
      if ($child.PSIsContainer) { $pending += $child.FullName }
    }
  }
}

$cmd = if ($Rest -and $Rest.Count -gt 0) { $Rest[0] } else { "" }
$argsRest = if ($Rest -and $Rest.Count -gt 1) { $Rest[1..($Rest.Count - 1)] } else { @() }

function Show-Help {
  @"
LabWired Agent (Windows)

Usage:
  labwired agent                 Start LabWired Agent
  labwired agent doctor          Check install
  labwired agent update          Self-update kit + tools
  labwired agent version         Version
  labwired agent package info    Portable prefix info
  labwired agent package path    Print LABWIRED_HOME
  labwired agent install-deps    Refresh tools into prefix
  labwired agent serial-challenge PORT BAUD NONCE MARKER ADDRESS_KEY TIMEOUT
                                 Send a bounded hardware nonce challenge
  labwired agent hardware plan --profile FILE --out DIR
  labwired agent hardware run --profile FILE --out DIR --confirm DIGEST
  labwired agent help


Env:
  LABWIRED_HOME            Install root (default %USERPROFILE%\.labwired)
  LABWIRED_CLI / LABWIRED_SIM   Simulator
  LABWIRED_PROBE_RS        probe-rs.exe
"@
}

function Cmd-SerialChallenge {
  if ($argsRest.Count -ne 6) { [Console]::Error.WriteLine("usage: serial-challenge PORT BAUD NONCE MARKER ADDRESS_KEY TIMEOUT"); exit 2 }
  $helper = Join-Path $AgentHome "lib\serial-challenge.ps1"
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { Fail "serial challenge helper missing" }
  Assert-SafePath $helper
  & $helper -Port ([string]$argsRest[0]) -Baud ([int]$argsRest[1]) -Nonce ([string]$argsRest[2]) `
    -Marker ([string]$argsRest[3]) -AddressKey ([string]$argsRest[4]) -TimeoutSeconds ([int]$argsRest[5]) `
    -Terminator LF -MaxBytes 65536
  exit $LASTEXITCODE
}

function Cmd-SerialCapture {
  if ($argsRest.Count -ne 4) { [Console]::Error.WriteLine("usage: serial-capture PORT BAUD MARKER TIMEOUT"); exit 2 }
  $helper = Join-Path $AgentHome "lib\serial-capture.ps1"; Assert-SafePath $helper
  & $helper -Port ([string]$argsRest[0]) -Baud ([int]$argsRest[1]) -Marker ([string]$argsRest[2]) -TimeoutSeconds ([int]$argsRest[3]) -MaxBytes 65536
  exit $LASTEXITCODE
}

function Convert-FlagArguments([string[]]$Items) {
  $result=@{};for($i=0;$i -lt $Items.Count;$i+=2){if($i+1 -ge $Items.Count -or -not $Items[$i].StartsWith('--')){[Console]::Error.WriteLine('invalid typed arguments');exit 2};$key=$Items[$i].Substring(2);if($result.ContainsKey($key)){[Console]::Error.WriteLine('duplicate typed argument');exit 2};$result[$key]=$Items[$i+1]};return $result
}

function Cmd-Probe {
  if($argsRest.Count -lt 1){[Console]::Error.WriteLine('usage: probe flash|rtt-capture ...');exit 2};$sub=$argsRest[0]
  if($sub -eq 'flash'){
    if($argsRest.Count -lt 4){[Console]::Error.WriteLine('usage: probe flash ARTIFACT --provider ...');exit 2};$artifact=$argsRest[1];$flags=Convert-FlagArguments @($argsRest[2..($argsRest.Count-1)])
    foreach($name in @('provider','chip','probe','port','expected-sha256','environment','workspace')){if(-not $flags.ContainsKey($name)){[Console]::Error.WriteLine("missing --$name");exit 2}}
    $helper=Join-Path $AgentHome 'lib\probe-flash.ps1';Assert-SafePath $helper
    $pio=(Get-Command pio -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Source -First 1);if(-not $pio){$pio='pio'}
    $probeRs=if($env:LABWIRED_PROBE_RS){$env:LABWIRED_PROBE_RS}else{(Get-Command probe-rs -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Source -First 1)}
    & $helper -Provider $flags['provider'] -Artifact $artifact -ExpectedSha256 $flags['expected-sha256'] -Chip $flags['chip'] -Probe $flags['probe'] -Port $flags['port'] -Environment $flags['environment'] -Workspace $flags['workspace'] -Pio $pio -ProbeRs $probeRs
    exit $LASTEXITCODE
  }
  if($sub -eq 'rtt-capture'){
    if($argsRest.Count -lt 3){[Console]::Error.WriteLine('usage: probe rtt-capture --chip ...');exit 2};$flags=Convert-FlagArguments @($argsRest[1..($argsRest.Count-1)]);foreach($name in @('chip','probe','elf','marker','timeout')){if(-not $flags.ContainsKey($name)){[Console]::Error.WriteLine("missing --$name");exit 2}}
    $probeRs=if($env:LABWIRED_PROBE_RS){$env:LABWIRED_PROBE_RS}else{(Get-Command probe-rs -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Source -First 1)}
    $helper=Join-Path $AgentHome 'lib\rtt-capture.ps1';Assert-SafePath $helper
    & $helper -ProbeRs $probeRs -Chip $flags['chip'] -Probe $flags['probe'] -Elf $flags['elf'] -Marker $flags['marker'] -TimeoutSeconds ([int]$flags['timeout']);exit $LASTEXITCODE
  }
  Fail "unknown probe command $sub"
}

function Cmd-Hardware {
  $runner = Join-Path $AgentHome 'scripts\hardware-runner.mjs'
  if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { [Console]::Error.WriteLine('labwired: hardware runner missing'); exit 2 }
  Assert-SafePath $runner
  $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $nodeCommand) { [Console]::Error.WriteLine('labwired: Node.js 18+ is required for hardware commands'); exit 2 }
  $nodeVersion = (& $nodeCommand.Source --version 2>$null)
  $nodeMajor = 0
  if (-not $nodeVersion -or -not [int]::TryParse(([string]$nodeVersion).Trim().TrimStart('v').Split('.')[0], [ref]$nodeMajor) -or $nodeMajor -lt 18) {
    [Console]::Error.WriteLine('labwired: Node.js 18+ is required for hardware commands'); exit 2
  }
  & $nodeCommand.Source $runner @argsRest
  exit $LASTEXITCODE
}

function Get-LabWiredAgentConfigDir {
  if ($env:OPENCODE_CONFIG_DIR) { return $env:OPENCODE_CONFIG_DIR }
  if ($env:LABWIRED_AGENT_CONFIG_DIR) { return $env:LABWIRED_AGENT_CONFIG_DIR }
  return (Join-Path $env:USERPROFILE ".config\opencode")
}

function Ensure-LabWiredAgentConfigDir {
  $cfg = Get-LabWiredAgentConfigDir
  $old = Join-Path $env:USERPROFILE ".config\opencode"
  if (-not (Test-Path $cfg)) { New-Item -ItemType Directory -Path $cfg -Force | Out-Null }
  $newCfg = Join-Path $cfg "opencode.json"
  $oldCfg = Join-Path $old "opencode.json"
  if (-not (Test-Path $newCfg) -and (Test-Path $oldCfg)) {
    Say "migrating agent config -> $cfg"
    Copy-Item -Recurse -Force (Join-Path $old "*") $cfg -ErrorAction SilentlyContinue
  }
  $env:LABWIRED_AGENT_CONFIG_DIR = $cfg
  $env:OPENCODE_CONFIG_DIR = $cfg
  return $cfg
}

function Apply-LabWiredBranding {
  $cfg = Ensure-LabWiredAgentConfigDir
  $themesDir = Join-Path $cfg "themes"
  $brandingDir = Join-Path $cfg "branding"
  $pluginsDir = Join-Path $cfg "plugins"
  if (-not (Test-Path $themesDir)) { New-Item -ItemType Directory -Path $themesDir -Force | Out-Null }
  if (-not (Test-Path $brandingDir)) { New-Item -ItemType Directory -Path $brandingDir -Force | Out-Null }
  if (-not (Test-Path $pluginsDir)) { New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null }
  $themeSrc = Join-Path $AgentHome "branding\themes\labwired.json"
  if (Test-Path $themeSrc) {
    Copy-Item -Force $themeSrc (Join-Path $themesDir "labwired.json")
  }
  $bannerSrc = Join-Path $AgentHome "branding\banner.txt"
  $bannerDst = Join-Path $brandingDir "banner.txt"
  if ((Test-Path $bannerSrc) -and -not (Test-Path $bannerDst)) {
    Copy-Item $bannerSrc $bannerDst
  }
  $pluginSrc = Join-Path $AgentHome "plugins\labwired-brand.tsx"
  if (Test-Path $pluginSrc) {
    Copy-Item -Force $pluginSrc (Join-Path $pluginsDir "labwired-brand.tsx")
  }
  $tuiSrc = Join-Path $AgentHome "config\tui.json"
  $tuiDst = Join-Path $cfg "tui.json"
  $wantedPlugin = "./plugins/labwired-brand.tsx"
  if (-not (Test-Path $tuiDst)) {
    if (Test-Path $tuiSrc) {
      Copy-Item -Force $tuiSrc $tuiDst
    } else {
      Set-Content -Path $tuiDst -Value (@{
        '$schema' = 'https://opencode.ai/tui.json'
        theme = 'labwired'
        plugin = @($wantedPlugin)
      } | ConvertTo-Json) -Encoding utf8
    }
  } else {
    try {
      $cfgObj = Get-Content -Raw $tuiDst | ConvertFrom-Json
      if (-not $cfgObj.theme -or $cfgObj.theme -in @('system', 'opencode')) {
        $cfgObj | Add-Member -NotePropertyName theme -NotePropertyValue 'labwired' -Force
      }
      $plugins = @()
      if ($cfgObj.plugin) { $plugins = @($cfgObj.plugin) }
      $hasBrand = $false
      foreach ($p in $plugins) {
        $s = if ($p -is [string]) { $p } elseif ($p -is [array] -and $p.Count -gt 0) { [string]$p[0] } else { '' }
        if ($s -eq $wantedPlugin -or $s.EndsWith('labwired-brand.tsx')) { $hasBrand = $true; break }
      }
      if (-not $hasBrand) {
        $cfgObj | Add-Member -NotePropertyName plugin -NotePropertyValue (@($wantedPlugin) + $plugins) -Force
      }
      if (-not $cfgObj.'$schema') {
        $cfgObj | Add-Member -NotePropertyName '$schema' -NotePropertyValue 'https://opencode.ai/tui.json' -Force
      }
      ($cfgObj | ConvertTo-Json -Depth 8) | Set-Content -Path $tuiDst -Encoding utf8
    } catch {
      if (Test-Path $tuiSrc) { Copy-Item -Force $tuiSrc $tuiDst }
    }
  }
  $env:OPENCODE_DISABLE_TERMINAL_TITLE = "1"
  try {
    $Host.UI.RawUI.WindowTitle = "LabWired Agent"
  } catch { }
}

function Show-LabWiredSplash {
  $banner = Join-Path $AgentHome "branding\banner.txt"
  if (Test-Path $banner) {
    Write-Host (Get-Content $banner -Raw) -ForegroundColor Blue
  } else {
    Write-Host "  LabWired Agent" -ForegroundColor Blue
    Write-Host "  The easy way to build hardware" -ForegroundColor Blue
  }
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
    Write-Host "runtime $((& opencode --version 2>&1 | Select-Object -First 1))"
  } else {
    Write-Host "runtime (missing - re-run LabWired install)"
  }
}

function Cmd-Doctor {
  $ok = 0
  Write-Host "LabWired Agent"
  Say "home $AgentHome"
  Say "prefix $HomeDir"

  if (Get-Command opencode -ErrorAction SilentlyContinue) {
    Say "ok  agent-runtime: present"
  } else {
    Write-Host "FAIL agent-runtime not on PATH - re-run LabWired install" -ForegroundColor Red
    $ok = 1
  }

  if ($env:LABWIRED_CLI -and (Test-Path $env:LABWIRED_CLI)) {
    Say "ok  labwired-sim: $($env:LABWIRED_CLI)"
  } elseif (Test-Path $sim) {
    Say "ok  labwired-sim: $sim"
  } else {
    Write-Host "warn labwired-sim: no Windows prebuild - use hosted MCP verify or WSL" -ForegroundColor Yellow
  }

  if ((Get-Command npm -ErrorAction SilentlyContinue) -or (Get-Command npx -ErrorAction SilentlyContinue)) {
    Say "ok  node/npm present"
  } else {
    Write-Host "FAIL node/npm missing" -ForegroundColor Red
    $ok = 1
  }

  $cfg = Get-LabWiredAgentConfigDir
  if (Test-Path (Join-Path $cfg "opencode.json")) {
    Say "ok  agent-config: present"
  } else {
    Write-Host "FAIL config missing - re-run install.ps1" -ForegroundColor Red
    $ok = 1
  }

  $skills = @(
    "golden-path", "bringup", "prove", "observe", "desk-hw", "import-circuit"
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
    Write-Host "warn probe-rs missing - re-run install.ps1" -ForegroundColor Yellow
  }

  if ($ok -eq 0) { Say "ready"; exit 0 }
  Write-Host "`nnot ready - fix FAILs above" -ForegroundColor Red
  exit 1
}

function Test-JsonProperty([object]$Object, [string]$Name) {
  return ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name])
}

function Remove-JsonOwnedPath([object]$Root, [string[]]$Parts) {
  $node = $Root
  $parents = @()
  for ($index = 0; $index -lt ($Parts.Count - 1); $index++) {
    $part = $Parts[$index]
    if (-not (Test-JsonProperty $node $part)) { return }
    $parents += @(@{ Object = $node; Name = $part })
    $node = $node.PSObject.Properties[$part].Value
  }
  if ($Parts.Count -eq 0 -or -not (Test-JsonProperty $node $Parts[-1])) { return }
  $node.PSObject.Properties.Remove($Parts[-1])
  for ($index = $parents.Count - 1; $index -ge 0; $index--) {
    $parent = $parents[$index].Object
    $name = $parents[$index].Name
    $child = $parent.PSObject.Properties[$name].Value
    if ($null -ne $child -and @($child.PSObject.Properties).Count -eq 0) {
      $parent.PSObject.Properties.Remove($name)
    } else {
      break
    }
  }
}

function Get-AgentOwnershipPlan {
  $cfg = Get-LabWiredAgentConfigDir
  $manifest = Join-Path $cfg "labwired-agent.manifest"
  Assert-SafePath $cfg
  Assert-SafePath $manifest
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
    return @{ ConfigRoot = $cfg; Manifest = $manifest; Entries = @(); JsonEntries = @(); JsonArrayEntries = @(); FileEntries = @(); TuiEntries = @() }
  }

  $cfgRoot = [IO.Path]::GetFullPath($cfg).TrimEnd([char[]]@(92, 47))
  $entries = @(Get-Content -LiteralPath $manifest | Where-Object { $_ })
  $jsonEntries = @()
  $jsonArrayEntries = @()
  $fileEntries = @()

  # Validate every entry and every directory ancestor before changing anything.
  foreach ($entry in $entries) {
    if ($entry -eq "opencode.json") { continue }
    if ($entry.StartsWith("json-array-value:opencode.json:")) {
      $parts = @($entry -split ":", 4)
      if ($parts.Count -ne 4 -or $parts[2] -ne "enabled_providers" -or -not $parts[3]) {
        throw "unsafe Agent ownership entry: $entry"
      }
      $jsonArrayEntries += @(@{ Name = $parts[2]; Value = $parts[3] })
      continue
    }
    if ($entry.StartsWith("json-file:") -or $entry.StartsWith("json-array:")) {
      if ($entry -notin @('json-file:tui.json:theme', 'json-file:tui.json:$schema', 'json-array:tui.json:plugin')) {
        throw "unsafe Agent ownership entry: $entry"
      }
      continue
    }
    if ($entry.StartsWith("json:")) {
      $jsonPath = $entry.Substring(5)
      $parts = @($jsonPath -split "\.")
      if (-not $jsonPath -or @($parts | Where-Object { -not $_ -or $_ -in @(".", "..") -or $_ -match "[\\/]" }).Count -gt 0) {
        throw "unsafe Agent ownership entry: $entry"
      }
      $jsonEntries += ,$parts
      continue
    }

    $segments = @($entry -split "[\\/]")
    if ([IO.Path]::IsPathRooted($entry) -or @($segments | Where-Object { -not $_ -or $_ -in @(".", "..") }).Count -gt 0) {
      throw "unsafe Agent ownership entry: $entry"
    }
    $path = [IO.Path]::GetFullPath((Join-Path $cfg ($entry -replace "/", "\")))
    if (-not $path.StartsWith($cfgRoot + "\", [StringComparison]::OrdinalIgnoreCase)) {
      throw "unsafe Agent ownership entry: $entry"
    }
    Assert-SafePath (Split-Path -Parent $path)
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path -Force).PSIsContainer) {
      throw "refusing directory Agent ownership entry: $entry"
    }
    $fileEntries += $path
  }

  $tuiEntries = @($entries | Where-Object { $_.StartsWith("json-file:tui.json:") -or $_ -eq "json-array:tui.json:plugin" })
  $configPath = Join-Path $cfg "opencode.json"
  $tuiPath = Join-Path $cfg "tui.json"
  foreach ($jsonPath in @($configPath, $tuiPath)) {
    Assert-SafePath $jsonPath
    if (Test-Path -LiteralPath $jsonPath -PathType Leaf) {
      try { $null = Get-Content -LiteralPath $jsonPath -Raw | ConvertFrom-Json }
      catch { throw "invalid Agent-owned JSON target: $jsonPath" }
    }
  }
  return @{
    ConfigRoot = $cfg; Manifest = $manifest; Entries = $entries
    JsonEntries = $jsonEntries; JsonArrayEntries = $jsonArrayEntries
    FileEntries = $fileEntries; TuiEntries = $tuiEntries
  }
}

function Remove-AgentOwnedConfig([hashtable]$Plan) {
  $cfg = $Plan.ConfigRoot
  $manifest = $Plan.Manifest
  $jsonEntries = @($Plan.JsonEntries)
  $jsonArrayEntries = @($Plan.JsonArrayEntries)
  $fileEntries = @($Plan.FileEntries)
  $tuiEntries = @($Plan.TuiEntries)
  $configPath = Join-Path $cfg "opencode.json"
  if (($jsonEntries.Count -gt 0 -or $jsonArrayEntries.Count -gt 0) -and (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    foreach ($parts in $jsonEntries) { Remove-JsonOwnedPath $config $parts }
    foreach ($arrayEntry in $jsonArrayEntries) {
      if (Test-JsonProperty $config $arrayEntry.Name) {
        $values = @($config.PSObject.Properties[$arrayEntry.Name].Value | Where-Object { $_ -ne $arrayEntry.Value })
        if ($values.Count -eq 0) { $config.PSObject.Properties.Remove($arrayEntry.Name) }
        else { $config | Add-Member -NotePropertyName $arrayEntry.Name -NotePropertyValue $values -Force }
      }
    }
    $config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $configPath -Encoding UTF8
  }

  $tuiPath = Join-Path $cfg "tui.json"
  if ($tuiEntries.Count -gt 0 -and (Test-Path -LiteralPath $tuiPath -PathType Leaf)) {
    $tui = Get-Content -LiteralPath $tuiPath -Raw | ConvertFrom-Json
    foreach ($entry in $tuiEntries) {
      if ($entry.StartsWith("json-file:tui.json:")) {
        $property = $entry.Substring("json-file:tui.json:".Length)
        if ($property -notin @("theme", '$schema')) { throw "unsafe Agent ownership entry: $entry" }
        if (Test-JsonProperty $tui $property) { $tui.PSObject.Properties.Remove($property) }
      } elseif (Test-JsonProperty $tui "plugin") {
        $plugins = @($tui.plugin | Where-Object { $_ -ne "./plugins/labwired-brand.tsx" })
        if ($plugins.Count -eq 0) { $tui.PSObject.Properties.Remove("plugin") }
        else { $tui | Add-Member -NotePropertyName plugin -NotePropertyValue $plugins -Force }
      }
    }
    if (@($tui.PSObject.Properties).Count -eq 0) {
      Remove-Item -LiteralPath $tuiPath -Force
    } else {
      $tui | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $tuiPath -Encoding UTF8
    }
  }

  foreach ($path in $fileEntries) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  }
  if (Test-Path -LiteralPath $manifest) { Remove-Item -LiteralPath $manifest -Force }
}

function Remove-NoFollowTree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  # cmd.exe's native rmdir removes directory reparse entries themselves during
  # recursive cleanup. Unlike a PowerShell check-then-enumerate walker, it does
  # not separately resolve a junction and then enumerate its external target.
  $quoted = '"' + $Path.Replace('"', '""') + '"'
  $command = "rmdir /s /q $quoted"
  $null = & cmd.exe /d /v:off /s /c $command
  if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $Path)) {
    throw "could not remove isolated Agent tombstone: $Path"
  }
}

function Move-AgentTreeToTombstone([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  # Preflight validated the root and parent. Descendants may race in afterward,
  # but the atomic same-parent move isolates them before no-follow cleanup.
  $parent = Split-Path -Parent $Path
  $tombstone = Join-Path $parent (".labwired-agent-delete-" + [guid]::NewGuid().ToString("n"))
  Move-Item -LiteralPath $Path -Destination $tombstone
  $isolated = Get-Item -LiteralPath $tombstone -Force
  if ($isolated.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    Move-Item -LiteralPath $tombstone -Destination $Path
    throw "refusing reparse-point Agent tombstone: $tombstone"
  }
  return @{ Original = $Path; Tombstone = $tombstone }
}

function Move-AgentTreesToTombstones {
  $moved = @()
  try {
    foreach ($path in @((Join-Path $HomeDir "agent"), (Join-Path $HomeDir "state\agent"))) {
      $entry = Move-AgentTreeToTombstone $path
      if ($entry) { $moved += @($entry) }
    }
    return $moved
  } catch {
    for ($index = $moved.Count - 1; $index -ge 0; $index--) {
      if (Test-Path -LiteralPath $moved[$index].Tombstone) {
        Move-Item -LiteralPath $moved[$index].Tombstone -Destination $moved[$index].Original -ErrorAction SilentlyContinue
      }
    }
    throw
  }
}

function Restore-AgentTombstones([object[]]$Moved) {
  for ($index = $Moved.Count - 1; $index -ge 0; $index--) {
    if (Test-Path -LiteralPath $Moved[$index].Tombstone) {
      Move-Item -LiteralPath $Moved[$index].Tombstone -Destination $Moved[$index].Original
    }
  }
}

function Remove-AgentTombstones([object[]]$Moved) {
  foreach ($entry in $Moved) {
    try { Remove-NoFollowTree $entry.Tombstone }
    catch { Write-Host "warn: isolated Agent tombstone requires manual cleanup: $($entry.Tombstone)" -ForegroundColor Yellow }
  }
}

function Assert-CmdLiteralSafePath([string]$Path) {
  if ($Path -match '[%!^&|<>()]') {
    Fail "refusing cmd.exe metacharacter in Agent cleanup path: $Path"
  }
}

function Remove-AgentLaunchers {
  $prefixBin = Join-Path $HomeDir "bin"
  $prefixCmd = Join-Path $prefixBin "labwired.cmd"
  $prefixPs1 = Join-Path $prefixBin "labwired.ps1"
  $agentPs1 = Join-Path $prefixBin "labwired-agent.ps1"
  $userBin = if ($env:LABWIRED_BIN_DIR) { $env:LABWIRED_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "LabWired\bin" }
  $userCmd = Join-Path $userBin "labwired.cmd"
  $hasSharedComponent = (
    (Test-Path -LiteralPath (Join-Path $HomeDir "components\core\bin") -PathType Container) -or
    (Test-Path -LiteralPath (Join-Path $HomeDir "components\editor") -PathType Container)
  )

  if (-not $hasSharedComponent) {
    if ((Test-Path -LiteralPath $userCmd -PathType Leaf) -and (Test-Path -LiteralPath $prefixCmd -PathType Leaf)) {
      if ((Get-FileHash -LiteralPath $userCmd -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $prefixCmd -Algorithm SHA256).Hash) {
        Remove-Item -LiteralPath $userCmd -Force
      }
    }
    foreach ($path in @($prefixCmd, $prefixPs1)) {
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
  }
  if (Test-Path -LiteralPath $agentPs1) { Remove-Item -LiteralPath $agentPs1 -Force }
}

function Assert-AgentKitSafe {
  $agent = Join-Path $HomeDir "agent"
  $stateAgent = Join-Path $HomeDir "state\agent"
  $prefixBin = Join-Path $HomeDir "bin"
  $userBin = if ($env:LABWIRED_BIN_DIR) { $env:LABWIRED_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "LabWired\bin" }
  foreach ($path in @(
    $prefixBin,
    (Join-Path $prefixBin "labwired.cmd"),
    (Join-Path $prefixBin "labwired.ps1"),
    (Join-Path $prefixBin "labwired-agent.ps1"),
    $userBin,
    (Join-Path $userBin "labwired.cmd")
  )) { Assert-SafePath $path }
  Assert-CmdLiteralSafePath $agent
  Assert-CmdLiteralSafePath $stateAgent
  foreach ($path in @($agent, $stateAgent)) { Assert-NoReparseTree $path }
}

function Assert-AgentOwnedConfigSafe {
  return (Get-AgentOwnershipPlan)
}

function Assert-AgentUninstallSafe {
  Assert-AgentKitSafe
  return (Assert-AgentOwnedConfigSafe)
}

function Invoke-PostPreflightUninstallTestHook {
  if ($env:LABWIRED_WINDOWS_TEST_MODE -ne "1" -or -not $env:LABWIRED_TEST_UNINSTALL_RACE_JUNCTION_TARGET) { return }
  $link = Join-Path $HomeDir "agent\race-after-preflight"
  $target = $env:LABWIRED_TEST_UNINSTALL_RACE_JUNCTION_TARGET
  New-Item -ItemType Directory -Path (Split-Path -Parent $link) -Force | Out-Null
  $null = & cmd.exe /d /c mklink /J $link $target
  if ($LASTEXITCODE -ne 0) { Fail "could not create post-preflight junction fixture" }
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
      $ownershipPlan = Assert-AgentUninstallSafe
      Invoke-PostPreflightUninstallTestHook
      $tombstones = @(Move-AgentTreesToTombstones)
      try {
        Remove-AgentOwnedConfig $ownershipPlan
        Remove-AgentLaunchers
      } catch {
        Restore-AgentTombstones $tombstones
        throw
      }
      # Irreversible deletion begins only after the rollback-capable transaction
      # commits. Cleanup failures are warnings and leave isolated tombstones;
      # they never claim that already-deleted roots were restored.
      Remove-AgentTombstones $tombstones
      Say "uninstalled Agent from $HomeDir"
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
  # Clone into isolation; install.ps1 performs the verified atomic Agent swap.
  Say "LabWired self-update (Windows)"
  $repo = if ($env:LABWIRED_AGENT_REPO) { $env:LABWIRED_AGENT_REPO } else { "https://github.com/LabWired/agent.git" }
  $ref = if ($env:LABWIRED_AGENT_REF) { $env:LABWIRED_AGENT_REF } else { "main" }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git required for update" }
  $tmp = Join-Path $env:TEMP ("lw-upd-" + [guid]::NewGuid().ToString("n"))
  Assert-SafePath $tmp
  try {
    Say "staging update"
    & git clone --depth 1 --branch $ref $repo $tmp
    if ($LASTEXITCODE -ne 0) { Fail "git clone failed with code $LASTEXITCODE" }
    $install = Join-Path $tmp "scripts\install.ps1"
    foreach ($required in @($install, (Join-Path $tmp "bin\labwired-agent.ps1"), (Join-Path $tmp "VERSION"))) {
      if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { Fail "staged update is incomplete: $required" }
    }
    & $install -Prefix $HomeDir -AgentOnly
    if (-not $?) { Fail "Agent installer failed" }
    Say "update complete - run: labwired agent doctor"
  } finally {
    Assert-SafePath $tmp
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
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
  "serial-challenge" { Cmd-SerialChallenge }
  "serial-capture" { Cmd-SerialCapture }
  "probe" { Cmd-Probe }
  "hardware" { Cmd-Hardware }
  "rtt-capture" { $script:argsRest=@('rtt-capture')+@($argsRest); Cmd-Probe }
  "opencode" {
    # Internal engine alias - same product start as bare labwired agent.
    if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
      Fail "LabWired Agent runtime not found. Re-run LabWired install."
    }
    Apply-LabWiredBranding
    if (-not $env:LABWIRED_CLI) {
      Write-Host "labwired: note - no local sim; hosted MCP verify still works." -ForegroundColor Yellow
    }
    Show-LabWiredSplash
    Write-Host "labwired: starting LabWired Agent" -ForegroundColor Cyan
    & opencode @argsRest
  }
  "" {
    if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
      Fail "LabWired Agent runtime not found. Re-run LabWired install."
    }
    Apply-LabWiredBranding
    if (-not $env:LABWIRED_CLI) {
      Write-Host "labwired: note - no local sim; hosted MCP verify still works." -ForegroundColor Yellow
    }
    Show-LabWiredSplash
    Write-Host "labwired: starting LabWired Agent" -ForegroundColor Cyan
    & opencode @argsRest
  }
  default {
    if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
      Fail "unknown command '$cmd' (LabWired Agent runtime missing - re-run install)"
    }
    Apply-LabWiredBranding
    & opencode @Rest
  }
}
