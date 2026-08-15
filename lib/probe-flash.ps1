[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('platformio','probe-rs')][string]$Provider,[Parameter(Mandatory=$true)][string]$Artifact,[Parameter(Mandatory=$true)][string]$ExpectedSha256,[Parameter(Mandatory=$true)][string]$Chip,[Parameter(Mandatory=$true)][string]$Probe,[Parameter(Mandatory=$true)][string]$Port,[Parameter(Mandatory=$true)][string]$Environment,[Parameter(Mandatory=$true)][string]$Workspace,[string]$Pio='pio',[string]$ProbeRs='probe-rs')
$ErrorActionPreference='Stop'
function Fail([string]$m,[int]$c=2){[Console]::Error.WriteLine('probe flash: '+$m);exit $c}
# Provider serial identifiers are ordinal/case-sensitive. Structured JSON fields
# take precedence; metadata fallback accepts only complete SER=/SERIAL= tokens.
function Get-DeviceSerials($device){
  $explicit=@()
  foreach($name in @('serialNumber','serial_number')){$property=$device.PSObject.Properties[$name];if($null -ne $property -and $property.Value -is [string]){$explicit+=@([string]$property.Value)}}
  if($explicit.Count -gt 0){return $explicit}
  $found=@()
  foreach($name in @('hwid','description')){$property=$device.PSObject.Properties[$name];if($null -ne $property -and $property.Value -is [string]){foreach($match in [regex]::Matches([string]$property.Value,'(?:^|[\s,;])(?:SER|SERIAL)=([^\s,;]+)')){$found+=@($match.Groups[1].Value)}}}
  return $found
}
if($ExpectedSha256 -notmatch '^[0-9a-fA-F]{64}$' -or -not(Test-Path -LiteralPath $Artifact -PathType Leaf)){Fail 'invalid artifact or SHA-256'}
if($Environment -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or -not $Chip -or -not $Probe -or -not $Port){Fail 'invalid typed identity or environment'}
$artifactPath=(Resolve-Path -LiteralPath $Artifact).Path; if((Get-Item -LiteralPath $artifactPath).Attributes -band [IO.FileAttributes]::ReparsePoint){Fail 'artifact must not be a reparse point'}
$hash=(Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant();if($hash -ne $ExpectedSha256.ToLowerInvariant()){Fail 'artifact SHA-256 mismatch'}
$workspacePath=(Resolve-Path -LiteralPath $Workspace).Path
if($Provider -eq 'probe-rs'){
  if([IO.Path]::GetExtension($artifactPath) -ine '.elf'){Fail 'probe-rs requires ELF'}
  & $ProbeRs download --chip $Chip --probe $Probe --binary-format elf $artifactPath
  if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
} else {
  if([IO.Path]::GetExtension($artifactPath) -ine '.bin'){Fail 'PlatformIO requires BIN'}
  $devicesText=(& $Pio device list --json-output | Out-String);if($LASTEXITCODE -ne 0){Fail 'device enumeration failed'}
  # ConvertFrom-Json differs across Windows PowerShell and PowerShell Core:
  # one may emit the top-level JSON array as a single pipeline object. The
  # identity filter needs device records, so explicitly unroll that value.
  $devices=@($devicesText|ConvertFrom-Json|ForEach-Object{$_})
  $matches=@($devices|Where-Object{([string]$_.port -ceq $Port) -and (@((Get-DeviceSerials $_)|Where-Object{$_ -ceq $Probe}).Count -gt 0)})
  if($matches.Count -ne 1){Fail 'port does not map uniquely to serial identity'}
  $stage=Join-Path $workspacePath ('.pio\build\'+$Environment+'\firmware.bin');$parent=Split-Path -Parent $stage;New-Item -ItemType Directory -Path $parent -Force|Out-Null
  foreach($candidate in @($workspacePath,(Join-Path $workspacePath '.pio'),(Join-Path $workspacePath '.pio\build'),$parent,$stage)){if(Test-Path -LiteralPath $candidate){if((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){Fail 'staging path contains a reparse point'}}}
  $backup=$null;$backupHash=$null;$backupCreated=$null
  if(Test-Path -LiteralPath $stage){$backup=$stage+'.labwired-backup-'+[guid]::NewGuid().ToString('n');Move-Item -LiteralPath $stage -Destination $backup;$backupHash=(Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash;$backupCreated=(Get-Item -LiteralPath $backup).CreationTimeUtc.Ticks}
  Copy-Item -LiteralPath $artifactPath -Destination $stage
  $uploadCode=0;$cleanupCode=0
  try {& $Pio run -e $Environment -t nobuild -t upload --upload-port $Port;if($LASTEXITCODE -ne 0){$uploadCode=$LASTEXITCODE}}
  finally {
    if(-not(Test-Path -LiteralPath $stage -PathType Leaf)-or(Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash){$cleanupCode=1}else{Remove-Item -LiteralPath $stage -Force}
    if($backup){if((-not(Test-Path -LiteralPath $backup -PathType Leaf)) -or ((Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -ne $backupHash) -or ((Get-Item -LiteralPath $backup).CreationTimeUtc.Ticks -ne $backupCreated) -or (Test-Path -LiteralPath $stage)){$cleanupCode=1}else{Move-Item -LiteralPath $backup -Destination $stage}}
  }
  if($cleanupCode -ne 0){Fail 'staging cleanup ownership failure' 1};if($uploadCode -ne 0){exit $uploadCode}
}
$receipt=@{provider=$Provider;artifactSha256=$hash;chip=$Chip;environment=$Environment;workspace=$workspacePath;probeSerial=$Probe;observationPort=$Port;identityApplied=$true;serialPortApplied=($Provider -eq 'platformio')}
[Console]::Out.WriteLine('LABWIRED_FLASH_RECEIPT '+(ConvertTo-Json $receipt -Compress));exit 0
