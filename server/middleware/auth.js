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

const authenticateToken = async (req, res, next) => {
  // Requirement 3.2: the JWT_Token is delivered solely as an httpOnly
  // `tak_session` cookie (set in server/routes/auth.js); it is never read
  // from an Authorization header, so the token value is never exposed to
  // client-side JavaScript or any other delivery path.
  const token = req.cookies && req.cookies.tak_session;

  if (!token) {
    logAuthFailure(req, 'missing_token');
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Requirement 3.3: reject any token whose `jti` has been revoked
    // (e.g. via logout). This check runs only after the signature has
    // been successfully verified above, so an invalid/expired signature
    // still falls through to the existing catch block below (403).
    if (decoded.jti) {
      try {
        const revocation = await pool.query(
          'SELECT 1 FROM token_revocations WHERE jti = $1',
          [decoded.jti]
        );
        if (revocation.rows.length > 0) {
          logAuthFailure(req, 'token_revoked');
          return res.status(401).json({ error: 'Token has been revoked' });
        }
      } catch (revocationError) {
        getLogger().error({ err: revocationError }, 'Token revocation check failed');
        logAuthFailure(req, 'revocation_check_failed');
        return res.status(401).json({ error: 'Unable to verify token' });
      }
    }

    // Fetch full user data from cache
    const authentikSync = require('../services/authentikSync');
    const cachedUser = await authentikSync.getUserFromCache(decoded.username);
    
    if (!cachedUser) {
      logAuthFailure(req, 'user_not_found');
      return res.status(401).json({ error: 'User not found' });
    }
    
    // Set user data on request
    req.user = {
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
    };
    
    next();
  } catch (error) {
    const reason = error && error.name === 'TokenExpiredError' ? 'expired_token' : 'invalid_signature';
    logAuthFailure(req, reason);
    return res.status(403).json({ error: 'Invalid token' });
  }
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

module.exports = { authenticateToken, requireTeamAdmin };