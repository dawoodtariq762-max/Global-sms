/**
 * GLOBAL SMS — Background Provider Sync Service
 * ---------------------------------------------------------------------------
 * Architecture
 *
 *   Provider API  ->  Background Sync Service  ->  Local Database
 *                                                        |
 *                                          GLOBAL SMS Backend (/api/*)
 *                                                        |
 *                            Admin / Manager / Agent / Client panels
 *
 * The panels NEVER call a provider API. They only read the local database
 * through the existing endpoints. Only this service talks to providers.
 *
 * Key properties
 *  - Incremental: each provider keeps its own `last_sync_at` cursor and asks
 *    only for records newer than that.
 *  - Safety window: the cursor is rewound by `overlap_seconds` on each poll so
 *    that records written a moment before the previous cursor are not missed.
 *  - Deduplication: the provider's unique reference id is stored with a UNIQUE
 *    index, so the overlap can never create duplicates.
 *  - Non-blocking: runs on its own timer in the Node process, writes in a
 *    single batched transaction, and never touches the request path.
 *  - Multi-provider: connectors are registered in `CONNECTORS`; adding a
 *    provider does not require any panel or API change.
 */

const db = require('./db');
const crypto = require('crypto');

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function nowUtcSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function toUtcSql(value, opts = {}) {
  if (!value && value !== 0) return nowUtcSql();
  // epoch seconds / milliseconds
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    const ms = String(value).length <= 10 ? n * 1000 : n;
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  }

  let raw = String(value).trim();
  // Zivastats returns a naive SQL timestamp such as "2026-10-30 07:23:37"
  // in UTC. JavaScript otherwise parses that shape in the server's local
  // timezone, which can move the sync cursor hours into the past and make a
  // relative-window provider request the maximum window on every poll.
  // This is opt-in per provider so existing providers keep their behaviour.
  if (opts && opts.assumeUtc) {
    const naive = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)$/);
    if (naive) raw = `${naive[1]}T${naive[2]}Z`;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) raw = `${raw}T00:00:00Z`;
  }

  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 19).replace('T', ' ');
  return nowUtcSql();
}

function isUtcDateConfig(cfg) {
  return ['utc', 'z', 'gmt'].includes(String((cfg && (cfg.date_timezone || cfg.response_timezone)) || '').trim().toLowerCase());
}

function shiftSql(sqlTs, seconds) {
  const d = new Date(String(sqlTs).replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return nowUtcSql();
  return new Date(d.getTime() + seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]) !== '') return obj[k];
  }
  return '';
}

/**
 * Normalise a pasted URL.
 * Handles: surrounding whitespace, markdown "[text](url)" pastes, HTML-escaped
 * "&amp;" separators, angle brackets, and a trailing slash before the query
 * (astrasms returns HTTP 500 for ".../viewstats/?token=...").
 */
function cleanUrl(value) {
  let u = String(value == null ? '' : value).trim();
  if (!u) return '';
  u = u.replace(/^<+|>+$/g, '').trim();
  // markdown link: [label](real-url)  ->  real-url
  const md = u.match(/\]\(\s*(https?:\/\/[^)\s]+)\s*\)/i);
  if (md) u = md[1];
  else {
    const bare = u.match(/https?:\/\/[^\s\]()<>]+/i);   // pull the URL out of any wrapper
    if (bare) u = bare[0];
  }
  u = u.replace(/&amp;/gi, '&');       // HTML-escaped ampersands
  u = u.replace(/\s+/g, '');           // stray spaces/newlines from copy-paste
  const q = u.indexOf('?');
  const path = q === -1 ? u : u.slice(0, q);
  const rest = q === -1 ? '' : u.slice(q);
  return path.replace(/\/+$/, '') + rest;   // drop trailing slash on the path only
}

/**
 * Normalise an API token/key of ANY shape.
 * Tokens differ per provider: plain hex with no padding, base64 ending in one
 * "=", two "==", containing "+" or "/", or already percent-encoded. Users also
 * paste "token=VALUE", the full URL, or a value with stray quotes/newlines.
 * This reduces all of those to the exact literal the provider expects.
 */
function cleanToken(value, paramName) {
  let t = String(value == null ? '' : value).trim();
  if (!t) return '';
  t = t.replace(/^['"<]+|['">]+$/g, '').trim();          // quotes / angle brackets
  t = t.replace(/&amp;/gi, '&');
  // a whole URL was pasted into the token box -> take the token param out of it
  if (/^https?:\/\//i.test(t)) {
    try {
      const qp = new URL(t).searchParams;
      t = qp.get(paramName || 'token') || qp.get('token') || qp.get('api_key') || qp.get('key') || '';
    } catch (_) { /* fall through */ }
  }
  // "token=VALUE" or "?token=VALUE" pasted into the box
  const kv = t.match(/^[?&]?\s*[A-Za-z_][A-Za-z0-9_-]*\s*=\s*(.+)$/);
  if (kv && /^(token|api_key|apikey|key|auth|access_token)$/i.test(t.split('=')[0].replace(/^[?&]\s*/, '').trim())) {
    t = kv[1].trim();
  }
  // anything glued on after the token ("...ea2&dt1=2026-08-06")
  t = t.split('&')[0].trim();
  // already percent-encoded? decode so we control the encoding ourselves.
  // Only decode when it round-trips cleanly, so a literal "%" is never eaten.
  if (/%[0-9A-Fa-f]{2}/.test(t)) {
    try { const d = decodeURIComponent(t); if (encodeURIComponent(d) === encodeURIComponent(decodeURIComponent(t))) t = d; }
    catch (_) { /* malformed encoding -> keep as typed */ }
  }
  return t.replace(/\s+/g, '');   // internal spaces/newlines are never part of a key
}

/**
 * Serialise query parameters without over-encoding.
 * URLSearchParams turns "=" into "%3D" and "+" into "%2B". Both are legal, but
 * providers such as lamix compare the raw string and reject the encoded form.
 * These characters are unreserved inside a query value per RFC 3986, so they
 * are emitted literally; everything else is still encoded properly.
 */
function buildQuery(params) {
  const safe = (s) => encodeURIComponent(String(s))
    .replace(/%3D/g, '=')     // base64 padding
    .replace(/%2B/g, '+')     // base64 "+"
    .replace(/%2F/g, '/')     // base64 "/"
    .replace(/%3A/g, ':')     // times in dt1/dt2
    .replace(/%20/g, '%20');  // keep spaces encoded (a literal space breaks the URL)
  const out = [];
  for (const [k, v] of params) out.push(encodeURIComponent(k) + '=' + safe(v));
  return out.join('&');
}

/** Read a value from a dotted path, e.g. "data.messages" */
function dig(obj, path) {
  if (!path) return obj;
  return String(path).split('.').reduce((a, k) => (a && a[k] !== undefined ? a[k] : undefined), obj);
}

/* ------------------------------------------------------------------ *
 * Provider connectors
 *
 * A connector turns "provider config + since timestamp" into a normalised
 * array of records. To add a provider, add one entry here — nothing else
 * in the panel or the API needs to change.
 * ------------------------------------------------------------------ */

const CONNECTORS = {
  /**
   * Generic URL/JSON connector. Covers most HTTP providers.
   *
   * config JSON (stored per provider row):
   * {
   *   "url":            "https://provider.tld/api/messages",   // required
   *   "method":         "GET",                                  // GET | POST
   *   "auth":           "bearer" | "header" | "query" | "basic" | "none",
   *   "token":          "<api key / token>",
   *   "auth_header":    "X-API-Key",        // when auth = header
   *   "auth_query":     "api_key",          // when auth = query
   *   "auth_username":  "<username>",       // when auth = basic
   *   "auth_password":  "<password>",       // when auth = basic
   *   "since_param":    "start_date",       // query param carrying the cursor
   *   "since_format":   "sql" | "iso" | "epoch" | "epoch_ms",
   *   "window_param":   "seconds",          // relative-window providers (ZY SMS)
   *   "window_max_seconds": 3600,
   *   "date_timezone":  "UTC",              // only when response dates are naive UTC
   *   "page_param":     "page",             // header-paginated providers
   *   "limit_param":    "limit",
   *   "limit":          500,
   *   "extra_params":   { "status": "delivered" },
   *   "records_path":   "data.messages",    // where the array lives
   *   "map": {                              // provider field -> ams field
   *     "ref":     "message_id",
   *     "number":  "to",
   *     "cli":     "from",
   *     "message": "text",
   *     "date":    "created_at"
   *   }
   * }
   */
  generic_json: async function (cfg, sinceSql, log) {
    let url = cleanUrl(cfg.url);
    if (!url) throw new Error('provider config missing "url"');

    const method = String(cfg.method || 'GET').toUpperCase();
    // Some providers sit behind a WAF that rejects unknown/absent User-Agents
    // (astrasms.com returns 403 to python-urllib, for example). Always send a
    // normal one; it can be overridden per provider if a provider requires it.
    const headers = {
      'Accept': 'application/json',
      'User-Agent': String(cfg.user_agent || 'Mozilla/5.0 (compatible; GLOBAL-SMS-Sync/1.0)'),
    };
    const params = new URLSearchParams();

    // If the whole request URL was pasted (token/dt1/dt2/records already in it),
    // split it: keep the path as the base and treat its query as defaults. The
    // values we compute below always win, so a stale pasted dt1/dt2 is ignored.
    const pastedParams = new URLSearchParams();
    const qIdx = url.indexOf('?');
    if (qIdx !== -1) {
      const rawQs = url.slice(qIdx + 1);
      url = url.slice(0, qIdx);
      for (const [k, v] of new URLSearchParams(rawQs)) pastedParams.set(k, v);
    }

    // ---- authentication ----
    // Tokens come in every shape: plain hex, base64 with one "=", two "==",
    // "+" and "/", or already percent-encoded. cleanToken() normalises all of
    // them so the caller never has to know which kind they have.
    const authQueryName = cfg.auth_query || 'api_key';
    let token = cleanToken(cfg.token, authQueryName);
    if (!token && pastedParams.has(authQueryName)) token = cleanToken(pastedParams.get(authQueryName), authQueryName);

    const auth = String(cfg.auth || (token ? 'bearer' : 'none')).toLowerCase();
    if (auth === 'basic') {
      // ZY SMS/Zivastats uses HTTP Basic authentication. Do not run the
      // password through cleanToken(): passwords are not API tokens and may
      // legitimately contain characters that token cleanup would remove.
      const basicUser = String(cfg.auth_username || cfg.username || '');
      const basicPass = String(cfg.auth_password || cfg.password || '');
      let basicToken = '';
      if (basicUser || basicPass) basicToken = Buffer.from(`${basicUser}:${basicPass}`).toString('base64');
      else if (token) basicToken = token.replace(/^Basic/i, '');
      if (basicToken) headers['Authorization'] = 'Basic ' + basicToken;
    }
    else if (auth === 'bearer' && token) headers['Authorization'] = 'Bearer ' + token;
    else if (auth === 'header' && token) headers[cfg.auth_header || 'X-API-Key'] = token;
    else if (auth === 'query' && token) params.set(authQueryName, token);

    // ---- incremental cursor ----
    // Providers differ: some take one "since" param, many take a dt1/dt2 window
    // plus a "records" count. Both styles are supported via config.
    const fmtVal = (sql, fmt) => {
      const f = String(fmt || 'sql').toLowerCase();
      if (f === 'iso')      return String(sql).replace(' ', 'T') + 'Z';
      if (f === 'epoch')    return Math.floor(new Date(String(sql).replace(' ', 'T') + 'Z').getTime() / 1000);
      if (f === 'epoch_ms') return new Date(String(sql).replace(' ', 'T') + 'Z').getTime();
      if (f === 'date')     return String(sql).slice(0, 10);
      if (f === 'compact')  return String(sql).replace(/[-: ]/g, '');
      return sql;                                   // "sql" -> YYYY-MM-DD HH:MM:SS
    };
    const fmt = cfg.since_format || 'sql';
    if (cfg.since_param) params.set(cfg.since_param, String(fmtVal(sinceSql, fmt)));
    // dt1 / dt2 window style (dt2 defaults to "now" a little in the future so
    // that clock skew on the provider side cannot hide the newest rows)
    if (cfg.from_param) params.set(cfg.from_param, String(fmtVal(sinceSql, fmt)));
    if (cfg.to_param) {
      // __force_to is set by fetchAllPages() when walking backwards through a
      // truncated backlog. Normal polls leave it undefined and keep the
      // original "now + 60s" behaviour exactly as before.
      const upper = cfg.__force_to
        || new Date(Date.now() + 60000).toISOString().slice(0, 19).replace('T', ' ');
      params.set(cfg.to_param, String(fmtVal(upper, fmt)));
    }
    // Relative-window style (ZY SMS): the provider does not accept a cursor
    // timestamp; it accepts "records from the last N seconds". Convert the
    // normal GLOBAL cursor (already rewound by overlap) to that N, capped by the
    // provider maximum. A new/full sync therefore asks for the maximum window.
    if (cfg.window_param) {
      const sinceMs = new Date(String(sinceSql).replace(' ', 'T') + 'Z').getTime();
      const maxWindow = parseInt(cfg.window_max_seconds || cfg.max_window_seconds || 0, 10);
      const minWindow = Math.max(1, parseInt(cfg.window_min_seconds || 60, 10) || 60);
      let windowSeconds = Number.isFinite(sinceMs)
        ? Math.ceil((Date.now() - sinceMs) / 1000)
        : (maxWindow > 0 ? maxWindow : 3600);
      if (!Number.isFinite(windowSeconds) || windowSeconds < minWindow) windowSeconds = minWindow;
      if (maxWindow > 0) windowSeconds = Math.min(windowSeconds, maxWindow);
      params.set(cfg.window_param, String(Math.max(1, windowSeconds)));
    }
    // record count: default 50 as required
    const recParam = cfg.records_param || cfg.limit_param;
    if (recParam) params.set(recParam, String(cfg.records || cfg.limit || 50));
    for (const [k, v] of Object.entries(cfg.extra_params || {})) params.set(k, String(v));

    // Carry over any pasted params we did not generate ourselves (some
    // providers need an extra flag), without ever overriding our own values.
    for (const [k, v] of pastedParams) if (!params.has(k)) params.set(k, v);

    // ---- request ----
    // Build the query manually. URLSearchParams percent-encodes "=" to "%3D"
    // and "+" to "%2B" inside values; several providers (lamix included) reject
    // an encoded token even though it is technically correct. Token characters
    // that are safe unencoded in a query string are therefore left as-is.
    const pageParam = cfg.page_param || cfg.page_query || '';
    const pageSize = Math.max(0, parseInt(cfg.records || cfg.limit || 0, 10) || 0);
    const maxPages = Math.max(1, parseInt(cfg.max_pages || 20, 10) || 20);
    const pageDelayMs = Math.max(0, parseInt(cfg.page_delay_ms || 0, 10) || 0);

    const extractRows = (json) => {
      // Many providers (lamix/viewstats included) answer HTTP 200 with an error
      // body when the API key is wrong: {"status":"error","msg":"Not Authorized"}.
      // Without this check a bad key looks like "0 new messages" forever, which
      // is the worst possible failure mode - silent. Surface it as a real error
      // so it lands in sync_logs / last_error and stops the cursor advancing.
      if (json && !Array.isArray(json)) {
        const st = String(json.status ?? json.result ?? '').toLowerCase();
        if (st === 'error' || st === 'fail' || st === 'failed' || json.error) {
          const msg = String(json.msg || json.message || json.error || json.error_message
                             || 'provider returned an error');
          // "No Records Found" is NOT a failure. Both lamix and astrasms return
          // status=error with this message whenever the requested window simply
          // contains no SMS. Treating it as an error made every quiet poll fail,
          // triggering exponential backoff and freezing the cursor - which is
          // why a low-traffic provider appeared to "not work" while a busy one
          // seemed fine. An empty window must be a normal, successful, empty run.
          if (/no\s*record|no\s*data|not\s*found\s*record|empty/i.test(msg)) {
            return [];
          }
          throw new Error(`provider error: ${msg.slice(0, 200)}`);
        }
      }

      let rows = dig(json, cfg.records_path || '');
      if (!Array.isArray(rows)) {
        // tolerate common shapes without explicit records_path
        rows = Array.isArray(json) ? json
             : Array.isArray(json.data) ? json.data
             : Array.isArray(json.results) ? json.results
             : Array.isArray(json.messages) ? json.messages
             : [];
      }
      return rows;
    };

    const m = cfg.map || {};
    const assumeUtcDate = isUtcDateConfig(cfg);
    const mapRows = (rows) => rows.map(r => {
      // Payout is OPTIONAL and is only used as an indicator (see below).
      const payoutKeys = [m.payout || 'payout', 'payout', 'price', 'rate', 'amount', 'revenue'];
      let payoutRaw = null;
      for (const k of payoutKeys) {
        if (r && r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== '') { payoutRaw = r[k]; break; }
      }
      const number  = String(pick(r, [m.number  || 'to', 'to', 'number', 'msisdn', 'recipient', 'destination', 'destination_addr', 'destination_address', 'dest_addr', 'destination_number', 'called_number', 'dialed_number', 'did', 'num', 'ddi']));
      const cli     = String(pick(r, [m.cli     || 'from', 'from', 'cli', 'sender', 'originator', 'source', 'source_addr', 'source_address', 'src_addr', 'source_number', 'caller', 'caller_id', 'service']));
      const message = String(pick(r, [m.message || 'text', 'text', 'message', 'body', 'content', 'sms', 'short_message', 'message_content', 'msg_text', 'sms_text']));
      const rawDate = pick(r, [m.date || 'created_at', 'created_at', 'date', 'timestamp', 'received_at', 'time', 'datetime', 'dt', 'start_stamp', 'start_time', 'date_time', 'inserted_at', 'created', 'sms_date']);
      const date    = assumeUtcDate ? toUtcSql(rawDate, { assumeUtc: true }) : rawDate;

      // Unique reference. Many providers (including lamix/viewstats) return NO
      // id field at all, so fall back to a deterministic fingerprint of the
      // fields that identify a message. Same SMS -> same hash on every poll,
      // which is what makes the overlap window safe without a provider id.
      let ref = String(pick(r, [m.ref || 'id', 'id', 'message_id', 'sms_id', 'uuid', 'reference', 'msgid', 'inbound_id', 'allocation_id', 'record_id', 'cdr_id', 'sms_record_id']));
      let legacyRefs = [];
      if (!ref) {
        const fingerprintFor = (value) => 'fp:' + crypto.createHash('sha1')
          .update([value, number, cli, message].join('|'))
          .digest('hex').slice(0, 24);
        ref = fingerprintFor(toUtcSql(date, { assumeUtc: assumeUtcDate }));

        // Upgrade safety: before date_timezone=UTC existed, a non-UTC server
        // hashed Zivastats' naive UTC timestamp after a local-time parse.
        // Keep that old fingerprint as an alias for sync_seen lookups so
        // turning UTC parsing on cannot re-insert SMS from the last hour.
        if (assumeUtcDate) {
          const legacyRef = fingerprintFor(toUtcSql(rawDate));
          if (legacyRef && legacyRef !== ref) legacyRefs.push(legacyRef);
        }
      }

      return { ref, legacyRefs, number, cli, message, date, payoutRaw, raw: r };
    });

    const fetchPage = async (pageNo) => {
      const pageParams = new URLSearchParams(params);
      if (pageParam) pageParams.set(pageParam, String(pageNo));
      const qs = buildQuery(pageParams);
      const full = method === 'GET' && qs ? url + '?' + qs : url;
      const pageHeaders = { ...headers };
      const init = { method, headers: pageHeaders, signal: AbortSignal.timeout(Number(cfg.timeout_ms || 20000)) };
      if (method !== 'GET') {
        pageHeaders['Content-Type'] = 'application/json';
        init.body = JSON.stringify(Object.fromEntries(pageParams));
      }

      const res = await fetch(full, init);
      if (!res.ok) {
        let bodySnippet = '';
        try {
          const rawText = await res.text();
          bodySnippet = rawText
            .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
            .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic ***')
            .replace(/(token|key|api_key|password|secret|auth|access_token)[=:"']\s*([A-Za-z0-9._~+/-]{4,})/gi, '$1=***')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200);
        } catch (_) {}
        const detail = bodySnippet ? `: ${bodySnippet}` : '';
        throw new Error(`provider HTTP ${res.status}${detail}`);
      }
      const json = await res.json().catch(() => null);
      if (json === null) throw new Error('provider returned non-JSON');
      return { json, headers: res.headers };
    };

    const first = await fetchPage(1);
    let mapped = mapRows(extractRows(first.json));

    // Page-number pagination (ZY SMS sends X-Page-Count / X-Total-Count).
    // Providers without page_param keep the exact single-request behaviour;
    // dt1/dt2 backlog walking remains in fetchAllPages() below.
    if (pageParam) {
      const headerInt = (name) => {
        try { return parseInt(first.headers.get(name) || '', 10); } catch (_) { return NaN; }
      };
      let totalPages = headerInt('x-page-count');
      if (!Number.isFinite(totalPages) || totalPages < 1) totalPages = headerInt('x-pagination-page-count');
      if (!Number.isFinite(totalPages) || totalPages < 1) {
        let totalCount = headerInt('x-total-count');
        if (!Number.isFinite(totalCount)) totalCount = headerInt('x-pagination-total-count');
        const perPage = headerInt('x-per-page') || headerInt('x-pagination-per-page') || pageSize || mapped.length;
        if (Number.isFinite(totalCount) && perPage > 0) totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      }

      const seenRefs = new Set(mapped.map(r => r.ref).filter(Boolean));
      let lastPageCount = mapped.length;
      const lastPage = (Number.isFinite(totalPages) && totalPages > 1) ? Math.min(totalPages, maxPages) : maxPages;
      for (let pageNo = 2; pageNo <= lastPage; pageNo++) {
        // Without a trustworthy page-count header, only continue while the
        // previous page was exactly full. This prevents an endless duplicate
        // loop against a provider that ignores the page parameter.
        if ((!Number.isFinite(totalPages) || totalPages <= 1) && (!pageSize || lastPageCount < pageSize)) break;
        if (pageDelayMs) await new Promise(resolve => setTimeout(resolve, pageDelayMs));
        const next = await fetchPage(pageNo);
        const nextMapped = mapRows(extractRows(next.json));
        lastPageCount = nextMapped.length;
        if (!nextMapped.length) break;
        let added = 0;
        for (const rec of nextMapped) {
          if (rec.ref && seenRefs.has(rec.ref)) continue;
          if (rec.ref) seenRefs.add(rec.ref);
          mapped.push(rec);
          added++;
        }
        if (!added) break;
      }
    }

    return mapped;
  },
};

/* ------------------------------------------------------------------ *
 * Provider registry (database-backed)
 * ------------------------------------------------------------------ */

function listProviders(activeOnly = false) {
  const where = activeOnly ? 'WHERE active=1' : '';
  return db.all(`SELECT * FROM sync_providers ${where} ORDER BY id ASC`);
}

function getProvider(id) {
  return db.get('SELECT * FROM sync_providers WHERE id=?', [id]);
}

function parseConfig(row) {
  try { return JSON.parse(row.config_json || '{}'); } catch (_) { return {}; }
}

/**
 * Update a provider's bookkeeping row.
 *
 * PERFORMANCE: db.run() persists the ENTIRE database to disk (sql.js exports
 * the whole file on every write). Provider bookkeeping happens on every poll -
 * every 12s, forever, even when nothing was fetched - so using db.run() here
 * cost a full 18 MB export per call and blocked the event loop for ~30 ms.
 * runNoSave() keeps the write in memory; the caller decides when to persist.
 */
function markProvider(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.runNoSave(
    `UPDATE sync_providers SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`,
    [...keys.map(k => fields[k]), id]
  );
}

function logSync(providerId, status, fetched, inserted, duplicates, failed, ms, error) {
  try {
    // runNoSave for the same reason as markProvider: this runs on every poll.
    // Persisting is handled once per cycle by the caller.
    db.runNoSave(
      `INSERT INTO sync_logs (provider_id,status,fetched,inserted,duplicates,failed,duration_ms,error)
       VALUES (?,?,?,?,?,?,?,?)`,
      [providerId, status, fetched | 0, inserted | 0, duplicates | 0, failed | 0, ms | 0, String(error || '').slice(0, 500)]
    );
    // keep the log table small
    db.runNoSave(`DELETE FROM sync_logs WHERE id NOT IN (SELECT id FROM sync_logs ORDER BY id DESC LIMIT 2000)`);
  } catch (_) {}
}

/* ------------------------------------------------------------------ *
 * Backlog drain (window paging)
 * ------------------------------------------------------------------ *
 *
 * THE PROBLEM THIS SOLVES — measured, not theoretical.
 *
 * Providers of the CR-API family cap one response at a fixed number of rows
 * ("records: Number of records you want to fetch, Max value is 200") AND
 * return them NEWEST FIRST. Combine those two facts with a cursor that jumps
 * to the newest timestamp seen, and older records inside the same window are
 * silently skipped forever.
 *
 * Reproduced end-to-end against a mock built strictly from the provider's own
 * documentation (500 records waiting, cap 200, newest-first):
 *
 *     cycle 1 -> fetched=200 inserted=200   cursor moved to the NEWEST row
 *     cycle 2 -> fetched=31  duplicates=31  (only the overlap window)
 *     cycle 3 -> fetched=31  duplicates=31
 *     ------------------------------------------------
 *     provider had 500 | GLOBAL SMS ingested 200 | 300 PERMANENTLY MISSING
 *
 * 300 real SMS lost, with every log line saying "ok". That is the worst kind
 * of failure: invisible.
 *
 * THE FIX
 * When a response comes back completely full, the window is assumed to be
 * truncated. We re-query the SAME window but move the upper bound (`to_param`)
 * down to the oldest timestamp we just received, walking backwards until a
 * short page arrives. Verified on the same mock: 500/500 records recovered in
 * 3 rounds.
 *
 * SAFETY
 *  - Only ever activates when a page comes back exactly full. A provider that
 *    returns fewer rows than the cap behaves exactly as before — byte for byte
 *    the same single request.
 *  - Requires `to_param` to be configured. Providers without a window (single
 *    `since_param` style) are untouched.
 *  - Hard-capped by `max_pages` (default 20) so a provider that ignores dt2
 *    can never loop forever.
 *  - Stops immediately if a page yields no new refs, which is what happens if
 *    a provider clamps dt2 instead of honouring it.
 *  - Records are de-duplicated by ref here as well, so the caller's dedup
 *    ledger sees each message exactly once.
 * ------------------------------------------------------------------ */
async function fetchAllPages(connector, cfg, sinceSql, log) {
  const first = await connector(cfg, sinceSql, log);

  // Paging is only meaningful for the dt1/dt2 window style.
  const pageSize = Number(cfg.records || cfg.limit || 0);
  if (!cfg.to_param || !pageSize || !Array.isArray(first) || first.length < pageSize) {
    return first;
  }
  if (cfg.disable_paging) return first;

  const maxPages = Math.max(1, parseInt(cfg.max_pages || 20, 10));
  const out = first.slice();
  const seenRefs = new Set(first.map(r => r.ref));

  // Oldest timestamp in the page we just received.
  const oldestOf = (rows) => {
    let min = null;
    for (const r of rows) {
      const t = toUtcSql(r.date, { assumeUtc: isUtcDateConfig(cfg) });
      if (min === null || t < min) min = t;
    }
    return min;
  };

  let cursorTo = oldestOf(first);
  let pages = 1;

  while (pages < maxPages && cursorTo) {
    // Same window, but ask only for records at or before the oldest we have.
    const pageCfg = Object.assign({}, cfg, { __force_to: cursorTo });
    let rows;
    try {
      rows = await connector(pageCfg, sinceSql, log);
    } catch (e) {
      // A failed extra page must not lose the rows we already hold.
      if (log && log.warn) log.warn(`[SYNC] backlog page ${pages + 1} failed: ${e.message}`);
      break;
    }
    pages++;
    if (!Array.isArray(rows) || !rows.length) break;

    let added = 0;
    for (const r of rows) {
      if (r.ref && !seenRefs.has(r.ref)) { seenRefs.add(r.ref); out.push(r); added++; }
    }
    // No new refs -> the provider is not honouring dt2. Stop, do not loop.
    if (!added) break;

    const nextTo = oldestOf(rows);
    // Guard against a provider that returns the same window forever.
    if (!nextTo || nextTo >= cursorTo) break;
    cursorTo = nextTo;

    if (rows.length < pageSize) break;   // short page = backlog drained
  }

  if (pages > 1 && log && log.log) {
    log.log(`[SYNC] backlog drained in ${pages} page(s): ${out.length} record(s)`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * One sync cycle for one provider
 * ------------------------------------------------------------------ */

async function syncProvider(provider, deps, opts = {}) {
  const started = Date.now();
  const startedSql = new Date(started).toISOString().slice(0, 19).replace('T', ' ');
  const cfg = parseConfig(provider);
  const connector = CONNECTORS[provider.connector] || CONNECTORS.generic_json;
  const relativeWindow = !!cfg.window_param;
  const assumeUtcDate = isUtcDateConfig(cfg);

  // Cursor with safety overlap. A manual resync ignores the cursor entirely.
  const overlap = Math.max(0, parseInt(provider.overlap_seconds || 30, 10));
  const fullResync = !!opts.full;
  const cursor = provider.last_sync_at || '1970-01-01 00:00:00';
  const since = fullResync ? '1970-01-01 00:00:00' : shiftSql(cursor, -overlap);

  let fetched = 0, inserted = 0, duplicates = 0, failed = 0;
  let newest = provider.last_sync_at || '';

  // Did this cycle change anything that must reach disk? Bookkeeping alone
  // (cursor + log row) is NOT worth an 18 MB export on every 12s poll, so an
  // idle cycle now persists nothing and costs zero disk I/O.
  let dirty = false;

  try {
    const records = await fetchAllPages(connector, cfg, since, deps.log);
    fetched = records.length;

    if (fetched) {
      // Single transaction for the whole batch: one fsync instead of N.
      try { db.beginBatch && db.beginBatch(); } catch (_) {}
      try {
        for (const rec of records) {
          if (!rec.ref) { failed++; continue; }

          const receivedAt = toUtcSql(rec.date, { assumeUtc: assumeUtcDate });

          // Deduplicate on (provider_id, provider_ref). `legacyRefs` is only
          // present for the UTC-date upgrade described in the connector; all
          // existing connectors/providers continue with their single ref.
          let seen = db.get(
            'SELECT id FROM sync_seen WHERE provider_id=? AND provider_ref=?',
            [provider.id, rec.ref]
          );
          let seenByLegacy = false;
          if (!seen && Array.isArray(rec.legacyRefs)) {
            for (const legacyRef of rec.legacyRefs) {
              if (!legacyRef || legacyRef === rec.ref) continue;
              seen = db.get(
                'SELECT id FROM sync_seen WHERE provider_id=? AND provider_ref=?',
                [provider.id, legacyRef]
              );
              if (seen) { seenByLegacy = true; break; }
            }
          }
          if (seen) {
            duplicates++;
            if (seenByLegacy) {
              const alias = db.run(
                'INSERT OR IGNORE INTO sync_seen (provider_id,provider_ref,received_at) VALUES (?,?,?)',
                [provider.id, rec.ref, receivedAt]
              );
              if (alias && alias.changes) dirty = true;
            }
            continue;
          }

          // Reuse the exact ingestion path used by the live carrier webhook,
          // so allocation, payout, OTP extraction and limits behave identically.
          let ok = false;
          try {
            // Provider payout is an INDICATOR only. GLOBAL SMS always calculates the
            // displayed payout from its own rate cards - EXCEPT when the
            // provider explicitly reports 0, which marks the SMS non-payable.
            const providerPayout = rec.payoutRaw;
            const hasPayout = providerPayout !== null && providerPayout !== undefined && String(providerPayout).trim() !== '';
            const payoutNum = hasPayout ? parseFloat(String(providerPayout).replace(/[^0-9.\-]/g, '')) : NaN;
            const forceZeroPayout = hasPayout && isFinite(payoutNum) && payoutNum === 0;

            const result = deps.processIncomingSmsPayload(
              { headers: {}, query: {}, body: {} },                 // no HTTP request
              { number: rec.number, cli: rec.cli, message: rec.message },
              `provider:${provider.name}`,
              { source: 'api_sync', received_at: receivedAt, forceZeroPayout }
            );
            ok = result && result.status === 200;
            if (!ok) failed++;
          } catch (e) {
            failed++;
            deps.log.warn(`[SYNC] record failed (${provider.name}/${rec.ref}):`, e.message);
          }

          if (ok) {
            inserted++;
            dirty = true;
            // db.run (not runNoSave): inside a batch this only flags the batch
            // dirty, so the dedup ledger is guaranteed to be persisted by the
            // single save at the end of the cycle.
            db.run(
              'INSERT OR IGNORE INTO sync_seen (provider_id,provider_ref,received_at) VALUES (?,?,?)',
              [provider.id, rec.ref, receivedAt]
            );
          }
          if (receivedAt > newest) newest = receivedAt;
        }

        // Advance the cursor and write the log row INSIDE the batch so they
        // ride along with the single save below instead of forcing two more
        // full-database exports.
        //
        // Relative-window APIs (Zivastats `seconds=N`) need a different cursor
        // from dt1/dt2 APIs. Their window is calculated from the previous
        // successful poll, so store this poll's start time rather than the
        // newest SMS timestamp. If the first full-hour poll finds only a
        // 20-minute-old SMS, using that SMS time would keep asking for an
        // ever-growing/maximum window and re-fetch the same rows for an hour.
        // The configured overlap is still subtracted on the next poll, and
        // sync_seen still prevents an overlap row from being inserted twice.
        markProvider(provider.id, {
          last_sync_at: relativeWindow ? startedSql : (newest || nowUtcSql()),
          last_status: 'ok',
          last_error: '',
          consecutive_failures: 0,
        });
        logSync(provider.id, 'ok', fetched, inserted, duplicates, failed, Date.now() - started, '');
      } finally {
        // Persist once per cycle, and only when real rows were ingested.
        try {
          if (dirty) { db.endBatch && db.endBatch(); }
          else { db.endBatchNoSave ? db.endBatchNoSave() : (db.endBatch && db.endBatch()); }
        } catch (e) { deps.log.warn('[SYNC] batch save failed:', e.message); }
      }
    } else {
      // Idle poll: nothing fetched. Keep the cursor fresh in memory only - no
      // disk write at all. This is the common case and used to cost two full
      // 18 MB exports every 12 seconds.
      markProvider(provider.id, {
        last_sync_at: newest || nowUtcSql(),
        last_status: 'ok',
        last_error: '',
        consecutive_failures: 0,
      });
      logSync(provider.id, 'ok', fetched, inserted, duplicates, failed, Date.now() - started, '');
      markBookkeepingDirty();
    }

    if (fetched) {
      deps.log.log(`[SYNC] ${provider.name}: fetched=${fetched} new=${inserted} dup=${duplicates} failed=${failed} (${Date.now() - started}ms)`);
      // New rows are visible to every panel immediately: clear the read cache.
      try { deps.clearApiReadCache && deps.clearApiReadCache(); } catch (_) {}
    }
    return { ok: true, fetched, inserted, duplicates, failed };

  } catch (e) {
    // Cursor is deliberately NOT advanced, so nothing is skipped.
    const fails = (provider.consecutive_failures || 0) + 1;
    markProvider(provider.id, {
      last_status: 'error',
      last_error: String(e.message || e).slice(0, 500),
      consecutive_failures: fails,
    });
    logSync(provider.id, 'error', fetched, inserted, duplicates, failed, Date.now() - started, e.message);
    markBookkeepingDirty();
    deps.log.warn(`[SYNC] ${provider.name} failed (attempt ${fails}): ${e.message}`);
    return { ok: false, error: String(e.message || e) };
  }
}

/* ------------------------------------------------------------------ *
 * Scheduler
 * ------------------------------------------------------------------ */

let timer = null;
const inFlight = new Set();   // guards against overlapping cycles per provider

function defaultIntervalMs() {
  const s = parseInt(process.env.SYNC_INTERVAL_SECONDS || '12', 10);
  return Math.max(5, isNaN(s) ? 12 : s) * 1000;
}

async function runDueProviders(deps) {
  let providers = [];
  try { providers = listProviders(true); } catch (_) { return; }
  const now = Date.now();

  for (const p of providers) {
    if (inFlight.has(p.id)) continue;

    // Per-provider interval.
    const every = Math.max(5, parseInt(p.interval_seconds || 12, 10)) * 1000;
    const lastRun = p.__lastRunAt || 0;

    // Exponential backoff after repeated failures (capped at 5 minutes),
    // so a broken provider cannot hammer the API or the event loop.
    const fails = p.consecutive_failures || 0;
    const backoff = fails ? Math.min(300000, every * Math.pow(2, Math.min(fails, 5))) : 0;
    const wait = Math.max(every, backoff);

    const last = lastRunMap.get(p.id) || 0;
    if (now - last < wait) continue;

    lastRunMap.set(p.id, now);
    inFlight.add(p.id);
    // Fire and forget: a slow provider must not delay the others.
    syncProvider(p, deps).finally(() => inFlight.delete(p.id));
  }
}

const lastRunMap = new Map();

/**
 * Bookkeeping (cursor, status, log rows) is written in memory only, so an idle
 * provider costs zero disk I/O. Flush it to disk occasionally, and on shutdown,
 * so a restart cannot lose the cursor and re-pull old records.
 * One write every 5 minutes instead of 10 per minute.
 */
const BOOKKEEPING_FLUSH_MS = 5 * 60 * 1000;
let bookkeepingDirty = false;
let flushTimer = null;
function markBookkeepingDirty() { bookkeepingDirty = true; }
function flushBookkeeping(reason) {
  if (!bookkeepingDirty) return false;
  bookkeepingDirty = false;
  try { db.save(); return true; }
  catch (e) { bookkeepingDirty = true; console.warn('[SYNC] bookkeeping flush failed:', e.message); return false; }
}

function start(deps) {
  const enabled = String(process.env.SYNC_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) { deps.log.log('• Provider sync disabled (SYNC_ENABLED=false)'); return null; }
  if (timer) return timer;

  const tick = defaultIntervalMs();
  timer = setInterval(() => { runDueProviders(deps).catch(() => {}); }, tick);
  if (timer.unref) timer.unref();   // never keeps the process alive on shutdown

  // Periodically persist in-memory bookkeeping so a crash/restart cannot lose
  // the cursor. Far cheaper than saving on every poll.
  if (!flushTimer) {
    flushTimer = setInterval(() => { flushBookkeeping('interval'); }, BOOKKEEPING_FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();
    const onExit = () => { try { flushBookkeeping('exit'); } catch (_) {} };
    process.once('SIGINT', () => { onExit(); process.exit(0); });
    process.once('SIGTERM', () => { onExit(); process.exit(0); });
    process.once('beforeExit', onExit);
  }

  const count = (() => { try { return listProviders(true).length; } catch (_) { return 0; } })();
  deps.log.log(`• Provider sync active: scheduler every ${tick / 1000}s, ${count} active provider(s)`);
  return timer;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  flushBookkeeping('stop');
}

module.exports = {
  start,
  stop,
  syncProvider,
  flushBookkeeping,
  listProviders,
  getProvider,
  parseConfig,
  CONNECTORS,
  _internal: { toUtcSql, isUtcDateConfig, shiftSql, dig, pick, cleanUrl, cleanToken, buildQuery },
};
