/**
 * Unit tests for `requireCurrentAgreement` (Requirement 28 Criteria 6-7,
 * task 50.4).
 *
 * Covers:
 *   - No current serverwide agreement exists: passes through.
 *   - A current agreement exists and the user has signed that exact
 *     document version: passes through.
 *   - A current agreement exists and the user has NOT signed it: blocked
 *     with 403 `{error, requiresSignature: true, documentId}`.
 *   - The signature-submission and logout bypass routes always pass
 *     through, regardless of signature status (no query even runs).
 *   - An unauthenticated request (no `req.user`) is skipped/passed
 *     through without querying the database.
 *
 * `server/config/database` is mocked (`pool.query`) so each case can
 * control exactly what the current-agreement lookup and signature lookup
 * return, following the same mocking convention already used by
 * `server/middleware/authorize.test.js` and `server/middleware/auth.test.js`.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

const mockError = jest.fn();
jest.mock('../config/logger', () => ({
  createLogger: () => ({ error: mockError })
}));

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const requireCurrentAgreement = require('./requireCurrentAgreement');

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

describe('requireCurrentAgreement (Requirement 28 Criteria 6-7)', () => {
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
