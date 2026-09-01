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
//
// `sendEmail` is a SHARED spy across every constructed instance
// (`mockSendEmail`, declared below), unlike the three per-instance
// `jest.fn()`s beside it. Property 24 (task 10.6) needs to observe the
// `team_transfer_completed` notification that
// `TeamTransferService.applyPostCommitEffects` sends through its own
// module-scope `new EmailService()` singleton -- a per-instance mock
// would be unreachable from the test, since that singleton is created
// at require time inside the service and never exposed.
const mockSendEmail = jest.fn().mockResolvedValue(true);

// `sendDenialEmail` is a SHARED spy for the same reason (task 10.10,
// Requirements 12.3 and 12.4). `RequestApprovalService` constructs its own
// `new EmailService()` in its constructor and never exposes it, and
// `server/routes/requests.js` holds a single module-scope
// `new RequestApprovalService()`, so a per-instance `jest.fn()` is
// unreachable from here -- yet the denial-email examples must both READ
// the call (which address, which reason) and MAKE IT FAIL.
const mockSendDenialEmail = jest.fn().mockResolvedValue(true);

jest.mock('../services/EmailService', () => {
  return jest.fn().mockImplementation(() => ({
    sendApprovalEmail: jest.fn().mockResolvedValue(true),
    sendDenialEmail: mockSendDenialEmail,
    sendVerificationEmail: jest.fn().mockResolvedValue(true),
    sendEmail: mockSendEmail
  }));
});

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');
const fc = require('fast-check');
const { test } = require('@fast-check/jest');

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

  /**
   * Suite teardown, in FK-safe order.
   *
   * `audit_logs`, `sync_operations`, and `access_requests` all hold
   * NON-cascading foreign keys into `users`, so every one of them must be
   * cleared BEFORE the `users` rows it references -- deleting `users`
   * first raises `23503` (`audit_logs_user_id_fkey`), which used to make
   * this suite report FAILED even when every test passed, and left the
   * whole world (users, teams, audit rows) behind in the test container on
   * every run. The ordering below is the one
   * `server/routes/users.transfer.integration.test.js`'s `cleanupWorld`
   * already uses.
   *
   * Two audit-row shapes are written by the routes exercised here: the
   * approve/deny routes' own `access_request` rows (matched by
   * `resource_id`, which is not an FK) and
   * `TeamTransferService.applyPostCommitEffects`'s `user.team_transfer`
   * rows (matched by `resource_type = 'user'`). Both carry a `user_id`
   * FK, so both are removed.
   */
  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await pool.query(
        `DELETE FROM audit_logs
          WHERE user_id = ANY($1)
             OR (resource_type = 'user' AND resource_id = ANY($1))`,
        [createdUserIds]
      );
    }
    if (createdRequestIds.length > 0) {
      await pool.query(
        `DELETE FROM audit_logs
          WHERE resource_type = 'access_request' AND resource_id = ANY($1)`,
        [createdRequestIds]
      );
    }
    if (createdUserIds.length > 0) {
      await pool.query(
        'DELETE FROM sync_operations WHERE target_user_id = ANY($1) OR created_by = ANY($1)',
        [createdUserIds]
      );
      await pool.query(
        `DELETE FROM access_requests
          WHERE existing_user_id = ANY($1)
             OR initiated_by = ANY($1)
             OR assigned_to_admin = ANY($1)
             OR processed_by = ANY($1)`,
        [createdUserIds]
      );
    }
    if (createdRequestIds.length > 0) {
      await pool.query('DELETE FROM access_requests WHERE id = ANY($1)', [createdRequestIds]);
    }
    if (createdUserIds.length > 0) {
      await pool.query('DELETE FROM channel_memberships WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM team_memberships WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    }
    if (createdTeamIds.length > 0) {
      // Deepest-first, so `teams.parent_team_id` never blocks a delete.
      for (const teamId of [...createdTeamIds].reverse()) {
        await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
      }
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

  /**
   * Feature: team-member-transfer, task 10.3 -- Property 21 (Requirement
   * 11.1, and the Requirement 17.6 assertion).
   *
   * Nested inside the outer describe deliberately: the outer `afterAll`
   * calls `pool.end()`, so a sibling top-level describe would run its
   * tests against a closed pool. This block owns its own hierarchy
   * fixture and tears it down in its own `afterAll`, which runs while the
   * pool is still open.
   *
   * All four seeded Teams share ONE Organisation root, so the
   * Organisation-boundary re-check of Requirement 11.6 can never fire and
   * the only rejection this property can observe is the staleness one it
   * is about. (The approving actor is a Global_Manager anyway, per the
   * outer `beforeEach`, which exempts them from that check.)
   */
  describe('Property 21: Approval is rejected exactly when the recorded source no longer matches', () => {
    // Org (root) -> A, B; A -> C. Four Teams, one Organisation, depths
    // 0, 1, 1, 2 -- so a generated (recorded, actual, destination) triple
    // can name an ancestor, a descendant, or a sibling of any other.
    const hierarchyTeamIds = [];

    beforeAll(async () => {
      const org = await pool.query(
        `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING id`,
        [`P21 Org ${crypto.randomUUID()}`, 'P21ORG']
      );
      const orgId = org.rows[0].id;

      const insertChild = async (label, parentId) => {
        const result = await pool.query(
          `INSERT INTO teams (name, callsign_prefix, parent_team_id) VALUES ($1, $2, $3) RETURNING id`,
          [`P21 ${label} ${crypto.randomUUID()}`, `P21${label}`, parentId]
        );
        return result.rows[0].id;
      };

      const aId = await insertChild('A', orgId);
      const bId = await insertChild('B', orgId);
      const cId = await insertChild('C', aId);

      hierarchyTeamIds.push(orgId, aId, bId, cId);
    });

    afterAll(async () => {
      // Deepest-first, so `teams.parent_team_id` never blocks a delete.
      for (const teamId of [...hierarchyTeamIds].reverse()) {
        await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
      }
    });

    /**
     * The generated scenario is three indices into the seeded hierarchy
     * plus the role the Transferred_User holds before the approval:
     *
     *  - `recordedIndex`   -> the Transfer_Request's `current_team_id`
     *  - `actualIndex`     -> the Team the user's Direct_Membership names
     *                         at approval time
     *  - `destinationIndex`-> the Transfer_Request's `target_team_id`
     *
     * `destinationIndex !== actualIndex` is required because a user whose
     * Direct_Membership already names the destination is rejected by
     * `AlreadyInDestinationTeamError`, a DIFFERENT rejection than the one
     * this biconditional is about -- admitting it would let a passing run
     * be a rejection for the wrong reason. `destinationIndex` is free to
     * equal `recordedIndex`, which is the ordinary fresh-request shape.
     */
    const scenarioArb = fc
      .record({
        recordedIndex: fc.integer({ min: 0, max: 3 }),
        actualIndex: fc.integer({ min: 0, max: 3 }),
        destinationIndex: fc.integer({ min: 0, max: 3 }),
        priorRole: fc.constantFrom('member', 'admin')
      })
      .filter(scenario => scenario.destinationIndex !== scenario.actualIndex);

    // Feature: team-member-transfer, Property 21: Approval is rejected exactly when the recorded source no longer matches
    test.prop([scenarioArb], { numRuns: 100 })(
      'approving a team_change request yields 409 with the row still pending and every membership row untouched if and only if the Direct_Membership names a Team other than the recorded current_team_id, and otherwise applies the transfer',
      async (scenario) => {
        const recordedTeamId = hierarchyTeamIds[scenario.recordedIndex];
        const actualTeamId = hierarchyTeamIds[scenario.actualIndex];
        const destinationTeamId = hierarchyTeamIds[scenario.destinationIndex];

        // The expectation is derived straight from the generated indices
        // -- "the Direct_Membership names a Team other than the row's
        // current_team_id" -- never by asking the code under test what it
        // thinks the source Team is.
        const expectedStale = scenario.actualIndex !== scenario.recordedIndex;

        const username = `p21-${crypto.randomUUID()}`;
        const userResult = await pool.query(
          `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id`,
          [username, `${username}@example.invalid`]
        );
        const userId = userResult.rows[0].id;

        let accessRequestId = null;

        try {
          await pool.query(
            `INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3)`,
            [actualTeamId, userId, scenario.priorRole]
          );

          const membershipsBefore = await pool.query(
            `SELECT team_id, role, inherited_from_team_id
               FROM team_memberships
              WHERE user_id = $1
              ORDER BY team_id, inherited_from_team_id NULLS FIRST`,
            [userId]
          );

          const accessRequest = await insertAccessRequest({
            request_type: 'team_change',
            existing_user_id: userId,
            current_team_id: recordedTeamId,
            target_team_id: destinationTeamId,
            justification: 'Property 21 staleness scenario'
          });
          accessRequestId = accessRequest.id;

          const res = await request(app).post(`/api/requests/${accessRequestId}/approve`).send({});

          const dbRequest = await pool.query(
            'SELECT status, processed_by, processed_at FROM access_requests WHERE id = $1',
            [accessRequestId]
          );
          const directRows = await pool.query(
            `SELECT team_id, role
               FROM team_memberships
              WHERE user_id = $1 AND inherited_from_team_id IS NULL`,
            [userId]
          );

          if (expectedStale) {
            // 409, the row is still actionable, and NOTHING moved --
            // asserted over every team_memberships row, not just the
            // direct one, so a partially-applied inherited-row write
            // would be caught too.
            expect(res.status).toBe(409);
            expect(res.body.error).toMatch(/changed since the request was created/i);

            expect(dbRequest.rows[0].status).toBe('pending');
            expect(dbRequest.rows[0].processed_by).toBeNull();
            expect(dbRequest.rows[0].processed_at).toBeNull();

            const membershipsAfter = await pool.query(
              `SELECT team_id, role, inherited_from_team_id
                 FROM team_memberships
                WHERE user_id = $1
                ORDER BY team_id, inherited_from_team_id NULLS FIRST`,
              [userId]
            );
            expect(membershipsAfter.rows).toEqual(membershipsBefore.rows);

            expect(directRows.rows).toHaveLength(1);
            expect(directRows.rows[0].team_id).toBe(actualTeamId);
            expect(directRows.rows[0].role).toBe(scenario.priorRole);
          } else {
            // The other half of the biconditional: a request whose
            // recorded source still matches is NOT rejected, and the
            // transfer really lands.
            expect(res.status).toBe(200);

            expect(dbRequest.rows[0].status).toBe('approved');
            expect(dbRequest.rows[0].processed_by).toBe(adminActor.id);

            expect(directRows.rows).toHaveLength(1);
            expect(directRows.rows[0].team_id).toBe(destinationTeamId);
            expect(directRows.rows[0].role).toBe('member');
          }
        } finally {
          // Per-run cleanup, in FK order. The Transferred_User is removed
          // here rather than deferred to the outer `afterAll`, so 100 runs
          // leave no residue for the next randomly-generated scenario to
          // interact with.
          if (accessRequestId !== null) {
            await pool.query('DELETE FROM access_requests WHERE id = $1', [accessRequestId]);
          }
          await pool.query('DELETE FROM channel_memberships WHERE user_id = $1', [userId]);
          await pool.query('DELETE FROM team_memberships WHERE user_id = $1', [userId]);
          await pool.query('DELETE FROM sync_operations WHERE target_user_id = $1', [userId]);
          await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        }
      },
      120000
    );
  });

  /**
   * Feature: team-member-transfer, task 10.4 -- Property 22 (Requirement
   * 12.1).
   *
   * Nested inside the outer describe for the same reason as Property 21
   * above: the outer `afterAll` calls `pool.end()`, so a sibling
   * top-level describe would run against a closed pool.
   *
   * Scope note: this block asserts ONLY what Requirement 12.1 states --
   * the four columns the denial writes, plus that the Transferred_User's
   * membership rows are left exactly as they were. The denial email
   * (12.3/12.4) and the reason's bounds (12.5/12.6, Property 23) are
   * deliberately not touched here.
   */
  describe('Property 22: Denial records the decision', () => {
    // Org (root) -> Source, Destination. A real two-Team hierarchy under
    // one Organisation, so the seeded row is a genuine Transfer_Request
    // (`current_team_id` and `target_team_id` both resolvable) rather
    // than a shape `denyRequest`'s team-path lookup would have to fall
    // back on.
    const p22TeamIds = [];
    let p22SourceTeamId;
    let p22DestinationTeamId;

    // Two DISTINCT denying admins, neither of which is the outer
    // `adminActor`. `processed_by` is generated per run, so an
    // implementation that recorded a fixed or wrong actor id (the
    // Transferred_User, the Initiating_Admin, the outer admin) could not
    // pass -- asserting against `adminActor.id` alone would not
    // distinguish those.
    const p22DenierIds = [];

    // The Initiating_Admin whose address the Transfer_Request records in
    // `requester_email`, i.e. the admin the denial is reported back to.
    let p22InitiatorId;
    let p22InitiatorEmail;

    beforeAll(async () => {
      const org = await pool.query(
        `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING id`,
        [`P22 Org ${crypto.randomUUID()}`, 'P22ORG']
      );
      const orgId = org.rows[0].id;

      const insertChild = async (label) => {
        const result = await pool.query(
          `INSERT INTO teams (name, callsign_prefix, parent_team_id) VALUES ($1, $2, $3) RETURNING id`,
          [`P22 ${label} ${crypto.randomUUID()}`, `P22${label}`, orgId]
        );
        return result.rows[0].id;
      };

      p22SourceTeamId = await insertChild('Source');
      p22DestinationTeamId = await insertChild('Dest');
      p22TeamIds.push(orgId, p22SourceTeamId, p22DestinationTeamId);

      const insertUser = async (prefix) => {
        const username = `${prefix}-${crypto.randomUUID()}`;
        const result = await pool.query(
          `INSERT INTO users (username, email, first_name, last_name) VALUES ($1, $2, $3, $4) RETURNING id, email`,
          [username, `${username}@example.invalid`, 'Prop', 'TwentyTwo']
        );
        return result.rows[0];
      };

      const denierA = await insertUser('p22-denier-a');
      const denierB = await insertUser('p22-denier-b');
      p22DenierIds.push(denierA.id, denierB.id);

      const initiator = await insertUser('p22-initiator');
      p22InitiatorId = initiator.id;
      p22InitiatorEmail = initiator.email;
    });

    afterAll(async () => {
      // `audit_logs.user_id` has no ON DELETE action, so the deny route's
      // own audit row must go before the admin that wrote it. Scoped to
      // the ids this block created -- the outer `afterAll`'s equivalent
      // gap is a separate, pre-existing matter.
      const p22UserIds = [...p22DenierIds, p22InitiatorId].filter((id) => id != null);
      if (p22UserIds.length > 0) {
        await pool.query('DELETE FROM audit_logs WHERE user_id = ANY($1)', [p22UserIds]);
        await pool.query('DELETE FROM team_memberships WHERE user_id = ANY($1)', [p22UserIds]);
        await pool.query('DELETE FROM users WHERE id = ANY($1)', [p22UserIds]);
      }
      // Deepest-first, so `teams.parent_team_id` never blocks a delete.
      for (const teamId of [...p22TeamIds].reverse()) {
        await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
      }
    });

    /**
     * Denial reasons that the route's validator accepts, since
     * Requirement 12.1 speaks of a "non-empty `denialReason`" -- rejected
     * values are Property 23's subject, not this one's. Every generated
     * value therefore trims to between 1 and 1000 characters:
     *
     *  - printable-ASCII text (the ordinary case),
     *  - whitespace-padded text, because `body('denialReason').trim()`
     *    sanitises in place, so the value that reaches the column is the
     *    TRIMMED one -- the expectation below is computed the same way,
     *    from the generated string,
     *  - non-ASCII graphemes, since `denial_reason` is `TEXT` and the
     *    reason is admin-authored prose,
     *  - the exact 1000-character upper bound, which the validator
     *    admits (`max: 1000` is inclusive).
     */
    const reasonArb = fc
      .oneof(
        { weight: 6, arbitrary: fc.string({ minLength: 1, maxLength: 80 }) },
        {
          weight: 3,
          arbitrary: fc
            .tuple(fc.string({ minLength: 1, maxLength: 40 }), fc.constantFrom('  ', '\t', '\n ', ' \r\n', '\f'))
            .map(([body, pad]) => `${pad}${body}${pad}`)
        },
        { weight: 2, arbitrary: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 20 }) },
        { weight: 1, arbitrary: fc.constant('b'.repeat(1000)) }
      )
      .filter((reason) => reason.trim().length >= 1 && reason.trim().length <= 1000);

    const denialScenarioArb = fc.record({
      reason: reasonArb,
      // Every Direct_Membership role, so "membership rows unchanged"
      // covers the case a buggy denial would be most tempted to touch:
      // an admin being moved out.
      priorRole: fc.constantFrom('member', 'admin'),
      denierIndex: fc.integer({ min: 0, max: 1 })
    });

    // Feature: team-member-transfer, Property 22: Denial records the decision
    test.prop([denialScenarioArb], { numRuns: 100 })(
      'denying a pending Transfer_Request sets status to denied, denial_reason to the submitted reason, processed_by to the denying user, and processed_at to a non-null timestamp, leaving every membership row unchanged',
      async (scenario) => {
        const denierId = p22DenierIds[scenario.denierIndex];

        // Both expectations are read straight off the generated data:
        // the stored reason is the submitted string as the route's own
        // `trim()` sanitiser leaves it, and the recorded actor is the id
        // this run chose to authenticate as.
        const expectedStoredReason = scenario.reason.trim();

        const username = `p22-user-${crypto.randomUUID()}`;
        const userResult = await pool.query(
          `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id`,
          [username, `${username}@example.invalid`]
        );
        const userId = userResult.rows[0].id;

        let accessRequestId = null;

        try {
          await pool.query(
            `INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3)`,
            [p22SourceTeamId, userId, scenario.priorRole]
          );

          const membershipsBefore = await pool.query(
            `SELECT team_id, role, inherited_from_team_id
               FROM team_memberships
              WHERE user_id = $1
              ORDER BY team_id, inherited_from_team_id NULLS FIRST`,
            [userId]
          );

          const inserted = await pool.query(
            `INSERT INTO access_requests
               (request_type, requester_email, requester_first_name, requester_last_name,
                existing_user_id, current_team_id, target_team_id, approval_team_id,
                initiated_by, email_verified, justification)
             VALUES ('team_change', $1, 'Prop', 'TwentyTwo', $2, $3, $4, $5, $6, true, $7)
             RETURNING id`,
            [
              p22InitiatorEmail,
              userId,
              p22SourceTeamId,
              p22DestinationTeamId,
              p22SourceTeamId,
              p22InitiatorId,
              'Property 22 denial scenario'
            ]
          );
          accessRequestId = inserted.rows[0].id;

          mockUser = { id: denierId, userId: denierId, is_global_manager: true };

          const res = await request(app)
            .post(`/api/requests/${accessRequestId}/deny`)
            .send({ denialReason: scenario.reason });

          expect(res.status).toBe(200);

          const dbRequest = await pool.query(
            'SELECT status, denial_reason, processed_by, processed_at FROM access_requests WHERE id = $1',
            [accessRequestId]
          );
          const denied = dbRequest.rows[0];

          expect(denied.status).toBe('denied');
          expect(denied.denial_reason).toBe(expectedStoredReason);
          expect(denied.processed_by).toBe(denierId);
          expect(denied.processed_at).not.toBeNull();
          expect(denied.processed_at).toBeInstanceOf(Date);

          // Requirement 12.1's second half: a denial is a pure
          // decision-recording write. Compared over EVERY
          // team_memberships row of the Transferred_User, so an
          // inherited-row write would be caught as well as a direct one.
          const membershipsAfter = await pool.query(
            `SELECT team_id, role, inherited_from_team_id
               FROM team_memberships
              WHERE user_id = $1
              ORDER BY team_id, inherited_from_team_id NULLS FIRST`,
            [userId]
          );
          expect(membershipsAfter.rows).toEqual(membershipsBefore.rows);
        } finally {
          mockUser = { id: adminActor.id, userId: adminActor.id, is_global_manager: true };
          if (accessRequestId !== null) {
            await pool.query(
              `DELETE FROM audit_logs
                WHERE resource_type = 'access_request' AND resource_id = $1`,
              [accessRequestId]
            );
            await pool.query('DELETE FROM access_requests WHERE id = $1', [accessRequestId]);
          }
          await pool.query('DELETE FROM channel_memberships WHERE user_id = $1', [userId]);
          await pool.query('DELETE FROM team_memberships WHERE user_id = $1', [userId]);
          await pool.query('DELETE FROM sync_operations WHERE target_user_id = $1', [userId]);
          await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        }
      },
      120000
    );
  });

  /**
   * Feature: team-member-transfer, task 10.5 -- Property 23 (Requirements
   * 12.5 and 12.6).
   *
   * Nested inside the outer describe for the same reason as Properties 21
   * and 22 above: the outer `afterAll` calls `pool.end()`, so a sibling
   * top-level describe would run against a closed pool.
   *
   * Scope: only the bound the deny route's validator
   * (`body('denialReason').trim().isLength({ min: 1, max: 1000 })`)
   * enforces, stated as a biconditional over the TRIMMED length -- since
   * `trim()` is a sanitiser that rewrites `req.body.denialReason` in
   * place, the value `isLength` measures is never the raw submitted one.
   * A reason whose trimmed length falls outside 1..1000 must leave the
   * row actionable (`status` still `pending`, `denial_reason` still
   * NULL); a reason inside the bound must be accepted. Which four columns
   * an accepted denial writes is Property 22's subject, and the denial
   * email is Requirement 12.3/12.4's; neither is re-asserted here.
   */
  describe('Property 23: A denial reason outside its bounds is rejected', () => {
    // Org (root) -> Source, Destination, as in Property 22: a real
    // two-Team hierarchy under one Organisation, so every seeded row is a
    // genuine Transfer_Request whose `current_team_id`/`target_team_id`
    // both resolve.
    const p23TeamIds = [];
    let p23SourceTeamId;
    let p23DestinationTeamId;

    // The Initiating_Admin recorded in `requester_email`/`initiated_by`.
    let p23InitiatorId;
    let p23InitiatorEmail;

    beforeAll(async () => {
      const org = await pool.query(
        `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING id`,
        [`P23 Org ${crypto.randomUUID()}`, 'P23ORG']
      );
      const orgId = org.rows[0].id;

      const insertChild = async (label) => {
        const result = await pool.query(
          `INSERT INTO teams (name, callsign_prefix, parent_team_id) VALUES ($1, $2, $3) RETURNING id`,
          [`P23 ${label} ${crypto.randomUUID()}`, `P23${label}`, orgId]
        );
        return result.rows[0].id;
      };

      p23SourceTeamId = await insertChild('Source');
      p23DestinationTeamId = await insertChild('Dest');
      p23TeamIds.push(orgId, p23SourceTeamId, p23DestinationTeamId);

      const initiatorUsername = `p23-initiator-${crypto.randomUUID()}`;
      const initiator = await pool.query(
        `INSERT INTO users (username, email, first_name, last_name) VALUES ($1, $2, $3, $4) RETURNING id, email`,
        [initiatorUsername, `${initiatorUsername}@example.invalid`, 'Prop', 'TwentyThree']
      );
      p23InitiatorId = initiator.rows[0].id;
      p23InitiatorEmail = initiator.rows[0].email;
    });

    afterAll(async () => {
      // `audit_logs.user_id` has no ON DELETE action, so any audit row
      // this block's users wrote must go before the user itself. Scoped
      // to the ids created here.
      if (p23InitiatorId != null) {
        await pool.query('DELETE FROM audit_logs WHERE user_id = $1', [p23InitiatorId]);
        await pool.query('DELETE FROM team_memberships WHERE user_id = $1', [p23InitiatorId]);
        await pool.query('DELETE FROM users WHERE id = $1', [p23InitiatorId]);
      }
      // Deepest-first, so `teams.parent_team_id` never blocks a delete.
      for (const teamId of [...p23TeamIds].reverse()) {
        await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
      }
    });

    /**
     * Every character in the pool is a single UTF-16 code unit, and none
     * of them is whitespace. Both properties matter:
     *
     *  - validator.js's `isLength` discounts surrogate pairs before
     *    comparing, so for an astral character JavaScript's `.length`
     *    and the validator's count diverge. A BMP-only pool keeps the
     *    length this test computes from the generated data identical to
     *    the one the route measures.
     *  - a whitespace-free pool makes the boundary buckets below exact:
     *    a generated 1000-character body trims to exactly 1000, so
     *    "at the bound" cannot silently become "one under".
     *
     * Non-ASCII members are included because `denial_reason` is `TEXT`
     * holding admin-authored prose.
     */
    const REASON_CHARS = [...'abcXYZ019-_.', 'é', 'ü', 'ō', 'テ', '—'];

    const bodyOfLength = (length) =>
      fc
        .array(fc.constantFrom(...REASON_CHARS), { minLength: length, maxLength: length })
        .map((chars) => chars.join(''));

    // ASCII whitespace only: `String.prototype.trim` and validator.js's
    // `trim` (a `/^\s+/` + `/\s+$/` strip) agree on every one of these,
    // so the padding can never make the expectation computed here differ
    // from the route's own sanitisation.
    const whitespaceRunArb = fc
      .array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), { minLength: 1, maxLength: 12 })
      .map((chars) => chars.join(''));

    /**
     * The generated scenario is `{ label, sendField, value }`, spanning
     * both sides of both bounds:
     *
     *  - trimmed length 0: the field absent entirely, present as JSON
     *    `null`, the empty string, and whitespace-only (Requirement 12.5,
     *    plus the "whitespace-only" form the `trim()` sanitiser creates),
     *  - trimmed length 1, an arbitrary mid-range length, 999 and 1000:
     *    accepted, the last being the inclusive upper bound itself,
     *  - trimmed length 1001 and a run further past it: rejected
     *    (Requirement 12.6),
     *  - a padded 1000-character body (raw length > 1000, trimmed length
     *    exactly 1000) and a padded 1001-character one: the pair that
     *    distinguishes a bound applied to the trimmed value from one
     *    applied to the raw submission.
     */
    const denialReasonArb = fc.oneof(
      fc.constant({ label: 'absent', sendField: false, value: null }),
      fc.constant({ label: 'json-null', sendField: true, value: null }),
      fc.constant({ label: 'empty-string', sendField: true, value: '' }),
      whitespaceRunArb.map((value) => ({ label: 'whitespace-only', sendField: true, value })),
      bodyOfLength(1).map((value) => ({ label: 'at-min', sendField: true, value })),
      fc
        .integer({ min: 2, max: 200 })
        .chain((length) => bodyOfLength(length))
        .map((value) => ({ label: 'mid-range', sendField: true, value })),
      bodyOfLength(999).map((value) => ({ label: 'one-under-max', sendField: true, value })),
      bodyOfLength(1000).map((value) => ({ label: 'at-max', sendField: true, value })),
      bodyOfLength(1001).map((value) => ({ label: 'one-over-max', sendField: true, value })),
      fc
        .integer({ min: 1002, max: 1200 })
        .chain((length) => bodyOfLength(length))
        .map((value) => ({ label: 'far-over-max', sendField: true, value })),
      fc
        .tuple(whitespaceRunArb, bodyOfLength(1000), whitespaceRunArb)
        .map(([left, body, right]) => ({
          label: 'padded-trims-to-max',
          sendField: true,
          value: `${left}${body}${right}`
        })),
      fc
        .tuple(whitespaceRunArb, bodyOfLength(1001), whitespaceRunArb)
        .map(([left, body, right]) => ({
          label: 'padded-trims-to-over-max',
          sendField: true,
          value: `${left}${body}${right}`
        }))
    );

    const p23ScenarioArb = fc.record({
      denialReason: denialReasonArb,
      // Both Direct_Membership roles, so a rejected denial is shown to
      // leave the row alone for the shape a buggy one would be most
      // tempted to act on: an admin on the way out.
      priorRole: fc.constantFrom('member', 'admin')
    });

    // Feature: team-member-transfer, Property 23: A denial reason outside its bounds is rejected
    test.prop([p23ScenarioArb], { numRuns: 100 })(
      'denying a pending Transfer_Request responds 400 and leaves the row pending with a NULL denial_reason if and only if the trimmed denialReason is empty or longer than 1000 characters, and is accepted otherwise',
      async (scenario) => {
        const { sendField, value } = scenario.denialReason;

        // The expectation is derived from the generated value alone: the
        // trimmed length of what will be submitted, compared against the
        // stated 1..1000 bound. The route is never consulted about what
        // it considers valid.
        const trimmedReason = value === null ? '' : String(value).trim();
        const expectedRejected = trimmedReason.length < 1 || trimmedReason.length > 1000;

        const username = `p23-user-${crypto.randomUUID()}`;
        const userResult = await pool.query(
          `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id`,
          [username, `${username}@example.invalid`]
        );
        const userId = userResult.rows[0].id;

        let accessRequestId = null;

        try {
          await pool.query(
            `INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3)`,
            [p23SourceTeamId, userId, scenario.priorRole]
          );

          const inserted = await pool.query(
            `INSERT INTO access_requests
               (request_type, requester_email, requester_first_name, requester_last_name,
                existing_user_id, current_team_id, target_team_id, approval_team_id,
                initiated_by, email_verified, justification)
             VALUES ('team_change', $1, 'Prop', 'TwentyThree', $2, $3, $4, $5, $6, true, $7)
             RETURNING id`,
            [
              p23InitiatorEmail,
              userId,
              p23SourceTeamId,
              p23DestinationTeamId,
              p23SourceTeamId,
              p23InitiatorId,
              'Property 23 denial-reason bounds scenario'
            ]
          );
          accessRequestId = inserted.rows[0].id;

          // `sendField: false` omits the key entirely, which is the
          // "absent" half of Requirement 12.5 -- distinct from sending
          // `null`, since the two reach the validator by different routes
          // even though both sanitise to ''.
          const body = sendField ? { denialReason: value } : {};
          const res = await request(app).post(`/api/requests/${accessRequestId}/deny`).send(body);

          const dbRequest = await pool.query(
            'SELECT status, denial_reason, processed_by, processed_at FROM access_requests WHERE id = $1',
            [accessRequestId]
          );
          const row = dbRequest.rows[0];

          if (expectedRejected) {
            expect(res.status).toBe(400);
            expect(Array.isArray(res.body.errors)).toBe(true);
            expect(res.body.errors.length).toBeGreaterThan(0);

            // Requirements 12.5 and 12.6: the row stays actionable, with
            // no partial decision recorded on it.
            expect(row.status).toBe('pending');
            expect(row.denial_reason).toBeNull();
            expect(row.processed_by).toBeNull();
            expect(row.processed_at).toBeNull();
          } else {
            // The other half of the biconditional: a reason inside the
            // bound is not what gets rejected. The stored value is the
            // trimmed one, computed here from the generated string.
            expect(res.status).toBe(200);
            expect(row.status).toBe('denied');
            expect(row.denial_reason).toBe(trimmedReason);
            expect(row.processed_by).toBe(adminActor.id);
          }
        } finally {
          // Per-run cleanup in FK order, so 100 runs leave no residue for
          // the next generated scenario to interact with.
          if (accessRequestId !== null) {
            await pool.query(
              `DELETE FROM audit_logs
                WHERE resource_type = 'access_request' AND resource_id = $1`,
              [accessRequestId]
            );
            await pool.query('DELETE FROM access_requests WHERE id = $1', [accessRequestId]);
          }
          await pool.query('DELETE FROM channel_memberships WHERE user_id = $1', [userId]);
          await pool.query('DELETE FROM team_memberships WHERE user_id = $1', [userId]);
          await pool.query('DELETE FROM sync_operations WHERE target_user_id = $1', [userId]);
          await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        }
      },
      120000
    );
  });

  /**
   * Feature: team-member-transfer, task 10.6 -- Property 24 (Requirements
   * 13.1, 13.3, 13.5).
   *
   * Nested inside the outer describe for the same reason as Properties
   * 21-23 above: the outer `afterAll` calls `pool.end()`, so a sibling
   * top-level describe would run against a closed pool.
   *
   * WHAT IS OBSERVED, AND HOW
   * =========================
   *
   * `applyPostCommitEffects` step 4 calls
   * `emailService.sendEmail(user.email, 'team_transfer_completed',
   * { first_name, team_path, username, callsign })` on the module-scope
   * `new EmailService()` singleton inside `TeamTransferService`. That
   * singleton is never exposed, so the shared `mockSendEmail` spy
   * installed by this file's `jest.mock('../services/EmailService')`
   * factory is the only way to see the call. Note that BEFORE this task
   * the factory had no `sendEmail` at all, so the notification threw
   * `emailService.sendEmail is not a function` into step 4's own
   * try/catch on every run of Property 21 -- an unobserved no-op that
   * would have made this property vacuous.
   *
   * Because `sendEmail` is mocked, no rendering happens in production
   * code during the test. Requirement 13.3's completeness half is
   * therefore asserted in two independent ways against the REAL template
   * text, read once from the `email_templates` row that migration
   * 1786930000000 seeded:
   *
   *  1. every `{{token}}` appearing in the real subject/body is a key of
   *     the variables object the service actually passed -- a template
   *     variable the caller does not supply is caught directly, without
   *     depending on any rendering step;
   *  2. rendering the real subject/body with those variables, through the
   *     same substitution `EmailService.replaceVariables` performs,
   *     leaves no `{{...}}` behind.
   *
   * The rendering helper is a local re-implementation rather than the
   * real method because the whole module is mocked here; its three-line
   * body (a global `{{key}}` replace with a `value || ''` fallback) is
   * already covered by `server/services/EmailService.test.js`.
   *
   * SCOPE
   * =====
   *
   * Requirement 13.1's `team_path` is asserted exactly, computed by
   * walking the seeded hierarchy directly. The callsign is asserted to be
   * a non-empty string carrying the user's stored Callsign_Suffix as its
   * final segment -- its full derivation is Property 16's subject
   * (`TeamTransferService.test.js`), and restating it here would make one
   * requirement's failure surface as another's. Requirement 13.4 (a send
   * failure still leaves the committed transfer and a 200) belongs to
   * task 7.6's examples, and Requirement 13.2 (the seeded row) to the
   * migration test; neither is re-asserted here.
   */
  describe('Property 24: The transfer notification is complete and correctly suppressed', () => {
    /**
     * Six Teams under ONE Organisation root, so the Requirement 11.6
     * Organisation re-check can never fire and every generated approval
     * either sends a notification or is suppressed -- never rejected:
     *
     *   Org (P24ORG)
     *    +- Source (P24SRC)
     *    +- DestA  (P24DSTA)          <- destination 0, chain depth 1
     *    |   +- DestB (P24DSTB)       <- destination 1, chain depth 2
     *    +- Mid    (callsign_prefix NULL)
     *        +- DestC (P24DSTC)       <- destination 2, chain depth 2
     *
     * `Mid` deliberately holds a NULL `callsign_prefix`: its segment of
     * the DestC path must fall back to the Team's `name`, which is the
     * one branch of step 4's `callsign_prefix || name` segment mapping
     * that a prefix-everywhere fixture would never reach.
     */
    const p24TeamIds = [];
    let p24Org;
    let p24SourceTeam;
    let p24Destinations;

    // The Initiating_Admin recorded in `requester_email`/`initiated_by`.
    // Requirement 13.1's notification goes to the TRANSFERRED user, not
    // to this address, so keeping the two distinct is what makes the
    // recipient assertion below meaningful.
    let p24InitiatorId;
    let p24InitiatorEmail;

    // The real seeded template, read once. Every assertion about
    // completeness is made against this text rather than a copy of it, so
    // a later edit to the migration's body that adds a fourth variable
    // fails this property instead of silently passing.
    let p24Template;

    beforeAll(async () => {
      const insertTeam = async (label, prefix, parentId) => {
        const result = await pool.query(
          `INSERT INTO teams (name, callsign_prefix, parent_team_id) VALUES ($1, $2, $3)
           RETURNING id, name, callsign_prefix`,
          [`P24 ${label} ${crypto.randomUUID()}`, prefix, parentId]
        );
        p24TeamIds.push(result.rows[0].id);
        return result.rows[0];
      };

      p24Org = await insertTeam('Org', 'P24ORG', null);
      p24SourceTeam = await insertTeam('Source', 'P24SRC', p24Org.id);
      const destA = await insertTeam('DestA', 'P24DSTA', p24Org.id);
      const destB = await insertTeam('DestB', 'P24DSTB', destA.id);
      const mid = await insertTeam('Mid', null, p24Org.id);
      const destC = await insertTeam('DestC', 'P24DSTC', mid.id);

      // Each entry carries its own root-first Ancestor_Chain as seeded
      // data, so the expected `team_path` is a walk of the fixture rather
      // than a second call to `Team.getAncestorChain`.
      p24Destinations = [
        { team: destA, chain: [p24Org, destA] },
        { team: destB, chain: [p24Org, destA, destB] },
        { team: destC, chain: [p24Org, mid, destC] }
      ];

      const initiatorUsername = `p24-initiator-${crypto.randomUUID()}`;
      const initiator = await pool.query(
        `INSERT INTO users (username, email, first_name, last_name) VALUES ($1, $2, $3, $4)
         RETURNING id, email`,
        [initiatorUsername, `${initiatorUsername}@example.invalid`, 'Prop', 'TwentyFour']
      );
      p24InitiatorId = initiator.rows[0].id;
      p24InitiatorEmail = initiator.rows[0].email;

      const templateResult = await pool.query(
        `SELECT subject_template, body_template FROM email_templates WHERE template_key = $1`,
        ['team_transfer_completed']
      );

      if (templateResult.rows.length === 0) {
        throw new Error(
          'The `team_transfer_completed` email_templates row is missing. It is seeded by ' +
            'database/migrations/1786930000000_seed-team-transfer-completed-email-template.cjs, ' +
            'so this test database is not migrated to head.'
        );
      }

      p24Template = templateResult.rows[0];
    });

    afterAll(async () => {
      if (p24InitiatorId != null) {
        // `audit_logs.user_id` has no ON DELETE action, so any audit row
        // this block's users wrote must go before the user itself.
        await pool.query('DELETE FROM audit_logs WHERE user_id = $1', [p24InitiatorId]);
        await pool.query('DELETE FROM team_memberships WHERE user_id = $1', [p24InitiatorId]);
        await pool.query('DELETE FROM users WHERE id = $1', [p24InitiatorId]);
      }
      // Deepest-first, so `teams.parent_team_id` never blocks a delete.
      for (const teamId of [...p24TeamIds].reverse()) {
        await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
      }
    });

    /**
     * `EmailService.replaceVariables`, re-implemented locally because the
     * whole module is mocked in this file (see the block comment above).
     * The `value || ''` fallback is production's, not a simplification:
     * it is what makes a null or empty `first_name` substitute to an
     * empty string rather than leaving `{{first_name}}` in the body.
     */
    const renderTemplate = (template, variables) => {
      let result = template;
      for (const [key, value] of Object.entries(variables)) {
        result = result.replace(new RegExp(`{{${key}}}`, 'g'), value || '');
      }
      return result;
    };

    const UNSUBSTITUTED = /{{[^{}]*}}/;

    /** Every `{{token}}` the real template text asks to be substituted. */
    const templateTokens = (...templates) => {
      const tokens = new Set();
      for (const template of templates) {
        for (const match of template.matchAll(/{{\s*([^{}\s]+)\s*}}/g)) {
          tokens.add(match[1]);
        }
      }
      return tokens;
    };

    /**
     * The generated scenario:
     *
     *  - `destinationIndex` picks one of the three destinations above, so
     *    the path has two or three segments and the NULL-prefix fallback
     *    is reached.
     *  - `isTeamDevice` is the suppression switch of Requirement 13.5 --
     *    a fair coin, so both halves of the biconditional are exercised
     *    across ~100 runs.
     *  - `firstName` spans an ordinary name, a two-word name, non-ASCII
     *    graphemes, the empty string, and NULL. The last two are the
     *    reason `{{first_name}}` could survive into a sent body at all:
     *    a naive substitution that skips falsy values would leave the
     *    placeholder visible to the recipient. Braces are deliberately
     *    NOT generated -- a `{{...}}` arriving through the DATA would
     *    fail the residual check while saying nothing about the template.
     *  - `callsignSuffix` is either a stored suffix (mixed case and
     *    non-ASCII included, since the Name segment is the user's own
     *    text) or NULL, which yields a prefix-only callsign.
     *  - `priorRole` covers both Direct_Membership roles, so the admin
     *    demotion path notifies identically.
     */
    const p24ScenarioArb = fc.record({
      destinationIndex: fc.integer({ min: 0, max: 2 }),
      isTeamDevice: fc.boolean(),
      firstName: fc.constantFrom('Ada', 'Grace Hopper', 'Ārana', 'テスト', '', null),
      callsignSuffix: fc.constantFrom('J.Doe', 'a.smith', 'Ō.Rua', null),
      priorRole: fc.constantFrom('member', 'admin')
    });

    // Feature: team-member-transfer, Property 24: The transfer notification is complete and correctly suppressed
    test.prop([p24ScenarioArb], { numRuns: 100 })(
      'approving a team_change request sends exactly one team_transfer_completed email to the Transferred_User, whose rendered subject and body retain no unsubstituted {{...}} placeholder and carry the Destination_Team path and computed callsign, if and only if the user is not a team-owned device -- for which nothing at all is sent',
      async (scenario) => {
        const destination = p24Destinations[scenario.destinationIndex];

        // Both expectations are walks of the seeded/generated data. The
        // path maps every segment but the last to `callsign_prefix ||
        // name` and the last to the Team's full `name`, joined with
        // ' - ' -- the mapping and separator Requirement 13.1's copy
        // shares with the approval and denial emails.
        const expectedTeamPath = destination.chain
          .map((team, index) =>
            index === destination.chain.length - 1 ? team.name : team.callsign_prefix || team.name
          )
          .join(' - ');
        const expectedSuppressed = scenario.isTeamDevice;

        const username = `p24-user-${crypto.randomUUID()}`;
        const userResult = await pool.query(
          `INSERT INTO users (username, email, first_name, last_name, callsign_suffix, is_team_device)
           VALUES ($1, $2, $3, 'TwentyFour', $4, $5)
           RETURNING id, email`,
          [
            username,
            `${username}@example.invalid`,
            scenario.firstName,
            scenario.callsignSuffix,
            scenario.isTeamDevice
          ]
        );
        const userId = userResult.rows[0].id;
        const userEmail = userResult.rows[0].email;

        let accessRequestId = null;

        try {
          await pool.query(
            `INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3)`,
            [p24SourceTeam.id, userId, scenario.priorRole]
          );

          const inserted = await pool.query(
            `INSERT INTO access_requests
               (request_type, requester_email, requester_first_name, requester_last_name,
                existing_user_id, current_team_id, target_team_id, approval_team_id,
                initiated_by, email_verified, justification)
             VALUES ('team_change', $1, 'Prop', 'TwentyFour', $2, $3, $4, $5, $6, true, $7)
             RETURNING id`,
            [
              p24InitiatorEmail,
              userId,
              p24SourceTeam.id,
              destination.team.id,
              p24SourceTeam.id,
              p24InitiatorId,
              'Property 24 notification scenario'
            ]
          );
          accessRequestId = inserted.rows[0].id;

          mockSendEmail.mockClear();

          const res = await request(app).post(`/api/requests/${accessRequestId}/approve`).send({});

          expect(res.status).toBe(200);

          // The transfer must really have committed in BOTH halves --
          // otherwise "no email was sent" would be satisfied by a
          // transfer that never happened, which is not what Requirement
          // 13.5 says.
          const directRows = await pool.query(
            `SELECT team_id FROM team_memberships
              WHERE user_id = $1 AND inherited_from_team_id IS NULL`,
            [userId]
          );
          expect(directRows.rows).toHaveLength(1);
          expect(directRows.rows[0].team_id).toBe(destination.team.id);

          const transferEmails = mockSendEmail.mock.calls.filter(
            ([, templateKey]) => templateKey === 'team_transfer_completed'
          );

          if (expectedSuppressed) {
            // Requirement 13.5: a Team_Owned_Device holds a synthetic,
            // non-deliverable address, so NOTHING is sent to it -- not
            // through this template, and not through any other.
            expect(transferEmails).toHaveLength(0);
            expect(mockSendEmail.mock.calls.filter(([to]) => to === userEmail)).toHaveLength(0);
          } else {
            expect(transferEmails).toHaveLength(1);

            const [recipient, , variables] = transferEmails[0];

            // Requirement 13.1: the Transferred_User's own address.
            expect(recipient).toBe(userEmail);

            // Requirement 13.3 (widened): exactly the four documented
            // variables -- `username` was added alongside the original
            // three so the template can render the same blue Team/
            // Username/TAK-Callsign info box `access_request_approved`
            // uses.
            expect(Object.keys(variables).sort()).toEqual(['callsign', 'first_name', 'team_path', 'username']);
            expect(variables.first_name).toBe(scenario.firstName || '');
            expect(variables.team_path).toBe(expectedTeamPath);
            expect(variables.username).toBe(username);

            // The callsign is asserted only as far as Requirement 13.1
            // states -- present, non-empty, and ending in the stored
            // Callsign_Suffix when there is one. Its derivation is
            // Property 16's.
            expect(typeof variables.callsign).toBe('string');
            expect(variables.callsign.length).toBeGreaterThan(0);
            if (scenario.callsignSuffix !== null) {
              expect(variables.callsign.endsWith(`-${scenario.callsignSuffix}`)).toBe(true);
            }

            // Completeness, part 1: no variable the real template asks
            // for is missing from what the service passed.
            const suppliedKeys = new Set(Object.keys(variables));
            const requiredTokens = [
              ...templateTokens(p24Template.subject_template, p24Template.body_template)
            ];
            expect(requiredTokens.length).toBeGreaterThan(0);
            expect(requiredTokens.filter((token) => !suppliedKeys.has(token))).toEqual([]);

            // Completeness, part 2: rendering the real template with
            // those variables leaves no placeholder for the recipient to
            // read, and the two facts Requirement 13.1 promises are
            // actually in the body.
            const renderedSubject = renderTemplate(p24Template.subject_template, variables);
            const renderedBody = renderTemplate(p24Template.body_template, variables);

            expect(renderedSubject).not.toMatch(UNSUBSTITUTED);
            expect(renderedBody).not.toMatch(UNSUBSTITUTED);
            expect(renderedBody).toContain(expectedTeamPath);
            expect(renderedBody).toContain(variables.callsign);
          }
        } finally {
          // Per-run cleanup in FK order, so 100 runs leave no residue for
          // the next generated scenario to interact with. `audit_logs`
          // holds a non-cascading FK into `users`, and an approved
          // transfer writes TWO rows: the route's own `access_request`
          // row and `applyPostCommitEffects`'s `user.team_transfer` one.
          await pool.query(
            `DELETE FROM audit_logs WHERE resource_type = 'user' AND resource_id = $1`,
            [userId]
          );
          if (accessRequestId !== null) {
            await pool.query(
              `DELETE FROM audit_logs
                WHERE resource_type = 'access_request' AND resource_id = $1`,
              [accessRequestId]
            );
            await pool.query('DELETE FROM access_requests WHERE id = $1', [accessRequestId]);
          }
          await pool.query('DELETE FROM channel_memberships WHERE user_id = $1', [userId]);
          await pool.query('DELETE FROM team_memberships WHERE user_id = $1', [userId]);
          await pool.query('DELETE FROM sync_operations WHERE target_user_id = $1', [userId]);
          await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        }
      },
      180000
    );
  });

  /**
   * Feature: team-member-transfer, task 10.7 -- Property 25 (Requirements
   * 10.5, 14.1, 14.2, 14.3).
   *
   * Nested inside the outer describe for the same reason as Properties
   * 21-24 above: the outer `afterAll` calls `pool.end()`, so a sibling
   * top-level describe would run against a closed pool.
   *
   * WHAT IS OBSERVED, AND HOW
   * =========================
   *
   * `applyPostCommitEffects` step 5 is the only writer of an `audit_logs`
   * row with `action` of `user.team_transfer`. It runs after `COMMIT`,
   * through the shared `pool` rather than the transaction client, so the
   * row is readable here with an ordinary query as soon as the approve
   * response has returned. `details` is a `JSONB` column, so `pg` hands
   * back an already-parsed object.
   *
   * Every expected value is a walk of the generated scenario and the
   * seeded fixture. Each destination carries its own root-first
   * Ancestor_Chain as fixture data, so the expected `revokedChannelIds`
   * set is a filter over the channels this run made the user a member of
   * -- never a second call to `Team.getAncestorChain`, and never a re-run
   * of the revocation SQL.
   *
   * DISCRIMINATING FIXTURE
   * ======================
   *
   * The approving actor, the recorded `initiated_by`, the prior role, the
   * destination, the channel-membership set, and the supplied
   * Callsign_Suffix are generated independently of one another, and
   * neither approver is the outer `adminActor`. An implementation that
   * recorded a fixed actor id, the Transferred_User in place of the actor
   * (or vice versa), the destination in place of the source, the role the
   * user arrives with rather than the one they held, or an empty revoked
   * list could not pass.
   *
   * The four seeded Channels are all NON-primary and all hold a NULL
   * `authentik_group_id`: `addUserToTeam`'s additive half joins on
   * `c.is_primary = true`, so the user's Channel set is exactly the one
   * this run inserts, minus whatever the transfer revokes. Their owning
   * Teams span the three cases that matter -- the Source_Team (always
   * revoked), the Organisation root (always retained, since it is in
   * every destination's chain), a sibling Team outside both chains
   * (always revoked), and the deeper of the two destinations (retained
   * when it IS the destination, revoked when the shallower one is). The
   * last of those makes the expected set depend on the generated
   * destination rather than being a constant.
   *
   * SCOPE
   * =====
   *
   * Requirement 14.3 is asserted as the EXACT key set of `details`: every
   * transfer on this path went through a Transfer_Request, so `requestId`
   * and `initiatedBy` must always be present and no further key may
   * appear. The complementary half -- an immediate transfer, where
   * `viaRequest` is false and both keys are absent -- is reachable only
   * from `POST /api/users/:userId/transfer` and belongs to
   * `server/routes/users.transfer.integration.test.js`. Requirement 14.4
   * (an audit-insert failure still leaves the committed transfer and a
   * 200) is task 7.6's example, and the Channel end-state itself is
   * Property 3's; neither is re-asserted here.
   */
  describe('Property 25: Every completed transfer is audited with its full context', () => {
    /**
     * Five Teams under ONE Organisation root, so the Requirement 11.6
     * Organisation re-check can never fire and every generated approval
     * completes:
     *
     *   Org (P25ORG)
     *    +- Source (P25SRC)
     *    +- Other  (P25OTH)
     *    +- DestA  (P25DSTA)        <- destination 0, chain [Org, DestA]
     *        +- DestB (P25DSTB)     <- destination 1, chain [Org, DestA, DestB]
     */
    const p25TeamIds = [];
    const p25ChannelIds = [];
    let p25SourceTeamId;
    let p25Destinations;
    let p25Channels;

    // Two approving actors, neither of which is the outer `adminActor`,
    // and two Initiating_Admins. `audit_logs.user_id` is generated per
    // run from the first pair and `details.initiatedBy` from the second,
    // so the two ids can never be confused for one another.
    const p25ApproverIds = [];
    let p25Initiators;

    beforeAll(async () => {
      const insertTeam = async (label, prefix, parentId) => {
        const result = await pool.query(
          `INSERT INTO teams (name, callsign_prefix, parent_team_id) VALUES ($1, $2, $3) RETURNING id`,
          [`P25 ${label} ${crypto.randomUUID()}`, prefix, parentId]
        );
        p25TeamIds.push(result.rows[0].id);
        return result.rows[0].id;
      };

      const orgId = await insertTeam('Org', 'P25ORG', null);
      p25SourceTeamId = await insertTeam('Source', 'P25SRC', orgId);
      const otherTeamId = await insertTeam('Other', 'P25OTH', orgId);
      const destAId = await insertTeam('DestA', 'P25DSTA', orgId);
      const destBId = await insertTeam('DestB', 'P25DSTB', destAId);

      p25Destinations = [
        { teamId: destAId, chainTeamIds: [orgId, destAId] },
        { teamId: destBId, chainTeamIds: [orgId, destAId, destBId] }
      ];

      const insertChannel = async (label, teamId) => {
        const result = await pool.query(
          `INSERT INTO channels (name, display_name, team_id, is_primary, authentik_group_id)
           VALUES ($1, $2, $3, false, NULL)
           RETURNING id`,
          [`p25-${label}-${crypto.randomUUID()}`, `P25 ${label}`, teamId]
        );
        p25ChannelIds.push(result.rows[0].id);
        return { id: result.rows[0].id, teamId, label };
      };

      // Index order is the order the generated boolean tuple below
      // addresses these by.
      p25Channels = [
        await insertChannel('source', p25SourceTeamId),
        await insertChannel('org', orgId),
        await insertChannel('other', otherTeamId),
        await insertChannel('destB', destBId)
      ];

      const insertUser = async (prefix) => {
        const username = `${prefix}-${crypto.randomUUID()}`;
        const result = await pool.query(
          `INSERT INTO users (username, email, first_name, last_name) VALUES ($1, $2, $3, $4)
           RETURNING id, email`,
          [username, `${username}@example.invalid`, 'Prop', 'TwentyFive']
        );
        return result.rows[0];
      };

      const approverA = await insertUser('p25-approver-a');
      const approverB = await insertUser('p25-approver-b');
      p25ApproverIds.push(approverA.id, approverB.id);

      const initiatorA = await insertUser('p25-initiator-a');
      const initiatorB = await insertUser('p25-initiator-b');
      p25Initiators = [initiatorA, initiatorB];
    });

    afterAll(async () => {
      const p25UserIds = [...p25ApproverIds, ...p25Initiators.map((initiator) => initiator.id)];
      if (p25UserIds.length > 0) {
        // `audit_logs.user_id` has no ON DELETE action, so any audit row
        // this block's users wrote must go before the user itself. Scoped
        // to the ids created here.
        await pool.query('DELETE FROM audit_logs WHERE user_id = ANY($1)', [p25UserIds]);
        await pool.query('DELETE FROM team_memberships WHERE user_id = ANY($1)', [p25UserIds]);
        await pool.query('DELETE FROM users WHERE id = ANY($1)', [p25UserIds]);
      }
      if (p25ChannelIds.length > 0) {
        await pool.query('DELETE FROM channels WHERE id = ANY($1)', [p25ChannelIds]);
      }
      // Deepest-first, so `teams.parent_team_id` never blocks a delete.
      for (const teamId of [...p25TeamIds].reverse()) {
        await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
      }
    });

    /**
     * The generated scenario:
     *
     *  - `destinationIndex` picks DestA or DestB, which decides both
     *    `details.destinationTeamId` and whether the DestB Channel is in
     *    the revoked set.
     *  - `priorRole` spans both Direct_Membership roles. The `admin` half
     *    is Requirement 10.5's demotion record: the audit row must carry
     *    the role the user HELD, even though the row it was read from is
     *    deleted by `addUserToTeam` before the audit write happens.
     *  - `approverIndex` picks which of the two block-local approvers
     *    authenticates, i.e. the expected `audit_logs.user_id`.
     *  - `initiatorIndex` picks the Transfer_Request's `initiated_by`, or
     *    `null` for a row that records none -- Requirement 14.3 asks for
     *    "its `initiated_by` value", which is a present-but-null key when
     *    the column is null, not an absent one.
     *  - `channelMemberships` is one boolean per seeded Channel, so the
     *    expected `revokedChannelIds` ranges over the empty set, every
     *    proper subset, and the full set.
     *  - `requestCallsignSuffix` is the Transfer_Request's stored suffix:
     *    absent, an ordinary value, or a whitespace-padded one, since the
     *    service trims before it stores and the audit records the STORED
     *    value.
     *  - `storedCallsignSuffix` is the user's own prior suffix, which is
     *    Requirement 9.7's link (c). When it is the one that wins,
     *    `callsignSuffixApplied` is null -- this transfer applied no new
     *    suffix -- which is the value the audit must then carry.
     */
    const p25ScenarioArb = fc.record({
      destinationIndex: fc.integer({ min: 0, max: 1 }),
      priorRole: fc.constantFrom('member', 'admin'),
      approverIndex: fc.integer({ min: 0, max: 1 }),
      initiatorIndex: fc.constantFrom(0, 1, null),
      channelMemberships: fc.tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean()),
      requestCallsignSuffix: fc.constantFrom(null, 'J.Doe', '  Padded.Suffix  '),
      storedCallsignSuffix: fc.constantFrom(null, 'Stored.Value')
    });

    // Feature: team-member-transfer, Property 25: Every completed transfer is audited with its full context
    test.prop([p25ScenarioArb], { numRuns: 100 })(
      'approving a team_change request writes exactly one user.team_transfer audit row naming the Transferred_User as its resource and the approving actor as its user, whose details hold the source and destination team ids, the role held before the move, viaRequest true together with the request id and its initiated_by, the revoked channel ids, and the Callsign_Suffix this transfer applied -- and no other key',
      async (scenario) => {
        const destination = p25Destinations[scenario.destinationIndex];
        const approverId = p25ApproverIds[scenario.approverIndex];
        const initiator =
          scenario.initiatorIndex === null ? null : p25Initiators[scenario.initiatorIndex];

        // Every expectation below is computed from the generated scenario
        // and the seeded fixture alone.
        const selectedChannels = p25Channels.filter(
          (_, index) => scenario.channelMemberships[index]
        );
        const expectedRevokedChannelIds = selectedChannels
          .filter((channel) => !destination.chainTeamIds.includes(channel.teamId))
          .map((channel) => channel.id)
          .sort((a, b) => a - b);

        // Requirement 9.7's precedence chain as the audit sees it: the
        // Transfer_Request's suffix is link (b), and a transfer that
        // falls through to the user's own stored value (link (c)) applied
        // nothing, so it records null.
        const expectedCallsignSuffixApplied =
          scenario.requestCallsignSuffix === null ? null : scenario.requestCallsignSuffix.trim();

        const username = `p25-user-${crypto.randomUUID()}`;
        const userResult = await pool.query(
          `INSERT INTO users (username, email, first_name, last_name, callsign_suffix)
           VALUES ($1, $2, 'Trans', 'Ferred', $3)
           RETURNING id`,
          [username, `${username}@example.invalid`, scenario.storedCallsignSuffix]
        );
        const userId = userResult.rows[0].id;

        let accessRequestId = null;

        try {
          await pool.query(
            `INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3)`,
            [p25SourceTeamId, userId, scenario.priorRole]
          );

          for (const channel of selectedChannels) {
            await pool.query(
              `INSERT INTO channel_memberships (user_id, channel_id) VALUES ($1, $2)`,
              [userId, channel.id]
            );
          }

          const inserted = await pool.query(
            `INSERT INTO access_requests
               (request_type, requester_email, requester_first_name, requester_last_name,
                existing_user_id, current_team_id, target_team_id, approval_team_id,
                initiated_by, email_verified, justification, callsign_suffix)
             VALUES ('team_change', $1, 'Prop', 'TwentyFive', $2, $3, $4, $5, $6, true, $7, $8)
             RETURNING id`,
            [
              initiator === null ? `p25-no-initiator-${crypto.randomUUID()}@example.invalid` : initiator.email,
              userId,
              p25SourceTeamId,
              destination.teamId,
              p25SourceTeamId,
              initiator === null ? null : initiator.id,
              'Property 25 audit scenario',
              scenario.requestCallsignSuffix
            ]
          );
          accessRequestId = inserted.rows[0].id;

          mockUser = { id: approverId, userId: approverId, is_global_manager: true };

          const res = await request(app).post(`/api/requests/${accessRequestId}/approve`).send({});

          expect(res.status).toBe(200);

          // The transfer must really have completed -- an audit row
          // describing a move that did not happen would satisfy nothing
          // Requirement 14 is about.
          const directRows = await pool.query(
            `SELECT team_id, role FROM team_memberships
              WHERE user_id = $1 AND inherited_from_team_id IS NULL`,
            [userId]
          );
          expect(directRows.rows).toHaveLength(1);
          expect(directRows.rows[0].team_id).toBe(destination.teamId);
          expect(directRows.rows[0].role).toBe('member');

          // Matched on the action plus EITHER identifier, so a row
          // written against the wrong `resource_type`/`resource_id` is
          // still found (via `user_id`) and then fails the assertions
          // below, rather than being silently absent. Per-run cleanup
          // removes both shapes, so exactly one row can exist here.
          const auditRows = await pool.query(
            `SELECT user_id, resource_type, resource_id, details
               FROM audit_logs
              WHERE action = 'user.team_transfer'
                AND (resource_id = $1 OR user_id = ANY($2))
              ORDER BY id`,
            [userId, p25ApproverIds]
          );

          expect(auditRows.rows).toHaveLength(1);

          const auditRow = auditRows.rows[0];

          // Requirement 14.1.
          expect(auditRow.resource_type).toBe('user');
          expect(auditRow.resource_id).toBe(userId);
          expect(auditRow.user_id).toBe(approverId);

          // Requirements 14.2 and 14.3: exactly these keys, no more and
          // no fewer.
          const details = auditRow.details;
          expect(Object.keys(details).sort()).toEqual([
            'callsignSuffixApplied',
            'destinationTeamId',
            'initiatedBy',
            'priorRole',
            'requestId',
            'revokedChannelIds',
            'sourceTeamId',
            'viaRequest'
          ]);

          expect(details.sourceTeamId).toBe(p25SourceTeamId);
          expect(details.destinationTeamId).toBe(destination.teamId);

          // Requirement 10.5: the role held BEFORE the move, including
          // the `admin` demotion record.
          expect(details.priorRole).toBe(scenario.priorRole);

          // Requirement 14.3: this path is always via a Transfer_Request.
          expect(details.viaRequest).toBe(true);
          expect(details.requestId).toBe(accessRequestId);
          expect(details.initiatedBy).toBe(initiator === null ? null : initiator.id);

          // Revocation order is whatever the `DELETE ... RETURNING`
          // yields, so compare as sets.
          expect([...details.revokedChannelIds].sort((a, b) => a - b)).toEqual(
            expectedRevokedChannelIds
          );

          expect(details.callsignSuffixApplied).toBe(expectedCallsignSuffixApplied);
        } finally {
          // Per-run cleanup in FK order, so 100 runs leave no residue for
          // the next generated scenario to interact with. An approved
          // transfer writes TWO audit rows: the route's own
          // `access_request` row and `applyPostCommitEffects`'s
          // `user.team_transfer` one, the latter matched by the same
          // predicate the assertion used.
          mockUser = { id: adminActor.id, userId: adminActor.id, is_global_manager: true };
          await pool.query(
            `DELETE FROM audit_logs
              WHERE action = 'user.team_transfer'
                AND (resource_id = $1 OR user_id = ANY($2))`,
            [userId, p25ApproverIds]
          );
          if (accessRequestId !== null) {
            await pool.query(
              `DELETE FROM audit_logs
                WHERE resource_type = 'access_request' AND resource_id = $1`,
              [accessRequestId]
            );
            await pool.query('DELETE FROM access_requests WHERE id = $1', [accessRequestId]);
          }
          await pool.query('DELETE FROM channel_memberships WHERE user_id = $1', [userId]);
          await pool.query('DELETE FROM team_memberships WHERE user_id = $1', [userId]);
          await pool.query('DELETE FROM sync_operations WHERE target_user_id = $1', [userId]);
          await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        }
      },
      180000
    );
  });

  /**
   * Feature: team-member-transfer, task 10.10 -- concurrency and
   * approval-failure examples (Requirements 11.2, 11.3, 11.4, 11.5, 12.3,
   * 12.4).
   *
   * Nested inside the outer describe for the same reason as Properties
   * 21-25 above: the outer `afterAll` calls `pool.end()`, so a sibling
   * top-level describe would run against a closed pool.
   *
   * WHY THESE ARE EXAMPLES AND NOT A PROPERTY
   * =========================================
   *
   * Requirement 11.5 (an at-most-once guarantee under concurrent
   * approval) is deliberately NOT a property. The guarantee does not live
   * in application logic that varies with its input -- it lives in one
   * Postgres row lock, `FOR UPDATE OF ar` on `approveRequest`'s
   * transactional re-fetch. Two or three live concurrent transactions
   * exercise exactly the same lock acquisition that a hundred generated
   * ones would, at a hundredth of the wall-clock cost, so the coverage
   * here is two executions (two-way and three-way concurrency) rather
   * than a generator.
   *
   * The remaining cases are single-shot failure shapes with no input
   * space to explore: a dangling FK value, an already-decided row, the
   * denial email's recipient, and a rejected email send.
   *
   * HOW A DANGLING FK VALUE IS CREATED
   * ==================================
   *
   * Requirements 11.2 and 11.3 describe an `existing_user_id` /
   * `target_team_id` that "names no row" in its referenced table. Both
   * columns carry a real foreign key with no `ON DELETE` action
   * (`access_requests_existing_user_id_fkey`,
   * `access_requests_target_team_id_fkey`), and neither is `DEFERRABLE`,
   * so the referenced row can be neither deleted afterwards nor absent at
   * insert time through ordinary SQL -- the state the requirement
   * describes is reachable only by suspending referential integrity for
   * the one insert that creates it.
   *
   * `insertTransferRequestBypassingForeignKeys` does that with
   * `SET LOCAL session_replication_role = 'replica'`, which makes
   * Postgres skip the internal RI trigger enforcing the constraint. It is
   * `SET LOCAL`, so it reverts at `COMMIT` and the pooled connection
   * returns to the pool with the default in place; it touches no DDL, so
   * it takes no `ACCESS EXCLUSIVE` lock and cannot outlive the
   * transaction. `access_requests` carries no user-defined triggers (only
   * the internal RI ones), so nothing else is suppressed along with it.
   * It does require the connecting role to be a superuser, which the
   * `postgres` role this file's connection convention already defaults to
   * is.
   *
   * Substituting `NULL` for a dangling id would be a weaker test of the
   * same code: `approveRequest`'s guards are `SELECT 1 FROM users WHERE
   * id = $1` and `SELECT 1 FROM teams WHERE id = $1`, and a `NULL`
   * parameter satisfies them vacuously (zero rows) without any
   * referential integrity ever having been violated -- so a guard that
   * only ever rejected `NULL` would pass, while the requirement's actual
   * subject, an id that once resolved and no longer does, would not be
   * covered.
   *
   * SCOPE
   * =====
   *
   * Requirement 11.1 (staleness) is Property 21's, 12.1 (the four columns
   * a denial writes) is Property 22's, and 12.5/12.6 (the reason's
   * bounds) are Property 23's; none is re-asserted here.
   */
  describe('Transfer_Request concurrency and approval/denial failure examples (task 10.10)', () => {
    /**
     * Org (root) -> Source, Destination, both under ONE Organisation, so
     * the Requirement 11.6 Organisation re-check can never fire and every
     * rejection observed below is the one its own example is about.
     *
     * `sourceChannel` is a NON-primary Channel owned by Source holding a
     * NULL `authentik_group_id`. Non-primary matters because
     * `addUserToTeam`'s additive half joins on `c.is_primary = true`, so a
     * membership in this Channel is one the transfer can only ever REVOKE,
     * never re-create -- which is what makes it a usable witness for "no
     * membership change" below.
     */
    const t1010TeamIds = [];
    let t1010SourceTeamId;
    let t1010DestinationTeamId;
    let t1010SourceChannelId;

    // The Initiating_Admin: the address a Transfer_Request records in
    // `requester_email` and the id it records in `initiated_by`, i.e. the
    // admin Requirement 12.3 says the denial is reported back to. Kept
    // distinct from both the Transferred_User and the outer `adminActor`,
    // so "the denial email reached the Initiating_Admin" cannot be
    // satisfied by an implementation that mailed either of the others.
    let t1010InitiatorId;
    let t1010InitiatorEmail;

    beforeAll(async () => {
      const insertTeam = async (label, prefix, parentId) => {
        const result = await pool.query(
          `INSERT INTO teams (name, callsign_prefix, parent_team_id) VALUES ($1, $2, $3) RETURNING id`,
          [`T1010 ${label} ${crypto.randomUUID()}`, prefix, parentId]
        );
        t1010TeamIds.push(result.rows[0].id);
        return result.rows[0].id;
      };

      const orgId = await insertTeam('Org', 'T1010ORG', null);
      t1010SourceTeamId = await insertTeam('Source', 'T1010SRC', orgId);
      t1010DestinationTeamId = await insertTeam('Dest', 'T1010DST', orgId);

      const channelResult = await pool.query(
        `INSERT INTO channels (name, display_name, team_id, is_primary, authentik_group_id)
         VALUES ($1, $2, $3, false, NULL)
         RETURNING id`,
        [`t1010-source-${crypto.randomUUID()}`, 'T1010 Source Channel', t1010SourceTeamId]
      );
      t1010SourceChannelId = channelResult.rows[0].id;

      const initiatorUsername = `t1010-initiator-${crypto.randomUUID()}`;
      const initiator = await pool.query(
        `INSERT INTO users (username, email, first_name, last_name) VALUES ($1, $2, $3, $4)
         RETURNING id, email`,
        [initiatorUsername, `${initiatorUsername}@example.invalid`, 'Task', 'TenTen']
      );
      t1010InitiatorId = initiator.rows[0].id;
      t1010InitiatorEmail = initiator.rows[0].email;
    });

    afterAll(async () => {
      if (t1010InitiatorId != null) {
        // `audit_logs.user_id` has no ON DELETE action, so any audit row
        // this block's users wrote must go before the user itself.
        await pool.query('DELETE FROM audit_logs WHERE user_id = $1', [t1010InitiatorId]);
        await pool.query('DELETE FROM team_memberships WHERE user_id = $1', [t1010InitiatorId]);
        await pool.query('DELETE FROM users WHERE id = $1', [t1010InitiatorId]);
      }
      if (t1010SourceChannelId != null) {
        await pool.query('DELETE FROM channels WHERE id = $1', [t1010SourceChannelId]);
      }
      // Deepest-first, so `teams.parent_team_id` never blocks a delete.
      for (const teamId of [...t1010TeamIds].reverse()) {
        await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
      }
    });

    /** A Transferred_User with a Direct_Membership in the Source_Team. */
    const seedTransferredUser = async (priorRole) => {
      const username = `t1010-user-${crypto.randomUUID()}`;
      const result = await pool.query(
        `INSERT INTO users (username, email, first_name, last_name) VALUES ($1, $2, $3, $4)
         RETURNING id, email`,
        [username, `${username}@example.invalid`, 'Trans', 'Ferred']
      );
      const user = result.rows[0];
      await pool.query(
        `INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3)`,
        [t1010SourceTeamId, user.id, priorRole]
      );
      return user;
    };

    /** A pending Transfer_Request from the Source_Team to the Destination_Team. */
    const seedTransferRequest = async (userId, justification) => {
      const result = await pool.query(
        `INSERT INTO access_requests
           (request_type, requester_email, requester_first_name, requester_last_name,
            existing_user_id, current_team_id, target_team_id, approval_team_id,
            initiated_by, email_verified, justification)
         VALUES ('team_change', $1, 'Task', 'TenTen', $2, $3, $4, $5, $6, true, $7)
         RETURNING id`,
        [
          t1010InitiatorEmail,
          userId,
          t1010SourceTeamId,
          t1010DestinationTeamId,
          t1010SourceTeamId,
          t1010InitiatorId,
          justification
        ]
      );
      return result.rows[0].id;
    };

    /**
     * Inserts a Transfer_Request whose `existing_user_id` and/or
     * `target_team_id` name no row in their referenced table, by
     * suspending referential integrity for the duration of the insert
     * alone. See this describe's block comment for why this is the only
     * way to reach the state Requirements 11.2 and 11.3 describe, and why
     * `SET LOCAL` makes it safe.
     */
    const insertTransferRequestBypassingForeignKeys = async ({ existingUserId, targetTeamId }) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL session_replication_role = 'replica'");
        const result = await client.query(
          `INSERT INTO access_requests
             (request_type, requester_email, requester_first_name, requester_last_name,
              existing_user_id, current_team_id, target_team_id, approval_team_id,
              initiated_by, email_verified, justification)
           VALUES ('team_change', $1, 'Task', 'TenTen', $2, $3, $4, $5, $6, true, $7)
           RETURNING id`,
          [
            t1010InitiatorEmail,
            existingUserId,
            t1010SourceTeamId,
            targetTeamId,
            t1010SourceTeamId,
            t1010InitiatorId,
            'Task 10.10 dangling-reference scenario'
          ]
        );
        await client.query('COMMIT');
        return result.rows[0].id;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };

    /** An id that resolves to no row in the given table. */
    const nonExistentId = async (table) => {
      const result = await pool.query(`SELECT COALESCE(MAX(id), 0) + 1000000 AS id FROM ${table}`);
      return Number(result.rows[0].id);
    };

    /**
     * Every membership row the Transferred_User holds, ordered so two
     * snapshots compare directly with `toEqual`.
     */
    const snapshotMemberships = async (userId) => {
      const teamMemberships = await pool.query(
        `SELECT team_id, role, inherited_from_team_id
           FROM team_memberships
          WHERE user_id = $1
          ORDER BY team_id, inherited_from_team_id NULLS FIRST`,
        [userId]
      );
      const channelMemberships = await pool.query(
        `SELECT channel_id, permission
           FROM channel_memberships
          WHERE user_id = $1
          ORDER BY channel_id`,
        [userId]
      );
      return { teamMemberships: teamMemberships.rows, channelMemberships: channelMemberships.rows };
    };

    /** How many `user.team_transfer` audit rows name this user. */
    const countTransferAuditRows = async (userId) => {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS count
           FROM audit_logs
          WHERE action = 'user.team_transfer' AND resource_type = 'user' AND resource_id = $1`,
        [userId]
      );
      return result.rows[0].count;
    };

    /** Per-example teardown, in FK order. */
    const cleanupExample = async ({ userId = null, requestIds = [] } = {}) => {
      mockUser = { id: adminActor.id, userId: adminActor.id, is_global_manager: true };
      if (userId !== null) {
        await pool.query(
          `DELETE FROM audit_logs WHERE resource_type = 'user' AND resource_id = $1`,
          [userId]
        );
      }
      const ids = requestIds.filter((id) => id != null);
      if (ids.length > 0) {
        await pool.query(
          `DELETE FROM audit_logs
            WHERE resource_type = 'access_request' AND resource_id = ANY($1)`,
          [ids]
        );
        await pool.query('DELETE FROM access_requests WHERE id = ANY($1)', [ids]);
      }
      if (userId !== null) {
        await pool.query('DELETE FROM channel_memberships WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM team_memberships WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM sync_operations WHERE target_user_id = $1', [userId]);
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      }
    };

    // -----------------------------------------------------------------
    // Requirement 11.5: at-most-once under concurrent approval
    // -----------------------------------------------------------------

    /**
     * Both concurrency counts run the same scenario: one `pending`
     * Transfer_Request, N approvals dispatched together against the real
     * database.
     *
     * `Promise.all` over supertest `Test` objects starts every request in
     * the same tick (a `Test` dispatches when `.then` is first called), so
     * all N reach `approveRequest`'s Phase 1 pre-fetch -- which runs
     * OUTSIDE any transaction and therefore admits all of them -- before
     * any has finished. Arbitration happens in Phase 2, where
     * `FOR UPDATE OF ar` serialises them: the first locks the row and
     * commits `status = 'approved'`; each later one blocks on the lock,
     * then re-evaluates `WHERE ar.status = 'pending'` against the
     * now-committed row version, matches zero rows, and throws
     * 'Request not found or already processed' into a `ROLLBACK`.
     *
     * The assertions do not depend on the interleaving actually
     * overlapping -- a run in which one approval happens to finish before
     * the next begins is the sequential already-processed case and yields
     * the same counts -- so the example is deterministic while still
     * exercising the lock on essentially every run.
     *
     * "Exactly one set of membership writes" is asserted three ways: one
     * Direct_Membership row (naming the destination, demoted to `member`),
     * no row naming the Source_Team at all, and exactly ONE
     * `user.team_transfer` audit row. The last is the sharpest of the
     * three, because `applyPostCommitEffects` runs only after a
     * successful `COMMIT`: a second approval that slipped through would
     * write a second audit row even where
     * `team_memberships_user_id_team_id_key` had swallowed its duplicate
     * membership insert.
     */
    it.each([[2], [3]])(
      'Requirement 11.5: %i concurrent approvals of one pending Transfer_Request apply the transfer at most once -- exactly one 200, and exactly one set of membership writes',
      async (concurrency) => {
        // `admin`, so a second application of the transfer would have a
        // role change to make as well as a team change.
        const transferredUser = await seedTransferredUser('admin');
        let accessRequestId = null;

        try {
          accessRequestId = await seedTransferRequest(
            transferredUser.id,
            `Task 10.10 ${concurrency}-way concurrent approval`
          );

          const responses = await Promise.all(
            Array.from({ length: concurrency }, () =>
              request(app).post(`/api/requests/${accessRequestId}/approve`).send({})
            )
          );

          const succeeded = responses.filter((res) => res.status === 200);
          const failed = responses.filter((res) => res.status !== 200);

          expect(succeeded).toHaveLength(1);
          expect(failed).toHaveLength(concurrency - 1);
          for (const res of failed) {
            expect(res.status).toBeGreaterThanOrEqual(400);
          }

          // The row itself carries exactly one decision.
          const dbRequest = await pool.query(
            'SELECT status, processed_by, processed_at, denial_reason FROM access_requests WHERE id = $1',
            [accessRequestId]
          );
          expect(dbRequest.rows[0].status).toBe('approved');
          expect(dbRequest.rows[0].processed_by).toBe(adminActor.id);
          expect(dbRequest.rows[0].processed_at).not.toBeNull();
          expect(dbRequest.rows[0].denial_reason).toBeNull();

          // One membership end-state, not N.
          const directRows = await pool.query(
            `SELECT team_id, role FROM team_memberships
              WHERE user_id = $1 AND inherited_from_team_id IS NULL`,
            [transferredUser.id]
          );
          expect(directRows.rows).toHaveLength(1);
          expect(directRows.rows[0].team_id).toBe(t1010DestinationTeamId);
          expect(directRows.rows[0].role).toBe('member');

          const sourceRows = await pool.query(
            'SELECT 1 FROM team_memberships WHERE user_id = $1 AND team_id = $2',
            [transferredUser.id, t1010SourceTeamId]
          );
          expect(sourceRows.rows).toHaveLength(0);

          // One transfer happened, so one transfer was audited.
          expect(await countTransferAuditRows(transferredUser.id)).toBe(1);
        } finally {
          await cleanupExample({ userId: transferredUser.id, requestIds: [accessRequestId] });
        }
      },
      60000
    );

    // -----------------------------------------------------------------
    // Requirements 11.2 and 11.3: dangling references
    // -----------------------------------------------------------------

    it('Requirement 11.2: approving a Transfer_Request whose existing_user_id names no users row responds with an error status and leaves the row pending', async () => {
      const danglingUserId = await nonExistentId('users');
      let accessRequestId = null;

      try {
        accessRequestId = await insertTransferRequestBypassingForeignKeys({
          existingUserId: danglingUserId,
          targetTeamId: t1010DestinationTeamId
        });

        const res = await request(app).post(`/api/requests/${accessRequestId}/approve`).send({});

        expect(res.status).toBeGreaterThanOrEqual(400);

        const dbRequest = await pool.query(
          'SELECT status, processed_by, processed_at FROM access_requests WHERE id = $1',
          [accessRequestId]
        );
        expect(dbRequest.rows[0].status).toBe('pending');
        expect(dbRequest.rows[0].processed_by).toBeNull();
        expect(dbRequest.rows[0].processed_at).toBeNull();

        // The rollback also means nothing was written on the dangling id's
        // behalf -- neither a membership nor a post-commit audit row.
        const memberships = await pool.query(
          'SELECT 1 FROM team_memberships WHERE user_id = $1',
          [danglingUserId]
        );
        expect(memberships.rows).toHaveLength(0);
        expect(await countTransferAuditRows(danglingUserId)).toBe(0);
      } finally {
        await cleanupExample({ requestIds: [accessRequestId] });
      }
    });

    it('Requirement 11.3: approving a Transfer_Request whose target_team_id names no teams row responds with an error status, leaves the row pending, and moves nothing', async () => {
      const transferredUser = await seedTransferredUser('member');
      const danglingTeamId = await nonExistentId('teams');
      let accessRequestId = null;

      try {
        await pool.query(
          `INSERT INTO channel_memberships (user_id, channel_id) VALUES ($1, $2)`,
          [transferredUser.id, t1010SourceChannelId]
        );

        const before = await snapshotMemberships(transferredUser.id);

        accessRequestId = await insertTransferRequestBypassingForeignKeys({
          existingUserId: transferredUser.id,
          targetTeamId: danglingTeamId
        });

        const res = await request(app).post(`/api/requests/${accessRequestId}/approve`).send({});

        expect(res.status).toBeGreaterThanOrEqual(400);

        const dbRequest = await pool.query(
          'SELECT status, processed_by, processed_at FROM access_requests WHERE id = $1',
          [accessRequestId]
        );
        expect(dbRequest.rows[0].status).toBe('pending');
        expect(dbRequest.rows[0].processed_by).toBeNull();
        expect(dbRequest.rows[0].processed_at).toBeNull();

        // Here there IS a real Transferred_User to observe, so the
        // rollback is checked over every membership row they hold --
        // including the Source_Team Channel a partially-applied transfer
        // would have revoked.
        expect(await snapshotMemberships(transferredUser.id)).toEqual(before);
        expect(await countTransferAuditRows(transferredUser.id)).toBe(0);
      } finally {
        await cleanupExample({ userId: transferredUser.id, requestIds: [accessRequestId] });
      }
    });

    // -----------------------------------------------------------------
    // Requirement 11.4: a non-pending row
    // -----------------------------------------------------------------

    /**
     * The second approval here is aimed at a row that is already
     * `approved` while the Transferred_User's own state has been reset to
     * the shape the row still describes: a Direct_Membership in the
     * Source_Team, plus a membership in the Source_Team's Channel.
     *
     * That reset is what makes the example discriminating. The row's
     * `current_team_id` matches the user's actual Team again, both Teams
     * are still in one Organisation, and neither FK dangles -- so
     * staleness (11.1), the Organisation re-check (11.6), and the
     * dangling-reference guards (11.2/11.3) would all pass. The ONLY
     * thing standing between the second approval and a second transfer is
     * `status` no longer being `pending`, so an implementation that failed
     * to check it would move the user again and be caught here.
     */
    it('Requirement 11.4: approving an already-approved Transfer_Request responds with an error status and makes no membership change', async () => {
      const transferredUser = await seedTransferredUser('admin');
      let accessRequestId = null;

      try {
        accessRequestId = await seedTransferRequest(
          transferredUser.id,
          'Task 10.10 already-approved scenario'
        );

        const firstRes = await request(app).post(`/api/requests/${accessRequestId}/approve`).send({});
        expect(firstRes.status).toBe(200);

        const afterFirst = await pool.query(
          'SELECT status, processed_by, processed_at FROM access_requests WHERE id = $1',
          [accessRequestId]
        );
        expect(afterFirst.rows[0].status).toBe('approved');

        // Reset the Transferred_User to the state the already-approved row
        // still describes, so every guard other than the status check
        // would admit a second approval.
        await pool.query('DELETE FROM channel_memberships WHERE user_id = $1', [transferredUser.id]);
        await pool.query('DELETE FROM team_memberships WHERE user_id = $1', [transferredUser.id]);
        await pool.query(
          `INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'admin')`,
          [t1010SourceTeamId, transferredUser.id]
        );
        await pool.query(
          `INSERT INTO channel_memberships (user_id, channel_id) VALUES ($1, $2)`,
          [transferredUser.id, t1010SourceChannelId]
        );

        const before = await snapshotMemberships(transferredUser.id);
        const auditRowsBefore = await countTransferAuditRows(transferredUser.id);
        expect(auditRowsBefore).toBe(1);

        const secondRes = await request(app).post(`/api/requests/${accessRequestId}/approve`).send({});

        expect(secondRes.status).toBeGreaterThanOrEqual(400);

        expect(await snapshotMemberships(transferredUser.id)).toEqual(before);
        expect(await countTransferAuditRows(transferredUser.id)).toBe(auditRowsBefore);

        const afterSecond = await pool.query(
          'SELECT status, processed_by, processed_at FROM access_requests WHERE id = $1',
          [accessRequestId]
        );
        expect(afterSecond.rows[0].status).toBe('approved');
        expect(afterSecond.rows[0].processed_at).toEqual(afterFirst.rows[0].processed_at);
      } finally {
        await cleanupExample({ userId: transferredUser.id, requestIds: [accessRequestId] });
      }
    });

    // -----------------------------------------------------------------
    // Requirements 12.3 and 12.4: the denial email
    // -----------------------------------------------------------------

    /**
     * Requirement 12.3 has two halves:
     *
     *  - the recipient is the Initiating_Admin's address (the
     *    Transfer_Request's `requester_email`), NOT the Transferred_User's
     *    -- the two are distinct rows here, so mailing the wrong one is
     *    visible;
     *  - the submitted reason is what gets sent. The observable seam is
     *    `sendDenialEmail(email, { denialReason })`, whose value this
     *    example pins to the reason the route received, TRIMMED, since
     *    `body('denialReason').trim()` sanitises in place.
     *
     * The remaining hop -- `sendDenialEmail` placing that value in the
     * `{{denial_reason}}` position of the `access_request_denied`
     * template's body -- is deliberately not re-asserted here. It belongs
     * to `EmailService`, which is mocked in this file and whose own
     * `server/services/EmailService.test.js` already pins that exact
     * template key and variable name. It is also unobservable against this
     * database: unlike `team_transfer_completed` (which Property 24 reads
     * from the row migration 1786930000000 seeds), the
     * `access_request_denied` row is created by `database/init.js` rather
     * than by any migration, so a database migrated to head does not hold
     * it at all.
     */
    it('Requirement 12.3: denying a Transfer_Request sends the denial email to the Initiating_Admin, carrying the submitted reason', async () => {
      const transferredUser = await seedTransferredUser('member');
      const denialReason = 'Destination team is at capacity until the next roster cycle';
      let accessRequestId = null;

      try {
        accessRequestId = await seedTransferRequest(
          transferredUser.id,
          'Task 10.10 denial-email scenario'
        );

        mockSendDenialEmail.mockClear();

        const res = await request(app)
          .post(`/api/requests/${accessRequestId}/deny`)
          .send({ denialReason });

        expect(res.status).toBe(200);

        expect(mockSendDenialEmail).toHaveBeenCalledTimes(1);
        const [recipient, payload] = mockSendDenialEmail.mock.calls[0];

        // The Initiating_Admin, and demonstrably not the Transferred_User.
        expect(recipient).toBe(t1010InitiatorEmail);
        expect(recipient).not.toBe(transferredUser.email);

        expect(payload.denialReason).toBe(denialReason);

        // The stored decision and the sent notification agree on the
        // reason -- so the reader of either sees the same text.
        const dbRequest = await pool.query(
          'SELECT status, denial_reason FROM access_requests WHERE id = $1',
          [accessRequestId]
        );
        expect(dbRequest.rows[0].status).toBe('denied');
        expect(dbRequest.rows[0].denial_reason).toBe(denialReason);
      } finally {
        await cleanupExample({ userId: transferredUser.id, requestIds: [accessRequestId] });
      }
    });

    /**
     * Requirement 12.4: the denial decision is already made by the time
     * the notification is attempted, so a failed send must not undo it.
     * The shared `sendDenialEmail` spy rejects once, which is exactly what
     * a refused SMTP connection looks like to `denyRequest`.
     */
    it('Requirement 12.4: a failing denial email still responds 200 and leaves the row denied', async () => {
      const transferredUser = await seedTransferredUser('member');
      const denialReason = 'Declined; the member is mid-deployment';
      let accessRequestId = null;

      try {
        accessRequestId = await seedTransferRequest(
          transferredUser.id,
          'Task 10.10 denial-email-failure scenario'
        );

        mockSendDenialEmail.mockClear();
        mockSendDenialEmail.mockRejectedValueOnce(new Error('SMTP connection refused'));

        const res = await request(app)
          .post(`/api/requests/${accessRequestId}/deny`)
          .send({ denialReason });

        expect(mockSendDenialEmail).toHaveBeenCalledTimes(1);

        expect(res.status).toBe(200);

        const dbRequest = await pool.query(
          'SELECT status, denial_reason, processed_by, processed_at FROM access_requests WHERE id = $1',
          [accessRequestId]
        );
        expect(dbRequest.rows[0].status).toBe('denied');
        expect(dbRequest.rows[0].denial_reason).toBe(denialReason);
        expect(dbRequest.rows[0].processed_by).toBe(adminActor.id);
        expect(dbRequest.rows[0].processed_at).not.toBeNull();
      } finally {
        await cleanupExample({ userId: transferredUser.id, requestIds: [accessRequestId] });
      }
    });
  });
});
