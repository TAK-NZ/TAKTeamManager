/**
 * Unit tests for `requireCurrentAgreement` (Requirement 28 Criteria 6-7,
 * task 50.4; BUG-010 fix).
 *
 * Covers:
 *   - No current serverwide agreement exists: passes through.
 *   - A current agreement exists and the user has signed that exact
 *     document version: passes through.
 *   - A current agreement exists and the user has NOT signed it: blocked
 *     with 403 `{error, requiresSignature: true, documentId}`.
 *   - The signature-submission and logout bypass routes always pass
 *     through, regardless of signature status (no query even runs).
 *   - An unauthenticated request (no `req.user`, no valid session
 *     cookie) is skipped/passed through without querying the database.
 *
 * `server/config/database` is mocked (`pool.query`) so each case can
 * control exactly what the current-agreement lookup and signature lookup
 * return, following the same mocking convention already used by
 * `server/middleware/authorize.test.js` and `server/middleware/auth.test.js`.
 *
 * A second describe block below ("real global mount point") covers the
 * BUG-010 regression directly: it builds the middleware chain the way
 * `server/index.js` actually does at its global mount point (no upstream
 * middleware setting `req.user` manually -- only `cookie-parser`, exactly
 * like the real app), so a request carrying a real `tak_session` cookie
 * for a user without a current signature IS blocked, proving the fix
 * works at the actual production wiring, not just via manual `req.user`
 * injection.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

const mockError = jest.fn();
jest.mock('../config/logger', () => ({
  createLogger: () => ({ error: mockError })
}));

jest.mock('../services/authentikSync', () => ({
  getUserFromCache: jest.fn()
}));

const jwt = require('jsonwebtoken');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pool = require('../config/database');
const authentikSync = require('../services/authentikSync');
const requireCurrentAgreement = require('./requireCurrentAgreement');

const JWT_SECRET = 'a'.repeat(32);

function buildApp({ user } = {}) {
  const app = express();
  app.use((req, res, next) => {
    if (user) {
      req.user = user;
    }
    next();
  });
  app.use(requireCurrentAgreement);
  app.get('/api/some/protected/route', (req, res) => res.status(200).json({ ok: true }));
  app.post('/api/mou/:documentId/sign', (req, res) => res.status(200).json({ ok: true }));
  app.post('/api/auth/logout', (req, res) => res.status(200).json({ ok: true }));
  return app;
}

/**
 * Builds an app mirroring the REAL global mount point in
 * `server/index.js`: `cookie-parser` mounted, then
 * `requireCurrentAgreement` mounted directly with NO upstream middleware
 * setting `req.user` -- exactly as production wiring has it (each route's
 * own `authenticateToken` is further down the chain, per-route, and is
 * intentionally NOT mounted here, since the whole point is to prove the
 * gate is enforced even before that per-route middleware would run).
 */
function buildRealGlobalMountApp() {
  const app = express();
  app.use(cookieParser());
  app.use(requireCurrentAgreement);
  app.get('/api/some/protected/route', (req, res) => res.status(200).json({ ok: true }));
  app.post('/api/mou/:documentId/sign', (req, res) => res.status(200).json({ ok: true }));
  app.post('/api/auth/logout', (req, res) => res.status(200).json({ ok: true }));
  return app;
}

function signSessionCookie(payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
  return `tak_session=${token}`;
}

describe('requireCurrentAgreement (Requirement 28 Criteria 6-7)', () => {
  let originalJwtSecret;

  beforeAll(() => {
    originalJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalJwtSecret;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes through when no current serverwide agreement exists', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const app = buildApp({ user: { userId: 1 } });
    const res = await request(app).get('/api/some/protected/route');

    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toMatch(/is_current_agreement = true AND team_id IS NULL/);
  });

  it('passes through when a current agreement exists and the user has signed that exact version', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] });

    const app = buildApp({ user: { userId: 1 } });
    const res = await request(app).get('/api/some/protected/route');

    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1][1]).toEqual([42, 1]);
  });

  it('blocks with 403 {error, requiresSignature: true, documentId} when the user has NOT signed the current version', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })
      .mockResolvedValueOnce({ rows: [] });

    const app = buildApp({ user: { userId: 1 } });
    const res = await request(app).get('/api/some/protected/route');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: expect.any(String),
      requiresSignature: true,
      documentId: 42
    });
  });

  it('always passes through the signature-submission bypass route, without querying, even if unsigned', async () => {
    const app = buildApp({ user: { userId: 1 } });
    const res = await request(app).post('/api/mou/42/sign');

    expect(res.status).toBe(200);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('always passes through the logout bypass route, without querying, even if unsigned', async () => {
    const app = buildApp({ user: { userId: 1 } });
    const res = await request(app).post('/api/auth/logout');

    expect(res.status).toBe(200);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('skips/passes through an unauthenticated request (no req.user), without querying', async () => {
    const app = buildApp({});
    const res = await request(app).get('/api/some/protected/route');

    expect(res.status).toBe(200);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('fails closed with 403 when the database query throws', async () => {
    pool.query.mockRejectedValueOnce(new Error('db connection lost'));

    const app = buildApp({ user: { userId: 1 } });
    const res = await request(app).get('/api/some/protected/route');

    expect(res.status).toBe(403);
    expect(mockError).toHaveBeenCalledTimes(1);
  });
});

/**
 * BUG-010 regression coverage: proves the gate is actually enforced at
 * the REAL global mount point (no manual `req.user` injection -- only
 * `cookie-parser`, matching `server/index.js`'s actual middleware order),
 * by resolving the user itself from a real, signed `tak_session` cookie
 * via `resolveUserFromRequest` (`server/middleware/auth.js`), the same
 * helper `authenticateToken` uses.
 */
describe('requireCurrentAgreement mounted at the real global mount point (BUG-010 regression)', () => {
  let originalJwtSecret;

  beforeAll(() => {
    originalJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalJwtSecret;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks a logged-in user (real session cookie, no req.user pre-set) with 403 when they have not signed the current agreement', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }] }) // current agreement lookup
      .mockResolvedValueOnce({ rows: [] }); // no matching signature
    authentikSync.getUserFromCache.mockResolvedValueOnce({
      id: 7,
      authentik_id: 'auth-7',
      username: 'bob',
      email: 'bob@example.com',
      first_name: 'Bob',
      last_name: 'Example',
      is_admin: false,
      groups: []
    });

    const app = buildRealGlobalMountApp();
    const res = await request(app)
      .get('/api/some/protected/route')
      .set('Cookie', [signSessionCookie({ username: 'bob' })]);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: expect.any(String),
      requiresSignature: true,
      documentId: 99
    });
  });

  it('passes through a logged-in user (real session cookie) who has already signed the current agreement', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] });
    authentikSync.getUserFromCache.mockResolvedValueOnce({
      id: 7,
      authentik_id: 'auth-7',
      username: 'bob',
      email: 'bob@example.com',
      first_name: 'Bob',
      last_name: 'Example',
      is_admin: false,
      groups: []
    });

    const app = buildRealGlobalMountApp();
    const res = await request(app)
      .get('/api/some/protected/route')
      .set('Cookie', [signSessionCookie({ username: 'bob' })]);

    expect(res.status).toBe(200);
  });

  it('passes through a request with no session cookie at all, without querying the database, deferring to authenticateToken', async () => {
    const app = buildRealGlobalMountApp();
    const res = await request(app).get('/api/some/protected/route');

    expect(res.status).toBe(200);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('passes through a request with an invalid/expired session cookie, without querying the database', async () => {
    const expiredToken = jwt.sign({ username: 'bob' }, JWT_SECRET, { expiresIn: '-1h' });

    const app = buildRealGlobalMountApp();
    const res = await request(app)
      .get('/api/some/protected/route')
      .set('Cookie', [`tak_session=${expiredToken}`]);

    expect(res.status).toBe(200);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('still allows the bypass routes (sign/logout) through for a logged-in unsigned user, without resolving the user or querying', async () => {
    const app = buildRealGlobalMountApp();
    const res = await request(app)
      .post('/api/mou/42/sign')
      .set('Cookie', [signSessionCookie({ username: 'bob' })]);

    expect(res.status).toBe(200);
    expect(pool.query).not.toHaveBeenCalled();
    expect(authentikSync.getUserFromCache).not.toHaveBeenCalled();
  });
});
