/**
 * Real-Postgres integration tests for team creation and team membership
 * add (BUG-020 / task 58.6, Requirement 12.5):
 *
 *   "Integration tests ... for at least the following API routes: team
 *   creation (a success case and a validation-failure case), team
 *   membership add/remove (a success case and a case where the target
 *   user or team does not exist) ... using supertest."
 *
 * `server/routes/teams.test.js` already exists but only covers
 * `GET /api/teams/my-teams`'s pagination behavior against a fully mocked
 * `Team` model / `pool`. It does NOT exercise `POST /api/teams` or
 * `POST /api/teams/:teamId/members` at all, and never touches a real
 * database. This file closes that gap for those two routes, following
 * the exact real-Postgres connection/env-var convention already
 * established by `server/services/TeamMembershipService.integration
 * .test.js`, `server/routes/health.integration.test.js`, and
 * `server/routes/auditLogs.integration.test.js`.
 *
 * DB-vs-mock decision: this file uses a REAL Postgres database rather
 * than a mocked pool, per the task's explicit instruction. Team creation
 * involves multiple real INSERTs (the `teams` row, plus the auto-created
 * primary `channels` row via `Team.createTeamChannel`) and real
 * authorization decisions (`authorize.js`'s row-scoped
 * `team:create:root_or_sub`/`team:members:add` resolvers, which call the
 * REAL `Team.isAdmin` against real `team_memberships` rows) -- a mocked
 * pool could only assert on the SQL strings issued, not prove the actual
 * persisted end state or the real authorization decision.
 *
 * Mocking scope: ONLY `authenticateToken` (from `../middleware/auth`) is
 * mocked, to bypass real JWT/cookie handling and inject a `req.user`
 * object directly -- exactly the same narrow-mocking convention already
 * used by `server/routes/auditLogs.integration.test.js`. `requireTeamAdmin`
 * (also exported by `../middleware/auth`) is intentionally left as the
 * REAL implementation via `jest.requireActual`, since one of the
 * "membership add" test cases below specifically exercises its real,
 * DB-backed `Team.isAdmin` check. `authorize.js` itself is never mocked,
 * so the real Permission_Registry/row-scoped-resolver authorization
 * logic (including the real 403 paths) is exercised end-to-end.
 *
 * `AUTHENTIK_URL` is deliberately pointed at an unreachable local address
 * (`http://127.0.0.1:1`) rather than mocked or pointed at a real
 * Authentik instance: `Team.create` -> `Team.createTeamChannel` attempts
 * a real `fetch()` call to create an Authentik group for the team's
 * primary channel, but that call is already wrapped in its own
 * `try/catch` in application code (see `Team.createTeamChannel`'s inner
 * `catch (authentikError)` block) that falls back to creating the
 * channel row WITHOUT an Authentik group id on any fetch failure. `fetch`
 * against a closed local port fails fast (immediate ECONNREFUSED) rather
 * than waiting on a real network round trip, keeping this test fast
 * without requiring a real, reachable Authentik instance -- mirroring
 * `health.integration.test.js`'s "real, unreachable database connection"
 * technique (pointing at a real-but-refusing endpoint rather than mocking
 * the call).
 *
 * Connection convention: mirrors `server/services/TeamMembershipService
 * .integration.test.js` exactly -- `DB_HOST`/`DB_PORT`/`DB_NAME`/
 * `DB_USER`/`DB_PASSWORD` are read from the environment if already set,
 * otherwise defaulted to the local Docker-based test container
 * (`tak_migration_test_501`, Postgres 15, host port 15433, database
 * `tak_team_manager`, user `postgres`, password `postgres123`). These,
 * plus `AUTHENTIK_URL`/`AUTHENTIK_API_TOKEN`, are set on `process.env`
 * BEFORE `../config/database` (required transitively by `./teams` and
 * `../middleware/authorize`) is first required anywhere in this file's
 * module graph, and are restored in `afterAll`.
 */

const ORIGINAL_ENV = {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
  AUTHENTIK_URL: process.env.AUTHENTIK_URL,
  AUTHENTIK_API_TOKEN: process.env.AUTHENTIK_API_TOKEN
};

process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '15433';
process.env.DB_NAME = process.env.DB_NAME || 'tak_team_manager';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres123';
// Real-but-refusing endpoint (see file-level comment above) rather than a
// mocked fetch: keeps Team.createTeamChannel's Authentik call fast-failing
// without depending on a real, reachable Authentik instance.
process.env.AUTHENTIK_URL = 'http://127.0.0.1:1';
process.env.AUTHENTIK_API_TOKEN = 'test-admin-token';

let mockUser = { id: 1, userId: 1, is_global_manager: true };

jest.mock('../middleware/auth', () => {
  const actual = jest.requireActual('../middleware/auth');
  return {
    // Bypasses real JWT/cookie handling; injects req.user directly.
    authenticateToken: (req, res, next) => {
      req.user = mockUser;
      next();
    },
    // Left as the REAL implementation -- one of the tests below
    // specifically exercises its real, DB-backed Team.isAdmin check.
    requireTeamAdmin: actual.requireTeamAdmin
  };
});

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

const pool = require('../config/database');
const teamsRouter = require('./teams');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/teams', teamsRouter);
  return app;
}

describe('POST /api/teams against a real Postgres database (Requirement 12.5, task 58.6)', () => {
  let app;
  const createdTeamIds = [];

  beforeAll(async () => {
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `Real Postgres test database is not reachable at ` +
          `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} ` +
          `(user "${process.env.DB_USER}"). This integration test (task 58.6, BUG-020) ` +
          `requires a real, running, already-migrated Postgres instance -- it deliberately ` +
          `does not mock "../config/database", since the whole point is to prove real ` +
          `POST /api/teams behavior against real, persisted rows. ` +
          `Underlying error: ${error.message}`,
        { cause: error }
      );
    }
  });

  beforeEach(() => {
    app = buildApp();
    mockUser = { id: 1, userId: 1, is_global_manager: true };
  });

  afterAll(async () => {
    // Note: `pool` (../config/database) is a singleton shared with the
    // second describe block below in this same file, which is
    // responsible for the single `pool.end()` call and env-var
    // restoration once the whole file's suites have finished -- calling
    // `pool.end()` here too would break that second describe block's own
    // `beforeAll` connectivity check.
    if (createdTeamIds.length > 0) {
      await pool.query('DELETE FROM channels WHERE team_id = ANY($1)', [createdTeamIds]);
      await pool.query('DELETE FROM teams WHERE id = ANY($1)', [createdTeamIds]);
    }
  });

  it('success: a Global_Manager creating a top-level team persists a real teams row', async () => {
    const teamName = `IntegrationTest Team ${crypto.randomUUID()}`;

    // takserver-enrollment Criterion 2.1: an Organisation (no
    // parentTeamId) now requires a non-empty callsignPrefix -- added
    // here so this top-level team creation still succeeds. Unrelated to
    // what this test itself verifies (a real teams row persisting).
    const res = await request(app)
      .post('/api/teams')
      .send({ name: teamName, description: 'Created by BUG-020 integration test', callsignPrefix: 'ITT' });

    expect(res.status).toBe(201);
    expect(res.body.team).toBeDefined();
    expect(res.body.team.name).toBe(teamName);
    createdTeamIds.push(res.body.team.id);

    const dbRow = await pool.query('SELECT * FROM teams WHERE id = $1', [res.body.team.id]);
    expect(dbRow.rows).toHaveLength(1);
    expect(dbRow.rows[0].name).toBe(teamName);
  });

  it('regression: creating a top-level team with an explicit parentTeamId: null (the real Client\'s exact request shape) succeeds instead of 400', async () => {
    // The Client's create-team form always sends parentTeamId explicitly
    // (null for a top-level team, an integer for a sub-team) -- never
    // omits the field. Plain `.optional()` on an express-validator chain
    // only skips validation when the field is ABSENT, not when it's
    // present-but-null, so `.isInt()` used to run against `null` and fail
    // every top-level team creation from the real Client with a 400, even
    // though the test above (which omits parentTeamId entirely) passed.
    const teamName = `IntegrationTest Null Parent ${crypto.randomUUID()}`;

    // takserver-enrollment Criterion 2.1: callsignPrefix is required for
    // an Organisation.
    const res = await request(app)
      .post('/api/teams')
      .send({ name: teamName, description: 'Top-level team', parentTeamId: null, callsignPrefix: 'INP' });

    expect(res.status).toBe(201);
    expect(res.body.team).toBeDefined();
    expect(res.body.team.parent_team_id).toBeNull();
    createdTeamIds.push(res.body.team.id);
  });

  it('validation-failure: a missing required "name" field is rejected with 400 and creates no row', async () => {
    const beforeCount = (await pool.query('SELECT COUNT(*) FROM teams')).rows[0].count;

    const res = await request(app)
      .post('/api/teams')
      .send({ description: 'No name supplied' });

    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();

    const afterCount = (await pool.query('SELECT COUNT(*) FROM teams')).rows[0].count;
    expect(afterCount).toBe(beforeCount);
  });

  it('validation-failure (authorization): a non-Global_Manager creating a top-level team is rejected with 403 and creates no row', async () => {
    mockUser = { id: 2, userId: 2, is_global_manager: false };
    const teamName = `IntegrationTest Should Not Exist ${crypto.randomUUID()}`;

    const res = await request(app)
      .post('/api/teams')
      .send({ name: teamName });

    expect(res.status).toBe(403);

    const dbRow = await pool.query('SELECT * FROM teams WHERE name = $1', [teamName]);
    expect(dbRow.rows).toHaveLength(0);
  });
});

describe('POST /api/teams/:teamId/members against a real Postgres database (Requirement 12.5, task 58.6)', () => {
  let app;
  let team;
  let otherTeam;
  let teamAdminUser;
  let targetUser;
  const createdUserIds = [];
  const createdTeamIds = [];

  beforeAll(async () => {
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `Real Postgres test database is not reachable at ` +
          `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}. ` +
          `Underlying error: ${error.message}`,
        { cause: error }
      );
    }

    // Real team, created directly (bypassing the HTTP route/Authentik
    // fetch entirely for test-fixture setup -- that path is already
    // exercised by the "POST /api/teams" describe block above).
    const teamResult = await pool.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING *`,
      [`Membership Test Team ${crypto.randomUUID()}`, null]
    );
    team = teamResult.rows[0];
    createdTeamIds.push(team.id);

    const otherTeamResult = await pool.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING *`,
      [`Membership Test Other Team ${crypto.randomUUID()}`, null]
    );
    otherTeam = otherTeamResult.rows[0];
    createdTeamIds.push(otherTeam.id);

    // A real user with a real team_memberships row with role='admin' for
    // `team` -- a genuine team admin, per `Team.isAdmin`, of `team` only
    // (NOT `otherTeam`), and NOT a Global_Manager -- matching the exact
    // BUG-015 scenario this route's authorization is meant to support
    // ("a team admin adding a member to their own team").
    const adminUsername = `membership-admin-${crypto.randomUUID()}`;
    const adminResult = await pool.query(
      `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id`,
      [adminUsername, `${adminUsername}@example.invalid`]
    );
    teamAdminUser = adminResult.rows[0];
    createdUserIds.push(teamAdminUser.id);

    await pool.query(
      `INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [team.id, teamAdminUser.id]
    );

    const targetUsername = `membership-target-${crypto.randomUUID()}`;
    const targetResult = await pool.query(
      `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id`,
      [targetUsername, `${targetUsername}@example.invalid`]
    );
    targetUser = targetResult.rows[0];
    createdUserIds.push(targetUser.id);
  });

  beforeEach(() => {
    app = buildApp();
    mockUser = { id: teamAdminUser.id, userId: teamAdminUser.id, is_global_manager: false };
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await pool.query('DELETE FROM team_memberships WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM channel_memberships WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    }
    if (createdTeamIds.length > 0) {
      await pool.query('DELETE FROM teams WHERE id = ANY($1)', [createdTeamIds]);
    }

    await pool.end();

    process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
    process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
    process.env.DB_NAME = ORIGINAL_ENV.DB_NAME;
    process.env.DB_USER = ORIGINAL_ENV.DB_USER;
    process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
    process.env.AUTHENTIK_URL = ORIGINAL_ENV.AUTHENTIK_URL;
    process.env.AUTHENTIK_API_TOKEN = ORIGINAL_ENV.AUTHENTIK_API_TOKEN;
  });

  it('success: a real team admin adding an existing user to their own team persists a real team_memberships row', async () => {
    const res = await request(app)
      .post(`/api/teams/${team.id}/members`)
      .send({ userId: targetUser.id, role: 'member' });

    expect(res.status).toBe(201);
    expect(res.body.membership).toBeDefined();

    const dbRow = await pool.query(
      'SELECT * FROM team_memberships WHERE team_id = $1 AND user_id = $2',
      [team.id, targetUser.id]
    );
    expect(dbRow.rows).toHaveLength(1);
    expect(dbRow.rows[0].role).toBe('member');
  });

  it('not-found (target user): adding a non-existent userId fails without creating a membership row', async () => {
    const nonExistentUserId = 999999999;

    const res = await request(app)
      .post(`/api/teams/${team.id}/members`)
      .send({ userId: nonExistentUserId, role: 'member' });

    // Team.addMember's INSERT (and its own fallback INSERT) both violate
    // team_memberships.user_id's foreign key against the non-existent
    // user, propagating to the route's generic catch (real observed
    // behavior: HTTP 500, not a 2xx).
    expect(res.status).toBeGreaterThanOrEqual(400);

    const dbRow = await pool.query(
      'SELECT * FROM team_memberships WHERE team_id = $1 AND user_id = $2',
      [team.id, nonExistentUserId]
    );
    expect(dbRow.rows).toHaveLength(0);
  });

  it('not-found (team): a real team admin of one team acting against a non-existent teamId is rejected without creating a membership row', async () => {
    const nonExistentTeamId = 888888888;

    const res = await request(app)
      .post(`/api/teams/${nonExistentTeamId}/members`)
      .send({ userId: targetUser.id, role: 'member' });

    // requireTeamAdmin's real Team.isAdmin(nonExistentTeamId, ...) query
    // matches zero rows, so the real observed behavior is a 403 (team
    // admin access required), not a 404 -- and the membership insert
    // is never attempted.
    expect(res.status).toBe(403);

    const dbRow = await pool.query(
      'SELECT * FROM team_memberships WHERE team_id = $1 AND user_id = $2',
      [nonExistentTeamId, targetUser.id]
    );
    expect(dbRow.rows).toHaveLength(0);
  });

  it('not-found (team), using a Global_Manager actor: still rejected by the real requireTeamAdmin check, and creates no row', async () => {
    // Demonstrates the real, currently-observed behavior of
    // requireTeamAdmin (server/middleware/auth.js): unlike authorize.js's
    // team:members:add resolver, requireTeamAdmin does NOT special-case
    // is_global_manager -- it always runs a real Team.isAdmin(teamId,
    // userId) query, which cannot match a non-existent team for ANY
    // actor, Global_Manager or not.
    mockUser = { id: teamAdminUser.id, userId: teamAdminUser.id, is_global_manager: true };
    const nonExistentTeamId = 777777777;

    const res = await request(app)
      .post(`/api/teams/${nonExistentTeamId}/members`)
      .send({ userId: targetUser.id, role: 'member' });

    expect(res.status).toBe(403);

    const dbRow = await pool.query(
      'SELECT * FROM team_memberships WHERE team_id = $1 AND user_id = $2',
      [nonExistentTeamId, targetUser.id]
    );
    expect(dbRow.rows).toHaveLength(0);
  });
});
