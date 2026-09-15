/**
 * Unit tests for DailyStatsSnapshotJob (server/services/DailyStatsSnapshotJob.js).
 *
 * The job upserts one `daily_stats` row per day capturing the four /admin
 * totals. These tests mock the pool (via a lock-granting client so
 * withJobLock runs the body) and assert the captureToday() upsert uses the
 * EXACT /admin count definitions and the display-timezone day, plus the
 * start/stop lifecycle.
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

// A client that GRANTS the advisory lock, so withJobLock runs its body.
function lockGrantingClient() {
  return {
    query: jest.fn(async (sql) => {
      if (typeof sql === 'string' && sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ locked: true }] };
      }
      return { rows: [] };
    }),
    release: jest.fn()
  };
}

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const DailyStatsSnapshotJob = require('./DailyStatsSnapshotJob');

describe('DailyStatsSnapshotJob.captureToday', () => {
  let job;
  const ORIGINAL_TZ = process.env.DISPLAY_TIMEZONE;
  const ORIGINAL_IGNORED = process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DISPLAY_TIMEZONE = 'Pacific/Auckland';
    delete process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;
    pool.query.mockResolvedValue({
      rows: [{ day: '2026-03-10', total_users: 100, total_teams: 12, total_team_devices: 7, total_channels: 42 }]
    });
    job = new DailyStatsSnapshotJob({ pool });
  });

  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.DISPLAY_TIMEZONE;
    else process.env.DISPLAY_TIMEZONE = ORIGINAL_TZ;
    if (ORIGINAL_IGNORED === undefined) delete process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;
    else process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES = ORIGINAL_IGNORED;
  });

  it('upserts today (display-timezone) with the EXACT /admin count definitions', async () => {
    await job.captureToday();

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];

    // day = today in the display timezone
    expect(sql).toContain("(now() AT TIME ZONE $2)::date");
    expect(params[1]).toBe('Pacific/Auckland');

    // total_users: /admin users/count definition (excl team devices, orphaned,
    // and ignored-prefix usernames via LIKE ANY).
    expect(sql).toContain('FROM users');
    expect(sql).toContain('is_team_device = false');
    expect(sql).toContain("account_status <> 'orphaned'");
    expect(sql).toContain('NOT (username LIKE ANY($1::text[]))');

    // total_teams / total_team_devices / total_channels: the /admin defs.
    expect(sql).toContain('FROM teams');
    expect(sql).toContain('FROM users WHERE is_team_device = true');
    expect(sql).toContain('FROM channels');
    expect(sql).toContain('FROM bch_channels');
    expect(sql).toContain('FROM region_channels');

    // Idempotent upsert on day.
    expect(sql).toContain('ON CONFLICT (day) DO UPDATE');
  });

  it('passes escaped ignored-prefix patterns (matching /admin users/count), empty when none configured', async () => {
    await job.captureToday();
    expect(pool.query.mock.calls[0][1][0]).toEqual([]);

    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [{}] });
    process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES = 'etl-,ak-';

    await job.captureToday();
    expect(pool.query.mock.calls[0][1][0]).toEqual(['etl-%', 'ak-%']);
  });

  it('returns the captured counts from the upsert RETURNING row', async () => {
    const result = await job.captureToday();
    expect(result).toEqual({
      day: '2026-03-10',
      totalUsers: 100,
      totalTeams: 12,
      totalTeamDevices: 7,
      totalChannels: 42
    });
  });
});

describe('DailyStatsSnapshotJob lifecycle', () => {
  let job;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [{}] });
    pool.connect.mockImplementation(async () => lockGrantingClient());
    job = new DailyStatsSnapshotJob({ pool });
  });

  afterEach(() => {
    job.stop();
    jest.useRealTimers();
  });

  it('runs one snapshot immediately on start, then on the interval', () => {
    jest.useFakeTimers();
    const runSpy = jest.spyOn(job, 'runSnapshot');

    job.start();
    expect(runSpy).toHaveBeenCalledTimes(1); // immediate first run

    jest.advanceTimersByTime(job.intervalMs);
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it('start() is idempotent (a second start does not add a second timer)', () => {
    jest.useFakeTimers();
    job.start();
    const timer = job.timer;
    job.start();
    expect(job.timer).toBe(timer);
  });

  it('runSnapshot never throws even if the capture query fails', async () => {
    pool.connect.mockImplementation(async () => lockGrantingClient());
    pool.query.mockRejectedValue(new Error('db down'));

    await expect(job.runSnapshot()).resolves.toBeUndefined();
    expect(mockLoggerInstance.error).toHaveBeenCalled();
  });
});
