const jwt = require('jsonwebtoken');
const User = require('../models/User');
const pool = require('../config/database');
const { getLogger } = require('./requestContext');

/**
 * Requirement 13.7: "IF a request to the App fails authorization (403) or
 * authentication (401), THEN THE App SHALL log that failure with the
 * requesting IP address, the requested route, and the reason for the
 * failure, to support security monitoring."
 *
 * `getRequestIp`/`getRequestRoute`/`logAuthFailure` below are small, local
 * helpers (this task is purely additive logging -- no authentication logic
 * or response bodies/status codes change) used on every 401/403 branch in
 * this file. `warn` matches the level already used elsewhere in this
 * codebase for expected/anticipated failures (e.g. `auth.js`'s existing
 * "User not found in cache" `getLogger().warn(...)` calls), rather than
 * `error`, which is reserved for unexpected exceptions.
 */
function getRequestIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress);
}

function getRequestRoute(req) {
  return req.originalUrl || `${req.method} ${(req.route && req.route.path) || req.path}`;
}

function logAuthFailure(req, reason) {
  getLogger().warn(
    { ip: getRequestIp(req), route: getRequestRoute(req), reason },
    'Authentication failed'
  );
}

/**
 * Resolves the current user from a request's `tak_session` cookie,
 * independent of sending any HTTP response.
 *
 * This is `authenticateToken`'s own JWT verification + revocation check +
 * user-cache lookup logic, extracted so it can be reused by
 * `server/middleware/requireCurrentAgreement.js` (BUG-010): that
 * middleware is mounted globally in `server/index.js`, ahead of every
 * route's own per-route `authenticateToken` mount, so `req.user` is not
 * yet populated at that point in the chain. Rather than relying on
 * `req.user` having already been set by a downstream middleware that
 * hasn't run yet, it calls this helper directly to resolve the user for
 * its own purposes, without rejecting the request itself on failure --
 * that responsibility stays with `authenticateToken`, below.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{user: object|null, reason?: string}>} `user` is
 *   `null` when the session could not be resolved, with `reason` set to
 *   one of `authenticateToken`'s existing failure reasons
 *   (`missing_token`, `token_revoked`, `revocation_check_failed`,
 *   `user_not_found`, `expired_token`, `invalid_signature`).
 */
async function resolveUserFromRequest(req) {
  // Requirement 3.2: the JWT_Token is delivered solely as an httpOnly
  // `tak_session` cookie (set in server/routes/auth.js); it is never read
  // from an Authorization header, so the token value is never exposed to
  // client-side JavaScript or any other delivery path.
  const token = req.cookies && req.cookies.tak_session;

  if (!token) {
    return { user: null, reason: 'missing_token' };
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Requirement 3.3: reject any token whose `jti` has been revoked
    // (e.g. via logout). This check runs only after the signature has
    // been successfully verified above, so an invalid/expired signature
    // still falls through to the existing catch block below.
    if (decoded.jti) {
      try {
        const revocation = await pool.query(
          'SELECT 1 FROM token_revocations WHERE jti = $1',
          [decoded.jti]
        );
        if (revocation.rows.length > 0) {
          return { user: null, reason: 'token_revoked' };
        }
      } catch (revocationError) {
        getLogger().error({ err: revocationError }, 'Token revocation check failed');
        return { user: null, reason: 'revocation_check_failed' };
      }
    }

    // Fetch full user data from cache
    const authentikSync = require('../services/authentikSync');
    const cachedUser = await authentikSync.getUserFromCache(decoded.username);

    if (!cachedUser) {
      return { user: null, reason: 'user_not_found' };
    }

    return {
      user: {
        id: cachedUser.authentik_id,
        userId: cachedUser.id,
        username: cachedUser.username,
        email: cachedUser.email,
        first_name: cachedUser.first_name,
        last_name: cachedUser.last_name,
        name: cachedUser.first_name + (cachedUser.last_name ? ' ' + cachedUser.last_name : ''),
        isAdmin: cachedUser.is_admin, // Team admin capabilities
        is_global_manager: cachedUser.is_admin, // Global manager = Authentik TakTeamManager_Admin group
        takRole: cachedUser.tak_role,
        takColor: cachedUser.tak_color,
        takCallsign: cachedUser.tak_callsign,
        groups: cachedUser.groups || []
      }
    };
  } catch (error) {
    const reason = error && error.name === 'TokenExpiredError' ? 'expired_token' : 'invalid_signature';
    return { user: null, reason };
  }
}

// Requirement 13.7: the specific HTTP status code + response body for
// each `resolveUserFromRequest` failure reason, preserving the exact
// status/message pairs `authenticateToken` returned before this helper
// was extracted.
const AUTH_FAILURE_RESPONSES = {
  missing_token: { status: 401, error: 'Access token required' },
  token_revoked: { status: 401, error: 'Token has been revoked' },
  revocation_check_failed: { status: 401, error: 'Unable to verify token' },
  user_not_found: { status: 401, error: 'User not found' },
  expired_token: { status: 403, error: 'Invalid token' },
  invalid_signature: { status: 403, error: 'Invalid token' }
};

const authenticateToken = async (req, res, next) => {
  const { user, reason } = await resolveUserFromRequest(req);

  if (!user) {
    logAuthFailure(req, reason);
    const { status, error } = AUTH_FAILURE_RESPONSES[reason] || AUTH_FAILURE_RESPONSES.invalid_signature;
    return res.status(status).json({ error });
  }

  req.user = user;
  next();
};

const requireTeamAdmin = async (req, res, next) => {
  const { teamId } = req.params;
  const Team = require('../models/Team');
  
  try {
    // Team.isAdmin compares against team_memberships.user_id, which is a
    // foreign key to the local users.id (req.user.userId), not the
    // Authentik id (req.user.id).
    const isAdmin = await Team.isAdmin(teamId, req.user.userId);
    if (!isAdmin) {
      logAuthFailure(req, 'team_admin_required');
      return res.status(403).json({ error: 'Team admin access required' });
    }
    next();
  } catch (error) {
    res.status(500).json({ error: 'Authorization check failed' });
  }
};

module.exports = { authenticateToken, requireTeamAdmin, resolveUserFromRequest };