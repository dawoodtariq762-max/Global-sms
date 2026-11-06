/**
 * GLOBAL SMS — Routing Connections Service
 * ---------------------------------------------------------------------------
 * ADDITIVE, TRANSPORT-AGNOSTIC inbound routing.
 *
 * The panel already had three ways for SMS to arrive:
 *   1. HTTP push  : provider -> POST/GET /api/incoming-sms   (carrier settings)
 *   2. HTTP pull  : providerSync.js -> provider REST API     (provider sync)
 *   3. SMPP       : smppService.js                           (client / server)
 *
 * What this file adds is NOT another ingestion engine. It adds *named,
 * per-partner connection endpoints* for the transports a partner may actually
 * offer, all of them converging on the SAME ingestion function the two HTTP
 * paths and SMPP already use (processIncomingSmsPayload). Allocation, rate
 * cards, OTP extraction, payout rules, daily limits, payment ledger,
 * de-duplication and panel scoping therefore behave exactly as before.
 *
 * Supported protocols
 *   http   HTTP/HTTPS or REST webhook receiver
 *          POST|GET /api/routing/in/:publicId   (token + optional IP allowlist)
 *   tcp    raw TCP socket listener
 *          framing: json (one JSON object) | line (one record per line)
 *                   | length4 (4-byte big-endian length prefix) | raw
 *   udp    datagram listener, same framing/parsing rules as tcp
 *   smpp   thin LINK to an existing smpp_connections row. No second SMPP
 *          engine is created: start/stop/status are delegated to smppService.
 *
 * Design rules
 *   - Isolation: one connector can never take down another, and no socket or
 *     HTTP failure can reach the Express request path — every callback is
 *     wrapped in try/catch.
 *   - Nothing here runs unless a connector row exists and is active.
 *   - No new parsing of business rules: an inbound message is turned into
 *     {number, cli, message} and handed to the shared ingester.
 *   - De-duplication: a provider-supplied id is passed through, so the
 *     existing api_integration_seen ledger rejects a retried delivery.
 *   - Zero impact on outbound SMS, rates, allocations, users or records.
 */

const db = require('./db');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');

let deps = null;                 // { log, processIncomingSmsPayload, clearApiReadCache }
let running = false;
const listeners = new Map();     // connector id -> { kind, server|socket, sockets:Set }

const PROTOCOLS = ['http', 'tcp', 'udp', 'smpp'];
const FRAMINGS = ['json', 'line', 'length4', 'raw'];

function nowSql() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}
function str(v) { return v === undefined || v === null ? '' : String(v); }

/* ------------------------------------------------------------------ *
 * Persistence helpers
 * ------------------------------------------------------------------ */
function listConnectors() {
  return db.all('SELECT * FROM routing_connectors ORDER BY id ASC');
}
function getConnector(id) {
  return db.get('SELECT * FROM routing_connectors WHERE id=?', [+id]);
}
function getByPublicId(publicId) {
  return db.get('SELECT * FROM routing_connectors WHERE public_id=?', [str(publicId)]);
}
function markConnector(id, fields) {
  const keys = Object.keys(fields || {});
  if (!keys.length) return;
  const set = keys.map(k => `${k}=?`).join(',');
  const vals = keys.map(k => fields[k]);
  try { db.run(`UPDATE routing_connectors SET ${set}, updated_at=datetime('now') WHERE id=?`, [...vals, +id]); }
  catch (e) { try { deps && deps.log.warn('[ROUTING] mark failed: ' + e.message); } catch (_) {} }
}
function logEvent(conn, event, level, detail, peer) {
  try {
    db.run('INSERT INTO routing_logs (connector_id,connector_name,event,level,detail,peer) VALUES (?,?,?,?,?,?)',
      [conn ? conn.id : null, conn ? conn.name : '', event, level || 'info', str(detail).slice(0, 400), str(peer).slice(0, 80)]);
    // keep the log table small the same way the SMPP log does
    db.runNoSave('DELETE FROM routing_logs WHERE id NOT IN (SELECT id FROM routing_logs ORDER BY id DESC LIMIT 5000)');
  } catch (_) {}
}
function recentLogs(connectorId, limit) {
  const n = clampInt(limit, 1, 500, 100);
  if (connectorId) return db.all('SELECT * FROM routing_logs WHERE connector_id=? ORDER BY id DESC LIMIT ?', [+connectorId, n]);
  return db.all('SELECT * FROM routing_logs ORDER BY id DESC LIMIT ?', [n]);
}

/* ------------------------------------------------------------------ *
 * Payload parsing / field mapping
 * ------------------------------------------------------------------ */
function dig(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[+part];
    else if (typeof cur === 'object') cur = cur[part];
    else return undefined;
  }
  return cur;
}

/** `{number}|{cli}|{message}` -> anchored regex with ordered captures. */
function templateRegex(tpl) {
  const parts = String(tpl).split(/(\{[A-Za-z0-9_]+\})/).filter(p => p !== '');
  let pattern = '';
  const keys = [];
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^\{([A-Za-z0-9_]+)\}$/);
    if (m) {
      keys.push(m[1]);
      const last = i === parts.length - 1;
      pattern += last ? '([\\s\\S]*)' : '([\\s\\S]*?)';
    } else {
      pattern += parts[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return { re: new RegExp('^' + pattern + '$'), keys };
}

/** Turn one raw frame into a plain object of fields. */
function frameToObject(conn, raw) {
  const text = str(raw).replace(/[\u0000]+$/g, '').trim();
  if (!text) return {};

  if (String(conn.framing || 'json') === 'json' || /^[[{]/.test(text)) {
    try {
      let parsed = JSON.parse(text);
      if (Array.isArray(parsed)) parsed = parsed[0] || {};
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) { /* fall through to template / delimited parsing */ }
  }

  const tpl = str(conn.template).trim();
  if (tpl) {
    const { re, keys } = templateRegex(tpl);
    const m = text.match(re);
    if (m) {
      const out = {};
      keys.forEach((k, i) => { out[k] = m[i + 1]; });
      return out;
    }
  }

  const delim = str(conn.delimiter) || '|';
  if (delim && text.includes(delim)) {
    const parts = text.split(delim);
    return { number: parts[0], cli: parts[1], message: parts.slice(2).join(delim) };
  }
  // Nothing structured: treat the whole frame as the message body. It will be
  // rejected by the ingester for a missing number, which is the correct,
  // visible outcome rather than a silent drop.
  return { message: text };
}

/**
 * Apply the per-connector field map. Auto-detection in
 * processIncomingSmsPayload already understands number/to/msisdn,
 * from/sender/cli, body/text/… so a map is only needed for exotic providers.
 */
function applyMapping(conn, obj) {
  const out = { ...obj };
  const map = {
    number: conn.map_number, cli: conn.map_cli, message: conn.map_message,
    id: conn.map_id, date: conn.map_date,
  };
  for (const [canon, path] of Object.entries(map)) {
    if (!str(path).trim()) continue;
    const v = dig(obj, path.trim());
    if (v !== undefined && v !== null && v !== '') out[canon] = v;
  }
  return out;
}

/** Shared ingestion — identical path to carrier webhook / SMPP. */
function ingest(conn, obj, peer) {
  if (!deps || typeof deps.processIncomingSmsPayload !== 'function') {
    return { status: 503, body: { ok: false, error: 'ingestion not available' } };
  }
  let result;
  try {
    result = deps.processIncomingSmsPayload(
      { ip: peer || 'routing' },
      obj,
      `${conn.protocol}:${conn.name}`,
      { source: 'routing_' + conn.protocol }
    );
  } catch (e) {
    logEvent(conn, 'error', 'error', 'ingest threw: ' + e.message, peer);
    markConnector(conn.id, { last_error: 'ingest failed: ' + e.message, last_event_at: nowSql(), consecutive_failures: (+conn.consecutive_failures || 0) + 1 });
    return { status: 500, body: { ok: false, error: e.message } };
  }

  const ok = result && result.status === 200;
  if (ok) {
    try { deps.clearApiReadCache && deps.clearApiReadCache(); } catch (_) {}
    markConnector(conn.id, {
      total_received: (+conn.total_received || 0) + 1,
      last_event_at: nowSql(), last_error: '', consecutive_failures: 0, status: conn.protocol === 'smpp' ? 'linked' : 'listening',
    });
    logEvent(conn, 'message', 'info',
      `accepted ${str(obj.number || obj.to || obj.msisdn).slice(0, 24)}` +
      (result.body && result.body.id ? ` -> SMS #${result.body.id}` : ''), peer);
  } else {
    markConnector(conn.id, {
      total_rejected: (+conn.total_rejected || 0) + 1,
      last_event_at: nowSql(),
      last_error: str(result && result.body && result.body.error).slice(0, 200),
    });
    logEvent(conn, 'reject', 'warn', str(result && result.body && result.body.error) || 'rejected', peer);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * HTTP / HTTPS / REST receiver
 * ------------------------------------------------------------------ */
function tokenOk(conn, headers, query, body) {
  const want = str(conn.token);
  if (!want) return true;
  const h = headers || {};
  const auth = str(h.authorization || h.Authorization || '');
  const provided = str(
    (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '') ||
    h['x-route-token'] || h['x-api-key'] ||
    (query && (query.token || query.key || query.secret)) ||
    (body && typeof body === 'object' && (body.token || body.secret))
  ).trim();
  if (!provided) return false;
  const a = Buffer.from(provided), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function ipAllowed(conn, ip) {
  const list = str(conn.allowed_ips).split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  if (!list.length) return true;
  const clean = s => str(s).replace(/^::ffff:/, '');
  const me = clean(ip);
  return list.some(entry => {
    const e = clean(entry);
    if (e === me) return true;
    if (e.includes('/')) {
      try {
        const [base, bitsStr] = e.split('/');
        const bits = clampInt(bitsStr, 0, 32, 32);
        const toLong = a => a.split('.').reduce((acc, o) => (acc << 8) + (parseInt(o, 10) || 0), 0) >>> 0;
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(base) || !/^\d+\.\d+\.\d+\.\d+$/.test(me)) return false;
        const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
        return (toLong(base) & mask) === (toLong(me) & mask);
      } catch (_) { return false; }
    }
    return false;
  });
}

/**
 * One inbound HTTP request. Called from the Express route in server.js so the
 * main HTTP listener's TLS/proxy configuration is reused — this service never
 * opens its own web port.
 */
function handleHttp(publicId, reqLike) {
  const conn = getByPublicId(publicId);
  if (!conn) return { status: 404, body: { ok: false, error: 'unknown routing endpoint' } };
  if (!conn.active) return { status: 403, body: { ok: false, error: 'connector is stopped' } };

  const ip = str(reqLike.ip);
  if (!ipAllowed(conn, ip)) {
    logEvent(conn, 'reject', 'warn', 'IP not allowed: ' + ip, ip);
    markConnector(conn.id, { total_rejected: (+conn.total_rejected || 0) + 1, last_error: 'IP not allowed: ' + ip, last_event_at: nowSql() });
    return { status: 403, body: { ok: false, error: 'IP not allowed', ip } };
  }
  if (!tokenOk(conn, reqLike.headers, reqLike.query, reqLike.body)) {
    logEvent(conn, 'reject', 'warn', 'invalid token', ip);
    markConnector(conn.id, { total_rejected: (+conn.total_rejected || 0) + 1, last_error: 'invalid token', last_event_at: nowSql() });
    return { status: 401, body: { ok: false, error: 'invalid or missing token' } };
  }

  // Body may already be parsed (json / urlencoded) or be a raw string (text).
  let obj = {};
  const body = reqLike.body;
  if (body && typeof body === 'object') obj = { ...body };
  else if (typeof body === 'string' && body.trim()) {
    obj = str(body).trim().startsWith('{') || str(body).trim().startsWith('[')
      ? (() => { try { const p = JSON.parse(body); return Array.isArray(p) ? (p[0] || {}) : (p || {}); } catch (_) { return frameToObject(conn, body); } })()
      : frameToObject(conn, body);
  }
  // Query string fills any gap (carriers that POST an empty body and pass
  // everything as ?number=&message=).
  if (reqLike.query && typeof reqLike.query === 'object') {
    for (const [k, v] of Object.entries(reqLike.query)) {
      if (k === 'token' || k === 'key' || k === 'secret') continue;
      if (v !== undefined && v !== '') obj[k] = v;
    }
  }

  const result = ingest(conn, applyMapping(conn, obj), ip);
  const ack = str(conn.response_ack).trim();
  return ack ? { ...result, body: ack, raw: true } : result;
}

/* ------------------------------------------------------------------ *
 * TCP / UDP listeners
 * ------------------------------------------------------------------ */
function parseFrames(conn, state, chunk) {
  const framing = String(conn.framing || 'json');
  const out = [];
  state.buf = Buffer.concat([state.buf || Buffer.alloc(0), chunk]);

  if (framing === 'length4') {
    while (state.buf.length >= 4) {
      const len = state.buf.readUInt32BE(0);
      if (len <= 0 || len > 1024 * 1024) { state.buf = Buffer.alloc(0); break; }
      if (state.buf.length < 4 + len) break;
      out.push(state.buf.slice(4, 4 + len).toString('utf8'));
      state.buf = state.buf.slice(4 + len);
    }
    return out;
  }

  if (framing === 'json') {
    // Newline-delimited JSON; a bare object is accepted once it parses.
    const text = state.buf.toString('utf8');
    const lines = text.split('\n');
    const rest = lines.pop();
    for (const line of lines) if (line.trim()) out.push(line);
    state.buf = Buffer.from(rest, 'utf8');
    if (state.buf.length) {
      const trimmed = state.buf.toString('utf8').trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try { JSON.parse(trimmed); out.push(trimmed); state.buf = Buffer.alloc(0); } catch (_) {}
      }
    }
    return out;
  }

  if (framing === 'raw') {
    // Whole payload is one message; flushed on 'end' by the caller.
    return out;
  }

  // line framing (default fallback)
  const text = state.buf.toString('utf8');
  const lines = text.split(/\r?\n/);
  state.buf = Buffer.from(lines.pop(), 'utf8');
  for (const line of lines) if (line.trim()) out.push(line);
  return out;
}

function handleFrame(conn, raw, peer) {
  try {
    const obj = frameToObject(conn, raw);
    if (!obj || !Object.keys(obj).length) {
      logEvent(conn, 'reject', 'warn', 'empty frame', peer);
      markConnector(conn.id, { total_rejected: (+conn.total_rejected || 0) + 1, last_event_at: nowSql() });
      return;
    }
    ingest(conn, applyMapping(conn, obj), peer);
  } catch (e) {
    logEvent(conn, 'error', 'error', 'frame handling failed: ' + e.message, peer);
  }
}

function startTcp(conn) {
  const port = clampInt(conn.listen_port, 1, 65535, 0);
  if (!port) throw new Error('listen_port is required');
  const host = str(conn.bind_host) || '0.0.0.0';

  const server = net.createServer({ allowHalfOpen: false }, socket => {
    const peer = (socket.remoteAddress || '').replace(/^::ffff:/, '');
    const state = { buf: Buffer.alloc(0) };
    try { socket.setNoDelay(true); } catch (_) {}
    // Idle sockets from a partner that never closes must not pile up.
    try { socket.setTimeout(10 * 60 * 1000, () => socket.destroy()); } catch (_) {}
    logEvent(conn, 'connection', 'info', 'peer connected', peer);
    const entry = listeners.get(conn.id);
    if (entry) entry.sockets.add(socket);

    socket.on('data', chunk => {
      let frames = [];
      try { frames = parseFrames(conn, state, chunk); } catch (e) { logEvent(conn, 'error', 'error', 'parse: ' + e.message, peer); }
      if (conn.framing === 'raw') {
        handleFrame(conn, chunk, peer);
        const ack = str(conn.response_ack) || 'OK';
        try { socket.write(ack + '\n'); } catch (_) {}
        return;
      }
      for (const f of frames) {
        handleFrame(conn, f, peer);
        const ack = str(conn.response_ack) || 'OK';
        try { socket.write(ack + '\n'); } catch (_) {}
      }
    });
    socket.on('end', () => {
      if (conn.framing === 'raw' && state.buf && state.buf.length) handleFrame(conn, state.buf.toString('utf8'), peer);
      try { socket.end(); } catch (_) {}
    });
    socket.on('error', e => logEvent(conn, 'error', 'warn', 'socket error: ' + e.message, peer));
    socket.on('close', () => {
      const e2 = listeners.get(conn.id);
      if (e2) e2.sockets.delete(socket);
    });
  });

  server.on('error', e => {
    markConnector(conn.id, { status: 'error', last_error: e.message, last_event_at: nowSql() });
    logEvent(conn, 'error', 'error', 'listen failed: ' + e.message);
  });
  server.on('listening', () => {
    markConnector(conn.id, { status: 'listening', last_error: '', last_event_at: nowSql(), consecutive_failures: 0 });
    logEvent(conn, 'start', 'info', `TCP listening on ${host}:${port}`);
  });
  server.unref && server.unref();
  server.listen(port, host);
  listeners.set(conn.id, { kind: 'tcp', server, sockets: new Set() });
  return { ok: true, status: 'listening', note: `TCP listening on ${host}:${port}` };
}

function startUdp(conn) {
  const port = clampInt(conn.listen_port, 1, 65535, 0);
  if (!port) throw new Error('listen_port is required');
  const host = str(conn.bind_host) || '0.0.0.0';
  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    const peer = (rinfo && rinfo.address) || '';
    try {
      if (conn.framing === 'length4' || conn.framing === 'json' || conn.framing === 'line') {
        const frames = parseFrames(conn, { buf: Buffer.alloc(0) }, msg);
        if (frames.length) frames.forEach(f => handleFrame(conn, f, peer));
        else handleFrame(conn, msg.toString('utf8'), peer);   // datagram is already a whole frame
      } else {
        handleFrame(conn, msg.toString('utf8'), peer);
      }
    } catch (e) { logEvent(conn, 'error', 'error', 'udp frame: ' + e.message, peer); }
  });
  socket.on('error', e => {
    markConnector(conn.id, { status: 'error', last_error: e.message, last_event_at: nowSql() });
    logEvent(conn, 'error', 'error', 'udp listen failed: ' + e.message);
    try { socket.close(); } catch (_) {}
    listeners.delete(conn.id);
  });
  socket.bind(port, host, () => {
    markConnector(conn.id, { status: 'listening', last_error: '', last_event_at: nowSql(), consecutive_failures: 0 });
    logEvent(conn, 'start', 'info', `UDP listening on ${host}:${port}`);
  });
  try { socket.unref(); } catch (_) {}
  listeners.set(conn.id, { kind: 'udp', socket, sockets: new Set() });
  return { ok: true, status: 'listening', note: `UDP listening on ${host}:${port}` };
}

/* ------------------------------------------------------------------ *
 * SMPP link (no second engine — delegates to smppService)
 * ------------------------------------------------------------------ */
function smppService() { return require('./smppService'); }

function startSmppLink(conn) {
  if (!conn.smpp_connection_id) throw new Error('smpp_connection_id is required for the smpp protocol');
  const svc = smppService();
  const target = svc.getConnection(+conn.smpp_connection_id);
  if (!target) throw new Error('linked SMPP connection no longer exists');
  const r = svc.startConnection(+conn.smpp_connection_id);
  const st = svc.statusOf(+conn.smpp_connection_id);
  listeners.set(conn.id, { kind: 'smpp', targetId: +conn.smpp_connection_id, sockets: new Set() });
  markConnector(conn.id, { status: 'linked', last_error: r && r.ok === false ? str(r.error) : '', last_event_at: nowSql() });
  logEvent(conn, 'start', 'info', `linked to SMPP connection "${target.name}" (${st && st.status})`);
  return { ok: true, status: 'linked', note: `Linked to SMPP connection "${target.name}" — ${st && st.status}` };
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */
function startConnector(id) {
  const conn = getConnector(id);
  if (!conn) throw new Error('Connector not found');
  stopListener(conn.id, { silent: true });
  markConnector(conn.id, { status: 'connecting', last_error: '' });
  let r;
  try {
    if (conn.protocol === 'tcp') r = startTcp(conn);
    else if (conn.protocol === 'udp') r = startUdp(conn);
    else if (conn.protocol === 'smpp') r = startSmppLink(conn);
    else {
      // http: served by the Express app; nothing to bind.
      if (!str(conn.public_id)) markConnector(conn.id, { public_id: newPublicId() });
      listeners.set(conn.id, { kind: 'http', sockets: new Set() });
      markConnector(conn.id, { status: 'listening', last_error: '', last_event_at: nowSql() });
      logEvent(conn, 'start', 'info', 'HTTP receiver active at /api/routing/in/' + (conn.public_id || '(new)'));
      r = { ok: true, status: 'listening', note: 'HTTP receiver active' };
    }
  } catch (e) {
    markConnector(conn.id, { status: 'error', last_error: e.message, last_event_at: nowSql(), consecutive_failures: (+conn.consecutive_failures || 0) + 1 });
    logEvent(conn, 'error', 'error', 'start failed: ' + e.message);
    return { ok: false, error: e.message };
  }
  return r;
}

function stopListener(id, opts) {
  const entry = listeners.get(+id);
  if (!entry) return;
  try {
    if (entry.kind === 'tcp' && entry.server) {
      try { entry.sockets.forEach(s => { try { s.destroy(); } catch (_) {} }); } catch (_) {}
      try { entry.server.close(); } catch (_) {}
    } else if (entry.kind === 'udp' && entry.socket) {
      try { entry.socket.close(); } catch (_) {}
    } else if (entry.kind === 'smpp' && entry.targetId) {
      try { smppService().stopConnection(entry.targetId); } catch (_) {}
    }
  } catch (_) {}
  listeners.delete(+id);
  if (!opts || !opts.silent) logEvent(getConnector(id), 'stop', 'info', 'connector stopped');
}

function stopConnector(id) {
  const conn = getConnector(id);
  if (!conn) throw new Error('Connector not found');
  stopListener(conn.id);
  markConnector(conn.id, { status: 'stopped', last_event_at: nowSql() });
  return { ok: true, status: 'stopped' };
}

function restartConnector(id) {
  stopConnector(id);
  return startConnector(id);
}

function newPublicId() { return crypto.randomBytes(12).toString('hex'); }

function statusOf(id) {
  const conn = getConnector(id);
  if (!conn) return null;
  const entry = listeners.get(conn.id);
  let live = 'stopped';
  if (entry) {
    if (entry.kind === 'http') live = 'listening';
    else if (entry.kind === 'tcp') live = entry.server && entry.server.listening ? 'listening' : 'stopped';
    else if (entry.kind === 'udp') live = 'listening';
    else if (entry.kind === 'smpp') {
      const st = smppService().statusOf(entry.targetId);
      live = st ? st.status : 'stopped';
    }
  }
  return {
    id: conn.id, name: conn.name, protocol: conn.protocol, active: !!conn.active,
    status: conn.status, live,
    last_error: conn.last_error, last_event_at: conn.last_event_at,
    total_received: conn.total_received, total_rejected: conn.total_rejected,
    endpoint: conn.protocol === 'http' ? '/api/routing/in/' + (conn.public_id || '') : '',
    listen: conn.protocol === 'tcp' || conn.protocol === 'udp' ? `${conn.bind_host || '0.0.0.0'}:${conn.listen_port || 0}` : '',
    smpp_connection_id: conn.smpp_connection_id || null,
  };
}

/* ------------------------------------------------------------------ *
 * CRUD
 * ------------------------------------------------------------------ */
function sanitize(data) {
  const d = data || {};
  const protocol = PROTOCOLS.includes(str(d.protocol).toLowerCase()) ? str(d.protocol).toLowerCase() : 'http';
  const out = {
    name: str(d.name).trim(),
    protocol,
    direction: str(d.direction).trim() || 'inbound',
    active: d.active ? 1 : 0,
    notes: str(d.notes),
    token: str(d.token),
    allowed_ips: str(d.allowed_ips),
    response_ack: str(d.response_ack),
    bind_host: str(d.bind_host) || '0.0.0.0',
    listen_port: clampInt(d.listen_port, 0, 65535, 0),
    framing: FRAMINGS.includes(str(d.framing).toLowerCase()) ? str(d.framing).toLowerCase() : 'json',
    delimiter: str(d.delimiter) || '|',
    template: str(d.template),
    payload_encoding: str(d.payload_encoding) || 'utf8',
    map_number: str(d.map_number),
    map_cli: str(d.map_cli),
    map_message: str(d.map_message),
    map_id: str(d.map_id),
    map_date: str(d.map_date),
    smpp_connection_id: d.smpp_connection_id ? +d.smpp_connection_id : null,
  };
  return out;
}

function createConnector(data) {
  const c = sanitize(data);
  if (!c.name) throw new Error('name is required');
  const publicId = newPublicId();
  db.run(`INSERT INTO routing_connectors
    (name,protocol,direction,active,notes,public_id,token,allowed_ips,response_ack,bind_host,listen_port,
     framing,delimiter,template,payload_encoding,map_number,map_cli,map_message,map_id,map_date,smpp_connection_id,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'stopped')`,
    [c.name, c.protocol, c.direction, c.active, c.notes, publicId, c.token, c.allowed_ips, c.response_ack,
     c.bind_host, c.listen_port, c.framing, c.delimiter, c.template, c.payload_encoding,
     c.map_number, c.map_cli, c.map_message, c.map_id, c.map_date, c.smpp_connection_id]);
  const row = db.get('SELECT * FROM routing_connectors WHERE name=?', [c.name]);
  if (!row) throw new Error('create failed');
  logEvent(row, 'create', 'info', `connector created (${row.protocol})`);
  if (row.active) { try { startConnector(row.id); } catch (e) { markConnector(row.id, { status: 'error', last_error: e.message }); } }
  return getConnector(row.id);
}

function updateConnector(id, data) {
  const cur = getConnector(id);
  if (!cur) throw new Error('Connector not found');
  const c = sanitize({ ...cur, ...data });
  if (!c.name) throw new Error('name is required');
  db.run(`UPDATE routing_connectors SET
      name=?,protocol=?,direction=?,active=?,notes=?,token=?,allowed_ips=?,response_ack=?,bind_host=?,
      listen_port=?,framing=?,delimiter=?,template=?,payload_encoding=?,map_number=?,map_cli=?,map_message=?,
      map_id=?,map_date=?,smpp_connection_id=?,updated_at=datetime('now')
    WHERE id=?`,
    [c.name, c.protocol, c.direction, c.active, c.notes, c.token, c.allowed_ips, c.response_ack, c.bind_host,
     c.listen_port, c.framing, c.delimiter, c.template, c.payload_encoding, c.map_number, c.map_cli, c.map_message,
     c.map_id, c.map_date, c.smpp_connection_id, +id]);
  const after = getConnector(id);
  // Apply changes immediately: running -> restart, stopped -> stay stopped.
  if (after.active) { try { restartConnector(id); } catch (e) { markConnector(id, { status: 'error', last_error: e.message }); } }
  else { try { stopConnector(id); } catch (_) {} }
  return getConnector(id);
}

function deleteConnector(id) {
  const cur = getConnector(id);
  if (!cur) throw new Error('Connector not found');
  try { stopConnector(id); } catch (_) {}
  try { db.run('DELETE FROM routing_logs WHERE connector_id=?', [+id]); } catch (_) {}
  db.run('DELETE FROM routing_connectors WHERE id=?', [+id]);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Connectivity test
 * ------------------------------------------------------------------ */
async function testConnector(id) {
  const conn = getConnector(id);
  if (!conn) throw new Error('Connector not found');

  if (conn.protocol === 'http') {
    const path = '/api/routing/in/' + (conn.public_id || '');
    return {
      ok: true, protocol: 'http',
      endpoint: path,
      active: !!conn.active,
      requires_token: !!str(conn.token),
      allowed_ips: str(conn.allowed_ips) || 'any',
      note: conn.active
        ? `Receiver is live. POST ${path} with ${str(conn.token) ? 'the token' : 'no token'} — JSON, form or query-string fields all accepted.`
        : 'Receiver is created but the connector is stopped. Start it to accept messages.',
    };
  }

  if (conn.protocol === 'smpp') {
    if (!conn.smpp_connection_id) return { ok: false, error: 'No SMPP connection linked' };
    const svc = smppService();
    const st = svc.statusOf(+conn.smpp_connection_id);
    const target = svc.getConnection(+conn.smpp_connection_id);
    return {
      ok: !!(st && (st.status === 'bound' || st.status === 'listening')),
      protocol: 'smpp',
      linked: target ? target.name : '(missing)',
      status: st ? st.status : 'unknown',
      note: st && st.status === 'bound'
        ? 'Bound to the SMPP peer.'
        : st && st.status === 'listening'
          ? `Listening on port ${st.listen_port || target?.listen_port}. Waiting for the peer to bind.`
          : 'Not connected — use the SMPP Connections screen for bind diagnostics.',
    };
  }

  // tcp / udp: is it listening, or can the port be bound at all?
  const entry = listeners.get(conn.id);
  if (entry) {
    const live = statusOf(conn.id);
    return { ok: live.live === 'listening', protocol: conn.protocol, listen: live.listen, active: true, note: `Listening on ${live.listen}` };
  }
  const port = clampInt(conn.listen_port, 1, 65535, 0);
  if (!port) return { ok: false, error: 'listen_port is required' };
  const host = str(conn.bind_host) || '0.0.0.0';
  return await new Promise(resolve => {
    if (conn.protocol === 'udp') {
      const s = dgram.createSocket('udp4');
      s.once('error', e => { try { s.close(); } catch (_) {} resolve({ ok: false, protocol: 'udp', error: e.message }); });
      s.bind(port, host, () => { try { s.close(); } catch (_) {} resolve({ ok: true, protocol: 'udp', listen: `${host}:${port}`, note: 'Port is free — start the connector to listen.' }); });
      return;
    }
    const srv = net.createServer();
    srv.once('error', e => resolve({ ok: false, protocol: 'tcp', error: e.message }));
    srv.listen(port, host, () => { try { srv.close(); } catch (_) {} resolve({ ok: true, protocol: 'tcp', listen: `${host}:${port}`, note: 'Port is free — start the connector to listen.' }); });
  });
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */
function start(d) {
  deps = d || {};
  if (!deps.log) deps.log = console;
  // make sure the additive tables exist even on an old database file
  try {
    require('./schema').createTables();
  } catch (e) { deps.log.warn('[ROUTING] schema ensure failed: ' + e.message); }
  running = true;
  if (String(process.env.ROUTING_ENABLED || 'true').toLowerCase() === 'false') {
    deps.log.log('• Routing connectors disabled (ROUTING_ENABLED=false)');
    return;
  }
  let list = [];
  try { list = listConnectors().filter(c => c.active); } catch (e) { deps.log.warn('[ROUTING] list failed: ' + e.message); }
  for (const c of list) {
    try { startConnector(c.id); } catch (e) { deps.log.warn(`[ROUTING] ${c.name}: start failed: ${e.message}`); }
  }
  deps.log.log(`• Routing connectors active: ${list.length} connection(s) configured (http/tcp/udp/smpp)`);
}

module.exports = {
  start,
  isRunning() { return running; },
  listConnectors, getConnector, getByPublicId, statusOf,
  createConnector, updateConnector, deleteConnector,
  startConnector, stopConnector, restartConnector,
  testConnector,
  handleHttp,
  recentLogs,
  _internal: { frameToObject, applyMapping, templateRegex, ipAllowed, tokenOk, parseFrames },
};
