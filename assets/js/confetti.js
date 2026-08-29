/* ------------------------------------------------------------------
 * confetti.js — canvas confetti burst for the win popup.
 *
 * Written by hand rather than pulled from a CDN so the site stays fully
 * self-contained: no external request, nothing to break offline, and one
 * less thing that can fail on GitHub Pages.
 *
 * Two things here are easy to get wrong and were both caught in testing:
 *
 *  1. Physics must advance on ELAPSED TIME, not on frame count. Frame
 *     counting looks right at 60Hz and then runs ~3x too fast on a 180Hz
 *     display, so the burst is over before anyone sees it.
 *
 *  2. Cannons alone are not enough. Particles fired from the bottom edge
 *     arc off screen in well under a second. The sustained part of the
 *     effect comes from staggered waves falling from above.
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  var COLORS = ['#22e06a', '#ffd93d', '#ff6b9d', '#4dd0e1', '#ffffff', '#a78bfa', '#ff8c42'];

  var canvas = null, ctx = null, dpr = 1;
  var parts = [], raf = null, last = 0, timers = [];

  function reducedMotion() {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function ensureCanvas() {
    if (canvas) return true;
    canvas = document.getElementById('confetti');
    if (!canvas) return false;
    ctx = canvas.getContext('2d');
    resize();
    global.addEventListener('resize', resize);
    return true;
  }

  function resize() {
    if (!canvas) return;
    dpr = Math.min(global.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(global.innerWidth * dpr);
    canvas.height = Math.floor(global.innerHeight * dpr);
    canvas.style.width = global.innerWidth + 'px';
    canvas.style.height = global.innerHeight + 'px';
  }

  function make(x, y, vx, vy, gravity, life) {
    parts.push({
      x: x, y: y, vx: vx, vy: vy,
      g: gravity,
      w: 6 + Math.random() * 6,
      h: 9 + Math.random() * 7,
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 0.34,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      life: 0,
      maxLife: life,
      /* wobble makes the fall read as paper rather than gravel */
      wob: Math.random() * Math.PI * 2,
      vwob: 0.06 + Math.random() * 0.07
    });
  }

  /* An angled cannon: fast, heavy, short-lived. */
  function cannon(x, y, angle, spread, count, power) {
    for (var i = 0; i < count; i++) {
      var a = angle + (Math.random() - 0.5) * spread;
      var v = power * (0.7 + Math.random() * 0.6);
      make(x, y, Math.cos(a) * v, Math.sin(a) * v, 0.34, 170 + Math.random() * 70);
    }
  }

  /* A wave drifting down from above: slow, light, long-lived. This is what
   * keeps the screen alive for the two seconds after the initial pop. */
  function rain(count) {
    var W = global.innerWidth;
    for (var i = 0; i < count; i++) {
      make(
        Math.random() * W,
        -30 - Math.random() * 140,
        (Math.random() - 0.5) * 2.4,
        2.6 + Math.random() * 2.2,
        0.055,
        230 + Math.random() * 90
      );
    }
  }

  function tick(now) {
    var W = global.innerWidth, H = global.innerHeight;
    if (!last) last = now;
    var dt = (now - last) / 16.667;   /* in 60fps-equivalent frames */
    last = now;
    if (!(dt > 0)) dt = 1;
    if (dt > 3) dt = 3;               /* clamp so a backgrounded tab can't teleport */

    var drag = Math.pow(0.992, dt);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.life += dt;
      p.vy += p.g * dt;
      p.vx *= drag;
      p.vy *= drag;
      p.wob += p.vwob * dt;
      p.x += (p.vx + Math.cos(p.wob) * 0.9) * dt;
      p.y += p.vy * dt;
      p.rot += p.vrot * dt;

      if (p.y - 40 > H || p.life > p.maxLife) { parts.splice(i, 1); continue; }
      if (p.y < -200) continue;   /* still falling in from above */

      var fade = p.life > p.maxLife - 45 ? (p.maxLife - p.life) / 45 : 1;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, fade));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      /* squash horizontally as it spins, so pieces read as flat paper */
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w * Math.abs(Math.cos(p.wob)) + 1.5, p.h);
      ctx.restore();
    }

    if (parts.length) {
      raf = requestAnimationFrame(tick);
    } else {
      ctx.clearRect(0, 0, W, H);
      raf = null;
      last = 0;   /* so the next burst starts from a clean clock */
    }
  }

  function run() { if (!raf) raf = requestAnimationFrame(tick); }

  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

  function burst() {
    if (reducedMotion() || !ensureCanvas()) return;
    stop();
    var W = global.innerWidth, H = global.innerHeight;

    /* the initial pop */
    cannon(W * 0.04, H * 0.90, -Math.PI / 3,     0.55, 42, 19);
    cannon(W * 0.96, H * 0.90, -Math.PI * 2 / 3, 0.55, 42, 19);
    cannon(W * 0.50, H * 0.55, -Math.PI / 2,     1.7,  30, 13);
    rain(34);

    /* then keep it falling, so the celebration lasts as long as the popup
     * takes to read rather than blinking out instantly */
    later(function () { rain(30); run(); }, 450);
    later(function () { rain(26); run(); }, 950);
    later(function () { rain(18); run(); }, 1450);

    run();
  }

  function stop() {
    parts.length = 0;
    last = 0;
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
    timers.length = 0;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (ctx) ctx.clearRect(0, 0, global.innerWidth, global.innerHeight);
  }

  global.Confetti = { burst: burst, stop: stop };
})(window);
