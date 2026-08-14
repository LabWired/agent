#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop';$temp=Join-Path ([IO.Path]::GetTempPath()) ('labwired-win-hw-'+[guid]::NewGuid().ToString('n'));$agent=Join-Path $temp 'agent';New-Item -ItemType Directory -Path (Join-Path $agent 'bin'),(Join-Path $agent 'lib')|Out-Null
Copy-Item (Join-Path $Root 'bin\labwired-agent.ps1') (Join-Path $agent 'bin\labwired-agent.ps1');$log=Join-Path $temp 'args.json';$env:LABWIRED_HOME=$temp;$env:LABWIRED_TEST_HW_LOG=$log;$fakeProbe=Join-Path $temp 'probe-rs.exe';Set-Content $fakeProbe '' -Encoding ASCII;$env:LABWIRED_PROBE_RS=$fakeProbe
$engine=(Get-Process -Id $PID).Path
function Run-Real([string]$helper,[string[]]$argv){$out=& $engine -NoProfile -File (Join-Path $Root ('lib\'+$helper)) @argv 2>&1;return @{Code=$LASTEXITCODE;Out=($out-join "`n")}}
$workspace=Join-Path $temp 'real-work';New-Item -ItemType Directory -Path $workspace|Out-Null;Set-Content (Join-Path $workspace 'platformio.ini') '[env:release]' -Encoding ASCII
$artifact=Join-Path $temp 'firmware.bin';[IO.File]::WriteAllBytes($artifact,[Text.Encoding]::ASCII.GetBytes('exact-bin'));$sha=(Get-FileHash $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
$pio=Join-Path $temp 'pio.cmd';$uploadLog=Join-Path $temp 'upload.log';$env:LABWIRED_TEST_UPLOAD_LOG=$uploadLog
Set-Content $pio @'
@echo off
if "%1 %2"=="device list" echo %LABWIRED_TEST_DEVICE_JSON%& exit /b 0
echo upload>>"%LABWIRED_TEST_UPLOAD_LOG%"
exit /b 0
'@ -Encoding ASCII
$flashArgs=@('-Provider','platformio','-Artifact',$artifact,'-ExpectedSha256',$sha,'-Chip','esp32c3','-Port','COM7','-Environment','release','-Workspace',$workspace,'-Pio',$pio)
foreach($case in @(
  @{Probe='probe-1';Json='[{"port":"COM7","hwid":"USB SER=probe-10 LOCATION=1"}]'},
  @{Probe='probe-1';Json='[{"port":"COM7","description":"adapter SERIAL=xprobe-1"}]'},
  @{Probe='probe.+[1]';Json='[{"port":"COM7","hwid":"USB SER=probeZZ1"}]'},
  @{Probe='probe-1';Json='[{"port":"COM7","serialNumber":"probe-1"},{"port":"COM7","serialNumber":"probe-1"}]'}
)){$env:LABWIRED_TEST_DEVICE_JSON=$case.Json;$r=Run-Real 'probe-flash.ps1' ($flashArgs+@('-Probe',$case.Probe));if($r.Code -eq 0){throw 'real flash helper accepted an inexact or duplicate identity'};if(Test-Path $uploadLog){throw 'real flash helper uploaded before exact identity validation'}}
$r=Run-Real 'serial-capture.ps1' @('-Port','COM7','-Baud','0','-Marker','ready','-TimeoutSeconds','1');if($r.Code -ne 3){throw 'real serial validation exit classification failed'}
$r=Run-Real 'serial-challenge.ps1' @('-Port','COM7','-Baud','115200','-Nonce','bad','-Marker','ready','-AddressKey','IP','-TimeoutSeconds','1');if($r.Code -ne 3){throw 'real challenge validation exit classification failed'}
$r=Run-Real 'rtt-capture.ps1' @('-ProbeRs',(Join-Path $temp 'missing.exe'),'-Chip','chip','-Probe','probe','-Elf',$artifact,'-Marker','ready','-TimeoutSeconds','1');if($r.Code -ne 2){throw 'real RTT missing-tool classification failed'}
$rttFail=Join-Path $temp 'rtt-fail.cmd';Set-Content $rttFail "@echo off`r`nexit /b 9" -Encoding ASCII
$r=Run-Real 'rtt-capture.ps1' @('-ProbeRs',$rttFail,'-Chip','chip','-Probe','probe','-Elf',$artifact,'-Marker','ready','-TimeoutSeconds','2');if($r.Code -ne 2){throw 'real RTT native failure classification failed'}
$rttSlow=Join-Path $temp 'rtt-slow.cmd';Set-Content $rttSlow "@echo off`r`nping -n 4 127.0.0.1 >nul`r`necho ready" -Encoding ASCII
$r=Run-Real 'rtt-capture.ps1' @('-ProbeRs',$rttSlow,'-Chip','chip','-Probe','probe','-Elf',$artifact,'-Marker','ready','-TimeoutSeconds','1');if($r.Code -ne 1){throw 'real RTT timeout classification failed'}
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
}finally{Remove-Item Env:LABWIRED_TEST_HW_FAIL,Env:LABWIRED_TEST_HW_LOG,Env:LABWIRED_PROBE_RS,Env:LABWIRED_TEST_DEVICE_JSON,Env:LABWIRED_TEST_UPLOAD_LOG -ErrorAction SilentlyContinue;Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue}
