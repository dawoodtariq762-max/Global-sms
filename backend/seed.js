/**
 * Seed — sirf ek Admin account banata hai (agar DB khaali ho).
 * Koi demo/fake data nahi. Baaki sab (managers, agents, clients,
 * ranges, numbers) aap panel se khud add karenge.
 */
const db = require('./db');
const bcrypt = require('bcryptjs');

function hash(p) { return bcrypt.hashSync(p, 10); }

// ==== ADMIN CREDENTIALS (yahan change kar sakte hain) ====
const ADMIN_USERNAME = 'vibepk';
const ADMIN_PASSWORD = 'vibepk123';

function ensureTestAccount() {
  const existing = db.get("SELECT id FROM users WHERE username=? COLLATE NOCASE", ['test']);
  if (existing) return;
  db.run(`INSERT INTO users (username,password,role,name,active) VALUES (?,?,?,?,1)`,
    ['test', hash('test123'), 'test', 'Test Panel']);
  console.log('✓ Test Panel account created — username: test');
}

function seed() {
  const existing = db.get('SELECT COUNT(*) AS c FROM users');
  if (existing && existing.c > 0) { console.log('• Seed skipped (users already present)'); ensureTestAccount(); return; }

  console.log('• Creating admin account...');
  db.run(
    `INSERT INTO users (username,password,role,name,active) VALUES (?,?,?,?,1)`,
    [ADMIN_USERNAME, hash(ADMIN_PASSWORD), 'admin', 'Administrator']
  );
  console.log(`✓ Admin created — username: ${ADMIN_USERNAME}`);
  ensureTestAccount();
  console.log('  (Ab is se login karke managers/agents/clients/ranges add karein)');
}

module.exports = { seed };
