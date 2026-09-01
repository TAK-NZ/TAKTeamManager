jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));

jest.mock('../models/Team', () => ({
  findById: jest.fn(),
  getJoinableTeams: jest.fn(),
  getAncestorChain: jest.fn(),
  isAdmin: jest.fn()
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 'authentik-1', userId: 1, is_global_manager: false };
    next();
  }
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

const mockCreateAccessRequest = jest.fn();
const mockApproveRequest = jest.fn();
jest.mock('../services/RequestApprovalService', () => {
  return jest.fn().mockImplementation(() => ({
    createAccessRequest: mockCreateAccessRequest,
    approveRequest: mockApproveRequest
  }));
});

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const Team = require('../models/Team');
const requestsRouter = require('./requests');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/requests', requestsRouter);
  return app;
}

/**
 * Integration tests for `POST /api/requests/:requestId/approve`'s optional
 * `callsignSuffix` override field (Requirements 11.12, 11.13, 11.15,
 * 11.16; task 24.3). `RequestApprovalService.approveRequest` itself is
 * mocked here (its own resolution/uniqueness-check logic is covered by
 * `server/services/RequestApprovalService.test.js`) -- these tests only
 * verify the route wires the body field through as the 4th positional
 * argument, and maps a thrown `CallsignSuffixConflictError` to a 400
 * naming the conflicting value.
 */
describe('POST /api/requests/:requestId/approve callsignSuffix handling (Requirements 11.12, 11.13, 11.15, 11.16)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    // The approve route now queries for requester_email before calling approveRequest
    pool.query.mockResolvedValue({ rows: [{ requester_email: 'test@example.com' }] });
    app = buildApp();
  });

  it('passes callsignSuffix through to approveRequest as the 4th argument', async () => {
    mockApproveRequest.mockResolvedValue({ success: true });

    const res = await request(app)
      .post('/api/requests/1/approve')
      .send({ additionalDetails: 'welcome', callsignSuffix: 'Override-Suffix' });

    expect(res.status).toBe(200);
    // 5th argument is the approver's Global_Manager status (Requirement
    // 11.6): the mocked `authenticateToken` above sets
    // `is_global_manager: false`, and the route normalises it with `!!`.
    expect(mockApproveRequest).toHaveBeenCalledWith('1', 1, 'welcome', 'Override-Suffix', false);
  });

  it('approves successfully with no callsignSuffix supplied (passed through as undefined)', async () => {
    mockApproveRequest.mockResolvedValue({ success: true });

    const res = await request(app)
      .post('/api/requests/1/approve')
      .send({});

    expect(res.status).toBe(200);
    expect(mockApproveRequest).toHaveBeenCalledWith('1', 1, undefined, undefined, false);
  });

  it('responds 400 naming the conflicting value when approveRequest throws CallsignSuffixConflictError, without a generic 500', async () => {
    const { CallsignSuffixConflictError } = require('../services/CallsignSuffixUniquenessService');
    mockApproveRequest.mockRejectedValue(new CallsignSuffixConflictError('J.Doe'));

    const res = await request(app)
      .post('/api/requests/1/approve')
      .send({ callsignSuffix: 'J.Doe' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('J.Doe');
  });

  it('responds 500 for a non-CallsignSuffixConflictError failure, unchanged from existing behavior', async () => {
    mockApproveRequest.mockRejectedValue(new Error('Request not found or already processed'));

    const res = await request(app)
      .post('/api/requests/1/approve')
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to approve request');
  });
});

/**
 * Integration tests for `GET /api/requests/pending` (Requirements 11.11,
 * 11.12; task 24.2), covering the new per-row `effective_callsign_suffix`
 * field: the request's own submitted `callsign_suffix` when present,
 * otherwise the server-computed default via
 * `CallsignService.computeDefaultCallsignSuffix`, resolving the target
 * team's Organisation's `callsign_name_format` via
 * `Team.getAncestorChain`, deduped by `target_team_id`.
 */
describe('GET /api/requests/pending effective_callsign_suffix (Requirements 11.11, 11.12)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  // Requirement 4.4: the non-Global_Manager branch gates each row on
  // `Team.isAdmin(gatingTeamId, userId)`, so admin status is stubbed per
  // gating team id rather than as a list of direct membership rows.
  function mockAdminTeams(teamIds) {
    Team.isAdmin.mockImplementation((teamId) => Promise.resolve(teamIds.includes(teamId)));
  }

  it('returns the request\'s own callsign_suffix as effective_callsign_suffix, calling getAncestorChain only for team_path resolution', async () => {
    mockAdminTeams([1]);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 100,
          target_team_id: 1,
          team_name: 'Team A',
          callsign_suffix: 'Badge123',
          requested_first_name: null,
          requested_last_name: null,
          requester_first_name: 'John',
          requester_last_name: 'Doe'
        }
      ]
    });
    Team.getAncestorChain.mockResolvedValue([{ id: 1, name: 'Team A', callsign_prefix: null, callsign_name_format: 'full_name' }]);

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].effective_callsign_suffix).toBe('Badge123');
    expect(res.body.requests[0].team_path).toBe('Team A');
    expect(Team.getAncestorChain).toHaveBeenCalledTimes(1);
  });

  it('computes the default via CallsignService when callsign_suffix is not set, using requested_* falling back to requester_* names', async () => {
    mockAdminTeams([1]);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 101,
          target_team_id: 1,
          team_name: 'Team A',
          callsign_suffix: null,
          requested_first_name: null,
          requested_last_name: null,
          requester_first_name: 'John',
          requester_last_name: 'Doe'
        }
      ]
    });
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'first_initial_dot_last' }]);

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests[0].effective_callsign_suffix).toBe('J.Doe');
    expect(Team.getAncestorChain).toHaveBeenCalledWith(1);
  });

  it('prefers requested_first_name/requested_last_name over requester_first_name/requester_last_name when computing the default', async () => {
    mockAdminTeams([1]);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 102,
          target_team_id: 1,
          team_name: 'Team A',
          callsign_suffix: null,
          requested_first_name: 'James',
          requested_last_name: 'Smith',
          requester_first_name: 'John',
          requester_last_name: 'Doe'
        }
      ]
    });
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'first_initial_dot_last' }]);

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests[0].effective_callsign_suffix).toBe('J.Smith');
  });

  it('resolves the target team\'s Organisation callsign_name_format only ONCE for multiple pending requests targeting the same team', async () => {
    mockAdminTeams([1]);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 103,
          target_team_id: 1,
          team_name: 'Team A',
          callsign_suffix: null,
          requested_first_name: null,
          requested_last_name: null,
          requester_first_name: 'John',
          requester_last_name: 'Doe'
        },
        {
          id: 104,
          target_team_id: 1,
          team_name: 'Team A',
          callsign_suffix: null,
          requested_first_name: null,
          requested_last_name: null,
          requester_first_name: 'Jane',
          requester_last_name: 'Roe'
        }
      ]
    });
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'full_name' }]);

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests[0].effective_callsign_suffix).toBe('John-Doe');
    expect(res.body.requests[1].effective_callsign_suffix).toBe('Jane-Roe');
    expect(Team.getAncestorChain).toHaveBeenCalledTimes(1);
    expect(Team.getAncestorChain).toHaveBeenCalledWith(1);
  });

  it('resolves each Organisation\'s callsign_name_format independently for pending requests targeting DIFFERENT teams', async () => {
    mockAdminTeams([1, 2]);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 105,
          target_team_id: 1,
          team_name: 'Team A',
          callsign_suffix: null,
          requested_first_name: null,
          requested_last_name: null,
          requester_first_name: 'John',
          requester_last_name: 'Doe'
        },
        {
          id: 106,
          target_team_id: 2,
          team_name: 'Team B',
          callsign_suffix: null,
          requested_first_name: null,
          requested_last_name: null,
          requester_first_name: 'Jane',
          requester_last_name: 'Roe'
        }
      ]
    });
    Team.getAncestorChain.mockImplementation((targetTeamId) => {
      if (targetTeamId === 1) {
        return Promise.resolve([{ id: 1, callsign_name_format: 'full_name' }]);
      }
      return Promise.resolve([{ id: 2, callsign_name_format: 'first_initial_last' }]);
    });

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests[0].effective_callsign_suffix).toBe('John-Doe');
    expect(res.body.requests[1].effective_callsign_suffix).toBe('J-Roe');
    expect(Team.getAncestorChain).toHaveBeenCalledTimes(2);
    expect(Team.getAncestorChain).toHaveBeenCalledWith(1);
    expect(Team.getAncestorChain).toHaveBeenCalledWith(2);
  });

  // Task 12.2 changed the shape of this case rather than its outcome: the
  // candidate rows are now fetched first and filtered in JS, so the query
  // does run for a caller who administers nothing. What still holds is that
  // no row survives the filter, so nothing is enriched and nothing is
  // returned.
  it('returns an empty requests array when the user administers no gating team', async () => {
    mockAdminTeams([]);
    pool.query.mockResolvedValue({
      rows: [{ id: 300, request_type: 'new_account', target_team_id: 1, team_name: 'Team A' }]
    });

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests).toEqual([]);
    expect(Team.getAncestorChain).not.toHaveBeenCalled();
  });
});

/**
 * account-lifecycle-management Requirement 5.2 (task 11.3): the additive
 * `reclaimableAccount: { userId, previousTeamId }` field on a
 * `new_account` row whose `requester_email` matches an
 * `account_status = 'orphaned'` `users` row.
 */
describe('GET /api/requests/pending reclaimableAccount (account-lifecycle-management)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  function mockAdminTeams(teamIds) {
    Team.isAdmin.mockImplementation((teamId) => Promise.resolve(teamIds.includes(teamId)));
  }

  const NEW_ACCOUNT_ROW = {
    id: 500,
    request_type: 'new_account',
    target_team_id: 1,
    team_name: 'Team A',
    callsign_suffix: 'Badge1',
    requester_email: 'reclaim-candidate@example.com',
    requester_first_name: 'Re',
    requester_last_name: 'Claim'
  };

  it('sets reclaimableAccount to {userId, previousTeamId} when the email matches an orphaned row with a still-existing direct membership', async () => {
    mockAdminTeams([1]);
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes('FROM access_requests ar')) {
        return Promise.resolve({ rows: [NEW_ACCOUNT_ROW] });
      }
      if (sql.includes("account_status = 'orphaned'")) {
        expect(params).toEqual([['reclaim-candidate@example.com']]);
        return Promise.resolve({
          rows: [{ id: 777, email: 'reclaim-candidate@example.com', previous_team_id: 42 }]
        });
      }
      return Promise.resolve({ rows: [] });
    });
    Team.getAncestorChain.mockResolvedValue([{ id: 1, name: 'Team A', callsign_prefix: null, callsign_name_format: 'full_name' }]);

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests[0].reclaimableAccount).toEqual({ userId: 777, previousTeamId: 42 });
  });

  it('sets previousTeamId to null when the orphaned row has no surviving direct membership', async () => {
    mockAdminTeams([1]);
    pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM access_requests ar')) {
        return Promise.resolve({ rows: [NEW_ACCOUNT_ROW] });
      }
      if (sql.includes("account_status = 'orphaned'")) {
        return Promise.resolve({
          rows: [{ id: 777, email: 'reclaim-candidate@example.com', previous_team_id: null }]
        });
      }
      return Promise.resolve({ rows: [] });
    });
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'full_name' }]);

    const res = await request(app).get('/api/requests/pending');

    expect(res.body.requests[0].reclaimableAccount).toEqual({ userId: 777, previousTeamId: null });
  });

  it('sets reclaimableAccount to null (not absent) when no orphaned row matches the email', async () => {
    mockAdminTeams([1]);
    pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM access_requests ar')) {
        return Promise.resolve({ rows: [NEW_ACCOUNT_ROW] });
      }
      if (sql.includes("account_status = 'orphaned'")) {
        return Promise.resolve({ rows: [] }); // no match
      }
      return Promise.resolve({ rows: [] });
    });
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'full_name' }]);

    const res = await request(app).get('/api/requests/pending');

    expect(res.body.requests[0].reclaimableAccount).toBeNull();
  });

  it('never performs the reclaim lookup at all for a team_change/role_change/name_change row (no requester_email to key on)', async () => {
    mockAdminTeams([2]);
    const reclaimQuerySpy = jest.fn();
    pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM access_requests ar')) {
        return Promise.resolve({
          rows: [{
            id: 501,
            request_type: 'team_change',
            approval_team_id: 2,
            target_team_id: 2,
            current_team_id: 3,
            callsign_suffix: null,
            requester_email: 'irrelevant@example.com'
          }]
        });
      }
      if (sql.includes("account_status = 'orphaned'")) {
        reclaimQuerySpy();
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    Team.getAncestorChain.mockResolvedValue([{ id: 2, callsign_name_format: 'full_name' }]);

    const res = await request(app).get('/api/requests/pending');

    expect(reclaimQuerySpy).not.toHaveBeenCalled();
    expect(res.body.requests[0]).not.toHaveProperty('reclaimableAccount');
  });

  it('batches the reclaim lookup into one query for multiple new_account rows, keyed by distinct email', async () => {
    mockAdminTeams([1]);
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes('FROM access_requests ar')) {
        return Promise.resolve({
          rows: [
            { ...NEW_ACCOUNT_ROW, id: 600, requester_email: 'a@example.com' },
            { ...NEW_ACCOUNT_ROW, id: 601, requester_email: 'b@example.com' },
            // A duplicate email should not appear twice in the batched lookup.
            { ...NEW_ACCOUNT_ROW, id: 602, requester_email: 'a@example.com' }
          ]
        });
      }
      if (sql.includes("account_status = 'orphaned'")) {
        expect(params[0].sort()).toEqual(['a@example.com', 'b@example.com']);
        return Promise.resolve({ rows: [{ id: 1, email: 'a@example.com', previous_team_id: null }] });
      }
      return Promise.resolve({ rows: [] });
    });
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'full_name' }]);

    const res = await request(app).get('/api/requests/pending');

    const reclaimQueryCalls = pool.query.mock.calls.filter(([sql]) => sql.includes("account_status = 'orphaned'"));
    expect(reclaimQueryCalls).toHaveLength(1);
    expect(res.body.requests.find((r) => r.id === 600).reclaimableAccount).toEqual({ userId: 1, previousTeamId: null });
    expect(res.body.requests.find((r) => r.id === 602).reclaimableAccount).toEqual({ userId: 1, previousTeamId: null });
    expect(res.body.requests.find((r) => r.id === 601).reclaimableAccount).toBeNull();
  });

  it('never issues the reclaim lookup query when there are no new_account rows at all', async () => {
    mockAdminTeams([2]);
    const reclaimQuerySpy = jest.fn();
    pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM access_requests ar')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("account_status = 'orphaned'")) {
        reclaimQuerySpy();
      }
      return Promise.resolve({ rows: [] });
    });

    await request(app).get('/api/requests/pending');

    expect(reclaimQuerySpy).not.toHaveBeenCalled();
  });
});

/**
 * Feature: team-member-transfer, task 12.1.
 *
 * Examples for the shared `enrichPendingRequests` helper on
 * `GET /api/requests/pending`: the `team_change` fields of Requirement 4.3
 * (Source_Team and Destination_Team hierarchy paths, the Transferred_User's
 * name and email, the Initiating_Admin's name), and the guarantee that rows
 * of the other request types keep their existing shape.
 *
 * These exercise the non-Global_Manager branch (the auth mock at the top of
 * this file is a non-Global_Manager); the enrichment is the same code on
 * both branches by construction, since both call the one helper.
 */
describe('GET /api/requests/pending team_change enrichment (Requirements 4.1, 4.3)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  // Requirement 4.4: the non-Global_Manager branch gates each row on
  // `Team.isAdmin(gatingTeamId, userId)`, so admin status is stubbed per
  // gating team id rather than as a list of direct membership rows.
  function mockAdminTeams(teamIds) {
    Team.isAdmin.mockImplementation((teamId) => Promise.resolve(teamIds.includes(teamId)));
  }

  it('resolves source_team_path and team_path from the distinct source and destination teams, and passes the joined user fields through', async () => {
    mockAdminTeams([2]);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 200,
          request_type: 'team_change',
          existing_user_id: 7,
          initiated_by: 9,
          current_team_id: 3,
          target_team_id: 2,
          approval_team_id: 2,
          team_name: 'Bravo',
          source_team_name: 'Alpha',
          callsign_suffix: null,
          transferred_user_first_name: 'Mia',
          transferred_user_last_name: 'Ngata',
          transferred_user_email: 'mia@example.com',
          initiated_by_first_name: 'Sam',
          initiated_by_last_name: 'Reid'
        }
      ]
    });
    Team.getAncestorChain.mockImplementation((teamId) => {
      if (teamId === 3) {
        return Promise.resolve([
          { id: 1, name: 'Org', callsign_prefix: 'ORG', callsign_name_format: 'full_name' },
          { id: 3, name: 'Alpha', callsign_prefix: 'ALP' }
        ]);
      }
      return Promise.resolve([
        { id: 1, name: 'Org', callsign_prefix: 'ORG', callsign_name_format: 'full_name' },
        { id: 2, name: 'Bravo', callsign_prefix: 'BRV' }
      ]);
    });

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    const [row] = res.body.requests;
    expect(row.team_path).toBe('ORG > Bravo');
    expect(row.source_team_path).toBe('ORG > Alpha');
    expect(row.transferred_user_first_name).toBe('Mia');
    expect(row.transferred_user_last_name).toBe('Ngata');
    expect(row.transferred_user_email).toBe('mia@example.com');
    expect(row.initiated_by_first_name).toBe('Sam');
    expect(row.initiated_by_last_name).toBe('Reid');
    // One chain resolution per distinct team id across BOTH columns.
    expect(Team.getAncestorChain).toHaveBeenCalledTimes(2);
    expect(Team.getAncestorChain).toHaveBeenCalledWith(3);
    expect(Team.getAncestorChain).toHaveBeenCalledWith(2);
  });

  it('joins the Transferred_User, the Initiating_Admin, and the Source_Team on the pending query', async () => {
    mockAdminTeams([1]);
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/requests/pending');

    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('LEFT JOIN users tu ON ar.existing_user_id = tu.id');
    expect(sql).toContain('LEFT JOIN users iu ON ar.initiated_by = iu.id');
    expect(sql).toContain('LEFT JOIN teams st ON ar.current_team_id = st.id');
  });

  it('leaves source_team_path empty and effective_callsign_suffix intact for a row with no current_team_id', async () => {
    mockAdminTeams([1]);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 201,
          request_type: 'new_account',
          target_team_id: 1,
          current_team_id: null,
          team_name: 'Team A',
          source_team_name: null,
          callsign_suffix: null,
          requester_first_name: 'John',
          requester_last_name: 'Doe'
        }
      ]
    });
    Team.getAncestorChain.mockResolvedValue([
      { id: 1, name: 'Team A', callsign_prefix: null, callsign_name_format: 'first_initial_dot_last' }
    ]);

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests[0].source_team_path).toBe('');
    expect(res.body.requests[0].team_path).toBe('Team A');
    expect(res.body.requests[0].effective_callsign_suffix).toBe('J.Doe');
    expect(Team.getAncestorChain).toHaveBeenCalledTimes(1);
  });
});

/**
 * Feature: team-member-transfer, task 12.2.
 *
 * Examples for the reworked non-Global_Manager gating on
 * `GET /api/requests/pending` (Requirements 4.2, 4.4). The auth mock at the
 * top of this file is a non-Global_Manager with `userId` 1, so every request
 * here takes the filtered branch.
 *
 * The behaviour under test is the gating column and the gating predicate: a
 * `team_change` row is gated on `approval_team_id` via `Team.isAdmin` (which
 * walks that Team's Ancestor_Chain), every other type stays gated on
 * `target_team_id`, and a row naming no gating Team is invisible.
 */
describe('GET /api/requests/pending non-Global_Manager gating (Requirements 4.2, 4.4)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    Team.getAncestorChain.mockResolvedValue([
      { id: 1, name: 'Org', callsign_prefix: 'ORG', callsign_name_format: 'full_name' }
    ]);
  });

  it('includes a team_change row gated on approval_team_id, not on target_team_id', async () => {
    // Caller administers team 5 (the Approval_Team) and NOT team 9 (the
    // Destination_Team), which is precisely the case the old
    // `target_team_id IN (...)` predicate got backwards.
    Team.isAdmin.mockImplementation((teamId) => Promise.resolve(teamId === 5));
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 400,
          request_type: 'team_change',
          approval_team_id: 5,
          target_team_id: 9,
          current_team_id: 5,
          callsign_suffix: null
        }
      ]
    });

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests.map((r) => r.id)).toEqual([400]);
    expect(Team.isAdmin).toHaveBeenCalledWith(5, 1);
    expect(Team.isAdmin).not.toHaveBeenCalledWith(9, 1);
  });

  it('excludes a team_change row whose approval_team_id the caller does not administer, and one with no approval_team_id at all', async () => {
    Team.isAdmin.mockImplementation((teamId) => Promise.resolve(teamId === 5));
    pool.query.mockResolvedValue({
      rows: [
        { id: 401, request_type: 'team_change', approval_team_id: 7, target_team_id: 5, callsign_suffix: null },
        { id: 402, request_type: 'team_change', approval_team_id: null, target_team_id: 5, callsign_suffix: null },
        { id: 403, request_type: 'new_account', target_team_id: 5, callsign_suffix: null }
      ]
    });

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    // 401 is gated on team 7 (not administered); 402 names no Approval_Team
    // so it fails closed; only the `new_account` row, gated on its
    // `target_team_id`, survives.
    expect(res.body.requests.map((r) => r.id)).toEqual([403]);
  });

  it('resolves admin status once per distinct gating team rather than once per row', async () => {
    Team.isAdmin.mockResolvedValue(true);
    pool.query.mockResolvedValue({
      rows: [
        { id: 404, request_type: 'team_change', approval_team_id: 5, target_team_id: 9, callsign_suffix: null },
        { id: 405, request_type: 'team_change', approval_team_id: 5, target_team_id: 8, callsign_suffix: null },
        { id: 406, request_type: 'new_account', target_team_id: 5, callsign_suffix: null }
      ]
    });

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests.map((r) => r.id)).toEqual([404, 405, 406]);
    expect(Team.isAdmin).toHaveBeenCalledTimes(1);
    expect(Team.isAdmin).toHaveBeenCalledWith(5, 1);
  });
});
