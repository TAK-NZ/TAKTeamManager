const { Pool } = require('pg');
const logger = require('./logger').createLogger('database');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // Requirement 8.6: explicit maximum pool size, configurable via
  // DB_POOL_MAX, sized for the documented scale target of up to 50,000
  // users rather than relying on the pg library's default.
  max: parseInt(process.env.DB_POOL_MAX, 10) || 20
});

// Requirement 8.5: register a pool-level error handler, matching the
// pattern already present in server/workers/syncWorker.js, so that an
// idle client error (e.g. a connection dropped by the database or network)
// emits an 'error' event that is logged rather than crashing the process
// via an uncaught exception.
pool.on('error', (err) => {
  logger.error({ err }, 'Database pool error');
});

module.exports = pool;