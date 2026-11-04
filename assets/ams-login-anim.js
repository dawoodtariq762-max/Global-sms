/* ==========================================================================
   GLOBAL SMS — CINEMATIC LOGIN EXPERIENCE  ("Signal Horizon")
   assets/ams-login-anim.js

   Companion to assets/ams-login-anim.css. One shared script for every login
   page (login.html and the four portal logins). It only ever ADDS decorative
   markup and toggles a class on <html> — it never touches a form value, a
   handler, a fetch or a route, so authentication, CAPTCHA, validation and
   permissions are untouched.

   Loaded with `defer`, after a tiny inline snippet in each page's <head> has
   already put `ams-anim-on` / `ams-anim-off` on <html>, so there is no
   flash of an un-animated card before the script runs.
   ========================================================================== */
(function () {
  'use strict';

  var KEY = 'ams_login_anim';
  var root = document.documentElement;

  function prefersReduced() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }
  function readStored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function writeStored(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  function shouldAnimate() {
    var s = readStored();
    if (s === 'on') return true;
    if (s === 'off') return false;
    return !prefersReduced();          /* default: follow the OS */
  }

  /* ---------------------------------------------------------------- *
   * 1. the background layer — orbs, trails, waves, stars, shots, orbit
   * ---------------------------------------------------------------- */
  function starCount() {
    var small = (window.innerWidth || 1024) < 760;
    var weak = (navigator.hardwareConcurrency || 8) <= 4;
    if (small) return 4;
    if (weak) return 5;
    return 6;
  }

  /* ---------------------------------------------------------------- *
   * 1b. the SCENE — "Signal Horizon". Decorative flanks that use the empty
   *     space around the card. ~40 tiny elements, built once, animated only
   *     with transform / opacity / translate / scale from the stylesheet.
   *       desktop (>=1000px): perspective floor, light rails, message chips
   *                           (left), radar + illuminated geometry (right)
   *       smaller screens:    static floor, two sonar rings, one horizon glow
   *     Which half is visible is decided in the CSS, so rotating a phone or
   *     resizing a window needs no JavaScript.
   * ---------------------------------------------------------------- */
  function sceneMarkup() {
    var h = '<span class="ams-ui-scene" aria-hidden="true">';

    /* floor (shared: animated on desktop, static elsewhere) */
    h += '<span class="ams-ui-floor"><span class="ams-ui-floor-grid"></span></span>';

    /* small screens: two sonar rings + a horizon glow */
    h += '<span class="ams-ui-m-ring ams-ui-m-ring-1"></span>'
       + '<span class="ams-ui-m-glow"></span>';

    /* desktop: six light rails, three per side, each with a travelling pulse */
    var rails = [['l', 'a', 12, -1], ['r', 'a', 14, -5]];
    for (var i = 0; i < rails.length; i++) {
      var r = rails[i];
      h += '<span class="ams-ui-strip ams-ui-strip-' + r[0] + r[1] + '" style="--d:' + r[2] + 's;--dl:' + r[3] + 's"></span>';
    }

    /* desktop left: message chips (abstract "delivered" bubbles) + geometry */
    h += '<span class="ams-ui-par ams-ui-par-l">';
    for (var c = 1; c <= 3; c++) {
      h += '<span class="ams-ui-chip ams-ui-chip-' + c + '"><i></i><b></b><u></u></span>';
    }
    h += '<span class="ams-ui-geo ams-ui-geo-l1"></span></span>';

    /* desktop right: radar. A node lights up exactly when the sweep passes it
       (sweep period 8s, so the delay is derived from the node's angle). */
    var T = 8;
    var nodes = [[.50, 24], [.50, 152], [.50, 238], [.34, 80], [.34, 205], [.34, 318], [.18, 40], [.18, 270]];
    h += '<span class="ams-ui-par ams-ui-par-r"><span class="ams-ui-radar">'
       + '<i class="ams-ui-rr ams-ui-rr1"></i><i class="ams-ui-rr ams-ui-rr2"></i><i class="ams-ui-rr ams-ui-rr3"></i>'
       + '<i class="ams-ui-sweep"></i>';
    for (var n = 0; n < nodes.length; n++) {
      var a = nodes[n][1];
      var hit = (((a + 90) % 360) / 360) * T;            /* seconds into the lap */
      h += '<i class="ams-ui-node" style="--k:' + nodes[n][0] + ';--a:' + a + 'deg;animation-delay:' + (hit - T).toFixed(2) + 's"></i>';
    }
    h += '<i class="ams-ui-hub"></i></span>'
       + '<span class="ams-ui-geo ams-ui-geo-r1"></span></span>';

    /* extra moving layers (positions / timings randomised in decorateScene):
       data packets crossing the screen, rising bokeh, drifting crosses, ribbons */
    var i;
    for (i = 0; i < 4; i++) h += '<span class="ams-ui-pk' + (i > 1 ? ' ams-ui-x' : '') + '"></span>';
    for (i = 0; i < 3; i++) h += '<span class="ams-ui-bk' + (i > 0 ? ' ams-ui-x' : '') + '"></span>';
    for (i = 0; i < 2; i++) h += '<span class="ams-ui-cr' + (i > 0 ? ' ams-ui-x' : '') + '"></span>';
    h += '<span class="ams-ui-rb ams-ui-rb-1"></span>';

    return h + '</span>';
  }

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function decorateScene(wrap) {
    var list, i, e, d;
    list = wrap.querySelectorAll('.ams-ui-pk');
    for (i = 0; i < list.length; i++) {
      e = list[i]; d = rnd(7, 14);
      e.style.top = (8 + (84 * i) / list.length + rnd(-3, 3)).toFixed(1) + '%';
      e.style.setProperty('--d', d.toFixed(1) + 's');
      e.style.setProperty('--w', Math.round(rnd(40, 110)) + 'px');
      e.style.setProperty('--x0', i % 2 ? '112vw' : '-14vw');
      e.style.setProperty('--x1', i % 2 ? '-14vw' : '112vw');
      e.style.scale = i % 2 ? '-1 1' : '1 1';
      e.style.animationDelay = (-rnd(0, d)).toFixed(1) + 's';
    }
    list = wrap.querySelectorAll('.ams-ui-bk');
    for (i = 0; i < list.length; i++) {
      e = list[i]; d = rnd(20, 36);
      e.style.left = rnd(2, 96).toFixed(1) + '%';
      e.style.setProperty('--s', Math.round(rnd(36, 120)) + 'px');
      e.style.setProperty('--sx', Math.round(rnd(-90, 90)) + 'px');
      e.style.setProperty('--pk', rnd(.22, .45).toFixed(2));
      e.style.setProperty('--c', ['21,94,239', '0,200,180', '0,168,155', '56,189,248'][i % 4]);
      e.style.animationDuration = d.toFixed(1) + 's';
      e.style.animationDelay = (-rnd(0, d)).toFixed(1) + 's';
    }
    list = wrap.querySelectorAll('.ams-ui-cr');
    for (i = 0; i < list.length; i++) {
      e = list[i]; d = rnd(14, 24);
      e.style.left = rnd(3, 96).toFixed(1) + '%';
      e.style.top = rnd(6, 90).toFixed(1) + '%';
      e.style.setProperty('--dx', Math.round(rnd(-70, 70)) + 'px');
      e.style.setProperty('--dy', Math.round(rnd(-90, 90)) + 'px');
      e.style.animationDuration = d.toFixed(1) + 's';
      e.style.animationDelay = (-rnd(0, d)).toFixed(1) + 's';
    }
  }

  function buildLayer() {
    var existing = document.querySelector('.ams-login-bg');
    if (existing) return existing;

    var wrap = document.createElement('div');
    wrap.className = 'ams-login-bg';
    wrap.setAttribute('aria-hidden', 'true');

    var html = ''
      + '<span class="ams-lb-orb ams-lb-orb-a"></span>'
      + '<span class="ams-lb-orb ams-lb-orb-b"></span>'
      + '<span class="ams-lb-orb ams-lb-orb-c"></span>'
      + '<span class="ams-lb-trail ams-lb-trail-1"></span>'
      + '<span class="ams-lb-trail ams-lb-trail-2"></span>'
      + '<span class="ams-lb-trail ams-lb-trail-3"></span>'
      + '<span class="ams-lb-wave ams-lb-wave-1"></span>'
      + '<span class="ams-lb-wave ams-lb-wave-2"></span>'
      + '<span class="ams-lb-halo"></span>'
      + '<span class="ams-lb-orbit"></span>'
      + '<span class="ams-lb-shot ams-lb-shot-1"></span>'
      + '<span class="ams-lb-shot ams-lb-shot-2"></span>';

    var n = starCount();
    for (var i = 0; i < n; i++) html += '<span class="ams-lb-star"></span>';
    html += sceneMarkup();
    wrap.innerHTML = html;
    decorateScene(wrap);

    /* Randomise the particles once, at build time. Animation duration and
       delay are set with a NEGATIVE delay so every star is already somewhere
       along its path on the first frame — no synchronised "curtain up". */
    var stars = wrap.querySelectorAll('.ams-lb-star');
    for (var j = 0; j < stars.length; j++) {
      var s = stars[j];
      var dur = 16 + Math.random() * 20;                 /* 16s - 36s */
      var size = 2 + Math.round(Math.random() * 2);      /* 2px - 4px */
      s.style.left = (Math.random() * 100).toFixed(2) + '%';
      s.style.top = (60 + Math.random() * 55).toFixed(2) + '%';
      s.style.setProperty('--ams-ui-size', size + 'px');
      s.style.setProperty('--ams-ui-peak', (0.45 + Math.random() * 0.5).toFixed(2));
      s.style.setProperty('--ams-ui-drift', (Math.random() * 70 - 35).toFixed(0) + 'px');
      s.style.animationDuration = dur.toFixed(1) + 's';
      s.style.animationDelay = (-Math.random() * dur).toFixed(1) + 's';
    }

    document.body.insertBefore(wrap, document.body.firstChild);
    return wrap;
  }

  /* ---------------------------------------------------------------- *
   * 2. the card — travelling cyan edge light (ring element; styled in the CSS)
   * ---------------------------------------------------------------- */
  function findCard() {
    var kids = document.body ? document.body.children : [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.classList && (el.classList.contains('shell') || el.classList.contains('card'))) return el;
    }
    return null;
  }
  function decorateCard() {
    var card = findCard();
    if (!card || card.querySelector(':scope > .ams-ui-edge')) return card;
    var edge = document.createElement('span');
    edge.className = 'ams-ui-edge';
    edge.setAttribute('aria-hidden', 'true');
    var glow = document.createElement('span');
    glow.className = 'ams-ui-glow';
    glow.setAttribute('aria-hidden', 'true');
    /* one-shot "signal lock" scan line that crosses the card as it arrives
       (and again, tinted, on a failed / successful sign-in) */
    var scan = document.createElement('span');
    scan.className = 'ams-ui-scan';
    scan.setAttribute('aria-hidden', 'true');
    card.insertBefore(edge, card.firstChild);
    card.insertBefore(glow, card.firstChild);
    card.insertBefore(scan, card.firstChild);
    return card;
  }


  /* ---------------------------------------------------------------- *
   * 2c. premium extras — RGB halo tracks the card, cursor spotlight
   * ---------------------------------------------------------------- */
  function premiumFx() {
    var card = findCard();
    var halo = document.querySelector('.ams-lb-halo');
    if (!card) return;
    function place() {
      if (!halo) return;
      var r = card.getBoundingClientRect();
      halo.style.left = (r.left - 3) + 'px';
      halo.style.top = (r.top - 3) + 'px';
      halo.style.width = (r.width + 6) + 'px';
      halo.style.height = (r.height + 6) + 'px';
    }
    place();
    var t0 = Date.now();
    (function loop() { place(); if (Date.now() - t0 < 1500) requestAnimationFrame(loop); })();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { passive: true });
    window.addEventListener('load', place);
    /* the entrance transform moves the card's box; re-measure when it lands */
    card.addEventListener('animationend', function (e) { if (e.target === card) place(); });
    try { new ResizeObserver(place).observe(card); } catch (e) {}
    var pend = false, ex = 0, ey = 0;
    card.addEventListener('mousemove', function (e) {
      ex = e.clientX; ey = e.clientY;
      if (pend) return; pend = true;
      requestAnimationFrame(function () {
        pend = false;
        var r = card.getBoundingClientRect();
        card.style.setProperty('--mx', (ex - r.left) + 'px');
        card.style.setProperty('--my', (ey - r.top) + 'px');
      });
    });
  }


  /* ---------------------------------------------------------------- *
   * 2f. interaction feedback — purely additive, event-driven (no loops).
   *     Only OBSERVES the form and the #msg line the page already renders;
   *     it never reads a value, never intercepts a submit, never calls fetch.
   * ---------------------------------------------------------------- */
  function animOn() { return root.classList.contains('ams-anim-on'); }

  function feedbackFx() {
    var card = findCard();
    if (!card) return;
    var form = card.querySelector('form');
    var scan = card.querySelector('.ams-ui-scan');
    var btn = card.querySelector('form > .btn, form button[type=submit]');

    /* re-trigger a one-shot CSS animation by toggling a class */
    function fire(el, cls) {
      if (!el) return;
      el.classList.remove(cls);
      void el.offsetWidth;                       /* restart */
      el.classList.add(cls);
    }
    function clearOnEnd(el, cls) {
      el.addEventListener('animationend', function (e) {
        if (e.target === el) el.classList.remove(cls);
      });
    }
    if (form) clearOnEnd(form, 'ams-ui-shake');
    if (scan) {
      scan.addEventListener('animationend', function (e) {
        if (e.target === scan) scan.classList.remove('is-err');   /* 'is-ok' stays: page redirects */
      }, true);
    }

    /* ripple on the primary button (pointer only) */
    if (btn) {
      btn.addEventListener('pointerdown', function (e) {
        if (!animOn() || (e.button && e.button !== 0)) return;
        var r = btn.getBoundingClientRect();
        var d = document.createElement('span');
        d.className = 'ams-ui-ripple';
        d.setAttribute('aria-hidden', 'true');
        d.style.left = (e.clientX - r.left) + 'px';
        d.style.top = (e.clientY - r.top) + 'px';
        d.addEventListener('animationend', function () { if (d.parentNode) d.parentNode.removeChild(d); });
        btn.appendChild(d);
      }, { passive: true });
    }

    /* captcha refresh: a quick spin of the icon */
    var refresh = card.querySelector('.refresh-btn');
    if (refresh) {
      refresh.addEventListener('click', function () { if (animOn()) fire(refresh, 'ams-ui-spin'); });
      clearOnEnd(refresh, 'ams-ui-spin');
    }

    /* the page's own status line drives the feedback */
    var msg = card.querySelector('#msg, .msg');
    if (msg && window.MutationObserver) {
      var last = '';
      new MutationObserver(function () {
        var txt = msg.textContent || '';
        var cls = msg.className || '';
        var key = cls + '|' + txt;
        if (key === last) return;
        last = key;
        var busy = /\bshow\b/.test(cls) && txt.indexOf('⏳') === 0;       /* ⏳ Verifying... */
        var err = /\berror\b/.test(cls) && /\bshow\b/.test(cls);
        var ok = /\bsuccess\b/.test(cls) && !busy && /\bshow\b/.test(cls);
        if (btn) btn.classList.toggle('ams-ui-busy', busy);
        card.classList.toggle('ams-ui-is-busy', busy);
        if (!animOn()) return;
        if (err) { fire(form, 'ams-ui-shake'); fire(scan, 'is-err'); }
        else if (ok) { scan && scan.classList.add('is-ok'); if (window.AMSLoginConfetti) window.AMSLoginConfetti(); }
      }).observe(msg, { attributes: true, childList: true, characterData: true, subtree: true });
    }
  }

  /* depth: the side scenes drift a few px against the pointer. Event-driven
     (one rAF per burst of moves, never a running loop); CSS `transition` on
     the `translate` property does the smoothing. Fine pointers only. */
  function parallaxFx() {
    var scene = document.querySelector('.ams-ui-scene');
    if (!scene || !window.matchMedia) return;
    var fine = false;
    try { fine = matchMedia('(hover: hover) and (pointer: fine)').matches; } catch (e) {}
    if (!fine) return;
    var pend = false, nx = 0, ny = 0;
    window.addEventListener('pointermove', function (e) {
      if (!animOn() || window.innerWidth < 1000) return;
      nx = (e.clientX / window.innerWidth) * 2 - 1;
      ny = (e.clientY / window.innerHeight) * 2 - 1;
      if (pend) return; pend = true;
      requestAnimationFrame(function () {
        pend = false;
        scene.style.setProperty('--px', nx.toFixed(3));
        scene.style.setProperty('--py', ny.toFixed(3));
      });
    }, { passive: true });
    document.addEventListener('mouseleave', function () {
      scene.style.setProperty('--px', '0');
      scene.style.setProperty('--py', '0');
    });
  }


  /* ---------------------------------------------------------------- *
   * 2g. the FUN layer — playful, event-driven, no running loops.
   *     cursor comet (3 followers with different lag), click / tap sparks,
   *     typing sparks, clickable chips and logo, confetti on a good login.
   *     Particles are short-lived WAAPI animations (compositor), capped, and
   *     removed on finish.
   * ---------------------------------------------------------------- */
  var COLORS = ['#00c8b4', '#6f9cff', '#9fe3dc', '#5fd6cb', '#38bdf8', '#facc15', '#34d399'];
  function pick() { return COLORS[(Math.random() * COLORS.length) | 0]; }

  function funFx() {
    var fx = document.createElement('div');
    fx.className = 'ams-ui-fx';
    fx.setAttribute('aria-hidden', 'true');
    document.body.appendChild(fx);
    var live = 0;
    var weak = function () { return root.classList.contains('ams-ui-lite'); };
    var canWAAPI = typeof Element.prototype.animate === 'function';

    function burst(x, y, n, spread, size) {
      if (!animOn() || !canWAAPI) return;
      n = weak() ? Math.ceil(n / 2) : n;
      if (live > 70) return;
      for (var i = 0; i < n; i++) {
        var el = document.createElement('span');
        el.className = 'ams-ui-spark';
        var c = pick();
        el.style.cssText = 'left:' + x + 'px;top:' + y + 'px;--c:' + c + ';width:' + (size || 6) + 'px;height:' + (size || 6) + 'px';
        fx.appendChild(el); live++;
        var a = Math.random() * Math.PI * 2, dist = spread * (0.45 + Math.random() * 0.75);
        var dx = Math.cos(a) * dist, dy = Math.sin(a) * dist;
        var an = el.animate([
          { transform: 'translate(-50%,-50%) translate(0,0) scale(1)', opacity: 1 },
          { transform: 'translate(-50%,-50%) translate(' + dx.toFixed(0) + 'px,' + dy.toFixed(0) + 'px) scale(0)', opacity: 0 }
        ], { duration: 500 + Math.random() * 450, easing: 'cubic-bezier(.1,.7,.3,1)' });
        an.onfinish = (function (e) { return function () { live--; if (e.parentNode) e.parentNode.removeChild(e); }; })(el);
      }
    }

    function confetti() {
      if (!animOn() || !canWAAPI) return;
      var card = findCard(); if (!card) return;
      var r = card.getBoundingClientRect();
      var n = weak() ? 14 : 26;
      for (var i = 0; i < n; i++) {
        var el = document.createElement('span');
        el.className = 'ams-ui-conf';
        el.style.cssText = 'left:' + (r.left + r.width * (0.15 + Math.random() * 0.7)) + 'px;top:' + (r.top + 20) + 'px;--c:' + pick();
        fx.appendChild(el); live++;
        var dx = (Math.random() - .5) * 360, up = 80 + Math.random() * 160, fall = 300 + Math.random() * 280;
        var an = el.animate([
          { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
          { transform: 'translate(' + (dx * .6).toFixed(0) + 'px,' + (-up).toFixed(0) + 'px) rotate(' + (Math.random() * 360).toFixed(0) + 'deg)', opacity: 1, offset: .35 },
          { transform: 'translate(' + dx.toFixed(0) + 'px,' + fall.toFixed(0) + 'px) rotate(' + (360 + Math.random() * 540).toFixed(0) + 'deg)', opacity: 0 }
        ], { duration: 1100 + Math.random() * 700, easing: 'cubic-bezier(.2,.6,.4,1)', delay: Math.random() * 120 });
        an.onfinish = (function (e) { return function () { live--; if (e.parentNode) e.parentNode.removeChild(e); }; })(el);
      }
    }
    window.AMSLoginConfetti = confetti;

    /* click / tap anywhere -> little firework (not on the toggle) */
    document.addEventListener('pointerdown', function (e) {
      if (e.target && e.target.closest && e.target.closest('.login-anim-toggle')) return;
      burst(e.clientX, e.clientY, 8, 60, 5);
    }, { passive: true });

    var card = findCard();

    /* chips are clickable: pop + sparks + a little hop */
    var chips = document.querySelectorAll('.ams-ui-chip');
    for (var i = 0; i < chips.length; i++) {
      (function (chip) {
        chip.addEventListener('pointerdown', function (e) {
          e.stopPropagation();
          var r = chip.getBoundingClientRect();
          burst(r.left + r.width / 2, r.top + r.height / 2, 16, 90, 6);
          if (animOn() && canWAAPI) chip.animate(
            [{ transform: 'translate3d(0,0,0) scale(1)' }, { transform: 'translate3d(0,-16px,0) scale(1.12)', offset: .4 }, { transform: 'translate3d(0,0,0) scale(1)' }],
            { duration: 520, easing: 'cubic-bezier(.3,1.6,.5,1)' });
        });
      })(chips[i]);
    }

    /* logo is clickable: spin + burst */
    var logoHost = card && card.querySelector('.ams-ui-mark, .m-brand, .logo');
    if (logoHost) {
      logoHost.style.cursor = 'pointer';
      logoHost.addEventListener('pointerdown', function () {
        var r = logoHost.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + r.height / 2, 22, 120, 6);
        var svg = logoHost.querySelector('svg') || logoHost;
        if (animOn() && canWAAPI) svg.animate([{ transform: 'rotate(0deg) scale(1)' }, { transform: 'rotate(360deg) scale(1.2)', offset: .5 }, { transform: 'rotate(720deg) scale(1)' }], { duration: 900, easing: 'cubic-bezier(.3,.8,.3,1)' });
      });
    }

  }


  /* ---------------------------------------------------------------- *
   * 2d. LITE mode — weak hardware or measured slow frames => lighter scene
   * ---------------------------------------------------------------- */
  function liteMode() {
    var cores = navigator.hardwareConcurrency || 8;
    var mem = navigator.deviceMemory || 8;
    var saveData = !!(navigator.connection && navigator.connection.saveData);
    if (cores <= 2 || mem <= 2 || saveData) { root.classList.add('ams-ui-lite'); return; }
    /* measure real frame time for ~40 frames after the entrance */
    setTimeout(function () {
      var n = 0, last = 0, sum = 0;
      function f(t) {
        if (last) { sum += (t - last); n++; }
        last = t;
        if (n < 40) requestAnimationFrame(f);
        else if (sum / n > 24) root.classList.add('ams-ui-lite');   /* < ~42fps */
      }
      requestAnimationFrame(f);
    }, 1400);
  }


  /* ---------------------------------------------------------------- *
   * 2e. logo mark — replaces the white-background PNG with a crisp inline
   *     SVG (GLOBAL SMS globe + message bubble) that sits straight on the dark glass.
   *     Swap the artwork by editing MARK below, or remove this call to go back to the PNG.
   * ---------------------------------------------------------------- */
  var MARK = '<svg viewBox="0 0 64 64" role="img" aria-label="__AMSLABEL__" xmlns="http://www.w3.org/2000/svg">'
    + '<defs><linearGradient id="amsG1" x1="8" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">'
    + '<stop offset="0" stop-color="#0d3c8c"/><stop offset=".52" stop-color="#155eef"/><stop offset="1" stop-color="#0b43be"/></linearGradient></defs>'
    + '<rect width="64" height="64" rx="15" fill="url(#amsG1)"/>'
    + '<circle cx="29" cy="28" r="13.5" fill="none" stroke="#fff" stroke-width="2.9"/>'
    + '<ellipse cx="29" cy="28" rx="6.2" ry="13.5" fill="none" stroke="#fff" stroke-width="2" opacity=".7"/>'
    + '<path d="M15.5 28h27" stroke="#fff" stroke-width="2" opacity=".7" stroke-linecap="round"/>'
    + '<path d="M37 33h12.5a5.3 5.3 0 0 1 5.3 5.3v5.4a5.3 5.3 0 0 1-5.3 5.3h-6.6l-6.4 5.6V49h-.5a5.3 5.3 0 0 1-5.3-5.3v-5.4A5.3 5.3 0 0 1 37 33z" fill="#00d3be" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>'
    + '<circle cx="41.5" cy="41.2" r="1.6" fill="#0a2540"/><circle cx="46.4" cy="41.2" r="1.6" fill="#0a2540"/><circle cx="51.3" cy="41.2" r="1.6" fill="#0a2540"/></svg>';
  /* ---------------------------------------------------------------- *
   * central logo contract
   *   - DEFAULT: the inline SVG mark above.
   *   - If the owner uploads a logo in the Panel Branding panel, that upload
   *     wins everywhere. The <img> is kept (or restored if we already swapped
   *     it) and pointed at the uploaded asset, so one central logo really is
   *     used by every login page and role panel.
   * ---------------------------------------------------------------- */
  function brandLabel() {
    try { if (window.AMS_BRAND && window.AMS_BRAND.panelName) return window.AMS_BRAND.panelName; } catch (e) {}
    return 'GLOBAL SMS';
  }
  function brandLogoUrl() {
    try {
      var b = window.AMS_BRAND;
      if (b && b.assets && b.assets.logo) return b.assets.logo;
    } catch (e) {}
    /* GLOBAL SMS: the supplied official logo is the default mark (2026-10-24).
       An owner-uploaded branding logo above still wins everywhere. */
    return '/assets/ams-logo-trim.png?v=gsms-20261104';
  }
  var LOGO_SLOTS = '.m-brand img, .m-brand .ams-ui-mark, .logo img, .logo .ams-ui-mark';
  function restoreImg(span) {
    var img = document.createElement('img');
    img.className = span.getAttribute('data-ams-ui-cls') || '';
    img.setAttribute('data-ams-ui-mark', '1');
    img.setAttribute('data-brand-logo', '');
    span.parentNode.replaceChild(img, span);
    return img;
  }
  function brandLogos() {
    var custom = brandLogoUrl();
    var nodes = document.querySelectorAll(LOGO_SLOTS);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (custom) {                              /* an uploaded logo always wins */
        var img = (el.className && String(el.className).indexOf('ams-ui-mark') !== -1) ? restoreImg(el) : el;
        if (img.getAttribute('src') !== custom) img.setAttribute('src', custom);
        img.setAttribute('data-brand-logo', '');
        img.setAttribute('alt', brandLabel());
        continue;
      }
      if (el.tagName !== 'IMG') continue;        /* already showing the SVG mark */
      if (el.getAttribute('data-ams-ui-mark')) continue;
      var span = document.createElement('span');
      span.className = 'ams-ui-mark';
      span.setAttribute('data-ams-ui-mark', '1');
      span.setAttribute('data-ams-ui-cls', el.className || '');
      span.setAttribute('data-brand-logo', '');   /* keep it a branding slot */
      span.innerHTML = MARK.replace('__AMSLABEL__', brandLabel());
      el.parentNode.replaceChild(span, el);
    }
  }

  /* ---------------------------------------------------------------- *
   * 2b. logo backing — the supplied logo is an opaque white-background PNG.
   *     On the glass card that reads as a white square, so the white is turned
   *     into transparency IN MEMORY (colour-to-alpha on a small canvas) and the
   *     <img> is pointed at the result. The file on disk is never modified (the
   *     sidebars keep using it as-is). A logo that is already transparent passes
   *     through unchanged; any failure leaves the CSS edge-fade fallback in place.
   * ---------------------------------------------------------------- */
  /* True only when the logo ships on an opaque, near-white artboard. Sampling
     the border ring is enough: a transparent mark has alpha 0 there, an artboard
     PNG is opaque white. Used to decide whether the multiply/edge-mask/white
     plate treatment is needed at all. */
  function hasOpaqueBacking(img) {
    try {
      var w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return false;
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      var d = ctx.getImageData(0, 0, w, h).data;
      var n = 0, opaque = 0, white = 0;
      var stepX = Math.max(1, Math.floor(w / 40)), stepY = Math.max(1, Math.floor(h / 40));
      function look(x, y) {
        var i = (y * w + x) * 4; n++;
        if (d[i + 3] < 200) return;
        opaque++;
        if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++;
      }
      for (var x = 0; x < w; x += stepX) { look(x, 0); look(x, h - 1); }
      for (var y = 0; y < h; y += stepY) { look(0, y); look(w - 1, y); }
      return n > 0 && (opaque / n) > 0.6 && (white / Math.max(1, opaque)) > 0.6;
    } catch (e) { return false; }
  }
  function cleanLogo(img) {
    if (!img || img.getAttribute('data-ams-ui-clean')) return;
    function run() {
      try {
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return;
        img.setAttribute('data-ams-ui-clean', '1');
        /* An uploaded branding logo is used exactly as supplied — never recoloured. */
        if (brandLogoUrl()) return;
        if (!hasOpaqueBacking(img)) return;
        root.classList.add('ams-ui-logo-opaque');
        var k = Math.min(1, 480 / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
        var c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, cw, ch);
        var d = ctx.getImageData(0, 0, cw, ch), p = d.data;
        for (var i = 0; i < p.length; i += 4) {
          if (p[i + 3] < 255) continue;                       /* already transparent */
          var r = p[i], g = p[i + 1], b = p[i + 2];
          var a = Math.max(255 - r, 255 - g, 255 - b) / 255;  /* how far from white */
          if (a < 0.05) { p[i + 3] = 0; continue; }           /* near-white speckle -> clear */
          p[i]     = Math.max(0, Math.min(255, (r - 255 * (1 - a)) / a));
          p[i + 1] = Math.max(0, Math.min(255, (g - 255 * (1 - a)) / a));
          p[i + 2] = Math.max(0, Math.min(255, (b - 255 * (1 - a)) / a));
          p[i + 3] = Math.round(a * 255);
        }
        ctx.putImageData(d, 0, 0);
        img.src = c.toDataURL('image/png');
        img.classList.add('ams-ui-logo-clean');
      } catch (e) { img.removeAttribute('data-ams-ui-clean'); }
    }
    if (img.complete && img.naturalWidth) run();
    else img.addEventListener('load', run, { once: true });
  }
  function cleanLogos() {
    var list = document.querySelectorAll('.m-brand img, .logo img, .login-hero-logo');
    for (var i = 0; i < list.length; i++) cleanLogo(list[i]);
  }

  /* ---------------------------------------------------------------- *
   * 3. the toggle
   * ---------------------------------------------------------------- */
  function buildToggle(onChange) {
    var id = 'loginAnimToggle';
    if (document.getElementById(id)) return;
    var wrap = document.createElement('div');
    wrap.className = 'login-anim-toggle';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Login animations');
    wrap.innerHTML =
      '<label class="login-anim-label" for="' + id + '" id="loginAnimLabel">Animations</label>' +
      '<input type="checkbox" id="' + id + '" class="login-anim-switch" role="switch" ' +
      'aria-labelledby="loginAnimLabel" />' +
      '<span class="login-anim-state" id="loginAnimState" aria-hidden="true">On</span>';
    document.body.insertBefore(wrap, document.body.firstChild);

    var input = document.getElementById(id);
    input.addEventListener('change', function () { onChange(input.checked); });
  }

  /* ---------------------------------------------------------------- *
   * 4. wire it all up
   * ---------------------------------------------------------------- */
  function apply(on, persist) {
    root.classList.toggle('ams-anim-on', !!on);
    root.classList.toggle('ams-anim-off', !on);
    var input = document.getElementById('loginAnimToggle');
    if (input) input.checked = !!on;
    var st = document.getElementById('loginAnimState');
    if (st) {
      st.textContent = on ? 'On' : 'Off';
      st.classList.toggle('is-on', !!on);
    }
    if (persist) writeStored(on ? 'on' : 'off');
  }

  function init() {
    if (!document.body) return;
    buildLayer();
    decorateCard();
    brandLogos();
    cleanLogos();
    /* AMS_BRAND is published by /branding/runtime.js; if it loads after this
       file, re-evaluate so an uploaded logo still wins over the SVG default. */
    window.AMSLoginBrandRefresh = function () { try { brandLogos(); } catch (e) {} };
    window.addEventListener('load', function () { try { brandLogos(); } catch (e) {} });
    premiumFx();
    feedbackFx();
    parallaxFx();
    funFx();
    liteMode();
    buildToggle(function (on) { apply(on, true); });
    apply(shouldAnimate(), false);

    /* pause everything while the tab is hidden */
    try {
      document.addEventListener('visibilitychange', function () {
        root.classList.toggle('ams-anim-paused', document.visibilityState === 'hidden');
      });
    } catch (e) {}

    /* follow the OS setting, but only while the user has never chosen */
    try {
      var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      var listen = mq.addEventListener ? 'addEventListener' : 'addListener';
      mq[listen]('change', function () {
        if (readStored() === null) apply(!prefersReduced(), false);
      });
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
