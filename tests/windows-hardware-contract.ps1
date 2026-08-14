#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop';$temp=Join-Path ([IO.Path]::GetTempPath()) ('labwired-win-hw-'+[guid]::NewGuid().ToString('n'));$agent=Join-Path $temp 'agent';New-Item -ItemType Directory -Path (Join-Path $agent 'bin'),(Join-Path $agent 'lib')|Out-Null
Copy-Item (Join-Path $Root 'bin\labwired-agent.ps1') (Join-Path $agent 'bin\labwired-agent.ps1');$log=Join-Path $temp 'args.json';$env:LABWIRED_HOME=$temp;$env:LABWIRED_TEST_HW_LOG=$log;$fakeProbe=Join-Path $temp 'probe-rs.exe';Set-Content $fakeProbe '' -Encoding ASCII;$env:LABWIRED_PROBE_RS=$fakeProbe
$fake=@'
param($Provider,$Artifact,$ExpectedSha256,$Chip,$Probe,$Port,$Environment,$Workspace,$Pio,$ProbeRs,$Baud,$Marker,$TimeoutSeconds,$MaxBytes,$Elf)
$PSBoundParameters|ConvertTo-Json -Compress|Set-Content $env:LABWIRED_TEST_HW_LOG -Encoding ASCII
if($env:LABWIRED_TEST_HW_FAIL){exit 9};Write-Output 'mock-ok';exit 0
'@
foreach($name in @('probe-flash.ps1','serial-capture.ps1','rtt-capture.ps1')){Set-Content (Join-Path $agent ('lib\'+$name)) $fake -Encoding ASCII}
function Run([string[]]$argv){$out=& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $agent 'bin\labwired-agent.ps1') @argv 2>&1;return @{Code=$LASTEXITCODE;Out=($out-join "`n");Args=(Get-Content $log -Raw)}}
try{
 $r=Run @('serial-capture','COM 7','115200','ready value','3');if(($r.Code -ne 0) -or ($r.Out -notmatch 'mock-ok') -or ($r.Args -notmatch 'COM 7') -or ($r.Args -notmatch 'ready value')){throw 'serial-capture route failed'}
 $r=Run @('probe','rtt-capture','--chip','chip one','--probe','probe two','--elf','C:\firm ware.elf','--marker','ready','--timeout','4');if(($r.Code -ne 0) -or ($r.Out -notmatch 'mock-ok') -or ($r.Args -notmatch 'probe two')){throw 'RTT route failed'}
 $r=Run @('probe','flash','C:\firm ware.bin','--provider','platformio','--chip','chip one','--probe','serial two','--port','COM 7','--expected-sha256',('a'*64),'--environment','release env','--workspace','C:\work space');if(($r.Code -ne 0) -or ($r.Out -notmatch 'mock-ok') -or ($r.Args -notmatch 'serial two') -or ($r.Args -notmatch 'COM 7')){throw 'flash route failed'}
 $env:LABWIRED_TEST_HW_FAIL='1';$r=Run @('serial-capture','COM7','115200','ready','1');if($r.Code -ne 9){throw 'native failure exit was not preserved'}
 Write-Host 'ok   windows-hardware-contract PASS'
}finally{Remove-Item Env:LABWIRED_TEST_HW_FAIL,Env:LABWIRED_TEST_HW_LOG,Env:LABWIRED_PROBE_RS -ErrorAction SilentlyContinue;Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue}
