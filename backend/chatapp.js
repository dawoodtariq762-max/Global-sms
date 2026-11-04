/**
 * backend/chatapp.js — CHAT SYSTEM (Admin <-> Manager <-> Agent)
 *
 * Hierarchy (spec 3B):
 *   1. Agent   <-> their Manager          (agent.parent_id)
 *   2. Manager <-> Admin                  (manager.parent_id, else the admin)
 *   3. Admin   reviews every conversation inside their tree.
 * Every rule is enforced server-side on every request — the UI merely hides
 * what the server would refuse anyway.
 *
 * Receipts (spec 3F) — deliberately conservative:
 *   1 tick    message is stored                      (created_at)
 *   2 grey    recipient has a LIVE stream connection (delivered_at)
 *   2 blue    recipient posted an explicit read      (read_at)
 * We never blue a tick just because the recipient's panel happens to be open.
 *
 * Attachments (spec 3E): TXT / CSV / video only. Stored outside the web root
 * under the data directory with a random filename, served only through an
 * authenticated, conversation-authorised download route.
 */
'use strict';
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('./db');

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */
const UPLOAD_DIR = process.env.CHAT_UPLOAD_DIR
  || path.join(process.env.DATA_DIR || path.dirname(process.env.DB_FILE || path.join(__dirname, 'data.sqlite')), 'chat-uploads');
const MAX_UPLOAD = parseInt(process.env.CHAT_MAX_UPLOAD_MB || '25', 10) * 1024 * 1024;

const ALLOWED = {
  'text/plain': ['.txt', '.text'],
  'text/csv': ['.csv'],
  'application/csv': ['.csv'],
  'video/mp4': ['.mp4'],
  'video/webm': ['.webm'],
  'video/quicktime': ['.mov'],
  'video/x-msvideo': ['.avi'],
  'video/x-matroska': ['.mkv'],
};
const ALLOWED_EXT = new Set(['.txt', '.text', '.csv', '.mp4', '.webm', '.mov', '.avi', '.mkv']);
const BODY_MAX = 4000;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
function pair(a, b) {
  const x = Math.min(parseInt(a, 10), parseInt(b, 10));
  const y = Math.max(parseInt(a, 10), parseInt(b, 10));
  return [x, y];
}
function isoZ(sqlUtc) {
  const s = String(sqlUtc || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}.000Z` : null;
}
function safeName(n) {
  return String(n || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file';
}
function ensureDir() {
  try { fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 }); } catch (e) {}
}
ensureDir();

/* Live-stream registry: userId -> Set<{res}> */
const streams = new Map();
function addStream(uid, entry) {
  if (!streams.has(uid)) streams.set(uid, new Set());
  streams.get(uid).add(entry);
}
function delStream(uid, entry) {
  const s = streams.get(uid);
  if (s) { s.delete(entry); if (!s.size) streams.delete(uid); }
}
function pushTo(uid, event, data) {
  const s = streams.get(uid);
  if (!s) return 0;
  let n = 0;
  for (const e of s) {
    try { e.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); n++; }
    catch (_) { /* dead socket, swept up on close */ }
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* presence (spec 4)                                                   */
/* ------------------------------------------------------------------ */
/* How long a heartbeat may be missed before the session is considered
 * gone. The SSE heartbeat fires every 25s, so 70s tolerates a couple of
 * missed beats without flapping on a slow network. */
const PRESENCE_TTL_MS = parseInt(process.env.CHAT_PRESENCE_TTL_MS || '70000', 10);

const ONLINE = [];   // user ids whose online flag we have broadcast

function isOnline(uid) {
  try {
    const r = db.get('SELECT online FROM chat_presence WHERE user_id=?', [uid]);
    return !!(r && r.online);
  } catch (e) { return false; }
}

/** Users we should tell a given user about (their conversation partners). */
function peersOf(uid) {
  const rows = db.all(
    `SELECT DISTINCT CASE WHEN a_id=? THEN b_id ELSE a_id END other
       FROM chat_conversations WHERE a_id=? OR b_id=?`, [uid, uid, uid]);
  return rows.map(r => r.other).filter(Boolean);
}

function setPresence(uid, online) {
  try {
    db.run(`INSERT INTO chat_presence (user_id, online, last_seen, since, updated_at)
            VALUES (?,?, datetime('now'), ?, datetime('now'))
            ON CONFLICT(user_id) DO UPDATE SET
              online=excluded.online,
              last_seen=datetime('now'),
              since=CASE WHEN chat_presence.online=excluded.online
                         THEN chat_presence.since ELSE datetime('now') END,
              updated_at=datetime('now')`,
      [uid, online ? 1 : 0, online ? new Date().toISOString() : null]);
  } catch (e) { /* presence must never break chat */ }
}

/** Broadcast a user's presence to everyone who shares a conversation with them. */
function broadcastPresence(uid) {
  const online = isOnline(uid);
  for (const p of peersOf(uid)) pushTo(p, 'presence', { user_id: uid, online });
}

/**
 * Mark every message addressed to `uid` that has not yet been delivered as
 * delivered, and tell each sender. Runs when a session comes up.
 */
function sweepDelivered(uid) {
  try {
    const rows = db.all(
      `SELECT m.id, m.conversation_id FROM chat_messages m
         JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE (c.a_id=? OR c.b_id=?) AND m.sender_id!=? AND m.delivered_at IS NULL`,
      [uid, uid, uid]);
    for (const m of rows) {
      db.run(`UPDATE chat_messages SET delivered_at=datetime('now') WHERE id=? AND delivered_at IS NULL`, [m.id]);
      const conv = db.get('SELECT a_id, b_id FROM chat_conversations WHERE id=?', [m.conversation_id]);
      const otherId = conv.a_id === uid ? conv.b_id : conv.a_id;
      pushTo(otherId, 'delivered', { conversation_id: m.conversation_id, message_id: m.id });
    }
    return rows.length;
  } catch (e) { return 0; }
}

/**
 * Stale sweep: anyone still flagged online but whose heartbeat stopped is
 * taken offline. This is the safety net for connections that vanish without
 * emitting 'close' — network loss, killed tab, laptop sleep.
 */
function sweepStalePresence() {
  try {
    const cutoffMs = Date.now() - PRESENCE_TTL_MS;
    const cutoff = new Date(cutoffMs).toISOString().slice(0, 19).replace('T', ' ');
    const stale = db.all(
      `SELECT user_id FROM chat_presence
        WHERE online=1 AND (last_seen IS NULL OR last_seen < ?)`, [cutoff]);
    for (const r of stale) {
      // A live socket is better evidence than a timestamp.
      if (streams.has(r.user_id) && streams.get(r.user_id).size) continue;
      db.run('UPDATE chat_presence SET online=0, updated_at=datetime(\'now\') WHERE user_id=?', [r.user_id]);
      broadcastPresence(r.user_id);
    }
  } catch (e) { /* ignore */ }
}
const presenceTimer = setInterval(sweepStalePresence, 20000);
if (presenceTimer.unref) presenceTimer.unref();

/** Touch the heartbeat so a long-lived session is not swept while it lives. */
function touchPresence(uid) {
  try {
    db.run(`UPDATE chat_presence SET last_seen=datetime('now'), updated_at=datetime('now') WHERE user_id=?`, [uid]);
  } catch (e) {}
}

function markOnline(uid) {
  const was = isOnline(uid);
  setPresence(uid, true);
  sweepDelivered(uid);
  if (!was) broadcastPresence(uid);      // no duplicate event on a second tab
}
function markOffline(uid) {
  const s = streams.get(uid);
  if (s && s.size) return;               // another device/tab is still connected
  const was = isOnline(uid);
  setPresence(uid, false);
  if (was) broadcastPresence(uid);
}

/* ------------------------------------------------------------------ */
/* hierarchy                                                           */
/* ------------------------------------------------------------------ */
function counterpartFor(user) {
  // Who is this account allowed to open a direct conversation with?
  if (user.role === 'agent') {
    const m = db.get(`SELECT u.id, u.username, u.name, u.role FROM users u
                       WHERE u.id = (SELECT parent_id FROM users WHERE id=?) AND u.role='manager'`, [user.id]);
    if (m) return m;
    // fall back: any admin
    return db.get(`SELECT id, username, name, role FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1`) || null;
  }
  if (user.role === 'manager') {
    const a = db.get(`SELECT u.id, u.username, u.name, u.role FROM users u
                       WHERE u.id = (SELECT parent_id FROM users WHERE id=?) AND u.role='admin'`, [user.id]);
    if (a) return a;
    return db.get(`SELECT id, username, name, role FROM users WHERE role='admin' AND active=1 ORDER BY id LIMIT 1`) || null;
  }
  return null; // admin opens conversations ad hoc
}

/**
 * Find the direct conversation between two users, creating it if absent.
 *
 * Written as INSERT ... ON CONFLICT DO NOTHING followed by a SELECT rather
 * than SELECT-then-INSERT. Two clients opening the same conversation at the
 * same moment used to both see "no row" and both insert; the UNIQUE(a_id,b_id)
 * constraint meant the second INSERT threw a constraint error (surfacing as a
 * 500) instead of creating a duplicate, but the request still failed. The
 * upsert makes the concurrent case a no-op and always returns exactly one row.
 */
function getOrCreateConversation(aId, bId) {
  db.run(`INSERT INTO chat_conversations (kind, a_id, b_id, created_at)
          VALUES ('direct',?,?, datetime('now'))
          ON CONFLICT(a_id, b_id) DO NOTHING`, [aId, bId]);
  const conv = db.get('SELECT * FROM chat_conversations WHERE a_id=? AND b_id=?', [aId, bId]);
  if (conv) return conv;
  /* Extremely unlikely: the insert was a no-op but the row is not visible in
     this connection. Read it back unconditionally rather than returning null. */
  return db.get('SELECT * FROM chat_conversations WHERE a_id=? AND b_id=? ORDER BY id LIMIT 1', [aId, bId]);
}

function canAccessConversation(user, conv) {
  if (!conv) return false;
  if (conv.a_id === user.id || conv.b_id === user.id) return true;
  // Admin supervises the whole tree (spec 3B.3)
  if (user.role === 'admin') return true;
  return false;
}

function unreadCount(convId, userId) {
  const r = db.get(
    `SELECT COUNT(*) c FROM chat_messages
      WHERE conversation_id=? AND sender_id!=? AND read_at IS NULL`, [convId, userId]);
  return +(r?.c || 0);
}

function convRow(conv, user) {
  const otherId = conv.a_id === user.id ? conv.b_id : conv.a_id;
  const other = db.get('SELECT id, username, name, role FROM users WHERE id=?', [otherId]) || {};
  const last = db.get(
    `SELECT body, sender_id, created_at FROM chat_messages
      WHERE conversation_id=? ORDER BY id DESC LIMIT 1`, [conv.id]);
  const isAdminView = user.role === 'admin' && conv.a_id !== user.id && conv.b_id !== user.id;
  const a = db.get('SELECT id, username, name, role FROM users WHERE id=?', [conv.a_id]) || {};
  const b = db.get('SELECT id, username, name, role FROM users WHERE id=?', [conv.b_id]) || {};
  return {
    id: conv.id,
    kind: conv.kind,
    other: { id: other.id, username: other.username, name: other.name, role: other.role },
    participants: [{ id: a.id, username: a.username, name: a.name, role: a.role },
                   { id: b.id, username: b.username, name: b.name, role: b.role }],
    supervised: isAdminView,          // admin reading someone else's thread
    last_message: last ? { body: String(last.body || '').slice(0, 120), sender_id: last.sender_id, at: isoZ(last.created_at) } : null,
    last_message_at: isoZ(conv.last_message_at),
    created_at: isoZ(conv.created_at),
    unread: unreadCount(conv.id, user.id),
  };
}

/* ------------------------------------------------------------------ */
/* mount                                                               */
/* ------------------------------------------------------------------ */
/* Built once at module load rather than per request. */
const upload = (() => {
  const multer = require('multer');
  return multer({
    storage: multer.diskStorage({
      destination: (rq, file, cb) => { ensureDir(); cb(null, UPLOAD_DIR); },
      filename: (rq, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase()),
    }),
    limits: { fileSize: MAX_UPLOAD, files: 1 },
    fileFilter: (rq, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const mime = String(file.mimetype || '').toLowerCase();
      const extOk = ALLOWED_EXT.has(ext);
      const mimeOk = Object.prototype.hasOwnProperty.call(ALLOWED, mime)
        || mime.startsWith('video/') || mime.startsWith('text/');
      if (!extOk || !mimeOk) {
        return cb(new Error('Unsupported file type. Allowed: TXT, CSV and video files.'));
      }
      cb(null, true);
    },
  });
})();


/* Runs multer but converts its errors into a clean 400 JSON response instead of
 * letting them fall through to the Express error handler (which would 500). */
function uploadOne(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `File is too large (max ${Math.floor(MAX_UPLOAD / 1048576)} MB).`
        : (err.message || 'Upload rejected.');
      return res.status(400).json({ error: msg });
    }
    next();
  });
}

module.exports = function mountChatApp(app, deps) {
  const { authRequired, requireRole, logAction, rateLimit } = deps;

  const chatLimit = rateLimit
    ? rateLimit({ windowMs: 60000, max: 180, keyFn: (req) => `chat:${req.user ? req.user.id : req.ip}` })
    : (req, res, next) => next();
  const sendLimit = rateLimit
    ? rateLimit({ windowMs: 60000, max: 60, keyFn: (req) => `chatsend:${req.user ? req.user.id : req.ip}` })
    : (req, res, next) => next();
  const pinLimit = rateLimit
    ? rateLimit({ windowMs: 300000, max: 10, keyFn: (req) => `chatpin:${req.user ? req.user.id : req.ip}` })
    : (req, res, next) => next();

  /* ================================================================
   * CONVERSATIONS
   * ================================================================ */
  app.get('/api/chatapp/conversations', authRequired, chatLimit, (req, res) => {
    try {
      const u = req.user;
      if (u.role === 'client') return res.status(403).json({ error: 'Chat is not available for client accounts.' });
      let convs;
      if (u.role === 'admin') {
        convs = db.all(`SELECT * FROM chat_conversations ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 300`);
      } else {
        convs = db.all(`SELECT * FROM chat_conversations WHERE a_id=? OR b_id=?
                        ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 300`, [u.id, u.id]);
      }
      const rows = convs.map(c => convRow(c, u)).filter(c => canAccessConversation(u, { a_id: c.participants[0].id, b_id: c.participants[1].id }));
      res.json({ ok: true, conversations: rows, total_unread: rows.reduce((s, c) => s + c.unread, 0) });
    } catch (e) { res.status(500).json({ error: 'Could not load conversations.' }); }
  });

  /**
   * GET /api/chatapp/participants
   * ------------------------------------------------------------------
   * Who this account is allowed to talk to, from the REAL account records
   * and the existing hierarchy — not from conversations that happen to
   * exist yet.
   *
   * GET /api/chatapp/conversations only returns rows already in
   * chat_conversations, so an Agent who has never messaged anyone saw an
   * empty list and had no way to discover or start the conversation with
   * their Manager. This endpoint closes that gap: each entry is returned
   * whether or not a conversation exists, with `conversation_id` null when
   * it does not, so the UI can render the name up front and create the row
   * on the first message.
   *
   * Names come from users.name / users.username. Nothing is hardcoded.
   *
   *   agent   -> the Manager it is assigned to (users.parent_id)
   *   manager -> the Admin it is assigned to (users.parent_id)
   *   admin   -> every active Manager and Agent
   *
   * An Agent never receives a Manager other than its own, and a Manager
   * never receives accounts it does not supervise. This is enforced here,
   * on the server — the frontend list is only a view of this result.
   */
  app.get('/api/chatapp/participants', authRequired, chatLimit, (req, res) => {
    try {
      const u = req.user;
      if (u.role === 'client') {
        return res.status(403).json({ error: 'Chat is not available for client accounts.' });
      }

      let people;
      if (u.role === 'agent') {
        /* Own Manager only — identified through the existing parent_id link. */
        people = db.all(
          `SELECT u.id, u.username, u.name, u.role, u.active
             FROM users u
            WHERE u.id = (SELECT parent_id FROM users WHERE id=?)
              AND u.role='manager'`, [u.id]);
        if (!people.length) {
          /* No manager on file: fall back to an admin rather than showing an
             empty list, so the agent always has somewhere to turn. */
          people = db.all(
            `SELECT id, username, name, role, active FROM users
              WHERE role='admin' AND active=1 ORDER BY id LIMIT 1`);
        }
      } else if (u.role === 'manager') {
        /* The Admin this manager reports to. */
        people = db.all(
          `SELECT u.id, u.username, u.name, u.role, u.active
             FROM users u
            WHERE u.id = (SELECT parent_id FROM users WHERE id=?)
              AND u.role='admin'`, [u.id]);
        if (!people.length) {
          people = db.all(
            `SELECT id, username, name, role, active FROM users
              WHERE role='admin' AND active=1 ORDER BY id LIMIT 1`);
        }
      } else {
        /* Admin: every active Manager and Agent. */
        people = db.all(
          `SELECT id, username, name, role, active FROM users
            WHERE role IN ('manager','agent') AND active=1
            ORDER BY role, name COLLATE NOCASE, username COLLATE NOCASE`);
      }

      const out = people.map(p => {
        const [a, b] = pair(u.id, p.id);
        const conv = db.get('SELECT id, last_message_at, created_at FROM chat_conversations WHERE a_id=? AND b_id=?', [a, b]);
        return {
          user_id: p.id,
          username: p.username,
          /* Real account name; falls back to the username when no name is set. */
          name: p.name || p.username,
          role: p.role,
          active: !!p.active,
          conversation_id: conv ? conv.id : null,
          has_conversation: !!conv,
          last_message_at: conv ? (conv.last_message_at || conv.created_at) : null,
        };
      });

      res.json({ ok: true, participants: out });
    } catch (e) { res.status(500).json({ error: 'Could not load participants.' }); }
  });

  /** Open (or create) the direct conversation for the caller's role. */
  app.post('/api/chatapp/conversations/open', authRequired, chatLimit, (req, res) => {
    try {
      const u = req.user;
      if (u.role === 'client') return res.status(403).json({ error: 'Not available.' });
      let targetId = parseInt(req.body?.user_id, 10);
      let target = null;

      if (Number.isFinite(targetId) && targetId > 0) {
        target = db.get('SELECT id, username, name, role, active FROM users WHERE id=?', [targetId]);
        if (!target) return res.status(404).json({ error: 'User not found.' });
        // authorise the pairing (spec 3B)
        const okPair =
          (u.role === 'admin') ||
          (u.role === 'manager' && target.role === 'admin') ||
          (u.role === 'agent' && target.role === 'manager' && target.id === (db.get('SELECT parent_id p FROM users WHERE id=?', [u.id])?.p));
        if (!okPair) return res.status(403).json({ error: 'You may only chat with your assigned counterpart.' });
      } else {
        target = counterpartFor(u);
        if (!target) return res.status(404).json({ error: 'No counterpart is configured for this account.' });
      }

      const [a, b] = pair(u.id, target.id);
      let conv = getOrCreateConversation(a, b);
      res.json({ ok: true, conversation: convRow(conv, u) });
    } catch (e) { res.status(500).json({ error: 'Could not open conversation.' }); }
  });

  /* ================================================================
   * MESSAGES
   * ================================================================ */
  app.get('/api/chatapp/conversations/:id/messages', authRequired, chatLimit, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const conv = db.get('SELECT * FROM chat_conversations WHERE id=?', [id]);
      if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
      if (!canAccessConversation(req.user, conv)) return res.status(403).json({ error: 'Not authorised for this conversation.' });

      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));
      const before = parseInt(req.query.before, 10);
      let sql = `SELECT m.* FROM chat_messages m WHERE m.conversation_id=?`;
      const params = [id];
      if (Number.isFinite(before) && before > 0) { sql += ' AND m.id < ?'; params.push(before); }
      sql += ' ORDER BY m.id DESC LIMIT ?';
      params.push(limit);

      const rows = db.all(sql, params).reverse();
      const att = db.all(`SELECT * FROM chat_attachments WHERE conversation_id=?`, [id]);
      const byMsg = new Map();
      for (const a of att) {
        if (!byMsg.has(a.message_id)) byMsg.set(a.message_id, []);
        byMsg.get(a.message_id).push({
          id: a.id, name: a.orig_name, mime: a.mime, size: a.size_bytes,
          url: `/api/chatapp/attachments/${a.id}/download`,
        });
      }
      res.json({
        ok: true,
        conversation: convRow(conv, req.user),
        messages: rows.map(m => ({
          id: m.id,
          conversation_id: m.conversation_id,
          sender_id: m.sender_id,
          body: m.body,
          created_at: isoZ(m.created_at),
          // receipt state derived from real columns only
          receipt: m.read_at ? 'read' : (m.delivered_at ? 'delivered' : 'sent'),
          delivered_at: isoZ(m.delivered_at),
          read_at: isoZ(m.read_at),
          mine: m.sender_id === req.user.id,
          attachments: byMsg.get(m.id) || [],
        })),
      });
    } catch (e) { res.status(500).json({ error: 'Could not load messages.' }); }
  });

  /** Send. client_msg_id lets a retry after a dropped connection dedupe safely (3J). */
  app.post('/api/chatapp/conversations/:id/messages', authRequired, sendLimit, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const conv = db.get('SELECT * FROM chat_conversations WHERE id=?', [id]);
      if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
      if (!canAccessConversation(req.user, conv)) return res.status(403).json({ error: 'Not authorised.' });

      const body = String(req.body?.body || '').slice(0, BODY_MAX);
      const attIds = Array.isArray(req.body?.attachment_ids) ? req.body.attachment_ids : [];
      if (!body.trim() && !attIds.length) return res.status(400).json({ error: 'Message is empty.' });

      let clientMsgId = req.body?.client_msg_id ? String(req.body.client_msg_id).slice(0, 64) : null;

      // dedupe: same client_msg_id in this conversation returns the original row
      if (clientMsgId) {
        const dup = db.get('SELECT * FROM chat_messages WHERE conversation_id=? AND client_msg_id=?', [id, clientMsgId]);
        if (dup) {
          return res.json({ ok: true, duplicate: true, message: {
            id: dup.id, body: dup.body, created_at: isoZ(dup.created_at),
            receipt: dup.read_at ? 'read' : (dup.delivered_at ? 'delivered' : 'sent'), mine: true } });
        }
      } else {
        clientMsgId = crypto.randomUUID();
      }

      const ins = db.run(
        `INSERT INTO chat_messages (conversation_id, sender_id, body, client_msg_id, created_at)
         VALUES (?,?,?,?, datetime('now'))`,
        [id, req.user.id, body, clientMsgId]);
      const msgId = ins?.lastInsertRowid || db.get('SELECT last_insert_rowid() id')?.id;

      for (const aid of attIds) {
        const n = parseInt(aid, 10);
        if (Number.isFinite(n)) db.run('UPDATE chat_attachments SET message_id=?, conversation_id=? WHERE id=? AND uploader_id=? AND message_id IS NULL',
          [msgId, id, n, req.user.id]);
      }

      db.run(`UPDATE chat_conversations SET last_message_at=datetime('now') WHERE id=?`, [id]);

      const otherId = conv.a_id === req.user.id ? conv.b_id : conv.a_id;

      /* Delivery is only claimed when the recipient genuinely has a live
         authenticated session. isOnline() reads the presence table, which is
         the same source of truth the presence endpoint and the stale sweep
         use — so a message cannot be marked delivered for someone the server
         knows is offline. */
      let delivered = false;
      if (isOnline(otherId)) {
        db.run(`UPDATE chat_messages SET delivered_at=datetime('now') WHERE id=? AND delivered_at IS NULL`, [msgId]);
        delivered = true;
      }

      const payload = {
        id: msgId, conversation_id: id, sender_id: req.user.id, body,
        created_at: isoZ(db.get('SELECT created_at FROM chat_messages WHERE id=?', [msgId])?.created_at),
        receipt: delivered ? 'delivered' : 'sent',
        mine: true,                     // lets the composer render the receipt immediately
        sender_name: (req.user.name || req.user.username || ''),
        attachments: db.all('SELECT id, orig_name name, mime, size_bytes size FROM chat_attachments WHERE message_id=?', [msgId])
          .map(a => ({ ...a, url: `/api/chatapp/attachments/${a.id}/download` })),
      };
      pushTo(otherId, 'message', payload);

      res.json({ ok: true, message: payload });
    } catch (e) { res.status(500).json({ error: 'Could not send message.' }); }
  });

  /** Explicit read — only called when the recipient actually opens the thread (3F). */
  app.post('/api/chatapp/conversations/:id/read', authRequired, chatLimit, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const conv = db.get('SELECT * FROM chat_conversations WHERE id=?', [id]);
      if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
      if (!canAccessConversation(req.user, conv)) return res.status(403).json({ error: 'Not authorised.' });

      const r = db.run(
        `UPDATE chat_messages SET read_at=datetime('now'), delivered_at=COALESCE(delivered_at, datetime('now'))
          WHERE conversation_id=? AND sender_id!=? AND read_at IS NULL`,
        [id, req.user.id]);
      const n = r && r.changes ? r.changes : 0;
      if (n) {
        const otherId = conv.a_id === req.user.id ? conv.b_id : conv.a_id;
        pushTo(otherId, 'read', { conversation_id: id, by: req.user.id, count: n });
      }
      res.json({ ok: true, marked: n });
    } catch (e) { res.status(500).json({ error: 'Could not mark as read.' }); }
  });

  /* ================================================================
   * LIVE STREAM (SSE) — no new dependency, works behind nginx
   * ================================================================ */
  /* EventSource cannot send an Authorization header, so this one route also
   * accepts ?token=. It is the same JWT the panels use, scope-checked by
   * authRequired, and is never written to any log. */
  const streamAuth = (req, res, next) => {
    if (req.get('authorization')) return authRequired(req, res, next);
    const t = req.query && req.query.token ? String(req.query.token) : '';
    if (!t) return res.status(401).json({ error: 'Not authenticated.' });
    req.headers.authorization = 'Bearer ' + t;
    return authRequired(req, res, next);
  };
  app.get('/api/chatapp/stream', streamAuth, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ user_id: req.user.id, at: new Date().toISOString() })}\n\n`);

    const entry = { res };
    addStream(req.user.id, entry);

    /* Presence: this session is live, so (a) record it, (b) deliver anything
       that was waiting, (c) tell our partners we came online. */
    markOnline(req.user.id);

    const hb = setInterval(() => {
      try { res.write(': ping\\n\\n'); touchPresence(req.user.id); } catch (_) {}
    }, 25000);

    req.on('close', () => {
      clearInterval(hb);
      delStream(req.user.id, entry);
      markOffline(req.user.id);        // no-op if another tab is still open
    });
  });

  /**
   * GET /api/chatapp/presence — presence of my conversation partners.
   * Server-side state is the source of truth; the UI renders what this says
   * and never infers ticks from its own guess about the recipient.
   */
  app.get('/api/chatapp/presence', authRequired, chatLimit, (req, res) => {
    try {
      const peers = peersOf(req.user.id);
      const out = {};
      for (const p of peers) out[p] = isOnline(p) ? 'online' : 'offline';
      res.json({ ok: true, presence: out, me: req.user.id, ttl_ms: PRESENCE_TTL_MS });
    } catch (e) { res.status(500).json({ error: 'Could not load presence.' }); }
  });

  /* ================================================================
   * ATTACHMENTS (3E)
   * ================================================================ */
  app.post('/api/chatapp/upload', authRequired, chatLimit, uploadOne, (req, res) => {
    try {
      if (req.user.role === 'client') return res.status(403).json({ error: 'Not available.' });
      if (!req.file) return res.status(400).json({ error: 'No file received.' });

      const ins = db.run(
        `INSERT INTO chat_attachments (message_id, conversation_id, uploader_id, orig_name, stored_name, mime, size_bytes, created_at)
         VALUES (NULL, NULL,?,?,?,?,?, datetime('now'))`,
        [req.user.id, safeName(req.file.originalname), req.file.filename,
         String(req.file.mimetype || '').slice(0, 120), req.file.size || 0]);
      const id = ins?.lastInsertRowid || db.get('SELECT last_insert_rowid() id')?.id;
      res.json({ ok: true, attachment: {
        id, name: safeName(req.file.originalname), mime: req.file.mimetype,
        size: req.file.size, url: `/api/chatapp/attachments/${id}/download` } });
    } catch (e) { console.error('[chat] upload failed:', e && e.message); res.status(500).json({ error: 'Upload failed.' }); }
  });

  /** Download — authenticated AND conversation-authorised (no public URLs). */
  app.get('/api/chatapp/attachments/:id/download', authRequired, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const a = db.get('SELECT * FROM chat_attachments WHERE id=?', [id]);
      if (!a) return res.status(404).json({ error: 'Attachment not found.' });

      if (a.conversation_id) {
        const conv = db.get('SELECT * FROM chat_conversations WHERE id=?', [a.conversation_id]);
        if (!canAccessConversation(req.user, conv)) return res.status(403).json({ error: 'Not authorised for this attachment.' });
      } else if (a.uploader_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Not authorised for this attachment.' });
      }

      // resolve inside the upload dir and refuse anything that escapes it
      const full = path.resolve(UPLOAD_DIR, path.basename(a.stored_name));
      if (!full.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
        return res.status(400).json({ error: 'Invalid attachment path.' });
      }
      if (!fs.existsSync(full)) return res.status(410).json({ error: 'File is no longer available.' });

      res.setHeader('Content-Type', a.mime || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName(a.orig_name)}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      fs.createReadStream(full).pipe(res);
    } catch (e) { res.status(500).json({ error: 'Download failed.' }); }
  });

  /* ================================================================
   * EXPORT / LOG (3G)
   * ================================================================ */
  app.get('/api/chatapp/conversations/:id/export', authRequired, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const conv = db.get('SELECT * FROM chat_conversations WHERE id=?', [id]);
      if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
      if (!canAccessConversation(req.user, conv)) return res.status(403).json({ error: 'Not authorised.' });

      const fmt = (req.query.format === 'csv') ? 'csv' : 'txt';
      const msgs = db.all(`SELECT * FROM chat_messages WHERE conversation_id=? ORDER BY id ASC`, [id]);
      const att = db.all(`SELECT * FROM chat_attachments WHERE conversation_id=?`, [id]);
      const attBy = new Map();
      for (const a of att) { if (!attBy.has(a.message_id)) attBy.set(a.message_id, []); attBy.get(a.message_id).push(a.orig_name); }

      const who = (uid) => { const u = db.get('SELECT username,name,role FROM users WHERE id=?', [uid]); return u ? (u.name || u.username) : ('user#' + uid); };
      const A = who(conv.a_id), B = who(conv.b_id);

      let out = '';
      if (fmt === 'csv') {
        const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
        out = 'timestamp,sender,message,receipt,attachments\n';
        for (const m of msgs) {
          const receipt = m.read_at ? 'read' : (m.delivered_at ? 'delivered' : 'sent');
          out += [esc(isoZ(m.created_at)), esc(who(m.sender_id)), esc(m.body), esc(receipt), esc((attBy.get(m.id) || []).join('; '))].join(',') + '\n';
        }
      } else {
        out = `Conversation between ${A} and ${B}\nExported: ${new Date().toISOString()}\n${'='.repeat(60)}\n\n`;
        for (const m of msgs) {
          const tick = m.read_at ? '✓✓ read' : (m.delivered_at ? '✓✓ delivered' : '✓ sent');
          out += `[${isoZ(m.created_at)}] ${who(m.sender_id)} (${tick})\n${m.body}\n`;
          const names = attBy.get(m.id);
          if (names && names.length) out += `  attachments: ${names.join(', ')}\n`;
          out += '\n';
        }
      }
      const fname = `chat-${conv.a_id}-${conv.b_id}-${new Date().toISOString().slice(0, 10)}.${fmt}`;
      res.setHeader('Content-Type', fmt === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.send(out);
    } catch (e) { res.status(500).json({ error: 'Export failed.' }); }
  });

  /* ================================================================
   * PERSONAL CHAT PIN (3H) — self-service, separate from the payment PIN
   * ================================================================ */
  app.get('/api/chatapp/pin/status', authRequired, (req, res) => {
    const row = db.get('SELECT chat_pin_hash, locked FROM chat_lock_prefs WHERE user_id=?', [req.user.id]);
    res.json({ ok: true, has_pin: !!(row && row.chat_pin_hash), locked: !!(row && row.locked) });
  });

  app.post('/api/chatapp/pin/set', authRequired, pinLimit, (req, res) => {
    try {
      const pin = String(req.body?.pin || '').trim();
      const current = String(req.body?.current_pin || '').trim();
      if (pin.length < 6 || pin.length > 64) return res.status(400).json({ error: 'PIN must be between 6 and 64 characters.' });

      const row = db.get('SELECT * FROM chat_lock_prefs WHERE user_id=?', [req.user.id]);
      if (row && row.chat_pin_hash) {
        if (!current || !bcrypt.compareSync(current, row.chat_pin_hash)) {
          return res.status(403).json({ error: 'Current PIN is incorrect.' });
        }
      }
      const hash = bcrypt.hashSync(pin, 10);
      db.run(`INSERT INTO chat_lock_prefs (user_id, chat_pin_hash, locked, updated_at)
              VALUES (?,?, COALESCE((SELECT locked FROM chat_lock_prefs WHERE user_id=?),0), datetime('now'))
              ON CONFLICT(user_id) DO UPDATE SET chat_pin_hash=excluded.chat_pin_hash, updated_at=datetime('now')`,
        [req.user.id, hash, req.user.id]);
      logAction(req, 'chat_pin_set', 'chat', {});
      res.json({ ok: true, message: 'Chat PIN saved.' });
    } catch (e) { res.status(500).json({ error: 'Could not save PIN.' }); }
  });

  app.post('/api/chatapp/pin/lock', authRequired, pinLimit, (req, res) => {
    const row = db.get('SELECT * FROM chat_lock_prefs WHERE user_id=?', [req.user.id]);
    if (!row || !row.chat_pin_hash) return res.status(400).json({ error: 'Set a chat PIN first.' });
    db.run(`INSERT INTO chat_lock_prefs (user_id, chat_pin_hash, locked, updated_at)
            VALUES (?,?,1, datetime('now'))
            ON CONFLICT(user_id) DO UPDATE SET locked=1, updated_at=datetime('now')`,
      [req.user.id, row.chat_pin_hash]);
    res.json({ ok: true, locked: true });
  });

  app.post('/api/chatapp/pin/unlock', authRequired, pinLimit, (req, res) => {
    const pin = String(req.body?.pin || '').trim();
    const row = db.get('SELECT * FROM chat_lock_prefs WHERE user_id=?', [req.user.id]);
    if (!row || !row.chat_pin_hash) return res.status(400).json({ error: 'No chat PIN is set.' });
    if (!bcrypt.compareSync(pin, row.chat_pin_hash)) {
      logAction(req, 'chat_pin_unlock_failed', 'chat', {});
      return res.status(403).json({ error: 'Incorrect PIN.' });
    }
    db.run('UPDATE chat_lock_prefs SET locked=0, updated_at=datetime(\'now\') WHERE user_id=?', [req.user.id]);
    logAction(req, 'chat_pin_unlock', 'chat', {});
    res.json({ ok: true, locked: false });
  });

  /* §10A — Agent Account PIN list must not include the seeded 'test' account.
   * The existing /api/account-pin/accounts route lives in chat.js; we filter
   * the same way for any admin chat surface here. */
  app.get('/api/chatapp/admin/accounts', authRequired, requireRole('admin'), (req, res) => {
    const rows = db.all(
      `SELECT u.id, u.username, u.name, u.role
         FROM users u
        WHERE u.role IN ('admin','manager','agent')
        ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
                 u.username COLLATE NOCASE`);
    res.json({ ok: true, accounts: rows });
  });

  return { counterpartFor, canAccessConversation, streams };
};
