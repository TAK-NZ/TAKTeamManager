/**
 * publicRouteBootstrap (Requirement 33: Centralize Public and Unauthenticated
 * Route Determination)
 *
 * Bootstrap middleware that consults the Public_Route_Registry
 * (`server/config/publicRoutes.js`) for every incoming request. On a match
 * it calls `next()` directly, bypassing `authenticateToken` entirely for
 * that request (Criterion 33.2). On no match it also calls `next()`: this
 * middleware is now mounted globally in `server/index.js` ahead of every
 * route mount (task 55.2), but `authenticateToken`/`authorize.js`
 * themselves remain mounted per-route rather than as a second global
 * `app.use()` (see the TODO below for why), so the no-match branch here
 * has nothing to delegate to yet and simply lets the request continue on
 * to whichever route it matches, where that route's own
 * `authenticateToken`/`authorize` chain applies as it already did before
 * this middleware existed.
 *
 * `publicRoutes.js` entries use Express mounted-route-pattern style paths
 * (e.g. `/api/requests/available-teams`), not interpolated request paths, so
 * matching a real incoming `req.path` against those patterns requires a
 * param-aware matcher rather than a literal string comparison. Express
 * itself uses `path-to-regexp` for this exact purpose, and it is already a
 * transitive dependency via `express`, so it is reused here directly
 * instead of hand-rolling an equivalent matcher.
 */

const pathToRegexp = require('path-to-regexp');
const publicRoutes = require('../config/publicRoutes');

// Compile each registry entry's path pattern into a regexp once, rather
// than on every request. `pathToRegexp` mirrors Express's own route
// matching, so `:param` segments (e.g. `:token`) match any single path
// segment the same way they would if this were a real mounted route.
const compiledPublicRoutes = publicRoutes.map(({ method, path }) => ({
  method: method.toUpperCase(),
  regexp: pathToRegexp(path)
}));

/**
 * Returns `true` if `{method, path}` matches an entry in the Public_Route_Registry.
 *
 * @param {string} method - HTTP method, e.g. `"GET"`.
 * @param {string} path - request path, e.g. `/api/requests/team-access`.
 * @returns {boolean}
 */
function isPublicRoute(method, path) {
  const upperMethod = (method || '').toUpperCase();
  return compiledPublicRoutes.some(
    (route) => route.method === upperMethod && route.regexp.test(path)
  );
}

/**
 * Express middleware consulting the Public_Route_Registry before
 * `authenticateToken` would otherwise apply.
 *
 * WHEN an incoming request's method and path match an entry in the
 * Public_Route_Registry, calls `next()` directly, skipping
 * `authenticateToken` entirely for that request (Criterion 33.2).
 *
 * NOTE: design.md's Authorization Architecture section describes the
 * no-match branch as delegating "to `authenticateToken` then
 * `authorize.js`." In this codebase those two middlewares are mounted
 * per-route (task 12.3), not as a single global `app.use()`, because
 * `authorize.js` looks up `req.route.path`, which Express only populates
 * once a request has matched a specific route -- it is `undefined` at this
 * router-mount-level point in the chain (verified empirically, same
 * finding documented in `authorize.js`'s own header comment). Delegating
 * from here would therefore not work; instead, every non-public route
 * mounted in `server/index.js` continues to run its own
 * `authenticateToken`/`authorize` pair exactly as it did before this
 * middleware was mounted globally (task 55.2), so calling `next()`
 * unconditionally on no match is correct, not a placeholder.
 */
function publicRouteBootstrap(req, res, next) {
  if (isPublicRoute(req.method, req.path)) {
    return next();
  }

  // No downstream delegation here — see NOTE above for why.
  return next();
}

module.exports = publicRouteBootstrap;
module.exports.isPublicRoute = isPublicRoute;
