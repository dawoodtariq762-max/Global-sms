/**
 * GLOBAL SMS — SMPP Connection Service
 * ---------------------------------------------------------------------------
 * ADDITIONAL channel. It does not touch the existing HTTP integrations.
 *
 *   Existing (untouched):
 *     HTTP push  : provider -> POST/GET /api/incoming-sms
 *     HTTP pull  : providerSync.js -> provider REST API every N seconds
 *
 *   Added here:
 *     SMPP client : GLOBAL SMS binds OUT to a provider's SMPP server (ESME)
 *     SMPP server : GLOBAL SMS LISTENS, the carrier binds IN to us
 *
 * All three converge on the SAME ingestion function that the carrier webhook
 * already uses (processIncomingSmsPayload), so allocation, rate cards, OTP
 * extraction, payout rules, daily limits and panel scoping behave identically
 * no matter which channel an SMS arrived on. Nothing in that function was
 * changed for SMPP.
 *
 * DESIGN NOTES
 *
 *  - Isolation: every connection runs in its own state object. One bad
 *    connection can never take down another, and an SMPP failure can never
 *    reach the Express request path — every callback is wrapped.
 *
 *  - Lazy require: the `smpp` package is only loaded when a connection is
 *    actually started. If the dependency is missing the rest of the panel
 *    still boots normally; the SMPP screen simply reports it.
 *
 *  - Reconnect: exponential backoff with jitter, capped by
 *    max_reconnect_seconds. Reconnect timers are unref()'d so they never hold
 *    the process open.
 *
 *  - Deduplication: SMPP links redeliver on any missing response, so every
 *    inbound message is keyed. If the PDU carries a receipted_message_id we
 *    use it; otherwise a deterministic fingerprint of
 *    (src|dst|text|time-bucket) is used, exactly like the HTTP pull path.
 *
 *  - Concatenated (multipart) SMS are reassembled before ingestion, so a long
 *    OTP message is stored as one row and the OTP regex sees the whole text.
 *
 *  - Back-pressure: inbound handling is synchronous and cheap (one DB write
 *    via the shared better-sqlite3 layer). No queue is needed, and the event
 *    loop is never blocked by network waits.
 */

const db = require('./db');
const crypto = require('crypto');
const net = require('net');

let smppLib = null;
let smppLoadError = '';
function getSmpp() {
  if (smppLib) return smppLib;
  try { smppLib = require('smpp'); }
  catch (e) { smppLoadError = e.message; throw new Error('SMPP library not installed: ' + e.message); }
  return smppLib;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function safeStr(v) {
  if (v === null || v === undefined) return '';
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return String(v);
}

/**
 * short_message arrives in several shapes depending on the peer and the
 * data_coding used: a plain string, a Buffer, or the library's decoded
 * { message, udh } object. Normalise all of them to text.
 */
function pduText(pdu) {
  const sm = pdu && pdu.short_message;
  if (sm === null || sm === undefined || sm === '') {
    // Some peers put long text in message_payload instead.
    return safeStr(pdu && pdu.message_payload);
  }
  if (typeof sm === 'string') return sm;
  if (Buffer.isBuffer(sm)) return sm.toString('utf8');
  if (typeof sm === 'object') {
    if (typeof sm.message === 'string') return sm.message;
    if (Buffer.isBuffer(sm.message)) return sm.message.toString('utf8');
  }
  return safeStr(sm);
}

/** UDH of a concatenated message, when the library exposes it. */
function pduUdh(pdu) {
  const sm = pdu && pdu.short_message;
  if (sm && typeof sm === 'object' && Array.isArray(sm.udh)) return sm.udh;
  return null;
}

function isDeliveryReceipt(pdu) {
  // esm_class bit 0x04 marks a delivery receipt rather than a real inbound SMS.
  const esm = Number(pdu && pdu.esm_class) || 0;
  if ((esm & 0x3c) === 0x04) return true;
  const t = pduText(pdu);
  return /^id:[^\s]+\s+sub:\d+/i.test(String(t).trim());
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/* ------------------------------------------------------------------ *
 * Database access
 * ------------------------------------------------------------------ */

function listConnections(activeOnly = false) {
  const where = activeOnly ? 'WHERE active=1' : '';
  return db.all(`SELECT * FROM smpp_connections ${where} ORDER BY id ASC`);
}

function getConnection(id) {
  return db.get('SELECT * FROM smpp_connections WHERE id=?', [id]);
}

/**
 * Runtime state write. runNoSave() is used for the same reason as in
 * providerSync.js: enquire_link keeps firing forever and must not cost a disk
 * flush every time. Real ingestion (which does flush) happens separately.
 */
function markConnection(id, fields) {
  const keys = Object.keys(fields || {});
  if (!keys.length) return;
  try {
    db.runNoSave(
      `UPDATE smpp_connections SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`,
      [...keys.map(k => fields[k]), id]
    );
  } catch (_) { /* never let bookkeeping break a live link */ }
}

const LOG_KEEP = 2000;
function logEvent(conn, event, level, detail, peer) {
  try {
    db.runNoSave(
      `INSERT INTO smpp_logs (connection_id,connection_name,event,level,detail,peer) VALUES (?,?,?,?,?,?)`,
      [conn ? conn.id : null, conn ? conn.name : '', event, level || 'info', String(detail || '').slice(0, 500), String(peer || '').slice(0, 80)]
    );
    if (Math.random() < 0.02) {
      db.runNoSave(`DELETE FROM smpp_logs WHERE id NOT IN (SELECT id FROM smpp_logs ORDER BY id DESC LIMIT ${LOG_KEEP})`);
    }
  } catch (_) {}
}

/* ------------------------------------------------------------------ *
 * Service state
 * ------------------------------------------------------------------ */

const runtime = new Map();   // connection id -> state
let deps = null;             // { log, processIncomingSmsPayload, clearApiReadCache }
let started = false;
let flushTimer = null;
let bookkeepingDirty = false;

function markDirty() { bookkeepingDirty = true; }

function flushBookkeeping() {
  if (!bookkeepingDirty) return;
  bookkeepingDirty = false;
  try { db.save && db.save(); } catch (_) {}
}

function stateOf(id) {
  if (!runtime.has(id)) {
    runtime.set(id, {
      id,
      session: null,
      server: null,
      sessions: new Set(),     // server mode: bound peer sessions
      status: 'stopped',
      reconnectTimer: null,
      enquireTimer: null,
      attempt: 0,
      stopping: false,
      parts: new Map(),        // concatenated SMS reassembly
    });
  }
  return runtime.get(id);
}

/* ------------------------------------------------------------------ *
 * Inbound message handling (shared by client and server modes)
 * ------------------------------------------------------------------ */

/**
 * Reassemble a concatenated (multipart) SMS.
 * Returns the full text once the last part arrives, otherwise null.
 */
function reassemble(st, key, udh, text) {
  // UDH 0x00 = 8-bit reference, 0x08 = 16-bit reference
  let ref = null, total = 0, seq = 0;
  for (const el of udh || []) {
    const id = Number(el.id);
    const data = el.value;
    if (!Buffer.isBuffer(data)) continue;
    if (id === 0x00 && data.length >= 3) { ref = data[0]; total = data[1]; seq = data[2]; break; }
    if (id === 0x08 && data.length >= 4) { ref = data.readUInt16BE(0); total = data[2]; seq = data[3]; break; }
  }
  if (ref === null || total < 2) return text;   // not concatenated

  const bucket = `${key}:${ref}:${total}`;
  let entry = st.parts.get(bucket);
  if (!entry) {
    entry = { total, parts: new Map(), at: Date.now() };
    st.parts.set(bucket, entry);
  }
  entry.parts.set(seq, text);

  // Drop stale half-assembled messages so the map cannot grow unbounded.
  if (st.parts.size > 500) {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [k, v] of st.parts) if (v.at < cutoff) st.parts.delete(k);
  }

  if (entry.parts.size < total) return null;    // still waiting
  st.parts.delete(bucket);
  let out = '';
  for (let i = 1; i <= total; i++) out += (entry.parts.get(i) || '');
  return out;
}

function dedupKeyFor(pdu, src, dst, text) {
  const rid = safeStr(pdu && (pdu.receipted_message_id || pdu.message_id)).trim();
  if (rid) return 'mid:' + rid;
  // No id from the peer: deterministic fingerprint, bucketed to 10s so a
  // genuine repeat of the same text minutes later is still stored.
  const bucket = Math.floor(Date.now() / 10000);
  return 'fp:' + crypto.createHash('sha1')
    .update([src, dst, text, bucket].join('|'))
    .digest('hex').slice(0, 24);
}

/**
 * Ingest one inbound SMPP message through the SAME path the HTTP carrier
 * webhook uses. Returns an SMPP command_status.
 */
function ingest(conn, st, pdu, peer) {
  const smpp = smppLib;
  const OK = 0;
  const ERR_SYS = (smpp && smpp.ESME_RSYSERR) || 0x00000008;

  try {
    if (isDeliveryReceipt(pdu)) {
      // Delivery receipts are acknowledgements of OUR submit_sm, not inbound
      // traffic. Log and accept; storing them would pollute sms_records.
      logEvent(conn, 'deliver', 'info', 'delivery receipt ignored', peer);
      markDirty();
      return OK;
    }

    const src = safeStr(pdu.source_addr).trim();
    const dst = safeStr(pdu.destination_addr).trim();
    let text = pduText(pdu);

    const udh = pduUdh(pdu);
    if (udh && udh.length) {
      const assembled = reassemble(st, `${src}|${dst}`, udh, text);
      if (assembled === null) return OK;      // wait for remaining parts
      text = assembled;
    }

    if (!dst) {
      logEvent(conn, 'deliver', 'warn', 'missing destination_addr', peer);
      markDirty();
      return OK;   // never NACK: the peer would redeliver this forever
    }

    // Duplicate suppression (SMPP peers redeliver aggressively).
    const key = dedupKeyFor(pdu, src, dst, text);
    const seen = db.get('SELECT sms_record_id FROM smpp_seen WHERE connection_id=? AND dedup_key=?', [conn.id, key]);
    if (seen) {
      logEvent(conn, 'deliver', 'info', `duplicate ignored (${key.slice(0, 28)})`, peer);
      markDirty();
      return OK;
    }

    // ---- shared ingestion path (unchanged code) ----
    const result = deps.processIncomingSmsPayload(
      { ip: peer || 'SMPP', smpp_connection: conn.name },
      { number: dst, cli: src, message: text },
      `smpp:${conn.name}`,
      { source: 'smpp' }
    );

    const ok = result && result.status === 200;
    if (ok) {
      const smsId = result.body && result.body.id ? result.body.id : null;
      try {
        db.run('INSERT OR IGNORE INTO smpp_seen (connection_id,dedup_key,sms_record_id,received_at) VALUES (?,?,?,?)',
          [conn.id, key, smsId, nowSql()]);
      } catch (_) {}
      db.runNoSave('UPDATE smpp_connections SET total_received=total_received+1, last_activity_at=? WHERE id=?', [nowSql(), conn.id]);
      logEvent(conn, 'deliver', 'info', `received from ${src || '?'} to ${dst}`, peer);
      try { deps.clearApiReadCache && deps.clearApiReadCache(); } catch (_) {}
    } else {
      const why = (result && result.body && result.body.error) || 'rejected';
      logEvent(conn, 'deliver', 'warn', `not stored: ${why} (${dst})`, peer);
    }
    markDirty();
    // Always ACK. A NACK makes the peer redeliver a message we have already
    // recorded in the Failed SMS queue, which is where the operator fixes it.
    return OK;
  } catch (e) {
    deps.log.warn(`[SMPP] ${conn.name}: ingest failed: ${e.message}`);
    logEvent(conn, 'error', 'error', 'ingest failed: ' + e.message, peer);
    markDirty();
    return ERR_SYS;
  }
}

/* ------------------------------------------------------------------ *
 * CLIENT mode — GLOBAL SMS binds OUT to the provider
 * ------------------------------------------------------------------ */

function scheduleReconnect(conn) {
  const st = stateOf(conn.id);
  if (st.stopping) return;
  if (st.reconnectTimer) return;

  const base = clampInt(conn.reconnect_seconds, 1, 3600, 10);
  const max = clampInt(conn.max_reconnect_seconds, base, 86400, 300);
  // Exponential backoff with jitter: a provider that is down does not get
  // hammered, and many connections do not all retry in the same instant.
  const backoff = Math.min(max, base * Math.pow(2, Math.min(st.attempt, 10)));
  const delay = Math.round((backoff * 0.7 + backoff * 0.3 * Math.random()) * 1000);

  st.status = 'reconnecting';
  markConnection(conn.id, { status: 'reconnecting' });
  logEvent(conn, 'reconnect', 'warn', `retry in ${Math.round(delay / 1000)}s (attempt ${st.attempt + 1})`);
  markDirty();

  st.reconnectTimer = setTimeout(() => {
    st.reconnectTimer = null;
    const fresh = getConnection(conn.id);
    if (!fresh || !fresh.active) return;
    startClient(fresh);
  }, delay);
  if (st.reconnectTimer.unref) st.reconnectTimer.unref();
}

function teardownClient(st) {
  if (st.enquireTimer) { clearInterval(st.enquireTimer); st.enquireTimer = null; }
  if (st.session) {
    try { st.session.removeAllListeners(); } catch (_) {}
    try { st.session.close(); } catch (_) {}
    try { st.session.destroy && st.session.destroy(); } catch (_) {}
    st.session = null;
  }
}

function startClient(conn) {
  const smpp = getSmpp();
  const st = stateOf(conn.id);
  st.stopping = false;
  teardownClient(st);

  if (!conn.host) {
    markConnection(conn.id, { status: 'error', last_error: 'host is required for client mode' });
    logEvent(conn, 'error', 'error', 'host is required for client mode');
    markDirty();
    return;
  }

  const port = clampInt(conn.port, 1, 65535, 2775);
  const scheme = conn.use_tls ? 'ssmpp' : 'smpp';
  const url = `${scheme}://${conn.host}:${port}`;

  st.status = 'connecting';
  markConnection(conn.id, { status: 'connecting', last_error: '' });
  logEvent(conn, 'bind', 'info', `connecting to ${url}`);
  markDirty();

  let session;
  try {
    session = smpp.connect(
      { url, connectTimeout: clampInt(conn.connect_timeout_ms, 1000, 120000, 15000) },
      () => onClientConnected(conn, session)
    );
  } catch (e) {
    markConnection(conn.id, { status: 'error', last_error: 'connect failed: ' + e.message, consecutive_failures: (conn.consecutive_failures || 0) + 1 });
    logEvent(conn, 'error', 'error', 'connect failed: ' + e.message);
    markDirty();
    st.attempt++;
    scheduleReconnect(conn);
    return;
  }

  st.session = session;

  // Every handler is guarded: an exception inside an SMPP callback must never
  // escape into the process and take the panel down.
  session.on('error', (e) => {
    const msg = (e && e.message) || String(e);
    if (st.status !== 'reconnecting') {
      markConnection(conn.id, { status: 'error', last_error: msg, consecutive_failures: (getConnection(conn.id) || {}).consecutive_failures + 1 || 1 });
      logEvent(conn, 'error', 'error', msg);
      markDirty();
    }
    st.attempt++;
    teardownClient(st);
    scheduleReconnect(conn);
  });

  session.on('close', () => {
    if (st.stopping) return;
    markConnection(conn.id, { status: 'disconnected' });
    logEvent(conn, 'unbind', 'warn', 'connection closed by peer');
    markDirty();
    st.attempt++;
    teardownClient(st);
    scheduleReconnect(conn);
  });

  session.on('deliver_sm', (pdu) => {
    let status = 0;
    try { status = ingest(conn, st, pdu, conn.host); }
    catch (e) { status = (smpp.ESME_RSYSERR || 8); }
    try { session.send(pdu.response({ command_status: status })); } catch (_) {}
  });

  // Some providers push via data_sm instead of deliver_sm.
  session.on('data_sm', (pdu) => {
    let status = 0;
    try { status = ingest(conn, st, pdu, conn.host); }
    catch (e) { status = (smpp.ESME_RSYSERR || 8); }
    try { session.send(pdu.response({ command_status: status })); } catch (_) {}
  });

  session.on('enquire_link', (pdu) => {
    try { session.send(pdu.response()); } catch (_) {}
  });

  session.on('unbind', (pdu) => {
    try { session.send(pdu.response()); } catch (_) {}
    try { session.close(); } catch (_) {}
  });
}

function onClientConnected(conn, session) {
  const smpp = smppLib;
  const st = stateOf(conn.id);

  const bindFn = {
    transceiver: 'bind_transceiver',
    receiver: 'bind_receiver',
    transmitter: 'bind_transmitter',
  }[String(conn.bind_type || 'transceiver').toLowerCase()] || 'bind_transceiver';

  const params = {
    system_id: conn.system_id || '',
    password: conn.password || '',
  };
  if (conn.system_type) params.system_type = conn.system_type;
  if (conn.address_range) params.address_range = conn.address_range;

  let responded = false;
  const bindTimeout = setTimeout(() => {
    if (responded) return;
    responded = true;
    logEvent(conn, 'error', 'error', 'bind timed out (no response from provider)');
    markConnection(conn.id, { status: 'error', last_error: 'bind timed out' });
    markDirty();
    st.attempt++;
    teardownClient(st);
    scheduleReconnect(conn);
  }, clampInt(conn.connect_timeout_ms, 1000, 120000, 15000));
  if (bindTimeout.unref) bindTimeout.unref();

  try {
    session[bindFn](params, (pdu) => {
      if (responded) return;
      responded = true;
      clearTimeout(bindTimeout);

      if (!pdu || pdu.command_status !== 0) {
        const code = pdu ? pdu.command_status : -1;
        const name = describeBindError(code);
        markConnection(conn.id, {
          status: 'error',
          last_error: `bind rejected: ${name}`,
          consecutive_failures: (getConnection(conn.id) || {}).consecutive_failures + 1 || 1,
        });
        logEvent(conn, 'bind', 'error', `bind rejected: ${name}`);
        markDirty();
        st.attempt++;
        teardownClient(st);
        scheduleReconnect(conn);
        return;
      }

      st.attempt = 0;
      st.status = 'bound';
      markConnection(conn.id, {
        status: 'bound',
        last_error: '',
        last_connected_at: nowSql(),
        last_activity_at: nowSql(),
        consecutive_failures: 0,
      });
      logEvent(conn, 'bind', 'info', `bound as ${bindFn.replace('bind_', '')} (system_id=${conn.system_id})`);
      markDirty();

      startEnquireLink(conn, session);
      // A link that just came up may have queued outbound messages waiting.
      setImmediate(() => { try { drainOutbox(conn.id); } catch (_) {} });
    });
  } catch (e) {
    if (!responded) {
      responded = true;
      clearTimeout(bindTimeout);
      logEvent(conn, 'error', 'error', 'bind failed: ' + e.message);
      markDirty();
      st.attempt++;
      teardownClient(st);
      scheduleReconnect(conn);
    }
  }
}

function describeBindError(code) {
  const smpp = smppLib || {};
  const map = {
    [smpp.ESME_RBINDFAIL || 0x0d]: 'bind failed',
    [smpp.ESME_RINVSYSID || 0x0f]: 'invalid system_id',
    [smpp.ESME_RINVPASWD || 0x0e]: 'invalid password',
    [smpp.ESME_RALYBND || 0x05]: 'already bound',
    [smpp.ESME_RINVSERTYP || 0x104]: 'invalid system_type',
  };
  return map[code] || `status 0x${Number(code || 0).toString(16)}`;
}

function startEnquireLink(conn, session) {
  const st = stateOf(conn.id);
  if (st.enquireTimer) clearInterval(st.enquireTimer);
  const secs = clampInt(conn.enquire_link_seconds, 5, 3600, 30);

  st.enquireTimer = setInterval(() => {
    if (!st.session) return;
    let answered = false;
    const t = setTimeout(() => {
      if (answered) return;
      // The socket looks open but the peer is not answering: this is the
      // classic "half-open link" that silently swallows traffic. Force a
      // reconnect rather than sitting there believing we are bound.
      logEvent(conn, 'error', 'warn', 'enquire_link timeout — forcing reconnect');
      markConnection(conn.id, { status: 'error', last_error: 'enquire_link timeout' });
      markDirty();
      st.attempt++;
      teardownClient(st);
      scheduleReconnect(conn);
    }, Math.min(secs * 1000, 20000));
    if (t.unref) t.unref();

    try {
      st.session.enquire_link({}, () => {
        answered = true;
        clearTimeout(t);
        markConnection(conn.id, { last_activity_at: nowSql() });
        markDirty();
      });
    } catch (e) {
      answered = true;
      clearTimeout(t);
    }
  }, secs * 1000);
  if (st.enquireTimer.unref) st.enquireTimer.unref();
}

/* ------------------------------------------------------------------ *
 * SERVER mode — the carrier binds IN to GLOBAL SMS
 * ------------------------------------------------------------------ */

function ipAllowed(conn, ip) {
  const list = String(conn.allowed_ips || '').split(/[\s,;]+/).filter(Boolean);
  if (!list.length) return true;                 // empty = allow any
  const clean = String(ip || '').replace(/^::ffff:/, '');
  return list.some(a => a.replace(/^::ffff:/, '') === clean);
}

function startServer(conn) {
  const smpp = getSmpp();
  const st = stateOf(conn.id);
  st.stopping = false;
  stopServer(st);

  const port = clampInt(conn.listen_port, 1, 65535, 0);
  if (!port) {
    markConnection(conn.id, { status: 'error', last_error: 'listen_port is required for server mode' });
    logEvent(conn, 'error', 'error', 'listen_port is required for server mode');
    markDirty();
    return;
  }

  const server = smpp.createServer({}, (session) => onPeerSession(conn, session));
  st.server = server;

  server.on('error', (e) => {
    const msg = (e && e.code === 'EADDRINUSE')
      ? `port ${port} is already in use`
      : ((e && e.message) || String(e));
    markConnection(conn.id, { status: 'error', last_error: msg });
    logEvent(conn, 'error', 'error', msg);
    markDirty();
    st.server = null;
    // Retry: the port may free up (e.g. an old process exiting).
    st.attempt++;
    scheduleServerRetry(conn);
  });

  try {
    server.listen(port, () => {
      st.attempt = 0;
      st.status = 'listening';
      markConnection(conn.id, { status: 'listening', last_error: '', last_connected_at: nowSql(), consecutive_failures: 0 });
      logEvent(conn, 'listen', 'info', `listening on port ${port}`);
      markDirty();
    });
  } catch (e) {
    markConnection(conn.id, { status: 'error', last_error: 'listen failed: ' + e.message });
    logEvent(conn, 'error', 'error', 'listen failed: ' + e.message);
    markDirty();
  }
}

function scheduleServerRetry(conn) {
  const st = stateOf(conn.id);
  if (st.stopping || st.reconnectTimer) return;
  const base = clampInt(conn.reconnect_seconds, 1, 3600, 10);
  const max = clampInt(conn.max_reconnect_seconds, base, 86400, 300);
  const delay = Math.min(max, base * Math.pow(2, Math.min(st.attempt, 8))) * 1000;
  st.reconnectTimer = setTimeout(() => {
    st.reconnectTimer = null;
    const fresh = getConnection(conn.id);
    if (fresh && fresh.active) startServer(fresh);
  }, delay);
  if (st.reconnectTimer.unref) st.reconnectTimer.unref();
}

function onPeerSession(conn, session) {
  const smpp = smppLib;
  const st = stateOf(conn.id);
  const peer = (session.socket && session.socket.remoteAddress) || '';

  session.on('error', () => { try { session.close(); } catch (_) {} });
  session.on('close', () => {
    st.sessions.delete(session);
    markConnection(conn.id, { status: st.sessions.size ? 'bound' : 'listening' });
    logEvent(conn, 'unbind', 'info', `peer disconnected (${st.sessions.size} bound)`, peer);
    markDirty();
  });

  const handleBind = (pdu, kind) => {
    try {
      if (!ipAllowed(conn, peer)) {
        logEvent(conn, 'bind', 'warn', `rejected: IP not allowed`, peer);
        markDirty();
        session.send(pdu.response({ command_status: smpp.ESME_RBINDFAIL }));
        setTimeout(() => { try { session.close(); } catch (_) {} }, 50);
        return;
      }
      const okId = String(conn.system_id || '');
      const okPw = String(conn.password || '');
      if (safeStr(pdu.system_id) !== okId || safeStr(pdu.password) !== okPw) {
        logEvent(conn, 'bind', 'warn', `rejected: bad credentials (system_id=${safeStr(pdu.system_id)})`, peer);
        markDirty();
        session.send(pdu.response({ command_status: smpp.ESME_RINVPASWD }));
        setTimeout(() => { try { session.close(); } catch (_) {} }, 50);
        return;
      }
      session.send(pdu.response({ system_id: 'GLOBAL SMS' }));  /* brand string in bind_resp (<=15 chars, informational) */
      st.sessions.add(session);
      markConnection(conn.id, { status: 'bound', last_error: '', last_connected_at: nowSql(), last_activity_at: nowSql(), consecutive_failures: 0 });
      logEvent(conn, 'bind', 'info', `peer bound as ${kind} (system_id=${okId})`, peer);
      markDirty();
    } catch (e) {
      try { session.close(); } catch (_) {}
    }
  };

  session.on('bind_transceiver', (pdu) => handleBind(pdu, 'transceiver'));
  session.on('bind_receiver', (pdu) => handleBind(pdu, 'receiver'));
  session.on('bind_transmitter', (pdu) => handleBind(pdu, 'transmitter'));

  session.on('enquire_link', (pdu) => {
    try { session.send(pdu.response()); markConnection(conn.id, { last_activity_at: nowSql() }); markDirty(); } catch (_) {}
  });

  session.on('unbind', (pdu) => {
    try { session.send(pdu.response()); session.close(); } catch (_) {}
  });

  // Carrier delivering an inbound SMS to us.
  session.on('submit_sm', (pdu) => {
    let status = 0, id = '';
    try {
      if (!st.sessions.has(session)) {
        status = smpp.ESME_RINVBNDSTS || 4;    // not bound
      } else {
        status = ingest(conn, st, pdu, peer);
        id = 'PX' + Date.now().toString(36);
      }
    } catch (e) { status = smpp.ESME_RSYSERR || 8; }
    try { session.send(pdu.response({ command_status: status, message_id: id })); } catch (_) {}
  });

  session.on('deliver_sm', (pdu) => {
    let status = 0;
    try { status = st.sessions.has(session) ? ingest(conn, st, pdu, peer) : (smpp.ESME_RINVBNDSTS || 4); }
    catch (e) { status = smpp.ESME_RSYSERR || 8; }
    try { session.send(pdu.response({ command_status: status })); } catch (_) {}
  });

  session.on('data_sm', (pdu) => {
    let status = 0;
    try { status = st.sessions.has(session) ? ingest(conn, st, pdu, peer) : (smpp.ESME_RINVBNDSTS || 4); }
    catch (e) { status = smpp.ESME_RSYSERR || 8; }
    try { session.send(pdu.response({ command_status: status })); } catch (_) {}
  });
}

function stopServer(st) {
  for (const s of st.sessions) { try { s.close(); } catch (_) {} }
  st.sessions.clear();
  if (st.server) {
    try { st.server.close(); } catch (_) {}
    st.server = null;
  }
}

/* ------------------------------------------------------------------ *
 * Outbound (submit_sm)
 * ------------------------------------------------------------------ */

/**
 * Queue a message. It is written to smpp_outbox first so nothing is lost if
 * the link is down; drainOutbox() sends it when a session is available.
 */
function queueOutbound(connectionId, destination, message, sourceAddr, userId) {
  const conn = getConnection(connectionId);
  if (!conn) throw new Error('Connection not found');
  const dst = String(destination || '').trim();
  if (!dst) throw new Error('destination is required');
  const text = String(message == null ? '' : message);
  if (!text) throw new Error('message is required');

  db.run(
    `INSERT INTO smpp_outbox (connection_id,destination,source_addr,message,status,created_by) VALUES (?,?,?,?,'queued',?)`,
    [connectionId, dst, String(sourceAddr || conn.default_source_addr || ''), text, userId || null]
  );
  const row = db.get('SELECT id FROM smpp_outbox ORDER BY id DESC LIMIT 1');
  setImmediate(() => { try { drainOutbox(connectionId); } catch (_) {} });
  return { ok: true, id: row ? row.id : null, status: 'queued' };
}

function pickSession(st) {
  if (st.session) return st.session;                       // client mode
  for (const s of st.sessions) return s;                   // server mode: first bound peer
  return null;
}

function drainOutbox(connectionId) {
  const conn = getConnection(connectionId);
  if (!conn) return;
  const st = stateOf(connectionId);
  const session = pickSession(st);
  if (!session) return;                    // not connected: stay queued

  const rows = db.all('SELECT * FROM smpp_outbox WHERE connection_id=? AND status=? ORDER BY id ASC LIMIT 50', [connectionId, 'queued']);
  for (const row of rows) {
    try {
      const params = {
        destination_addr: row.destination,
        short_message: row.message,
      };
      const src = row.source_addr || conn.default_source_addr || '';
      if (src) params.source_addr = src;

      db.runNoSave('UPDATE smpp_outbox SET attempts=attempts+1 WHERE id=?', [row.id]);

      session.submit_sm(params, (pdu) => {
        try {
          if (pdu && pdu.command_status === 0) {
            db.run(`UPDATE smpp_outbox SET status='sent', provider_message_id=?, error='', sent_at=? WHERE id=?`,
              [safeStr(pdu.message_id), nowSql(), row.id]);
            db.runNoSave('UPDATE smpp_connections SET total_sent=total_sent+1, last_activity_at=? WHERE id=?', [nowSql(), connectionId]);
            logEvent(conn, 'submit', 'info', `sent to ${row.destination}`);
          } else {
            const code = pdu ? `0x${Number(pdu.command_status).toString(16)}` : 'no response';
            db.run(`UPDATE smpp_outbox SET status='failed', error=? WHERE id=?`, [`submit_sm rejected (${code})`, row.id]);
            logEvent(conn, 'submit', 'error', `rejected for ${row.destination}: ${code}`);
          }
          markDirty();
        } catch (_) {}
      });
    } catch (e) {
      try {
        db.run(`UPDATE smpp_outbox SET status='failed', error=? WHERE id=?`, [String(e.message).slice(0, 300), row.id]);
        logEvent(conn, 'submit', 'error', `send failed for ${row.destination}: ${e.message}`);
        markDirty();
      } catch (_) {}
    }
  }
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

function startConnection(id) {
  const conn = getConnection(id);
  if (!conn) throw new Error('Connection not found');
  if (!conn.active) return { ok: false, error: 'Connection is not active' };
  if (!deps) return { ok: false, error: 'SMPP service is not running' };

  try { getSmpp(); }
  catch (e) {
    markConnection(id, { status: 'error', last_error: e.message });
    markDirty();
    return { ok: false, error: e.message };
  }

  stopConnection(id, true);
  const st = stateOf(id);
  st.attempt = 0;
  st.stopping = false;

  if (String(conn.mode) === 'server') startServer(conn);
  else startClient(conn);
  return { ok: true };
}

function stopConnection(id, silent) {
  const st = stateOf(id);
  st.stopping = true;
  if (st.reconnectTimer) { clearTimeout(st.reconnectTimer); st.reconnectTimer = null; }
  teardownClient(st);
  stopServer(st);
  st.status = 'stopped';
  st.parts.clear();
  if (!silent) {
    const conn = getConnection(id);
    markConnection(id, { status: 'stopped', last_error: '' });
    if (conn) logEvent(conn, 'unbind', 'info', 'stopped by operator');
    markDirty();
  }
  return { ok: true };
}

function restartConnection(id) {
  stopConnection(id, true);
  return startConnection(id);
}

function statusOf(id) {
  const conn = getConnection(id);
  if (!conn) return null;
  const st = runtime.get(id);
  return {
    id: conn.id,
    name: conn.name,
    mode: conn.mode,
    active: !!conn.active,
    status: conn.status || 'stopped',
    live: st ? st.status : 'stopped',
    bound_sessions: st ? (st.session ? 1 : st.sessions.size) : 0,
    last_error: conn.last_error || '',
    last_connected_at: conn.last_connected_at || '',
    last_activity_at: conn.last_activity_at || '',
    consecutive_failures: conn.consecutive_failures || 0,
    total_received: conn.total_received || 0,
    total_sent: conn.total_sent || 0,
    queued: (db.get('SELECT COUNT(*) c FROM smpp_outbox WHERE connection_id=? AND status=?', [id, 'queued']) || {}).c || 0,
  };
}

function start(d) {
  if (started) return;
  deps = d || {};
  if (!deps.log) deps.log = console;
  if (typeof deps.processIncomingSmsPayload !== 'function') {
    deps.log.warn('[SMPP] disabled: no ingestion function supplied');
    return;
  }
  started = true;

  const enabled = String(process.env.SMPP_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    deps.log.log('• SMPP service disabled (SMPP_ENABLED=false)');
    return;
  }

  // Any connection left in a live state by a previous run is stale after a
  // restart; reset so the UI never shows a bind that does not exist.
  try { db.runNoSave(`UPDATE smpp_connections SET status='stopped' WHERE status NOT IN ('stopped','error')`); db.save && db.save(); } catch (_) {}

  let list = [];
  try { list = listConnections(true); } catch (_) { list = []; }

  if (list.length) {
    try { getSmpp(); }
    catch (e) {
      deps.log.warn(`• SMPP: ${list.length} active connection(s) configured but library unavailable: ${e.message}`);
      return;
    }
  }

  for (const c of list) {
    try { startConnection(c.id); }
    catch (e) { deps.log.warn(`[SMPP] ${c.name}: start failed: ${e.message}`); }
  }

  // One periodic flush, mirroring providerSync's bookkeeping strategy: link
  // chatter must not cost a disk write every few seconds.
  flushTimer = setInterval(() => { try { flushBookkeeping(); } catch (_) {} }, 5 * 60 * 1000);
  if (flushTimer.unref) flushTimer.unref();

  // Retry anything still queued when a link recovers.
  const outboxTimer = setInterval(() => {
    try { for (const c of listConnections(true)) drainOutbox(c.id); } catch (_) {}
  }, 30000);
  if (outboxTimer.unref) outboxTimer.unref();

  deps.log.log(`• SMPP service active: ${list.length} connection(s) configured`);
}

function stop() {
  for (const id of Array.from(runtime.keys())) {
    try { stopConnection(id, true); } catch (_) {}
  }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  flushBookkeeping();
  started = false;
}

function onExit() {
  try { stop(); } catch (_) {}
}
process.once('SIGINT', onExit);
process.once('SIGTERM', onExit);
process.once('beforeExit', () => { try { flushBookkeeping(); } catch (_) {} });

module.exports = {
  start, stop,
  listConnections, getConnection,
  startConnection, stopConnection, restartConnection,
  statusOf,
  queueOutbound, drainOutbox,
  flushBookkeeping,
  isLibraryAvailable() { try { getSmpp(); return true; } catch (_) { return false; } },
  libraryError() { return smppLoadError; },
  _internal: { pduText, isDeliveryReceipt, dedupKeyFor, ipAllowed, clampInt, reassemble },
};
