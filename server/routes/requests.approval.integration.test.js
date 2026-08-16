/**
 * Real-Postgres integration tests for access-request approve/deny
 * (BUG-020 / task 58.6, Requirement 12.5):
 *
 *   "Integration tests ... for at least the following API routes: ...
 *   access-request approve/deny (a success case and a case where the
 *   request is already in a non-pending state) ... using supertest."
 *
 * `server/services/RequestApprovalService.test.js` already exists but
 * mocks `pool`/`client` entirely -- every assertion there is about SQL
 * strings/params handed to a mocked client, never about a real,
 * persisted `access_requests`/`team_memberships` row. This file closes
 * that gap by exercising `POST /api/requests/:requestId/approve` and
 * `POST /api/requests/:requestId/deny` (`server/routes/requests.js`, both
 * of which delegate to the real `RequestApprovalService`) against a real
 * Postgres database via `supertest`, following the exact connection
 * convention already established by
 * `server/services/TeamMembershipService.integration.test.js` and
 * `server/routes/auditLogs.integration.test.js`.
 *
 * Request-type choice: the seeded requests below use `team_change` and
 * `role_change` (never `new_account`/`name_change`), specifically because
 * those two branches of `RequestApprovalService.processApprovedRequest`
 * perform ONLY local database writes -- no outbound Authentik `fetch()`
 * call at all (`new_account`/`name_change` both require creating/PATCHing
 * a real Authentik user, which is out of scope for this test and already
 * covered by `RequestApprovalService.test.js`'s mocked-fetch unit tests).
 * This lets the entire approve/deny flow run against a real, unmocked
 * `fetch`-free code path while still exercising a real transaction, a
 * real `TeamMembershipService.addUserToTeam` call (for `team_change`),
 * and a real direct `UPDATE team_memberships` (for `role_change`).
 *
 * `EmailService` IS mocked (`jest.mock('../services/EmailService')`):
 * `approveRequest`/`denyRequest` both send a real email via
 * `this.emailService.sendApprovalEmail`/`sendDenialEmail` -> `sendEmail`
 * -> a real `nodemailer` SMTP transport as their very last step before
 * `COMMIT`. Actually sending outbound email is unrelated to what this
 * task verifies (real DB persistence of the approve/deny state change)
 * and there is no real/reachable SMTP server in this test environment;
 * mocking `EmailService` here mirrors the existing
 * `RequestApprovalService.test.js` unit test's own `jest.mock('./EmailService')`
 * convention exactly.
 *
 * `authenticateToken` is mocked (bypassing real JWT/cookie handling, per
 * the same convention as `teams.integration.test.js`/
 * `auditLogs.integration.test.js`); `authorize.js` is left as the REAL
 * implementation, so the real Permission_Registry `request:approve`/
 * `request:deny` entries are consulted (both are Global_Manager-only via
 * `roleDefaults.global_manager`'s wildcard, so the mocked actor is given
 * `is_global_manager: true`).
 *
 * Connection convention: `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/
 * `DB_PASSWORD` are read from the environment if already set, otherwise
 * defaulted to the local Docker-based test container
 * (`tak_migration_test_501`, Postgres 15, host port 15433, database
 * `tak_team_manager`, user `postgres`, password `postgres123`). These
 * are set on `process.env` BEFORE `../config/database` (required
 * transitively by `./requests`) is first required anywhere in this
 * file's module graph, and are restored in `afterAll`.
 */

const ORIGINAL_ENV = {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD
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
  },
  requireTeamAdmin: (req, res, next) => next()
}));

// Real fetch/SMTP is not exercised for team_change/role_change requests
// (see file-level comment above), but EmailService's real transporter is
// mocked anyway, mirroring RequestApprovalService.test.js's own
// jest.mock('./EmailService') convention -- there is no reachable SMTP
// server in this test environment, and sending a real email is unrelated
// to what this test verifies (real database persistence).
jest.mock('../services/EmailService', () => {
  return jest.fn().mockImplementation(() => ({
    sendApprovalEmail: jest.fn().mockResolvedValue(true),
    sendDenialEmail: jest.fn().mockResolvedValue(true),
    sendVerificationEmail: jest.fn().mockResolvedValue(true)
  }));
});

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

const pool = require('../config/database');
const requestsRouter = require('./requests');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/requests', requestsRouter);
  return app;
}

async function insertAccessRequest(overrides = {}) {
  const base = {
    request_type: 'role_change',
    requester_email: `access-request-${crypto.randomUUID()}@example.invalid`,
    existing_user_id: null,
    target_team_id: null,
    current_team_id: null,
    requested_role: null,
    justification: 'BUG-020 integration test'
  };
  const row = { ...base, ...overrides };

  const result = await pool.query(
    `INSERT INTO access_requests
       (request_type, requester_email, existing_user_id, target_team_id, current_team_id, requested_role, justification)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      row.request_type,
      row.requester_email,
      row.existing_user_id,
      row.target_team_id,
      row.current_team_id,
      row.requested_role,
      row.justification
    ]
  );
  return result.rows[0];
}

describe('Access-request approve/deny against a real Postgres database (Requirement 12.5, task 58.6)', () => {
  let app;
  let adminActor;
  let sourceTeam;
  let targetTeam;
  const createdUserIds = [];
  const createdTeamIds = [];
  const createdRequestIds = [];

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
          `approve/deny behavior against real, persisted access_requests/team_memberships ` +
          `rows. Underlying error: ${error.message}`,
        { cause: error }
      );
    }

    // A real local user row to act as the approving/denying admin --
    // req.user.id is threaded straight through to
    // access_requests.processed_by, which is a real FK against users(id),
    // so it must reference a real row.
    const adminUsername = `access-request-admin-${crypto.randomUUID()}`;
    const adminResult = await pool.query(
      `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING *`,
      [adminUsername, `${adminUsername}@example.invalid`]
    );
    adminActor = adminResult.rows[0];
    createdUserIds.push(adminActor.id);

    const sourceTeamResult = await pool.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING *`,
      [`AccessRequest Source Team ${crypto.randomUUID()}`, null]
    );
    sourceTeam = sourceTeamResult.rows[0];
    createdTeamIds.push(sourceTeam.id);

    const targetTeamResult = await pool.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING *`,
      [`AccessRequest Target Team ${crypto.randomUUID()}`, null]
    );
    targetTeam = targetTeamResult.rows[0];
    createdTeamIds.push(targetTeam.id);
  });

  beforeEach(() => {
    app = buildApp();
    mockUser = { id: adminActor.id, userId: adminActor.id, is_global_manager: true };
  });

  afterAll(async () => {
    if (createdRequestIds.length > 0) {
      await pool.query('DELETE FROM access_requests WHERE id = ANY($1)', [createdRequestIds]);
    }
    if (createdUserIds.length > 0) {
      await pool.query('DELETE FROM team_memberships WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM sync_operations WHERE target_user_id = ANY($1)', [createdUserIds]);
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
  });

  it('approve success: a pending team_change request is approved, moving the real user to the real target team', async () => {
    const username = `access-request-user-${crypto.randomUUID()}`;
    const userResult = await pool.query(
      `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING *`,
      [username, `${username}@example.invalid`]
    );
    const targetUser = userResult.rows[0];
    createdUserIds.push(targetUser.id);

    await pool.query(
      `INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [sourceTeam.id, targetUser.id]
    );

    const accessRequest = await insertAccessRequest({
      request_type: 'team_change',
      existing_user_id: targetUser.id,
      target_team_id: targetTeam.id
    });
    createdRequestIds.push(accessRequest.id);

    const res = await request(app)
      .post(`/api/requests/${accessRequest.id}/approve`)
      .send({ additionalDetails: 'approved by BUG-020 integration test' });

    expect(res.status).toBe(200);

    const dbRequest = await pool.query('SELECT * FROM access_requests WHERE id = $1', [accessRequest.id]);
    expect(dbRequest.rows[0].status).toBe('approved');
    expect(dbRequest.rows[0].processed_by).toBe(adminActor.id);

    const membershipRows = await pool.query(
      'SELECT team_id FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL',
      [targetUser.id]
    );
    expect(membershipRows.rows).toHaveLength(1);
    expect(membershipRows.rows[0].team_id).toBe(targetTeam.id);
  });

  it('deny success: a pending role_change request is denied, recording a real denial_reason and never touching team_memberships', async () => {
    const username = `access-request-user-${crypto.randomUUID()}`;
    const userResult = await pool.query(
      `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING *`,
      [username, `${username}@example.invalid`]
    );
    const targetUser = userResult.rows[0];
    createdUserIds.push(targetUser.id);

    await pool.query(
      `INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [sourceTeam.id, targetUser.id]
    );

    const accessRequest = await insertAccessRequest({
      request_type: 'role_change',
      existing_user_id: targetUser.id,
      current_team_id: sourceTeam.id,
      requested_role: 'admin'
    });
    createdRequestIds.push(accessRequest.id);

    const res = await request(app)
      .post(`/api/requests/${accessRequest.id}/deny`)
      .send({ denialReason: 'denied by BUG-020 integration test' });

    expect(res.status).toBe(200);

    const dbRequest = await pool.query('SELECT * FROM access_requests WHERE id = $1', [accessRequest.id]);
    expect(dbRequest.rows[0].status).toBe('denied');
    expect(dbRequest.rows[0].denial_reason).toBe('denied by BUG-020 integration test');
    expect(dbRequest.rows[0].processed_by).toBe(adminActor.id);

    // Denial must never change the user's actual role -- still 'member',
    // not 'admin'.
    const membershipRows = await pool.query(
      'SELECT role FROM team_memberships WHERE user_id = $1 AND team_id = $2',
      [targetUser.id, sourceTeam.id]
    );
    expect(membershipRows.rows).toHaveLength(1);
    expect(membershipRows.rows[0].role).toBe('member');
  });

  it('already-processed: approving an already-approved request a second time is rejected and leaves the row unchanged', async () => {
    const username = `access-request-user-${crypto.randomUUID()}`;
    const userResult = await pool.query(
      `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING *`,
      [username, `${username}@example.invalid`]
    );
    const targetUser = userResult.rows[0];
    createdUserIds.push(targetUser.id);

    await pool.query(
      `INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [sourceTeam.id, targetUser.id]
    );

    const accessRequest = await insertAccessRequest({
      request_type: 'role_change',
      existing_user_id: targetUser.id,
      current_team_id: sourceTeam.id,
      requested_role: 'admin'
    });
    createdRequestIds.push(accessRequest.id);

    const firstRes = await request(app).post(`/api/requests/${accessRequest.id}/approve`).send({});
    expect(firstRes.status).toBe(200);

    const afterFirstApprove = await pool.query('SELECT * FROM access_requests WHERE id = $1', [accessRequest.id]);
    expect(afterFirstApprove.rows[0].status).toBe('approved');
    const processedAtAfterFirst = afterFirstApprove.rows[0].processed_at;

    // Second approval attempt against the SAME, now-already-approved
    // request: RequestApprovalService.approveRequest's pre-fetch
    // ('... WHERE id = $1 AND status = $2', [requestId, 'pending'])
    // matches zero rows, so it throws 'Request not found or already
    // processed', which the route's catch block turns into a real,
    // observed HTTP failure -- and no further mutation occurs.
    const secondRes = await request(app).post(`/api/requests/${accessRequest.id}/approve`).send({});
    expect(secondRes.status).toBeGreaterThanOrEqual(400);

    const afterSecondApprove = await pool.query('SELECT * FROM access_requests WHERE id = $1', [accessRequest.id]);
    expect(afterSecondApprove.rows[0].status).toBe('approved');
    expect(afterSecondApprove.rows[0].processed_at).toEqual(processedAtAfterFirst);

    // The user's real role must still reflect only the FIRST approval's
    // effect (admin), not have been altered again by the rejected second
    // attempt.
    const membershipRows = await pool.query(
      'SELECT role FROM team_memberships WHERE user_id = $1 AND team_id = $2',
      [targetUser.id, sourceTeam.id]
    );
    expect(membershipRows.rows[0].role).toBe('admin');
  });

  it('already-processed: denying a request that was already approved is rejected without changing its approved status', async () => {
    const username = `access-request-user-${crypto.randomUUID()}`;
    const userResult = await pool.query(
      `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING *`,
      [username, `${username}@example.invalid`]
    );
    const targetUser = userResult.rows[0];
    createdUserIds.push(targetUser.id);

    await pool.query(
      `INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [sourceTeam.id, targetUser.id]
    );

    const accessRequest = await insertAccessRequest({
      request_type: 'team_change',
      existing_user_id: targetUser.id,
      target_team_id: targetTeam.id
    });
    createdRequestIds.push(accessRequest.id);

    const approveRes = await request(app).post(`/api/requests/${accessRequest.id}/approve`).send({});
    expect(approveRes.status).toBe(200);

    // Attempting to DENY a request that is already 'approved' (a
    // non-pending status): denyRequest's own pre-fetch
    // ('... WHERE id = $1 AND status = \'pending\'') matches zero rows,
    // throwing 'Request not found or already processed'.
    const denyRes = await request(app)
      .post(`/api/requests/${accessRequest.id}/deny`)
      .send({ denialReason: 'should not be applied' });
    expect(denyRes.status).toBeGreaterThanOrEqual(400);

    const dbRequest = await pool.query('SELECT * FROM access_requests WHERE id = $1', [accessRequest.id]);
    expect(dbRequest.rows[0].status).toBe('approved');
    expect(dbRequest.rows[0].denial_reason).toBeNull();
  });
});
