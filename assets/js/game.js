/* ------------------------------------------------------------------
 * game.js — rules, round selection and persistent stats.
 * Pure logic, no DOM, so it can be exercised from the self-test page.
 *
 * Rules (as specified):
 *   Five levels: 0.1s, 0.5s, 2s, 8s, 15s.
 *   A wrong guess OR a skip advances to the next level.
 *   Getting it wrong (or skipping) at 15s ends the round as a loss and
 *   reveals the song.
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  var STAGES = [0.1, 0.5, 2, 8, 15];
  var POINTS = [100, 80, 60, 40, 20];
  var STORE_KEY = 'shirspot.stats.v1';
  var RECENT_KEY = 'shirspot.recent.v1';

  var GENRES = [
    { id: 'all',      he: 'הכול' },
    { id: 'mizrahit', he: 'מזרחית' },
    { id: '90s',      he: 'שנות התשעים' },
    { id: '2000s',    he: 'שנות האלפיים' },
    { id: '80s',      he: 'שנות השמונים' },
    { id: '2010s',    he: 'שנות העשרה' },
    { id: '2020s',    he: 'להיטי היום' },
    { id: 'rock',     he: 'רוק ישראלי' },
    { id: 'pop',      he: 'פופ ישראלי' },
    { id: 'hiphop',   he: 'היפ הופ ישראלי' },
    { id: 'classic',  he: 'קלאסיקות' },
    { id: 'hiphopen', he: 'היפ הופ עולמי' },
    { id: 'metal',    he: 'מטאל' },
    { id: 'eyalgolan', he: 'אייל גולן' }
  ];

  function readJSON(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, val) {
    try { global.localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ }
  }

  function defaultStats() {
    return { played: 0, won: 0, streak: 0, best: 0, byStage: [0, 0, 0, 0, 0], score: 0 };
  }

  function Game(songs) {
    this.songs = songs;
    this.stats = Object.assign(defaultStats(), readJSON(STORE_KEY, {}));
    if (!Array.isArray(this.stats.byStage) || this.stats.byStage.length !== 5) {
      this.stats.byStage = [0, 0, 0, 0, 0];
    }
    this.recent = readJSON(RECENT_KEY, []);
    this.genre = 'all';
    this.round = null;
  }

  /* "הכול" means every Hebrew song. The English hip hop set is a deliberate
   * side pool — folding ~700 English tracks into the default would change
   * what this game is. */
  Game.prototype.pool = function () {
    var g = this.genre;
    if (g === 'all') {
      return this.songs.filter(function (s) { return s.lang !== 'en'; });
    }
    return this.songs.filter(function (s) { return s.genres && s.genres.indexOf(g) !== -1; });
  };

  Game.prototype.setGenre = function (g) {
    this.genre = g;
    return this.pool().length;
  };

  /** Pick a song, avoiding anything played recently (per genre pool size). */
  Game.prototype.pickSong = function () {
    var pool = this.pool();
    if (!pool.length) return null;

    var recent = this.recent;
    var avoid = Math.min(recent.length, Math.floor(pool.length * 0.6));
    var recentSet = new Set(recent.slice(0, avoid));

    var fresh = pool.filter(function (s) { return !recentSet.has(s.id); });
    var from = fresh.length ? fresh : pool;

    /* Weight slightly toward better-known tracks so rounds stay fair:
     * pick the best-ranked of two random draws. */
    var a = from[Math.floor(Math.random() * from.length)];
    var b = from[Math.floor(Math.random() * from.length)];
    var song = (a.rank || 999) <= (b.rank || 999) ? a : b;

    this.recent.unshift(song.id);
    if (this.recent.length > 400) this.recent.length = 400;
    writeJSON(RECENT_KEY, this.recent);
    return song;
  };

  Game.prototype.newRound = function (song) {
    song = song || this.pickSong();
    if (!song) return null;
    this.round = {
      song: song,
      stage: 0,
      attempts: [],   /* { text, kind: 'wrong'|'skip' } */
      status: 'playing'
    };
    return this.round;
  };

  Game.prototype.stageSeconds = function () {
    return STAGES[Math.min(this.round ? this.round.stage : 0, STAGES.length - 1)];
  };

  function endRound(game, won) {
    var r = game.round;
    r.status = won ? 'won' : 'lost';
    var st = game.stats;
    st.played += 1;
    if (won) {
      st.won += 1;
      st.streak += 1;
      st.byStage[r.stage] += 1;
      st.score += POINTS[r.stage];
      if (st.streak > st.best) st.best = st.streak;
    } else {
      st.streak = 0;
    }
    writeJSON(STORE_KEY, st);
    return r;
  }

  /** Advance after a wrong answer or a skip. Returns the updated round. */
  function advance(game, text, kind) {
    var r = game.round;
    if (!r || r.status !== 'playing') return r;
    r.attempts.push({ text: text || '', kind: kind });
    if (r.stage >= STAGES.length - 1) {
      return endRound(game, false);
    }
    r.stage += 1;
    return r;
  }

  /**
   * Submit a guess.
   * @param {object|null} picked  song object chosen from the suggestion list
   * @param {string} text         raw typed text (used when nothing was picked)
   * @returns {{correct:boolean, round:object}}
   */
  Game.prototype.guess = function (picked, text) {
    var r = this.round;
    if (!r || r.status !== 'playing') return { correct: false, round: r };

    var correct = false;
    if (picked && picked.id === r.song.id) {
      correct = true;
    } else if (!picked && text) {
      /* Typed free-text that is unambiguously this song still counts —
       * the search is meant to help the player, not trip them up. */
      correct = global.SongSearch.matchesSong(text, r.song);
    } else if (picked) {
      /* Different recording of the same song (same title + artist) counts. */
      correct = sameSong(picked, r.song);
    }

    if (correct) {
      endRound(this, true);
      return { correct: true, round: r };
    }
    advance(this, picked ? (picked.artist + ' - ' + picked.title) : text, 'wrong');
    return { correct: false, round: r };
  };

  function sameSong(a, b) {
    if (!a || !b) return false;
    var H = global.Heb;
    return H.norm(a.title) === H.norm(b.title) && H.norm(a.artist) === H.norm(b.artist);
  }

  Game.prototype.skip = function () {
    return advance(this, '', 'skip');
  };

  Game.prototype.resetStats = function () {
    this.stats = defaultStats();
    writeJSON(STORE_KEY, this.stats);
  };

  Game.STAGES = STAGES;
  Game.POINTS = POINTS;
  Game.GENRES = GENRES;

  global.Game = Game;
})(window);
