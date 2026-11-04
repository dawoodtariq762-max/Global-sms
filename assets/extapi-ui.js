/**
 * assets/extapi-ui.js — REST API section for the Manager, Agent and Admin panels.
 *
 *   Manager / Agent (spec 2B): create -> activate -> copy -> regenerate /
 *   deactivate / revoke. Access is never enabled implicitly.
 *   Admin (spec 2C): monitors which accounts have API access and can revoke or
 *   deactivate any of them. Tokens are never displayed after creation.
 *
 * The plaintext token is shown exactly once, at creation or regeneration.
 */
(function () {
  'use strict';

  var TOKEN = null;
  var IS_ADMIN = (function () {
    try { return (sessionStorage.getItem('ams_role') || localStorage.getItem('ams_role') || '') === 'admin'; }
    catch (e) { return false; }
  })();
  function tk() {
    if (TOKEN) return TOKEN;
    TOKEN = sessionStorage.getItem('ams_token') || localStorage.getItem('ams_token') || '';
    return TOKEN;
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers.Authorization = 'Bearer ' + tk();
    if (opts.body && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function el(id) { return document.getElementById(id); }
  function copy(text, btn) {
    var done = function () {
      if (!btn) return;
      var old = btn.textContent; btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = old; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
    } else fallback(text, done);
  }
  function fallback(text, done) {
    try {
      var t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      document.execCommand('copy'); t.remove(); done();
    } catch (e) { window.prompt('Copy this value:', text); }
  }

  var CSS = ''
    + '<style>'
    + '.apiwrap{max-width:920px;}'
    + '.apicard{border:1px solid var(--border);border-radius:14px;background:var(--panel);padding:18px;margin-bottom:16px;}'
    + '.apicard h3{margin:0 0 4px;font-size:15px;}'
    + '.apicard .sub{color:var(--text-muted);font-size:12.5px;margin-bottom:14px;}'
    + '.apirow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;}'
    + '.apilbl{width:120px;flex-shrink:0;font-size:12.5px;color:var(--text-muted);font-weight:600;}'
    + '.apival{flex:1;min-width:200px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;'
    + ' background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;word-break:break-all;}'
    + '.apibtn{border:1px solid var(--border);background:var(--panel2);color:var(--text);border-radius:9px;'
    + ' padding:8px 13px;font-size:13px;font-weight:600;cursor:pointer;}'
    + '.apibtn:hover{background:var(--bg2);}'
    + '.apibtn.primary{background:var(--accent);border-color:var(--accent);color:#fff;}'
    + '.apibtn.danger{background:var(--danger);border-color:var(--danger);color:#fff;}'
    + '.apibtn:disabled{opacity:.55;cursor:not-allowed;}'
    + '.apistatus{display:inline-flex;align-items:center;gap:6px;font-weight:700;font-size:12.5px;'
    + ' padding:4px 11px;border-radius:20px;border:1px solid var(--border);background:var(--bg2);}'
    + '.apistatus.active{color:#0a7d3f;background:rgba(10,125,63,.12);border-color:rgba(10,125,63,.3);}'
    + '.apistatus.inactive{color:#8a6d00;background:rgba(180,140,0,.12);border-color:rgba(180,140,0,.3);}'
    + '.apistatus.revoked{color:var(--danger);background:rgba(220,38,38,.12);border-color:rgba(220,38,38,.3);}'
    + '.apistatus.not_created{color:var(--text-muted);}'
    + '.apinote{font-size:12px;color:var(--text-muted);margin-top:10px;line-height:1.55;}'
    + '.apitable{width:100%;border-collapse:collapse;font-size:13px;}'
    + '.apitable th,.apitable td{border-bottom:1px solid var(--border);padding:9px 10px;text-align:left;}'
    + '.apitable th{font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);}'
    + '.apierr{background:rgba(220,38,38,.1);border:1px solid var(--danger);color:var(--danger);'
    + ' padding:9px 12px;border-radius:9px;font-size:13px;margin-bottom:12px;display:none;}'
    + '.apimsg{background:rgba(10,125,63,.1);border:1px solid rgba(10,125,63,.35);color:#0a7d3f;'
    + ' padding:9px 12px;border-radius:9px;font-size:13px;margin-bottom:12px;display:none;}'
    /* ---- numbered section headers (six clearly separated areas) ---- */
    + '.apihead{display:flex;gap:12px;align-items:flex-start;margin-bottom:14px;}'
    + '.apinum{flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;'
    + ' font-size:12px;font-weight:800;background:var(--accent);color:#fff;margin-top:1px;}'
    + '.apihead h3{margin:0 0 3px;font-size:15px;}'
    + '.apihead .sub{margin-bottom:0;}'
    /* ---- warnings ---- */
    + '.apiwarn{margin-top:12px;padding:10px 12px;border-radius:9px;font-size:12.5px;line-height:1.55;'
    + ' background:rgba(180,140,0,.10);border:1px solid rgba(180,140,0,.35);color:#8a6d00;}'
    + 'body.ams-dark .apiwarn{background:rgba(250,204,21,.10);border-color:rgba(250,204,21,.30);color:#facc15;}'
    /* ---- code + json viewer ---- */
    + '.apicode,.apijson{margin:10px 0 0;padding:12px 14px;border-radius:10px;overflow:auto;'
    + ' max-height:340px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;'
    + ' background:var(--bg2);border:1px solid var(--border);color:var(--text);white-space:pre;tab-size:2;}'
    + '.apicode{margin-top:4px;color:var(--text-muted);}'
    + '.apiempty{color:var(--text-muted);font-style:italic;}'
    + '.jkey{color:#0b43be;} .jstr{color:#0a7d3f;} .jnum{color:#b45309;} .jbool{color:#155eef;}'
    + 'body.ams-dark .jkey{color:#a9c2ff;} body.ams-dark .jstr{color:#86efac;}'
    + 'body.ams-dark .jnum{color:#fcd34d;} body.ams-dark .jbool{color:#93c5fd;}'
    /* ---- filters ---- */
    + '.apifilters{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;}'
    + '.apifield{display:flex;flex-direction:column;gap:5px;}'
    + '.apifield label{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);}'
    + '.apifield input,.apifield select{height:36px;padding:0 10px;border-radius:9px;'
    + ' border:1px solid var(--border);background:var(--panel);color:var(--text);font-size:13px;font-family:inherit;}'
    + '.apifield input:focus-visible,.apifield select:focus-visible{outline:none;'
    + ' box-shadow:0 0 0 3px rgba(91,140,255,.35);border-color:var(--accent);}'
    + '.apifield-btn{padding-bottom:1px;}'
    /* ---- preview meta + loading ---- */
    + '.apimeta{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;min-height:0;}'
    + '.apipill{font-size:11.5px;padding:4px 10px;border-radius:20px;background:var(--bg2);'
    + ' border:1px solid var(--border);color:var(--text-muted);}'
    + '.apipill b{color:var(--text);}'
    + '.apiloading{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--text-muted);padding:6px 0 10px;}'
    + '.apispin{width:15px;height:15px;border-radius:50%;border:2px solid var(--border);'
    + ' border-top-color:var(--accent);animation:apispin .7s linear infinite;flex:none;}'
    + '@keyframes apispin{to{transform:rotate(360deg)}}'
    + '@media(prefers-reduced-motion:reduce){.apispin{animation-duration:2s}}'
    /* ---- admin base-url config ---- */
    + '.apiconfig{margin-top:16px;padding-top:14px;border-top:1px dashed var(--border);}'
    + '.apiconfig>label{display:block;font-size:11.5px;font-weight:700;text-transform:uppercase;'
    + ' letter-spacing:.4px;color:var(--text-muted);margin-bottom:7px;}'
    + '.apiconfigrow{display:flex;gap:9px;flex-wrap:wrap;}'
    + '.apiconfigrow input{flex:1;min-width:240px;height:36px;padding:0 10px;border-radius:9px;'
    + ' border:1px solid var(--border);background:var(--panel);color:var(--text);font-size:13px;}'
    /* ---- primary endpoint block ---- */
    + '.apiendpoint{display:flex;gap:10px;align-items:center;flex-wrap:wrap;'
    + ' padding:14px;border-radius:11px;border:1px solid var(--accent);'
    + ' background:var(--bg2);}'
    + '.apiendpoint-url{flex:1;min-width:240px;word-break:break-all;'
    + ' font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;font-weight:600;color:var(--text);}'
    + 'body.ams-dark .apiendpoint{border-color:var(--accent);}'
    /* ---- collapsible secondary detail ---- */
    + '.apidetails{margin-top:14px;border-top:1px dashed var(--border);padding-top:12px;}'
    + '.apidetails>summary{cursor:pointer;font-size:12.5px;font-weight:700;color:var(--text-muted);'
    + ' text-transform:uppercase;letter-spacing:.4px;list-style:none;display:flex;align-items:center;gap:7px;}'
    + '.apidetails>summary::-webkit-details-marker{display:none;}'
    + '.apidetails>summary::before{content:"\\25B8";font-size:11px;transition:transform .18s ease;display:inline-block;}'
    + '.apidetails[open]>summary::before{transform:rotate(90deg);}'
    + '@media(prefers-reduced-motion:reduce){.apidetails>summary::before{transition:none}}'
    + '.apidetails>summary:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(91,140,255,.35);border-radius:6px;}'
    /* ---- test-token chooser ---- */
    + '.apitestrow{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;}'
    + '.apitestopt{flex:1;min-width:230px;display:flex;gap:9px;align-items:flex-start;cursor:pointer;'
    + ' padding:11px 13px;border:1px solid var(--border);border-radius:11px;background:var(--panel2);}'
    + '.apitestopt:has(input:checked){border-color:var(--accent);background:var(--bg2);}'
    + '.apitestopt input{margin-top:2px;flex:none;accent-color:var(--accent);}'
    + '.apitestopt span{display:flex;flex-direction:column;gap:2px;}'
    + '.apitestopt b{font-size:13px;}'
    + '.apitestopt em{font-style:normal;font-size:11.5px;color:var(--text-muted);}'
    + '.apitestopt input:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(91,140,255,.35);border-radius:4px;}'
    /* ---- responsive ---- */
    + '@media(max-width:640px){'
    + ' .apilbl{width:100%;}'
    + ' .apifilters{flex-direction:column;align-items:stretch;}'
    + ' .apifield-btn button{width:100%;}'
    + ' .apiendpoint-url{min-width:100%;}'
    + ' .apitestopt{min-width:100%;}'
    + '}'
    + '</style>';

  /* ==================================================================
   * SELF-SERVICE PANEL (Manager / Agent / Admin)
   * ------------------------------------------------------------------
   * Six clearly separated areas, in the order the user works through them:
   *   1. Status + token
   *   2. Base URL + endpoint
   *   3. Authentication
   *   4. Filters
   *   5. JSON preview
   *   6. Copy + test actions
   *
   * The preview calls the real server-side query with the user's own session
   * and the user's own data scope. It never fabricates sample records and it
   * never sends a request on every keystroke — only on an explicit Preview.
   * ================================================================== */
  var LIMIT_CHOICES = [10, 25, 50, 100, 250];

  /* ==================================================================
   * SELF-SERVICE PANEL (Manager / Agent / Admin)
   * ------------------------------------------------------------------
   * Four areas, ordered the way the user actually works:
   *   1. Ready-to-use endpoint   — the one URL they need, with Copy
   *   2. API token & access      — status, activate/revoke, reveal + copy
   *   3. Test the API            — runs against the real endpoint; the user
   *                                never has to paste a token they own
   *   4. Integration example     — real endpoint, real auth header, real
   *                                place for the token to go
   *
   * Base URL / path are secondary detail, tucked into a disclosure. The
   * panel never invents a domain: everything comes from what the server
   * reports, and when that is unset it says so once, plainly.
   * ================================================================== */
  function renderSelf(root) {
    root.innerHTML = CSS
      + '<div class="apiwrap">'
      +   '<div class="apierr" id="apiErr"></div><div class="apimsg" id="apiMsg"></div>'

      /* ---- 1. READY-TO-USE ENDPOINT (primary) ---- */
      +   '<section class="apicard">'
      +     '<div class="apihead"><span class="apinum">1</span><div>'
      +       '<h3>Your API endpoint</h3>'
      +       '<div class="sub">This is the address your integration calls. Copy it as it is.</div>'
      +     '</div></div>'
      +     '<div id="apiUrlBody"><div class="apinote">Loading…</div></div>'
      +   '</section>'

      /* ---- 2. TOKEN + STATUS ---- */
      +   '<section class="apicard">'
      +     '<div class="apihead"><span class="apinum">2</span><div>'
      +       '<h3>API token &amp; access</h3>'
      +       '<div class="sub">Your credential is personal to this account. Nobody else’s token is ever shown here.</div>'
      +     '</div></div>'
      +     '<div id="apiBody"><div class="apinote">Loading…</div></div>'
      +   '</section>'

      /* ---- 3. TEST ---- */
      +   '<section class="apicard">'
      +     '<div class="apihead"><span class="apinum">3</span><div>'
      +       '<h3>Test the API</h3>'
      +       '<div class="sub">Sends a real request to the endpoint above and shows exactly what comes back.</div>'
      +     '</div></div>'
      +     '<div class="apitestrow" role="radiogroup" aria-label="Which token to test with">'
      +       '<label class="apitestopt"><input type="radio" name="apiTokenSrc" value="mine" id="apiSrcMine" checked>'
      +         '<span><b>My active token</b><em>Applies automatically — you never paste it</em></span></label>'
      +       '<label class="apitestopt"><input type="radio" name="apiTokenSrc" value="pasted" id="apiSrcPasted">'
      +         '<span><b>A different token</b><em>Paste one you created elsewhere</em></span></label>'
      +     '</div>'
      +     '<div class="apifield" id="apiPasteWrap" style="display:none;margin-bottom:12px">'
      +       '<label for="apiPaste">Token</label>'
      +       '<input type="password" id="apiPaste" placeholder="amsk_…" autocomplete="off" spellcheck="false">'
      +     '</div>'
      +     '<div class="apifilters" style="margin-bottom:14px">'
      +       '<div class="apifield"><label for="apiFrom">From</label>'
      +         '<input type="datetime-local" id="apiFrom" step="60"></div>'
      +       '<div class="apifield"><label for="apiTo">To</label>'
      +         '<input type="datetime-local" id="apiTo" step="60"></div>'
      +       '<div class="apifield"><label for="apiLimit">Records</label>'
      +         '<select id="apiLimit">'
      +           LIMIT_CHOICES.map(function (n) { return '<option value="' + n + '"' + (n === 10 ? ' selected' : '') + '>' + n + '</option>'; }).join('')
      +         '</select></div>'
      +     '</div>'
      +     '<div class="apirow">'
      +       '<button class="apibtn primary" id="apiRunTest">Run test</button>'
      +       '<span class="apinote" id="apiTestHint" style="margin:0"></span>'
      +     '</div>'
      +     '<div id="apiTestResult" style="display:none;margin-top:14px">'
      +       '<div class="apimeta" id="apiTestMeta"></div>'
      +       '<div class="apiloading" id="apiTestLoading" style="display:none">'
      +         '<span class="apispin"></span> Sending request…</div>'
      +       '<div class="apierr" id="apiTestErr" style="display:none"></div>'
      +       '<pre class="apijson" id="apiTestJson"></pre>'
      +       '<div class="apirow" id="apiTestActions" style="display:none;margin-top:12px">'
      +         '<button class="apibtn" id="apiCopyResponse">Copy response</button>'
      +         '<button class="apibtn" id="apiDownload">Download .json</button>'
      +       '</div>'
      +     '</div>'
      +   '</section>'

      /* ---- 4. INTEGRATION EXAMPLE ---- */
      +   '<section class="apicard">'
      +     '<div class="apihead"><span class="apinum">4</span><div>'
      +       '<h3>Integration example</h3>'
      +       '<div class="sub">A working Telegram bot command that calls this endpoint.</div>'
      +     '</div></div>'
      +     '<div class="apirow" style="margin-bottom:6px">'
      +       '<button class="apibtn" id="apiCopyExample">Copy example</button>'
      +     '</div>'
      +     '<pre class="apicode" id="apiExample"></pre>'
      +     '<div class="apinote" id="apiFields"></div>'
      +   '</section>'
      + '</div>';

    var body = el('apiBody');
    var urlBody = el('apiUrlBody');
    var errBox = el('apiErr'), msgBox = el('apiMsg');
    var lastResponse = null;
    var lastEndpoint = '';
    var lastBase = '';
    var baseConfigured = false;
    /* The plaintext of a token created during this page session. Held in
       memory only — never written to storage — so the test can apply it
       without the user pasting anything. Cleared when they dismiss it. */
    var sessionToken = '';

    function err(m) { errBox.textContent = m; errBox.style.display = 'block'; msgBox.style.display = 'none'; }
    function msg(m) { msgBox.textContent = m; msgBox.style.display = 'block'; errBox.style.display = 'none'; }
    function clearErr() { errBox.style.display = 'none'; msgBox.style.display = 'none'; }

    /* ---------- 2. token + status ---------- */
    function paint(s) {
      var badge = '<span class="apistatus ' + esc(s.status) + '">' + esc(String(s.status).replace(/_/g, ' ')) + '</span>';
      var html = '<div class="apirow"><span class="apilbl">Status</span><div>' + badge + '</div></div>';

      if (s.exists) {
        var known = sessionToken ? sessionToken : '';
        html += '<div class="apirow"><span class="apilbl">Token</span>'
          + '<span class="apival" id="apiTokVal">' + esc(known ? mask(known) : (s.token_prefix || '') + maskTail()) + '</span>'
          + (known
              ? '<button class="apibtn" id="apiTokReveal">Show</button><button class="apibtn" id="apiTokCopy">Copy</button>'
              : '<button class="apibtn" id="apiCopyPrefix">Copy prefix</button>')
          + '</div>';
        html += '<div class="apirow"><span class="apilbl">Created</span><span class="apival">' + esc(s.created_at || '—') + '</span></div>';
        html += '<div class="apirow"><span class="apilbl">Activated</span><span class="apival">' + esc(s.activated_at || '—') + '</span></div>';
        html += '<div class="apirow"><span class="apilbl">Last used</span><span class="apival">' + esc(s.last_used_at || 'never') + '</span></div>';
        if (!known) {
          html += '<div class="apinote">For your security the full token is shown only when it is first created. '
                + 'You can still test it above without pasting it.</div>';
        }
      } else {
        html += '<div class="apinote">You have not created an API token yet.</div>';
      }

      html += '<div class="apirow" style="margin-top:16px">';
      if (!s.exists || s.status === 'revoked') {
        html += '<button class="apibtn primary" id="apiCreate">'
          + (s.status === 'revoked' ? 'Create a new API token' : 'Create API token') + '</button>';
      } else {
        if (s.status === 'active') html += '<button class="apibtn" id="apiDeact">Deactivate</button>';
        else html += '<button class="apibtn primary" id="apiAct">Activate</button>';
        html += '<button class="apibtn" id="apiRegen">Regenerate</button>';
        html += '<button class="apibtn danger" id="apiRevoke">Revoke</button>';
      }
      html += '</div>';

      if (s.exists && s.status === 'inactive') {
        html += '<div class="apinote">Your token exists but is <b>not active</b>. It will not work until you activate it.</div>';
      }
      body.innerHTML = html;

      var cp = el('apiCopyPrefix');
      if (cp) cp.onclick = function () { copy(String(s.token_prefix || ''), cp); };
      var rv = el('apiTokReveal'), tc = el('apiTokCopy');
      if (rv) rv.onclick = function () {
        var v = el('apiTokVal'), showing = v.getAttribute('data-plain') === '1';
        if (showing) { v.textContent = mask(sessionToken); v.setAttribute('data-plain', '0'); rv.textContent = 'Show'; }
        else { v.textContent = sessionToken; v.setAttribute('data-plain', '1'); rv.textContent = 'Hide'; }
      };
      if (tc) tc.onclick = function () { copy(sessionToken, tc); };
      wire(s);
    }

    function mask(t) { return t.slice(0, 8) + '••••••••••••••••' + t.slice(-4); }
    function maskTail() { return '••••••••••••••••'; }

    /* Each handler must capture its OWN button — a single shared `var` would
     * end up holding the last element (or null) by the time the handler runs. */
    function wire(s) {
      var create = el('apiCreate');
      if (create) create.onclick = function () {
        create.disabled = true;
        api('/api/extapi/me/create', { method: 'POST', body: {} })
          .then(function (r) { sessionToken = r.token || ''; paint2(r, 'Token created. Copy it now — it will not be shown again.'); })
          .catch(function (e) { err(e.message); if (create.isConnected) create.disabled = false; });
      };

      var act = el('apiAct');
      if (act) act.onclick = function () { run('/api/extapi/me/activate', 'API access activated. Your token works now.', act); };

      var deact = el('apiDeact');
      if (deact) deact.onclick = function () {
        run('/api/extapi/me/deactivate', 'API access deactivated. Your token stopped working immediately.', deact);
      };

      var revoke = el('apiRevoke');
      if (revoke) revoke.onclick = function () {
        if (!confirm('Revoke this API token? Any integration using it will stop working. This cannot be undone — you will need to create a new token.')) return;
        run('/api/extapi/me/revoke', 'Token revoked. The old token no longer works.', revoke);
      };

      var regen = el('apiRegen');
      if (regen) regen.onclick = function () {
        if (!confirm('Regenerate? Your current token stops working immediately and the new one starts inactive.')) return;
        regen.disabled = true;
        api('/api/extapi/me/regenerate', { method: 'POST', body: {} })
          .then(function (r) { sessionToken = r.token || ''; paint2(r, 'New token issued. The previous one stopped working immediately. Copy this now — activate it before use.'); })
          .catch(function (e) { err(e.message); if (regen.isConnected) regen.disabled = false; });
      };
    }

    function run(path, message, btn) {
      if (btn) btn.disabled = true;
      api(path, { method: 'POST', body: {} })
        .then(function () { msg(message); load(); })
        .catch(function (e) { err(e.message); if (btn && btn.isConnected) btn.disabled = false; });
    }

    /* The token stays on screen until the user dismisses it — reloading straight
       away would wipe the only chance they get to copy it. */
    function paint2(r, message) {
      var token = r.token || '';
      var html = '<div class="apinote" style="color:#0a7d3f;font-weight:600">' + esc(message) + '</div>';
      html += '<div class="apirow" style="margin-top:10px"><span class="apilbl">Your token</span>'
        + '<span class="apival" id="apiTokenVal">' + esc(token) + '</span>'
        + '<button class="apibtn primary" id="apiCopyTok">Copy token</button>'
        + '<button class="apibtn" id="apiDone">Done</button></div>';
      body.innerHTML = html;
      var cb = el('apiCopyTok');
      if (cb) cb.onclick = function () { copy(token, cb); };
      var dn = el('apiDone');
      if (dn) dn.onclick = function () { load(); };
      msg(message + (r.status === 'inactive' ? ' It is inactive until you activate it.' : ''));
      if (r.base_url !== undefined) paintUrl(r);
      if (token) { var hint = el('apiTestHint'); if (hint) hint.textContent = 'Your new token is ready to test below.'; }
    }

    /* ---------- 1. ready-to-use endpoint ---------- */
    function paintUrl(s) {
      var base = s.base_url || '';
      baseConfigured = s.base_url_configured !== false && !!base;
      lastBase = base;
      var endpoint = (s.endpoints && s.endpoints.messages) || (base ? base + '/messages' : '');
      lastEndpoint = endpoint;
      var path = (s.paths && s.paths.messages) || '/api/v1/messages';

      var html = '';
      if (!endpoint) {
        /* One clean, actionable sentence. No speculation about proxies,
           browser logs or what a request "cannot know". */
        html += '<div class="apiwarn"><b>No public address is set, so there is no endpoint to copy yet.</b> '
          + (IS_ADMIN ? 'Set it in “Technical details” below.'
                      : 'Ask an administrator to set the panel’s public address.')
          + '</div>';
      } else {
        html += '<div class="apiendpoint">'
          +   '<span class="apiendpoint-url" id="apiEndpointVal">' + esc(endpoint + '?limit=10') + '</span>'
          +   '<button class="apibtn primary" id="apiCopyEndpoint">Copy endpoint</button>'
          + '</div>';
        if (!baseConfigured) {
          html += '<div class="apiwarn"><b>This address is a guess taken from the current browser request</b> and is only '
            + 'usable on this machine. Set the panel’s public address so integrations get a URL they can actually reach.</div>';
        } else {
          html += '<div class="apinote">Send this with an <code>Authorization</code> header — see “Integration example” below.</div>';
        }
      }

      /* Secondary detail, collapsed by default. */
      html += '<details class="apidetails"><summary>Technical details</summary>'
        +   '<div class="apirow" style="margin-top:12px"><span class="apilbl">Base URL</span>'
        +     '<span class="apival">' + esc(base || 'not set') + '</span>'
        +     '<button class="apibtn" id="apiCopyBase">Copy base URL</button></div>'
        +   '<div class="apirow"><span class="apilbl">Endpoint path</span>'
        +     '<span class="apival">' + esc(path) + '</span></div>';
      if (IS_ADMIN) {
        html += '<div class="apiconfig">'
          + '<label for="apiBaseInput">Public address</label>'
          + '<div class="apiconfigrow">'
          +   '<input type="url" id="apiBaseInput" placeholder="https://sms.example.com" value="' + esc(s.base_url_origin || '') + '">'
          +   '<button class="apibtn primary" id="apiSaveBase">Save</button>'
          + '</div>'
          + '<div class="apinote" id="apiBaseNote"></div>'
          + '</div>';
      }
      html += '</details>';

      urlBody.innerHTML = html;

      var cb = el('apiCopyBase');
      if (cb) cb.onclick = function () { copy(base, cb); };
      var ce = el('apiCopyEndpoint');
      if (ce) ce.onclick = function () { copy(endpoint + '?limit=10', ce); };

      if (IS_ADMIN) {
        var note = el('apiBaseNote');
        if (note) {
          note.innerHTML = s.base_url_source === 'env'
            ? 'Currently set by the <code>PUBLIC_BASE_URL</code> environment variable, which overrides any value saved here.'
            : 'Applies to every Manager and Agent API page. Scheme, host and port only — <code>/api/v1</code> is added automatically.';
        }
        var save = el('apiSaveBase');
        if (save) save.onclick = function () {
          var v = String(el('apiBaseInput').value || '').trim();
          save.disabled = true;
          api('/api/extapi/settings/base-url', { method: 'POST', body: { base_url: v } })
            .then(function () { msg('Public address saved.'); load(); })
            .catch(function (e) { err(e.message); save.disabled = false; });
        };
      }

      paintExample(s);
    }

    /* ---------- 4. integration example ---------- */
    function paintExample(s) {
      var endpoint = lastEndpoint || 'https://YOUR-PANEL-ADDRESS/api/v1/messages';
      var example = [
        '# Python — Telegram bot: /sms returns your latest messages',
        'import os, requests',
        '',
        'API_URL  = "' + endpoint + '"',
        'API_TOKEN = os.environ["AMS_API_TOKEN"]   # keep the token out of your code',
        '',
        'def sms(update, context):',
        '    r = requests.get(',
        '        API_URL,',
        '        params={"limit": 10},',
        '        headers={"Authorization": f"Bearer {API_TOKEN}"},   # token goes in the HEADER',
        '        timeout=15,',
        '    )',
        '    r.raise_for_status()',
        '    rows = r.json()["records"]',
        '    if not rows:',
        '        return update.message.reply_text("No messages yet.")',
        '    msg = "\\n".join(f\'{m["time"]}  {m["cli"]} -> {m["number"]}  [{m["status"]}]\' for m in rows)',
        '    update.message.reply_text(msg[:4000])',
        '',
        '# Equivalent curl:',
        '# curl -X GET "' + endpoint + '?limit=10" \\',
        '#      -H "Authorization: Bearer $AMS_API_TOKEN"',
      ].join('\n');

      var ex = el('apiExample');
      if (ex) ex.textContent = example;
      var cex = el('apiCopyExample');
      if (cex) cex.onclick = function () { copy(example, cex); };

      var f = el('apiFields');
      if (f) {
        f.innerHTML = 'Each record contains exactly: <code>time</code>, <code>cli</code>, <code>number</code>, '
          + '<code>content</code>, <code>status</code>. Pagination comes back in the <code>X-Total-Count</code>, '
          + '<code>X-Limit</code>, <code>X-Offset</code> and <code>X-Has-More</code> headers, so the JSON body stays stable. '
          + 'Limits: a short burst cap, then 40 requests per minute, per endpoint. '
          + 'The token belongs in the <b>Authorization header</b> — never in the URL.';
      }
    }

    /* ---------- 3. test the API ---------- */
    function selectedToken() {
      var mine = el('apiSrcMine');
      if (mine && mine.checked) return sessionToken || '';
      return String((el('apiPaste') && el('apiPaste').value) || '').trim();
    }

    /* Filters for the test request. Only the token travels in the header;
       these are ordinary, non-secret query parameters. */
    function testQuery() {
      var qs = [];
      var from = String((el('apiFrom') && el('apiFrom').value) || '').trim();
      var to = String((el('apiTo') && el('apiTo').value) || '').trim();
      var limit = String((el('apiLimit') && el('apiLimit').value) || '10');
      if (from) qs.push('from=' + encodeURIComponent(from.replace('T', ' ') + ':00'));
      if (to) qs.push('to=' + encodeURIComponent(to.replace('T', ' ') + ':00'));
      qs.push('limit=' + encodeURIComponent(limit));
      return '?' + qs.join('&');
    }

    function runTest() {
      var res = el('apiTestResult'), meta = el('apiTestMeta'), loading = el('apiTestLoading'),
          terr = el('apiTestErr'), out = el('apiTestJson');
      clearErr();
      res.style.display = 'block';
      terr.style.display = 'none';
      meta.innerHTML = '';
      loading.style.display = 'flex';
      out.innerHTML = '<span class="apiempty">Sending…</span>';

      var token = selectedToken();
      if (!token) {
        loading.style.display = 'none';
        terr.textContent = sessionToken ? 'Choose a token source first.'
          : 'This browser session does not hold your token, so it cannot be applied automatically. '
          + 'Either create or regenerate a token (it is then remembered for this page), or paste one below.';
        terr.style.display = 'block';
        out.innerHTML = '<span class="apiempty">No request sent.</span>';
        return;
      }

      /* The request goes to the real public endpoint with the real
         Authorization header — exactly what an integration would send. The
         token travels in the header only, never in the URL. */
      var url = (lastEndpoint || '/api/v1/messages') + testQuery();
      var t0 = (window.performance && performance.now) ? performance.now() : Date.now();

      fetch(url, { method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } })
        .then(function (r) {
          return r.text().then(function (text) {
            var body = null;
            try { body = JSON.parse(text); } catch (e) { body = null; }
            return { status: r.status, ok: r.ok, body: body, text: text,
                     headers: r.headers, wall: Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - t0) };
          });
        })
        .then(function (r) {
          loading.style.display = 'none';
          var recs = (r.body && r.body.records) || [];
          var total = r.headers ? r.headers.get('X-Total-Count') : null;
          meta.innerHTML = '<span class="apipill"><b>' + esc(String(r.status)) + '</b> '
            + esc(r.ok ? r.status === 200 ? 'OK' : 'success' : 'failed') + '</span>'
            + (r.ok ? '<span class="apipill"><b>' + esc(String(recs.length)) + '</b> returned</span>' : '')
            + (total !== null ? '<span class="apipill"><b>' + esc(total) + '</b> matching</span>' : '')
            + '<span class="apipill">round trip <b>' + esc(String(r.wall)) + '</b> ms</span>';
          lastResponse = r.body || { records: [] };
          var acts = el('apiTestActions');
          if (acts) acts.style.display = 'flex';
          if (r.ok) {
            msg('Request succeeded — the token was accepted.');
            /* Always show the real response body, including an empty
               records array: someone testing the API needs to see the exact
               shape the endpoint returns, not a paraphrase of it. */
            out.innerHTML = highlightJson(recs);
          } else {
            var why = (r.body && (r.body.error)) || (r.status === 401 ? 'Invalid or missing API token.' : null)
                   || (r.status === 403 ? 'This token is not active (revoked or deactivated).' : null)
                   || ('HTTP ' + r.status);
            lastResponse = null;
            var a2 = el('apiTestActions'); if (a2) a2.style.display = 'none';
            terr.textContent = 'Request failed: ' + why;
            terr.style.display = 'block';
            out.innerHTML = '<span class="apiempty">' + esc(r.text.slice(0, 400)) + '</span>';
          }
        })
        .catch(function (e) {
          loading.style.display = 'none';
          terr.textContent = 'Could not reach the endpoint'
            + (lastBase && lastBase.indexOf(location.origin) !== 0 ? ' (' + lastBase + ')' : '')
            + '. ' + (e && e.message ? e.message : 'Network error.');
          terr.style.display = 'block';
          out.innerHTML = '<span class="apiempty">No response.</span>';
        });
    }

    /* ---------- JSON viewer ---------- */
    function highlightJson(records) {
      /* Pretty-print first, then colourise. Values are escaped before any
         markup is added, so message bodies can never inject HTML. */
      var text = JSON.stringify({ records: records }, null, 2);
      return esc(text)
        .replace(/&quot;(\\?&quot;?|[^&]*?)&quot;(\s*:)/g, '<span class="jkey">"$1"</span>$2')
        .replace(/:\s*&quot;([^&]*?)&quot;/g, ': <span class="jstr">"$1"</span>')
        .replace(/:\s*(-?\d+(?:\.\d+)?)/g, ': <span class="jnum">$1</span>')
        .replace(/:\s*(true|false|null)/g, ': <span class="jbool">$1</span>');
    }

    function wireActions() {
      var mine = el('apiSrcMine'), pasted = el('apiSrcPasted'), wrap = el('apiPasteWrap');
      function sync() { wrap.style.display = (pasted && pasted.checked) ? 'block' : 'none'; }
      if (mine) mine.onchange = sync;
      if (pasted) pasted.onchange = sync;
      sync();

      var runBtn = el('apiRunTest');
      if (runBtn) runBtn.onclick = runTest;

      var cr = el('apiCopyResponse');
      if (cr) cr.onclick = function () {
        if (!lastResponse) { err('Run a test first.'); return; }
        copy(JSON.stringify(lastResponse, null, 2), cr);
      };

      var dl = el('apiDownload');
      if (dl) dl.onclick = function () {
        if (!lastResponse) { err('Run a test first.'); return; }
        try {
          var blob = new Blob([JSON.stringify(lastResponse, null, 2)], { type: 'application/json' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'api-messages-response.json';
          document.body.appendChild(a); a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
        } catch (e) { err('Download failed: ' + e.message); }
      };
    }

    function load() {
      api('/api/extapi/me')
        .then(function (s) { paint(s); paintUrl(s); })
        .catch(function (e) { err(e.message); });
    }
    load();
    wireActions();
  }


  /* ---------------- admin monitoring (spec 2C) ---------------- */
  function renderAdmin(root) {
    root.innerHTML = CSS
      + '<div class="apiwrap">'
      +   '<div class="apierr" id="apiErr"></div><div class="apimsg" id="apiMsg"></div>'
      +   '<div class="apicard">'
      +     '<h3>API management</h3>'
      +     '<div class="sub">Which Managers and Agents have created or activated API access. '
      +       'Tokens are never displayed here.</div>'
      +     '<div id="apiTableWrap"><div class="apinote">Loading…</div></div>'
      +   '</div>'
      + '</div>';

    var wrap = el('apiTableWrap'), errBox = el('apiErr'), msgBox = el('apiMsg');
    function err(m) { errBox.textContent = m; errBox.style.display = 'block'; msgBox.style.display = 'none'; }
    function msg(m) { msgBox.textContent = m; msgBox.style.display = 'block'; errBox.style.display = 'none'; }

    function rows(list) {
      if (!list.length) { wrap.innerHTML = '<div class="apinote">No accounts yet.</div>'; return; }
      var h = '<table class="apitable"><thead><tr>'
        + '<th>Account</th><th>Role</th><th>Parent</th><th>Status</th>'
        + '<th>Token</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>';
      list.forEach(function (a) {
        var st = a.status || 'not_created';
        h += '<tr>'
          + '<td>' + esc(a.name || a.username) + '<div style="font-size:11.5px;color:var(--text-muted)">@' + esc(a.username) + '</div></td>'
          + '<td>' + esc(a.role) + '</td>'
          + '<td>' + esc(a.parent_username || '—') + '</td>'
          + '<td><span class="apistatus ' + esc(st) + '">' + esc(st.replace('_', ' ')) + '</span></td>'
          + '<td style="font-family:monospace;font-size:12px">' + esc(a.token_prefix ? a.token_prefix + '…' : '—') + '</td>'
          + '<td style="font-size:12px">' + esc(a.created_at || '—') + '</td>'
          + '<td style="font-size:12px">' + esc(a.last_used_at || 'never') + '</td>'
          + '<td>' + (st === 'active'
              ? '<button class="apibtn" data-deact="' + a.user_id + '">Deactivate</button> '
              : '') + (st !== 'not_created' && st !== 'revoked'
              ? '<button class="apibtn danger" data-rev="' + a.user_id + '">Revoke</button>' : '') + '</td>'
          + '</tr>';
      });
      h += '</tbody></table>';
      wrap.innerHTML = h;

      Array.prototype.forEach.call(wrap.querySelectorAll('[data-deact]'), function (b) {
        b.onclick = function () {
          api('/api/extapi/admin/credentials/' + b.dataset.deact + '/deactivate', { method: 'POST', body: {} })
            .then(function () { msg('Deactivated.'); load(); }).catch(function (e) { err(e.message); });
        };
      });
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-rev]'), function (b) {
        b.onclick = function () {
          if (!confirm('Revoke API access for this account? This cannot be undone.')) return;
          api('/api/extapi/admin/credentials/' + b.dataset.rev + '/revoke', { method: 'POST', body: {} })
            .then(function () { msg('Revoked.'); load(); }).catch(function (e) { err(e.message); });
        };
      });
    }

    function load() {
      api('/api/extapi/admin/credentials').then(function (r) { rows(r.accounts || []); })
        .catch(function (e) { err(e.message); });
    }
    load();
  }

  /* ---------------- auto-mount ---------------- */
  function mount() {
    ['page-extapi', 'page-api', 'page-apiManagement'].forEach(function (id) {
      var root = el(id);
      if (!root || root.dataset.apiMounted) return;
      root.dataset.apiMounted = '1';
      root.innerHTML = '';
      var role = sessionStorage.getItem('ams_role') || localStorage.getItem('ams_role') || '';
      if (role === 'admin') renderAdmin(root); else renderSelf(root);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  window.AMS_EXTAPI_MOUNT = mount;

  /* Panels swap pages by toggling a class, so re-check whenever the DOM changes.
   * mount() is idempotent — it only fills a section the first time. */
  try {
    var mo = new MutationObserver(function () { mount(); });
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    window.addEventListener('hashchange', mount);
    document.addEventListener('click', function () { setTimeout(mount, 30); });
  } catch (e) { /* observers are a nicety, not a requirement */ }
})();
