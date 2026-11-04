/* ==========================================================================
   GLOBAL SMS — LOGIN DESIGN v2 "Clean Centered"
   assets/qtech-login-anim.js

   Shared by login.html and the four portal logins. Only ADDS decoration and
   toggles classes on <html>; it never touches form values, submit handlers,
   fetch calls or routes. Pairs with assets/qtech-login-anim.css.
   ========================================================================== */
(function () {
  'use strict';

  var KEY = 'qtech_login_anim';
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
    return !prefersReduced();
  }
  function animOn() { return root.classList.contains('qtech-anim-on'); }

  /* 1. background glows */
  function buildLayer() {
    if (document.querySelector('.qtech-login-bg')) return;
    var wrap = document.createElement('div');
    wrap.className = 'qtech-login-bg';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML = '<span class="qlb-a"></span><span class="qlb-b"></span>';
    document.body.insertBefore(wrap, document.body.firstChild);
  }

  /* 2. logo: an uploaded branding logo always wins over the default */
  function brandLogoUrl() {
    try {
      var b = window.QTECH_BRAND;
      if (b && b.assets && b.assets.logo) return b.assets.logo;
    } catch (e) {}
    return '';
  }
  function brandLabel() {
    try { if (window.QTECH_BRAND && window.QTECH_BRAND.panelName) return window.QTECH_BRAND.panelName; } catch (e) {}
    return 'GLOBAL SMS';
  }
  function brandLogos() {
    var custom = brandLogoUrl();
    var imgs = document.querySelectorAll('img[data-brand-logo]');
    for (var i = 0; i < imgs.length; i++) {
      if (custom && imgs[i].getAttribute('src') !== custom) imgs[i].setAttribute('src', custom);
      imgs[i].setAttribute('alt', brandLabel());
    }
  }

  /* 3. feedback: shake on error, ripple on button, captcha refresh spin */
  function findCard() {
    var kids = document.body ? document.body.children : [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.classList && (el.classList.contains('shell') || el.classList.contains('card'))) return el;
    }
    return null;
  }
  function feedbackFx() {
    var card = findCard();
    if (!card) return;
    var form = card.querySelector('form');
    var btn = card.querySelector('form > .btn, form button[type=submit], form button:not([type=button])');

    function fire(el, cls) {
      if (!el) return;
      el.classList.remove(cls);
      void el.offsetWidth;
      el.classList.add(cls);
    }
    function clearOnEnd(el, cls) {
      el.addEventListener('animationend', function (e) {
        if (e.target === el || e.target.parentNode === el) el.classList.remove(cls);
      });
    }
    if (form) clearOnEnd(form, 'qt-shake');

    if (btn) {
      btn.addEventListener('pointerdown', function (e) {
        if (!animOn() || (e.button && e.button !== 0)) return;
        var r = btn.getBoundingClientRect();
        var d = document.createElement('span');
        d.className = 'qt-ripple';
        d.setAttribute('aria-hidden', 'true');
        d.style.left = (e.clientX - r.left) + 'px';
        d.style.top = (e.clientY - r.top) + 'px';
        d.addEventListener('animationend', function () { if (d.parentNode) d.parentNode.removeChild(d); });
        btn.appendChild(d);
      }, { passive: true });
    }

    var refresh = card.querySelector('.refresh-btn');
    if (refresh) {
      refresh.addEventListener('click', function () { if (animOn()) fire(refresh, 'qt-spin'); });
      clearOnEnd(refresh, 'qt-spin');
    }

    var msg = card.querySelector('#msg, .msg');
    if (msg && window.MutationObserver) {
      var last = '';
      new MutationObserver(function () {
        var txt = msg.textContent || '';
        var cls = msg.className || '';
        var key = cls + '|' + txt;
        if (key === last) return;
        last = key;
        var busy = txt.indexOf('⏳') === 0 || /^(Signing in|Checking)/.test(txt);
        var err = /\b(error|err)\b/.test(cls);
        if (btn) btn.classList.toggle('qt-busy', busy);
        if (animOn() && err) fire(form, 'qt-shake');
      }).observe(msg, { attributes: true, childList: true, characterData: true, subtree: true });
    }
  }

  /* 4. animation toggle */
  function buildToggle(onChange) {
    var id = 'loginAnimToggle';
    if (document.getElementById(id)) return;
    var wrap = document.createElement('div');
    wrap.className = 'login-anim-toggle';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Login animations');
    wrap.innerHTML =
      '<label class="login-anim-label" for="' + id + '" id="loginAnimLabel">Animations</label>' +
      '<input type="checkbox" id="' + id + '" class="login-anim-switch" role="switch" aria-labelledby="loginAnimLabel" />' +
      '<span class="login-anim-state" id="loginAnimState" aria-hidden="true">On</span>';
    document.body.insertBefore(wrap, document.body.firstChild);
    var input = document.getElementById(id);
    input.addEventListener('change', function () { onChange(input.checked); });
  }

  function apply(on, persist) {
    root.classList.toggle('qtech-anim-on', !!on);
    root.classList.toggle('qtech-anim-off', !on);
    var input = document.getElementById('loginAnimToggle');
    if (input) input.checked = !!on;
    var st = document.getElementById('loginAnimState');
    if (st) st.textContent = on ? 'On' : 'Off';
    if (persist) writeStored(on ? 'on' : 'off');
  }

  function init() {
    if (!document.body) return;
    buildLayer();
    brandLogos();
    /* QTECH_BRAND may arrive after this file: re-apply so an uploaded logo wins */
    window.QTLoginBrandRefresh = function () { try { brandLogos(); } catch (e) {} };
    window.addEventListener('load', function () { try { brandLogos(); } catch (e) {} });
    feedbackFx();
    buildToggle(function (on) { apply(on, true); });
    apply(shouldAnimate(), false);

    try {
      document.addEventListener('visibilitychange', function () {
        root.classList.toggle('qtech-anim-paused', document.visibilityState === 'hidden');
      });
    } catch (e) {}

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
