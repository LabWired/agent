#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop';$temp=Join-Path ([IO.Path]::GetTempPath()) ('labwired-win-hw-'+[guid]::NewGuid().ToString('n'));$agent=Join-Path $temp 'agent';New-Item -ItemType Directory -Path (Join-Path $agent 'bin'),(Join-Path $agent 'lib'),(Join-Path $agent 'scripts')|Out-Null
Copy-Item (Join-Path $Root 'bin\labwired-agent.ps1') (Join-Path $agent 'bin\labwired-agent.ps1');$log=Join-Path $temp 'args.json';$env:LABWIRED_HOME=$temp;$env:LABWIRED_TEST_HW_LOG=$log;$fakeProbe=Join-Path $temp 'probe-rs.exe';Set-Content $fakeProbe '' -Encoding ASCII;$env:LABWIRED_PROBE_RS=$fakeProbe
Set-Content (Join-Path $agent 'scripts\hardware-runner.mjs') '// fake runner path' -Encoding ASCII
$engine=(Get-Process -Id $PID).Path
function Run-Real([string]$helper,[string[]]$argv){$oldPreference=$ErrorActionPreference;$ErrorActionPreference='Continue';try{$out=& $engine -NoProfile -File (Join-Path $Root ('lib\'+$helper)) @argv 2>&1;$code=$LASTEXITCODE}finally{$ErrorActionPreference=$oldPreference};return @{Code=$code;Out=($out-join "`n")}}
$workspace=Join-Path $temp 'real-work';New-Item -ItemType Directory -Path $workspace|Out-Null;Set-Content (Join-Path $workspace 'platformio.ini') '[env:release]' -Encoding ASCII
$artifact=Join-Path $temp 'firmware.bin';[IO.File]::WriteAllBytes($artifact,[Text.Encoding]::ASCII.GetBytes('exact-bin'));$sha=(Get-FileHash $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
$pio=Join-Path $temp 'pio.cmd';$uploadLog=Join-Path $temp 'upload.log';$deviceJson=Join-Path $temp 'devices.json';$env:LABWIRED_TEST_UPLOAD_LOG=$uploadLog;$env:LABWIRED_TEST_DEVICE_FILE=$deviceJson
Set-Content $pio @'
@echo off
if "%1 %2"=="device list" type "%LABWIRED_TEST_DEVICE_FILE%"& exit /b 0
echo %*>>"%LABWIRED_TEST_UPLOAD_LOG%"
exit /b 0
'@ -Encoding ASCII
$flashArgs=@('-Provider','platformio','-Artifact',$artifact,'-ExpectedSha256',$sha,'-Chip','esp32c3','-Port','COM7','-Environment','release','-Workspace',$workspace,'-Pio',$pio)
foreach($case in @(
  @{Probe='probe-1';Json='[{"port":"COM7","hwid":"USB SER=probe-10 LOCATION=1"}]'},
  @{Probe='probe-1';Json='[{"port":"COM7","description":"adapter SERIAL=xprobe-1"}]'},
  @{Probe='probe.+[1]';Json='[{"port":"COM7","hwid":"USB SER=probeZZ1"}]'},
  @{Probe='probe-1';Json='[{"port":"COM7","serialNumber":"probe-1"},{"port":"COM7","serialNumber":"probe-1"}]'}
)){Set-Content -LiteralPath $deviceJson -Value $case.Json -Encoding ASCII;$r=Run-Real 'probe-flash.ps1' ($flashArgs+@('-Probe',$case.Probe));if($r.Code -eq 0){throw 'real flash helper accepted an inexact or duplicate identity'};if(Test-Path $uploadLog){throw 'real flash helper uploaded before exact identity validation'}}
Set-Content -LiteralPath $deviceJson -Value '[{"port":"COM7","serialNumber":"probe-1"}]' -Encoding ASCII
$stageDir=Join-Path $workspace '.pio\build\release';New-Item -ItemType Directory -Path $stageDir -Force|Out-Null;$stage=Join-Path $stageDir 'firmware.bin';$original=[byte[]](0,255,1,254,2,253);[IO.File]::WriteAllBytes($stage,$original)
$r=Run-Real 'probe-flash.ps1' ($flashArgs+@('-Probe','probe-1'));if($r.Code -ne 0){throw ('real flash success failed: '+$r.Out)}
if((Get-Content $uploadLog -Raw).Trim() -cne 'run -e release -t nobuild -t upload --upload-port COM7'){throw 'real flash used unexpected PlatformIO argv'}
if([Convert]::ToBase64String($original) -cne [Convert]::ToBase64String([IO.File]::ReadAllBytes($stage))){throw 'real flash did not restore preexisting staged bytes'}
$receiptLine=@($r.Out -split "`r?`n"|Where-Object{$_.StartsWith('LABWIRED_FLASH_RECEIPT ')})
if($receiptLine.Count -ne 1){throw 'real flash did not emit one machine receipt'};$receipt=$receiptLine[0].Substring(23)|ConvertFrom-Json
if($receipt.provider -cne 'platformio' -or $receipt.artifactSha256 -cne $sha -or $receipt.chip -cne 'esp32c3' -or $receipt.environment -cne 'release' -or $receipt.workspace -cne (Resolve-Path $workspace).Path -or $receipt.probeSerial -cne 'probe-1' -or $receipt.observationPort -cne 'COM7' -or $receipt.identityApplied -ne $true -or $receipt.serialPortApplied -ne $true){throw 'real flash receipt was not bound to the exact transaction'}
Remove-Item $stage -Force;Remove-Item $uploadLog -Force
$r=Run-Real 'probe-flash.ps1' ($flashArgs+@('-Probe','probe-1'));if($r.Code -ne 0){throw ('real flash without prior stage failed: '+$r.Out)}
if(Test-Path $stage){throw 'real flash left a staged artifact when none existed before'}
if((Get-Content $uploadLog -Raw).Trim() -cne 'run -e release -t nobuild -t upload --upload-port COM7'){throw 'real flash without prior stage used unexpected argv'}
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
 $nodeDir=Join-Path $temp 'fake-node';New-Item -ItemType Directory -Path $nodeDir|Out-Null;$fakeNode=Join-Path $nodeDir 'node.exe'
 $fakeNodeSource=@'
using System;
using System.IO;
public static class FakeNode {
 public static void Main(string[] args) {
  if (args.Length == 1 && args[0] == "--version") { Console.WriteLine(Environment.GetEnvironmentVariable("LABWIRED_OLD_NODE") == "1" ? "v16.20.2" : "v20.18.0"); return; }
  File.WriteAllLines(Environment.GetEnvironmentVariable("LABWIRED_FAKE_NODE_ARGS"), args);
  Console.WriteLine("{\"fake\":true}");
  int code; if (!Int32.TryParse(Environment.GetEnvironmentVariable("LABWIRED_FAKE_NODE_EXIT"), out code)) code=0;
  Environment.ExitCode=code;
 }
}
'@
 $fakeNodeSourcePath=Join-Path $nodeDir 'fake-node.cs';Set-Content $fakeNodeSourcePath $fakeNodeSource -Encoding ASCII
 $cscCandidates=@((Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),(Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'))
 $csc=$cscCandidates|Where-Object{Test-Path -LiteralPath $_ -PathType Leaf}|Select-Object -First 1
 if(-not $csc){throw 'C# compiler fixture dependency unavailable'}
 & $csc /nologo /target:exe "/out:$fakeNode" $fakeNodeSourcePath
 if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $fakeNode -PathType Leaf)){throw 'fake Node fixture compilation failed'}
 $oldPath=$env:PATH;$env:PATH=$nodeDir+';'+$oldPath;$env:LABWIRED_FAKE_NODE_ARGS=Join-Path $temp 'node-args.txt';$env:LABWIRED_FAKE_NODE_EXIT='7'
 $r=Run @('hardware','run','--profile','C:\profile one.json','--out','C:\evidence one','--confirm',('a'*64));if($r.Code -ne 7 -or $r.Out -notmatch '"fake":true'){throw 'native hardware dispatcher did not preserve output/exit'}
 $nodeArgs=Get-Content $env:LABWIRED_FAKE_NODE_ARGS;if($nodeArgs.Count -ne 8 -or $nodeArgs[1] -cne 'run' -or $nodeArgs[3] -cne 'C:\profile one.json' -or $nodeArgs[5] -cne 'C:\evidence one'){throw 'native hardware dispatcher changed argv'}
 Remove-Item $env:LABWIRED_FAKE_NODE_ARGS -Force;$env:LABWIRED_OLD_NODE='1';$r=Run @('hardware','plan','--profile','x','--out','y');if($r.Code -ne 2 -or $r.Out -notmatch 'Node.js 18\+'){throw 'native hardware dispatcher accepted old Node'};if(Test-Path $env:LABWIRED_FAKE_NODE_ARGS){throw 'old Node executed hardware runner'}
 $env:PATH=$oldPath;Remove-Item Env:LABWIRED_OLD_NODE,Env:LABWIRED_FAKE_NODE_ARGS,Env:LABWIRED_FAKE_NODE_EXIT -ErrorAction SilentlyContinue
 $env:LABWIRED_TEST_HW_FAIL='1';$r=Run @('serial-capture','COM7','115200','ready','1');if($r.Code -ne 9){throw 'native failure exit was not preserved'}
 Write-Host 'ok   windows-hardware-contract PASS'
}finally{if($oldPath){$env:PATH=$oldPath};Remove-Item Env:LABWIRED_TEST_HW_FAIL,Env:LABWIRED_TEST_HW_LOG,Env:LABWIRED_PROBE_RS,Env:LABWIRED_TEST_DEVICE_FILE,Env:LABWIRED_TEST_UPLOAD_LOG,Env:LABWIRED_OLD_NODE,Env:LABWIRED_FAKE_NODE_ARGS,Env:LABWIRED_FAKE_NODE_EXIT -ErrorAction SilentlyContinue;Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue}
