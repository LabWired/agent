[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Port,
  [Parameter(Mandatory = $true)][int]$Baud,
  [Parameter(Mandatory = $true)][string]$Nonce,
  [Parameter(Mandatory = $true)][string]$Marker,
  [Parameter(Mandatory = $true)][string]$AddressKey,
  [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
  [ValidateSet('LF', 'CRLF')][string]$Terminator = 'LF',
  [ValidateRange(1, 65536)][int]$MaxBytes = 65536
)

$ErrorActionPreference = 'Stop'
if ($Nonce -notmatch '^[0-9a-f]{32}$' -or $TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 3600) {
  [Console]::Error.WriteLine('serial-challenge: invalid nonce or timeout')
  exit 3
}

$serial = $null
$captured = New-Object System.Text.StringBuilder
$exitCode = 1
try {
  $serial = New-Object System.IO.Ports.SerialPort($Port, $Baud, 'None', 8, 'One')
  $serial.ReadTimeout = 100
  $serial.WriteTimeout = 1000
  $serial.Open()
  $ending = if ($Terminator -eq 'CRLF') { "`r`n" } else { "`n" }
  $serial.Write($Nonce + $ending)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $chunk = $serial.ReadExisting()
    if ($chunk.Length -gt 0) {
      if ([Text.Encoding]::UTF8.GetByteCount($captured.ToString() + $chunk) -gt $MaxBytes) {
        [Console]::Error.WriteLine('serial-challenge: response exceeds size limit')
        $exitCode = 2
        break
      }
      [void]$captured.Append($chunk)
      $text = $captured.ToString()
      if ($text.Contains($Marker) -and $text.Contains('nonce=' + $Nonce) -and $text.Contains($AddressKey + '=')) {
        $exitCode = 0
        break
      }
    }
    Start-Sleep -Milliseconds 25
  }
} catch {
  [Console]::Error.WriteLine('serial-challenge: ' + $_.Exception.Message)
  $exitCode = 2
} finally {
  if ($null -ne $serial) {
    try { if ($serial.IsOpen) { $serial.Close() } } catch { }
    $serial.Dispose()
  }
}

[Console]::Out.Write($captured.ToString())
if ($exitCode -eq 1) { [Console]::Error.WriteLine('serial-challenge: correlated response not observed before timeout') }
exit $exitCode
