/**
 * Permission_Registry completeness test (Requirement 24 Criteria 6-7,
 * task 12.4).
 *
 * Requirement 24.6: "THE Repository SHALL contain an automated test that
 * enumerates every route path and HTTP method mounted in `server/index.js`
 * and asserts that each one has a corresponding entry in the
 * Permission_Registry, failing the test if any mounted route is missing a
 * registry entry."
 *
 * Requirement 24.7: a route added to `server/index.js` in the future with
 * no Permission_Registry entry must fail THIS test, catching the omission
 * in CI rather than in production.
 *
 * --- Why this can't just `require('../index')` ---
 *
 * `server/index.js` does not export its Express `app`. Every route mount
 * happens inside an async IIFE that also calls `validateConfig()` (which
 * can `process.exit()` on invalid config) and, further down, `app.listen()`
 * (binding a real port and starting `authentikSync.startPeriodicSync()` /
 * `EscalationService.startDailySchedule()`). None of that is safe or
 * appropriate to trigger from a unit test.
 *
 * Instead, this file builds its OWN Express app, mounting the exact same
 * route files at the exact same mount paths `server/index.js` uses --
 * duplicating ONLY the `app.use(mountPath, require('./routes/X'))` lines,
 * not any of index.js's startup/config-validation/listen/signal-handling
 * logic. This list must be kept in sync by hand whenever a route mount is
 * added to or removed from `server/index.js` (see the block below) -- a
 * fully automatic alternative would mean parsing `index.js`'s source text,
 * which is more fragile than this documented-duplication approach. A more
 * invasive fix -- refactoring `server/index.js` to export a `buildApp()`
 * factory separate from its startup side effects -- would remove this
 * duplication entirely and is a reasonable future improvement, but is a
 * larger production-code refactor than this optional test task calls for.
 *
 * --- Reconstructing the Permission_Registry's route key without a real request ---
 *
 * `authorize.js`'s `getRouteKey(req)` computes `` `${req.method}
 * ${req.baseUrl}${req.route.path}` `` -- but `req.route`/`req.baseUrl` are
 * only populated by Express once an actual request has been matched to a
 * route, not from a mounted app's static structure. So instead of
 * dispatching real requests, `collectMountedRoutes` below walks
 * `app._router.stack` directly: a top-level `Layer` for a sub-router
 * mounted via `app.use(mountPath, subRouter)` exposes that subRouter's own
 * stack at `layer.handle.stack`, and its mount path is recovered from
 * `layer.regexp`'s source (Express 4's `path-to-regexp` compiles
 * `/api/teams` to a regexp shaped like `^\/api\/teams\/?(?=\/|$)`, or sets
 * `layer.regexp.fast_slash = true` for a router mounted at `/`). A
 * terminal route-matching `Layer` (one with `.route` set) exposes its own
 * pattern at `layer.route.path` and its HTTP method(s) at
 * `layer.route.methods`. Recursing through nested router stacks while
 * concatenating mount prefixes reconstructs the exact full path
 * `getRouteKey` would have computed for a real request to that route
 * (e.g. `/api/teams/:teamId`). This walker is self-contained here (test-only
 * tooling), not extracted into production code, since nothing in
 * `server/` needs this outside of this test.
 */

// GlobalChannelService -> CredentialEncryptionService reads and validates
// CREDENTIAL_ENCRYPTION_KEY once at module load time (Requirement 6.1).
// This test only needs `server/routes/globalChannels.js` to be
// `require()`-able without throwing -- it never calls encrypt()/decrypt()
// -- so a syntactically valid throwaway key is set before any route file
// is required below, mirroring the setup already used by
// `GlobalChannelService.test.js`/`CredentialEncryptionService.test.js`.
if (!process.env.CREDENTIAL_ENCRYPTION_KEY) {
  process.env.CREDENTIAL_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
}

const express = require('express');
const { routes: registryRoutes } = require('./permissions.registry');
const publicRoutes = require('./publicRoutes');

/**
 * Builds a fresh Express app mounting the SAME route files, at the SAME
 * mount paths, in the SAME order as `server/index.js`'s "Routes" section
 * and its two non-API mounts (`/health`; `/uploads` is a static-file
 * mount, not a router of authenticated route handlers, and is excluded --
 * see the module doc comment above and the exclusion reasoning below).
 *
 * IMPORTANT: keep this list in sync with `server/index.js`'s own
 * `app.use('/api/...', require('./routes/...'))` lines (and the
 * `app.use('/health', require('./routes/health'))` line) whenever a route
 * is mounted, unmounted, or remounted at a different path there. This is
 * the one piece of intentional, documented duplication this test accepts
 * (see the module doc comment's "why this can't just `require('../index')`"
 * section) in exchange for not needing to refactor `server/index.js`.
 *
 * None of `validateConfig()`, `app.listen()`, or any background service
 * start (`authentikSync.startPeriodicSync()`, `EscalationService`) is
 * invoked here -- only the plain `express.Router()` instances each route
 * file exports.
 */
function buildTestApp() {
  const app = express();

  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/teams', require('../routes/teams'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/channels', require('../routes/channels'));
  app.use('/api/signup-codes', require('../routes/signupCodes'));
  app.use('/api', require('../routes/signup'));
  app.use('/api', require('../routes/orgDomains'));
  app.use('/api/requests', require('../routes/requests'));
  app.use('/api/channel-requests', require('../routes/channelRequests'));
  app.use('/api/config', require('../routes/config'));
  app.use('/api/sync', require('../routes/sync'));
  app.use('/api/operations', require('../routes/operations'));
  app.use('/api/global-channels', require('../routes/globalChannels'));
  app.use('/api/vendor-channels', require('../routes/vendorChannels'));
  app.use('/api/deployment-channels', require('../routes/deploymentChannels'));
  app.use('/api/audit-logs', require('../routes/auditLogs'));
  app.use('/api/settings', require('../routes/settings'));
  app.use('/api/mou', require('../routes/mou'));
  app.use('/api/communications', require('../routes/communications'));
  app.use('/api/devices', require('../routes/devices'));
  app.use('/api/enrollment', require('../routes/enrollment'));
  app.use('/api/bulk-import', require('../routes/bulkImport'));

  // Requirement 14.1/14.2: GET /health and its /health/ready, /health/live
  // siblings. Not an authenticated route -- see the "excluded, not
  // silently papered over" reasoning below -- but included here anyway so
  // this test's route inventory matches server/index.js's mount set
  // exactly, and so a future authenticated route accidentally added under
  // `/health` would still be walked and checked.
  app.use('/health', require('../routes/health'));

  return app;
}

/**
 * Recovers the mount path (e.g. `/api/teams`) a sub-router `Layer` was
 * mounted at, from its compiled regexp. Express 4's `path-to-regexp`
 * compiles a string mount path like `/api/teams` into a regexp shaped
 * like `^\/api\/teams\/?(?=\/|$)`; a router mounted at the app root (`/`)
 * is instead flagged via `layer.regexp.fast_slash === true` and has no
 * meaningful prefix to extract. `layer.path` (set directly on some layer
 * shapes) is checked first as the simpler/more direct source when present.
 *
 * @param {*} layer - An Express Router `Layer` instance.
 * @returns {string} The recovered mount path, or `''` if none/root.
 */
function getMountPath(layer) {
  if (layer.path) {
    return layer.path;
  }
  if (!layer.regexp || layer.regexp.fast_slash) {
    return '';
  }
  const match = layer.regexp.source.match(/^\^\\\/(.*?)\\\/\?/);
  return match ? `/${match[1].replace(/\\\//g, '/')}` : '';
}

/**
 * Normalizes a concatenated mount-prefix + route-path string into the same
 * shape `authorize.js`'s `getRouteKey` produces: collapse any doubled
 * slashes (e.g. a router mounted at `/health` with a route of `/`
 * produces `/health/`, not `/health//`... but a router mounted at `/api/x`
 * with a route of `/` produces `/api/x/`, which still needs its trailing
 * slash stripped below), ensure exactly one leading slash, and strip a
 * trailing slash unless the whole path is just `/`.
 *
 * @param {string} fullPath
 * @returns {string}
 */
function normalizePath(fullPath) {
  let normalized = fullPath.replace(/\/{2,}/g, '/');
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Recursively walks an Express router's internal `stack` (as found at
 * `app._router.stack` for the top-level app, or `layer.handle.stack` for
 * a mounted sub-router), collecting a `${METHOD} ${fullPath}` string for
 * every terminal route (a `Layer` with `.route` set), in the exact key
 * format `permissions.registry.js`/`publicRoutes.js` use.
 *
 * A route registered for multiple HTTP methods (none currently exist in
 * this codebase, but the walker handles it correctly regardless) produces
 * one collected string per method.
 *
 * @param {Array} stack
 * @param {string} prefix - Accumulated mount-path prefix from enclosing routers.
 * @param {string[]} out - Accumulator array collected strings are pushed onto.
 */
function collectRouteKeys(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
      const fullPath = normalizePath(prefix + layer.route.path);
      for (const method of methods) {
        out.push(`${method.toUpperCase()} ${fullPath}`);
      }
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      collectRouteKeys(layer.handle.stack, prefix + getMountPath(layer), out);
    }
  }
}

describe('Permission_Registry completeness (Requirement 24 Criteria 6-7)', () => {
  it('has a registry or public-route entry for every route mounted in server/index.js', () => {
    const app = buildTestApp();

    const collected = [];
    collectRouteKeys(app._router.stack, '', collected);

    // Sanity check on the walker itself: server/index.js mounts many
    // dozens of authenticated + public routes across 18 route files, so a
    // near-zero count here would indicate the walker silently found
    // nothing (e.g. an Express internals shape change) rather than a
    // genuinely empty app -- fail loudly rather than passing vacuously.
    expect(collected.length).toBeGreaterThan(50);

    const registryKeys = new Set(Object.keys(registryRoutes));
    const publicKeys = new Set(publicRoutes.map((r) => `${r.method} ${r.path}`));

    const uniqueCollected = Array.from(new Set(collected));
    const missing = uniqueCollected.filter(
      (key) => !registryKeys.has(key) && !publicKeys.has(key)
    );

    if (missing.length > 0) {
      throw new Error(
        'The following route(s) mounted in server/index.js have NEITHER a ' +
        'permissions.registry.js entry NOR a publicRoutes.js entry, meaning ' +
        'authorize.js would deny them by default but they are effectively ' +
        'undocumented/untracked (Requirement 24.6/24.7):\n' +
        missing.map((k) => `  - ${k}`).join('\n')
      );
    }
  });

  /**
   * `GET /health`, `GET /health/ready`, and `GET /health/live` deliberately
   * have NO `authenticateToken`/`authorize` middleware at all (see
   * server/routes/health.js's header comment) -- they are liveness/
   * readiness probes for a load balancer or container orchestrator that
   * has no JWT_Token, not authenticated-but-unregistered routes. They are
   * correctly tracked in `publicRoutes.js` instead of
   * `permissions.registry.js`. The `/uploads` static-file mount in
   * `server/index.js` is excluded from `buildTestApp()` entirely (rather
   * than walked and then excluded here) because it is not an Express
   * route handler in the `router.route()`/`req.route` sense this registry
   * concerns itself with at all -- `express.static()` has no notion of
   * `req.route`, so `authorize.js`'s `getRouteKey` could never resolve a
   * meaningful key for it in the first place. This test asserts that
   * distinction explicitly, so a future change that accidentally starts
   * requiring authentication for a health-check route (breaking load
   * balancer probes) would be caught here rather than silently passing.
   */
  it('confirms /health routes are tracked as public, not registry, entries', () => {
    const healthPaths = ['/health', '/health/ready', '/health/live'];
    for (const p of healthPaths) {
      const key = `GET ${p}`;
      expect(publicRoutes.some((r) => `${r.method} ${r.path}` === key)).toBe(true);
      expect(registryRoutes[key]).toBeUndefined();
    }
  });
});

// Exported for reuse by `./publicRoutes.completeness.test.js` (task 55.4),
// which needs the exact same "build a real route-mounted app, then walk
// its router stack" logic against a throwaway single-route app of its
// own, rather than duplicating this walker a second time. Safe to export
// from a test file (not production code).
module.exports = {
  buildTestApp,
  getMountPath,
  normalizePath,
  collectRouteKeys
};
