/* ============================================================================
   ams-motion.js — companion to ams-motion.css
   ----------------------------------------------------------------------------
   Three small, event-driven jobs. No timers, no requestAnimationFrame loops, no
   network, no data access, no libraries. ES5 like the rest of the shipped JS.

   1. html.ams-motion-ready  — set after first paint so nothing animates while the page
                       is still booting (CSS uses it to keep menus that are
                       restored open from "sliding" on load).
   2. --ams-motion-h         — measures each sidebar dropdown group (.submenu / .rsub /
                       Manager's .dropmenu) so it opens to its REAL height. The
                       old code capped groups at a fixed max-height (Admin 420px,
                       Agent 200px), which clipped long groups and wasted time at
                       the end of the animation. CSS falls back to 480px if this
                       script does not run.
   3. click origin   — a clicked link / clickable card remembers where it was
                       clicked (sessionStorage, 5 s, same tab only); the next page
                       opens from that point and a thin progress bar runs. Skipped
                       entirely in LITE mode / reduced-motion.
   4. .is-loading    — a .btn that is disabled while its label ends in "…" or
                       "..." (the "Saving…" pattern the panels already use) gets
                       a spinner. Nothing is wired to any request; it only
                       mirrors state the page already sets.
   ========================================================================== */
(function () {
  'use strict';
  var root = document.documentElement;
  if (!root || !window.MutationObserver) return;

  /* ---- 1. ready flag ---- */
  function markReady() {
    if (!window.requestAnimationFrame) { root.classList.add('ams-motion-ready'); return; }
    requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.add('ams-motion-ready'); }); });
  }
  if (document.readyState === 'complete') markReady();
  else window.addEventListener('load', markReady);

  /* ---- 2. dropdown group heights ---- */
  var GROUPS = '.submenu, .rsub, .navtabs .dropmenu, .appbar .dropmenu';

  function isOpen(el) { return el.classList.contains('open') || el.classList.contains('show'); }

  function measure(el) {
    /* scrollHeight reports full content height even while max-height is 0 */
    var h = el.scrollHeight;
    if (h > 0) el.style.setProperty('--ams-motion-h', (h + 2) + 'px');
  }

  /* A group nested inside another open group would be clipped by the parent's
     measured cap while it grows, so open ancestors get a generous cap instead. */
  function relaxAncestors(el) {
    var p = el.parentElement;
    while (p) {
      if (p.matches && p.matches(GROUPS) && isOpen(p)) p.style.setProperty('--ams-motion-h', '9999px');
      p = p.parentElement;
    }
  }

  function measureAll() {
    var list = document.querySelectorAll(GROUPS), i;
    for (i = 0; i < list.length; i++) measure(list[i]);
  }

  function watchNav() {
    var navs = document.querySelectorAll('.sidebar, .rail, .appbar'), i;
    if (!navs.length) return;
    var mo = new MutationObserver(function (records) {
      for (var r = 0; r < records.length; r++) {
        var t = records[r].target;
        if (t.matches && t.matches(GROUPS) && isOpen(t)) { measure(t); relaxAncestors(t); }
      }
    });
    for (i = 0; i < navs.length; i++) {
      mo.observe(navs[i], { attributes: true, attributeFilter: ['class'], subtree: true });
    }
    measureAll();
    var rt = null;
    window.addEventListener('resize', function () {   /* label wrapping can change with width */
      clearTimeout(rt);
      rt = setTimeout(measureAll, 150);
    });
  }

  /* ---- 3. busy buttons ---- */
  var BUSY = /(\u2026|\.{3})\s*$/;

  function syncButton(b) {
    if (!b || !b.classList || !b.classList.contains('btn')) return;
    var busy = !!b.disabled && BUSY.test((b.textContent || '').replace(/\s+$/, ''));
    if (busy) {
      b.classList.add('is-loading');
      b.setAttribute('aria-busy', 'true');
      b._amsAuto = true;
    } else if (b._amsAuto) {
      b.classList.remove('is-loading');
      b.removeAttribute('aria-busy');
      b._amsAuto = false;
    }
  }

  function watchButtons() {
    if (!document.body) return;
    new MutationObserver(function (records) {
      for (var r = 0; r < records.length; r++) syncButton(records[r].target);
    }).observe(document.body, { attributes: true, attributeFilter: ['disabled'], subtree: true });
  }

  /* ---- 4. click-origin navigation ---- */
  var KEY = 'ams_from';
  function motionOff() {
    return root.classList.contains('ds-lite') ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function bar(cls) {
    var b = document.getElementById('ams-motion-bar');
    if (!b) { b = document.createElement('div'); b.id = 'ams-motion-bar'; b.className = 'ams-motion-bar'; document.body.appendChild(b); }
    b.className = 'ams-motion-bar ' + cls;
    if (cls === 'done') setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 600);
  }
  function applyOrigin(x, y) {
    root.style.setProperty('--ams-motion-ox', x + 'px');
    root.style.setProperty('--ams-motion-oy', y + 'px');
    root.classList.add('ams-motion-from');
    setTimeout(function () { root.classList.remove('ams-motion-from'); }, 800);
  }
  function watchClicks() {
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || motionOff()) return;
      var t = e.target; if (!t || !t.closest) return;
      var a = t.closest('a[href]');
      var card = t.closest('.stat-card, .dash-metric, .ams-ui-card, .ams-ui-wcard, .card[onclick], [data-page]');
      var x = Math.round(e.clientX), y = Math.round(e.clientY);
      if (a) {
        var h = a.getAttribute('href') || '';
        if (!h || h.charAt(0) === '#' || a.target === '_blank' || a.hasAttribute('download') ||
            /^(javascript|mailto|tel):/i.test(h) || (a.origin && a.origin !== location.origin)) return;
        try { sessionStorage.setItem(KEY, JSON.stringify({ x: x, y: y, t: Date.now() })); } catch (err) {}
        bar('go');
      } else if (card) {
        applyOrigin(x, y);            /* in-page navigation: grow from the card right now */
      }
    }, true);
    window.addEventListener('pageshow', function (ev) {   /* back/forward cache: drop a stale bar */
      var b = document.getElementById('ams-motion-bar'); if (b && ev.persisted && b.parentNode) b.parentNode.removeChild(b);
    });
  }
  function arrive() {
    var raw = null, d = null;
    try { raw = sessionStorage.getItem(KEY); sessionStorage.removeItem(KEY); } catch (err) {}
    if (!raw || motionOff()) return;
    try { d = JSON.parse(raw); } catch (err) { return; }
    if (!d || Date.now() - d.t > 5000) return;
    applyOrigin(d.x, d.y);
    bar('done');
  }

  function start() { watchNav(); watchButtons(); watchClicks(); arrive(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
