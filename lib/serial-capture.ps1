[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Port,[Parameter(Mandatory=$true)][int]$Baud,[Parameter(Mandatory=$true)][string]$Marker,[Parameter(Mandatory=$true)][int]$TimeoutSeconds,[int]$MaxBytes=65536)
$ErrorActionPreference='Stop'; $serial=$null; $text=New-Object Text.StringBuilder; $code=1
if($Baud -lt 1 -or $TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 3600 -or $MaxBytes -lt 1 -or $MaxBytes -gt 65536){[Console]::Error.WriteLine('serial-capture: invalid bounds');exit 3}
try {
  $serial=New-Object IO.Ports.SerialPort($Port,$Baud,'None',8,'One'); $serial.ReadTimeout=100; $serial.Open(); $end=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while([DateTime]::UtcNow -lt $end){ $chunk=$serial.ReadExisting(); if($chunk){ if([Text.Encoding]::UTF8.GetByteCount($text.ToString()+$chunk)-gt $MaxBytes){$code=2;break};[void]$text.Append($chunk);if($text.ToString().Contains($Marker)){$code=0;break} };Start-Sleep -Milliseconds 25 }
} catch { [Console]::Error.WriteLine('serial-capture: '+$_.Exception.Message);$code=2 } finally { if($serial){try{if($serial.IsOpen){$serial.Close()}}catch{};$serial.Dispose()} }
[Console]::Out.Write($text.ToString()); if($code -eq 1){[Console]::Error.WriteLine('serial-capture: marker not observed')}; exit $code
