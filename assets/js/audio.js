/* ------------------------------------------------------------------
 * audio.js — snippet playback.
 *
 * The game hinges on playing exactly 0.1s of a track. An <audio> element
 * cannot do that: play() has tens of milliseconds of start-up latency and
 * you can only stop it from a timer, so a "0.1s" clip lands anywhere
 * between 0.08s and 0.25s. That difference is the entire first level.
 *
 * So we decode the whole preview into an AudioBuffer up front and play a
 * sample-accurate slice with AudioBufferSourceNode.start(when, offset,
 * duration). The <audio> path is kept only as a last-resort fallback.
 *
 * Short slices also click badly if you cut at a non-zero crossing, so every
 * snippet gets a proportional gain ramp at both ends.
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  var ctx = null;
  var buffers = new Map();   /* songId -> AudioBuffer */
  var inflight = new Map();  /* songId -> Promise */
  var current = null;        /* { source, gain, stopTimer } */
  var fallbackEl = null;

  function getCtx() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    return ctx;
  }

  /** Must be called from inside a user gesture before the first play. */
  function unlock() {
    var c = getCtx();
    if (c && c.state === 'suspended') return c.resume();
    return Promise.resolve();
  }

  function decode(c, arrayBuf) {
    /* Safari still wants the callback form */
    return new Promise(function (resolve, reject) {
      var p = c.decodeAudioData(arrayBuf, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  }

  /* Apple's preview URLs are stable, but if one ever 404s we can ask the
   * public lookup endpoint for a fresh one using the stored track id. */
  function refreshUrl(song) {
    if (!song.itunesId) return Promise.resolve(null);
    var url = 'https://itunes.apple.com/lookup?id=' + encodeURIComponent(song.itunesId);
    return fetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.results && j.results[0] && j.results[0].previewUrl) {
          song.preview = j.results[0].previewUrl;
          return song.preview;
        }
        return null;
      })
      .catch(function () { return null; });
  }

  function fetchBuffer(song) {
    var c = getCtx();
    if (!c) return Promise.reject(new Error('no-webaudio'));

    if (buffers.has(song.id)) return Promise.resolve(buffers.get(song.id));
    if (inflight.has(song.id)) return inflight.get(song.id);

    var attempt = function (url, allowRefresh) {
      return fetch(url, { mode: 'cors' })
        .then(function (r) {
          if (!r.ok) throw new Error('http-' + r.status);
          return r.arrayBuffer();
        })
        .then(function (ab) { return decode(c, ab); })
        .catch(function (err) {
          if (allowRefresh) {
            return refreshUrl(song).then(function (fresh) {
              if (!fresh) throw err;
              return attempt(fresh, false);
            });
          }
          throw err;
        });
    };

    var p = attempt(song.preview, true)
      .then(function (buf) {
        buffers.set(song.id, buf);
        inflight.delete(song.id);
        /* keep memory bounded on long sessions */
        if (buffers.size > 40) {
          var oldest = buffers.keys().next().value;
          buffers.delete(oldest);
        }
        return buf;
      })
      .catch(function (err) {
        inflight.delete(song.id);
        throw err;
      });

    inflight.set(song.id, p);
    return p;
  }

  function stop() {
    if (current) {
      try { current.source.stop(); } catch (e) { /* already stopped */ }
      if (current.stopTimer) clearTimeout(current.stopTimer);
      current = null;
    }
    if (fallbackEl) { try { fallbackEl.pause(); } catch (e) {} }
  }

  /**
   * Play `duration` seconds starting at `offset`.
   * Resolves when playback finishes (or is cut short by stop()).
   */
  function playSnippet(song, offset, duration, onEnd) {
    stop();
    return fetchBuffer(song).then(function (buf) {
      var c = getCtx();
      var dur = Math.min(duration, Math.max(0, buf.duration - offset));
      if (dur <= 0) { offset = 0; dur = Math.min(duration, buf.duration); }

      var src = c.createBufferSource();
      src.buffer = buf;

      var gain = c.createGain();
      src.connect(gain);
      gain.connect(c.destination);

      /* proportional ramps: enough to kill the click, never enough to eat
       * a meaningful share of a 100ms snippet */
      var fadeIn = Math.min(0.010, dur * 0.06);
      var fadeOut = Math.min(0.030, dur * 0.10);
      var t0 = c.currentTime + 0.02; /* small lead so the ramp is scheduled cleanly */

      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(1, t0 + fadeIn);
      gain.gain.setValueAtTime(1, t0 + dur - fadeOut);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      src.start(t0, offset, dur);

      current = { source: src, gain: gain, stopTimer: null };
      var me = current;
      src.onended = function () {
        if (current === me) current = null;
        if (onEnd) onEnd();
      };
      return dur;
    }).catch(function (err) {
      /* Last resort: element playback. Timing is approximate. */
      return playFallback(song, offset, duration, onEnd).then(function () {
        return duration;
      }).catch(function () { throw err; });
    });
  }

  function playFallback(song, offset, duration, onEnd) {
    if (!fallbackEl) {
      fallbackEl = new Audio();
      fallbackEl.crossOrigin = 'anonymous';
      fallbackEl.preload = 'auto';
    }
    var el = fallbackEl;
    return new Promise(function (resolve, reject) {
      var done = false;
      function begin() {
        try { el.currentTime = offset; } catch (e) {}
        el.play().then(function () {
          var stopAt = offset + duration;
          var tick = function () {
            if (done) return;
            if (el.currentTime >= stopAt) { el.pause(); done = true; if (onEnd) onEnd(); resolve(); return; }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }, reject);
      }
      if (el.src !== song.preview) {
        el.src = song.preview;
        el.addEventListener('canplay', begin, { once: true });
        el.addEventListener('error', function () { reject(new Error('audio-el')); }, { once: true });
        el.load();
      } else { begin(); }
    });
  }

  /** Warm the cache without playing — used to preload the next round. */
  function preload(song) {
    if (!song || !song.preview) return Promise.resolve();
    return fetchBuffer(song).catch(function () { /* non-fatal */ });
  }

  function isReady(song) { return buffers.has(song.id); }

  global.SnippetPlayer = {
    unlock: unlock,
    play: playSnippet,
    stop: stop,
    preload: preload,
    isReady: isReady
  };
})(window);
