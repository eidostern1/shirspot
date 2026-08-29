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

. (Join-Path $PSScriptRoot 'hebrew-lib.ps1')

# Manual corrections for catalogue metadata errors, keyed by iTunes trackId.
$overridePath = Join-Path $PSScriptRoot 'title-overrides.json'
$OVERRIDES = @{}
if (Test-Path $overridePath) {
  $ov = [IO.File]::ReadAllText($overridePath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  foreach ($prop in $ov.PSObject.Properties) {
    if ($prop.Name -notlike '_*') { $OVERRIDES[$prop.Name] = $prop.Value }
  }
}

$MAX_PER_ARTIST = 16

# Artists carrying a year window (the English hip hop chart names) are wanted
# for their era-defining hits, not their catalogue. Sixteen each produced 900
# songs, most of them album tracks nobody would recognise. Their cache is
# popularity-ranked by fetch-popular.ps1, so the top few really are the hits.
# The by-name artists are exempt and keep the full allowance.
$MAX_PER_CHART_ARTIST = 5
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

# Genre config is read from the roster rather than from the cached payload,
# so re-tagging an artist only needs a rebuild, not a re-fetch.
$ROSTER = @{}
$rosterJson = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'artists.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
foreach ($a in $rosterJson) {
  if ($a.he) { $ROSTER[$a.he] = $a }
}

# ---------------- pass 1: collect every acceptable copy ----------------
$copies = @{}   # key "artistHe|titleNorm" -> list of copies

$files = Get-ChildItem $cacheDir -Filter *.json
Write-Host "Reading $($files.Count) cache files..."

foreach ($f in $files) {
  $entry = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json
  $cfg = $ROSTER[$entry.he]
  $genresForArtist = if ($cfg -and $cfg.g) { $cfg.g } else { $entry.g }
  $onlyRange = if ($cfg) { $cfg.only } else { $null }
  $rank = 0
  foreach ($r in $entry.fetched) {
    $rank++
    if (-not $r.previewUrl) { continue }
    if (-not $r.trackName) { continue }
    if (-not (Artist-Matches $r.artistName $entry)) { continue }
    if (Test-Excluded $r.trackName $r.collectionName) { continue }

    $title = Clean-Title $r.trackName
    # A mixed title carries its own answer: "Ze Hakol O Klum (זה הכל או כלום)"
    # should display as the Hebrew, not the transliteration.
    $title = Get-HebrewRun $title
    # Applied before de-duplication, so a corrected title merges naturally
    # with the correctly-spelled twin instead of surviving alongside it.
    $tidKey = [string]$r.trackId
    if ($OVERRIDES.ContainsKey($tidKey)) { $title = $OVERRIDES[$tidKey] }
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
      genres    = $genresForArtist
      only      = $onlyRange
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
    only      = $best.only
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

# ------- pass 2b: fold transliterated titles into their Hebrew twin -------
# Apple often lists the same recording twice: once titled "Omed Basha'ar" and
# once "עומד בשער". We pair them by consonant skeleton and keep the Hebrew
# spelling, carrying over the earlier year and better rank from whichever
# copy had them.
#
# Deliberately only Latin -> Hebrew: two Hebrew titles are never merged with
# each other, so this can't silently collapse two genuinely different songs.

$mergedCount = 0
$latinKept = 0
$dupMerged = 0

foreach ($artist in @($byArtist.Keys)) {
  $list = $byArtist[$artist]
  $heb = @(); $lat = @()
  foreach ($r in $list) {
    if ($r.title -match '[א-ת]') { $heb += $r } else { $lat += $r }
  }
  foreach ($h in $heb) {
    $h | Add-Member -NotePropertyName skel -NotePropertyValue (Get-HebSkeleton $h.title) -Force
  }

  $keep = New-Object System.Collections.ArrayList
  foreach ($h in $heb) { [void]$keep.Add($h) }

  foreach ($l in $lat) {
    $ls = Get-LatSkeleton $l.title
    $match = $null
    if ($ls.Length -ge 4) {
      foreach ($h in $heb) { if ($h.skel -ceq $ls) { $match = $h; break } }
      # one edit of slack covers ה/h and similar spelling drift, and still
      # leaves clear daylight: the nearest non-matching pair measured 3
      if (-not $match -and $ls.Length -ge 5) {
        foreach ($h in $heb) {
          if ($h.skel.Length -ge 5 -and (Get-EditDistance $h.skel $ls 1) -le 1) { $match = $h; break }
        }
      }
    }
    if ($match) {
      if ($l.year -gt 1900 -and ($match.year -eq 0 -or $l.year -lt $match.year)) { $match.year = $l.year }
      if ($l.rank -lt $match.rank) { $match.rank = $l.rank }
      $mergedCount++
    } else {
      [void]$keep.Add($l)
      $latinKept++
    }
  }

  # Fold near-identical Hebrew titles. The catalogue sometimes lists one song
  # twice under spelling variants ("חופשי"/"חפשי", "אנטארקטיקה"/"אנטרקטיקה")
  # or an outright typo. Tight rule - same artist, both titles reasonably
  # long, exactly one edit apart - and we keep the better-ranked copy, which
  # is the more widely listed spelling.
  $final = New-Object System.Collections.ArrayList
  foreach ($cand in ($keep | Sort-Object rank)) {
    $isDup = $false
    if ($cand.title -match '[א-ת]') {
      $cn = Normalize-He $cand.title
      if ($cn.Length -ge 8) {
        foreach ($seen in $final) {
          if (-not ($seen.title -match '[א-ת]')) { continue }
          $sn = Normalize-He $seen.title
          if ($sn.Length -ge 8 -and (Get-EditDistance $sn $cn 1) -le 1) {
            if ($cand.year -gt 1900 -and ($seen.year -eq 0 -or $cand.year -lt $seen.year)) {
              $seen.year = $cand.year
            }
            $isDup = $true; $dupMerged++; break
          }
        }
      }
    }
    if (-not $isDup) { [void]$final.Add($cand) }
  }
  $byArtist[$artist] = $final
}

Write-Host "Transliterated titles folded into Hebrew twin: $mergedCount"
Write-Host "Latin-titled songs with no Hebrew counterpart:  $latinKept"
Write-Host "Near-duplicate Hebrew titles folded:            $dupMerged"

# ---------------- pass 3: cap per artist, assign genres, emit ----------------
$songs = New-Object System.Collections.ArrayList
$seenGlobal = @{}
$idSeen = @{}

foreach ($artist in ($byArtist.Keys | Sort-Object)) {
  # When choosing which of an artist's songs to keep, prefer the ones Apple
  # titles in Hebrew. This is a nudge, not a rule: a much better-known track
  # still wins its slot even if only a transliterated title exists for it.
  foreach ($r in $byArtist[$artist]) {
    $pen = 0
    if ($r.title -notmatch '[א-ת]') { $pen = 10 }
    $r | Add-Member -NotePropertyName sortKey -NotePropertyValue ([int]$r.rank + $pen) -Force
  }
  # `only` restricts an artist to a release window - used for the English hip
  # hop chart artists, who are wanted for their 2016-2024 hits rather than
  # their whole back catalogue.
  #
  # This has to happen BEFORE the per-artist cap, or out-of-window tracks eat
  # the slots and the artist ends up with far fewer songs than intended.
  #
  # The upper bound is also softened: Apple stamps re-releases with the
  # reissue date, and for some artists that is their WHOLE catalogue (every
  # Trippie Redd entry reports 2026). Applying a hard ceiling there deletes
  # the artist entirely. So if the full window leaves too little, we keep the
  # lower bound - which is the half that actually matters, since it is what
  # excludes an artist's older, pre-2016 era - and drop the ceiling.
  $candidates = $byArtist[$artist]
  $cfgOnly = $null
  foreach ($c in $candidates) { if ($c.only -and $c.only.Count -eq 2) { $cfgOnly = $c.only; break } }

  if ($cfgOnly) {
    $lo = [int]$cfgOnly[0]; $hi = [int]$cfgOnly[1]
    $windowed = @($candidates | Where-Object { $_.year -ge $lo -and $_.year -le $hi })
    if ($windowed.Count -lt 5) {
      $relaxed = @($candidates | Where-Object { $_.year -ge $lo })
      if ($relaxed.Count -gt $windowed.Count) {
        Write-Host ("  {0}: only {1} in {2}-{3} (Apple re-release dating); using {4}+ instead -> {5}" -f $artist, $windowed.Count, $lo, $hi, $lo, $relaxed.Count)
        $windowed = $relaxed
      }
    }
    $candidates = $windowed
  }

  # An artist with their own dedicated playlist needs more than the usual
  # allowance, so the roster can override the cap per artist.
  $cap = if ($cfgOnly) { $MAX_PER_CHART_ARTIST } else { $MAX_PER_ARTIST }
  if ($ROSTER.ContainsKey($artist) -and $ROSTER[$artist].max) { $cap = [int]$ROSTER[$artist].max }
  $list = $candidates | Sort-Object sortKey | Select-Object -First $cap
  foreach ($r in $list) {
    $gkey = (Normalize-He $artist) + '|' + (Normalize-He $r.title)
    if ($seenGlobal.ContainsKey($gkey)) { continue }
    $seenGlobal[$gkey] = $true

    $g = New-Object System.Collections.ArrayList
    foreach ($x in $r.genres) { if (-not $g.Contains($x)) { [void]$g.Add($x) } }

    # The decade playlists ("שנות התשעים" and friends) are about Israeli
    # music, so English-language tracks stay out of them.
    $isEnglish = $g.Contains('hiphopen')

    # Decade tag from the earliest year we saw.
    $isClassic = $g.Contains('classic')
    $y = $r.year
    if (-not $isEnglish -and $y -ge 1960 -and $y -le $THIS_YEAR) {
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
      lang      = $(if ($isEnglish) { 'en' } else { 'he' })
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
