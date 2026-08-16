/**
 * Integration tests for `GET /health` and `GET /ready` (Requirement 14.1,
 * 14.2, 14.3, 14.4).
 *
 * Mocks the shared `pool.query` and `axios.get` to exercise both the
 * healthy/ready path (checks resolve within their timeouts) and the
 * unhealthy/not_ready path (a check rejects, or does not resolve within
 * its timeout), asserting the exact response shape and status code
 * required by Requirement 14.1-14.4.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

jest.mock('axios');

const express = require('express');
const request = require('supertest');
const axios = require('axios');
const pool = require('../config/database');
const healthRouter = require('./health');

function buildApp() {
  const app = express();
  app.use('/health', healthRouter);
  return app;
}

describe('GET /health (Requirements 14.1, 14.2)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    app = buildApp();
  });

  it('returns 200 {status: "healthy"} when the SELECT 1 check succeeds', async () => {
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const res = await request(app).get('/health');

    expect(pool.query).toHaveBeenCalledWith('SELECT 1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'healthy' });
  });

  it('returns 503 {status: "unhealthy", reason} when the SELECT 1 check rejects', async () => {
    pool.query.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
    expect(typeof res.body.reason).toBe('string');
    expect(res.body.reason.length).toBeGreaterThan(0);
    // The underlying error message must not be leaked verbatim into the
    // response body.
    expect(res.body.reason).not.toContain('connection terminated unexpectedly');
  });

  it('returns 503 {status: "unhealthy", reason} when the SELECT 1 check does not resolve within the 2-second timeout', async () => {
    // A query promise that never resolves/rejects, so the race is decided
    // by the health route's own 2-second timeout.
    pool.query.mockReturnValue(new Promise(() => {}));

    const res = await request(app).get('/health').timeout(5000);

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
    expect(typeof res.body.reason).toBe('string');
  }, 10000);
});

describe('GET /health/ready (Requirements 14.3, 14.4)', () => {
  let app;
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    process.env = {
      ...ORIGINAL_ENV,
      AUTHENTIK_URL: 'https://authentik.example.com',
      AUTHENTIK_ADMIN_TOKEN: 'admin-token-value'
    };
    app = buildApp();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns 200 {status: "ready"} when both the DB and Authentik checks succeed', async () => {
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    axios.get.mockResolvedValue({ data: { results: [] } });

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('returns 503 {status: "not_ready", reason} when the DB check fails', async () => {
    pool.query.mockRejectedValue(new Error('connection terminated unexpectedly'));
    axios.get.mockResolvedValue({ data: { results: [] } });

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(typeof res.body.reason).toBe('string');
    expect(res.body.reason.toLowerCase()).toContain('database');
    expect(res.body.reason).not.toContain('connection terminated unexpectedly');
  });

  it('returns 503 {status: "not_ready", reason} when the Authentik check fails', async () => {
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    axios.get.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(typeof res.body.reason).toBe('string');
    expect(res.body.reason.toLowerCase()).toContain('authentik');
    expect(res.body.reason).not.toContain('ECONNREFUSED');
  });

  it('returns 503 {status: "not_ready", reason} when the DB check does not resolve within the 3-second timeout', async () => {
    pool.query.mockReturnValue(new Promise(() => {}));
    axios.get.mockResolvedValue({ data: { results: [] } });

    const res = await request(app).get('/health/ready').timeout(6000);

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.reason.toLowerCase()).toContain('database');
  }, 10000);

  it('returns 503 {status: "not_ready", reason} when the Authentik check does not resolve within the 3-second timeout', async () => {
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    axios.get.mockReturnValue(new Promise(() => {}));

    const res = await request(app).get('/health/ready').timeout(6000);

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.reason.toLowerCase()).toContain('authentik');
  }, 10000);

  it('returns 503 {status: "not_ready", reason} identifying both failures when both checks fail', async () => {
    pool.query.mockRejectedValue(new Error('connection terminated unexpectedly'));
    axios.get.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.reason.toLowerCase()).toContain('database');
    expect(res.body.reason.toLowerCase()).toContain('authentik');
  });

  it('runs the DB and Authentik checks concurrently rather than sequentially', async () => {
    pool.query.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ rows: [{ '?column?': 1 }] }), 200))
    );
    axios.get.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ data: { results: [] } }), 200))
    );

    const start = Date.now();
    const res = await request(app).get('/health/ready');
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe(200);
    // If the checks ran sequentially this would take >= 400ms; concurrent
    // execution should complete in roughly one check's duration.
    expect(elapsedMs).toBeLessThan(400);
  });
});

describe('GET /health/live (Requirement 14.5)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    app = buildApp();
  });

  it('returns 200 {status: "alive"} without checking the database', async () => {
    const res = await request(app).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'alive' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns 200 {status: "alive"} without checking Authentik', async () => {
    const res = await request(app).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'alive' });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('returns 200 even when the database is unreachable', async () => {
    pool.query.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const res = await request(app).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'alive' });
  });
});
