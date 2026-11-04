/**
 * PHASE-3: optional FTS5 trigram index over sms_records.message.
 *
 * Enabled ONLY when AMS_FTS=1 (default off = zero behavior change).
 * Why trigram: substring search (LIKE '%term%') is a full table scan at
 * millions of SMS; the trigram index serves it in milliseconds.
 *
 * Design:
 *  - init() creates the virtual table + sync triggers (AFTER INSERT/DELETE/UPDATE).
 *    Every SMS that arrives AFTER init is indexed by the triggers automatically —
 *    the ingest path itself is untouched.
 *  - startBackfill() indexes pre-existing history in 20k-row transactions with
 *    setImmediate yields (same pattern as the Phase-1 stats backfill). Progress
 *    in meta: sms_fts_backfill_max_id / sms_fts_backfill_done.
 *  - Queries use the index only once the backfill is done (ready()); until then
 *    the endpoint keeps the original LIKE behavior, so results are never partial.
 *  - External-content FTS (content='sms_records'): the message text is NOT
 *    duplicated — only index terms are stored.
 */
const TABLE = 'sms_fts';

function enabled() {
  return String(process.env.AMS_FTS || process.env.ALMADA_FTS || '') === '1';
}

let ready = false;

function getMeta(db, key) {
  try { return db.get('SELECT value FROM meta WHERE key=?', [key])?.value ?? null; } catch (_) { return null; }
}
function setMeta(db, key, value) {
  try {
    db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, String(value)]);
  } catch (_) {}
}

/** Create index + sync triggers, snapshot the history boundary atomically. */
function init(db) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING fts5(message, content='sms_records', content_rowid='id', tokenize='trigram')`);
  // Single IMMEDIATE txn: any insert after this point has triggers attached and
  // an id > frontier, so the backfill range can never double-index it.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${TABLE}_ai AFTER INSERT ON sms_records BEGIN
      INSERT INTO ${TABLE}(rowid, message) VALUES (new.id, COALESCE(new.message,'')); END;
    CREATE TRIGGER IF NOT EXISTS ${TABLE}_ad AFTER DELETE ON sms_records BEGIN
      INSERT INTO ${TABLE}(${TABLE}, rowid, message) VALUES('delete', old.id, COALESCE(old.message,'')); END;
    CREATE TRIGGER IF NOT EXISTS ${TABLE}_au AFTER UPDATE ON sms_records BEGIN
      INSERT INTO ${TABLE}(${TABLE}, rowid, message) VALUES('delete', old.id, COALESCE(old.message,''));
      INSERT INTO ${TABLE}(rowid, message) VALUES (new.id, COALESCE(new.message,'')); END;`);
    const maxId = +(db.get('SELECT COALESCE(MAX(id),0) m FROM sms_records')?.m || 0);
    const prevDone = +(getMeta(db, 'sms_fts_backfill_done') || 0) === 1;
    if (!prevDone) setMeta(db, 'sms_fts_backfill_frontier', String(maxId));
    db.exec('COMMIT');
    return { frontier: maxId };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

/** Chunked background backfill of history (never blocks the event loop). */
function startBackfill(db, log = console) {
  if (+(getMeta(db, 'sms_fts_backfill_done') || 0) === 1) { ready = true; return; }
  const frontier = +(getMeta(db, 'sms_fts_backfill_frontier') || 0);
  setMeta(db, 'sms_fts_backfill_done', '0');
  const CHUNK = 20000;
  setImmediate(function step() {
    try {
      const last = +(getMeta(db, 'sms_fts_backfill_max_id') || 0);
      if (last >= frontier) {
        setMeta(db, 'sms_fts_backfill_done', '1');
        ready = true;
        log.log(`[FTS] SMS message index backfill done (${frontier} rows)`);
        return;
      }
      const upto = Math.min(last + CHUNK, frontier);
      db.run('BEGIN IMMEDIATE');
      try {
        db.run(`INSERT INTO ${TABLE}(rowid, message) SELECT id, COALESCE(message,'') FROM sms_records WHERE id>? AND id<=? ORDER BY id`, [last, upto]);
        db.run('COMMIT');
      } catch (e) { db.run('ROLLBACK'); throw e; }
      setMeta(db, 'sms_fts_backfill_max_id', String(upto));
      setImmediate(step);
    } catch (e) {
      log.error('[FTS] backfill error:', e.message);
    }
  });
}

/** MATCH fragment for a search term (trigram = substring, case-insensitive). */
function matchClause(term) {
  return `"${String(term).replace(/"/g, '""')}"`;
}

function status(db) {
  if (!enabled()) return { enabled: false, ready: false };
  let frontier = +(getMeta(db, 'sms_fts_backfill_frontier') || 0);
  const maxId = +(getMeta(db, 'sms_fts_backfill_max_id') || 0);
  const done = +(getMeta(db, 'sms_fts_backfill_done') || 0) === 1;
  return {
    enabled: true,
    ready: ready || done,
    backfill: { frontier, indexed_upto: maxId, done, remaining: Math.max(0, frontier - maxId) },
  };
}

module.exports = { enabled, init, startBackfill, matchClause, status, isReady: () => ready };
