const fs = require('fs');
const { Pool } = require('pg');
const logger = require('./logger').createLogger('database');

/**
 * Security-hardening note: this pool USED to set
 * `ssl: { rejectUnauthorized: false }` unconditionally whenever
 * `NODE_ENV === 'production'` -- i.e. the connection was always
 * encrypted but the server's certificate was never actually verified,
 * making it vulnerable to a man-in-the-middle attack regardless of how
 * the database was reached. `server/config/configValidator.js` already
 * logged a startup warning calling this out (Requirement 15.5), but only
 * ever as an accepted warning, never a fix.
 *
 * The fix: in production, TLS is still enabled by default (preserving
 * "encrypted by default"), but certificate verification is now actually
 * ON (`rejectUnauthorized: true`, `pg`'s own default whenever an `ssl`
 * object is supplied at all). WHERE `DB_CA_PATH` points at a CA bundle
 * (e.g. AWS RDS's public `rds-ca-*.pem`, needed for a private/self-signed
 * chain), it is loaded and used for verification -- mirroring the
 * already-established `TAK_CA_PATH` pattern in
 * `server/services/TakServerService.js`'s `buildMutualTlsAgentOptions`.
 * WHERE `DB_CA_PATH` is unset, verification falls back to Node's default
 * system trust store, which is sufficient for a managed database whose
 * certificate chains to a publicly trusted root (true for AWS RDS's
 * current CA hierarchy).
 *
 * Outside production, `ssl: false` is unchanged from before -- local/dev
 * Postgres typically has no TLS listener configured at all.
 */
function resolveSslOption() {
  if (process.env.NODE_ENV !== 'production') {
    return false;
  }

  const caPath = process.env.DB_CA_PATH;
  if (typeof caPath === 'string' && caPath.trim().length > 0) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath) };
  }

  return { rejectUnauthorized: true };
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: resolveSslOption(),
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