# Second fetch pass: query iTunes with each artist's HEBREW name and merge the
# results into the existing cache.
#
# Why this exists: the first pass queried by Latin artist name and only fell
# back to Hebrew when that returned few results. But Apple's catalogue often
# holds the same song twice - once titled in transliteration ("Bashana Haba'a")
# and once in Hebrew ("בשנה הבאה") - and only the Hebrew-name query surfaces
# the Hebrew-titled release. Roughly a fifth of the built database had a
# transliterated title because of this.
#
# Resumable: artists already carrying hebrewPass=true are skipped.

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Continue'

$cacheDir  = Join-Path $PSScriptRoot 'cache'
$rosterPth = Join-Path $PSScriptRoot 'artists.json'
$roster = [IO.File]::ReadAllText($rosterPth, [Text.Encoding]::UTF8) | ConvertFrom-Json

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
$n = 0
foreach ($a in $roster) {
  $n++
  if (-not $a.he) { continue }   # documentation entries carry no artist
  # An artist whose name is already Latin has no Hebrew query to try.
  if ($a.he -notmatch '[א-ת]') { continue }
  $out = Join-Path $cacheDir ((Slugify $a.he) + '.json')
  if (-not (Test-Path $out)) { Write-Host ("[{0}/{1}] no cache, skip" -f $n, $roster.Count); continue }

  $entry = [IO.File]::ReadAllText($out, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($entry.PSObject.Properties.Name -contains 'hebrewPass' -and $entry.hebrewPass) {
    Write-Host ("[{0}/{1}] already done" -f $n, $roster.Count); continue
  }

  $existing = @{}
  foreach ($r in $entry.fetched) { if ($r.trackId) { $existing[[string]$r.trackId] = $true } }

  $added = 0
  $u = "https://itunes.apple.com/search?term=$([uri]::EscapeDataString($a.he))&media=music&entity=song&limit=40"
  try {
    $j = Get-JsonWithRetry $u
    $merged = @($entry.fetched)
    foreach ($r in $j.results) {
      if ($r.trackId -and -not $existing[[string]$r.trackId]) {
        $merged += $r
        $existing[[string]$r.trackId] = $true
        $added++
      }
    }
    $entry.fetched = $merged
  } catch { Write-Host ("    query failed: {0}" -f $_.Exception.Message) }

  $entry | Add-Member -NotePropertyName hebrewPass -NotePropertyValue $true -Force
  [IO.File]::WriteAllText($out, ($entry | ConvertTo-Json -Depth 8), $utf8)
  Write-Host ("[{0}/{1}] {2} -> +{3} tracks" -f $n, $roster.Count, $a.he, $added)

  Start-Sleep -Milliseconds 3500
}

Write-Host "DONE"
