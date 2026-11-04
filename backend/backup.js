/**
 * Backup service for GLOBAL SMS.
 * - Uses sql.js export buffer from db.js for consistent snapshots.
 * - Writes backups atomically to a dedicated folder.
 * - Retains backups for a configurable number of days.
 * - Designed for VPS deployment.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
/* Backup file naming. New backups use "global-sms-backup-<ts>.sqlite".
   Backups created under the panel's earlier backup prefixes are still listed,
   restorable and pruned by retention — only the prefix differs. Those legacy
   strings remain here solely so existing production backups stay visible. */
const BACKUP_PREFIX = 'global-sms-backup-';
const LEGACY_BACKUP_PREFIXES = ['ams-sms-backup-', 'qtech-sms-backup-', 'nova-sms-backup-', 'almada-sms-backup-'];
const BACKUP_NAME_RE = /^(?:(?:global|ams|qtech|almada|nova)-sms-backup-)\d{4}-\d{2}-\d{2}T[\w-]+\.sqlite$/; /* new = global, earlier prefixes still honoured */
function isBackupFileName(base){ return BACKUP_NAME_RE.test(String(base||'')); }
function getDbFile(db) {
  return db.getDbFile ? db.getDbFile() : path.join(__dirname, 'data.sqlite');
}
function getBackupDir(db) {
  return process.env.BACKUP_DIR
    || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'backups') : null)
    // VPS-safe default: outside the application folder, so backups survive accidental app deletion.
    || path.join(os.homedir(), 'ams-sms-backups');
}
function ensureBackupDir(db) {
  const dir = getBackupDir(db);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function safeBackupName(name) {
  const base = path.basename(String(name || ''));
  if (!isBackupFileName(base)) {
    throw new Error('Invalid backup file name');
  }
  return base;
}
function backupPath(db, fileName) {
  return path.join(ensureBackupDir(db), safeBackupName(fileName));
}
function listBackups(db) {
  const dir = ensureBackupDir(db);
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.sqlite') && (f.startsWith(BACKUP_PREFIX) || LEGACY_BACKUP_PREFIXES.some(p => f.startsWith(p))))
    .map(file => {
      const fullPath = path.join(dir, file);
      const st = fs.statSync(fullPath);
      return {
        file,
        size: st.size,
        created_at: st.birthtime.toISOString(),
        modified_at: st.mtime.toISOString(),
      };
    })
    .sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at));
}
function createBackup(db, reason = 'manual') {
  const dir = ensureBackupDir(db);
  if (db.save) db.save();
  const file = `${BACKUP_PREFIX}${ts()}.sqlite`;
  const fullPath = path.join(dir, file);
  const tmpPath = fullPath + '.tmp';
  // PHASE-2 MEMORY FIX: exportBuffer() was the sql.js-era whole-DB-in-a-Buffer
  // API — on a multi-GB database it allocated the entire file in RAM (1.86 GB
  // at 5M numbers) and got the process OOM-killed. VACUUM INTO writes the
  // same complete, restorable snapshot directly to disk with O(1) Node memory.
  let done = false;
  try {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) {}
    db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    done = true;
  } catch (_) { /* fall back below */ }
  if (!done) {
    const buffer = db.exportBuffer ? db.exportBuffer() : fs.readFileSync(getDbFile(db));
    fs.writeFileSync(tmpPath, Buffer.from(buffer));
  }
  fs.renameSync(tmpPath, fullPath);
  return { file, size: fs.statSync(fullPath).size, reason, created_at: new Date().toISOString() };
}
function cleanupOldBackups(db) {
  const days = Math.max(1, parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const backups = listBackups(db);
  const deleted = [];
  for (const b of backups) {
    const t = new Date(b.modified_at).getTime();
    if (t < cutoff) {
      const fullPath = backupPath(db, b.file);
      fs.unlinkSync(fullPath);
      deleted.push(b.file);
    }
  }
  return deleted;
}
function deleteBackup(db, fileName) {
  const fullPath = backupPath(db, fileName);
  if (!fs.existsSync(fullPath)) throw new Error('Backup not found');
  fs.unlinkSync(fullPath);
  return true;
}
function getLatestBackup(db) {
  return listBackups(db)[0] || null;
}
function restoreBackup(db, fileName) {
  const fullPath = backupPath(db, fileName);
  if (!fs.existsSync(fullPath)) throw new Error('Backup not found');
  // Always create a safety snapshot before restore.
  const safety = createBackup(db, 'pre-restore-safety');
  if (!db.replaceWithFile) throw new Error('Database restore is not supported by db layer');
  db.replaceWithFile(fullPath);
  return { ok: true, restored_from: path.basename(fileName), safety_backup: safety.file };
}
function startAutomaticBackups(db, logger = console) {
  const enabled = String(process.env.BACKUP_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    logger.log('• Automatic backups disabled');
    return null;
  }
  const hours = Math.max(1, parseFloat(process.env.BACKUP_INTERVAL_HOURS || '3'));
  const ms = hours * 60 * 60 * 1000;
  // Create a startup backup shortly after boot, then schedule interval.
  setTimeout(() => {
    try { createBackup(db, 'startup'); cleanupOldBackups(db); logger.log('✓ Startup backup created'); }
    catch (e) { logger.error('Backup error:', e.message); }
  }, 15000);
  const timer = setInterval(() => {
    try { const b = createBackup(db, 'auto'); cleanupOldBackups(db); logger.log('✓ Auto backup created:', b.file); }
    catch (e) { logger.error('Backup error:', e.message); }
  }, ms);
  if (timer.unref) timer.unref();
  logger.log(`• Automatic backups enabled: every ${hours} hour(s), dir: ${getBackupDir(db)}`);
  return timer;
}
module.exports = {
  getBackupDir,
  listBackups,
  createBackup,
  cleanupOldBackups,
  deleteBackup,
  getLatestBackup,
  restoreBackup,
  backupPath,
  startAutomaticBackups,
};
