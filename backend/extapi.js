/**
 * backend/extapi.js — PER-USER REST API CREDENTIALS + READ-ONLY SMS DATA API
 *
 * Design notes (see spec sections 2A-2F):
 *   - One credential per Manager and per Agent. Admin has its own credential.
 *     Tokens are cryptographically random and NEVER stored — only a SHA-256
 *     hash plus a short non-secret display prefix is persisted.
 *   - API access is NEVER auto-activated. Creation is an explicit action, and
 *     activation is a second, separate explicit action.
 *   - Data access is scoped by the existing hierarchy:
 *        agent   -> sms_records.agent_id   = caller
 *        manager -> sms_records.manager_id = caller
 *        admin   -> all rows
 *     This mirrors the scoping already used by /api/sms/paged.
 *   - Response body shape is exactly:  { "records": [ ... ] }
 *     Pagination metadata is carried in X-* response headers so the JSON
 *     structure stays identical to the supplied sample.
 *   - Nothing in this module writes to sms_records, payment tables or users.
 */
'use strict';
const crypto = require('crypto');
const db = require('./db');

/* ------------------------------------------------------------------ */
/* token helpers                                                       */
/* ------------------------------------------------------------------ */
function genToken() {
  return 'amsk_' + crypto.randomBytes(32).toString('base64url');
}
function hashToken(t) {
  return crypto.createHash('sha256').update(String(t)).digest('hex');
}
function prefixOf(t) {
  return String(t).slice(0, 12); // 'amsk_' + 8 chars — display only
}

/* ------------------------------------------------------------------ */
/* small utils                                                         */
/* ------------------------------------------------------------------ */
function isoZ(sqlUtc) {
  // stored as 'YYYY-MM-DD HH:MM:SS' (SQLite datetime('now'), UTC)
  const s = String(sqlUtc || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  return `${m[1]}T${m[2]}.000Z`;
}
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function safeDate(v) {
  // accept YYYY-MM-DD or full ISO; returns 'YYYY-MM-DD HH:MM:SS' for SQLite compare
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (m) return m[1] + ' 00:00:00';
  m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (m) return `${m[1]} ${m[2]}`;
  return null;
}
/* Never let a token, secret or message body reach the log. */
function logApiError(credId, userId, endpoint, ip, status, errMsg) {
  try {
    db.run(
      `INSERT INTO api_request_logs (credential_id, user_id, endpoint, ip, status_code, error, created_at)
       VALUES (?,?,?,?,?,?, datetime('now'))`,
      [credId || null, userId || null, String(endpoint || '').slice(0, 80),
       String(ip || '').slice(0, 60), status, String(errMsg || '').slice(0, 200)]
    );
  } catch (e) { /* logging must never break the response */ }
}

/* ------------------------------------------------------------------ */
/* scope                                                               */
/* ------------------------------------------------------------------ */
function scopeFor(user) {
  if (user.role === 'admin') return { sql: '1=1', params: [] };
  if (user.role === 'manager') return { sql: 's.manager_id = ?', params: [user.id] };
  if (user.role === 'agent') return { sql: 's.agent_id = ?', params: [user.id] };
  return { sql: '1=0', params: [] }; // clients get nothing
}

/* ------------------------------------------------------------------ */
/* main mount                                                          */
/* ------------------------------------------------------------------ */
module.exports = function mountExtApi(app, deps) {
  const { authRequired, requireRole, logAction, rateLimit } = deps;

  /* ---------- rate limiters ----------
   * Sustained cap (40/60s per credential) mirrors the reference convention and is
   * the real guard for polling clients. The short burst window is deliberately
   * looser (default 5/s) so that paging through results back-to-back works;
   * tighten or loosen both with env vars without touching code. */
  const BURST_MAX = parseInt(process.env.EXTAPI_BURST_PER_SEC || '5', 10) || 5;
  const MIN_MAX = parseInt(process.env.EXTAPI_RATE_PER_MIN || '40', 10) || 40;
  const burst = rateLimit
    ? rateLimit({ windowMs: 1000, max: BURST_MAX, keyFn: (req) => `extapi:burst:${req.extUser ? req.extUser.id : req.ip}` })
    : (req, res, next) => next();
  const minute = rateLimit
    ? rateLimit({ windowMs: 60000, max: MIN_MAX, keyFn: (req) => `extapi:min:${req.extUser ? req.extUser.id : req.ip}` })
    : (req, res, next) => next();
  const manageLimit = rateLimit
    ? rateLimit({ windowMs: 60000, max: 30, keyFn: (req) => `extapi:mgmt:${req.user ? req.user.id : req.ip}` })
    : (req, res, next) => next();

  /* ==================================================================
   * TOKEN AUTHENTICATION for public /api/v1/*
   * ================================================================== */
  function tokenAuth(req, res, next) {
    let token = '';
    const hdr = req.get('authorization') || '';
    if (/^bearer\s+/i.test(hdr)) token = hdr.replace(/^bearer\s+/i, '').trim();
    if (!token && req.query && req.query.token) token = String(req.query.token).trim();
    if (!token) {
      return res.status(401).json({ error: 'Missing API token. Send Authorization: Bearer <token>.' });
    }
    const h = hashToken(token);
    const cred = db.get('SELECT * FROM api_credentials WHERE token_hash=?', [h]);
    if (!cred) {
      logApiError(null, null, req.path, req.ip, 401, 'unknown token');
      return res.status(401).json({ error: 'Invalid API token.' });
    }
    if (cred.status !== 'active') {
      logApiError(cred.id, cred.user_id, req.path, req.ip, 403, 'status=' + cred.status);
      return res.status(403).json({
        error: cred.status === 'revoked'
          ? 'This API token has been revoked.'
          : 'API access is not active. Enable it in your panel first.'
      });
    }
    const user = db.get('SELECT id, username, role, name, active FROM users WHERE id=?', [cred.user_id]);
    if (!user || !user.active) {
      logApiError(cred.id, cred.user_id, req.path, req.ip, 403, 'user inactive');
      return res.status(403).json({ error: 'Account is disabled.' });
    }
    try { db.run("UPDATE api_credentials SET last_used_at=datetime('now') WHERE id=?", [cred.id]); } catch (e) {}

    req.extUser = user;
    req.extCred = cred;
    next();
  }

  function apiLog(status, msg) {
    return (req, res, next) => {
      if (status) logApiError(req.extCred ? req.extCred.id : null, req.extUser ? req.extUser.id : null,
        req.path, req.ip, status, msg);
      next();
    };
  }

  /* ==================================================================
   * PUBLIC BASE URL  (spec 2A)
   * ------------------------------------------------------------------
   * The base URL shown to users must be the real, externally reachable
   * origin. Deriving it from the request (`req.protocol` + `Host`) reports
   * whatever the reverse proxy happened to forward — on a local run that is
   * 127.0.0.1:PORT, and behind TLS termination it can even report plain
   * http. That is never a usable production URL, so the request is used only
   * as a clearly-labelled fallback.
   *
   * Resolution order:
   *   1. PUBLIC_BASE_URL environment variable        (deployment config)
   *   2. app_settings.public_base_url                (set by Admin in-panel)
   *   3. request-derived origin, flagged configured:false
   *
   * The response always carries `base_url_configured` so the UI can say
   * "this is not configured yet" rather than presenting a guessed URL as real.
   * ================================================================== */
  const API_V1_PATH = '/api/v1';

  function getSetting(key) {
    try {
      const r = db.get('SELECT value FROM app_settings WHERE key = ?', [key]);
      return r ? r.value : null;
    } catch (e) { return null; }
  }
  function setSetting(key, value) {
    try {
      db.run(`INSERT INTO app_settings (key, value, updated_at) VALUES (?,?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value]);
      return true;
    } catch (e) { return false; }
  }

  /** Normalise a user-supplied base URL. Returns '' when it is not usable. */
  function normaliseBaseUrl(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;   // assume TLS by default
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      if (!u.hostname) return '';
      // Strip any path/query the admin pasted — the API lives at /api/v1.
      return u.origin;
    } catch (e) { return ''; }
  }

  /**
   * @returns {{baseUrl:string, configured:boolean, source:string}}
   */
  function resolveBaseUrl(req) {
    const fromEnv = normaliseBaseUrl(process.env.PUBLIC_BASE_URL || '');
    if (fromEnv) return { baseUrl: fromEnv, configured: true, source: 'env' };

    const fromDb = normaliseBaseUrl(getSetting('public_base_url') || '');
    if (fromDb) return { baseUrl: fromDb, configured: true, source: 'database' };

    // Not configured. Fall back to the request so the page is still usable,
    // but mark it so the UI can warn instead of implying it is production.
    const host = req && req.get ? (req.get('host') || '') : '';
    const proto = req && req.protocol ? req.protocol : 'http';
    return {
      baseUrl: host ? `${proto}://${host}` : '',
      configured: false,
      source: 'request',
    };
  }

  /** The full URL a user would actually call for a given operation. */
  function endpointFor(baseUrl, path) {
    const b = normaliseBaseUrl(baseUrl);
    if (!b) return '';
    return b + API_V1_PATH + path;
  }

  /** Standard block returned by every credential-management response. */
  function apiInfoFor(req) {
    const r = resolveBaseUrl(req);
    const base = r.baseUrl ? r.baseUrl + API_V1_PATH : '';
    return {
      base_url: base,
      base_url_configured: r.configured,
      base_url_source: r.source,
      base_url_origin: r.baseUrl,
      endpoints: {
        messages: base ? base + '/messages' : '',
        stats: base ? base + '/stats' : '',
      },
      paths: { messages: API_V1_PATH + '/messages', stats: API_V1_PATH + '/stats' },
      auth: {
        method: 'header',
        header: 'Authorization: Bearer <token>',
        note: 'Send the token in the Authorization header. Do not put it in the URL.',
      },
    };
  }

  /* ==================================================================
   * SELF-SERVICE CREDENTIAL MANAGEMENT (Admin / Manager / Agent)
   * ================================================================== */
  function myCred(req, res) {
    const info = apiInfoFor(req);
    const row = db.get('SELECT * FROM api_credentials WHERE user_id=?', [req.user.id]);
    if (!row) {
      return res.json(Object.assign({
        ok: true, exists: false, status: 'not_created',
        token_prefix: null, created_at: null, last_used_at: null,
      }, info));
    }
    res.json(Object.assign({
      ok: true, exists: true, status: row.status,
      token_prefix: row.token_prefix,        // display only — not a secret
      created_at: row.created_at,
      activated_at: row.activated_at,
      last_used_at: row.last_used_at,
      revoked_at: row.revoked_at,
    }, info));
  }
  app.get('/api/extapi/me', authRequired, myCred);

  /* ------------------------------------------------------------------
   * Base URL configuration (spec 2A: "provide a config field or clearly
   * explain what must be set").
   *   GET  /api/extapi/settings/base-url   any signed-in user can read
   *   POST /api/extapi/settings/base-url   admin only
   * The env var takes precedence and is reported as such, so an admin who
   * sets the panel value but sees no change knows where to look.
   * ------------------------------------------------------------------ */
  app.get('/api/extapi/settings/base-url', authRequired, (req, res) => {
    const r = resolveBaseUrl(req);
    res.json({
      ok: true,
      base_url: r.baseUrl ? r.baseUrl + API_V1_PATH : '',
      base_url_origin: r.baseUrl,
      configured: r.configured,
      source: r.source,
      env_set: !!normaliseBaseUrl(process.env.PUBLIC_BASE_URL || ''),
      stored: getSetting('public_base_url') || '',
      is_admin: req.user.role === 'admin',
    });
  });

  app.post('/api/extapi/settings/base-url', authRequired, requireRole('admin'), (req, res) => {
    const raw = String((req.body && req.body.base_url) || '').trim();
    if (!raw) {
      // Clearing is allowed — it puts the page back into "not configured".
      setSetting('public_base_url', '');
      return res.json({ ok: true, base_url: '', configured: false, source: 'request' });
    }
    const norm = normaliseBaseUrl(raw);
    if (!norm) {
      return res.status(400).json({
        error: 'Enter a valid absolute URL, for example https://sms.example.com',
      });
    }
    setSetting('public_base_url', norm);
    if (typeof logAction === 'function') {
      try { logAction(req.user.id, 'extapi_set_base_url', JSON.stringify({ base_url: norm })); } catch (e) {}
    }
    res.json({ ok: true, base_url: norm + API_V1_PATH, base_url_origin: norm, configured: true, source: 'database' });
  });

  /* Create — explicit action, starts INACTIVE (spec 2B: no auto-activation) */
  app.post('/api/extapi/me/create', authRequired, manageLimit, (req, res) => {
    if (req.user.role === 'client') return res.status(403).json({ error: 'Not available for client accounts.' });
    const existing = db.get('SELECT id FROM api_credentials WHERE user_id=?', [req.user.id]);
    if (existing) return res.status(409).json({ error: 'API credential already exists. Regenerate instead.' });

    const token = genToken();
    try {
      db.run(
        `INSERT INTO api_credentials (user_id, token_hash, token_prefix, status, created_at)
         VALUES (?,?,?, 'inactive', datetime('now'))`,
        [req.user.id, hashToken(token), prefixOf(token)]
      );
    } catch (e) {
      return res.status(500).json({ error: 'Could not create credential.' });
    }
    logAction(req, 'extapi_create', 'api', { user_id: req.user.id });
    // The plaintext token is returned exactly once, on creation only.
    res.json({
      ok: true, status: 'inactive', token,
      note: 'Shown once. Activate it before use.',
      ...apiInfoFor(req),
    });
  });

  function setState(newStatus, actionName) {
    return (req, res) => {
      const row = db.get('SELECT * FROM api_credentials WHERE user_id=?', [req.user.id]);
      if (!row) return res.status(404).json({ error: 'No API credential yet — create one first.' });
      if (row.status === 'revoked') return res.status(409).json({ error: 'Revoked credential cannot be reused. Create a new one.' });

      let sql = "UPDATE api_credentials SET status=? WHERE user_id=?";
      if (newStatus === 'active') sql = "UPDATE api_credentials SET status=?, activated_at=COALESCE(activated_at, datetime('now')) WHERE user_id=?";
      if (newStatus === 'revoked') sql = "UPDATE api_credentials SET status=?, revoked_at=datetime('now') WHERE user_id=?";
      db.run(sql, [newStatus, req.user.id]);
      logAction(req, actionName, 'api', { user_id: req.user.id, status: newStatus });
      res.json({ ok: true, status: newStatus });
    };
  }
  app.post('/api/extapi/me/activate', authRequired, manageLimit, setState('active', 'extapi_activate'));
  app.post('/api/extapi/me/deactivate', authRequired, manageLimit, setState('inactive', 'extapi_deactivate'));
  app.post('/api/extapi/me/revoke', authRequired, manageLimit, setState('revoked', 'extapi_revoke'));

  /* Regenerate — issues a brand new token, stays inactive until re-activated */
  app.post('/api/extapi/me/regenerate', authRequired, manageLimit, (req, res) => {
    const row = db.get('SELECT * FROM api_credentials WHERE user_id=?', [req.user.id]);
    if (!row) return res.status(404).json({ error: 'No API credential yet — create one first.' });
    const token = genToken();
    db.run(
      `UPDATE api_credentials SET token_hash=?, token_prefix=?, status='inactive',
              revoked_at=NULL, activated_at=NULL
       WHERE user_id=?`,
      [hashToken(token), prefixOf(token), req.user.id]
    );
    logAction(req, 'extapi_regenerate', 'api', { user_id: req.user.id });
    res.json({
      ok: true, status: 'inactive', token,
      note: 'Previous token stopped working immediately. Activate the new one before use.',
      ...apiInfoFor(req),
    });
  });

  /* ==================================================================
   * ADMIN MONITORING (spec 2C) — never returns token hashes or secrets
   * ================================================================== */
  app.get('/api/extapi/admin/credentials', authRequired, requireRole('admin'), (req, res) => {
    const rows = db.all(`
      SELECT u.id AS user_id, u.username, u.name, u.role, u.active,
             p.username AS parent_username,
             c.id AS cred_id, c.status, c.token_prefix,
             c.created_at, c.activated_at, c.last_used_at, c.revoked_at
      FROM users u
      LEFT JOIN users p ON p.id = u.parent_id
      LEFT JOIN api_credentials c ON c.user_id = u.id
      WHERE u.role IN ('admin','manager','agent')
      ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
               u.username COLLATE NOCASE
    `);
    // normalise: no credential row => 'not_created'
    const out = rows.map(r => ({
      ...r,
      status: r.cred_id ? r.status : 'not_created',
      token_hash: undefined,
    }));
    res.json({ ok: true, accounts: out });
  });

  app.post('/api/extapi/admin/credentials/:userId/revoke', authRequired, requireRole('admin'), manageLimit, (req, res) => {
    const uid = parseInt(req.params.userId, 10);
    if (!uid) return res.status(400).json({ error: 'Valid user ID required.' });
    const t = db.get('SELECT id, role FROM users WHERE id=?', [uid]);
    if (!t) return res.status(404).json({ error: 'User not found.' });
    const n = db.run("UPDATE api_credentials SET status='revoked', revoked_at=datetime('now') WHERE user_id=?", [uid]);
    logAction(req, 'extapi_admin_revoke', 'api', { target_id: uid });
    res.json({ ok: true, changed: n && n.changes ? n.changes : 0 });
  });

  app.post('/api/extapi/admin/credentials/:userId/deactivate', authRequired, requireRole('admin'), manageLimit, (req, res) => {
    const uid = parseInt(req.params.userId, 10);
    if (!uid) return res.status(400).json({ error: 'Valid user ID required.' });
    const t = db.get('SELECT id FROM users WHERE id=?', [uid]);
    if (!t) return res.status(404).json({ error: 'User not found.' });
    const n = db.run("UPDATE api_credentials SET status='inactive' WHERE user_id=? AND status='active'", [uid]);
    logAction(req, 'extapi_admin_deactivate', 'api', { target_id: uid });
    res.json({ ok: true, changed: n && n.changes ? n.changes : 0 });
  });

  /* ==================================================================
   * PUBLIC READ-ONLY DATA API  (spec 2D)
   * ================================================================== */

  /**
   * The one and only message query. Both the public token endpoint and the
   * in-panel preview run through this, so the preview shows exactly what an
   * integration would receive — same rows, same scope, same field order,
   * same pagination maths. There is no second "sample" code path.
   *
   * Only `limit` rows are ever read. The total is a COUNT(*) over the same
   * indexed WHERE clause, never a full table read into memory.
   */
  function queryMessages(user, q) {
    const limit = clampInt(q.limit, 100, 1, 500);
    const offset = clampInt(q.offset, 0, 0, 1000000);
    const from = safeDate(q.from);
    const to = safeDate(q.to);
    const cli = q.cli ? String(q.cli).slice(0, 64) : null;
    const number = q.number ? String(q.number).slice(0, 40) : null;

    const bad = [];
    if (q.from && !from) bad.push('from');
    if (q.to && !to) bad.push('to');
    if (bad.length) {
      const e = new Error(`Invalid ${bad.join(' and ')} date. Use YYYY-MM-DD or ISO 8601.`);
      e.status = 400;
      throw e;
    }

    const sc = scopeFor(user);
    const where = ['1=1', sc.sql];
    const params = [...sc.params];
    if (from) { where.push('s.received_at >= ?'); params.push(from); }
    if (to) { where.push('s.received_at <= ?'); params.push(to); }
    if (cli) { where.push('s.cli = ?'); params.push(cli); }
    if (number) { where.push('s.number = ?'); params.push(number); }
    const wSql = where.join(' AND ');

    const t0 = process.hrtime.bigint();
    const total = +(db.get(`SELECT COUNT(*) c FROM sms_records s WHERE ${wSql}`, params)?.c || 0);

    const rows = db.all(
      `SELECT s.received_at, s.cli, s.number, s.message
         FROM sms_records s
        WHERE ${wSql}
        ORDER BY s.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    /* Status: sms_records only holds messages that were RECEIVED and processed.
     * Rejected/failed attempts live in failed_sms_queue and are deliberately not
     * exposed here (spec 2D: do not count failed attempts as successful SMS). */
    const records = rows.map(r => ({
      time: isoZ(r.received_at),
      cli: r.cli || '',
      number: r.number || '',
      content: r.message || '',
      status: 'received',
    }));

    return {
      records,
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
    };
  }

  function sendMessages(res, out) {
    res.setHeader('X-Total-Count', String(out.total));
    res.setHeader('X-Limit', String(out.limit));
    res.setHeader('X-Offset', String(out.offset));
    res.setHeader('X-Has-More', String(out.hasMore));
    res.setHeader('X-Query-Ms', out.elapsedMs.toFixed(1));
    res.json({ records: out.records });
  }

  /* ------------------------------------------------------------------
   * CORS for the public read API.
   * These endpoints are token-authenticated and read-only, and the token
   * must be supplied explicitly in the Authorization header (browsers never
   * attach one automatically), so allowing any origin adds no privilege an
   * unauthenticated caller does not already have. It is what lets the
   * panel's "Test the API" button call the real endpoint from the browser
   * when the configured public address differs from the panel's origin.
   * Credentials are never allowed, and non-GET methods are not opened up.
   * ------------------------------------------------------------------ */
  app.use('/api/v1', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers',
      'X-Total-Count, X-Limit, X-Offset, X-Has-More, X-Query-Ms');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  /**
   * GET /api/v1/messages
   *   ?from=YYYY-MM-DD  ?to=YYYY-MM-DD  ?cli=  ?number=
   *   ?limit=1..500 (default 100)  ?offset=0..
   * Body: { "records": [ { time, cli, number, content, status } ] }
   * Pagination: X-Total-Count, X-Limit, X-Offset, X-Has-More
   */
  app.get('/api/v1/messages', burst, tokenAuth, minute, (req, res) => {
    try {
      const user = req.extUser;
      if (user.role === 'client') {
        return res.status(403).json({ error: 'Client accounts have no API data access.' });
      }
      sendMessages(res, queryMessages(user, req.query));
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      logApiError(req.extCred ? req.extCred.id : null, req.extUser ? req.extUser.id : null,
        req.path, req.ip, 500, e.message);
      res.status(500).json({ error: 'Internal error.' });
    }
  });

  /* ==================================================================
   * IN-PANEL PREVIEW  (spec 2C)
   * ------------------------------------------------------------------
   * Runs the real query through the real scope, but authenticates with the
   * panel session (JWT) instead of an API token.
   *
   * Why a separate route rather than calling /api/v1/messages from the
   * browser: the API token is shown exactly once at creation and is never
   * stored in plaintext, so the browser has nothing to send afterwards.
   * This route is the "equally secure server-side mechanism" — it applies
   * the same scopeFor() rules, so a Manager can never preview another
   * Manager's rows and an Agent can never preview outside their own.
   *
   * It returns the identical body/headers, plus the metadata the preview
   * panel needs (elapsed time, the endpoint that was simulated). It never
   * returns another user's data and never invents sample records.
   * ================================================================== */
  app.get('/api/extapi/me/preview', authRequired, manageLimit, (req, res) => {
    try {
      const user = req.user;
      if (user.role === 'client') {
        return res.status(403).json({ error: 'Client accounts have no API data access.' });
      }
      const cred = db.get('SELECT status FROM api_credentials WHERE user_id=?', [user.id]);
      if (!cred) {
        return res.status(400).json({
          error: 'Create an API token first — the preview runs your own query.',
          code: 'no_credential',
        });
      }
      const out = queryMessages(user, {
        limit: req.query.limit,
        offset: req.query.offset,
        from: req.query.from,
        to: req.query.to,
        cli: req.query.cli,
        number: req.query.number,
      });
      const r = resolveBaseUrl(req);
      const base = r.baseUrl ? r.baseUrl + API_V1_PATH : '';
      // Echo the request the integration would make — token deliberately excluded.
      const qs = new URLSearchParams();
      if (req.query.from) qs.set('from', String(req.query.from));
      if (req.query.to) qs.set('to', String(req.query.to));
      if (req.query.limit) qs.set('limit', String(out.limit));
      if (req.query.offset) qs.set('offset', String(out.offset));
      const q = qs.toString();

      res.setHeader('X-Total-Count', String(out.total));
      res.setHeader('X-Limit', String(out.limit));
      res.setHeader('X-Offset', String(out.offset));
      res.setHeader('X-Has-More', String(out.hasMore));
      res.json({
        ok: true,
        records: out.records,
        count: out.records.length,
        total: out.total,
        limit: out.limit,
        offset: out.offset,
        has_more: out.hasMore,
        elapsed_ms: Math.round(out.elapsedMs * 10) / 10,
        credential_status: cred.status,
        endpoint: base ? base + '/messages' + (q ? '?' + q : '') : '',
        // The token is never included, in the body or the URL.
        endpoint_without_token: base ? base + '/messages' + (q ? '?' + q : '') : '',
      });
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      res.status(500).json({ error: 'Preview failed.' });
    }
  });

  /**
   * GET /api/v1/stats — aggregate counts that the DB can calculate reliably.
   * Deliberately limited to counts + the same time window parameters.
   */
  app.get('/api/v1/stats', burst, tokenAuth, minute, (req, res) => {
    try {
      const user = req.extUser;
      if (user.role === 'client') return res.status(403).json({ error: 'Client accounts have no API data access.' });

      const from = safeDate(req.query.from);
      const to = safeDate(req.query.to);
      if (req.query.from && !from) return res.status(400).json({ error: 'Invalid "from" date.' });
      if (req.query.to && !to) return res.status(400).json({ error: 'Invalid "to" date.' });

      const sc = scopeFor(user);
      const where = ['1=1', sc.sql];
      const params = [...sc.params];
      if (from) { where.push('s.received_at >= ?'); params.push(from); }
      if (to) { where.push('s.received_at <= ?'); params.push(to); }
      const wSql = where.join(' AND ');

      const row = db.get(
        `SELECT COUNT(*) AS total,
                COUNT(DISTINCT s.cli)   AS distinct_cli,
                COUNT(DISTINCT s.number) AS distinct_number,
                MIN(s.received_at) AS first_at,
                MAX(s.received_at) AS last_at
           FROM sms_records s WHERE ${wSql}`, params) || {};

      res.json({
        total: +(row.total || 0),
        distinct_cli: +(row.distinct_cli || 0),
        distinct_number: +(row.distinct_number || 0),
        first_at: isoZ(row.first_at),
        last_at: isoZ(row.last_at),
      });
    } catch (e) {
      logApiError(req.extCred ? req.extCred.id : null, req.extUser ? req.extUser.id : null,
        req.path, req.ip, 500, e.message);
      res.status(500).json({ error: 'Internal error.' });
    }
  });

  return { genToken, hashToken, scopeFor, isoZ };
};
