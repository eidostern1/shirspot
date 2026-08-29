/* ------------------------------------------------------------------
 * app.js — DOM wiring. Game rules live in game.js, matching in search.js.
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var el = {};
  var game = null;
  var index = null;
  var suggestions = [];
  var activeSug = -1;
  var nextSong = null;
  var busy = false;
  var playToken = 0;

  /* ---------------- helpers ---------------- */

  function fmtSeconds(s) {
    return (s < 1 ? s.toFixed(1) : String(s)) + ' שנ׳';
  }

  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.classList.remove('show'); }, ms || 2400);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* Highlight the typed text inside a label when it appears verbatim.
   * (Normalised matches don't map back to raw offsets, so we only
   * highlight the easy case rather than risk mangling the string.) */
  function highlight(text, query) {
    var safe = esc(text);
    var q = (query || '').trim();
    if (!q) return safe;
    var i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return safe;
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }

  /* ---------------- rendering ---------------- */

  function renderGenres() {
    el.genres.innerHTML = '';
    global.Game.GENRES.forEach(function (g) {
      var n = g.id === 'all'
        ? game.songs.length
        : game.songs.filter(function (s) { return s.genres.indexOf(g.id) !== -1; }).length;

      var b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.setAttribute('aria-pressed', String(game.genre === g.id));
      b.innerHTML = esc(g.he) + '<span class="cnt">' + n + '</span>';
      b.disabled = n < 5;
      b.addEventListener('click', function () {
        if (game.genre === g.id) return;
        game.setGenre(g.id);
        nextSong = null;
        try { localStorage.setItem('shirspot.genre', g.id); } catch (e) {}
        renderGenres();
        startRound();
      });
      el.genres.appendChild(b);
    });
  }

  function renderStages() {
    var r = game.round;
    var stage = r ? r.stage : 0;
    var over = r && r.status !== 'playing';

    el.stages.innerHTML = '';
    el.stageLabels.innerHTML = '';

    global.Game.STAGES.forEach(function (secs, i) {
      var d = document.createElement('div');
      d.className = 'stage';
      if (over && r.status === 'lost' && i <= stage) d.className += ' failed';
      else if (i < stage) d.className += ' done';
      else if (i === stage) d.className += ' current';
      d.innerHTML = '<i class="fill"></i>';
      el.stages.appendChild(d);

      var s = document.createElement('span');
      s.textContent = secs < 1 ? secs.toFixed(1) : secs;
      if (i === stage && !over) s.className = 'on';
      el.stageLabels.appendChild(s);
    });
  }

  function renderScorebar() {
    var st = game.stats;
    var pct = st.played ? Math.round((st.won / st.played) * 100) : 0;
    el.scorebar.innerHTML =
      '<span>רצף <b>' + st.streak + '</b></span>' +
      '<span>שיא <b>' + st.best + '</b></span>' +
      '<span>הצלחה <b>' + pct + '%</b></span>' +
      '<span>ניקוד <b>' + st.score + '</b></span>';
  }

  function renderAttempts() {
    var r = game.round;
    el.attempts.innerHTML = '';
    if (!r) return;
    r.attempts.forEach(function (a) {
      var d = document.createElement('div');
      d.className = 'attempt ' + a.kind;
      var tag = a.kind === 'skip' ? 'דילוג' : 'טעות';
      d.innerHTML = '<span class="tag">' + tag + '</span><span class="txt">' +
        (a.text ? esc(a.text) : '—') + '</span>';
      el.attempts.appendChild(d);
    });
  }

  function closeResult() {
    el.resultBack.hidden = true;
    global.Confetti.stop();
  }

  function showResult() {
    var r = game.round;
    if (!r || r.status === 'playing') { closeResult(); return; }

    var s = r.song;
    var won = r.status === 'won';
    var secs = global.Game.STAGES[r.stage];

    el.resultModal.className = 'modal result-modal ' + (won ? 'win' : 'lose');
    el.resultModal.innerHTML =
      '<div class="rm-verdict">' + (won ? 'כל הכבוד! 🎉' : 'לא נורא… 😔') + '</div>' +
      '<div class="rm-sub">' + (won
        ? 'זיהית אחרי <b>' + fmtSeconds(secs) + '</b> · <b>' + global.Game.POINTS[r.stage] + '</b> נקודות'
        : 'השיר היה') + '</div>' +
      (s.art ? '<img class="rm-cover" src="' + esc(s.art) + '" alt="">' : '') +
      '<div class="rm-title">' + esc(s.title) + '</div>' +
      '<div class="rm-artist">' + esc(s.artist) + '</div>' +
      '<div class="rm-meta">' + (s.year ? s.year + ' · ' : '') + esc(s.artistLat || '') + '</div>' +
      '<div class="rm-actions">' +
        '<button class="btn btn-accent" data-act="next">שיר הבא ←</button>' +
        '<button class="btn" data-act="full">▶ השמע 15 שנ׳</button>' +
      '</div>' +
      '<div style="margin-top:13px"><a class="link-out" target="_blank" rel="noopener" href="https://music.apple.com/il/song/' +
        encodeURIComponent(s.itunesId) + '">האזנה מלאה ב-Apple Music ↗</a></div>' +
      '<button class="rm-close" data-act="close">סגירה</button>';

    $('[data-act="next"]', el.resultModal).addEventListener('click', startRound);
    $('[data-act="close"]', el.resultModal).addEventListener('click', closeResult);
    $('[data-act="full"]', el.resultModal).addEventListener('click', function () {
      global.SnippetPlayer.play(s, null, 15);
    });

    el.resultBack.hidden = false;
    if (won) global.Confetti.burst();
    var nextBtn = $('[data-act="next"]', el.resultModal);
    if (nextBtn) nextBtn.focus();
  }

  function setPlayIcon(playing) {
    el.playBtn.innerHTML = playing
      ? '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M8 5.14v13.72c0 .83.92 1.33 1.62.88l10.78-6.86a1.05 1.05 0 000-1.76L9.62 4.26A1.05 1.05 0 008 5.14z"/></svg>';
    el.playBtn.classList.toggle('playing', playing);
  }

  function renderRound() {
    var r = game.round;
    var over = !r || r.status !== 'playing';
    renderStages();
    renderAttempts();
    showResult();
    renderScorebar();

    el.dur.innerHTML = r ? fmtSeconds(global.Game.STAGES[r.stage]).replace(' ', '<small>') + '</small>' : '';
    el.input.disabled = over;
    el.skipBtn.disabled = false;
    /* Once the round is over this button becomes the way forward, so the
     * player is never stuck if they dismiss the popup. */
    el.skipBtn.classList.toggle('btn-accent', over);
    el.skipBtn.textContent = over
      ? 'שיר הבא ←'
      : (r.stage === global.Game.STAGES.length - 1 ? 'ויתור' : 'דילוג ⏭');
    closeSuggest();
    if (!over) el.input.value = '';
  }

  /* ---------------- playback ---------------- */

  function play() {
    var r = game.round;
    if (!r) return;
    var secs = global.Game.STAGES[r.stage];
    var token = ++playToken;

    global.SnippetPlayer.unlock().then(function () {
      setPlayIcon(true);
      var bar = el.stages.children[r.stage];
      var fill = bar ? bar.querySelector('.fill') : null;
      var t0 = performance.now();

      function tick() {
        if (token !== playToken) return;
        var p = Math.min(1, (performance.now() - t0) / (secs * 1000));
        if (fill) fill.style.width = (p * 100) + '%';
        if (p < 1) requestAnimationFrame(tick);
      }

      return global.SnippetPlayer.play(r.song, null, secs, function () {
        if (token === playToken) setPlayIcon(false);
      }).then(function () {
        requestAnimationFrame(tick);
      });
    }).catch(function (err) {
      setPlayIcon(false);
      console.error('playback failed', err);
      toast('לא הצלחנו לנגן את השיר הזה — עוברים לשיר אחר');
      setTimeout(startRound, 900);
    });
  }

  /* ---------------- rounds ---------------- */

  function startRound() {
    if (busy) return;
    busy = true;
    playToken++;
    global.SnippetPlayer.stop();
    setPlayIcon(false);

    var song = nextSong;
    nextSong = null;
    if (song && game.genre !== 'all' && song.genres.indexOf(game.genre) === -1) song = null;

    var r = game.newRound(song);
    if (!r) { busy = false; toast('אין מספיק שירים בסגנון הזה'); return; }

    closeResult();
    el.playBtn.disabled = true;
    renderRound();

    global.SnippetPlayer.preload(r.song).then(function () {
      el.playBtn.disabled = false;
      busy = false;
      el.input.focus();
      /* warm the next round while the player is thinking */
      nextSong = game.pickSong();
      if (nextSong) global.SnippetPlayer.preload(nextSong);
    }).catch(function () {
      busy = false;
      el.playBtn.disabled = false;
    });
  }

  function submitGuess(picked) {
    var r = game.round;
    if (!r || r.status !== 'playing') return;
    var text = el.input.value.trim();
    if (!picked && !text) { toast('כתוב ניחוש או לחץ דילוג'); return; }

    var res = game.guess(picked, text);
    closeSuggest();
    el.input.value = '';

    if (res.correct) {
      playToken++;
      global.SnippetPlayer.stop();
      setPlayIcon(false);
      renderRound();
    } else if (res.round.status === 'lost') {
      playToken++;
      global.SnippetPlayer.stop();
      setPlayIcon(false);
      renderRound();
    } else {
      renderRound();
      play();
    }
  }

  function doSkip() {
    var r = game.round;
    /* after the round ends this button reads "next song" */
    if (!r || r.status !== 'playing') { startRound(); return; }
    game.skip();
    renderRound();
    if (game.round.status === 'playing') play();
    else { playToken++; global.SnippetPlayer.stop(); setPlayIcon(false); }
  }

  /* ---------------- autocomplete ---------------- */

  var sugTimer = null;

  function closeSuggest() {
    el.suggest.hidden = true;
    el.suggest.innerHTML = '';
    suggestions = [];
    activeSug = -1;
    el.input.setAttribute('aria-expanded', 'false');
  }

  function renderSuggest(q) {
    if (!suggestions.length) {
      el.suggest.hidden = false;
      el.suggest.innerHTML = '<div class="sug-empty">לא נמצא שיר מתאים — נסה שם זמר או מילה מהכותרת</div>';
      return;
    }
    el.suggest.hidden = false;
    el.suggest.innerHTML = '';
    suggestions.forEach(function (hit, i) {
      var s = hit.song;
      var d = document.createElement('div');
      d.className = 'sug' + (i === activeSug ? ' active' : '');
      d.setAttribute('role', 'option');
      d.innerHTML =
        (s.art ? '<img src="' + esc(s.art) + '" alt="" loading="lazy">' : '<img alt="">') +
        '<span class="sug-txt">' +
          '<span class="sug-title">' + highlight(s.title, q) + '</span>' +
          '<span class="sug-artist">' + highlight(s.artist, q) + '</span>' +
        '</span>' +
        (s.year ? '<span class="sug-year">' + s.year + '</span>' : '');
      d.addEventListener('mousedown', function (ev) {
        ev.preventDefault();   /* keep focus so blur doesn't close first */
        submitGuess(s);
      });
      d.addEventListener('mouseenter', function () {
        activeSug = i;
        $$('.sug', el.suggest).forEach(function (n, k) { n.classList.toggle('active', k === i); });
      });
      el.suggest.appendChild(d);
    });
    el.input.setAttribute('aria-expanded', 'true');
  }

  function updateSuggest() {
    var q = el.input.value.trim();
    if (q.length < 1) { closeSuggest(); return; }
    suggestions = global.SongSearch.search(index, q, { limit: 8 });
    activeSug = suggestions.length ? 0 : -1;
    renderSuggest(q);
  }

  function moveSug(delta) {
    if (!suggestions.length) return;
    activeSug = (activeSug + delta + suggestions.length) % suggestions.length;
    $$('.sug', el.suggest).forEach(function (n, k) { n.classList.toggle('active', k === activeSug); });
    var node = el.suggest.children[activeSug];
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  }

  /* ---------------- modals ---------------- */

  function openStats() {
    var st = game.stats;
    var pct = st.played ? Math.round((st.won / st.played) * 100) : 0;
    var max = Math.max.apply(null, st.byStage.concat([1]));

    var rows = global.Game.STAGES.map(function (secs, i) {
      var n = st.byStage[i];
      return '<div class="dist-row"><span class="lbl">' + (secs < 1 ? secs.toFixed(1) : secs) + 'שנ׳</span>' +
        '<span class="bar"><i style="width:' + (n / max * 100) + '%"></i></span>' +
        '<span class="n">' + n + '</span></div>';
    }).join('');

    el.modalBody.innerHTML =
      '<h2>הסטטיסטיקה שלך</h2>' +
      '<p class="hint">כמה מהר אתה מזהה שירים?</p>' +
      '<div class="stat-grid">' +
        '<div class="stat"><b>' + st.played + '</b><span>סבבים</span></div>' +
        '<div class="stat"><b>' + pct + '%</b><span>הצלחה</span></div>' +
        '<div class="stat"><b>' + st.streak + '</b><span>רצף נוכחי</span></div>' +
        '<div class="stat"><b>' + st.best + '</b><span>שיא רצף</span></div>' +
      '</div>' +
      '<p class="hint" style="margin-bottom:8px">פילוח לפי אורך הקטע שנדרש:</p>' +
      rows +
      '<div style="margin-top:18px;text-align:center">' +
        '<button class="btn" data-act="reset">איפוס נתונים</button></div>';

    $('[data-act="reset"]', el.modalBody).addEventListener('click', function () {
      game.resetStats();
      renderScorebar();
      openStats();
      toast('הנתונים אופסו');
    });
    el.modalBack.hidden = false;
  }

  function openHelp() {
    el.modalBody.innerHTML =
      '<h2>איך משחקים?</h2>' +
      '<p class="hint">משחק זיהוי שירים בעברית.</p>' +
      '<ul class="rules">' +
        '<li>לוחצים על כפתור ההשמעה ושומעים <b>0.1 שניות</b> מהשיר.</li>' +
        '<li>מנחשים את שם השיר — ההשלמה האוטומטית מציעה שירים מתוך מאגר המשחק, וסובלנית לשגיאות כתיב.</li>' +
        '<li>כל ניחוש שגוי או דילוג פותח קטע ארוך יותר: 0.5 ← 2 ← 8 ← 15 שניות.</li>' +
        '<li>אם טעיתם גם ב-15 השניות — השיר נחשף והסבב נגמר.</li>' +
        '<li>ככל שתזהו מוקדם יותר, כך תקבלו יותר נקודות.</li>' +
      '</ul>' +
      '<p class="hint">טיפ: אפשר לחפש גם לפי שם הזמר כדי לראות את כל השירים שלו במאגר. גם אם שכחתם להחליף שפה במקלדת — החיפוש יבין.</p>';
    el.modalBack.hidden = false;
  }

  /* ---------------- boot ---------------- */

  function boot() {
    el.genres = $('#genres');
    el.stages = $('#stages');
    el.stageLabels = $('#stageLabels');
    el.playBtn = $('#playBtn');
    el.dur = $('#dur');
    el.input = $('#guessInput');
    el.suggest = $('#suggest');
    el.skipBtn = $('#skipBtn');
    el.attempts = $('#attempts');
    el.resultBack = $('#resultBack');
    el.resultModal = $('#resultModal');
    el.scorebar = $('#scorebar');
    el.toast = $('#toast');
    el.modalBack = $('#modalBack');
    el.modalBody = $('#modalBody');
    el.main = $('#main');
    el.loading = $('#loading');

    var songs = global.SONGS_DB;
    if (!songs || !songs.length) {
      el.loading.innerHTML = '<span class="err">מאגר השירים לא נטען.<br>ודאו ש-<code>data/songs.js</code> קיים.</span>';
      return;
    }

    game = new global.Game(songs);
    index = global.SongSearch.buildIndex(songs);

    try {
      var saved = localStorage.getItem('shirspot.genre');
      if (saved && global.Game.GENRES.some(function (g) { return g.id === saved; })) game.setGenre(saved);
    } catch (e) {}

    el.loading.hidden = true;
    el.main.hidden = false;

    renderGenres();
    setPlayIcon(false);

    el.playBtn.addEventListener('click', play);
    el.skipBtn.addEventListener('click', doSkip);
    $('#statsBtn').addEventListener('click', openStats);
    $('#helpBtn').addEventListener('click', openHelp);
    el.modalBack.addEventListener('click', function (e) {
      if (e.target === el.modalBack) el.modalBack.hidden = true;
    });
    $('#modalClose').addEventListener('click', function () { el.modalBack.hidden = true; });
    el.resultBack.addEventListener('click', function (e) {
      if (e.target === el.resultBack) closeResult();
    });

    el.input.addEventListener('input', function () {
      clearTimeout(sugTimer);
      sugTimer = setTimeout(updateSuggest, 80);
    });
    el.input.addEventListener('focus', function () { if (el.input.value.trim()) updateSuggest(); });
    el.input.addEventListener('blur', function () { setTimeout(closeSuggest, 120); });

    el.input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSug(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSug(-1); }
      else if (e.key === 'Escape') { e.stopPropagation(); closeSuggest(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        /* Submitting can open the result popup synchronously. Without this,
         * the same keypress would bubble to the document handler, see an
         * open popup, and skip straight past it to the next song. */
        e.stopPropagation();
        var picked = activeSug >= 0 && suggestions[activeSug] ? suggestions[activeSug].song : null;
        submitGuess(picked);
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!el.resultBack.hidden) { closeResult(); return; }
        if (!el.modalBack.hidden) { el.modalBack.hidden = true; return; }
      }
      /* Enter on the result popup moves to the next song */
      if (e.key === 'Enter' && !el.resultBack.hidden) {
        e.preventDefault();
        startRound();
        return;
      }
      /* space replays the snippet when not typing */
      if (e.code === 'Space' && document.activeElement !== el.input &&
          el.modalBack.hidden && el.resultBack.hidden) {
        e.preventDefault();
        if (!el.playBtn.disabled) play();
      }
    });

    startRound();

    try {
      if (!localStorage.getItem('shirspot.seen')) {
        localStorage.setItem('shirspot.seen', '1');
        openHelp();
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
