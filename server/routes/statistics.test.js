/**
 * Unit tests for GET /api/statistics (server/routes/statistics.js).
 *
 * Global_Manager-only time series backing the Statistics page. These tests
 * mock the DB pool and the auth/authorize middleware (authorization is proven
 * by the permission-registry tests; here we assert the route's own behaviour:
 * window validation, the SQL it issues, and the response shape).
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, userId: 1, is_global_manager: true };
    next();
  }
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

jest.mock('../middleware/requestContext', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() })
}));

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/statistics', require('./statistics'));
  return app;
}

describe('GET /api/statistics', () => {
  let app;
  const ORIGINAL_TZ = process.env.DISPLAY_TIMEZONE;
  const ORIGINAL_IGNORED = process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DISPLAY_TIMEZONE = 'Pacific/Auckland';
    delete process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;
    app = buildApp();
  });

  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.DISPLAY_TIMEZONE;
    else process.env.DISPLAY_TIMEZONE = ORIGINAL_TZ;
    if (ORIGINAL_IGNORED === undefined) delete process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;
    else process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES = ORIGINAL_IGNORED;
  });

  it('defaults to an 8-day window when no window param is given, and passes it as the series bound', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/statistics');

    expect(res.status).toBe(200);
    expect(res.body.window).toBe(8);
    const [, params] = pool.query.mock.calls[0];
    expect(params[0]).toBe(8); // the day-series bound
    expect(params[1]).toBe('Pacific/Auckland'); // the display timezone literal
  });

  it.each([30, 90, 365])('accepts the allowed window %i', async (windowDays) => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/statistics').query({ window: windowDays });

    expect(res.status).toBe(200);
    expect(res.body.window).toBe(windowDays);
    expect(pool.query.mock.calls[0][1][0]).toBe(windowDays);
  });

  it('rejects an out-of-allow-list window with 400 and never runs the query', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/statistics').query({ window: 45 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid window/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a non-integer window with 400 (validator) before the query', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/statistics').query({ window: 'lots' });

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('maps each row to the series shape, preserving null totals (no snapshot) rather than coercing to 0', async () => {
    pool.query.mockResolvedValue({
      rows: [
        {
          day: '2026-03-10',
          dau_users: 5,
          dau_team_devices: 2,
          total_users: 100,
          total_teams: 12,
          total_team_devices: 7,
          total_channels: 42
        },
        {
          // A pre-capture day: DAU is a real 0 (COALESCEd in SQL), but the
          // snapshot totals are null and must STAY null (a gap), not become 0.
          day: '2026-03-11',
          dau_users: 0,
          dau_team_devices: 0,
          total_users: null,
          total_teams: null,
          total_team_devices: null,
          total_channels: null
        }
      ]
    });

    const res = await request(app).get('/api/statistics').query({ window: 8 });

    expect(res.status).toBe(200);
    expect(res.body.series).toEqual([
      { day: '2026-03-10', dau_users: 5, dau_team_devices: 2, total_users: 100, total_teams: 12, total_team_devices: 7, total_channels: 42 },
      { day: '2026-03-11', dau_users: 0, dau_team_devices: 0, total_users: null, total_teams: null, total_team_devices: null, total_channels: null }
    ]);
  });

  it('builds escaped ignored-prefix LIKE patterns from AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES for the DAU users filter', async () => {
    process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES = 'etl-,ak-';
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/statistics').query({ window: 8 });

    const [, params] = pool.query.mock.calls[0];
    // $3 is the escaped prefix patterns array.
    expect(params[2]).toEqual(['etl-%', 'ak-%']);
  });

  it('sends an empty prefix array (so LIKE ANY matches nothing) when no prefixes are configured', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/statistics').query({ window: 8 });

    expect(pool.query.mock.calls[0][1][2]).toEqual([]);
  });

  it('returns 500 without throwing when the query fails', async () => {
    pool.query.mockRejectedValue(new Error('db down'));

    const res = await request(app).get('/api/statistics').query({ window: 30 });

    expect(res.status).toBe(500);
  });

  it('the DAU query splits on is_team_device and reads the snapshot totals from daily_stats', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/statistics').query({ window: 30 });

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('device_daily_activity');
    expect(sql).toContain('JOIN tak_devices');
    expect(sql).toContain('JOIN users');
    expect(sql).toContain('is_team_device = false'); // users bucket
    expect(sql).toContain('is_team_device = true');  // team-devices bucket
    expect(sql).toContain('LEFT JOIN daily_stats');
    // Distinct users so a user with several devices active the same day counts once.
    expect(sql).toContain('COUNT(DISTINCT u.id)');
  });
});
