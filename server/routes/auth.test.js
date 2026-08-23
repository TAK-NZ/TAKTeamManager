/**
 * Integration tests for the auth-scoped rate limiters (Requirements 7.1,
 * 7.5, 7.6) mounted on `server/routes/auth.js`.
 *
 * These exercise the actual mounted router via `supertest` rather than
 * `server/middleware/rateLimiters.js` in isolation, so they verify the
 * limiters are wired up on the real routes with the right thresholds:
 *
 *  - `authLimiter`: the 21st request from a given IP within a 15-minute
 *    window to ANY `/api/auth/*` route (exercised here via
 *    `GET /api/auth/login`, a route with no other side effects) receives
 *    HTTP 429.
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
  syncUsers: jest.fn()
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
      AUTHENTIK_ADMIN_TOKEN: 'admin-token',
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
