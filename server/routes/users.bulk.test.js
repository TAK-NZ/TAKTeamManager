/**
 * Route tests for the bulk member-action endpoints added for the Orgs &
 * Teams multi-select feature: `POST /api/users/bulk-suspend`,
 * `bulk-unsuspend`, `bulk-resend-welcome`, `bulk-transfer`, and
 * `bulk-remove-from-team`.
 *
 * Every one of these routes has no `:userId`/`:teamId` route param for
 * `authorize.js`'s row-scoped resolvers to key on (the subject is an
 * ARRAY of user ids), so `authenticateToken`/`authorize` are stubbed to
 * bypass the real chain (mirroring `users.suspend.test.js`'s own
 * approach) and this file is scoped to confirming: each route performs
 * the SAME per-row authorization check its single-item counterpart's
 * resolver would perform, one row's failure never affects any other
 * row's outcome, and `bulk-remove-from-team` is rejected outright for a
 * non-Global_Manager caller before any row is even read.
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

jest.mock('../models/Team', () => ({
  isAdmin: jest.fn(),
  getAncestorChain: jest.fn()
}));

jest.mock('../models/User', () => ({
  getTeamMemberships: jest.fn()
}));

jest.mock('../services/AccountLifecycleService', () => {
  class AccountAlreadySuspendedError extends Error {
    constructor(userId) {
      super('Account is already suspended');
      this.name = 'AccountAlreadySuspendedError';
      this.userId = userId;
    }
  }
  class AccountOrphanedError extends Error {
    constructor(userId) {
      super('Account has no Authentik identity (orphaned)');
      this.name = 'AccountOrphanedError';
      this.userId = userId;
    }
  }
  class AccountNotSuspendedError extends Error {
    constructor(userId, currentStatus) {
      super(`Account is not suspended (current status: ${currentStatus})`);
      this.name = 'AccountNotSuspendedError';
      this.userId = userId;
      this.currentStatus = currentStatus;
    }
  }
  class TargetUserNotFoundError extends Error {
    constructor(userId) {
      super('Target user not found');
      this.name = 'TargetUserNotFoundError';
      this.userId = userId;
    }
  }

  const mockService = {
    suspendAccount: jest.fn(),
    unsuspendAccount: jest.fn()
  };
  mockService.AccountAlreadySuspendedError = AccountAlreadySuspendedError;
  mockService.AccountOrphanedError = AccountOrphanedError;
  mockService.AccountNotSuspendedError = AccountNotSuspendedError;
  mockService.TargetUserNotFoundError = TargetUserNotFoundError;
  return mockService;
});

jest.mock('../services/TeamMembershipService', () => ({
  removeUserFromTeam: jest.fn()
}));

jest.mock('../services/userAttributes', () => ({
  clearUserAttributes: jest.fn()
}));

jest.mock('../services/EventPublisher', () => ({
  publishOperation: jest.fn().mockResolvedValue('op-id')
}));

jest.mock('../services/TeamTransferService', () => {
  const actual = jest.requireActual('../services/TeamTransferService');
  return {
    ...actual,
    TeamTransferService: {
      executeTransfer: jest.fn(),
      applyPostCommitEffects: jest.fn()
    }
  };
});

jest.mock('../services/EmailService', () => jest.fn().mockImplementation(() => ({
  sendApprovalEmail: jest.fn().mockResolvedValue()
})));

jest.mock('../config/deviceMgmt', () => ({
  isDeviceMgmtRevokeEnabled: jest.fn().mockReturnValue(true)
}));

let mockAuthUser = { id: 1, userId: 1, is_global_manager: true };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = mockAuthUser;
    next();
  },
  requireTeamAdmin: (req, res, next) => next()
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const Team = require('../models/Team');
const User = require('../models/User');
const AccountLifecycleService = require('../services/AccountLifecycleService');
const TeamMembershipService = require('../services/TeamMembershipService');
const UserAttributesService = require('../services/userAttributes');
const { TeamTransferService } = require('../services/TeamTransferService');
const usersRouter = require('./users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  return app;
}

function asGlobalManager(userId = 1) {
  mockAuthUser = { id: userId, userId, is_global_manager: true };
}

function asTeamAdmin(userId = 7) {
  mockAuthUser = { id: userId, userId, is_global_manager: false };
}

describe('POST /api/users/bulk-suspend', () => {
  let app;
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    asGlobalManager();
    app = buildApp();
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns 400 without calling the service when userIds is missing/empty/invalid', async () => {
    const empty = await request(app).post('/api/users/bulk-suspend').send({ userIds: [] });
    expect(empty.status).toBe(400);

    const notArray = await request(app).post('/api/users/bulk-suspend').send({ userIds: 'nope' });
    expect(notArray.status).toBe(400);

    const badId = await request(app).post('/api/users/bulk-suspend').send({ userIds: [1, 'x'] });
    expect(badId.status).toBe(400);

    expect(AccountLifecycleService.suspendAccount).not.toHaveBeenCalled();
  });

  it('suspends every row for a Global_Manager and reports a per-row success result', async () => {
    AccountLifecycleService.suspendAccount
      .mockResolvedValueOnce({ userId: 10, accountStatus: 'suspended' })
      .mockResolvedValueOnce({ userId: 11, accountStatus: 'suspended' });

    const res = await request(app).post('/api/users/bulk-suspend').send({ userIds: [10, 11] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      successCount: 2,
      failureCount: 0,
      results: [
        { userId: 10, success: true, accountStatus: 'suspended' },
        { userId: 11, success: true, accountStatus: 'suspended' }
      ]
    });
    // A Global_Manager skips the Team.isAdmin membership check entirely.
    expect(Team.isAdmin).not.toHaveBeenCalled();
  });

  it("performs the SAME per-row authorization the single-item route's resolver would: a Team_Admin may suspend only a row in a team they administer", async () => {
    asTeamAdmin(7);
    pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM team_memberships')) {
        return Promise.resolve({ rows: [{ team_id: 5 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    Team.isAdmin.mockImplementation((teamId) => Promise.resolve(teamId === 5));
    AccountLifecycleService.suspendAccount.mockResolvedValue({ userId: 10, accountStatus: 'suspended' });

    const res = await request(app).post('/api/users/bulk-suspend').send({ userIds: [10] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toEqual({ userId: 10, success: true, accountStatus: 'suspended' });
    expect(Team.isAdmin).toHaveBeenCalledWith(5, 7);
  });

  it('records an unauthorized row as its OWN failure, never calling the service for it, while leaving the batch response 200', async () => {
    asTeamAdmin(7);
    pool.query.mockResolvedValue({ rows: [{ team_id: 99 }] });
    Team.isAdmin.mockResolvedValue(false);

    const res = await request(app).post('/api/users/bulk-suspend').send({ userIds: [10] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      successCount: 0,
      failureCount: 1,
      results: [{ userId: 10, success: false, error: 'You do not have permission to suspend this account' }]
    });
    expect(AccountLifecycleService.suspendAccount).not.toHaveBeenCalled();
  });

  it("one row's AccountAlreadySuspendedError does not affect another row's success (per-row isolation)", async () => {
    AccountLifecycleService.suspendAccount
      .mockRejectedValueOnce(new AccountLifecycleService.AccountAlreadySuspendedError(10))
      .mockResolvedValueOnce({ userId: 11, accountStatus: 'suspended' });

    const res = await request(app).post('/api/users/bulk-suspend').send({ userIds: [10, 11] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      successCount: 1,
      failureCount: 1,
      results: [
        { userId: 10, success: false, error: 'Account is already suspended' },
        { userId: 11, success: true, accountStatus: 'suspended' }
      ]
    });
  });

  it('maps AccountOrphanedError and TargetUserNotFoundError to their own per-row messages', async () => {
    AccountLifecycleService.suspendAccount
      .mockRejectedValueOnce(new AccountLifecycleService.AccountOrphanedError(10))
      .mockRejectedValueOnce(new AccountLifecycleService.TargetUserNotFoundError(11));

    const res = await request(app).post('/api/users/bulk-suspend').send({ userIds: [10, 11] });

    expect(res.body.results).toEqual([
      { userId: 10, success: false, error: 'Account has no Authentik identity (orphaned)' },
      { userId: 11, success: false, error: 'User not found' }
    ]);
  });

  it('maps an unrecognized error to a generic per-row message rather than failing the whole request', async () => {
    AccountLifecycleService.suspendAccount.mockRejectedValue(new Error('unexpected db failure'));

    const res = await request(app).post('/api/users/bulk-suspend').send({ userIds: [10] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toEqual({ userId: 10, success: false, error: 'Failed to suspend account' });
  });
});

describe('POST /api/users/bulk-unsuspend', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    asGlobalManager();
    app = buildApp();
  });

  it('unsuspends every row for a Global_Manager', async () => {
    AccountLifecycleService.unsuspendAccount
      .mockResolvedValueOnce({ userId: 10, accountStatus: 'active' })
      .mockResolvedValueOnce({ userId: 11, accountStatus: 'active' });

    const res = await request(app).post('/api/users/bulk-unsuspend').send({ userIds: [10, 11] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      successCount: 2,
      failureCount: 0,
      results: [
        { userId: 10, success: true, accountStatus: 'active' },
        { userId: 11, success: true, accountStatus: 'active' }
      ]
    });
  });

  it('applies the SAME user:suspend authorization rule as bulk-suspend (shared per-row check)', async () => {
    asTeamAdmin(7);
    pool.query.mockResolvedValue({ rows: [{ team_id: 99 }] });
    Team.isAdmin.mockResolvedValue(false);

    const res = await request(app).post('/api/users/bulk-unsuspend').send({ userIds: [10] });

    expect(res.body.results[0]).toEqual({ userId: 10, success: false, error: 'You do not have permission to unsuspend this account' });
    expect(AccountLifecycleService.unsuspendAccount).not.toHaveBeenCalled();
  });

  it('maps AccountNotSuspendedError to its own per-row message', async () => {
    AccountLifecycleService.unsuspendAccount.mockRejectedValue(
      new AccountLifecycleService.AccountNotSuspendedError(10, 'active')
    );

    const res = await request(app).post('/api/users/bulk-unsuspend').send({ userIds: [10] });

    expect(res.body.results[0]).toEqual({
      userId: 10,
      success: false,
      error: 'Account is not suspended (current status: active)'
    });
  });
});

describe('POST /api/users/bulk-resend-welcome', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    asGlobalManager();
    app = buildApp();
    pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM users u LEFT JOIN user_cache')) {
        return Promise.resolve({ rows: [{ id: 10, email: 'a@example.com', first_name: 'A', last_name: 'B', tak_callsign: null }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it('sends a welcome email to every row for a Global_Manager', async () => {
    const res = await request(app).post('/api/users/bulk-resend-welcome').send({ userIds: [10], teamId: null });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      successCount: 1,
      failureCount: 0,
      results: [{ userId: 10, success: true }]
    });
  });

  it("performs the SAME per-row authorization the single-item route's resolver would: at least one of the target's current teams must be administered by the caller", async () => {
    asTeamAdmin(7);
    User.getTeamMemberships.mockResolvedValue([{ id: 5 }, { id: 6 }]);
    Team.isAdmin.mockImplementation((teamId) => Promise.resolve(teamId === 6));

    const res = await request(app).post('/api/users/bulk-resend-welcome').send({ userIds: [10] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toEqual({ userId: 10, success: true });
    expect(Team.isAdmin).toHaveBeenCalledWith(5, 7);
    expect(Team.isAdmin).toHaveBeenCalledWith(6, 7);
  });

  it('records an unauthorized row as its own failure without sending an email', async () => {
    asTeamAdmin(7);
    User.getTeamMemberships.mockResolvedValue([{ id: 5 }]);
    Team.isAdmin.mockResolvedValue(false);

    const res = await request(app).post('/api/users/bulk-resend-welcome').send({ userIds: [10] });

    expect(res.body.results[0]).toEqual({
      userId: 10,
      success: false,
      error: 'You do not have permission to resend a welcome email to this account'
    });
  });

  it('a missing user is a per-row 404-shaped failure, not a whole-request failure', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM users u LEFT JOIN user_cache')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).post('/api/users/bulk-resend-welcome').send({ userIds: [999] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toEqual({ userId: 999, success: false, error: 'User not found' });
  });
});

describe('POST /api/users/bulk-transfer', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    asGlobalManager();
    app = buildApp();
  });

  it('returns 400 for a malformed body (missing targetTeamId) without touching the database', async () => {
    const res = await request(app).post('/api/users/bulk-transfer').send({ userIds: [10] });

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('transfers every row for a Global_Manager (Dual_Admin path, immediate completion)', async () => {
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes('team_id, role FROM team_memberships')) {
        return Promise.resolve({ rows: [{ team_id: 5, role: 'member' }] });
      }
      if (sql.includes('SELECT id FROM users WHERE id')) {
        return Promise.resolve({ rows: [{ id: params[0] }] });
      }
      if (sql.includes('SELECT id FROM teams WHERE id')) {
        return Promise.resolve({ rows: [{ id: params[0] }] });
      }
      if (sql.includes("FROM access_requests")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn()
    });
    Team.getAncestorChain.mockImplementation((teamId) =>
      Promise.resolve([{ id: 1, name: 'Org', callsign_prefix: 'ORG' }, { id: teamId, name: `Team${teamId}`, callsign_prefix: null }])
    );
    TeamTransferService.executeTransfer.mockResolvedValue({
      demotedFromAdmin: false,
      revokedChannelIds: []
    });
    TeamTransferService.applyPostCommitEffects.mockResolvedValue({ callsign: 'ORG-Team9-Alice' });

    const res = await request(app).post('/api/users/bulk-transfer').send({ userIds: [10], targetTeamId: 9 });

    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(1);
    expect(res.body.results[0]).toEqual(expect.objectContaining({ userId: 10, success: true, status: 'completed' }));
  });

  it("performs the SAME per-row authorization user:team:transfer's resolver would: denies a caller who administers NEITHER side", async () => {
    asTeamAdmin(7);
    pool.query.mockImplementation((sql) => {
      if (sql.includes('team_id, role FROM team_memberships')) {
        return Promise.resolve({ rows: [{ team_id: 5, role: 'member' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    Team.isAdmin.mockResolvedValue(false);

    const res = await request(app).post('/api/users/bulk-transfer').send({ userIds: [10], targetTeamId: 9 });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toEqual({
      userId: 10,
      success: false,
      error: 'You do not have permission to transfer this user'
    });
    expect(TeamTransferService.executeTransfer).not.toHaveBeenCalled();
  });

  it("one row's SelfTransferError does not affect another row's success (per-row isolation)", async () => {
    asGlobalManager(10);
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes('team_id, role FROM team_memberships')) {
        return Promise.resolve({ rows: [{ team_id: 5, role: 'member' }] });
      }
      if (sql.includes('SELECT id FROM users WHERE id')) {
        return Promise.resolve({ rows: [{ id: params[0] }] });
      }
      if (sql.includes('SELECT id FROM teams WHERE id')) {
        return Promise.resolve({ rows: [{ id: params[0] }] });
      }
      if (sql.includes('FROM access_requests')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn()
    });
    Team.getAncestorChain.mockImplementation((teamId) =>
      Promise.resolve([{ id: 1, name: 'Org', callsign_prefix: 'ORG' }, { id: teamId, name: `Team${teamId}`, callsign_prefix: null }])
    );
    TeamTransferService.executeTransfer.mockResolvedValue({ demotedFromAdmin: false, revokedChannelIds: [] });
    TeamTransferService.applyPostCommitEffects.mockResolvedValue({ callsign: 'ORG-Team9-Bob' });

    // userIds[0] === actor's own id -> SelfTransferError; userIds[1] succeeds.
    const res = await request(app).post('/api/users/bulk-transfer').send({ userIds: [10, 11], targetTeamId: 9 });

    expect(res.body.successCount).toBe(1);
    expect(res.body.failureCount).toBe(1);
    expect(res.body.results[0]).toEqual({ userId: 10, success: false, error: 'An admin cannot transfer their own membership' });
    expect(res.body.results[1]).toEqual(expect.objectContaining({ userId: 11, success: true }));
  });

  it('maps NoCurrentTeamError (no Direct_Membership) to its own per-row message', async () => {
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes('team_id, role FROM team_memberships')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT id FROM users WHERE id')) {
        return Promise.resolve({ rows: [{ id: params[0] }] });
      }
      if (sql.includes('SELECT id FROM teams WHERE id')) {
        return Promise.resolve({ rows: [{ id: params[0] }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).post('/api/users/bulk-transfer').send({ userIds: [10], targetTeamId: 9 });

    expect(res.body.results[0]).toEqual({ userId: 10, success: false, error: 'User has no current team' });
  });
});

describe('POST /api/users/bulk-remove-from-team', () => {
  let app;
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('rejects the ENTIRE request with 403 for a non-Global_Manager, before any row is read', async () => {
    asTeamAdmin(7);

    const res = await request(app).post('/api/users/bulk-remove-from-team').send({ userIds: [10], teamId: 5 });

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
    expect(TeamMembershipService.removeUserFromTeam).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed body without calling any service', async () => {
    asGlobalManager();

    const res = await request(app).post('/api/users/bulk-remove-from-team').send({ userIds: [10] });

    expect(res.status).toBe(400);
    expect(TeamMembershipService.removeUserFromTeam).not.toHaveBeenCalled();
  });

  it('permanently deletes every row for a Global_Manager, reporting authentikAccountDeleted per row', async () => {
    asGlobalManager();
    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT authentik_user_id FROM users')) {
        return Promise.resolve({ rows: [{ authentik_user_id: 999 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    TeamMembershipService.removeUserFromTeam.mockResolvedValue({ success: true, groupsQueued: 1 });
    UserAttributesService.clearUserAttributes.mockResolvedValue();

    const res = await request(app).post('/api/users/bulk-remove-from-team').send({ userIds: [10, 11], teamId: 5 });

    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(2);
    expect(res.body.results[0]).toEqual(
      expect.objectContaining({ userId: 10, success: true, authentikAccountDeleted: true })
    );
    expect(TeamMembershipService.removeUserFromTeam).toHaveBeenCalledTimes(2);
  });

  it("one row's missing-user 'not found' failure does not affect another row's success (per-row isolation)", async () => {
    asGlobalManager();
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes('SELECT authentik_user_id FROM users')) {
        if (params[0] === 10) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [{ authentik_user_id: 999 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    TeamMembershipService.removeUserFromTeam.mockResolvedValue({ success: true, groupsQueued: 1 });
    UserAttributesService.clearUserAttributes.mockResolvedValue();

    const res = await request(app).post('/api/users/bulk-remove-from-team').send({ userIds: [10, 11], teamId: 5 });

    expect(res.body.results[0]).toEqual({ userId: 10, success: false, error: 'User not found' });
    expect(res.body.results[1]).toEqual(expect.objectContaining({ userId: 11, success: true }));
  });
});
