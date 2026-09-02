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
 * Instead, this file (via the shared `server/config/routeInventory.js`)
 * builds its OWN Express app, mounting the exact same route files at the
 * exact same mount paths `server/index.js` uses -- duplicating ONLY the
 * `app.use(mountPath, require('./routes/X'))` lines, not any of index.js's
 * startup/config-validation/listen/signal-handling logic. That mount list
 * must be kept in sync by hand whenever a route mount is added to or
 * removed from `server/index.js` (see `routeInventory.js`'s own doc
 * comment) -- a fully automatic alternative would mean parsing index.js's
 * source text, which is more fragile than this documented-duplication
 * approach. A more invasive fix -- refactoring `server/index.js` to export
 * a `buildApp()` factory separate from its startup side effects -- would
 * remove this duplication entirely and is a reasonable future improvement,
 * but is a larger production-code refactor than this optional test task
 * calls for.
 *
 * --- Reconstructing the Permission_Registry's route key without a real request ---
 *
 * `authorize.js`'s `getRouteKey(req)` computes `` `${req.method}
 * ${req.baseUrl}${req.route.path}` `` -- but `req.route`/`req.baseUrl` are
 * only populated by Express once an actual request has been matched to a
 * route, not from a mounted app's static structure. So instead of
 * dispatching real requests, `routeInventory.js`'s `collectRouteKeys`
 * walks `app._router.stack` directly: a top-level `Layer` for a
 * sub-router mounted via `app.use(mountPath, subRouter)` exposes that
 * subRouter's own stack at `layer.handle.stack`, and its mount path is
 * recovered from `layer.regexp`'s source (Express 4's `path-to-regexp`
 * compiles `/api/teams` to a regexp shaped like
 * `^\/api\/teams\/?(?=\/|$)`, or sets `layer.regexp.fast_slash = true`
 * for a router mounted at `/`). A terminal route-matching `Layer` (one
 * with `.route` set) exposes its own pattern at `layer.route.path` and
 * its HTTP method(s) at `layer.route.methods`. Recursing through nested
 * router stacks while concatenating mount prefixes reconstructs the exact
 * full path `getRouteKey` would have computed for a real request to that
 * route (e.g. `/api/teams/:teamId`).
 *
 * This walker used to live inline in this file; it is now shared
 * production/test tooling in `server/config/routeInventory.js`, reused
 * by `publicRoutes.completeness.test.js`, `enrollmentPermissions.test.js`,
 * and `openapi.completeness.test.js`.
 */

const { routes: registryRoutes } = require('./permissions.registry');
const publicRoutes = require('./publicRoutes');
const { buildTestApp, getMountPath, normalizePath, collectRouteKeys } = require('./routeInventory');

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

// Re-exported for backward compatibility with existing consumers
// (`publicRoutes.completeness.test.js`, `enrollmentPermissions.test.js`)
// that import these names from this file. The actual implementation now
// lives in `server/config/routeInventory.js`; new consumers (e.g.
// `openapi.completeness.test.js`) should import from there directly.
module.exports = {
  buildTestApp,
  getMountPath,
  normalizePath,
  collectRouteKeys
};
