/* Per-number copy control for the existing SMS Numbers tables (Admin, Manager, Agent, Client).
   Frontend presentation only: reads the number already rendered in the row, never changes
   number data, filters, permissions, allocation or any API. No network requests are made. */
(function () {
  'use strict';
  var TABLES = ['numBody', 'numbersBody'];
  var MAX_ROWS = 20000;
  var GLYPH_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var GLYPH_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
  var live = null;
  function liveRegion() {
    if (live && live.isConnected) return live;
    live = document.createElement('div');
    live.className = 'ams-copy-live';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);
    return live;
  }
  function announce(text) {
    try { liveRegion().textContent = text; } catch (e) {}
    try { clearTimeout(announce._t); announce._t = setTimeout(function () { if (live) live.textContent = ''; }, 1600); } catch (e) {}
  }
  // Only for clipboards that are unavailable (non-secure context / older browser).
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function digitsOf(text) { return (String(text).match(/\d/g) || []).length; }
  // Locates the number cell inside an existing row. Returns {number, host} or null.
  // Reads only what the existing renderer already printed; nothing is recalculated.
  function findNumber(row) {
    var cell = row.querySelector('td.ams-num');
    if (!cell) {
      var cells = row.querySelectorAll('td');
      for (var i = 0; i < cells.length; i++) {
        if (cells[i].querySelector('button,input,a,select')) continue;
        var probe = (cells[i].textContent || '').trim();
        if (/^\+?[0-9][0-9\s()+.-]*$/.test(probe) && digitsOf(probe) >= 7) { cell = cells[i]; break; }
      }
    }
    if (!cell) return null;
    var source = cell.querySelector('b') || cell;
    var raw = String(source.textContent || '').trim();
    if (!/^\+?[0-9][0-9\s()+.-]*$/.test(raw) || digitsOf(raw) < 7) return null;
    return { number: raw, host: cell };
  }
  function makeButton(number) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ams-copy-inline';
    btn.dataset.copy = number;
    btn.title = 'Copy number';
    btn.setAttribute('aria-label', 'Copy number ' + number);
    btn.innerHTML = GLYPH_COPY;
    return btn;
  }
  function decorate() {
    for (var t = 0; t < TABLES.length; t++) {
      var body = document.getElementById(TABLES[t]);
      if (!body) continue;
      var rows = body.rows || [];
      var limit = Math.min(rows.length, MAX_ROWS);
      for (var i = 0; i < limit; i++) {
        var row = rows[i];
        if (!row || row.dataset.amsCopyDone === '1') continue;
        var found = findNumber(row);
        if (!found) continue;
        found.host.appendChild(makeButton(found.number));
        row.dataset.amsCopyDone = '1';
      }
    }
  }
  function onClick(event) {
    var btn = event.target && event.target.closest ? event.target.closest('.ams-copy-inline') : null;
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    var number = btn.dataset.copy || '';
    if (!number) return;
    writeClipboard(number).then(function (ok) {
      if (!ok) { announce('Copy failed. Select the number and copy manually.'); return; }
      btn.classList.add('is-copied');
      btn.innerHTML = GLYPH_DONE;
      btn.title = 'Copied';
      btn.setAttribute('aria-label', 'Copied number ' + number);
      announce('Number copied: ' + number);
      clearTimeout(btn._amsCopyTimer);
      btn._amsCopyTimer = setTimeout(function () {
        btn.classList.remove('is-copied');
        btn.innerHTML = GLYPH_COPY;
        btn.title = 'Copy number';
        btn.setAttribute('aria-label', 'Copy number ' + number);
      }, 1300);
    });
  }
  function start() {
    document.addEventListener('click', onClick, true);
    var scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () { scheduled = false; try { decorate(); } catch (e) {} }, 120);
    }
    if (window.MutationObserver) {
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    }
    decorate();
    liveRegion();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
