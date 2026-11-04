/**
 * PHASE-2 export worker — runs in a worker_thread so multi-million-row CSV
 * exports NEVER touch the API event loop.
 * Receives workerData: { jobId, dbFile, exportFile, payload }
 *   payload: { type: 'numbers'|'sms', scopeCol, scopeId, filters {...} }
 * Streams keyset batches (id > lastId ORDER BY id LIMIT 20000) from its own
 * READ-ONLY SQLite connection (WAL = parallel with the API process) and posts
 * progress messages back to the main thread.
 */
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const fs = require('fs');

const BATCH = 20000;
const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

try {
  const { jobId, dbFile, exportFile, payload } = workerData;
  const db = new Database(dbFile, { readonly: true });
  // Sequential keyset scan: tiny cache, NO mmap (keeps worker RSS ~30-60 MB)
  db.pragma('cache_size = -32768');
  db.pragma('mmap_size = 0');

  const alias = payload.type === 'sms' ? 's' : 'n';
  const scopeCol = payload.scopeCol; // null = admin
  const scopeId = payload.scopeId;
  const f = { ...(payload.filters || {}), ...payload };
  const where = [];
  const params = [];
  if (scopeCol) { where.push(`${alias}.${scopeCol} = ?`); params.push(scopeId); }
  if (f.search && /^\+?\d{3,}$/.test(String(f.search))) {
    const digits = String(f.search).replace(/\D+/g, '');
    where.push(`${alias}.number LIKE ?`); params.push(digits + '%');
  }
  if (f.from) { where.push(`${alias}.received_at >= ?`); params.push(String(f.from)); }
  if (f.to) { where.push(`${alias}.received_at <= ?`); params.push(String(f.to)); }

  let sql, header;
  if (payload.type === 'numbers') {
    if (f.range) { where.push(`r.name = ?`); params.push(String(f.range)); }
    if (f.provider) { where.push(`r.provider = ?`); params.push(String(f.provider)); }   /* P19k #8 */
    const ownerCol = scopeCol === 'manager_id' ? 'agent_id' : (scopeCol === 'agent_id' ? 'client_id' : null);
    if (f.allocation === 'unallocated') {
      where.push(ownerCol ? `${ownerCol} IS NULL` : 'manager_id IS NULL AND agent_id IS NULL AND client_id IS NULL');
    } else if (f.allocation === 'allocated') {
      where.push(ownerCol ? `${ownerCol} IS NOT NULL` : '(manager_id IS NOT NULL OR agent_id IS NOT NULL OR client_id IS NOT NULL)');
    }
    sql = `SELECT n.id, n.number, r.name AS range_name, n.prefix, n.rate, n.payterm, n.payout,
             mu.username AS manager_name, au.username AS agent_name, cu.username AS client_name, n.imported_at
           FROM numbers n
           LEFT JOIN ranges r ON r.id = n.range_id
           LEFT JOIN users cu ON cu.id = n.client_id
           LEFT JOIN users au ON au.id = n.agent_id
           LEFT JOIN users mu ON mu.id = n.manager_id
           ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
           ORDER BY n.id ASC LIMIT ? OFFSET ?`;
    header = 'id,number,range,prefix,rate,payterm,payout,manager,agent,client,imported_at';
  } else {
    sql = `SELECT s.id, s.received_at, s.number, s.cli, s.message, s.otp_code, s.sender_type,
             r.name AS range_name, mu.username AS manager_name, au.username AS agent_name, cu.username AS client_name,
             s.payout_rate, s.payout_amount
           FROM sms_records s
           LEFT JOIN ranges r ON r.id = s.range_id
           LEFT JOIN users cu ON cu.id = s.client_id
           LEFT JOIN users au ON au.id = s.agent_id
           LEFT JOIN users mu ON mu.id = s.manager_id
           ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
           ORDER BY s.id ASC LIMIT ? OFFSET ?`;
    header = 'id,received_at,number,cli,message,otp_code,sender_type,range,manager,agent,client,payout_rate,payout_amount';
  }

  const out = fs.createWriteStream(exportFile, { flags: 'w' });
  out.write(header + '\n');
  let lastId = 0, rows = 0, bytes = 0;
  const run = db.prepare(sql);
  const progressEvery = 100000;
  let sinceProgress = 0;

  function pump() {
    const batch = run.all(...params, BATCH, rows);
    if (!batch.length) { out.end(() => finish()); return; }
    let chunk = '';
    for (const r of batch) {
      const vals = payload.type === 'numbers'
        ? [r.id, r.number, r.range_name, r.prefix, r.rate, r.payterm, r.payout, r.manager_name, r.agent_name, r.client_name, r.imported_at]
        : [r.id, r.received_at, r.number, r.cli, r.message, r.otp_code, r.sender_type, r.range_name, r.manager_name, r.agent_name, r.client_name, r.payout_rate, r.payout_amount];
      chunk += vals.map(esc).join(',') + '\n';
    }
    lastId = batch[batch.length - 1].id;
    rows += batch.length;
    sinceProgress += batch.length;
    if (sinceProgress >= progressEvery) { sinceProgress = 0; parentPort.postMessage({ type: 'progress', rows }); }
    // backpressure: pause when the OS buffer is full, resume on drain
    if (!out.write(chunk)) { out.once('drain', pump); return; }
    setImmediate(pump);
  }

  function finish() {
    try { bytes = fs.statSync(exportFile).size; } catch (_) {}
    // final progress first so the main thread records the true row count
    parentPort.postMessage({ type: 'progress', rows });
    parentPort.postMessage({ type: 'done', rows, bytes });
    try { db.close(); } catch (_) {}
  }

  pump();
} catch (e) {
  parentPort.postMessage({ type: 'error', error: e.message });
}
