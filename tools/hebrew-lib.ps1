# Shared helpers for repairing catalogue titles.
#
# Apple's catalogue stores many Israeli tracks with a transliterated Latin
# title ("Omed Basha'ar") instead of the Hebrew one ("עומד בשער"), and often
# holds BOTH as separate catalogue items. To pair them up we reduce each
# title to a consonant skeleton and compare those:
#
#   "Omed Basha'ar"  ->  M D B S R
#   "עומד בשער"      ->  M D B S R
#
# Hebrew is written without vowels, so the consonant skeleton is the part
# the two spellings genuinely share. Letters that act as vowels (א ע ו י,
# and ה other than word-initially) are dropped, and homophone groups are
# folded together (ט/ת, ס/ש, כ/ק, ב/ו).

function Get-HebrewRun($s) {
  # For a mixed title, return just the Hebrew portion.
  #   "Ze Hakol O Klum (זה הכל או כלום)" -> "זה הכל או כלום"
  #   "Yesh Lecha Shemesh יש לך שמש"     -> "יש לך שמש"
  if (-not $s) { return '' }
  if ($s -notmatch '[\u05D0-\u05EA]') { return $s }

  $runs = [regex]::Matches($s, '[\u05D0-\u05EA][\u05D0-\u05EA\s\u0027\u05F3\u05F4\u2019"\-]*')
  $best = ''; $bestN = 0
  foreach ($m in $runs) {
    $cand = $m.Value.Trim(([char[]]" -'`"" + [char]0x05F3 + [char]0x05F4 + [char]0x2019))
    $n = ([regex]::Matches($cand, '[\u05D0-\u05EA]')).Count
    if ($n -gt $bestN) { $best = $cand; $bestN = $n }
  }
  if ($bestN -ge 2) { return $best }
  return $s
}

function Get-HebSkeleton($s) {
  $t = ($s -replace '[^\u05D0-\u05EA\s]', ' ') -replace '\s+', ' '
  $t = $t.Trim()
  if (-not $t) { return '' }
  $sb = New-Object System.Text.StringBuilder
  foreach ($word in $t.Split(' ')) {
    for ($i = 0; $i -lt $word.Length; $i++) {
      $code = [int][char]$word[$i]
      $m = ''
      switch ($code) {
        0x05D0 { $m = '' }                                    # א  silent
        0x05E2 { $m = '' }                                    # ע  silent
        0x05D5 { $m = '' }                                    # ו  vowel o/u
        0x05D9 { $m = '' }                                    # י  vowel i
        0x05D4 { if ($i -eq 0) { $m = 'H' } else { $m = '' } } # ה  only audible at word start
        0x05D1 { $m = 'B' }  0x05E4 { $m = 'P' }  0x05E3 { $m = 'P' }
        0x05DB { $m = 'K' }  0x05DA { $m = 'K' }  0x05E7 { $m = 'K' }
        0x05D2 { $m = 'G' }  0x05D3 { $m = 'D' }
        0x05D8 { $m = 'T' }  0x05EA { $m = 'T' }
        0x05E1 { $m = 'S' }  0x05E9 { $m = 'S' }
        0x05D6 { $m = 'Z' }  0x05E6 { $m = 'C' }  0x05E5 { $m = 'C' }
        0x05D7 { $m = 'H' }  0x05DC { $m = 'L' }
        0x05DE { $m = 'M' }  0x05DD { $m = 'M' }
        0x05E0 { $m = 'N' }  0x05DF { $m = 'N' }
        0x05E8 { $m = 'R' }
        default { $m = '' }
      }
      [void]$sb.Append($m)
    }
  }
  return $sb.ToString()
}

function Get-LatSkeleton($s) {
  $t = $s.ToLower() -replace '[^a-z]', ''
  # digraphs first, into placeholders so later passes can't re-match them
  $t = $t -creplace 'sh', '1' -creplace 'ch', '2' -creplace 'kh', '2'
  $t = $t -creplace 'tz', '3' -creplace 'ts', '3'
  $t = $t -creplace 'ph', '4' -creplace 'th', '5'
  $sb = New-Object System.Text.StringBuilder
  foreach ($c in $t.ToCharArray()) {
    $m = ''
    switch -CaseSensitive ([string]$c) {
      '1' { $m = 'S' } '2' { $m = 'H' } '3' { $m = 'C' } '4' { $m = 'P' } '5' { $m = 'T' }
      'a' { $m = '' } 'e' { $m = '' } 'i' { $m = '' } 'o' { $m = '' } 'u' { $m = '' } 'y' { $m = '' }
      'b' { $m = 'B' } 'v' { $m = 'B' } 'w' { $m = 'B' }
      'p' { $m = 'P' } 'f' { $m = 'P' }
      'k' { $m = 'K' } 'q' { $m = 'K' } 'c' { $m = 'K' }
      'g' { $m = 'G' } 'j' { $m = 'G' }
      'd' { $m = 'D' } 't' { $m = 'T' } 's' { $m = 'S' } 'z' { $m = 'Z' }
      'h' { $m = 'H' } 'l' { $m = 'L' } 'm' { $m = 'M' } 'n' { $m = 'N' } 'r' { $m = 'R' }
      default { $m = '' }
    }
    [void]$sb.Append($m)
  }
  return $sb.ToString()
}

function Get-EditDistance($a, $b, $max) {
  $al = $a.Length; $bl = $b.Length
  if ([Math]::Abs($al - $bl) -gt $max) { return $max + 1 }
  if ($al -eq 0) { return $bl }
  if ($bl -eq 0) { return $al }
  $prev = New-Object int[] ($bl + 1)
  $cur = New-Object int[] ($bl + 1)
  for ($j = 0; $j -le $bl; $j++) { $prev[$j] = $j }
  for ($i = 1; $i -le $al; $i++) {
    $cur[0] = $i
    for ($j = 1; $j -le $bl; $j++) {
      $cost = 1; if ($a[$i - 1] -ceq $b[$j - 1]) { $cost = 0 }
      $v = [Math]::Min([Math]::Min($cur[$j - 1] + 1, $prev[$j] + 1), $prev[$j - 1] + $cost)
      $cur[$j] = $v
    }
    $tmp = $prev; $prev = $cur; $cur = $tmp
  }
  return $prev[$bl]
}
