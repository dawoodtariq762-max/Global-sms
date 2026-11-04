/**
 * backend/chat.js — ACCOUNT SECURITY PIN & COMPLAINTS SERVICE
 * (The separate Chat System / Chat App has been discontinued and removed).
 *
 * This module preserves:
 * 1. Account Security PIN (Agent Payment unlock, Binance UID protection, wrong PIN lock)
 * 2. Admin Account PIN Management (formerly Chat Accounts)
 * 3. Complaints / Ticketing System (manager/agent/client -> admin)
 */
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const SUBJECT_MAX = 200, COMPLAINT_MAX = 4000;
const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', agent: 'Agent', client: 'Client' };

function intId(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; }
function cleanText(v, max) { const s = String(v == null ? '' : v).trim(); if (!s) return null; if (s.length > max) return null; return s; }

module.exports = function mountChat(app, deps) {
  const { authRequired, chatAuthRequired, requireRole, logAction, SECRET } = deps;
  const chatAuth = chatAuthRequired || authRequired;

  /* ================================================================
   * PANEL LOCK VERIFICATION (Security PIN for Payment Section)
   * Validates user's Account Security PIN against chat_credentials
   * ================================================================ */
  const handleLockStatus = (req, res) => {
    const user = db.get('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.role === 'admin') {
      return res.json({ chat_security_enabled: false, locked: false, unlocked: true });
    }

    const cred = db.get('SELECT chat_enabled, chat_password_hash FROM chat_credentials WHERE user_id=?', [user.id]);
    if (cred && (cred.chat_enabled === 0 || cred.chat_enabled === false)) {
      return res.json({ chat_security_enabled: false, locked: false, unlocked: true });
    }

    const unlockHeader = req.headers['x-chat-unlock-token'] || req.headers['x-pin-unlock-token'];
    let unlocked = false;
    if (unlockHeader) {
      try {
        const decoded = jwt.verify(unlockHeader, SECRET);
        if (decoded && (decoded.type === 'chat_unlocked' || decoded.type === 'account_pin_unlocked') && decoded.id === user.id) {
          unlocked = true;
        }
      } catch (_) {}
    }

    return res.json({
      chat_security_enabled: true,
      locked: !unlocked,
      unlocked: unlocked
    });
  };

  app.get('/api/chat/auth/lock-status', authRequired, handleLockStatus);
  app.get('/api/auth/pin/status', authRequired, handleLockStatus);

  const handleVerifyLock = (req, res) => {
    const password = String((req.body && req.body.password) || '').trim();
    if (!password) return res.status(400).json({ error: 'Security PIN is required' });

    const user = db.get('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.active) return res.status(403).json({ error: 'Account disabled' });

    // Admin uses master account password
    if (user.role === 'admin') {
      if (!bcrypt.compareSync(password, user.password)) {
        return res.status(400).json({ ok: false, error: 'Invalid password or PIN' });
      }
      const unlockToken = jwt.sign({ id: user.id, username: user.username, role: user.role, type: 'chat_unlocked' }, SECRET, { expiresIn: '12h' });
      return res.json({ ok: true, message: 'Unlocked successfully', unlock_token: unlockToken });
    }

    let cred = db.get('SELECT chat_enabled, chat_password_hash, failed_attempts, locked_until FROM chat_credentials WHERE user_id=?', [user.id]);
    if (!cred) {
      db.run('INSERT OR IGNORE INTO chat_credentials (user_id, chat_password_hash, chat_enabled, password_set_at) VALUES (?,?,1,datetime("now"))', [user.id, user.password]);
      cred = db.get('SELECT chat_enabled, chat_password_hash, failed_attempts, locked_until FROM chat_credentials WHERE user_id=?', [user.id]);
    }

    if (cred && cred.locked_until && new Date(cred.locked_until) > new Date()) {
      return res.status(429).json({ ok: false, error: 'Account temporarily locked due to multiple failed attempts. Please try again later.' });
    }

    let match = cred && cred.chat_password_hash ? bcrypt.compareSync(password, cred.chat_password_hash) : false;
    // Fallback: if separate PIN not yet set, match against user account password
    if (!match && user.password && (!cred || user.password !== cred.chat_password_hash)) {
      match = bcrypt.compareSync(password, user.password);
    }

    if (!match) {
      const attempts = ((cred && cred.failed_attempts) || 0) + 1;
      const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60000).toISOString().slice(0, 19).replace('T', ' ') : null;
      db.run('UPDATE chat_credentials SET failed_attempts=?, locked_until=? WHERE user_id=?', [attempts, lockUntil, user.id]);
      return res.status(400).json({ ok: false, error: 'Incorrect Security PIN or Password' });
    }

    db.run(`UPDATE chat_credentials SET failed_attempts=0, locked_until=NULL, updated_at=datetime('now') WHERE user_id=?`, [user.id]);
    logAction(req, 'verify_security_pin', 'security', { user_id: user.id, username: user.username });
    const unlockToken = jwt.sign({ id: user.id, username: user.username, role: user.role, type: 'chat_unlocked' }, SECRET, { expiresIn: '12h' });
    return res.json({ ok: true, message: 'Unlocked successfully', unlock_token: unlockToken });
  };

  app.post('/api/chat/auth/verify-lock', authRequired, handleVerifyLock);
  app.post('/api/auth/pin/verify', authRequired, handleVerifyLock);

  /* ================================================================
   * ADMIN ACCOUNT PIN MANAGEMENT (formerly Chat Accounts)
   * ================================================================ */
  const handleGetAccounts = (req, res) => {
    const rows = db.all(`
      SELECT u.id, u.username, u.name, u.role, u.email, u.parent_id,
             p.username AS parent_username, p.role AS parent_role,
             c.chat_enabled, c.failed_attempts, c.locked_until,
             c.last_login_at, c.password_set_at,
             CASE WHEN c.chat_password_hash IS NOT NULL AND c.chat_password_hash != '' THEN 1 ELSE 0 END AS has_chat_password
      FROM users u
      LEFT JOIN users p ON p.id = u.parent_id
      LEFT JOIN chat_credentials c ON c.user_id = u.id
      /* §10A: the seeded 'test' panel account is not a real Agent/Manager/Admin
         and must not appear as an account entry in the PIN management list. */
      WHERE u.role IN ('admin','manager','agent')
        AND LOWER(u.username) <> 'test'
      ORDER BY u.role, u.username COLLATE NOCASE
    `);
    res.json({ ok: true, accounts: rows });
  };
  app.get('/api/chat/admin/accounts', chatAuth, requireRole('admin'), handleGetAccounts);
  app.get('/api/account-pin/accounts', chatAuth, requireRole('admin'), handleGetAccounts);

  const handleSetPassword = (req, res) => {
    const targetId = intId(req.params.userId);
    const password = String((req.body && req.body.password) || '').trim();
    if (!targetId) return res.status(400).json({ error: 'Valid user ID required' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'PIN must be at least 6 digits/characters' });

    const target = db.get('SELECT * FROM users WHERE id=?', [targetId]);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const hash = bcrypt.hashSync(password, 10);
    const existing = db.get('SELECT user_id FROM chat_credentials WHERE user_id=?', [targetId]);
    if (existing) {
      db.run(`UPDATE chat_credentials SET chat_password_hash=?, chat_enabled=1, failed_attempts=0, locked_until=NULL, password_set_at=datetime('now'), updated_at=datetime('now') WHERE user_id=?`, [hash, targetId]);
    } else {
      db.run(`INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled, password_set_at) VALUES (?,?,1,datetime('now'))`, [targetId, hash]);
    }
    logAction(req, 'admin_set_account_pin', 'security', { target_id: targetId, username: target.username });
    res.json({ ok: true, message: `Account Security PIN updated for ${target.username}` });
  };
  app.post('/api/chat/admin/accounts/:userId/password', chatAuth, requireRole('admin'), handleSetPassword);
  app.post('/api/account-pin/accounts/:userId/password', chatAuth, requireRole('admin'), handleSetPassword);

  const handleToggleStatus = (req, res) => {
    const targetId = intId(req.params.userId);
    const enable = req.body && typeof req.body.chat_enabled === 'boolean' ? (req.body.chat_enabled ? 1 : 0) : (req.body && req.body.chat_enabled === 1 ? 1 : 0);
    if (!targetId) return res.status(400).json({ error: 'Valid user ID required' });

    const target = db.get('SELECT * FROM users WHERE id=?', [targetId]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') return res.status(400).json({ error: 'Cannot disable admin PIN' });

    const existing = db.get('SELECT user_id FROM chat_credentials WHERE user_id=?', [targetId]);
    const newStatus = enable ? 1 : 0;
    if (existing) {
      db.run(`UPDATE chat_credentials SET chat_enabled=?, updated_at=datetime('now') WHERE user_id=?`, [newStatus, targetId]);
    } else {
      const dummyHash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
      db.run(`INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled) VALUES (?,?,?)`, [targetId, dummyHash, newStatus]);
    }
    logAction(req, 'admin_toggle_account_pin', 'security', { target_id: targetId, username: target.username, enabled: newStatus });
    res.json({ ok: true, chat_enabled: newStatus });
  };
  app.post('/api/chat/admin/accounts/:userId/toggle', chatAuth, requireRole('admin'), handleToggleStatus);
  app.post('/api/account-pin/accounts/:userId/toggle', chatAuth, requireRole('admin'), handleToggleStatus);



  const handleInitAll = (req, res) => {
    const uninit = db.all(`
      SELECT u.id, u.username, u.password FROM users u
      LEFT JOIN chat_credentials c ON c.user_id = u.id
      WHERE c.user_id IS NULL AND u.role != 'admin'
    `);
    let count = 0;
    for (const u of uninit) {
      const tempHash = bcrypt.hashSync(Math.floor(100000 + Math.random() * 900000).toString(), 10);
      db.run(`INSERT INTO chat_credentials (user_id, chat_password_hash, chat_enabled, password_set_at) VALUES (?,?,1,datetime('now'))`, [u.id, tempHash]);
      count++;
    }
    logAction(req, 'admin_init_all_pins', 'security', { count });
    res.json({ ok: true, initialized: count });
  };
  app.post('/api/chat/admin/accounts/init-all', chatAuth, requireRole('admin'), handleInitAll);
  app.post('/api/account-pin/accounts/init-all', chatAuth, requireRole('admin'), handleInitAll);

  /* ================================================================
   * UNREAD COUNT (Complaints badge)
   * ================================================================ */
  app.get('/api/chat/unread-count', chatAuth, (req, res) => {
    let complaints = 0;
    try {
      if (req.user.role === 'admin') {
        complaints = db.get(`SELECT COUNT(*) c FROM complaints WHERE status<>'Resolved'`)?.c || 0;
      } else {
        complaints = db.get(`SELECT COUNT(*) c FROM complaints WHERE sender_id=? AND status<>'Resolved'`, [req.user.id])?.c || 0;
      }
    } catch (_) {}
    res.json({ ok: true, chat: 0, channel: 0, complaints });
  });

  /* ================================================================
   * COMPLAINTS / TICKETING SYSTEM
   * ================================================================ */
  const COMPLAINT_SELECT = `SELECT cm.*, u.username, u.name, u.role FROM complaints cm JOIN users u ON u.id=cm.sender_id`;

  app.post('/api/complaints', chatAuth, (req, res) => {
    const subject = cleanText(req.body.subject, SUBJECT_MAX);
    const body = cleanText(req.body.body, COMPLAINT_MAX);
    if (!subject || !body) return res.status(400).json({ error: 'Subject and body required' });
    const info = db.run('INSERT INTO complaints (sender_id, subject, body) VALUES (?,?,?)', [req.user.id, subject, body]);
    logAction(req, 'complaint_created', 'complaints', { id: Number(info.lastInsertRowid), subject });
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });

  app.get('/api/complaints', chatAuth, (req, res) => {
    const isAdm = req.user.role === 'admin';
    const status = req.query.status ? String(req.query.status).trim() : null;
    let sql = COMPLAINT_SELECT, params = [];
    const wh = [];
    if (!isAdm) { wh.push('cm.sender_id=?'); params.push(req.user.id); }
    if (status) { wh.push('cm.status=?'); params.push(status); }
    if (wh.length) sql += ' WHERE ' + wh.join(' AND ');
    sql += ' ORDER BY cm.updated_at DESC, cm.id DESC LIMIT 100';
    const rows = db.all(sql, params).map(r => ({
      id: r.id,
      sender_id: r.sender_id,
      sender: { id: r.sender_id, username: r.username, name: r.name || r.username, role: r.role, role_label: ROLE_LABEL[r.role] || r.role },
      subject: r.subject,
      body: r.body,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      status_updated_at: r.status_updated_at,
      status_updated_by: r.status_updated_by
    }));
    res.json(rows);
  });

  function complaintAccess(user, cm) { return user.role === 'admin' || cm.sender_id === user.id; }

  app.get('/api/complaints/:id', chatAuth, (req, res) => {
    const cm = db.get('SELECT * FROM complaints WHERE id=?', [intId(req.params.id)]);
    if (!cm) return res.status(404).json({ error: 'Complaint not found' });
    if (!complaintAccess(req.user, cm)) return res.status(403).json({ error: 'Forbidden — not your complaint' });
    const replies = db.all(`SELECT cr.*, u.username, u.name, u.role FROM complaint_replies cr JOIN users u ON u.id=cr.sender_id
      WHERE cr.complaint_id=? ORDER BY cr.id ASC`, [cm.id]);
    const sender = db.get('SELECT id, username, name, role FROM users WHERE id=?', [cm.sender_id]);
    res.json({
      id: cm.id,
      sender_id: cm.sender_id,
      sender: sender ? { id: sender.id, username: sender.username, name: sender.name || sender.username, role: sender.role, role_label: ROLE_LABEL[sender.role] || sender.role } : null,
      subject: cm.subject,
      body: cm.body,
      status: cm.status,
      created_at: cm.created_at,
      updated_at: cm.updated_at,
      status_updated_at: cm.status_updated_at,
      status_updated_by: cm.status_updated_by,
      replies: replies.map(r => ({
        id: r.id,
        sender_id: r.sender_id,
        sender: { id: r.sender_id, username: r.username, name: r.name || r.username, role: r.role, role_label: ROLE_LABEL[r.role] || r.role },
        body: r.body,
        created_at: r.created_at
      }))
    });
  });

  app.post('/api/complaints/:id/status', chatAuth, requireRole('admin'), (req, res) => {
    const status = String(req.body.status || '').trim();
    if (!['Open', 'In Progress', 'Resolved'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const cm = db.get('SELECT * FROM complaints WHERE id=?', [intId(req.params.id)]);
    if (!cm) return res.status(404).json({ error: 'Complaint not found' });
    db.run(`UPDATE complaints SET status=?, status_updated_at=datetime('now'), status_updated_by=?, updated_at=datetime('now') WHERE id=?`,
      [status, req.user.username, cm.id]);
    logAction(req, 'complaint_status_change', 'complaints', { id: cm.id, status });
    res.json({ ok: true, status });
  });

  app.post('/api/complaints/:id/replies', chatAuth, (req, res) => {
    const cm = db.get('SELECT * FROM complaints WHERE id=?', [intId(req.params.id)]);
    if (!cm) return res.status(404).json({ error: 'Complaint not found' });
    if (!complaintAccess(req.user, cm)) return res.status(403).json({ error: 'Forbidden — not your complaint' });
    const body = cleanText(req.body.body, COMPLAINT_MAX);
    if (!body) return res.status(400).json({ error: 'Reply body required' });
    db.run(`UPDATE complaints SET updated_at=datetime('now') WHERE id=?`, [cm.id]);
    const info = db.run('INSERT INTO complaint_replies (complaint_id, sender_id, body) VALUES (?,?,?)', [cm.id, req.user.id, body]);
    logAction(req, 'complaint_reply', 'complaints', { id: cm.id, reply_id: Number(info.lastInsertRowid) });
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });
};
