# Turns tools/cache/*.json (raw iTunes results) into data/songs.js + data/songs.json.
#
# Notable correctness step: Apple's releaseDate is the date of *that catalogue
# item*, so a 1995 hit that was re-released on a 2026 compilation reports 2026.
# We therefore group every copy of a song and keep the EARLIEST year seen,
# which is a much better estimate of the original release.

$ErrorActionPreference = 'Stop'

$root     = Split-Path $PSScriptRoot -Parent
$cacheDir = Join-Path $PSScriptRoot 'cache'
$dataDir  = Join-Path $root 'data'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }

$MAX_PER_ARTIST = 16
$THIS_YEAR = 2026

# Tracks we never want in a "name that tune" game.
$EXCLUDE = @(
  'live', 'לייב', 'בהופעה', 'הופעה חיה', 'במופע', 'באולפן',
  'remix', 'רמיקס', 'ריمיקס',
  'karaoke', 'קריוקי',
  'instrumental', 'אינסטרומנטל', 'מינוס',
  'medley', 'מחרוזת',
  'version', 'גרסה', 'גירסה',
  'commentary', 'interview', 'ראיון',
  'megamix', 'mashup'
)

function Test-Excluded($name, $album) {
  $hay = (([string]$name) + ' ' + ([string]$album)).ToLower()
  foreach ($x in $EXCLUDE) { if ($hay.Contains($x.ToLower())) { return $true } }
  return $false
}

# Mirror of the normalisation in assets/js/hebrew.js, enough for de-duping.
function Normalize-He($s) {
  if (-not $s) { return '' }
  $t = [string]$s
  $t = $t -replace '[֑-ׇֽֿׁׂׅׄ]', ''
  $t = $t -replace "[`'`"``׳״‘’“”]", ''
  $t = $t.Replace([char]0x05DA, [char]0x05DB).
          Replace([char]0x05DD, [char]0x05DE).
          Replace([char]0x05DF, [char]0x05E0).
          Replace([char]0x05E3, [char]0x05E4).
          Replace([char]0x05E5, [char]0x05E6)
  $t = $t -replace 'וו', 'ו' -replace 'יי', 'י'
  $t = $t.ToLower()
  $t = $t -replace '[^א-תa-z0-9\s]', ' '
  $t = $t -replace '\s+', ' '
  return $t.Trim()
}

# Strip "(feat. X)", "[...]", " - Single Version" style suffixes.
function Clean-Title($s) {
  $t = [string]$s
  $t = $t -replace '\s*[\(\[]\s*(feat|ft|featuring)\.?[^\)\]]*[\)\]]', ''
  $t = $t -replace '\s*[\(\[][^\)\]]*\b(single|album|radio|edit|mono|stereo|remaster(ed)?|bonus|version)\b[^\)\]]*[\)\]]', ''
  $t = $t -replace '\s*-\s*(single|radio edit|remaster(ed)?( \d{4})?)\s*$', ''
  $t = $t -replace '\s+', ' '
  return $t.Trim().Trim('-').Trim()
}

function Artist-Matches($apiArtist, $entry) {
  $a = ([string]$apiArtist).ToLower()
  if (-not $a) { return $false }
  foreach ($l in $entry.lat) {
    $ll = ([string]$l).ToLower()
    if ($ll -and $a.Contains($ll)) { return $true }
    # tolerate "&" vs "and", and missing surname suffixes
    $lc = $ll -replace '\s*&\s*', ' and '
    $ac = $a  -replace '\s*&\s*', ' and '
    if ($lc -and $ac.Contains($lc)) { return $true }
  }
  if ($a.Contains(($entry.he).ToLower())) { return $true }
  return $false
}

# ---------------- pass 1: collect every acceptable copy ----------------
$copies = @{}   # key "artistHe|titleNorm" -> list of copies

$files = Get-ChildItem $cacheDir -Filter *.json
Write-Host "Reading $($files.Count) cache files..."

foreach ($f in $files) {
  $entry = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json
  $rank = 0
  foreach ($r in $entry.fetched) {
    $rank++
    if (-not $r.previewUrl) { continue }
    if (-not $r.trackName) { continue }
    if (-not (Artist-Matches $r.artistName $entry)) { continue }
    if (Test-Excluded $r.trackName $r.collectionName) { continue }

    $title = Clean-Title $r.trackName
    if (-not $title -or $title.Length -gt 55) { continue }

    $tn = Normalize-He $title
    if (-not $tn) { continue }

    $year = 0
    if ($r.releaseDate -and ([string]$r.releaseDate).Length -ge 4) {
      $year = [int]([string]$r.releaseDate).Substring(0, 4)
    }

    $key = $entry.he + '|' + $tn
    if (-not $copies.ContainsKey($key)) { $copies[$key] = New-Object System.Collections.ArrayList }
    [void]$copies[$key].Add([pscustomobject]@{
      artistHe  = $entry.he
      genres    = $entry.g
      title     = $title
      titleNorm = $tn
      artistLat = $r.artistName
      itunesId  = $r.trackId
      preview   = $r.previewUrl
      art       = $r.artworkUrl100
      year      = $year
      rank      = $rank
    })
  }
}

Write-Host "Distinct songs before ranking: $($copies.Count)"

# ---------------- pass 2: one record per song, earliest year ----------------
$byArtist = @{}

foreach ($key in $copies.Keys) {
  $list = $copies[$key]
  $best = ($list | Sort-Object rank)[0]              # best-known copy wins for preview/art
  $years = @($list | Where-Object { $_.year -gt 1900 } | ForEach-Object { $_.year })
  $minYear = if ($years.Count) { ($years | Measure-Object -Minimum).Minimum } else { 0 }

  $rec = [pscustomobject]@{
    artistHe  = $best.artistHe
    genres    = $best.genres
    title     = $best.title
    artistLat = $best.artistLat
    itunesId  = $best.itunesId
    preview   = $best.preview
    art       = $best.art
    year      = $minYear
    rank      = $best.rank
  }
  if (-not $byArtist.ContainsKey($rec.artistHe)) { $byArtist[$rec.artistHe] = New-Object System.Collections.ArrayList }
  [void]$byArtist[$rec.artistHe].Add($rec)
}

# ---------------- pass 3: cap per artist, assign genres, emit ----------------
$songs = New-Object System.Collections.ArrayList
$seenGlobal = @{}
$idSeen = @{}

foreach ($artist in ($byArtist.Keys | Sort-Object)) {
  $list = $byArtist[$artist] | Sort-Object rank | Select-Object -First $MAX_PER_ARTIST
  foreach ($r in $list) {
    $gkey = (Normalize-He $artist) + '|' + (Normalize-He $r.title)
    if ($seenGlobal.ContainsKey($gkey)) { continue }
    $seenGlobal[$gkey] = $true

    $g = New-Object System.Collections.ArrayList
    foreach ($x in $r.genres) { if (-not $g.Contains($x)) { [void]$g.Add($x) } }

    # Decade tag from the earliest year we saw.
    $isClassic = $g.Contains('classic')
    $y = $r.year
    if ($y -ge 1960 -and $y -le $THIS_YEAR) {
      $decadeOk = $true
      # A "classic" artist showing a 2010+ date is certainly a re-release,
      # so we decline to guess rather than mislabel it.
      if ($isClassic -and $y -ge 2010) { $decadeOk = $false }
      if ($decadeOk) {
        $d = $null
        if     ($y -le 1979) { $d = '70s' }
        elseif ($y -le 1989) { $d = '80s' }
        elseif ($y -le 1999) { $d = '90s' }
        elseif ($y -le 2009) { $d = '2000s' }
        elseif ($y -le 2019) { $d = '2010s' }
        else                 { $d = '2020s' }
        if (-not $g.Contains($d)) { [void]$g.Add($d) }
      }
    }

    $id = 't' + $r.itunesId
    if ($idSeen.ContainsKey($id)) { continue }
    $idSeen[$id] = $true

    $art = ''
    if ($r.art) { $art = ([string]$r.art) -replace '100x100', '300x300' }

    [void]$songs.Add([ordered]@{
      id        = $id
      title     = $r.title
      artist    = $artist
      artistLat = $r.artistLat
      year      = $r.year
      genres    = @($g)
      preview   = $r.preview
      art       = $art
      itunesId  = $r.itunesId
      rank      = $r.rank
    })
  }
}

Write-Host "Final song count: $($songs.Count)"

# genre histogram, so we can sanity-check the playlists
$hist = @{}
foreach ($s in $songs) { foreach ($g in $s.genres) { $hist[$g] = 1 + [int]$hist[$g] } }
foreach ($k in ($hist.Keys | Sort-Object)) { Write-Host ("  {0,-10} {1}" -f $k, $hist[$k]) }

$utf8 = New-Object Text.UTF8Encoding($false)
$json = $songs | ConvertTo-Json -Depth 5 -Compress

[IO.File]::WriteAllText((Join-Path $dataDir 'songs.json'), $json, $utf8)
[IO.File]::WriteAllText((Join-Path $dataDir 'songs.js'), "window.SONGS_DB = $json;", $utf8)

Write-Host "Wrote data/songs.json and data/songs.js"
