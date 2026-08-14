[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ProbeRs,[Parameter(Mandatory=$true)][string]$Chip,[Parameter(Mandatory=$true)][string]$Probe,[Parameter(Mandatory=$true)][string]$Elf,[Parameter(Mandatory=$true)][string]$Marker,[Parameter(Mandatory=$true)][int]$TimeoutSeconds)
$ErrorActionPreference='Stop'
if($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 3600 -or -not $Chip -or -not $Probe -or -not $Marker){[Console]::Error.WriteLine('rtt-capture: invalid arguments');exit 3}
if(-not(Test-Path -LiteralPath $ProbeRs -PathType Leaf)){[Console]::Error.WriteLine('rtt-capture: probe-rs missing');exit 2}
$argv=@('attach','--chip',$Chip,'--probe',$Probe,'--elf',$Elf)
$job=Start-Job -ScriptBlock { param($exe,$items); & $exe @items 2>&1; return $LASTEXITCODE } -ArgumentList $ProbeRs,$argv
try {
  if(-not(Wait-Job $job -Timeout $TimeoutSeconds)){Stop-Job $job -ErrorAction SilentlyContinue;[Console]::Error.WriteLine('rtt-capture: timeout');exit 1}
  $items=@(Receive-Job $job); $nativeCode=[int]$items[-1]; $text=($items[0..([Math]::Max(0,$items.Count-2))] -join "`n")
  [Console]::Out.Write($text)
  if($nativeCode -ne 0){exit 2}; if(-not $text.Contains($Marker)){exit 1}
  [Console]::Out.WriteLine((ConvertTo-Json @{status='hardware_observed';path='rtt';marker=$Marker;probeSerial=$Probe;chip=$Chip} -Compress));exit 0
} finally {Remove-Job $job -Force -ErrorAction SilentlyContinue}
