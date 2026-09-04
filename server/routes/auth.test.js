/**
 * Integration tests for the auth-scoped rate limiters (Requirements 7.1,
 * 7.5, 7.6) mounted on `server/routes/auth.js`.
 *
 * These exercise the actual mounted router via `supertest` rather than
 * `server/middleware/rateLimiters.js` in isolation, so they verify the
 * limiters are wired up on the real routes with the right thresholds:
 *
 *  - `authLimiter` (mounted per-route as `authFlowLimiter`, not
 *    router-wide): the 21st request from a given IP within a 15-minute
 *    window to an OAuth2-flow route (exercised here via
 *    `GET /api/auth/login`, a route with no other side effects) receives
 *    HTTP 429.
 *  - `GET /api/auth/me` is deliberately NOT covered by that same 20-per-
 *    15-min bucket -- it's re-fetched on every SPA page load by an
 *    already-authenticated session and talks to no Authentik endpoint,
 *    so it must not be exhausted by ordinary reload traffic (see the
 *    regression test below).
 *  - `authCallbackFailureLimiter`: after 10 FAILED `GET /api/auth/callback`
 *    attempts from a given IP, the 11th attempt receives HTTP 429 without
 *    ever reaching the token-exchange (`axios.post`) call. A successful
 *    callback does NOT count toward that failure limit.
 */

jest.mock('axios');
jest.mock('../config/database', () => ({
  query: jest.fn()
}));
jest.mock('../services/authentikSync', () => ({
  getUserFromCache: jest.fn(),
  syncUsers: jest.fn(),
  // Perf bugfix (slow first login): first-login onboarding now syncs the
  // SINGLE logging-in user via syncSingleUser (reusing the already-fetched
  // Authentik user + group map), instead of a whole-directory syncUsers().
  syncSingleUser: jest.fn(),
  // The login callback resolves a user's Authentik group ids to names via
  // the PAGINATED group-map builder (bugfix: a single capped page dropped
  // most groups, incl. ADMIN_GROUP_NAME, silently demoting admins on
  // every login). Stubbed so the callback path never makes a real fetch.
  fetchGroupMap: jest.fn(() => Promise.resolve({}))
}));

const axios = require('axios');
const express = require('express');
const request = require('supertest');
const authentikSync = require('../services/authentikSync');

const {
  authLimiterStore,
  authCallbackFailureStore,
  AUTH_LIMITER_MAX,
  AUTH_CALLBACK_FAILURE_MAX
} = require('../middleware/rateLimiters');

function buildApp() {
  // Required each time so the router (and its `router.use(authLimiter)`)
  // is freshly required after jest.resetModules() in beforeEach below,
  // matching the real mounting shape used by server/index.js
  // (`app.use('/api/auth', require('./routes/auth'))`).
  const authRouter = require('./auth');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

describe('Auth rate limiters (Requirements 7.1, 7.5, 7.6)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    authLimiterStore.resetAll();
    authCallbackFailureStore.resetAll();

    process.env = {
      ...ORIGINAL_ENV,
      AUTHENTIK_URL: 'https://authentik.example.com',
      AUTHENTIK_CLIENT_ID: 'client-id',
      AUTHENTIK_CLIENT_SECRET: 'client-secret',
      AUTHENTIK_TOKEN_URL: 'https://authentik.example.com/token',
      AUTHENTIK_USERINFO_URL: 'https://authentik.example.com/userinfo',
      APP_URL: 'https://app.example.com',
      FRONTEND_URL: 'https://app.example.com',
      JWT_SECRET: 'a'.repeat(32),
      JWT_EXPIRES_IN: '1h'
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('authLimiter on /api/auth/*', () => {
    it('allows requests up to the configured limit and rejects the one after it with 429', async () => {
      const app = buildApp();

      for (let i = 0; i < AUTH_LIMITER_MAX; i++) {
        const res = await request(app).get('/api/auth/login');
        expect(res.status).toBe(302); // redirect to Authentik, not rate-limited
      }

      const limitedRes = await request(app).get('/api/auth/login');
      expect(limitedRes.status).toBe(429);
    });

    it('does not apply authFlowLimiter to GET /api/auth/me, so ordinary session-refresh traffic is never 429d', async () => {
      const app = buildApp();

      // More than AUTH_LIMITER_MAX requests to /me (no session cookie, so
      // each individually 401s via authenticateToken) -- none of them may
      // ever draw from the same bucket as the OAuth2-flow routes above.
      for (let i = 0; i < AUTH_LIMITER_MAX + 5; i++) {
        const res = await request(app).get('/api/auth/me');
        expect(res.status).not.toBe(429);
      }

      // The OAuth2-flow bucket is untouched by the /me traffic above: a
      // fresh IP-scoped run against /login still has its full budget.
      for (let i = 0; i < AUTH_LIMITER_MAX; i++) {
        const res = await request(app).get('/api/auth/login');
        expect(res.status).toBe(302);
      }
      const limitedRes = await request(app).get('/api/auth/login');
      expect(limitedRes.status).toBe(429);
    });
  });

  describe('authCallbackFailureLimiter on GET /api/auth/callback', () => {
    it('does not count a successful callback toward the failure limit', async () => {
      const app = buildApp();

      axios.post.mockResolvedValue({ data: { access_token: 'tok' } });
      axios.get.mockResolvedValue({ data: { preferred_username: 'jdoe' } });
      authentikSync.getUserFromCache.mockResolvedValue({
        id: 1,
        username: 'jdoe'
      });

      // Far more than AUTH_CALLBACK_FAILURE_MAX successful callbacks should
      // never trip the failure-specific limiter, since none of them are
      // failures.
      for (let i = 0; i < AUTH_CALLBACK_FAILURE_MAX + 5; i++) {
        const res = await request(app).get('/api/auth/callback').query({ code: 'abc' });
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('https://app.example.com/dashboard');
      }
    });

    it('rejects with 429 after the configured number of failed attempts, before any token exchange', async () => {
      const app = buildApp();

      // Token exchange fails every time (e.g. Authentik rejects the code),
      // driving the callback's existing catch block, which is the only
      // place recordAuthCallbackFailure is called.
      axios.post.mockRejectedValue(new Error('invalid_grant'));

      for (let i = 0; i < AUTH_CALLBACK_FAILURE_MAX; i++) {
        const res = await request(app).get('/api/auth/callback').query({ code: 'abc' });
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('https://app.example.com?error=auth_failed');
      }

      axios.post.mockClear();

      const limitedRes = await request(app).get('/api/auth/callback').query({ code: 'abc' });
      expect(limitedRes.status).toBe(429);
      // Requirement 7.6: no token exchange happens for the rate-limited request.
      expect(axios.post).not.toHaveBeenCalled();
    });
  });
});

/**
 * Tests for the OAuth2 callback's cache-miss self-heal on
 * `GET /api/auth/callback` (eliminating the `?error=user_not_synced`
 * bounce for valid users whose `user_cache` row hasn't been written yet --
 * first boot before the initial sync completes, or a user added to
 * Authentik since the last periodic sync).
 *
 * On a cache miss, the callback runs ONE on-demand `authentikSync.syncUsers()`
 * and retries `getUserFromCache` ONCE before redirecting to the error page.
 *
 * The harness's `axios.get` mock answers BOTH the userinfo call (returning
 * `preferred_username`) and the subsequent user-detail group-refresh call;
 * since the mocked payload has no `.results`, the group refresh throws
 * "User not found in Authentik" and is swallowed by its own non-fatal
 * catch -- that path is unrelated to the cache-miss self-heal under test.
 */
describe('GET /api/auth/callback cache-miss self-heal', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    authLimiterStore.resetAll();
    authCallbackFailureStore.resetAll();

    process.env = {
      ...ORIGINAL_ENV,
      AUTHENTIK_URL: 'https://authentik.example.com',
      AUTHENTIK_CLIENT_ID: 'client-id',
      AUTHENTIK_CLIENT_SECRET: 'client-secret',
      AUTHENTIK_TOKEN_URL: 'https://authentik.example.com/token',
      AUTHENTIK_USERINFO_URL: 'https://authentik.example.com/userinfo',
      AUTHENTIK_API_TOKEN: 'admin-token',
      APP_URL: 'https://app.example.com',
      FRONTEND_URL: 'https://app.example.com',
      JWT_SECRET: 'a'.repeat(32),
      JWT_EXPIRES_IN: '1h'
    };

    axios.post.mockResolvedValue({ data: { access_token: 'tok' } });
    axios.get.mockResolvedValue({ data: { preferred_username: 'jdoe' } });
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('(a) cache hit: issues a JWT cookie and never runs an on-demand sync', async () => {
    const app = buildApp();

    authentikSync.getUserFromCache.mockResolvedValue({ id: 1, username: 'jdoe' });

    const res = await request(app).get('/api/auth/callback').query({ code: 'abc' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://app.example.com/dashboard');
    expect(res.headers['set-cookie'][0]).toContain('tak_session=');
    expect(authentikSync.syncUsers).not.toHaveBeenCalled();
    expect(authentikSync.getUserFromCache).toHaveBeenCalledTimes(1);
  });

  it('(b) miss then hit: runs exactly one on-demand sync, issues a JWT cookie, and does not redirect to the error page', async () => {
    const app = buildApp();

    authentikSync.getUserFromCache
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 2, username: 'jdoe' });
    authentikSync.syncUsers.mockResolvedValue(undefined);

    const res = await request(app).get('/api/auth/callback').query({ code: 'abc' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://app.example.com/dashboard');
    expect(res.headers.location).not.toContain('error=user_not_synced');
    expect(res.headers['set-cookie'][0]).toContain('tak_session=');
    expect(authentikSync.syncUsers).toHaveBeenCalledTimes(1);
    expect(authentikSync.getUserFromCache).toHaveBeenCalledTimes(2);
  });

  // Perf bugfix (slow first login): when the Authentik user object IS
  // resolved (the common first-login case), onboarding syncs only THAT one
  // user via syncSingleUser -- NOT the whole-directory syncUsers() -- so
  // the redirect isn't blocked on a directory-wide sync.
  it('(b2) miss then hit WITH a resolved Authentik user: syncs the single user, never the whole directory', async () => {
    const app = buildApp();
    const pool = require('../config/database');
    // Group-refresh UPDATE + the JWT-userId SELECT both go through pool.query.
    pool.query.mockResolvedValue({ rows: [{ id: 2 }] });

    // #1 userinfo (preferred_username), #2 user-detail lookup (results[0]
    // with a groups array so the group refresh resolves authentikUser).
    axios.get
      .mockResolvedValueOnce({ data: { preferred_username: 'jdoe' } })
      .mockResolvedValueOnce({ data: { results: [{ pk: 55, username: 'jdoe', groups: ['g1'] }] } });
    authentikSync.fetchGroupMap.mockResolvedValue({ g1: 'tak_Teams - FENZ' });

    authentikSync.getUserFromCache
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 2, username: 'jdoe', authentik_id: 55 });
    authentikSync.syncSingleUser.mockResolvedValue(undefined);

    const res = await request(app).get('/api/auth/callback').query({ code: 'abc' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://app.example.com/dashboard');
    expect(res.headers['set-cookie'][0]).toContain('tak_session=');
    // Single-user sync used; whole-directory sync never called.
    expect(authentikSync.syncSingleUser).toHaveBeenCalledTimes(1);
    expect(authentikSync.syncSingleUser).toHaveBeenCalledWith(
      expect.objectContaining({ pk: 55, username: 'jdoe' }),
      expect.any(Object),
      'TakTeamManager_Admin'
    );
    expect(authentikSync.syncUsers).not.toHaveBeenCalled();
  });

  it('(c) miss + syncUsers throws: swallows the sync error, still redirects to ?error=user_not_synced, and does not crash', async () => {
    const app = buildApp();

    authentikSync.getUserFromCache.mockResolvedValue(null);
    authentikSync.syncUsers.mockRejectedValue(new Error('authentik unreachable'));

    const res = await request(app).get('/api/auth/callback').query({ code: 'abc' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://app.example.com?error=user_not_synced');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(authentikSync.syncUsers).toHaveBeenCalledTimes(1);
    // Retry still happens even though the sync failed.
    expect(authentikSync.getUserFromCache).toHaveBeenCalledTimes(2);
  });

  it('(d) miss before and after sync: redirects to ?error=user_not_synced', async () => {
    const app = buildApp();

    authentikSync.getUserFromCache.mockResolvedValue(null);
    authentikSync.syncUsers.mockResolvedValue(undefined);

    const res = await request(app).get('/api/auth/callback').query({ code: 'abc' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://app.example.com?error=user_not_synced');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(authentikSync.syncUsers).toHaveBeenCalledTimes(1);
    expect(authentikSync.getUserFromCache).toHaveBeenCalledTimes(2);
  });
});

/**
 * Unit tests for `getSessionCookieOptions()`'s `secure` flag (Requirement
 * 3.1/3.2). `secure` must be conditional on `NODE_ENV=production` rather
 * than hardcoded `true`: over plain HTTP (local/dev/test deployments),
 * browsers silently drop cookies with the Secure attribute, which would
 * otherwise make the `tak_session` cookie never persist after a
 * successful OAuth callback.
 */
describe('getSessionCookieOptions secure flag (Requirements 3.1, 3.2)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    authLimiterStore.resetAll();
    authCallbackFailureStore.resetAll();

    process.env = {
      ...ORIGINAL_ENV,
      AUTHENTIK_URL: 'https://authentik.example.com',
      AUTHENTIK_CLIENT_ID: 'client-id',
      AUTHENTIK_CLIENT_SECRET: 'client-secret',
      AUTHENTIK_TOKEN_URL: 'https://authentik.example.com/token',
      AUTHENTIK_USERINFO_URL: 'https://authentik.example.com/userinfo',
      APP_URL: 'https://app.example.com',
      FRONTEND_URL: 'https://app.example.com',
      JWT_SECRET: 'a'.repeat(32),
      JWT_EXPIRES_IN: '1h'
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('sets the Secure attribute on the tak_session cookie when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const app = buildApp();

    axios.post.mockResolvedValueOnce({ data: { access_token: 'tok' } });
    axios.get.mockResolvedValueOnce({ data: { preferred_username: 'jdoe' } });
    authentikSync.getUserFromCache.mockResolvedValueOnce({ id: 1, username: 'jdoe' });

    const res = await request(app).get('/api/auth/callback').query({ code: 'abc' });

    expect(res.headers['set-cookie'][0]).toContain('tak_session=');
    expect(res.headers['set-cookie'][0]).toMatch(/Secure/i);
  });

  it('omits the Secure attribute on the tak_session cookie when NODE_ENV is not production', async () => {
    process.env.NODE_ENV = 'test';
    const app = buildApp();

    axios.post.mockResolvedValueOnce({ data: { access_token: 'tok' } });
    axios.get.mockResolvedValueOnce({ data: { preferred_username: 'jdoe' } });
    authentikSync.getUserFromCache.mockResolvedValueOnce({ id: 1, username: 'jdoe' });

    const res = await request(app).get('/api/auth/callback').query({ code: 'abc' });

    expect(res.headers['set-cookie'][0]).toContain('tak_session=');
    expect(res.headers['set-cookie'][0]).not.toMatch(/Secure/i);
  });
});

/**
 * Unit tests for the ported silent-auth flow (Requirement 1.3: "reusing
 * the same request-timeout value (currently 10000ms), `code` parameter
 * validation, and error-redirect handling already used by the primary
 * OAuth2 callback").
 *
 * `GET /api/auth/silent` / `GET /api/auth/silent-callback` don't redirect
 * on error the way the primary `/callback` does -- because this flow runs
 * in a popup/iframe, the result is delivered to the opening window via
 * `postMessage` instead of an HTTP redirect (see `server/routes/auth.js`'s
 * `sendResult` helper). The tests below therefore verify the FUNCTIONAL
 * equivalent of the primary callback's error-redirect pattern for this
 * flow: a `{success: false}` postMessage payload with no Authentik call
 * ever attempted, in every case that would redirect-with-an-error on the
 * primary callback (missing `code`, an `error` query param, or a
 * downstream Authentik/cache failure).
 */
describe('GET /api/auth/silent and /silent-callback (Requirement 1.3)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    authLimiterStore.resetAll();
    authCallbackFailureStore.resetAll();

    process.env = {
      ...ORIGINAL_ENV,
      AUTHENTIK_URL: 'https://authentik.example.com',
      AUTHENTIK_CLIENT_ID: 'client-id',
      AUTHENTIK_CLIENT_SECRET: 'client-secret',
      AUTHENTIK_TOKEN_URL: 'https://authentik.example.com/token',
      AUTHENTIK_USERINFO_URL: 'https://authentik.example.com/userinfo',
      APP_URL: 'https://app.example.com',
      FRONTEND_URL: 'https://app.example.com',
      JWT_SECRET: 'a'.repeat(32),
      JWT_EXPIRES_IN: '1h'
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('GET /api/auth/silent', () => {
    it('redirects to an Authentik authorize URL with prompt=none targeting /silent-callback', async () => {
      const app = buildApp();

      const res = await request(app).get('/api/auth/silent');

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('prompt=none');
      // redirect_uri is percent-encoded; decode the full location before
      // asserting on the path it targets.
      expect(decodeURIComponent(res.headers.location)).toContain('/api/auth/silent-callback');
    });
  });

  describe('GET /api/auth/silent-callback', () => {
    it('exchanges a valid code with a 10000ms timeout and posts success:true with a /dashboard redirectUrl', async () => {
      const app = buildApp();

      axios.post.mockResolvedValueOnce({ data: { access_token: 'tok' } });
      axios.get.mockResolvedValueOnce({ data: { preferred_username: 'jdoe' } });
      authentikSync.getUserFromCache.mockResolvedValueOnce({ id: 1, username: 'jdoe' });

      const res = await request(app).get('/api/auth/silent-callback').query({ code: 'abc' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('"success":true');
      expect(res.text).toContain('"redirectUrl":"https://app.example.com/dashboard"');

      // "timeout value" half of the task: both Authentik calls use the
      // same 10000ms timeout as the primary /callback.
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post.mock.calls[0][2]).toMatchObject({ timeout: 10000 });
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(axios.get.mock.calls[0][1]).toMatchObject({ timeout: 10000 });

      // A session cookie is set on success, matching the primary callback.
      expect(res.headers['set-cookie']).toBeDefined();
      expect(res.headers['set-cookie'][0]).toContain('tak_session=');
    });

    it('posts success:false to the FRONTEND_URL origin, matching the postMessage security check', async () => {
      const app = buildApp();

      axios.post.mockResolvedValueOnce({ data: { access_token: 'tok' } });
      axios.get.mockResolvedValueOnce({ data: { preferred_username: 'jdoe' } });
      authentikSync.getUserFromCache.mockResolvedValueOnce({ id: 1, username: 'jdoe' });

      const res = await request(app).get('/api/auth/silent-callback').query({ code: 'abc' });

      // Only the configured FRONTEND_URL's origin should ever receive the
      // postMessage -- a security-relevant detail of this popup flow.
      expect(res.text).toContain("postMessage({\"success\":true,\"redirectUrl\":\"https://app.example.com/dashboard\"}, 'https://app.example.com')");
    });

    it('"code" validation: with no code query param, never calls axios.post and posts success:false', async () => {
      const app = buildApp();

      const res = await request(app).get('/api/auth/silent-callback');

      expect(res.status).toBe(200);
      expect(res.text).toContain('"success":false');
      expect(axios.post).not.toHaveBeenCalled();
      expect(axios.get).not.toHaveBeenCalled();
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('error-redirect equivalent: with an error query param (e.g. login_required), never calls axios.post and posts success:false', async () => {
      const app = buildApp();

      const res = await request(app)
        .get('/api/auth/silent-callback')
        .query({ error: 'login_required' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('"success":false');
      expect(axios.post).not.toHaveBeenCalled();
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('posts success:false and sets no cookie when the token exchange rejects', async () => {
      const app = buildApp();

      axios.post.mockRejectedValueOnce(new Error('invalid_grant'));

      const res = await request(app).get('/api/auth/silent-callback').query({ code: 'abc' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('"success":false');
      expect(axios.get).not.toHaveBeenCalled();
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('posts success:false and sets no cookie when no cached user is found', async () => {
      const app = buildApp();

      axios.post.mockResolvedValueOnce({ data: { access_token: 'tok' } });
      axios.get.mockResolvedValueOnce({ data: { preferred_username: 'unknown-user' } });
      authentikSync.getUserFromCache.mockResolvedValueOnce(null);

      const res = await request(app).get('/api/auth/silent-callback').query({ code: 'abc' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('"success":false');
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });
});

/**
 * Bugfix (admin status stripped on every login): the callback's group
 * refresh resolves the logged-in user's Authentik group IDs to names to
 * decide `is_admin` (membership of ADMIN_GROUP_NAME). It used to fetch the
 * group list with a single `?page_size=500` request, but Authentik caps a
 * page at 100 results regardless -- so in a deployment with >100 groups,
 * any user whose admin group sorted past the first page had it silently
 * dropped, computing `is_admin = false` and clobbering the cached row on
 * EVERY login. The fix resolves names via the PAGINATED
 * `authentikSync.fetchGroupMap()`; these tests pin that behaviour.
 */
describe('GET /api/auth/callback admin group refresh (paginated group map)', () => {
  const ORIGINAL_ENV = process.env;
  const pool = require('../config/database');

  beforeEach(() => {
    jest.clearAllMocks();
    authLimiterStore.resetAll();
    authCallbackFailureStore.resetAll();
    process.env = {
      ...ORIGINAL_ENV,
      AUTHENTIK_CLIENT_ID: 'client-id',
      AUTHENTIK_CLIENT_SECRET: 'client-secret',
      AUTHENTIK_TOKEN_URL: 'https://authentik.example.com/token',
      AUTHENTIK_USERINFO_URL: 'https://authentik.example.com/userinfo',
      AUTHENTIK_URL: 'https://authentik.example.com',
      AUTHENTIK_API_TOKEN: 'admin-token',
      APP_URL: 'https://app.example.com',
      FRONTEND_URL: 'https://app.example.com',
      ADMIN_GROUP_NAME: 'TakTeamManager_Admin'
    };
    pool.query.mockResolvedValue({ rows: [] });
    authentikSync.getUserFromCache.mockResolvedValue({ id: 2, username: 'chris@example.net' });
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  // Arrange the two callback GETs: #1 userinfo (preferred_username), #2 the
  // user-detail lookup by username. Perf bugfix: the login path now resolves
  // group names from the user-detail response's `groups_obj` ([{ pk, name }]
  // for exactly this user's groups) -- NOT from a paginated full-directory
  // fetchGroupMap walk. `groupNameByPk` maps each of the user's group pks to
  // its name; the arranged response carries both `groups` (pks, the order
  // the code iterates) and the matching `groups_obj`.
  function arrangeCallback(groupNameByPk) {
    const userGroupIds = Object.keys(groupNameByPk);
    const groupsObj = userGroupIds.map((pk) => ({ pk, name: groupNameByPk[pk] }));
    axios.post.mockResolvedValue({ data: { access_token: 'tok' } });
    axios.get
      .mockResolvedValueOnce({ data: { preferred_username: 'chris@example.net' } })
      .mockResolvedValueOnce({ data: { results: [{ pk: 99, groups: userGroupIds, groups_obj: groupsObj }] } });
  }

  it('resolves group names from groups_obj (no paginated fetchGroupMap) and writes is_admin=true when the user is in ADMIN_GROUP_NAME', async () => {
    const app = buildApp();
    arrangeCallback({ 'g-admin': 'TakTeamManager_Admin', 'g-other': 'tak_Teams - FENZ' });

    const res = await request(app).get('/api/auth/callback').query({ code: 'abc' });
    expect(res.status).toBe(302);

    // The whole point of the perf fix: names come from `groups_obj`, so the
    // login path makes NO paginated group-list walk and NO raw core/groups
    // fetch of its own.
    expect(authentikSync.fetchGroupMap).not.toHaveBeenCalled();
    const groupListFetch = axios.get.mock.calls.find(([url]) => /\/core\/groups\//.test(url));
    expect(groupListFetch).toBeUndefined();

    // The cache UPDATE recorded is_admin=true and the full resolved group list.
    const adminUpdate = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && /UPDATE user_cache SET groups/.test(sql)
    );
    expect(adminUpdate).toBeDefined();
    const [, params] = adminUpdate;
    expect(params[0]).toEqual(['TakTeamManager_Admin', 'tak_Teams - FENZ']); // groups
    expect(params[1]).toBe(true); // is_admin
  });

  it('writes is_admin=false when the resolved groups do not include ADMIN_GROUP_NAME', async () => {
    const app = buildApp();
    arrangeCallback({ 'g-other': 'tak_Teams - FENZ' });

    const res = await request(app).get('/api/auth/callback').query({ code: 'abc' });
    expect(res.status).toBe(302);

    expect(authentikSync.fetchGroupMap).not.toHaveBeenCalled();
    const adminUpdate = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && /UPDATE user_cache SET groups/.test(sql)
    );
    expect(adminUpdate).toBeDefined();
    expect(adminUpdate[1][1]).toBe(false); // is_admin
  });

  it('falls back to the paginated fetchGroupMap when the user-detail response has no groups_obj', async () => {
    // Defensive fallback: an older Authentik / unexpected serializer that
    // omits `groups_obj` must still resolve admin status correctly, or the
    // login would clobber a Global_Manager's is_admin to false. When
    // `groups_obj` is absent, the code walks the paginated full list.
    const app = buildApp();
    axios.post.mockResolvedValue({ data: { access_token: 'tok' } });
    axios.get
      .mockResolvedValueOnce({ data: { preferred_username: 'chris@example.net' } })
      // No `groups_obj` key at all -- only the pk list.
      .mockResolvedValueOnce({ data: { results: [{ pk: 99, groups: ['g-admin', 'g-other'] }] } });
    authentikSync.fetchGroupMap.mockResolvedValue({
      'g-admin': 'TakTeamManager_Admin',
      'g-other': 'tak_Teams - FENZ'
    });

    const res = await request(app).get('/api/auth/callback').query({ code: 'abc' });
    expect(res.status).toBe(302);

    expect(authentikSync.fetchGroupMap).toHaveBeenCalledTimes(1);
    const adminUpdate = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && /UPDATE user_cache SET groups/.test(sql)
    );
    expect(adminUpdate).toBeDefined();
    expect(adminUpdate[1][0]).toEqual(['TakTeamManager_Admin', 'tak_Teams - FENZ']);
    expect(adminUpdate[1][1]).toBe(true); // is_admin
  });
});
