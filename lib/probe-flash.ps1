[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('platformio','probe-rs')][string]$Provider,[Parameter(Mandatory=$true)][string]$Artifact,[Parameter(Mandatory=$true)][string]$ExpectedSha256,[Parameter(Mandatory=$true)][string]$Chip,[Parameter(Mandatory=$true)][string]$Probe,[Parameter(Mandatory=$true)][string]$Port,[Parameter(Mandatory=$true)][string]$Environment,[Parameter(Mandatory=$true)][string]$Workspace,[string]$Pio='pio',[string]$ProbeRs='probe-rs')
$ErrorActionPreference='Stop'
function Fail([string]$m,[int]$c=2){[Console]::Error.WriteLine('probe flash: '+$m);exit $c}
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
  $matches=@($devicesText|ConvertFrom-Json|Where-Object{$_.port -eq $Port -and ($_.serialNumber -eq $Probe -or $_.serial_number -eq $Probe -or $_.hwid -eq $Probe -or ([string]$_.hwid).Contains('SER='+$Probe) -or ([string]$_.hwid).Contains('SERIAL='+$Probe) -or $_.description -eq $Probe -or ([string]$_.description).Contains('SER='+$Probe) -or ([string]$_.description).Contains('SERIAL='+$Probe))})
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
