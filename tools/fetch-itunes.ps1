# Fetches each roster artist's most-popular tracks from the public iTunes Search API
# and caches the raw JSON to tools/cache/. Resumable: already-cached artists are skipped.
#
# Run with:  powershell -ExecutionPolicy Bypass -File tools\fetch-itunes.ps1
# (or via the UTF-8 loader used by build.ps1)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Continue'

$root      = Split-Path $PSScriptRoot -Parent
$cacheDir  = Join-Path $PSScriptRoot 'cache'
$rosterPth = Join-Path $PSScriptRoot 'artists.json'

if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir | Out-Null }

$roster = [IO.File]::ReadAllText($rosterPth, [Text.Encoding]::UTF8) | ConvertFrom-Json

function Get-Text($url) {
  $wc = New-Object System.Net.WebClient
  $wc.Encoding = [System.Text.Encoding]::UTF8
  $wc.Headers.Add('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
  return $wc.DownloadString($url)
}

# iTunes rate-limits at roughly 20 requests/minute and answers 403 when throttled.
function Get-JsonWithRetry($url, $maxTries = 5) {
  for ($i = 1; $i -le $maxTries; $i++) {
    try {
      return (Get-Text $url) | ConvertFrom-Json
    } catch {
      $msg = $_.Exception.Message
      if ($i -eq $maxTries) { throw }
      $wait = 10 * $i
      Write-Host ("    throttled/failed ({0}), waiting {1}s..." -f $msg, $wait)
      Start-Sleep -Seconds $wait
    }
  }
}

function Slugify($s) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $s.ToCharArray()) {
    if ($ch -match '[a-zA-Z0-9]') { [void]$sb.Append($ch) }
    else { [void]$sb.Append([string]([int][char]$ch)) }
  }
  return $sb.ToString()
}

$n = 0
foreach ($a in $roster) {
  $n++
  $slug = Slugify $a.he
  $out  = Join-Path $cacheDir "$slug.json"

  if (Test-Path $out) {
    Write-Host ("[{0}/{1}] skip (cached): {2}" -f $n, $roster.Count, $a.he)
    continue
  }

  $collected = @()

  # Pass 1: constrain to the artist field using the Latin name (relevance-ordered = popular first)
  foreach ($lat in $a.lat) {
    $u = "https://itunes.apple.com/search?term=$([uri]::EscapeDataString($lat))&attribute=artistTerm&entity=song&limit=40"
    try {
      $j = Get-JsonWithRetry $u
      if ($j.resultCount -gt 0) { $collected += $j.results }
    } catch { Write-Host ("    latin query failed for {0}: {1}" -f $lat, $_.Exception.Message) }
    Start-Sleep -Milliseconds 3500
    if ($collected.Count -ge 15) { break }
  }

  # Pass 2: free-text Hebrew name, in case Apple indexes the artist only in Hebrew
  if ($collected.Count -lt 15) {
    $u2 = "https://itunes.apple.com/search?term=$([uri]::EscapeDataString($a.he))&media=music&entity=song&limit=40"
    try {
      $j2 = Get-JsonWithRetry $u2
      if ($j2.resultCount -gt 0) { $collected += $j2.results }
    } catch { Write-Host ("    hebrew query failed for {0}: {1}" -f $a.he, $_.Exception.Message) }
    Start-Sleep -Milliseconds 3500
  }

  $payload = [pscustomobject]@{
    he      = $a.he
    lat     = $a.lat
    g       = $a.g
    fetched = $collected
  }
  $json = $payload | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($out, $json, (New-Object Text.UTF8Encoding($false)))

  Write-Host ("[{0}/{1}] {2} -> {3} raw tracks" -f $n, $roster.Count, $a.he, $collected.Count)
}

Write-Host "DONE. Cache at $cacheDir"
