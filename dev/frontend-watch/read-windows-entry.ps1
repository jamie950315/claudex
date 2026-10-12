# Prints the Claude frontend entry most recently compiled by Claude Desktop on
# Windows, one line: "<index-*.js> <UTC time>". Read-only.
#
# Windows keeps the HTTP cache in the blockfile format, where the entry is not
# reliably found by name. The script code cache beside it uses the simple-cache
# v5 header and keys every compiled script as "_key<URL> \n<top origin>", so
# the entry Claude Desktop actually evaluated is read from there.
param([string]$CodeCache)
$ErrorActionPreference = 'Stop'
if (-not $CodeCache) {
  $candidates = @()
  $package = Get-AppxPackage -Name Claude -ErrorAction SilentlyContinue
  if ($package) { $candidates += Join-Path $env:LOCALAPPDATA "Packages\$($package.PackageFamilyName)\LocalCache\Roaming\Claude\Code Cache\js" }
  $candidates += Join-Path $env:APPDATA 'Claude\Code Cache\js'
  $CodeCache = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $CodeCache -or -not (Test-Path -LiteralPath $CodeCache)) { [Console]::Error.WriteLine('Claude Desktop code cache not found'); exit 2 }
$root = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/'
$newest = $null
foreach ($file in Get-ChildItem -LiteralPath $CodeCache -File | Where-Object { $_.Name -match '^[0-9a-f]{16}_0$' }) {
  try {
    $stream = [IO.File]::Open($file.FullName, 'Open', 'Read', 'ReadWrite,Delete')
    try { $header = New-Object byte[] 4120; $read = $stream.Read($header, 0, $header.Length) } finally { $stream.Close() }
  } catch [IO.IOException] { continue }
  # Simple-cache initial magic and version 5. Compared as bytes: Windows
  # PowerShell reads the 64-bit literal as a negative number.
  if ($read -lt 24 -or [BitConverter]::ToString($header, 0, 8) -ne '30-5C-72-A7-1B-6D-FB-FC' -or [BitConverter]::ToUInt32($header, 8) -ne 5) { continue }
  $length = [BitConverter]::ToUInt32($header, 12)
  if ($length -lt 1 -or $length -gt 4096 -or 24 + $length -gt $read) { continue }
  $key = [Text.Encoding]::ASCII.GetString($header, 24, $length)
  if (-not $key.StartsWith('_key' + $root)) { continue }
  $name = $key.Substring(4 + $root.Length).Split(" `n".ToCharArray())[0]
  if ($name -notmatch '^index-[A-Za-z0-9_-]{1,64}\.js$') { continue }
  if (-not $newest -or $file.LastWriteTimeUtc -gt $newest.Time) { $newest = @{ Name = $name; Time = $file.LastWriteTimeUtc } }
}
if (-not $newest) { [Console]::Error.WriteLine('No frontend entry in the code cache'); exit 1 }
"$($newest.Name) $($newest.Time.ToString('yyyy-MM-ddTHH:mm:ssZ'))"
