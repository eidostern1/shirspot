/* ------------------------------------------------------------------
 * search.js — typo-tolerant search over the local song database.
 *
 * Design goals, in priority order:
 *   1. Typing an artist surfaces every song we hold by that artist.
 *   2. Typos never dead-end the player (that is the whole point of the
 *      autocomplete — it should help you guess, not gate you).
 *   3. Exact / prefix matches must always outrank fuzzy ones, so the
 *      list never feels random.
 *
 * Scoring bands (kept deliberately far apart so ordering is stable):
 *   1.00        exact
 *   0.90-0.98   prefix of the whole field
 *   0.84-0.88   prefix of a word inside the field
 *   0.80        every query word matches some word (any order)
 *   0.76        substring
 *   0.50-0.72   fuzzy (edit distance within budget)
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  var Heb = global.Heb;

  /* ---------- Damerau-Levenshtein, bounded ---------- */
  /* Bounded because we only ever care about "within N edits"; bailing out
   * early keeps the whole index scan comfortably under a frame. */
  function editDistance(a, b, max) {
    var al = a.length, bl = b.length;
    if (Math.abs(al - bl) > max) return max + 1;
    if (al === 0) return bl;
    if (bl === 0) return al;

    var prev2 = [], prev = [], cur = [], i, j;
    for (j = 0; j <= bl; j++) prev[j] = j;

    for (i = 1; i <= al; i++) {
      cur[0] = i;
      var rowMin = cur[0];
      var from = Math.max(1, i - max);
      var to = Math.min(bl, i + max);

      /* cells outside the diagonal band can never beat `max` */
      if (from > 1) cur[from - 1] = max + 1;

      for (j = from; j <= to; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        var v = Math.min(
          cur[j - 1] + 1,      /* insertion */
          prev[j] + 1,         /* deletion */
          prev[j - 1] + cost   /* substitution */
        );
        /* transposition — "רככת" for "רכבת" is one edit, not two */
        if (i > 1 && j > 1 &&
            a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
            a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
          v = Math.min(v, prev2[j - 2] + cost);
        }
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (to < bl) cur[to + 1] = max + 1;
      if (rowMin > max) return max + 1;

      var tmp = prev2; prev2 = prev; prev = cur; cur = tmp;
    }
    return prev[bl] <= max ? prev[bl] : max + 1;
  }

  /* How many edits we forgive, by query length. */
  function editBudget(len) {
    if (len <= 2) return 0;
    if (len <= 4) return 1;
    if (len <= 7) return 2;
    if (len <= 12) return 3;
    return 4;
  }

  function fuzzyScore(q, t) {
    var budget = editBudget(q.length);
    if (budget === 0) return 0;
    var d = editDistance(q, t, budget);
    if (d > budget) return 0;
    if (d === 0) return 1;
    return Math.max(0.5, 0.72 - 0.11 * (d - 1));
  }

  /* ---------- single-field similarity, 0..1 ---------- */
  function similarity(q, t, tTokens) {
    if (!q || !t) return 0;
    if (q === t) return 1;

    if (t.indexOf(q) === 0) {
      /* prefix of the entire field — the closer in length, the better */
      return 0.90 + 0.08 * (q.length / t.length);
    }

    var i, tok, best = 0;

    /* prefix of any word ("אביב" -> "תל אביב") */
    for (i = 0; i < tTokens.length; i++) {
      tok = tTokens[i];
      if (tok.indexOf(q) === 0) {
        best = Math.max(best, 0.84 + 0.04 * (q.length / tok.length));
      } else if (Heb.stripProclitic(tok).indexOf(q) === 0) {
        /* "כוכבים" should reach "הכוכבים" */
        best = Math.max(best, 0.82);
      }
    }
    if (best) return best;

    /* every query word matches some field word, in any order */
    var qTokens = q.split(' ');
    if (qTokens.length > 1) {
      var used = {}, all = true;
      for (i = 0; i < qTokens.length; i++) {
        var found = false;
        for (var k = 0; k < tTokens.length; k++) {
          if (used[k]) continue;
          if (tTokens[k].indexOf(qTokens[i]) === 0 ||
              fuzzyScore(qTokens[i], tTokens[k]) > 0) {
            used[k] = true; found = true; break;
          }
        }
        if (!found) { all = false; break; }
      }
      if (all) return 0.80;
    }

    if (t.indexOf(q) !== -1) return 0.76;

    /* whole-string fuzzy */
    var fs = fuzzyScore(q, t);
    if (fs) return Math.min(0.74, fs);

    /* word-level fuzzy — one bad word shouldn't kill the match */
    if (qTokens.length === 1) {
      for (i = 0; i < tTokens.length; i++) {
        var f = fuzzyScore(q, tTokens[i]);
        if (f) best = Math.max(best, Math.min(0.70, f - 0.04));
      }
    }
    return best;
  }

  /* ---------- indexed field ---------- */
  /* Catalogue titles often carry a parenthetical transliteration, e.g.
   * "אם ננעלו (Im Nin'alu)". A player types only the Hebrew part, so the
   * bare title has to be matchable on its own. */
  function stripParens(s) {
    return String(s || '')
      .replace(/[\(\[][^\)\]]*[\)\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function makeField(raw) {
    var n = Heb.norm(raw);
    var p = Heb.phonetic(raw);
    return {
      raw: raw || '',
      n: n,
      p: p,
      nT: n ? n.split(' ') : [],
      pT: p ? p.split(' ') : [],
      skel: Heb.skeleton(n),
      heb: Heb.hasHebrew(n)
    };
  }

  /* Bridges Hebrew typing to a transliterated Latin title (and vice versa).
   * Only applies across scripts — within one script the ordinary scoring is
   * both stronger and safer, and skeletons are lossy enough that comparing
   * two Hebrew titles by skeleton would over-match. */
  function crossScriptScore(qv, field) {
    if (!field || !qv.skel || !field.skel) return 0;
    if (qv.heb === field.heb) return 0;
    if (qv.skel.length < 3) return 0;
    if (qv.skel === field.skel) return 0.93;
    /* One edit of slack keeps genuine pairs that differ only by a silent ה
     * ("Rak Elohim Yodea" / "רק אלוהים יודע"), but skeletons are lossy, so
     * this sits below the substring tier and only surfaces as a last resort. */
    if (qv.skel.length >= 5 && field.skel.length >= 5 &&
        editDistance(qv.skel, field.skel, 1) <= 1) return 0.70;
    if (qv.skel.length >= 4 && field.skel.indexOf(qv.skel) === 0) return 0.80;
    return 0;
  }

  function scoreField(qv, field) {
    if (!field || !field.n) return 0;
    var s = similarity(qv.n, field.n, field.nT);
    /* homophone-folded pass, slightly discounted so it can't outrank a
     * clean match on the real spelling */
    var sp = similarity(qv.p, field.p, field.pT) * 0.94;
    var best = Math.max(s, sp);
    if (qv.layout) {
      best = Math.max(best, similarity(qv.layout, field.n, field.nT) * 0.97);
    }
    return best;
  }

  /* ---------- query variants ---------- */
  function makeQuery(text) {
    var n = Heb.norm(text);
    var qv = {
      n: n,
      p: Heb.phonetic(text),
      layout: null,
      skel: Heb.skeleton(n),
      heb: Heb.hasHebrew(n)
    };
    /* If the user typed pure latin but our data is Hebrew, they may simply
     * have left the keyboard in English. Try the layout-swapped reading. */
    if (n && !Heb.hasHebrew(n) && Heb.hasLatin(n)) {
      var swapped = Heb.fromEnLayout(text);
      if (swapped && Heb.hasHebrew(swapped)) qv.layout = swapped;
    }
    return qv;
  }

  /* ---------- index ---------- */
  function buildIndex(songs) {
    var entries = songs.map(function (s, idx) {
      var bare = stripParens(s.title);
      return {
        song: s,
        idx: idx,
        title: makeField(s.title),
        titleBare: bare && bare !== s.title ? makeField(bare) : null,
        titleLat: s.titleLat ? makeField(s.titleLat) : null,
        artist: makeField(s.artist),
        artistLat: s.artistLat ? makeField(s.artistLat) : null,
        combo: makeField((s.artist || '') + ' ' + (s.title || '')),
        /* popularity rank within the source catalogue: lower is better */
        pop: typeof s.rank === 'number' ? s.rank : 999
      };
    });
    return { entries: entries };
  }

  function scoreEntry(qv, e) {
    var title = Math.max(
      scoreField(qv, e.title),
      e.titleBare ? scoreField(qv, e.titleBare) : 0,
      e.titleLat ? scoreField(qv, e.titleLat) * 0.99 : 0,
      crossScriptScore(qv, e.title),
      e.titleBare ? crossScriptScore(qv, e.titleBare) : 0
    );
    var artist = Math.max(
      scoreField(qv, e.artist),
      e.artistLat ? scoreField(qv, e.artistLat) * 0.99 : 0
    );
    var combo = scoreField(qv, e.combo);

    /* An artist hit is worth almost as much as a title hit, which is what
     * makes "עומר אדם" list that artist's entire catalogue here. */
    return Math.max(title, artist * 0.97, combo);
  }

  /**
   * @param {object} index   from buildIndex
   * @param {string} text    raw user input
   * @param {object} [opts]  { limit, minScore, pool }
   * @returns {Array<{song, score}>}
   */
  function search(index, text, opts) {
    opts = opts || {};
    var limit = opts.limit || 8;
    var minScore = opts.minScore != null ? opts.minScore : 0.45;
    var pool = opts.pool || null; /* optional Set of allowed song ids */

    var qv = makeQuery(text);
    if (!qv.n) return [];

    var hits = [];
    for (var i = 0; i < index.entries.length; i++) {
      var e = index.entries[i];
      if (pool && !pool.has(e.song.id)) continue;
      var sc = scoreEntry(qv, e);
      if (sc >= minScore) hits.push({ e: e, score: sc });
    }

    hits.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (a.e.pop !== b.e.pop) return a.e.pop - b.e.pop; /* better-known first */
      return a.e.title.n.localeCompare(b.e.title.n);
    });

    return hits.slice(0, limit).map(function (h) {
      return { song: h.e.song, score: h.score };
    });
  }

  /**
   * Is this free text close enough to *be* the given song?
   * Used so a player who types the right answer with a typo still wins
   * instead of being punished for spelling.
   *
   * This deliberately does NOT reuse the ranking score above. Ranking asks
   * "which of these is most relevant?"; acceptance asks "is this the same
   * string?" — a full title with one letter wrong is a poor *ranking* score
   * but an obvious yes here. So we test equality directly, on the plain and
   * the homophone-folded spelling, then allow a small edit budget as long
   * as the two strings are of comparable length (which stops a short or
   * generic word from being accepted as a whole title).
   */
  function nearEqual(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    var maxLen = Math.max(a.length, b.length);
    var minLen = Math.min(a.length, b.length);
    if (maxLen < 6) return false;              /* too short to forgive edits */
    if (minLen / maxLen < 0.72) return false;  /* lengths too far apart */
    var tol = Math.max(1, Math.floor(maxLen / 7));
    return editDistance(a, b, tol) <= tol;
  }

  function matchesSong(text, song) {
    var qv = makeQuery(text);
    if (!qv.n) return false;

    var titles = [song.title, stripParens(song.title)];
    if (song.titleLat) titles.push(song.titleLat);

    var cands = [];
    titles.forEach(function (t) {
      if (!t) return;
      cands.push(t);
      if (song.artist) cands.push(song.artist + ' ' + t);
      if (song.artistLat) cands.push(song.artistLat + ' ' + t);
    });

    for (var i = 0; i < cands.length; i++) {
      var tn = Heb.norm(cands[i]);
      if (!tn) continue;
      var tp = Heb.phonetic(cands[i]);
      if (qv.n === tn || qv.p === tp) return true;
      if (nearEqual(qv.n, tn) || nearEqual(qv.p, tp)) return true;
      if (qv.layout && (qv.layout === tn || nearEqual(qv.layout, tn))) return true;

      /* Typing "עומד בשער" must win a round whose title we only hold as
       * "Omed Basha'ar". Cross-script only, and the skeleton has to be long
       * enough that the match means something. */
      if (Heb.hasHebrew(tn) !== qv.heb) {
        var ts = Heb.skeleton(tn);
        if (ts && qv.skel && qv.skel.length >= 4 && qv.skel === ts) return true;
      }
    }
    return false;
  }

  global.SongSearch = {
    buildIndex: buildIndex,
    search: search,
    matchesSong: matchesSong,
    /* exported for the self-test page */
    _internals: { editDistance: editDistance, similarity: similarity, makeField: makeField, makeQuery: makeQuery, scoreField: scoreField }
  };
})(window);
