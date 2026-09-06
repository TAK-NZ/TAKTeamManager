/**
 * Route_Inventory
 *
 * Shared route-walking machinery: reconstructs the exact `${METHOD}
 * ${path}` key `authorize.js`'s `getRouteKey` would compute for a real
 * request, without dispatching one, by walking a mounted Express app's
 * internal router stack directly.
 *
 * Originally written inline in `permissions.registry.completeness.test.js`
 * (task 12.4) and reused via that file's `module.exports` by
 * `publicRoutes.completeness.test.js` (task 55.4) and
 * `enrollmentPermissions.test.js`. Extracted here, behavior unchanged, so
 * those three plus a fourth consumer -- the OpenAPI skeleton's own parity
 * guard (`server/config/openapi.completeness.test.js`) -- share ONE copy
 * of the walker instead of `require()`-ing a `.test.js` file to reach it.
 * This module registers no `describe`/`it` of its own.
 *
 * --- Why `buildTestApp` exists instead of `require('../index')` ---
 *
 * `server/index.js` does not export its Express `app`. Every route mount
 * happens inside an async IIFE that also calls `validateConfig()` (which
 * can `process.exit()` on invalid config) and, further down, `app.listen()`
 * (binding a real port and starting background services). None of that is
 * safe or appropriate to trigger from a test or from this module's own
 * load. Instead, `buildTestApp` below builds a throwaway Express app
 * mounting the SAME route files at the SAME mount paths `server/index.js`
 * uses -- duplicating ONLY the `app.use(mountPath, require('./routes/X'))`
 * lines, not any startup/config-validation/listen/signal-handling logic.
 *
 * IMPORTANT: keep this list in sync BY HAND with `server/index.js`'s own
 * `app.use('/api/...', require('./routes/...'))` lines (and its
 * `app.use('/health', require('./routes/health'))` line) whenever a route
 * is mounted, unmounted, or remounted at a different path there.
 *
 * --- The walker itself ---
 *
 * `getMountPath` recovers the mount path (e.g. `/api/teams`) a sub-router
 * `Layer` was mounted at, from its compiled regexp. Express 4's
 * `path-to-regexp` compiles a string mount path like `/api/teams` into a
 * regexp shaped like `^\/api\/teams\/?(?=\/|$)`, or sets
 * `layer.regexp.fast_slash = true` for a router mounted at `/`.
 * `normalizePath` collapses the concatenated mount-prefix + route-path
 * string into the same shape `getRouteKey` produces. `collectRouteKeys`
 * recurses through nested router stacks, concatenating mount prefixes, to
 * collect one `${METHOD} ${fullPath}` string per terminal route.
 */

// GlobalChannelService -> CredentialEncryptionService reads and validates
// CREDENTIAL_ENCRYPTION_KEY once at module load time (Requirement 6.1).
// Callers of `buildTestApp` only need `server/routes/globalChannels.js` to
// be `require()`-able without throwing -- they never call encrypt()/
// decrypt() -- so a syntactically valid throwaway key is set before any
// route file is required below, mirroring the setup already used by
// `GlobalChannelService.test.js`/`CredentialEncryptionService.test.js`.
if (!process.env.CREDENTIAL_ENCRYPTION_KEY) {
  process.env.CREDENTIAL_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
}

const express = require('express');

/**
 * Builds a fresh Express app mounting the SAME route files, at the SAME
 * mount paths, in the SAME order as `server/index.js`'s "Routes" section
 * and its `/health` mount (`/uploads` and `/templates` are static-file
 * mounts, not routers of authenticated route handlers, and are excluded --
 * see this module's doc comment).
 *
 * Security-hardening: `server/routes/deviceManagement.js` is mounted
 * CONDITIONALLY in `server/index.js`, behind `isDeviceMgmtEnabled()`
 * (`DEVICE_MGMT_ENABLED='true'`) -- but it is mounted UNCONDITIONALLY
 * here, regardless of that flag's real value. `deviceManagement.js`
 * itself only reads `isDeviceMgmtEnabled()` inside its own handlers
 * (per-request), not at require()/module-load time, so requiring and
 * mounting the router here carries no dependency on the flag. This
 * module exists to build a COMPLETE route inventory for completeness
 * tests, not to reproduce `server/index.js`'s runtime feature-gating
 * behavior -- mounting conditionally here would have left this router's
 * routes permanently unwalked by
 * `permissions.registry.completeness.test.js` (previously the actual
 * case), meaning a future route added there with no registry entry
 * would not have been caught by that test the way every other router's
 * routes are.
 *
 * None of `validateConfig()`, `app.listen()`, or any background service
 * start is invoked here -- only the plain `express.Router()` instances
 * each route file exports.
 */
function buildTestApp() {
  const app = express();

  app.use('/api', require('../routes/version'));
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/teams', require('../routes/teams'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/channels', require('../routes/channels'));
  app.use('/api/signup-codes', require('../routes/signupCodes'));
  app.use('/api', require('../routes/signup'));
  app.use('/api', require('../routes/orgDomains'));
  app.use('/api/requests', require('../routes/requests'));
  app.use('/api/config', require('../routes/config'));
  app.use('/api/sync', require('../routes/sync'));
  app.use('/api/operations', require('../routes/operations'));
  app.use('/api/global-channels', require('../routes/globalChannels'));
  app.use('/api/audit-logs', require('../routes/auditLogs'));
  app.use('/api/settings', require('../routes/settings'));
  app.use('/api/communications', require('../routes/communications'));
  app.use('/api/devices', require('../routes/devices'));
  app.use('/api/enrollment', require('../routes/enrollment'));
  app.use('/api/bulk-import', require('../routes/bulkImport'));
  app.use('/api', require('../routes/openapi'));

  // Mount unconditionally for inventory-completeness purposes -- see the
  // doc comment above. `deviceManagement.js` itself only reads
  // `isDeviceMgmtEnabled()` inside its own handlers (per-request), not at
  // require()/module-load time, so no environment override is needed
  // just to require() and mount the router.
  app.use('/api/device-management', require('../routes/deviceManagement'));

  // Mounted unconditionally for inventory-completeness — same rationale as
  // device-management above. `offlineMaps.js` reads its feature flag only via
  // its own require of `../config/offlineMaps` for the runtime mount decision
  // in `server/index.js`; requiring and mounting the router here has no
  // dependency on OFFLINE_MAPS_ENABLED, so both its routes are always walked.
  app.use('/api/offline-maps', require('../routes/offlineMaps'));

  app.use('/health', require('../routes/health'));

  return app;
}

/**
 * Recovers the mount path (e.g. `/api/teams`) a sub-router `Layer` was
 * mounted at, from its compiled regexp. `layer.path` (set directly on
 * some layer shapes) is checked first as the simpler/more direct source
 * when present.
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
 * slashes, ensure exactly one leading slash, and strip a trailing slash
 * unless the whole path is just `/`.
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
 * A route registered for multiple HTTP methods produces one collected
 * string per method.
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

module.exports = {
  buildTestApp,
  getMountPath,
  normalizePath,
  collectRouteKeys
};
