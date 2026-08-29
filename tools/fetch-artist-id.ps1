# Third fetch pass, for the English hip hop roster: resolve each artist's Apple
# artistId and look their catalogue up directly.
#
# Why: iTunes' `attribute=artistTerm` search is fuzzy and relevance-ranked, so a
# generic stage name matches the wrong people entirely. Querying artistTerm for
# "Future" returned tracks by j-hope, Paramore and Red Velvet - none of which
# survive the build's artist-name check, leaving that artist with one song.
# "Offset" and "Trippie Redd" came back empty for the same reason.
#
# Looking up by artistId is exact. Results are APPENDED, so tracks already in
# the cache keep their (better) popularity rank and this only fills gaps.
#
# Resumable: artists already carrying idPass=true are skipped.

# -Only lets you target specific artists by name, e.g. an artist who has been
# given a playlist of their own and needs deeper coverage than the roster pass
# provides:  -Only 'אייל גולן'
param([string[]]$Only)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Continue'

$cacheDir = Join-Path $PSScriptRoot 'cache'
$roster = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'artists.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json

function Get-Text($url) {
  $wc = New-Object System.Net.WebClient
  $wc.Encoding = [System.Text.Encoding]::UTF8
  $wc.Headers.Add('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
  return $wc.DownloadString($url)
}

function Get-JsonWithRetry($url, $maxTries = 5) {
  for ($i = 1; $i -le $maxTries; $i++) {
    try { return (Get-Text $url) | ConvertFrom-Json }
    catch {
      if ($i -eq $maxTries) { throw }
      $wait = 10 * $i
      Write-Host ("    throttled, waiting {0}s..." -f $wait)
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

$utf8 = New-Object Text.UTF8Encoding($false)
$targets = if ($Only) {
  @($roster | Where-Object { $_.he -and $Only -contains $_.he })
} else {
  @($roster | Where-Object { $_.he -and $_.g -contains 'hiphopen' })
}
$n = 0

foreach ($a in $targets) {
  $n++
  $out = Join-Path $cacheDir ((Slugify $a.he) + '.json')
  if (-not (Test-Path $out)) { Write-Host ("[{0}/{1}] no cache: {2}" -f $n, $targets.Count, $a.he); continue }

  $entry = [IO.File]::ReadAllText($out, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($entry.PSObject.Properties.Name -contains 'idPass' -and $entry.idPass) {
    Write-Host ("[{0}/{1}] already done: {2}" -f $n, $targets.Count, $a.he); continue
  }

  # 1. resolve the artistId by exact name
  $artistId = $null
  try {
    $u = "https://itunes.apple.com/search?term=$([uri]::EscapeDataString($a.he))&entity=musicArtist&limit=12"
    $j = Get-JsonWithRetry $u
    foreach ($r in $j.results) {
      if ($r.artistName -and $r.artistName.ToLower() -eq $a.he.ToLower()) {
        # prefer a hip hop credit when several artists share the exact name
        if (-not $artistId -or ($r.primaryGenreName -match 'Hip|Rap')) { $artistId = $r.artistId }
        if ($r.primaryGenreName -match 'Hip|Rap') { break }
      }
    }
  } catch { Write-Host ("    artist lookup failed: {0}" -f $_.Exception.Message) }
  Start-Sleep -Milliseconds 3500

  $added = 0
  if ($artistId) {
    try {
      $u2 = "https://itunes.apple.com/lookup?id=$artistId&entity=song&limit=120"
      $j2 = Get-JsonWithRetry $u2
      $existing = @{}
      foreach ($r in $entry.fetched) { if ($r.trackId) { $existing[[string]$r.trackId] = $true } }
      $merged = @($entry.fetched)
      foreach ($r in $j2.results) {
        if ($r.wrapperType -ne 'track') { continue }
        if ($r.trackId -and -not $existing[[string]$r.trackId]) {
          $merged += $r
          $existing[[string]$r.trackId] = $true
          $added++
        }
      }
      $entry.fetched = $merged
    } catch { Write-Host ("    song lookup failed: {0}" -f $_.Exception.Message) }
    Start-Sleep -Milliseconds 3500
  }

  $entry | Add-Member -NotePropertyName idPass -NotePropertyValue $true -Force
  [IO.File]::WriteAllText($out, ($entry | ConvertTo-Json -Depth 8), $utf8)
  Write-Host ("[{0}/{1}] {2} (id={3}) -> +{4}" -f $n, $targets.Count, $a.he, $artistId, $added)
}

Write-Host "DONE"
