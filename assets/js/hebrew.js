/* ------------------------------------------------------------------
 * hebrew.js — Hebrew-aware text normalisation for search.
 *
 * Hebrew makes fuzzy matching harder than Latin does:
 *   - niqqud (vowel points) may or may not be typed
 *   - five letters have a different form at the end of a word (ך ם ן ף ץ)
 *   - "ktiv male" doubles ו/י inconsistently (רכבת / רככת, מילה / מלה)
 *   - geresh/gershayim are typed as ' " ׳ ״ interchangeably
 *   - several letter pairs are homophones and get genuinely mixed up
 *     by native speakers: ח/כ/ק, ת/ט, ס/ש, א/ע
 *   - people forget to switch keyboard layout and type Hebrew as latin
 *
 * We expose three views of a string, each used at a different weight
 * by search.js:
 *   norm(s)      canonical form  — safe, loses nothing meaningful
 *   phonetic(s)  homophone-folded — catches real spelling mistakes
 *   fromEnLayout(s) reinterpret latin keystrokes as Hebrew ones
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  /* cantillation marks + vowel points + shin/sin dots */
  var NIQQUD = /[֑-ׇֽֿׁׂׅׄ]/g;
  /* maqaf, paseq, sof pasuq, nun hafukha — treat as separators */
  var HEB_SEP = /[־׀׃׆]/g;
  /* every flavour of apostrophe / quote, incl. geresh ׳ and gershayim ״ */
  var QUOTES = /['"`ʼ׳״‘’“”„´]/g;
  /* latin combining diacritics, after NFD */
  var LATIN_MARKS = /[̀-ͯ]/g;

  var FINALS = {
    'ך': 'כ', /* ך -> כ */
    'ם': 'מ', /* ם -> מ */
    'ן': 'נ', /* ן -> נ */
    'ף': 'פ', /* ף -> פ */
    'ץ': 'צ'  /* ץ -> צ */
  };

  /* Yiddish ligatures that occasionally appear in catalogue metadata */
  var LIGATURES = {
    'װ': 'וו', /* װ */
    'ױ': 'וי', /* ױ */
    'ײ': 'יי'  /* ײ */
  };

  /* Homophone folding. Both sides of a comparison get the same treatment,
   * so mapping ש->ס is safe: it only removes a distinction, never invents one. */
  var PHONETIC = {
    'ע': 'א', /* ע -> א  (both silent) */
    'ח': 'כ', /* ח -> כ */
    'ק': 'כ', /* ק -> כ */
    'ט': 'ת', /* ט -> ת */
    'ש': 'ס', /* ש -> ס */
    'ב': 'ו'  /* ב -> ו  (bet without dagesh is /v/) */
  };

  /* Standard Israeli keyboard: latin key -> Hebrew letter on the same key. */
  var EN2HE = {
    q: '/', w: "'", e: 'ק', r: 'ר', t: 'א', y: 'ט',
    u: 'ו', i: 'ן', o: 'ם', p: 'פ',
    a: 'ש', s: 'ד', d: 'ג', f: 'כ', g: 'ע',
    h: 'י', j: 'ח', k: 'ל', l: 'ך', ';': 'ף',
    "'": ',', z: 'ז', x: 'ס', c: 'ב', v: 'ה',
    b: 'נ', n: 'מ', m: 'צ', ',': 'ת', '.': 'ץ',
    '/': '.'
  };

  function stripBidi(s) {
    /* RLM/LRM/RLE/PDF etc. sometimes ride along in copy-pasted titles */
    return s.replace(/[‎‏‪-‮⁦-⁩​-‍﻿]/g, '');
  }

  /** Canonical form: lowercase, no niqqud, no finals, single-spaced. */
  function norm(s) {
    if (s == null) return '';
    var t = String(s);

    t = stripBidi(t);
    t = t.normalize ? t.normalize('NFD') : t;
    t = t.replace(LATIN_MARKS, '');
    t = t.replace(NIQQUD, '');
    t = t.replace(QUOTES, '');
    t = t.replace(HEB_SEP, ' ');

    t = t.replace(/[װ-ײ]/g, function (c) { return LIGATURES[c] || c; });
    t = t.replace(/[ךםןףץ]/g, function (c) { return FINALS[c]; });

    /* collapse doubled vav/yod — the two spellings are equally correct */
    t = t.replace(/וו/g, 'ו').replace(/יי/g, 'י');

    t = t.toLowerCase();
    /* keep hebrew letters, latin alphanumerics and spaces; everything else separates */
    t = t.replace(/[^א-תa-z0-9\s]/g, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  /** Homophone-folded form, for catching genuine misspellings. */
  function phonetic(s) {
    var t = norm(s);
    t = t.replace(/[עחקטשב]/g, function (c) { return PHONETIC[c]; });
    return t;
  }

  /** Reinterpret latin keystrokes as the Hebrew letters on the same keys. */
  function fromEnLayout(s) {
    if (!s) return '';
    var out = '';
    var src = String(s).toLowerCase();
    for (var i = 0; i < src.length; i++) {
      var c = src[i];
      out += Object.prototype.hasOwnProperty.call(EN2HE, c) ? EN2HE[c] : c;
    }
    return norm(out);
  }

  function hasHebrew(s) { return /[א-ת]/.test(String(s || '')); }
  function hasLatin(s) { return /[a-zA-Z]/.test(String(s || '')); }

  function tokens(s) {
    var n = norm(s);
    return n ? n.split(' ') : [];
  }

  /* Very common one-letter Hebrew proclitics. Stripping them gives a second
   * token to match on ("הכוכבים" also matches a query of "כוכבים"). */
  var PROCLITICS = 'הובכלמש'; /* ה ו ב כ ל מ ש */

  function stripProclitic(word) {
    if (word.length >= 4 && PROCLITICS.indexOf(word[0]) !== -1) return word.slice(1);
    return word;
  }

  global.Heb = {
    norm: norm,
    phonetic: phonetic,
    fromEnLayout: fromEnLayout,
    hasHebrew: hasHebrew,
    hasLatin: hasLatin,
    tokens: tokens,
    stripProclitic: stripProclitic
  };
})(window);
