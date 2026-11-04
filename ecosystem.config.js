/**
 * PM2 Process Configuration — GLOBAL SMS
 * =============================================================================
 * Start:    pm2 start ecosystem.config.js
 * Reload:   pm2 restart ams-sms --update-env
 * Logs:     pm2 logs ams-sms
 *
 * ARCHITECTURAL REQUIREMENTS:
 *
 * exec_mode: 'fork' + instances: 1
 *   This application MUST run strictly in single-process mode because:
 *   1) Background telecom carrier pollers and sync timers run at fixed intervals.
 *   2) Automated database backups (VACUUM INTO) run periodically.
 *   3) better-sqlite3 uses WAL mode with single-process write-locking.
 *   Running PM2 cluster mode would duplicate background sync ticks and trigger
 *   WAL write-lock contention.
 *
 * max_memory_restart: '1500M'
 *   Steady-state memory footprint is ~150 MB - 250 MB. 1500M acts as a safeguard.
 *
 * kill_timeout: 10000
 *   Ensures that on process shutdown, PRAGMA wal_checkpoint(TRUNCATE) has up
 *   to 10 seconds to finish flushing WAL frames back into data.sqlite cleanly.
 * =============================================================================
 */
module.exports = {
  apps: [
    {
      name: 'ams-sms',
      script: 'backend/server.js',
      cwd: __dirname,

      exec_mode: 'fork',
      instances: 1,

      autorestart: true,
      watch: false,
      max_memory_restart: '1500M',
      exp_backoff_restart_delay: 200,
      min_uptime: '30s',
      max_restarts: 10,
      restart_delay: 2000,

      kill_timeout: 10000,
      shutdown_with_message: false,
      wait_ready: false,

      time: true,
      merge_logs: true,
      error_file: './logs/error.log',
      out_file: './logs/out.log',

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
