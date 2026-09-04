# Fourth pass, English hip hop only: re-rank each artist's cache by real
# popularity.
#
# Ranking in this project is "position in the cached fetched[] array". The
# earlier passes filled that array from `attribute=artistTerm` (which ranks by
# how well the ARTIST FIELD matches, not by popularity) and then appended a
# full artistId catalogue dump in album order. The result ranked deep cuts
# alongside singles.
#
# A plain relevance search - no attribute filter - genuinely does return an
# artist's best-known songs first ("One Dance", "Hotline Bling", "I Like It").
# So we run that, keep the results that really are this artist, and PREPEND
# them, which makes them rank 1..N. Everything already cached is kept behind
# them, so nothing is lost - it just sorts below the hits.
#
# Resumable: artists already carrying popPass=true are skipped.

# -Genre picks which roster tag to process (default: the English hip hop set).
# -Only targets specific artists by name.
param([string]$Genre = 'hiphopen', [string[]]$Only)

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

function Is-ThisArtist($apiArtist, $entry) {
  $a = ([string]$apiArtist).ToLower()
  if (-not $a) { return $false }
  foreach ($l in $entry.lat) { if ($l -and $a.Contains(([string]$l).ToLower())) { return $true } }
  if ($a.Contains(([string]$entry.he).ToLower())) { return $true }
  return $false
}

$utf8 = New-Object Text.UTF8Encoding($false)
$targets = if ($Only) {
  @($roster | Where-Object { $_.he -and $Only -contains $_.he })
} else {
  @($roster | Where-Object { $_.he -and $_.g -contains $Genre })
}
$n = 0

foreach ($a in $targets) {
  $n++
  $out = Join-Path $cacheDir ((Slugify $a.he) + '.json')
  if (-not (Test-Path $out)) { continue }

  $entry = [IO.File]::ReadAllText($out, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($entry.PSObject.Properties.Name -contains 'popPass' -and $entry.popPass) {
    Write-Host ("[{0}/{1}] already done: {2}" -f $n, $targets.Count, $a.he); continue
  }

  $hits = @()
  try {
    $u = "https://itunes.apple.com/search?term=$([uri]::EscapeDataString($a.he))&media=music&entity=song&limit=30"
    $j = Get-JsonWithRetry $u
    foreach ($r in $j.results) {
      if ($r.trackId -and (Is-ThisArtist $r.artistName $entry)) { $hits += $r }
    }
  } catch { Write-Host ("    popularity query failed: {0}" -f $_.Exception.Message) }

  if ($hits.Count) {
    $frontIds = @{}
    foreach ($r in $hits) { $frontIds[[string]$r.trackId] = $true }
    $tail = @($entry.fetched | Where-Object { -not $frontIds[[string]$_.trackId] })
    $entry.fetched = @($hits) + $tail
  }

  $entry | Add-Member -NotePropertyName popPass -NotePropertyValue $true -Force
  [IO.File]::WriteAllText($out, ($entry | ConvertTo-Json -Depth 8), $utf8)
  Write-Host ("[{0}/{1}] {2} -> {3} popularity-ranked" -f $n, $targets.Count, $a.he, $hits.Count)

  Start-Sleep -Milliseconds 3500
}

Write-Host "DONE"
