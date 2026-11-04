/**
 * Database layer — better-sqlite3 (native SQLite) with direct file persistence.
 * ---------------------------------------------------------------------------
 * MIGRATED FROM sql.js.
 *
 * Why: sql.js is a WASM build that keeps the ENTIRE database in RAM and has to
 * re-serialise + rewrite the whole file on every write. That meant:
 *   - RAM usage ~4x the database file size
 *   - a hard WASM crash ("memory access out of bounds") at ~284 MB / ~325k SMS
 *   - ~38s boot time on a 176 MB database
 *   - every write blocking the event loop while the whole file was written
 *
 * better-sqlite3 reads pages from disk on demand, so:
 *   - RAM stays roughly constant no matter how big the database grows
 *   - there is no size ceiling
 *   - writes touch only the changed pages
 *
 * IMPORTANT — this module keeps the EXACT same public API and semantics as the
 * old sql.js layer so that no calling code had to change:
 *   init, run, runNoSave, exec, execNoSave, get, all, save, beginBatch,
 *   endBatch, endBatchNoSave, vacuum, exportBuffer, getDbFile, replaceWithFile
 *
 * Behavioural notes that preserve old behaviour exactly:
 *   - save() is now a no-op flush: better-sqlite3 has already written the data.
 *     It is kept so existing call sites keep working unchanged.
 *   - beginBatch()/endBatch() map onto real SQLite transactions, which is what
 *     the old code was emulating. Nesting is reference-counted.
 *   - The old code sometimes issues COMMIT/ROLLBACK without a matching BEGIN
 *     (sql.js silently ignored that). exec/execNoSave tolerate this instead of
 *     throwing, so those routes behave exactly as before.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = process.env.DB_FILE
  || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'data.sqlite') : null)
  || path.join(__dirname, 'data.sqlite');

let db;
let batchDepth = 0;          // reference count for beginBatch/endBatch
let txnActive = false;       // is OUR batch transaction open?

/* ------------------------------------------------------------------ *
 * init
 * ------------------------------------------------------------------ */
async function init() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  console.log('• Database file:', DB_FILE);

  db = new Database(DB_FILE);

  // WAL: readers never block the writer. Big responsiveness win for the panel.
  try { db.pragma('journal_mode = WAL'); } catch (_) {}
  // NORMAL is the recommended durability level with WAL and is far faster
  // than FULL while still being crash-safe for our use case.
  try { db.pragma('synchronous = NORMAL'); } catch (_) {}
  // Wait instead of throwing SQLITE_BUSY if something else holds the file.
  try { db.pragma('busy_timeout = 10000'); } catch (_) {}
  applyPerfPragmas(db);
  try { db.pragma('foreign_keys = ON'); } catch (_) {}

  // Fresh optimizer statistics on first boot only (ANALYZE can be slow on a
  // huge database, so we never rerun it automatically here — see runAnalyze()).
  try {
    const hasStats = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'");
    if (!hasStats) { db.exec('ANALYZE'); console.log('• ANALYZE: fresh optimizer statistics created'); }
  } catch (_) {}

  return db;
}

/**
 * PHASE-1 perf pragmas (env-tunable):
 *   SQLITE_CACHE_MB   page-cache MB (default 256; 512+ recommended on 8 GB VPS)
 *   SQLITE_MMAP_BYTES mmap window (default 1 GB) — reads avoid memcpy for hot pages
 *   temp_store=MEMORY sorts/temp tables stay in RAM
 */
function applyPerfPragmas(target) {
  const cacheMb = Math.max(16, parseInt(process.env.SQLITE_CACHE_MB || '256', 10) || 256);
  try { target.pragma(`cache_size = -${cacheMb * 1024}`); } catch (_) {}
  const mmap = parseInt(process.env.SQLITE_MMAP_BYTES || '1073741824', 10);
  if (Number.isFinite(mmap) && mmap > 0) { try { target.pragma(`mmap_size = ${mmap}`); } catch (_) {} }
  try { target.pragma('temp_store = MEMORY'); } catch (_) {}
  // LIKE prefix searches on BINARY-collated indexed columns need this to use
  // the index (phone numbers have no case). Text searches in queries are
  // wrapped in LOWER() so user-facing case-insensitivity is preserved.
  try { target.pragma('case_sensitive_like = ON'); } catch (_) {}
}

/* ------------------------------------------------------------------ *
 * Transaction / batching
 * ------------------------------------------------------------------ */
function inTransaction() {
  try { return db.inTransaction; } catch (_) { return false; }
}

function beginBatch() {
  batchDepth++;
  // Only open a transaction if nothing else already has one open.
  // PHASE-1: IMMEDIATE — take the write lock up-front so read-then-write
  // upgrades can't hit SQLITE_BUSY_SNAPSHOT once a second writer process
  // exists (Phase-2 process split).
  if (batchDepth === 1 && !inTransaction()) {
    try { db.exec('BEGIN IMMEDIATE'); txnActive = true; } catch (_) { txnActive = false; }
  }
}

function commitBatch() {
  if (txnActive && inTransaction()) {
    try { db.exec('COMMIT'); }
    catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }
  txnActive = false;
}

function endBatch() {
  if (batchDepth > 0) batchDepth--;
  if (batchDepth === 0) commitBatch();
}

/**
 * Close a batch without forcing an fsync.
 *
 * With sql.js this skipped rewriting the whole file. With better-sqlite3 the
 * data is already durable, so this simply closes the transaction. Kept for API
 * compatibility with background tasks that call it.
 */
function endBatchNoSave() {
  if (batchDepth > 0) batchDepth--;
  if (batchDepth === 0) commitBatch();
}

/** Re-run ANALYZE on demand (admin endpoint / post-maintenance). */
function runAnalyze() {
  try { db.exec('ANALYZE'); return true; }
  catch (e) { console.warn('ANALYZE failed:', e.message); return false; }
}

/**
 * save() — no-op flush.
 *
 * better-sqlite3 writes as it goes, so there is nothing to serialise. If a
 * batch transaction is open we commit it, which matches the old contract of
 * "make everything durable now".
 */
function save() {
  if (batchDepth === 0 && txnActive) commitBatch();
  return true;
}

/* ------------------------------------------------------------------ *
 * Statement helpers
 * A small prepared-statement cache keeps hot queries fast.
 * ------------------------------------------------------------------ */
const stmtCache = new Map();
const STMT_CACHE_MAX = 500;

function prep(sql) {
  let s = stmtCache.get(sql);
  if (s) return s;
  s = db.prepare(sql);
  if (stmtCache.size >= STMT_CACHE_MAX) {
    // simple FIFO trim
    const firstKey = stmtCache.keys().next().value;
    stmtCache.delete(firstKey);
  }
  stmtCache.set(sql, s);
  return s;
}

/**
 * better-sqlite3 rejects `undefined` and plain booleans as bind parameters,
 * while sql.js quietly coerced them. Normalise so existing callers behave
 * exactly as they did before.
 */
function normParams(params) {
  if (params == null) return [];
  const arr = Array.isArray(params) ? params : [params];
  return arr.map(v => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number' && !Number.isFinite(v)) return null;
    if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
    return v;
  });
}

/* ------------------------------------------------------------------ *
 * PHASE-1: slow-query detection (#40)
 * Every run/get/all is timed; anything >= SLOW_QUERY_MS (default 200)
 * is logged with the SQL. slowQueryStats() feeds /api/health.
 * ------------------------------------------------------------------ */
const SLOW_MS = Math.max(50, parseInt(process.env.SLOW_QUERY_MS || '200', 10) || 200);
const slowStats = { count: 0, worstMs: 0, lastSql: '', thresholdMs: SLOW_MS };
function noteSlow(sql, t0) {
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (ms < SLOW_MS) return;
  slowStats.count++;
  if (ms > slowStats.worstMs) slowStats.worstMs = Math.round(ms);
  slowStats.lastSql = String(sql).replace(/\s+/g, ' ').slice(0, 160);
  console.warn(`[SLOW_QUERY] ${ms.toFixed(0)}ms :: ${slowStats.lastSql}`);
}
function slowQueryStats() { return { ...slowStats }; }

function run(sql, params = []) {
  const t0 = process.hrtime.bigint();
  const info = prep(sql).run(...normParams(params));
  noteSlow(sql, t0);
  return { lastInsertRowid: Number(info.lastInsertRowid), changes: info.changes };
}

// Same as run(); the old layer only differed in whether it rewrote the file.
function runNoSave(sql, params = []) {
  return run(sql, params);
}

function get(sql, params = []) {
  const t0 = process.hrtime.bigint();
  const row = prep(sql).get(...normParams(params));
  noteSlow(sql, t0);
  return row === undefined ? null : row;
}

function all(sql, params = []) {
  const t0 = process.hrtime.bigint();
  const rows = prep(sql).all(...normParams(params));
  noteSlow(sql, t0);
  return rows;
}

/**
 * exec() — multi-statement DDL / raw SQL.
 *
 * The old sql.js layer silently ignored a COMMIT or ROLLBACK issued without a
 * matching BEGIN. Several routes rely on that (they COMMIT at the end of a
 * chunked job that never opened a transaction). Preserve that tolerance so
 * behaviour is identical, and keep our batch bookkeeping in sync.
 */
function execRaw(sql) {
  const trimmed = String(sql || '').trim();
  const upper = trimmed.toUpperCase();

  if (/^BEGIN(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE|TRANSACTION))*\s*;?$/.test(upper)) {
    if (inTransaction()) return;            // already inside one — no-op
    db.exec('BEGIN');
    return;
  }
  if (/^COMMIT(\s+TRANSACTION)?\s*;?$/.test(upper) || /^END(\s+TRANSACTION)?\s*;?$/.test(upper)) {
    if (!inTransaction()) return;           // nothing open — old layer ignored it
    db.exec('COMMIT');
    txnActive = false;
    return;
  }
  if (/^ROLLBACK(\s+TRANSACTION)?\s*;?$/.test(upper)) {
    if (!inTransaction()) return;
    db.exec('ROLLBACK');
    txnActive = false;
    return;
  }
  db.exec(trimmed);
}

function exec(sql) { execRaw(sql); }
function execNoSave(sql) { execRaw(sql); }

/* ------------------------------------------------------------------ *
 * Backup helpers
 * ------------------------------------------------------------------ */
function exportBuffer() {
  // Read a consistent snapshot: checkpoint WAL into the main file first so the
  // buffer is a complete, restorable database.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  return fs.readFileSync(DB_FILE);
}

function getDbFile() {
  return DB_FILE;
}

function replaceWithFile(filePath) {
  const buf = fs.readFileSync(filePath);
  // Validate before destroying the live database.
  const tmp = DB_FILE + '.restore-tmp';
  fs.writeFileSync(tmp, buf);
  let probe;
  try {
    probe = new Database(tmp, { readonly: true });
    probe.prepare('SELECT count(*) c FROM sqlite_master').get();
    probe.close();
  } catch (e) {
    try { if (probe) probe.close(); } catch (_) {}
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw new Error('Restore file is not a valid SQLite database: ' + e.message);
  }

  stmtCache.clear();
  batchDepth = 0;
  txnActive = false;
  try { db.close(); } catch (_) {}

  // Remove stale WAL/SHM so the restored file is authoritative.
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {}
  }
  fs.renameSync(tmp, DB_FILE);

  db = new Database(DB_FILE);
  applyPerfPragmas(db);
  try { db.pragma('journal_mode = WAL'); } catch (_) {}
  try { db.pragma('synchronous = NORMAL'); } catch (_) {}
  try { db.pragma('busy_timeout = 10000'); } catch (_) {}
  try { db.pragma('foreign_keys = ON'); } catch (_) {}
  return db;
}

function vacuum() {
  try {
    if (inTransaction()) { try { db.exec('COMMIT'); txnActive = false; } catch (_) {} }
    stmtCache.clear();
    db.exec('VACUUM');
    return true;
  } catch (e) {
    console.warn('VACUUM failed:', e.message);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Clean shutdown: checkpoint WAL so the .sqlite file is self-contained.
 * ------------------------------------------------------------------ */
function closeDb() {
  try {
    if (inTransaction()) { try { db.exec('COMMIT'); } catch (_) {} }
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (_) {}
}
process.on('exit', closeDb);
process.once('SIGINT', () => { closeDb(); process.exit(0); });
process.once('SIGTERM', () => { closeDb(); process.exit(0); });

/* P11: cursor-based row iteration for memory-safe streaming of very large pages.
   Returns a generator; rows are pulled one-by-one (no full materialization). */
function* iterate(sql, params = []) {
  const stmt = db.prepare(sql);
  for (const row of stmt.iterate(...params)) yield row;
}

module.exports = {
  init, run, runNoSave, exec, execNoSave, get, all, save, iterate,
  beginBatch, endBatch, endBatchNoSave, vacuum,
  exportBuffer, getDbFile, replaceWithFile,
  slowQueryStats, runAnalyze, inTransaction,
};
