param(
  [string]$Hub = $env:FLEET_URL,
  [string]$Token = $env:FLEET_TOKEN,
  [ValidateSet("off", "ask", "allow")][string]$Permit = "ask"
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Hub)) { throw "fleet installer: -Hub is required" }
if ([string]::IsNullOrWhiteSpace($Token)) { throw "fleet installer: -Token is required" }

$baseUrl = "https://github.com/TITOCHAN2023/fleetForAgent/releases/latest/download"
$nativeArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($nativeArch.ToUpperInvariant()) {
  "AMD64" { "amd64" }
  "ARM64" { "arm64" }
  default { throw "fleet installer: unsupported Windows architecture $nativeArch" }
}
$asset = "FleetAgent-windows-$arch.exe"
$tempFile = Join-Path ([IO.Path]::GetTempPath()) ("fleet-" + [guid]::NewGuid().ToString("N") + ".exe")

try {
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$asset" -OutFile $tempFile
  $checksumText = (Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/checksums.txt").Content
  $assetPattern = [regex]::Escape($asset)
  $checksumLine = $checksumText -split "`r?`n" | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+\*?$assetPattern$" } | Select-Object -First 1
  if (-not $checksumLine) { throw "fleet installer: checksum missing for $asset" }
  $want = ($checksumLine -split "\s+")[0].ToLowerInvariant()
  $got = (Get-FileHash -Algorithm SHA256 -Path $tempFile).Hash.ToLowerInvariant()
  if ($got -ne $want) { throw "fleet installer: SHA-256 mismatch for $asset" }

  $binDir = Join-Path $env:USERPROFILE ".local\bin"
  $target = Join-Path $binDir "fleet.exe"
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  if (Test-Path $target) {
    try { & $target quit | Out-Null } catch { }
    $stopped = $false
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
      try { $statusText = (& $target status 2>$null | Out-String) } catch { $statusText = "running: no" }
      if ($statusText -match "running:\s+no") { $stopped = $true; break }
      Start-Sleep -Milliseconds 100
    }
    if (-not $stopped) { throw "fleet installer: existing agent did not stop" }
  }
  Move-Item -Force -Path $tempFile -Destination $target
  Unblock-File -Path $target

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $userParts = @($userPath -split ";" | Where-Object { $_ })
  if ($userParts -notcontains $binDir) {
    $nextPath = if ($userPath) { "$userPath;$binDir" } else { $binDir }
    [Environment]::SetEnvironmentVariable("Path", $nextPath, "User")
  }
  if (@($env:Path -split ";") -notcontains $binDir) { $env:Path = "$env:Path;$binDir" }

  Write-Host "Fleet installed at $target"
  & $target start --hub $Hub --token $Token --permit $Permit
} finally {
  if (Test-Path $tempFile) { Remove-Item -Force $tempFile }
}
