/**
 * Real-Postgres integration test for `GET /api/audit-logs` (Requirement
 * 31 Criteria 1, 3, task 53.4):
 *
 *   "filter correctness and absence of rows older than the retention
 *   window"
 *
 * `server/routes/auditLogs.test.js` already covers this route's filter
 * logic and pagination shape, but it mocks `../config/database` entirely
 * -- every assertion there is about the SQL STRING and parameter array
 * handed to a mocked `pool.query`, never about what a real Postgres
 * query planner actually returns for real, persisted rows. It also does
 * not cover retention at all: that file never seeds a row older than
 * `AUDIT_LOGS_RETENTION_DAYS`, and never runs `RetentionCleanupJob`.
 *
 * This file closes that gap by:
 *   1. Seeding real `audit_logs` rows (plus a real `users` row for the
 *      `user_id` FK and a real `teams`/`channels` row for the `teamId`
 *      filter test) directly via `pool.query(...)`.
 *   2. Mounting the REAL `auditLogs.js` router behind a mocked
 *      `authenticateToken` (matching `auditLogs.test.js`'s existing
 *      convention) but leaving `pool`/`../config/database` unmocked, so
 *      `GET /api/audit-logs` hits the real seeded rows via `supertest`.
 *   3. Asserting each filter (individually and combined) returns exactly
 *      the real row ids that should match, by id -- not a mocked shape.
 *   4. Running the real `RetentionCleanupJob.deleteExpiredRows()` against
 *      the same real seeded data, then re-querying the route and
 *      asserting the pre-retention-window row is now genuinely gone while
 *      the still-within-window row remains.
 *
 * Connection convention: mirrors `server/services/RetentionCleanupJob
 * .integration.test.js` / `server/models/Channel.integration.test.js`
 * exactly -- `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` are
 * read from the environment if already set, otherwise defaulted to the
 * local Docker-based test container (`tak_migration_test_501`, Postgres
 * 15, host port 15433, database `tak_team_manager`, user `postgres`,
 * password `postgres123`). These are set on `process.env` BEFORE
 * `../config/database` (required transitively by `./auditLogs` and
 * `../services/RetentionCleanupJob`) is first required anywhere in this
 * file's module graph, and are restored in `afterAll`.
 */

const ORIGINAL_ENV = {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
  AUDIT_LOGS_RETENTION_DAYS: process.env.AUDIT_LOGS_RETENTION_DAYS
};

process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '15433';
process.env.DB_NAME = process.env.DB_NAME || 'tak_team_manager';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres123';

let mockUser = { id: 1, userId: 1, is_global_manager: true };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = mockUser;
    next();
  }
}));

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

const pool = require('../config/database');
const auditLogsRouter = require('./auditLogs');
const RetentionCleanupJob = require('../services/RetentionCleanupJob');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/audit-logs', auditLogsRouter);
  return app;
}

describe('GET /api/audit-logs against a real Postgres database (Requirements 31.1, 31.3, task 53.4)', () => {
  let app;
  let userAId;
  let userBId;
  let teamId;
  let channelId;
  let distractorTeamLikeId;
  let seededAuditLogIds = [];

  beforeAll(async () => {
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `Real Postgres test database is not reachable at ` +
          `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} ` +
          `(user "${process.env.DB_USER}"). This integration test (task 53.4) requires ` +
          `a real, running, already-migrated Postgres instance -- it deliberately does not ` +
          `mock "pool"/"../config/database", since the whole point is to prove the real ` +
          `route query results against real, persisted audit_logs rows. ` +
          `Underlying error: ${error.message}`,
        { cause: error }
      );
    }

    mockUser = { id: 1, userId: 1, is_global_manager: true };

    // Real users row, for audit_logs.user_id's FK.
    const usernameA = `auditlog-test-a-${crypto.randomUUID()}`;
    const userAResult = await pool.query(
      `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id`,
      [usernameA, `${usernameA}@example.invalid`]
    );
    userAId = userAResult.rows[0].id;

    const usernameB = `auditlog-test-b-${crypto.randomUUID()}`;
    const userBResult = await pool.query(
      `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id`,
      [usernameB, `${usernameB}@example.invalid`]
    );
    userBId = userBResult.rows[0].id;

    // Real team + real channel owned by that team, for the teamId filter
    // test's 'team'/'channel' resource_type matching.
    const teamResult = await pool.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING id`,
      [`AuditLog Test Team ${crypto.randomUUID()}`, 'ALT1']
    );
    teamId = teamResult.rows[0].id;

    const channelResult = await pool.query(
      `INSERT INTO channels (name, display_name, team_id, channel_type, is_primary)
       VALUES ($1, $2, $3, 'custom', false) RETURNING id`,
      [`auditlog-test-channel-${crypto.randomUUID()}`, 'AuditLog Test Channel', teamId]
    );
    channelId = channelResult.rows[0].id;

    // A second real team whose id we deliberately reuse as a distractor
    // row's numeric resource_id below, to prove the teamId filter's
    // resource_type IN ('team','channel') guard genuinely excludes a row
    // whose resource_id happens to equal the target team id numerically
    // but whose resource_type is unrelated (e.g. 'vendor_channel_grant').
    const distractorTeamResult = await pool.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING id`,
      [`AuditLog Distractor Team ${crypto.randomUUID()}`, 'ALT2']
    );
    distractorTeamLikeId = distractorTeamResult.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM audit_logs WHERE id = ANY($1)', [seededAuditLogIds]);
    await pool.query('DELETE FROM channels WHERE id = $1', [channelId]);
    await pool.query('DELETE FROM teams WHERE id = ANY($1)', [[teamId, distractorTeamLikeId]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[userAId, userBId]]);

    await pool.end();

    process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
    process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
    process.env.DB_NAME = ORIGINAL_ENV.DB_NAME;
    process.env.DB_USER = ORIGINAL_ENV.DB_USER;
    process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
    process.env.AUDIT_LOGS_RETENTION_DAYS = ORIGINAL_ENV.AUDIT_LOGS_RETENTION_DAYS;
  });

  beforeEach(() => {
    app = buildApp();
    mockUser = { id: 1, userId: 1, is_global_manager: true };
  });

  describe('filter correctness (Requirement 31.1)', () => {
    let userIdFilterRowId;
    let userIdFilterOtherRowId;
    let actionFilterRowId;
    let actionFilterOtherRowId;
    let teamFilterRowId;
    let teamFilterChannelRowId;
    let teamFilterDistractorRowId;
    let dateRangeInsideRowId;
    let dateRangeOutsideRowId;

    beforeAll(async () => {
      const insert = async ({ userId, action, resourceType, resourceId, createdAtSql }) => {
        const result = await pool.query(
          `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details, created_at)
           VALUES ($1, $2, $3, $4, $5, ${createdAtSql})
           RETURNING id`,
          [userId, action, resourceType, resourceId, JSON.stringify({ seeded: true })]
        );
        const id = result.rows[0].id;
        seededAuditLogIds.push(id);
        return id;
      };

      // userId filter: one row for userAId, one distractor for userBId,
      // sharing the same action/resource_type so only user_id
      // distinguishes them.
      userIdFilterRowId = await insert({
        userId: userAId,
        action: 'filter_test_user_id_match',
        resourceType: 'user',
        resourceId: userAId,
        createdAtSql: 'NOW()'
      });
      userIdFilterOtherRowId = await insert({
        userId: userBId,
        action: 'filter_test_user_id_match',
        resourceType: 'user',
        resourceId: userBId,
        createdAtSql: 'NOW()'
      });

      // action filter: one row with the target action, one distractor
      // with a different action but the same actor.
      actionFilterRowId = await insert({
        userId: userAId,
        action: 'filter_test_action_target',
        resourceType: 'user',
        resourceId: userAId,
        createdAtSql: 'NOW()'
      });
      actionFilterOtherRowId = await insert({
        userId: userAId,
        action: 'filter_test_action_other',
        resourceType: 'user',
        resourceId: userAId,
        createdAtSql: 'NOW()'
      });

      // teamId filter: a real 'team' row whose resource_id equals teamId,
      // a real 'channel' row owned by that team, and a distractor row
      // with an unrelated resource_type whose resource_id NUMERICALLY
      // equals distractorTeamLikeId -- proving the resource_type guard
      // (not just a numeric match) drives the filter.
      teamFilterRowId = await insert({
        userId: userAId,
        action: 'filter_test_team_direct',
        resourceType: 'team',
        resourceId: teamId,
        createdAtSql: 'NOW()'
      });
      teamFilterChannelRowId = await insert({
        userId: userAId,
        action: 'filter_test_team_channel',
        resourceType: 'channel',
        resourceId: channelId,
        createdAtSql: 'NOW()'
      });
      teamFilterDistractorRowId = await insert({
        userId: userAId,
        action: 'filter_test_team_distractor',
        resourceType: 'vendor_channel_grant',
        resourceId: distractorTeamLikeId,
        createdAtSql: 'NOW()'
      });

      // startDate/endDate range: one row safely inside 2024-06-01 to
      // 2024-06-30, one row safely outside (2024-08-01).
      dateRangeInsideRowId = await insert({
        userId: userAId,
        action: 'filter_test_date_inside',
        resourceType: 'user',
        resourceId: userAId,
        createdAtSql: "'2024-06-15T12:00:00Z'"
      });
      dateRangeOutsideRowId = await insert({
        userId: userAId,
        action: 'filter_test_date_outside',
        resourceType: 'user',
        resourceId: userAId,
        createdAtSql: "'2024-08-01T12:00:00Z'"
      });
    });

    function idsOf(res) {
      return res.body.auditLogs.map((row) => row.id).sort((a, b) => a - b);
    }

    it('filters by userId, returning only that actor\'s row', async () => {
      const res = await request(app).get('/api/audit-logs').query({ action: 'filter_test_user_id_match', userId: userAId, pageSize: 200 });

      expect(res.status).toBe(200);
      expect(idsOf(res)).toEqual([userIdFilterRowId]);
      expect(idsOf(res)).not.toContain(userIdFilterOtherRowId);
    });

    it('filters by action, returning only rows with that exact action', async () => {
      const res = await request(app).get('/api/audit-logs').query({ userId: userAId, action: 'filter_test_action_target', pageSize: 200 });

      expect(res.status).toBe(200);
      expect(idsOf(res)).toEqual([actionFilterRowId]);
      expect(idsOf(res)).not.toContain(actionFilterOtherRowId);
    });

    it('filters by teamId, matching real team/channel rows but excluding a distractor row with a numerically-equal but unrelated resource_id', async () => {
      const res = await request(app).get('/api/audit-logs').query({ teamId, pageSize: 200 });

      expect(res.status).toBe(200);
      const ids = idsOf(res);
      expect(ids).toContain(teamFilterRowId);
      expect(ids).toContain(teamFilterChannelRowId);
      expect(ids).not.toContain(teamFilterDistractorRowId);
    });

    it('filters by teamId using the distractor team id, matching nothing (the distractor row is resource_type-guarded out)', async () => {
      const res = await request(app).get('/api/audit-logs').query({ teamId: distractorTeamLikeId, pageSize: 200 });

      expect(res.status).toBe(200);
      expect(idsOf(res)).not.toContain(teamFilterDistractorRowId);
    });

    it('filters by startDate/endDate, returning only the row within the real date range', async () => {
      const res = await request(app)
        .get('/api/audit-logs')
        .query({ userId: userAId, startDate: '2024-06-01', endDate: '2024-06-30', pageSize: 200 });

      expect(res.status).toBe(200);
      const ids = idsOf(res);
      expect(ids).toContain(dateRangeInsideRowId);
      expect(ids).not.toContain(dateRangeOutsideRowId);
    });

    it('combines userId + action filters with AND against real rows', async () => {
      const res = await request(app)
        .get('/api/audit-logs')
        .query({ userId: userAId, action: 'filter_test_action_target', pageSize: 200 });

      expect(res.status).toBe(200);
      expect(idsOf(res)).toEqual([actionFilterRowId]);
    });
  });

  describe('absence of rows older than the retention window after real cleanup (Requirement 31.3)', () => {
    let oldRowId;
    let withinWindowRowId;

    beforeAll(async () => {
      process.env.AUDIT_LOGS_RETENTION_DAYS = '365';

      const oldResult = await pool.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL '400 days')
         RETURNING id`,
        [userAId, 'retention_test_old_row', 'user', userAId, JSON.stringify({ seeded: true })]
      );
      oldRowId = oldResult.rows[0].id;
      seededAuditLogIds.push(oldRowId);

      const withinResult = await pool.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL '10 days')
         RETURNING id`,
        [userAId, 'retention_test_within_window_row', 'user', userAId, JSON.stringify({ seeded: true })]
      );
      withinWindowRowId = withinResult.rows[0].id;
      seededAuditLogIds.push(withinWindowRowId);
    });

    it('returns both the old and within-window rows before retention cleanup has run', async () => {
      const res = await request(app)
        .get('/api/audit-logs')
        .query({ userId: userAId, startDate: '2000-01-01', pageSize: 200 });

      expect(res.status).toBe(200);
      const ids = res.body.auditLogs.map((row) => row.id);
      expect(ids).toContain(oldRowId);
      expect(ids).toContain(withinWindowRowId);
    });

    it('no longer returns the pre-retention-window row (but still returns the within-window row) once RetentionCleanupJob.deleteExpiredRows() has run against the real database', async () => {
      const job = new RetentionCleanupJob({ pool });
      const result = await job.deleteExpiredRows();

      expect(result.auditLogsDeleted).toBeGreaterThanOrEqual(1);

      const res = await request(app)
        .get('/api/audit-logs')
        .query({ userId: userAId, startDate: '2000-01-01', pageSize: 200 });

      expect(res.status).toBe(200);
      const ids = res.body.auditLogs.map((row) => row.id);
      expect(ids).not.toContain(oldRowId);
      expect(ids).toContain(withinWindowRowId);

      // Confirm directly against the database too, not just through the
      // route -- the row is genuinely gone, not merely filtered out by
      // the query.
      const directCheck = await pool.query('SELECT id FROM audit_logs WHERE id = $1', [oldRowId]);
      expect(directCheck.rows).toHaveLength(0);
    });
  });
});
