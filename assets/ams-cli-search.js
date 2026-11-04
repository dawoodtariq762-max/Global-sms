/* GLOBAL SMS — GLOBAL-style CLI Search (shared by admin/manager/agent/client).
 * "See which ranges a sender has been running on in the last 24 hours."
 * Presentation only: one read-only GET /api/cli-search/ranges-24h with the
 * full sender typed by the user (+ optional message text). The endpoint is
 * role-scoped on the server; this module never widens it. One instance per
 * panel page, fixed element ids (amsCli*). Global entry points used by the
 * inline onclick handlers in the panel markup: searchAmsCli(),
 * amsCliPage('first'|'prev'|'next'|'last'), renderAmsCliRanges(). */
(function () {
  'use strict';
  var rows = [];
  var page = 1;
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function el(id) { return document.getElementById(id); }
  function perPage() { var s = el('amsCliPerPage'); var n = s ? parseInt(s.value, 10) : 25; return Number.isFinite(n) && n > 0 ? n : Math.max(rows.length, 1); }

  window.renderAmsCliRanges = function () {
    var body = el('amsCliBody'); if (!body) return;
    var n = perPage();
    var pages = Math.max(1, Math.ceil(rows.length / n));
    if (page > pages) page = pages;
    var start = (page - 1) * n;
    var slice = rows.slice(start, start + n);
    body.innerHTML = slice.map(function (r) {
      return '<tr><td>' + esc(r.range_name || 'Unknown') + '</td><td class="mono">' + esc(r.last_seen ? String(r.last_seen).slice(0, 19) + ' UTC' : '—') + '</td></tr>';
    }).join('') || '<tr><td colspan="2" class="muted" style="text-align:center;padding:26px">No data available in table.</td></tr>';
    var info = el('amsCliInfo');
    if (info) info.textContent = 'Showing ' + (rows.length ? (start + 1) : 0) + ' to ' + (start + slice.length) + ' of ' + rows.length + ' entries';
    var cur = el('amsCliPageCur'); if (cur) cur.textContent = String(page);
    ['First', 'Prev'].forEach(function (k) { var b = el('amsCliBtn' + k); if (b) b.disabled = page <= 1; });
    ['Next', 'Last'].forEach(function (k) { var b = el('amsCliBtn' + k); if (b) b.disabled = page >= pages; });
  };

  window.amsCliPage = function (dir) {
    var pages = Math.max(1, Math.ceil(rows.length / perPage()));
    if (dir === 'first') page = 1;
    else if (dir === 'prev') page = Math.max(1, page - 1);
    else if (dir === 'next') page = Math.min(pages, page + 1);
    else if (dir === 'last') page = pages;
    window.renderAmsCliRanges();
  };

  window.searchAmsCli = async function () {
    var sender = (el('amsCliSender') && el('amsCliSender').value || '').trim();
    var body = el('amsCliBody');
    if (!sender) { alert('Please type the full sender (CLI).'); return; }
    var msg = (el('amsCliMessage') && el('amsCliMessage').value || '').trim();
    var url = '/cli-search/ranges-24h?cli=' + encodeURIComponent(sender) + (msg ? '&message=' + encodeURIComponent(msg) : '');
    if (body) body.innerHTML = '<tr><td colspan="2" class="muted" style="text-align:center;padding:26px">Searching…</td></tr>';
    try {
      var r = await window.API.get(url);
      rows = Array.isArray(r && r.ranges) ? r.ranges : [];
      page = 1;
      window.renderAmsCliRanges();
    } catch (e) {
      rows = [];
      window.renderAmsCliRanges();
      if (body) body.innerHTML = '<tr><td colspan="2" style="text-align:center;padding:26px">⚠ Search failed: ' + esc(e && e.message || 'Request failed') + '</td></tr>';
    }
  };
})();
