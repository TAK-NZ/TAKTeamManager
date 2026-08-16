/**
 * Public_Route_Registry (Requirement 33)
 *
 * A single, flat array of {method, path} entries enumerating every route
 * that is intentionally reachable without authentication. This is the one
 * place a route can be marked as public — anything not listed here is
 * expected to require a valid JWT_Token via `authenticateToken`.
 *
 * `path` values use the same mounted-route-pattern style Express exposes
 * (e.g. `/api/requests/verify/:token`), not interpolated values.
 *
 * This is the complete registry (task 55.1 - Public_Route_Registry
 * completion): every route handler across `server/routes/*.js` that does
 * NOT have `authenticateToken` in its middleware chain has a corresponding
 * entry below. Cross-referenced against `server/config/permissions.registry.js`
 * (which only contains entries for routes that DO run `authenticateToken`)
 * to satisfy the mutual-exclusion requirement (Req 33.3).
 *
 * The OAuth2 routes in `server/routes/auth.js` (`/sso`, `/login`, `/silent`,
 * `/silent-callback`, `/callback`, `POST /logout`) are listed individually
 * rather than as a `GET /api/auth/*` wildcard, because `GET /api/auth/me`
 * is mounted on the same router but DOES require authenticateToken/authorize
 * and has a Permission_Registry entry (`'GET /api/auth/me'`) — a wildcard
 * would incorrectly mark it public and violate Req 33.3.
 */

const publicRoutes = [
  // --- server/routes/config.js ---
  { method: 'GET', path: '/api/config/public' },

  // --- server/routes/requests.js ---
  { method: 'POST', path: '/api/requests/team-access' },
  { method: 'GET', path: '/api/requests/verify/:token' },

  // --- server/routes/health.js (mounted at /health) ---
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/health/ready' },
  { method: 'GET', path: '/health/live' },

  // --- server/routes/teams.js ---
  { method: 'GET', path: '/api/teams/joinable' },

  // --- server/routes/auth.js ---
  // Every route below runs without `authenticateToken` by definition: the
  // user has no token yet (login/callback/silent flows) or logout must
  // succeed even without a valid token (Requirement 3.4). `GET /api/auth/me`
  // is intentionally NOT listed here — it requires authentication and is
  // tracked in permissions.registry.js instead.
  { method: 'GET', path: '/api/auth/sso' },
  { method: 'GET', path: '/api/auth/login' },
  { method: 'GET', path: '/api/auth/silent' },
  { method: 'GET', path: '/api/auth/silent-callback' },
  { method: 'GET', path: '/api/auth/callback' },
  { method: 'POST', path: '/api/auth/logout' }
];

module.exports = publicRoutes;
