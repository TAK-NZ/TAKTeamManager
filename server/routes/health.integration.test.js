/**
 * Real-Postgres integration tests for `GET /health`, `GET /health/ready`,
 * and `GET /health/live` (task 34.5, Requirements 14.1-14.5).
 *
 * `server/routes/health.test.js` exercises the routes' branching logic
 * entirely against a `jest.mock('../config/database')`'d pool and a
 * `jest.mock('axios')`'d Authentik call -- valuable for testing response
 * shape/status-code behavior in isolation, but it never proves the routes
 * work against a REAL, reachable Postgres connection, nor that a REAL
 * (not mocked) connection failure is correctly surfaced as 503
 * unhealthy/not_ready. This file fills that gap and does NOT modify or
 * duplicate anything in `health.test.js`.
 *
 * Connection convention: mirrors
 * `server/workers/syncWorker.integration.test.js` exactly --
 * `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` are read from the
 * environment if already set (e.g. a CI job with its own test database),
 * otherwise defaulted to the local Docker test container used during
 * development of this task (`tak_migration_test_501`, Postgres 15, host
 * port 15433, database `tak_team_manager`, user `postgres`, password
 * `postgres123`).
 *
 * Only Postgres connectivity is real in this file. The Authentik
 * reachability check (`GET /health/ready`'s second dependency) still
 * mocks `axios`, since there is no real Authentik instance available in
 * this test environment and Requirements 14.3/14.4 are about the App's
 * own timeout/response-shape behavior per dependency, not about proving
 * a real Authentik deployment is reachable. The "mocked-unreachable DB"
 * case required by this task is achieved here by pointing a REAL
 * `pg.Pool` at a closed local port -- a genuine TCP-level connection
 * failure -- rather than by mocking `pool.query()` to reject; that
 * mocked-rejection case is already covered by `health.test.js`.
 *
 * No production code is modified to support this: `server/config/
 * database.js` already builds its `pg.Pool` from `DB_HOST`/`DB_PORT`/
 * `DB_NAME`/`DB_USER`/`DB_PASSWORD` read at require time, so pointing the
 * health routes at a different (real, reachable or real, unreachable)
 * database only requires setting those env vars before freshly requiring
 * `./health` (which requires `../config/database`) via
 * `jest.resetModules()` -- the same technique already used by
 * `server/config/database.test.js` and `server/config/
 * configValidator.test.js` for env-driven module reconfiguration.
 */

const express = require('express');
const request = require('supertest');

jest.mock('axios');

const ORIGINAL_ENV = {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
  AUTHENTIK_URL: process.env.AUTHENTIK_URL,
  AUTHENTIK_ADMIN_TOKEN: process.env.AUTHENTIK_ADMIN_TOKEN
};

function restoreEnv() {
  process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
  process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
  process.env.DB_NAME = ORIGINAL_ENV.DB_NAME;
  process.env.DB_USER = ORIGINAL_ENV.DB_USER;
  process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
  process.env.AUTHENTIK_URL = ORIGINAL_ENV.AUTHENTIK_URL;
  process.env.AUTHENTIK_ADMIN_TOKEN = ORIGINAL_ENV.AUTHENTIK_ADMIN_TOKEN;
}

function buildApp(healthRouter) {
  const app = express();
  app.use('/health', healthRouter);
  return app;
}

describe('Health endpoints against a real, reachable test database (task 34.5)', () => {
  let pool;
  let app;
  let axiosMock;

  beforeAll(async () => {
    jest.resetModules();

    process.env.DB_HOST = process.env.DB_HOST || 'localhost';
    process.env.DB_PORT = process.env.DB_PORT || '15433';
    process.env.DB_NAME = process.env.DB_NAME || 'tak_team_manager';
    process.env.DB_USER = process.env.DB_USER || 'postgres';
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres123';
    process.env.AUTHENTIK_URL = process.env.AUTHENTIK_URL || 'https://authentik.example.com';
    process.env.AUTHENTIK_ADMIN_TOKEN = process.env.AUTHENTIK_ADMIN_TOKEN || 'admin-token-value';

    // Required fresh, AFTER the env vars above are set and AFTER
    // jest.resetModules(), so `../config/database`'s module-level `pool`
    // singleton (required transitively by `./health`) is constructed
    // against THIS describe block's target database.
    axiosMock = require('axios'); // eslint-disable-line global-require
    const healthRouter = require('./health'); // eslint-disable-line global-require
    pool = require('../config/database'); // eslint-disable-line global-require
    app = buildApp(healthRouter);

    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(
        'Real Postgres test database is not reachable at ' +
          `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} ` +
          `(user "${process.env.DB_USER}"). This integration test (task 34.5) requires ` +
          'a real, running, already-migrated Postgres instance -- it deliberately does not ' +
          'mock "../config/database", since the whole point is to exercise a real DB ' +
          `connection. Underlying error: ${error.message}`,
        { cause: error }
      );
    }
  });

  afterAll(async () => {
    await pool.end();
    restoreEnv();
  });

  beforeEach(() => {
    axiosMock.get.mockReset();
    axiosMock.get.mockResolvedValue({ data: { results: [] } });
  });

  it('GET /health returns 200 {status: "healthy"} against the real database', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'healthy' });
  });

  it('GET /health/ready returns 200 {status: "ready"} when the real DB check and the (mocked) Authentik check both succeed', async () => {
    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('GET /health/live returns 200 {status: "alive"}', async () => {
    const res = await request(app).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'alive' });
  });
});

describe('Health endpoints against a real, unreachable database connection (task 34.5)', () => {
  let pool;
  let app;
  let axiosMock;

  beforeAll(() => {
    jest.resetModules();

    // A real `pg.Pool` pointed at a closed local port: attempting to
    // connect produces a genuine TCP-level ECONNREFUSED, not a mocked
    // rejection. Port 1 is real and unassigned in this test environment
    // -- nothing listens on it -- so refusal is near-instant on
    // localhost, keeping this test fast without depending on the health
    // route's own 2s/3s timeouts to be the thing that fires.
    process.env.DB_HOST = '127.0.0.1';
    process.env.DB_PORT = '1';
    process.env.DB_NAME = 'tak_team_manager';
    process.env.DB_USER = 'postgres';
    process.env.DB_PASSWORD = 'postgres123';
    process.env.AUTHENTIK_URL = process.env.AUTHENTIK_URL || 'https://authentik.example.com';
    process.env.AUTHENTIK_ADMIN_TOKEN = process.env.AUTHENTIK_ADMIN_TOKEN || 'admin-token-value';

    axiosMock = require('axios'); // eslint-disable-line global-require
    const healthRouter = require('./health'); // eslint-disable-line global-require
    pool = require('../config/database'); // eslint-disable-line global-require
    app = buildApp(healthRouter);
  });

  afterAll(async () => {
    await pool.end();
    restoreEnv();
  });

  beforeEach(() => {
    // The Authentik check is mocked to succeed so that GET /health/ready's
    // failure below is attributable to the real DB connection failure
    // alone, isolating what this test is actually verifying.
    axiosMock.get.mockReset();
    axiosMock.get.mockResolvedValue({ data: { results: [] } });
  });

  it(
    'GET /health returns 503 {status: "unhealthy", reason} on a real connection failure',
    async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      expect(typeof res.body.reason).toBe('string');
      expect(res.body.reason.length).toBeGreaterThan(0);
    },
    10000
  );

  it(
    'GET /health/ready returns 503 {status: "not_ready", reason} identifying the database on a real connection failure',
    async () => {
      const res = await request(app).get('/health/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not_ready');
      expect(typeof res.body.reason).toBe('string');
      expect(res.body.reason.toLowerCase()).toContain('database');
    },
    10000
  );

  it('GET /health/live returns 200 {status: "alive"} even though the database is unreachable (real connection, not mocked)', async () => {
    const res = await request(app).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'alive' });
  });
});
