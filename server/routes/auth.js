const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { parseDurationMs } = require('../config/configValidator');
const pool = require('../config/database');
const { getLogger } = require('../middleware/requestContext');
const {
  authLimiter,
  authCallbackFailureLimiter,
  recordAuthCallbackFailure
} = require('../middleware/rateLimiters');
const router = express.Router();

// Requirement 7.1/7.6: apply the dedicated auth rate limiter (20 requests
// per IP per 15-minute window) to the OAuth2-flow routes below --
// `/sso`, `/login`, `/silent`, `/silent-callback`, `/callback` -- each of
// which either redirects to Authentik or performs a token exchange.
//
// Deliberately NOT `router.use(authLimiter)` at the router level: that
// would also cover `/me` and `/logout` below, neither of which is an
// OAuth2 login attempt or talks to Authentik. `/me` in particular is
// re-fetched on every SPA page load/refresh (`App.jsx`'s mount effect,
// doubled under React StrictMode in development) by an ALREADY
// authenticated, cookie-bearing session -- there is no login/abuse surface
// there for this limiter to protect, only a normal user's own reload
// budget to needlessly consume. Folding it into the same 20-per-15-min
// bucket as the OAuth routes meant a handful of ordinary page reloads
// could 429 a real user with no login attempts at all. `/me` and
// `/logout` remain covered by the general 1000-requests/15-min backstop
// applied globally in `server/index.js`.
const authFlowLimiter = authLimiter;

// Requirement 3.1/3.2: cookie options shared by both the primary OAuth2
// callback and the silent-auth callback when delivering the JWT_Token to
// the Client. The token is never placed in a URL query parameter (which
// would be recorded in browser history, server access logs, or `Referer`
// headers); instead it is set as an httpOnly, Secure, SameSite=Lax cookie
// so the token value is never exposed to client-side JavaScript.
function getSessionCookieOptions() {
  return {
    httpOnly: true,
    // Only mark the cookie Secure when actually running in production
    // (NODE_ENV=production), where the App is served over HTTPS behind a
    // TLS-terminating load balancer/proxy. Over plain HTTP -- as used in
    // local/dev/test deployments -- browsers silently drop cookies with
    // the Secure attribute, which would otherwise make the `tak_session`
    // cookie never persist and SSO login appear broken.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: parseDurationMs(process.env.JWT_EXPIRES_IN)
  };
}

// SSO endpoint - immediately starts OAuth2 flow
router.get('/sso', authFlowLimiter, (req, res) => {
  const authURL = `${process.env.AUTHENTIK_URL}/application/o/authorize/` +
    `?response_type=code` +
    `&client_id=${process.env.AUTHENTIK_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.APP_URL + '/api/auth/callback')}` +
    `&scope=openid profile email`;
  
  res.redirect(authURL);
});

// OAuth2 login redirect
router.get('/login', authFlowLimiter, (req, res) => {
  const authURL = `${process.env.AUTHENTIK_URL}/application/o/authorize/` +
    `?response_type=code` +
    `&client_id=${process.env.AUTHENTIK_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.APP_URL + '/api/auth/callback')}` +
    `&scope=openid profile email`;
  
  res.redirect(authURL);
});

// Silent authentication check (prompt=none) - used by the client to
// silently re-establish a session (e.g. in a hidden iframe/popup) without
// forcing an interactive login screen.
router.get('/silent', authFlowLimiter, (req, res) => {
  const authURL = `${process.env.AUTHENTIK_URL}/application/o/authorize/` +
    `?response_type=code` +
    `&client_id=${process.env.AUTHENTIK_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.APP_URL + '/api/auth/silent-callback')}` +
    `&scope=openid profile email` +
    `&prompt=none`; // No user interaction - fails silently if no valid session

  res.redirect(authURL);
});

// Silent authentication callback. Because this flow runs in a popup/iframe,
// the result is delivered to the opening window via postMessage rather than
// a redirect, using the same 10000ms timeout, `code` validation, and error
// handling pattern as the primary OAuth2 callback below.
router.get('/silent-callback', authFlowLimiter, async (req, res) => {
  // Requirement 1.3/1.4: derive the postMessage target origin from
  // FRONTEND_URL instead of a hardcoded host.
  const frontendOrigin = new URL(process.env.FRONTEND_URL).origin;

  const sendResult = (payload) => {
    res.send(`
      <script>
        window.parent.postMessage(${JSON.stringify(payload)}, '${frontendOrigin}');
      </script>
    `);
  };

  try {
    const { code, error } = req.query;

    if (error || !code) {
      return sendResult({ success: false });
    }

    // Exchange code for token (same 10000ms timeout as the primary callback)
    const tokenResponse = await axios.post(process.env.AUTHENTIK_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.AUTHENTIK_CLIENT_ID,
        client_secret: process.env.AUTHENTIK_CLIENT_SECRET,
        code: code,
        redirect_uri: process.env.APP_URL + '/api/auth/silent-callback'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );

    const { access_token } = tokenResponse.data;

    // Get basic user info for authentication
    const userResponse = await axios.get(process.env.AUTHENTIK_USERINFO_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
      timeout: 10000
    });

    const basicUser = userResponse.data;

    // Get cached user data from local database
    const authentikSync = require('../services/authentikSync');
    const cachedUser = await authentikSync.getUserFromCache(basicUser.preferred_username);

    if (!cachedUser) {
      getLogger().warn({ username: basicUser.preferred_username }, 'User not found in cache, may need sync');
      return sendResult({ success: false });
    }

    // Create minimal JWT token with just user ID. A `jti` claim is added
    // so the token can be individually revoked on logout (Requirement 3.3).
    const jwtToken = jwt.sign(
      {
        userId: cachedUser.id,
        username: cachedUser.username,
        jti: crypto.randomUUID()
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    // Requirement 3.1/3.2: deliver the token via an httpOnly/Secure/
    // SameSite=Lax cookie set on this response rather than embedding it in
    // the postMessage payload's redirectUrl. Cookies set via res.cookie()
    // on this HTML response are set on the popup window's response the
    // same way they would be on a redirect response.
    res.cookie('tak_session', jwtToken, getSessionCookieOptions());

    sendResult({
      success: true,
      redirectUrl: `${process.env.FRONTEND_URL}/dashboard`
    });
  } catch (error) {
    getLogger().error({ err: error.response?.data || error.message }, 'Silent auth error');
    sendResult({ success: false });
  }
});

// OAuth2 callback
//
// Requirement 7.5/7.6: `authCallbackFailureLimiter` gates this route
// specifically, on top of `authFlowLimiter` (the 20-per-15-min OAuth2-flow
// limiter also applied to `/sso`, `/login`, `/silent`, `/silent-callback`
// above). It rejects with 429 (before any token exchange or Authentik API
// call) once the requesting IP has already recorded 10 failed callback
// attempts within the current 15-minute window. `recordAuthCallbackFailure`
// is called only from the `catch` block below -- i.e. only on an actual
// token-exchange/userinfo failure, never on a successful callback (both
// outcomes redirect with HTTP 302, so success vs. failure can't be
// distinguished by status code alone).
router.get('/callback', authFlowLimiter, authCallbackFailureLimiter, async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.redirect(process.env.FRONTEND_URL + '?error=no_code');
    }

    // Exchange code for token
    const tokenResponse = await axios.post(process.env.AUTHENTIK_TOKEN_URL, 
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.AUTHENTIK_CLIENT_ID,
        client_secret: process.env.AUTHENTIK_CLIENT_SECRET,
        code: code,
        redirect_uri: process.env.APP_URL + '/api/auth/callback'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );

    const { access_token } = tokenResponse.data;

    // Get basic user info for authentication
    const userResponse = await axios.get(process.env.AUTHENTIK_USERINFO_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
      timeout: 10000
    });

    const basicUser = userResponse.data;


    // Refresh user groups from Authentik on login for immediate role updates
    const authentikSync = require('../services/authentikSync');
    const adminGroupName = process.env.ADMIN_GROUP_NAME || 'TakTeamManager_Admin';

    try {
      const userDetailResponse = await axios.get(
        `${process.env.AUTHENTIK_URL}/api/v3/core/users/?username=${encodeURIComponent(basicUser.preferred_username)}`,
        { headers: { Authorization: `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }, timeout: 10000 }
      );
      const authentikUser = userDetailResponse.data.results && userDetailResponse.data.results[0];
      if (!authentikUser) throw new Error("User not found in Authentik");

      const groupNames = [];
      if (authentikUser.groups && authentikUser.groups.length > 0) {
        const groupResponse = await axios.get(
          `${process.env.AUTHENTIK_URL}/api/v3/core/groups/?page_size=500`,
          { headers: { Authorization: `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }, timeout: 10000 }
        );
        const groupMap = {};
        for (const g of (groupResponse.data.results || [])) {
          groupMap[g.pk] = g.name;
        }
        for (const gid of authentikUser.groups) {
          if (groupMap[gid]) groupNames.push(groupMap[gid]);
        }
      }

      const isAdmin = groupNames.includes(adminGroupName);
      await pool.query(
        'UPDATE user_cache SET groups = $1, is_admin = $2, updated_at = CURRENT_TIMESTAMP WHERE username = $3',
        [groupNames, isAdmin, basicUser.preferred_username]
      );
    } catch (refreshErr) {
      getLogger().warn({ err: refreshErr.message, username: basicUser.preferred_username }, 'Failed to refresh user groups on login');
    }

    // Get cached user data (now freshly updated)
    let cachedUser = await authentikSync.getUserFromCache(basicUser.preferred_username);

    if (!cachedUser) {
      // Self-heal: the user exists in Authentik (we just fetched authentikUser
      // above) but has no user_cache row yet — e.g. first boot before the
      // initial periodic sync completed, or a user added to Authentik since the
      // last sync. Run one on-demand sync and retry the lookup once, rather than
      // bouncing a valid user to ?error=user_not_synced and making them wait for
      // the next periodic sync (up to SYNC_INTERVAL_MINUTES).
      getLogger().warn({ username: basicUser.preferred_username }, 'User not found in cache; running on-demand Authentik sync');
      try {
        await authentikSync.syncUsers();
      } catch (syncErr) {
        getLogger().error({ err: syncErr.message, username: basicUser.preferred_username }, 'On-demand Authentik sync failed during login');
      }
      cachedUser = await authentikSync.getUserFromCache(basicUser.preferred_username);
    }

    if (!cachedUser) {
      getLogger().warn({ username: basicUser.preferred_username }, 'User still not in cache after on-demand sync; redirecting');
      return res.redirect(process.env.FRONTEND_URL + '?error=user_not_synced');
    }



    // Create minimal JWT token with just user ID. A `jti` claim is added
    // so the token can be individually revoked on logout (Requirement 3.3).
    const jwtToken = jwt.sign(
      { 
        userId: cachedUser.id,
        username: cachedUser.username,
        jti: crypto.randomUUID()
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );
    
    // Requirement 3.1/3.2: deliver the token via an httpOnly/Secure/
    // SameSite=Lax cookie instead of a `?token=` URL query parameter, which
    // would otherwise be recorded in browser history, server access logs,
    // or Referer headers.
    res.cookie('tak_session', jwtToken, getSessionCookieOptions());

    // Redirect to a bare dashboard URL - no token in the URL.
    res.redirect(`${process.env.FRONTEND_URL}/dashboard`);
  } catch (error) {
    getLogger().error({ err: error.response?.data || error.message }, 'OAuth callback error');
    // Requirement 7.5: this catch block is the ONLY place a failed
    // callback attempt is recorded against the authCallbackFailureLimiter
    // counter for the requesting IP.
    recordAuthCallbackFailure(req);
    res.redirect(process.env.FRONTEND_URL + '?error=auth_failed');
  }
});

// Logout
//
// Requirement 3.4: logout SHALL always clear the token cookie and return a
// success response, whether or not a valid token was present (missing,
// expired, invalid signature, etc.) - none of that ever produces an error
// response for this endpoint.
//
// Requirement 3.3: WHEN a valid token (one that verifies and carries a
// `jti`) was present, logout additionally inserts a `token_revocations`
// row so that a subsequent request using that same token is rejected by
// `authenticateToken` with 401.
// GET /logout for browser-navigable logout (redirects to login page)
router.get('/logout', async (req, res) => {
  // maxAge is destructured out deliberately -- clearCookie sets its own
  // expiry, and a stale maxAge in clearOptions would fight that.
  // eslint-disable-next-line no-unused-vars
  const { maxAge, ...clearOptions } = getSessionCookieOptions();
  res.clearCookie('tak_session', clearOptions);
  res.redirect(process.env.FRONTEND_URL || '/');
});

router.post('/logout', async (req, res) => {
  const token = req.cookies && req.cookies.tak_session;

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (decoded && decoded.jti && decoded.exp) {
        try {
          // exp is Unix seconds; token_revocations.expires_at is a
          // timestamp. Once the token itself would have expired naturally,
          // the revocation row is no longer needed (matches the retention
          // job's `WHERE expires_at < NOW()` purge pattern).
          const expiresAt = new Date(decoded.exp * 1000);
          await pool.query(
            'INSERT INTO token_revocations (jti, expires_at) VALUES ($1, $2) ON CONFLICT (jti) DO NOTHING',
            [decoded.jti, expiresAt]
          );
        } catch (revocationError) {
          // A DB failure while recording the revocation SHALL NOT prevent
          // logout from clearing the cookie and returning success.
          getLogger().error({ err: revocationError.message }, 'Failed to record token revocation on logout');
        }
      }
    } catch {
      // Missing, expired, or invalid-signature token - logout still
      // succeeds; there is simply no `jti` to revoke.
    }
  }

  // Requirement 3.4: clear the cookie using options matching how it was
  // set (minus maxAge, since clearCookie sets its own expiry) so the
  // browser actually removes it - a path/domain/secure/sameSite mismatch
  // would otherwise silently no-op.
  // eslint-disable-next-line no-unused-vars
  const { maxAge, ...clearOptions } = getSessionCookieOptions();
  res.clearCookie('tak_session', clearOptions);

  // WHERE AUTHENTIK_LOGOUT_URL is configured (Authentik's OIDC
  // end-session endpoint for this application), return it as
  // `redirectUrl` so the client can navigate the browser there after this
  // call resolves -- ending the Authentik SSO session too, not just the
  // local App session. This is a plain JSON response to an axios POST
  // (client/src/services/api.js's authAPI.logout()), not a page
  // navigation, so an HTTP redirect here would never be followed by the
  // browser; the client is responsible for the actual navigation (see
  // client/src/components/Layout.jsx's handleLogout). IF
  // AUTHENTIK_LOGOUT_URL is unset, `redirectUrl` is omitted and the
  // client falls back to its existing local-only behavior.
  const logoutUrl = process.env.AUTHENTIK_LOGOUT_URL;
  const response = { message: 'Logged out successfully' };
  if (typeof logoutUrl === 'string' && logoutUrl.trim().length > 0) {
    response.redirectUrl = logoutUrl;
  }

  res.json(response);
});

// Get current user
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
// Requirement: the top-bar role label distinguishes a Global_Manager
// (Authentik ADMIN_GROUP_NAME membership, already carried on req.user as
// is_global_manager/isAdmin) from a Team_Admin (a role='admin' row in
// team_memberships for at least one Team). That second flag is resolved
// HERE rather than in resolveUserFromRequest (server/middleware/auth.js)
// deliberately: resolveUserFromRequest runs on EVERY authenticated
// request, so doing this lookup there would add a database round trip to
// every API call for a value only the Client's role label needs. This
// route is the single place the Client reads its own profile from, so the
// lookup happens exactly once per profile fetch instead.
//
// A failure here is non-fatal and falls back to isTeamAdmin: false --
// the profile response itself must still succeed, since an advisory
// display label is not worth failing the whole request over.
router.get('/me', authenticateToken, authorize, async (req, res) => {
  let isTeamAdmin = false;
  try {
    const result = await pool.query(
      "SELECT 1 FROM team_memberships WHERE user_id = $1 AND role = 'admin' LIMIT 1",
      [req.user.userId]
    );
    isTeamAdmin = result.rows.length > 0;
  } catch (err) {
    getLogger().warn({ err: err.message }, 'Failed to resolve team admin status for profile');
  }

  res.json({ user: { ...req.user, isTeamAdmin } });
});

module.exports = router;