/**
 * Structured logger (Requirement 13: Implement Structured, Correlated Logging)
 *
 * Exports a configured `pino` instance so that ad hoc `console.log`/
 * `console.error` calls across `server/` can be replaced with structured,
 * level-gated JSON logging (Criterion 13.1: JSON log lines containing at
 * minimum a severity level, an ISO 8601 timestamp, and a module name).
 *
 * The `level` is driven by the `LOG_LEVEL` environment variable, defaulting
 * to `info` when unset (matching the "disabled by default in production"
 * requirement for `debug`-level logging).
 *
 * Redaction (Criterion 13.6): email addresses, names, passwords, and
 * token-shaped fields SHALL be replaced with `[REDACTED]` in logs at `info`
 * level and above, and SHALL only appear unredacted in logs emitted at
 * `debug` level. Pino's built-in `redact` option applies uniformly to every
 * log call regardless of that call's level, so to honor the
 * "unredacted only at debug" half of Criterion 13.6, redaction is only
 * wired in when the effective level is NOT `debug` — i.e. an operator who
 * explicitly opts into `LOG_LEVEL=debug` sees raw field values on debug
 * (and higher) log lines, while the default `info` level (and any other
 * non-debug level) always redacts.
 *
 * `server/middleware/requestContext.js` (a later task) is expected to
 * derive correlation-scoped child loggers from this instance via
 * `logger.child({ correlationId })`, and call sites elsewhere are expected
 * to derive module-scoped child loggers via `logger.child({ module: '...' })`
 * (or the `createLogger` convenience helper exported below) so that every
 * log line carries a module name per Criterion 13.1.
 */

const pino = require('pino');

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

// Requirement 13.6: PII/secret-shaped fields to redact. Paths cover common
// top-level property names plus one level of nesting under a handful of
// conventional container objects (`req.body`, `user`, `payload`) already
// used across `server/routes` and `server/services`. Pino's redact paths
// do not support unbounded-depth wildcards, so deeper nesting is redacted
// as those specific call sites are migrated to structured logging (task 33).
const REDACT_PATHS = [
  'email',
  'first_name',
  'last_name',
  'name',
  'password',
  'service_account_password',
  'authentik_admin_token',
  'token',
  'jwt',
  'req.body.email',
  'req.body.first_name',
  'req.body.last_name',
  'req.body.password',
  'req.body.token',
  'user.email',
  'user.first_name',
  'user.last_name',
  'payload.email',
  'payload.first_name',
  'payload.last_name',
  'payload.password',
  'payload.service_account_password',
  'payload.authentik_admin_token'
];

const REDACT_CENSOR = '[REDACTED]';

const pinoOptions = {
  level: LOG_LEVEL,
  // Requirement 13.1: ISO 8601 timestamps rather than pino's default epoch
  // millis.
  timestamp: pino.stdTimeFunctions.isoTime,
  // Requirement 13.6: redact at every level except `debug`, so that
  // `LOG_LEVEL=debug` (never the default) is the only way to see raw field
  // values, and the default `info` level always redacts.
  ...(LOG_LEVEL === 'debug'
    ? {}
    : { redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR } })
};

const logger = pino(pinoOptions);

/**
 * Convenience helper returning a module-scoped child logger, so call sites
 * get a `module` field on every log line (Requirement 13.1) without each
 * one hand-rolling `logger.child({ module: ... })`.
 *
 * @param {string} moduleName
 * @returns {import('pino').Logger}
 */
function createLogger(moduleName) {
  return logger.child({ module: moduleName });
}

module.exports = logger;
module.exports.createLogger = createLogger;
module.exports.REDACT_PATHS = REDACT_PATHS;
module.exports.REDACT_CENSOR = REDACT_CENSOR;
