/**
 * Config_Validator (Requirement 15: Validate Required Configuration at Startup)
 *
 * Validates required environment variables at startup so that the App and
 * Sync_Worker fail fast with a clear, actionable error instead of an
 * obscure runtime failure deep inside a request handler or sync operation.
 *
 * Scope of this module today: presence/non-empty (after `.trim()`) checks
 * for the Requirement 15.1 variable list (Criteria 15.1, 15.2); URL
 * well-formedness checks for AUTHENTIK_URL/APP_URL/FRONTEND_URL (Criteria
 * 15.3, 15.4); JWT_SECRET length / JWT_EXPIRES_IN duration checks (Criteria
 * 3.5, 3.6); the TAK Server mutual TLS credential gate described in
 * Requirement 26.1-26.2 (see `collectTakServerConfigIssues` below), which
 * only applies WHERE `TAK_SERVER_URL` is configured; the Requirement 25.1/
 * 25.4 data-retention threshold checks for `SYNC_OPERATIONS_RETENTION_DAYS`
 * and `AUDIT_LOGS_RETENTION_DAYS` (see `collectRetentionConfigIssues`
 * below); when `NODE_ENV=production`, the secrets-manager gate
 * described in Requirement 6.4 (see `validateProductionSecrets` below);
 * the Requirement 15.5 production database-TLS-certificate-validation
 * warning (see `checkDatabaseTlsCertificateValidationWarning` below); and
 * the Requirement 1 Criterion 5 startup assertion that a route module is
 * mounted at `/api/auth` (see `assertAuthRouteMounted` below).
 */

const { getSecretsProvider } = require('./secretsProvider');
const { createLogger } = require('./logger');

const logger = createLogger('configValidator');

// Requirement 15.1: required environment variables for both the App and the
// Sync_Worker. These are read from `server/index.js`, `server/config/database.js`,
// `server/workers/syncWorker.js`, `server/services/authentik.js`, and
// `server/routes/auth.js` today.
const REQUIRED_VARS = [
  'DB_HOST',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'AUTHENTIK_URL',
  'AUTHENTIK_ADMIN_TOKEN',
  'AUTHENTIK_CLIENT_ID',
  'AUTHENTIK_CLIENT_SECRET',
  'JWT_SECRET',
  'FRONTEND_URL',
  'APP_URL'
];

// Requirement 15.3/15.4: the environment variables that must be well-formed
// absolute URLs.
const URL_VARS = ['AUTHENTIK_URL', 'APP_URL', 'FRONTEND_URL'];

// Requirement 3.5: minimum acceptable JWT_SECRET length.
const MIN_JWT_SECRET_LENGTH = 32;

// Requirement 3.6: JWT_EXPIRES_IN duration bounds, expressed in milliseconds.
const MIN_JWT_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const MAX_JWT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Requirement 6.4: when NODE_ENV=production, these secrets MUST be
// resolved through the configured SecretsProvider (see
// `server/config/secretsProvider.js`) rather than trusted as-is from a
// plain `.env` value. `EMAIL_PASSWORD` is the generic SMTP credential
// actually read by `EmailService.js` (any SMTP-compatible provider, not
// tied to AWS SES specifically -- see that file's header comment).
const PRODUCTION_SECRET_VARS = [
  'AUTHENTIK_ADMIN_TOKEN',
  'JWT_SECRET',
  'DB_PASSWORD',
  'EMAIL_PASSWORD'
];

// Requirement 26.1: WHERE TAK_SERVER_URL is configured, the App/Sync_Worker
// must additionally require mutual TLS client credentials for TAK Server,
// expressed as one of two credential pairs. `TAK_CA_PATH` is optional in
// both cases (Criterion 26.1 "MAY additionally read an optional
// `TAK_CA_PATH`") and is therefore never required here.
const TAK_SERVER_P12_CREDENTIAL_VARS = ['TAK_API_P12_PATH', 'TAK_API_P12_PASSPHRASE'];
const TAK_SERVER_CERT_KEY_CREDENTIAL_VARS = ['TAK_API_CERT_PATH', 'TAK_API_KEY_PATH'];

// Requirement 25.1/25.4: default retention thresholds (in days) for
// `sync_operations` and `audit_logs` rows respectively, consumed here and
// by `server/services/RetentionCleanupJob.js` (task 47.1), which reads
// these same two environment variables with the same defaults via
// `parseInt(process.env.X, 10) || DEFAULT` at the point it runs each
// cleanup pass.
const DEFAULT_SYNC_OPERATIONS_RETENTION_DAYS = 90;
const DEFAULT_AUDIT_LOGS_RETENTION_DAYS = 365;

// jsonwebtoken-style short duration units accepted in JWT_EXPIRES_IN, e.g.
// "10m", "36h", "45d". Matches the subset of `ms`-package units that make
// sense for a session duration.
const DURATION_UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000
};

/**
 * Returns the subset of `varNames` that are missing or empty (after
 * trimming whitespace) in `env`.
 *
 * @param {string[]} varNames
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]} the names of the missing/empty variables, in the
 *   order they were checked.
 */
function findMissingOrEmpty(varNames, env) {
  return varNames.filter((name) => {
    const value = env[name];
    return typeof value !== 'string' || value.trim().length === 0;
  });
}

/**
 * Pure predicate: is `value` a well-formed absolute URL with an `http` or
 * `https` scheme and a non-empty host? (Requirement 15.3)
 *
 * Implemented as a standalone, testable function (rather than inlined)
 * because it is also exercised directly by a property-based test (see
 * task 2.3*).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isWellFormedUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (err) {
    return false;
  }

  const scheme = parsed.protocol.replace(':', '');
  return (scheme === 'http' || scheme === 'https') && parsed.host.length > 0;
}

/**
 * Parses a jsonwebtoken-style duration string/number into milliseconds.
 *
 * Accepts:
 *  - a plain number (or numeric string) of seconds, e.g. `3600` or `"3600"`
 *  - a short duration string of the form `<number><unit>` where unit is
 *    one of `s`, `m`, `h`, `d`, `w` (seconds/minutes/hours/days/weeks),
 *    e.g. `"10m"`, `"36h"`, `"45d"`
 *
 * @param {unknown} value
 * @returns {number|null} the duration in milliseconds, or `null` if
 *   `value` cannot be parsed.
 */
function parseDurationMs(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value * 1000 : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Plain numeric string -> seconds.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return parseFloat(trimmed) * 1000;
  }

  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i.exec(trimmed);
  if (!match) {
    return null;
  }

  const amount = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  return amount * DURATION_UNIT_MS[unit];
}

/**
 * Pure predicate: does `value` parse to a duration between 5 minutes and
 * 30 days inclusive? (Requirement 3.6)
 *
 * Implemented as a standalone, testable function because it is also
 * exercised directly by a property-based test (see task 2.4*).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidJwtExpiry(value) {
  const ms = parseDurationMs(value);
  if (ms === null || !Number.isFinite(ms)) {
    return false;
  }
  return ms >= MIN_JWT_EXPIRY_MS && ms <= MAX_JWT_EXPIRY_MS;
}

/**
 * Requirement 26.1/26.2: WHERE `TAK_SERVER_URL` is configured (non-empty
 * after trimming), requires `TAK_SERVER_URL` itself to be a well-formed
 * URL and requires one of the two mutual TLS client credential pairs to be
 * fully present and non-empty:
 *  - `TAK_API_P12_PATH` + `TAK_API_P12_PASSPHRASE`, or
 *  - `TAK_API_CERT_PATH` + `TAK_API_KEY_PATH`
 *
 * `TAK_CA_PATH` is optional in either case and is never required.
 *
 * IF `TAK_SERVER_URL` is unset or empty, THEN this integration is optional
 * (Criterion 26.1) and this function returns no issues without requiring
 * any TAK Server credential variable.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]} human-readable issue descriptions; empty when the
 *   TAK Server integration is disabled or fully and validly configured.
 */
function collectTakServerConfigIssues(env) {
  const takServerUrl = env.TAK_SERVER_URL;
  const isConfigured = typeof takServerUrl === 'string' && takServerUrl.trim().length > 0;

  if (!isConfigured) {
    return [];
  }

  const issues = [];

  if (!isWellFormedUrl(takServerUrl)) {
    issues.push(
      `TAK_SERVER_URL is not a well-formed URL (must be an absolute http/https URL with a host): "${takServerUrl}"`
    );
  }

  const missingP12 = findMissingOrEmpty(TAK_SERVER_P12_CREDENTIAL_VARS, env);
  const missingCertKey = findMissingOrEmpty(TAK_SERVER_CERT_KEY_CREDENTIAL_VARS, env);

  const hasP12Pair = missingP12.length === 0;
  const hasCertKeyPair = missingCertKey.length === 0;

  if (!hasP12Pair && !hasCertKeyPair) {
    issues.push(
      'TAK_SERVER_URL is configured but no complete mutual TLS client credential pair was found: ' +
        `provide either both ${TAK_SERVER_P12_CREDENTIAL_VARS.join(' and ')} ` +
        `(missing/empty: ${missingP12.join(', ')}), ` +
        `or both ${TAK_SERVER_CERT_KEY_CREDENTIAL_VARS.join(' and ')} ` +
        `(missing/empty: ${missingCertKey.join(', ')})`
    );
  }

  return issues;
}

/**
 * WHERE `AUTHENTIK_LOGOUT_URL` is configured (non-empty after trimming),
 * requires it to be a well-formed absolute http/https URL, mirroring the
 * `TAK_SERVER_URL` optional-URL validation pattern above. `AUTHENTIK_LOGOUT_URL`
 * is Authentik's OIDC end-session endpoint for this application, used by
 * `server/routes/auth.js`'s `POST /api/auth/logout` to also end the
 * Authentik SSO session after clearing the local `tak_session` cookie.
 *
 * IF `AUTHENTIK_LOGOUT_URL` is unset or empty, THEN this is optional and
 * this function returns no issues -- logout falls back to redirecting to
 * `FRONTEND_URL` instead (local session only).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]} human-readable issue descriptions; empty when unset
 *   or well-formed.
 */
function collectAuthentikLogoutUrlConfigIssues(env) {
  const logoutUrl = env.AUTHENTIK_LOGOUT_URL;
  const isConfigured = typeof logoutUrl === 'string' && logoutUrl.trim().length > 0;

  if (!isConfigured) {
    return [];
  }

  if (!isWellFormedUrl(logoutUrl)) {
    return [
      `AUTHENTIK_LOGOUT_URL is not a well-formed URL (must be an absolute http/https URL with a host): "${logoutUrl}"`
    ];
  }

  return [];
}

/**
 * Pure predicate: does `value` represent a positive integer (a whole
 * number greater than zero)? Accepts a plain positive-integer number, or
 * a string that -- after trimming -- consists only of digits and parses
 * to a value greater than zero. Rejects decimals, negative numbers, zero,
 * and non-numeric strings.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPositiveIntegerValue(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0;
  }

  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) && parseInt(trimmed, 10) > 0;
}

/**
 * Resolves the EFFECTIVE value of a retention-days environment variable:
 * IF `env[varName]` is unset or empty (after trimming), THEN the supplied
 * `defaultDays` applies and is inherently valid (mirroring the same
 * `parseInt(process.env.X, 10) || DEFAULT` default-application behavior
 * `RetentionCleanupJob.js` uses at the point it actually runs a cleanup
 * pass); OTHERWISE the set value must be a positive integer, and an
 * invalid set value produces an issue message rather than a resolved
 * effective value.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} varName
 * @param {number} defaultDays
 * @returns {{effectiveDays: number|null, issue: string|null}} `issue` is
 *   non-null only when the variable is set to something other than a
 *   positive integer, in which case `effectiveDays` is `null`.
 */
function resolveRetentionDaysConfig(env, varName, defaultDays) {
  const raw = env[varName];
  const isSet = typeof raw === 'string' ? raw.trim().length > 0 : raw !== undefined && raw !== null;

  if (!isSet) {
    return { effectiveDays: defaultDays, issue: null };
  }

  if (!isPositiveIntegerValue(raw)) {
    return {
      effectiveDays: null,
      issue: `${varName} must be a positive integer number of days (e.g. "90"): "${raw}"`
    };
  }

  return { effectiveDays: parseInt(raw, 10), issue: null };
}

/**
 * Requirement 25.1/25.4: validates the EFFECTIVE (default-applying)
 * values of `SYNC_OPERATIONS_RETENTION_DAYS` (default 90) and
 * `AUDIT_LOGS_RETENTION_DAYS` (default 365), the same two environment
 * variables read directly by `RetentionCleanupJob.deleteExpiredRows()`.
 *
 * Both values, if explicitly set, must parse to a positive integer
 * (Criterion 25.1/25.4's "configurable retention threshold"); an unset
 * variable is always valid because the stated default then applies.
 * Additionally, per Criterion 25.4's "distinct from and longer than",
 * the audit-log threshold's effective value MUST be strictly greater
 * than the sync-operations threshold's effective value. That ordering
 * check only runs when both effective values are resolvable -- if either
 * variable is set to a non-positive-integer, that is reported as its own
 * issue and the ordering check is skipped for this pass, rather than
 * comparing against a meaningless `null` value.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]} human-readable issue descriptions; empty when both
 *   thresholds are individually valid and correctly ordered.
 */
function collectRetentionConfigIssues(env) {
  const issues = [];

  const syncOperations = resolveRetentionDaysConfig(
    env,
    'SYNC_OPERATIONS_RETENTION_DAYS',
    DEFAULT_SYNC_OPERATIONS_RETENTION_DAYS
  );
  const auditLogs = resolveRetentionDaysConfig(
    env,
    'AUDIT_LOGS_RETENTION_DAYS',
    DEFAULT_AUDIT_LOGS_RETENTION_DAYS
  );

  if (syncOperations.issue) {
    issues.push(syncOperations.issue);
  }
  if (auditLogs.issue) {
    issues.push(auditLogs.issue);
  }

  if (syncOperations.effectiveDays !== null && auditLogs.effectiveDays !== null) {
    if (!(auditLogs.effectiveDays > syncOperations.effectiveDays)) {
      issues.push(
        `AUDIT_LOGS_RETENTION_DAYS's effective value (${auditLogs.effectiveDays} day(s)) must be ` +
          `strictly greater than SYNC_OPERATIONS_RETENTION_DAYS's effective value ` +
          `(${syncOperations.effectiveDays} day(s))`
      );
    }
  }

  return issues;
}

/**
 * Requirement 15.5: WHERE the App is started with `NODE_ENV=production`,
 * `server/config/database.js`'s connection pool unconditionally sets
 * `ssl: { rejectUnauthorized: false }` -- i.e. TLS certificate validation
 * is disabled -- purely as a function of `NODE_ENV === 'production'`
 * (there is no separate opt-in environment variable gating that setting).
 * This predicate mirrors that exact condition so the warning logged by
 * `validateConfig` below stays accurate to `database.js`'s actual
 * behavior.
 *
 * `server/workers/syncWorker.js`'s own dedicated database pool
 * configuration does not set `ssl: { rejectUnauthorized: false }` (or any
 * `ssl` option at all) today, so there is no equivalent Sync_Worker-side
 * condition to check here. This single, `NODE_ENV`-driven predicate is
 * still evaluated at Sync_Worker startup (via `validateConfig`, called
 * from both `server/index.js` and `server/workers/syncWorker.js`'s
 * `require.main === module` block), satisfying Requirement 15.5's "at
 * startup" for both processes.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function isDatabaseTlsCertificateValidationDisabled(env) {
  return env.NODE_ENV === 'production';
}

/**
 * Requirement 15.5: WHEN `isDatabaseTlsCertificateValidationDisabled(env)`
 * is true, logs a WARNING (never a hard failure -- this is informational,
 * unlike every other check in this module, and MUST NOT cause
 * `validateConfig` to `process.exit(1)`) identifying that TLS certificate
 * validation is disabled for the database pool.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function warnIfDatabaseTlsCertificateValidationDisabled(env) {
  if (isDatabaseTlsCertificateValidationDisabled(env)) {
    logger.warn(
      'TLS certificate validation is disabled for the database connection pool ' +
        "(NODE_ENV=production causes server/config/database.js to set ssl: { rejectUnauthorized: false }). " +
        'The database connection is encrypted but the server certificate is not verified, ' +
        'making the connection vulnerable to a man-in-the-middle attack.'
    );
  }
}

/**
 * Requirement 1 Criterion 5: recovers the mount path (e.g. `/api/auth`) a
 * top-level router `Layer` was mounted at, from its compiled regexp.
 * Mirrors `getMountPath` in
 * `server/config/permissions.registry.completeness.test.js` -- Express 4's
 * `path-to-regexp` compiles a string mount path like `/api/auth` into a
 * regexp shaped like `^\/api\/auth\/?(?=\/|$)`; a router mounted at the
 * app root (`/`) is instead flagged via `layer.regexp.fast_slash === true`
 * and has no meaningful prefix to extract.
 *
 * @param {*} layer - an Express Router `Layer` instance.
 * @returns {string|null} the recovered mount path, or `null` if none/root.
 */
function getLayerMountPath(layer) {
  if (typeof layer.path === 'string') {
    return layer.path;
  }
  if (!layer.regexp || layer.regexp.fast_slash) {
    return null;
  }
  const match = layer.regexp.source.match(/^\^\\\/(.*?)\\\/\?/);
  return match ? `/${match[1].replace(/\\\//g, '/')}` : null;
}

/**
 * Requirement 1 Criterion 5: WHERE the App relies on correct
 * `APP_URL`/`FRONTEND_URL` configuration as evidence that authentication
 * is functional, this SHALL NOT be treated as sufficient on its own --
 * this predicate additionally verifies that a route module (the single
 * active OAuth2 authentication route module required by Criterion 1) is
 * actually mounted at the `/api/auth` path on the given Express `app`.
 *
 * Walks the app's top-level `app._router.stack` (Express 4's internal
 * middleware/router stack; see the same "no exported `buildApp()`, so
 * walk router internals directly" rationale documented in
 * `server/config/permissions.registry.completeness.test.js`) looking for
 * a `Layer` whose recovered mount path is `/api/auth`. This only needs to
 * confirm that SOMETHING is mounted at that path -- not recurse into its
 * nested route table -- unlike the Permission_Registry completeness
 * test's full recursive walk.
 *
 * @param {import('express').Application} app
 * @returns {boolean}
 */
function isAuthRouteMounted(app) {
  const stack = app && app._router && app._router.stack;
  if (!Array.isArray(stack)) {
    return false;
  }

  return stack.some((layer) => getLayerMountPath(layer) === '/api/auth');
}

/**
 * Requirement 1 Criterion 5: asserts that `isAuthRouteMounted(app)` is
 * true, logging a descriptive error and exiting with a non-zero status
 * code (mirroring `validateConfig`'s fail-fast pattern) when it is not.
 *
 * MUST be called AFTER every route is mounted but BEFORE `app.listen()`
 * in `server/index.js`, so that a correctly configured `APP_URL`/
 * `FRONTEND_URL` with no functional `/api/auth` route never silently
 * passes as compliant.
 *
 * @param {import('express').Application} app
 */
function assertAuthRouteMounted(app) {
  if (!isAuthRouteMounted(app)) {
    logger.error(
      'Startup assertion failed: no route module is mounted at "/api/auth". ' +
        'Authentication cannot function without this route mounted; refusing to start.'
    );
    process.exit(1);
  }
}

/**
 * Runs every startup configuration check and returns a list of
 * human-readable issue descriptions. An empty array means configuration is
 * valid.
 *
 * Collecting every issue (rather than failing fast on the first one) gives
 * operators the full picture of what needs fixing in one pass.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function collectConfigIssues(env) {
  const issues = [];

  // Criteria 15.1/15.2: presence/non-empty checks.
  const missing = findMissingOrEmpty(REQUIRED_VARS, env);
  for (const name of missing) {
    issues.push(`${name} is missing or empty`);
  }

  // Criteria 15.3/15.4: URL well-formedness, only meaningful for variables
  // that are actually present (an already-reported missing variable
  // shouldn't also be reported as malformed).
  for (const name of URL_VARS) {
    if (missing.includes(name)) {
      continue;
    }
    const value = env[name];
    if (!isWellFormedUrl(value)) {
      issues.push(
        `${name} is not a well-formed URL (must be an absolute http/https URL with a host): "${value}"`
      );
    }
  }

  // Criterion 3.5: JWT_SECRET length.
  if (!missing.includes('JWT_SECRET')) {
    const secret = env.JWT_SECRET;
    if (typeof secret !== 'string' || secret.trim().length < MIN_JWT_SECRET_LENGTH) {
      issues.push(
        `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters long`
      );
    }
  }

  // Criterion 3.6: JWT_EXPIRES_IN duration bounds. JWT_EXPIRES_IN isn't in
  // REQUIRED_VARS, so it may be unset; treat that as invalid explicitly
  // rather than silently skipping the check.
  const jwtExpiresIn = env.JWT_EXPIRES_IN;
  if (typeof jwtExpiresIn !== 'string' || jwtExpiresIn.trim().length === 0) {
    issues.push('JWT_EXPIRES_IN is missing or empty');
  } else if (!isValidJwtExpiry(jwtExpiresIn)) {
    issues.push(
      `JWT_EXPIRES_IN must be a duration between 5 minutes and 30 days (e.g. "1h", "7d", or a number of seconds): "${jwtExpiresIn}"`
    );
  }

  // Criteria 26.1/26.2: TAK Server mutual TLS credential gate, only
  // applicable when TAK_SERVER_URL is configured.
  issues.push(...collectTakServerConfigIssues(env));

  // Optional AUTHENTIK_LOGOUT_URL well-formedness check, only applicable
  // when configured.
  issues.push(...collectAuthentikLogoutUrlConfigIssues(env));

  // Criteria 25.1/25.4: data retention threshold checks.
  issues.push(...collectRetentionConfigIssues(env));

  return issues;
}

/**
 * Requirement 6.4: WHERE the App or Sync_Worker is started with
 * `NODE_ENV=production`, resolves `AUTHENTIK_ADMIN_TOKEN`, `JWT_SECRET`,
 * `DB_PASSWORD`, and the AWS credential variables through the configured
 * `SecretsProvider` (see `getSecretsProvider` in `secretsProvider.js`)
 * instead of trusting the value already present in `env` from a plain
 * `.env` file.
 *
 * Resolves every secret concurrently and collects every failure (rather
 * than failing fast on the first one), mirroring `collectConfigIssues`'s
 * "report everything in one pass" behavior. Returns an empty array when
 * every secret resolved successfully, or when `env.NODE_ENV !== 'production'`
 * (this check is a no-op outside production; Criterion 6.4 is
 * production-only).
 *
 * @param {NodeJS.ProcessEnv} [env] defaults to `process.env`; overridable
 *   for testing.
 * @returns {Promise<string[]>} human-readable issue descriptions, one per
 *   failing secret.
 */
async function validateProductionSecrets(env = process.env) {
  if (env.NODE_ENV !== 'production') {
    return [];
  }

  const provider = getSecretsProvider(env);

  const results = await Promise.all(
    PRODUCTION_SECRET_VARS.map(async (name) => {
      try {
        await provider.getSecret(name);
        return null;
      } catch (err) {
        return `secret "${name}" could not be resolved via the configured secrets provider: ${err.message}`;
      }
    })
  );

  return results.filter((issue) => issue !== null);
}

/**
 * Validates required configuration at startup (Requirement 15, Requirement
 * 3 Criteria 3.5-3.6, Requirement 6.4).
 *
 * WHEN the App or Sync_Worker starts, verifies:
 *  - every environment variable in `REQUIRED_VARS` is present and a
 *    non-empty string after trimming whitespace (Criterion 15.1)
 *  - `AUTHENTIK_URL`, `APP_URL`, and `FRONTEND_URL` are well-formed
 *    absolute URLs (Criteria 15.3, 15.4)
 *  - `JWT_SECRET` is at least 32 characters long (Criterion 3.5)
 *  - `JWT_EXPIRES_IN` parses to a duration between 5 minutes and 30 days
 *    (Criterion 3.6)
 *  - WHERE `TAK_SERVER_URL` is configured, `TAK_SERVER_URL` is a
 *    well-formed URL and one of the two mutual TLS client credential
 *    pairs is fully present and non-empty (Criteria 26.1, 26.2); IF
 *    `TAK_SERVER_URL` is unset, no TAK Server credential variable is
 *    required
 *  - the EFFECTIVE values of `SYNC_OPERATIONS_RETENTION_DAYS` (default 90)
 *    and `AUDIT_LOGS_RETENTION_DAYS` (default 365) are each positive
 *    integers, with the audit-log threshold strictly greater than the
 *    sync-operations threshold (Criteria 25.1, 25.4)
 *  - WHERE `NODE_ENV=production`, `AUTHENTIK_ADMIN_TOKEN`, `JWT_SECRET`,
 *    `DB_PASSWORD`, and the AWS credential variables resolve through the
 *    configured secrets provider (Criterion 6.4)
 *  - WHERE `NODE_ENV=production`, logs an informational WARNING (never a
 *    hard failure) identifying that TLS certificate validation is
 *    disabled for the database pool (Criterion 15.5)
 *
 * IF any check fails, logs every specific invalid/missing variable name
 * and reason, and exits with a non-zero status code (Criteria 15.2, 3.5,
 * 3.6, 26.2, 25.1, 25.4, 6.4), so this MUST be called (and, because the production secrets
 * gate is asynchronous, awaited) as the first statement in
 * `server/index.js` and `server/workers/syncWorker.js`, before
 * `app.listen()` / before the poll loop starts.
 *
 * @param {NodeJS.ProcessEnv} [env] defaults to `process.env`; overridable
 *   for testing.
 * @returns {Promise<void>}
 */
async function validateConfig(env = process.env) {
  const issues = collectConfigIssues(env);

  // Requirement 15.5: informational only -- logged regardless of whether
  // any other check below fails, and never contributes to `issues` or
  // triggers `process.exit(1)` on its own.
  warnIfDatabaseTlsCertificateValidationDisabled(env);

  // Requirement 6.4: only attempt the secrets-manager gate if the
  // synchronous checks above passed. If, say, JWT_SECRET is missing
  // entirely, there's no point also trying (and likely failing) to
  // resolve it through a secrets provider -- report the simpler issue
  // first and let the operator fix that before this check runs again.
  if (issues.length === 0) {
    const secretIssues = await validateProductionSecrets(env);
    issues.push(...secretIssues);
  }

  if (issues.length > 0) {
    logger.error('Configuration error: invalid startup configuration:');
    for (const issue of issues) {
      logger.error(`  - ${issue}`);
    }
    process.exit(1);
  }
}

module.exports = {
  validateConfig,
  validateProductionSecrets,
  collectConfigIssues,
  collectTakServerConfigIssues,
  collectRetentionConfigIssues,
  findMissingOrEmpty,
  isWellFormedUrl,
  isValidJwtExpiry,
  isPositiveIntegerValue,
  parseDurationMs,
  isDatabaseTlsCertificateValidationDisabled,
  warnIfDatabaseTlsCertificateValidationDisabled,
  isAuthRouteMounted,
  assertAuthRouteMounted,
  REQUIRED_VARS,
  URL_VARS,
  PRODUCTION_SECRET_VARS,
  TAK_SERVER_P12_CREDENTIAL_VARS,
  TAK_SERVER_CERT_KEY_CREDENTIAL_VARS,
  MIN_JWT_SECRET_LENGTH,
  MIN_JWT_EXPIRY_MS,
  MAX_JWT_EXPIRY_MS,
  DEFAULT_SYNC_OPERATIONS_RETENTION_DAYS,
  DEFAULT_AUDIT_LOGS_RETENTION_DAYS
};
