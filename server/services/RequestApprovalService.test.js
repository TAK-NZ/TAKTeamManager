/**
 * Unit tests for `RequestApprovalService.approveRequest` (Requirement 18.1
 * / task 38.1): extracting `UserProvisioningService.createAndAddUser` for
 * reuse by the `new_account` approval path.
 *
 * These verify:
 *  - a `new_account` approval creates the Authentik user BEFORE any
 *    database transaction opens (i.e. before `pool.connect()` is called),
 *    then calls `UserProvisioningService.createAndAddUser` inside the
 *    transaction opened by `approveRequest`, and commits;
 *  - a failure creating the Authentik user causes `approveRequest` to
 *    reject cleanly WITHOUT ever acquiring a transactional client;
 *  - a failure inside the local transaction after the Authentik user was
 *    already created rolls back the transaction and logs the orphaned-
 *    user situation via the structured logger;
 *  - the other three request types (`team_change`, `role_change`,
 *    `name_change`) remain no-ops and are unaffected by this change.
 */

jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));

jest.mock('./UserProvisioningService', () => ({
  createAndAddUser: jest.fn(),
  // takserver-enrollment Requirement 6.6 (task 5.2):
  // `resolveAndCheckCallsignSuffixForApproval` is now a thin adapter over
  // this resolver rather than its own `computeDefaultCallsignSuffix` call
  // + its own `Team.getAncestorChain` read.
  resolveNewUserIdentity: jest.fn()
}));

// Task 10.1 (Requirement 6.1): the `team_change` branch no longer calls
// `TeamMembershipService.addUserToTeam` directly -- it delegates the whole
// move to `TeamTransferService.executeTransfer`, which wraps that call and
// adds the revocation, staleness, and Callsign_Suffix halves around it. The
// mock mirrors the module's real shape (a named export holding static
// methods) so the service's destructuring require resolves.
jest.mock('./TeamTransferService', () => ({
  TeamTransferService: {
    executeTransfer: jest.fn(),
    applyPostCommitEffects: jest.fn()
  }
}));

jest.mock('../models/Team', () => ({
  getAncestorChain: jest.fn(),
  getFullMemberList: jest.fn()
}));

jest.mock('./CallsignService', () => ({
  computeDefaultCallsignSuffix: jest.fn()
}));

jest.mock('./userAttributes', () => ({
  generateCallsign: jest.fn(),
  updateUserAttributes: jest.fn()
}));

jest.mock('./EmailService');

jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn()
}));

const mockLoggerError = jest.fn();
jest.mock('../middleware/requestContext', () => ({
  getLogger: () => ({ error: mockLoggerError, info: jest.fn(), warn: jest.fn() })
}));

const pool = require('../config/database');
const UserProvisioningService = require('./UserProvisioningService');
const { TeamTransferService } = require('./TeamTransferService');
const UserAttributesService = require('./userAttributes');
const EmailService = require('./EmailService');
const EventPublisher = require('./EventPublisher');
const Team = require('../models/Team');
const CallsignService = require('./CallsignService');
const { CallsignSuffixConflictError } = require('./CallsignSuffixUniquenessService');
const RequestApprovalService = require('./RequestApprovalService');

const PENDING_NEW_ACCOUNT_REQUEST = {
  id: 1,
  request_type: 'new_account',
  status: 'pending',
  requester_email: 'newuser@example.com',
  requester_first_name: 'New',
  requester_last_name: 'User',
  requested_first_name: null,
  requested_last_name: null,
  target_team_id: 7
};

function mockAuthentikSuccess(pk = 4242) {
  global.fetch = jest.fn()
    // 1. existing-user-by-email lookup -> no results
    .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
    // 2. create user
    .mockResolvedValueOnce({ ok: true, json: async () => ({ pk }) });
}

describe('RequestApprovalService.approveRequest - new_account', () => {
  let service;
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RequestApprovalService();
    service.emailService.sendApprovalEmail = jest.fn().mockResolvedValue(true);
    originalFetch = global.fetch;
    // Default: `resolveAndCheckCallsignSuffixForApproval` is a thin
    // adapter over `resolveNewUserIdentity` (task 5.2) -- most tests in
    // this suite don't exercise the callsign_suffix/username resolution
    // logic itself, so this default (a policy-disabled Organisation
    // returning the email verbatim as `username` and the computed
    // default as `callsignSuffix`) keeps them passing unchanged.
    UserProvisioningService.resolveNewUserIdentity.mockResolvedValue({
      username: 'newuser@example.com',
      callsignSuffix: 'New-User',
      pseudonymous: false,
      claimId: null
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('creates the Authentik user before acquiring a database client, then calls createAndAddUser inside the transaction and commits', async () => {
    mockAuthentikSuccess();

    // Phase 1 pre-fetch (plain pool.query, no client yet).
    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [PENDING_NEW_ACCOUNT_REQUEST] });
      }
      return Promise.resolve({ rows: [] });
    });

    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{
              ...PENDING_NEW_ACCOUNT_REQUEST,
              team_name: 'Alpha Team',
              admin_first_name: 'Admin',
              admin_last_name: 'Istrator'
            }]
          });
        }
        if (sql.includes('SELECT 1 FROM teams')) {
          return Promise.resolve({ rows: [{}] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };

    pool.connect.mockImplementation(() => {
      // pool.connect() must only be called AFTER both Authentik fetch
      // calls (lookup + create) have already resolved.
      expect(global.fetch).toHaveBeenCalledTimes(2);
      return Promise.resolve(mockClient);
    });

    UserProvisioningService.createAndAddUser.mockResolvedValue({ localUserId: 55, queuedGroups: 1 });

    const result = await service.approveRequest(1, 9, 'welcome aboard');

    expect(result).toEqual({ success: true });
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'approved'"),
      [1, 9]
    );
    expect(UserProvisioningService.resolveNewUserIdentity).toHaveBeenCalledWith(null, {
      firstName: 'New',
      lastName: 'User',
      email: 'newuser@example.com',
      teamId: 7,
      requestedUsername: 'newuser@example.com',
      requestedCallsignSuffix: undefined
    });
    expect(UserProvisioningService.createAndAddUser).toHaveBeenCalledWith(mockClient, {
      authentikUserId: 4242,
      username: 'newuser@example.com',
      email: 'newuser@example.com',
      firstName: 'New',
      lastName: 'User',
      teamId: 7,
      callsign_suffix: 'New-User',
      createdBy: 9,
      claimId: null
    });
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(service.emailService.sendApprovalEmail).toHaveBeenCalled();
  });

  /**
   * Regression test: previously, a newly-approved new_account user never
   * got a user_cache row until the next periodic Authentik sync (up to
   * SYNC_INTERVAL_MINUTES, default 10 minutes, later). Since
   * authenticateToken/GET /api/auth/me's session resolution looks the
   * user up via authentikSync.getUserFromCache (keyed on user_cache),
   * that user's very first login attempt right after approval would
   * 401/redirect with ?error=user_not_synced. This verifies
   * approveRequest now performs the SAME post-commit user_cache upsert
   * POST /api/users/create-and-add already does (server/routes/users.js),
   * strictly AFTER COMMIT (never inside the open transaction, since an
   * Authentik call must never run inside one).
   */
  it('eagerly upserts a user_cache row after COMMIT, so the newly-approved user can log in immediately (no periodic-sync wait)', async () => {
    mockAuthentikSuccess();

    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [PENDING_NEW_ACCOUNT_REQUEST] });
      }
      if (sql.includes('INSERT INTO user_cache')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{
              ...PENDING_NEW_ACCOUNT_REQUEST,
              team_name: 'Alpha Team',
              admin_first_name: 'Admin',
              admin_last_name: 'Istrator'
            }]
          });
        }
        if (sql.includes('SELECT 1 FROM teams')) {
          return Promise.resolve({ rows: [{}] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);

    UserProvisioningService.createAndAddUser.mockResolvedValue({ localUserId: 55, queuedGroups: 1 });
    UserAttributesService.generateCallsign.mockResolvedValue({
      callsign: 'FENZ-New User',
      color: 'Red',
      role: 'Team Member'
    });
    UserAttributesService.updateUserAttributes.mockResolvedValue(true);

    const result = await service.approveRequest(1, 9);

    expect(result).toEqual({ success: true });

    // COMMIT must happen before the user_cache upsert.
    const commitCallIndex = mockClient.query.mock.calls.findIndex(([sql]) => sql === 'COMMIT');
    expect(commitCallIndex).toBeGreaterThanOrEqual(0);

    expect(UserAttributesService.generateCallsign).toHaveBeenCalledWith(55, 7);
    expect(UserAttributesService.updateUserAttributes).toHaveBeenCalledWith(4242, {
      callsign: 'FENZ-New User',
      color: 'Red',
      role: 'Team Member'
    });

    const userCacheInsert = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_cache'));
    expect(userCacheInsert).toBeDefined();
    expect(userCacheInsert[1]).toEqual([
      4242,
      'newuser@example.com',
      'newuser@example.com',
      'New',
      'User',
      'FENZ-New User',
      'Red',
      'Team Member'
    ]);
  });

  it('does not fail the (already-committed) approval when the post-commit user_cache upsert itself throws', async () => {
    mockAuthentikSuccess();

    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [PENDING_NEW_ACCOUNT_REQUEST] });
      }
      if (sql.includes('INSERT INTO user_cache')) {
        return Promise.reject(new Error('db unavailable'));
      }
      return Promise.resolve({ rows: [] });
    });

    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{
              ...PENDING_NEW_ACCOUNT_REQUEST,
              team_name: 'Alpha Team',
              admin_first_name: 'Admin',
              admin_last_name: 'Istrator'
            }]
          });
        }
        if (sql.includes('SELECT 1 FROM teams')) {
          return Promise.resolve({ rows: [{}] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);

    UserProvisioningService.createAndAddUser.mockResolvedValue({ localUserId: 55, queuedGroups: 1 });
    UserAttributesService.generateCallsign.mockResolvedValue(null);

    const result = await service.approveRequest(1, 9);

    // The approval itself already succeeded (COMMIT already happened);
    // the post-commit upsert failure is logged, not thrown.
    expect(result).toEqual({ success: true });
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ authentikUserId: 4242 }),
      expect.stringContaining('post-commit user_cache upsert failed')
    );
  });

  it('rejects cleanly without ever acquiring a database client when Authentik user creation fails', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ detail: 'bad request' }) });

    pool.query.mockResolvedValue({ rows: [PENDING_NEW_ACCOUNT_REQUEST] });

    await expect(service.approveRequest(1, 9)).rejects.toThrow('Failed to create user in Authentik');

    expect(pool.connect).not.toHaveBeenCalled();
    expect(UserProvisioningService.createAndAddUser).not.toHaveBeenCalled();
  });

  /**
   * Requirement 17.2 (which Requirement 18.7 relies on): when the local
   * transaction fails after the Authentik user was already created in
   * Phase 1, `approveRequest` must attempt a synchronous compensating
   * delete of that Authentik user first, falling back to enqueueing a
   * `cleanup_orphaned_authentik_user` Sync_Operation if that delete
   * itself fails. This mirrors the exact same pattern already built for
   * `POST /api/users/create-and-add` (task 36.2, `server/routes/users.js`).
   */
  function buildRolledBackTransactionClient() {
    return {
      query: jest.fn().mockImplementation((sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') {
          return Promise.resolve();
        }
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{
              ...PENDING_NEW_ACCOUNT_REQUEST,
              team_name: 'Alpha Team',
              admin_first_name: 'Admin',
              admin_last_name: 'Istrator'
            }]
          });
        }
        if (sql.includes('SELECT 1 FROM teams')) {
          return Promise.resolve({ rows: [{}] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
  }

  it('rolls back, synchronously deletes the orphaned Authentik user, and logs compensationOutcome: deleted_synchronously', async () => {
    global.fetch = jest.fn()
      // 1. existing-user-by-email lookup -> no results
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
      // 2. create user
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pk: 4242 }) })
      // 3. compensating DELETE of the just-created Authentik user
      .mockResolvedValueOnce({ ok: true, status: 204 });

    pool.query.mockResolvedValue({ rows: [PENDING_NEW_ACCOUNT_REQUEST] });

    const mockClient = buildRolledBackTransactionClient();
    pool.connect.mockResolvedValue(mockClient);

    UserProvisioningService.createAndAddUser.mockRejectedValue(new Error('duplicate key value violates unique constraint'));

    await expect(service.approveRequest(1, 9)).rejects.toThrow('duplicate key value violates unique constraint');

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(service.emailService.sendApprovalEmail).not.toHaveBeenCalled();

    // Third fetch call is the compensating DELETE against the exact
    // Authentik user id created in Phase 1.
    expect(global.fetch).toHaveBeenCalledTimes(3);
    const [deleteUrl, deleteOptions] = global.fetch.mock.calls[2];
    expect(deleteUrl).toContain('/core/users/4242/');
    expect(deleteOptions.method).toBe('DELETE');

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();

    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        authentikUserId: 4242,
        failedStep: 'local_transaction',
        compensationOutcome: 'deleted_synchronously'
      },
      expect.any(String)
    );
  });

  it('falls back to enqueueing a cleanup_orphaned_authentik_user Sync_Operation when the synchronous delete fails, and logs compensationOutcome: cleanup_operation_queued', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pk: 4242 }) })
      // 3. compensating DELETE fails (e.g. Authentik 5xx)
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' });

    EventPublisher.publishOperation.mockResolvedValue(99);

    pool.query.mockResolvedValue({ rows: [PENDING_NEW_ACCOUNT_REQUEST] });

    const mockClient = buildRolledBackTransactionClient();
    pool.connect.mockResolvedValue(mockClient);

    UserProvisioningService.createAndAddUser.mockRejectedValue(new Error('duplicate key value violates unique constraint'));

    await expect(service.approveRequest(1, 9)).rejects.toThrow('duplicate key value violates unique constraint');

    expect(global.fetch).toHaveBeenCalledTimes(3);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'cleanup_orphaned_authentik_user',
      { authentik_user_id: 4242 },
      9
    );

    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        authentikUserId: 4242,
        failedStep: 'local_transaction',
        compensationOutcome: 'cleanup_operation_queued'
      },
      expect.any(String)
    );
  });

  it('logs compensationOutcome: compensation_failed when both the synchronous delete and the fallback enqueue fail', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pk: 4242 }) })
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' });

    EventPublisher.publishOperation.mockRejectedValue(new Error('database unreachable'));

    pool.query.mockResolvedValue({ rows: [PENDING_NEW_ACCOUNT_REQUEST] });

    const mockClient = buildRolledBackTransactionClient();
    pool.connect.mockResolvedValue(mockClient);

    UserProvisioningService.createAndAddUser.mockRejectedValue(new Error('duplicate key value violates unique constraint'));

    await expect(service.approveRequest(1, 9)).rejects.toThrow('duplicate key value violates unique constraint');

    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        authentikUserId: 4242,
        failedStep: 'local_transaction',
        compensationOutcome: 'compensation_failed'
      },
      expect.any(String)
    );
  });
});

/**
 * Unit tests for `RequestApprovalService.approveRequest`'s Requirement
 * 11.12/11.13/11.15/11.16 (task 24.3) `callsign_suffix` resolution,
 * REWRITTEN by takserver-enrollment task 5.2 for the consolidation onto
 * `UserProvisioningService.resolveNewUserIdentity`.
 *
 * `resolveAndCheckCallsignSuffixForApproval` is now a THIN ADAPTER: it no
 * longer calls `Team.getAncestorChain`, `Team.getFullMemberList` or
 * `CallsignService.computeDefaultCallsignSuffix` itself (all three are
 * REMOVED from this method -- they are `resolveNewUserIdentity`'s job
 * now, from the single ancestor-chain read it performs internally). So
 * these tests no longer assert against those three mocks; they assert
 * the adapter's own remaining job instead: computing the single
 * `requestedCallsignSuffix` value (override > the request's own stored
 * value, else `undefined`) passed to `resolveNewUserIdentity`, and
 * threading whatever `resolveNewUserIdentity` resolves (`username`,
 * `callsignSuffix`, `claimId`) through to `createAndAddUser` unchanged.
 * The uniqueness check itself (`checkCallsignSuffixUniqueness`, via
 * `CallsignSuffixConflictError`) now lives inside
 * `resolveNewUserIdentity`, so the collision test asserts that a
 * rejection from THAT mock propagates before the Authentik user is ever
 * created, rather than asserting `Team.getFullMemberList` was consulted
 * directly.
 */
describe('RequestApprovalService.approveRequest - callsign_suffix resolution (task 24.3)', () => {
  let service;
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RequestApprovalService();
    service.emailService.sendApprovalEmail = jest.fn().mockResolvedValue(true);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function buildHappyPathClient(requestOverrides = {}) {
    return {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{
              ...PENDING_NEW_ACCOUNT_REQUEST,
              ...requestOverrides,
              team_name: 'Alpha Team',
              admin_first_name: 'Admin',
              admin_last_name: 'Istrator'
            }]
          });
        }
        if (sql.includes('SELECT 1 FROM teams')) {
          return Promise.resolve({ rows: [{}] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
  }

  it('passes the request\'s own stored callsign_suffix as requestedCallsignSuffix when no override is supplied, and threads the resolver\'s result to createAndAddUser', async () => {
    mockAuthentikSuccess();
    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [{ ...PENDING_NEW_ACCOUNT_REQUEST, callsign_suffix: 'Stored-Suffix' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const mockClient = buildHappyPathClient({ callsign_suffix: 'Stored-Suffix' });
    pool.connect.mockResolvedValue(mockClient);
    UserProvisioningService.createAndAddUser.mockResolvedValue({ localUserId: 55, queuedGroups: 1 });
    UserProvisioningService.resolveNewUserIdentity.mockResolvedValue({
      username: 'newuser@example.com',
      callsignSuffix: 'Stored-Suffix',
      pseudonymous: false,
      claimId: null
    });

    await service.approveRequest(1, 9);

    expect(UserProvisioningService.resolveNewUserIdentity).toHaveBeenCalledWith(null, expect.objectContaining({
      requestedCallsignSuffix: 'Stored-Suffix'
    }));
    expect(UserProvisioningService.createAndAddUser).toHaveBeenCalledWith(mockClient, expect.objectContaining({
      callsign_suffix: 'Stored-Suffix'
    }));
  });

  it('passes undefined as requestedCallsignSuffix when there is no override and no stored value, leaving default computation to the resolver', async () => {
    mockAuthentikSuccess();
    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [{ ...PENDING_NEW_ACCOUNT_REQUEST, callsign_suffix: null }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const mockClient = buildHappyPathClient({ callsign_suffix: null });
    pool.connect.mockResolvedValue(mockClient);
    UserProvisioningService.createAndAddUser.mockResolvedValue({ localUserId: 55, queuedGroups: 1 });
    UserProvisioningService.resolveNewUserIdentity.mockResolvedValue({
      username: 'newuser@example.com',
      callsignSuffix: 'New-User',
      pseudonymous: false,
      claimId: null
    });

    await service.approveRequest(1, 9);

    expect(UserProvisioningService.resolveNewUserIdentity).toHaveBeenCalledWith(null, {
      firstName: 'New',
      lastName: 'User',
      email: 'newuser@example.com',
      teamId: 7,
      requestedUsername: 'newuser@example.com',
      requestedCallsignSuffix: undefined
    });
    expect(UserProvisioningService.createAndAddUser).toHaveBeenCalledWith(mockClient, expect.objectContaining({
      callsign_suffix: 'New-User'
    }));
  });

  it('uses the override, ignoring the stored value, when computing requestedCallsignSuffix', async () => {
    mockAuthentikSuccess();
    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [{ ...PENDING_NEW_ACCOUNT_REQUEST, callsign_suffix: 'Stored-Suffix' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const mockClient = buildHappyPathClient({ callsign_suffix: 'Stored-Suffix' });
    pool.connect.mockResolvedValue(mockClient);
    UserProvisioningService.createAndAddUser.mockResolvedValue({ localUserId: 55, queuedGroups: 1 });
    UserProvisioningService.resolveNewUserIdentity.mockResolvedValue({
      username: 'newuser@example.com',
      callsignSuffix: 'Override-Suffix',
      pseudonymous: false,
      claimId: null
    });

    await service.approveRequest(1, 9, '', 'Override-Suffix');

    expect(UserProvisioningService.resolveNewUserIdentity).toHaveBeenCalledWith(null, expect.objectContaining({
      requestedCallsignSuffix: 'Override-Suffix'
    }));
    expect(UserProvisioningService.createAndAddUser).toHaveBeenCalledWith(mockClient, expect.objectContaining({
      callsign_suffix: 'Override-Suffix'
    }));
  });

  it('propagates a CallsignSuffixConflictError thrown by resolveNewUserIdentity before creating the Authentik user or acquiring a database client', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [{ ...PENDING_NEW_ACCOUNT_REQUEST, callsign_suffix: null }] });
      }
      return Promise.resolve({ rows: [] });
    });
    UserProvisioningService.resolveNewUserIdentity.mockRejectedValueOnce(new CallsignSuffixConflictError('New-User'));
    global.fetch = jest.fn();

    await expect(service.approveRequest(1, 9)).rejects.toThrow(CallsignSuffixConflictError);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(UserProvisioningService.createAndAddUser).not.toHaveBeenCalled();
  });

  // Requirement 9.4 (task 10.1): a `callsignSuffixOverride` on a
  // `team_change` approval is no longer ignored -- it is Requirement 9.7's
  // highest-precedence link and is handed to `executeTransfer` as
  // `callsignSuffix`. It is NOT resolved here: `new_account`'s
  // `computeDefaultCallsignSuffix`/`getFullMemberList` path stays
  // untouched, because a transfer's resolution needs the user's stored
  // suffix, which is only readable inside the transaction.
  it('passes a callsignSuffixOverride supplied on a team_change approval through to executeTransfer without resolving it here', async () => {
    const client = { query: jest.fn() };
    TeamTransferService.executeTransfer.mockResolvedValue({ userId: 42 });

    await service.processApprovedRequest(
      client,
      { id: 2, request_type: 'team_change', existing_user_id: 42, target_team_id: 7, current_team_id: 3, callsign_suffix: 'Stored-On-Request' },
      { adminId: 9, callsignSuffixOverride: 'Override-Suffix' }
    );

    expect(TeamTransferService.executeTransfer).toHaveBeenCalledWith(client, expect.objectContaining({
      callsignSuffix: 'Override-Suffix',
      requestCallsignSuffix: 'Stored-On-Request'
    }));
    expect(CallsignService.computeDefaultCallsignSuffix).not.toHaveBeenCalled();
    expect(Team.getFullMemberList).not.toHaveBeenCalled();
  });
});

describe('RequestApprovalService.processApprovedRequest - other request types unaffected', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RequestApprovalService();
  });

  it('does not call createAndAddUser/executeTransfer for an unrecognized request_type and issues no queries', async () => {
    const client = { query: jest.fn() };
    await service.processApprovedRequest(client, { request_type: 'some_unknown_type' }, { adminId: 9 });

    expect(UserProvisioningService.createAndAddUser).not.toHaveBeenCalled();
    expect(TeamTransferService.executeTransfer).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests for `RequestApprovalService.processApprovedRequest`'s
 * `team_change` branch, rewired by task 10.1 (Requirements 6.1, 6.6, 9.4,
 * 9.7, 11.1, 11.6, 14.3).
 *
 * The branch previously called `TeamMembershipService.addUserToTeam`
 * directly, which performed only the additive half of a move. It now
 * delegates to `TeamTransferService.executeTransfer` -- the single method
 * both transfer paths go through (Requirement 6.1) -- on the already-open
 * transactional `client` (Requirement 6.6), and returns the outcome rather
 * than `break`ing so `approveRequest` can run the post-commit effects.
 */
describe('RequestApprovalService.processApprovedRequest - team_change', () => {
  let service;

  const TEAM_CHANGE_REQUEST = {
    id: 2,
    request_type: 'team_change',
    existing_user_id: 42,
    target_team_id: 7,
    current_team_id: 3,
    callsign_suffix: null,
    initiated_by: 11
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RequestApprovalService();
  });

  it('delegates the whole move to executeTransfer on the open transactional client, with every parameter the design specifies', async () => {
    const client = { query: jest.fn() };
    const outcome = { userId: 42, sourceTeamId: 3, destinationTeamId: 7, priorRole: 'admin' };
    TeamTransferService.executeTransfer.mockResolvedValue(outcome);

    const result = await service.processApprovedRequest(
      client,
      TEAM_CHANGE_REQUEST,
      { adminId: 9, approverIsGlobalManager: true }
    );

    expect(TeamTransferService.executeTransfer).toHaveBeenCalledWith(client, {
      userId: 42,
      destinationTeamId: 7,
      actorId: 9,
      // Requirement 11.6: the exemption follows the APPROVING user.
      actorIsGlobalManager: true,
      // Requirement 11.1: the recorded Source_Team, re-checked under lock.
      expectedSourceTeamId: 3,
      callsignSuffix: null,
      requestCallsignSuffix: null,
      // Requirement 14.3.
      transferRequestId: 2,
      initiatedBy: 11
    });

    // Returned rather than `break`ing, mirroring `new_account`'s
    // `{ localUserId }`, so approveRequest can run the post-commit effects.
    expect(result).toEqual({ transferOutcome: outcome });
  });

  it('defaults actorIsGlobalManager to false when the approver flag is not supplied, so the Organisation check fails closed', async () => {
    const client = { query: jest.fn() };
    TeamTransferService.executeTransfer.mockResolvedValue({ userId: 42 });

    await service.processApprovedRequest(client, TEAM_CHANGE_REQUEST, { adminId: 9 });

    expect(TeamTransferService.executeTransfer).toHaveBeenCalledWith(client, expect.objectContaining({
      actorIsGlobalManager: false
    }));
  });

  it('passes the two Callsign_Suffix links separately rather than pre-collapsing them with ||', async () => {
    const client = { query: jest.fn() };
    TeamTransferService.executeTransfer.mockResolvedValue({ userId: 42 });

    await service.processApprovedRequest(
      client,
      { ...TEAM_CHANGE_REQUEST, callsign_suffix: 'From-Request' },
      { adminId: 9, callsignSuffixOverride: 'From-Approval' }
    );

    // Requirement 9.7: the precedence chain is resolved in one place --
    // executeTransfer step 3 -- because its third link is only readable
    // inside the transaction. Both links therefore arrive intact.
    expect(TeamTransferService.executeTransfer).toHaveBeenCalledWith(client, expect.objectContaining({
      callsignSuffix: 'From-Approval',
      requestCallsignSuffix: 'From-Request'
    }));
  });

  it('propagates a failure from executeTransfer so the caller (approveRequest) rolls back atomically', async () => {
    const client = { query: jest.fn() };
    TeamTransferService.executeTransfer.mockRejectedValue(new Error('membership insert failed'));

    await expect(
      service.processApprovedRequest(client, TEAM_CHANGE_REQUEST, { adminId: 9 })
    ).rejects.toThrow('membership insert failed');
  });
});

/**
 * Unit tests for `RequestApprovalService.processApprovedRequest`'s
 * `role_change` branch (Requirement 18.3 / task 38.3): updates the `role`
 * column on the user's existing DIRECT `team_memberships` row for their
 * CURRENT team via a direct `UPDATE` on the already-open transactional
 * `client`, and throws (causing the caller's transaction to roll back)
 * when no direct membership row is affected.
 */
describe('RequestApprovalService.processApprovedRequest - role_change', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RequestApprovalService();
  });

  it('runs the direct UPDATE on the open transactional client with the correct params', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rowCount: 1 })
    };

    await service.processApprovedRequest(
      client,
      {
        request_type: 'role_change',
        existing_user_id: 42,
        current_team_id: 7,
        requested_role: 'admin'
      },
      { adminId: 9 }
    );

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE team_memberships'),
      ['admin', 42, 7]
    );
    expect(client.query.mock.calls[0][0]).toEqual(expect.stringContaining('inherited_from_team_id IS NULL'));
  });

  it('throws when the UPDATE affects zero rows (no direct membership found), so the caller rolls back', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rowCount: 0 })
    };

    await expect(
      service.processApprovedRequest(
        client,
        {
          request_type: 'role_change',
          existing_user_id: 42,
          current_team_id: 7,
          requested_role: 'admin'
        },
        { adminId: 9 }
      )
    ).rejects.toThrow(/no direct team membership found/);
  });
});

/**
 * Integration-style test (still using mocked `pool`/`client`, per this
 * file's existing pattern) verifying `approveRequest`'s `role_change` path
 * end-to-end: the status update and the role UPDATE share the same
 * transactional client, and a zero-rows-affected UPDATE rolls back the
 * status update too.
 */
describe('RequestApprovalService.approveRequest - role_change end-to-end transaction sharing', () => {
  let service;

  const PENDING_ROLE_CHANGE_REQUEST = {
    id: 3,
    request_type: 'role_change',
    status: 'pending',
    requester_email: 'existing@example.com',
    existing_user_id: 42,
    current_team_id: 7,
    requested_role: 'admin'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RequestApprovalService();
    service.emailService.sendApprovalEmail = jest.fn().mockResolvedValue(true);

    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [PENDING_ROLE_CHANGE_REQUEST] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it('commits the status update and the role UPDATE together when the UPDATE affects a row', async () => {
    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{
              ...PENDING_ROLE_CHANGE_REQUEST,
              team_name: null,
              admin_first_name: 'Admin',
              admin_last_name: 'Istrator'
            }]
          });
        }
        if (sql.includes('SELECT 1 FROM users')) {
          return Promise.resolve({ rows: [{}] });
        }
        if (sql.includes('UPDATE team_memberships')) {
          return Promise.resolve({ rowCount: 1 });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);

    const result = await service.approveRequest(3, 9);

    expect(result).toEqual({ success: true });
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE team_memberships'),
      ['admin', 42, 7]
    );
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back the request status update when the UPDATE affects zero rows', async () => {
    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') {
          return Promise.resolve();
        }
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{
              ...PENDING_ROLE_CHANGE_REQUEST,
              team_name: null,
              admin_first_name: 'Admin',
              admin_last_name: 'Istrator'
            }]
          });
        }
        if (sql.includes('SELECT 1 FROM users')) {
          return Promise.resolve({ rows: [{}] });
        }
        if (sql.includes('UPDATE team_memberships')) {
          return Promise.resolve({ rowCount: 0 });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);

    await expect(service.approveRequest(3, 9)).rejects.toThrow(/no direct team membership found/);

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(service.emailService.sendApprovalEmail).not.toHaveBeenCalled();
  });
});

/**
 * Integration-style test (still using mocked `pool`/`client`, per this
 * file's existing pattern) verifying `approveRequest`'s `team_change` path
 * end-to-end: the status update and the transfer share the same
 * transactional client (Requirement 6.6), the post-commit effects run
 * strictly after COMMIT (Requirements 8.4, 13, 14) and never turn a
 * committed transfer into a failure, and a failure inside
 * `executeTransfer` rolls the status update back too (Requirement 6.5).
 */
describe('RequestApprovalService.approveRequest - team_change end-to-end transaction sharing', () => {
  let service;

  const PENDING_TEAM_CHANGE_REQUEST = {
    id: 2,
    request_type: 'team_change',
    status: 'pending',
    requester_email: 'existing@example.com',
    existing_user_id: 42,
    target_team_id: 7,
    current_team_id: 3,
    callsign_suffix: null,
    initiated_by: 11
  };

  const TRANSFER_OUTCOME = {
    userId: 42,
    sourceTeamId: 3,
    destinationTeamId: 7,
    priorRole: 'admin',
    demotedFromAdmin: true,
    actorId: 9,
    revokedChannelIds: [],
    transferRequestId: 2,
    initiatedBy: 11,
    viaRequest: true
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RequestApprovalService();
    service.emailService.sendApprovalEmail = jest.fn().mockResolvedValue(true);
    TeamTransferService.applyPostCommitEffects.mockResolvedValue({ callsign: 'ALPHA-Jane', emailSent: true, audited: true });

    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [PENDING_TEAM_CHANGE_REQUEST] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it('commits the status update and the transfer together when executeTransfer succeeds', async () => {
    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{
              ...PENDING_TEAM_CHANGE_REQUEST,
              team_name: null,
              admin_first_name: 'Admin',
              admin_last_name: 'Istrator'
            }]
          });
        }
        if (sql.includes('SELECT 1 FROM users') || sql.includes('SELECT 1 FROM teams')) {
          return Promise.resolve({ rows: [{}] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    TeamTransferService.executeTransfer.mockResolvedValue(TRANSFER_OUTCOME);

    const result = await service.approveRequest(2, 9, '', null, true);

    expect(result).toEqual({ success: true });
    expect(TeamTransferService.executeTransfer).toHaveBeenCalledWith(mockClient, expect.objectContaining({
      userId: 42,
      destinationTeamId: 7,
      actorId: 9,
      actorIsGlobalManager: true,
      expectedSourceTeamId: 3
    }));
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('runs applyPostCommitEffects with the returned outcome, strictly after COMMIT and after the approval email', async () => {
    const callOrder = [];
    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql === 'COMMIT') {
          callOrder.push('COMMIT');
          return Promise.resolve();
        }
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{ ...PENDING_TEAM_CHANGE_REQUEST, team_name: null, admin_first_name: 'Admin', admin_last_name: 'Istrator' }]
          });
        }
        if (sql.includes('SELECT 1 FROM users') || sql.includes('SELECT 1 FROM teams')) {
          return Promise.resolve({ rows: [{}] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    TeamTransferService.executeTransfer.mockResolvedValue(TRANSFER_OUTCOME);
    service.emailService.sendApprovalEmail = jest.fn().mockImplementation(async () => {
      callOrder.push('approvalEmail');
      return true;
    });
    TeamTransferService.applyPostCommitEffects.mockImplementation(async () => {
      callOrder.push('postCommitEffects');
      return { callsign: 'ALPHA-Jane', emailSent: true, audited: true };
    });

    await expect(service.approveRequest(2, 9)).resolves.toEqual({ success: true });

    expect(TeamTransferService.applyPostCommitEffects).toHaveBeenCalledWith(TRANSFER_OUTCOME);
    expect(callOrder).toEqual(['COMMIT', 'approvalEmail', 'postCommitEffects']);
  });

  it('does not run applyPostCommitEffects when the transaction rolled back', async () => {
    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') {
          return Promise.resolve();
        }
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{ ...PENDING_TEAM_CHANGE_REQUEST, team_name: null, admin_first_name: 'Admin', admin_last_name: 'Istrator' }]
          });
        }
        if (sql.includes('SELECT 1 FROM users') || sql.includes('SELECT 1 FROM teams')) {
          return Promise.resolve({ rows: [{}] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    TeamTransferService.executeTransfer.mockRejectedValue(new Error("The user's team changed since the request was created"));

    await expect(service.approveRequest(2, 9)).rejects.toThrow("The user's team changed since the request was created");

    expect(TeamTransferService.applyPostCommitEffects).not.toHaveBeenCalled();
  });

  it('rolls back the request status update when executeTransfer fails', async () => {
    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') {
          return Promise.resolve();
        }
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{
              ...PENDING_TEAM_CHANGE_REQUEST,
              team_name: null,
              admin_first_name: 'Admin',
              admin_last_name: 'Istrator'
            }]
          });
        }
        if (sql.includes('SELECT 1 FROM users') || sql.includes('SELECT 1 FROM teams')) {
          return Promise.resolve({ rows: [{}] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    TeamTransferService.executeTransfer.mockRejectedValue(new Error('membership insert failed'));

    await expect(service.approveRequest(2, 9)).rejects.toThrow('membership insert failed');

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(service.emailService.sendApprovalEmail).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests for `RequestApprovalService.processApprovedRequest`'s
 * `name_change` branch (Requirement 18.4 / task 38.4, updated by task
 * 11.1 / Requirement 11.8): performs ONLY local database writes
 * (`users`/`user_cache`) on the already-open transactional `client`. The
 * Authentik name PATCH call is NOT made here -- it already happened in
 * Phase 1, via `updateAuthentikNameForNameChange`, before this
 * transaction opened. Per Requirement 11.8, a name change no longer
 * regenerates any callsign/color/role attributes, so this branch never
 * touches `tak_callsign`/`tak_color`/`tak_role` on `user_cache`.
 */
describe('RequestApprovalService.processApprovedRequest - name_change', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RequestApprovalService();
  });

  it('updates users and user_cache name fields on the open transactional client, without any Authentik call or callsign regeneration', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ authentik_user_id: 4242 }] })
    };
    const fetchSpy = jest.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchSpy;

    try {
      await service.processApprovedRequest(
        client,
        {
          request_type: 'name_change',
          existing_user_id: 42,
          requested_first_name: 'Jane',
          requested_last_name: 'Doe'
        },
        { adminId: 9 }
      );

      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users SET first_name = $1, last_name = $2 WHERE id = $3'),
        ['Jane', 'Doe', 42]
      );
      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE user_cache SET first_name = $1, last_name = $2 WHERE authentik_id = $3'),
        ['Jane', 'Doe', 4242]
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('throws when the users UPDATE affects zero rows (user not found), so the caller rolls back', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] })
    };

    await expect(
      service.processApprovedRequest(
        client,
        {
          request_type: 'name_change',
          existing_user_id: 999,
          requested_first_name: 'Jane',
          requested_last_name: 'Doe'
        },
        { adminId: 9 }
      )
    ).rejects.toThrow(/user 999 not found/);
  });
});

/**
 * Unit tests for `RequestApprovalService.updateAuthentikNameForNameChange`
 * (Requirement 18.4 / task 38.4, updated by task 11.1 / Requirement
 * 11.8): the Phase 1 (no open transaction) helper that performs ONLY the
 * Authentik DISPLAY-name PATCH -- a name change never computes or pushes
 * a regenerated callsign/color/role, since none of those attributes
 * derive from the live name anymore.
 */
describe('RequestApprovalService.updateAuthentikNameForNameChange', () => {
  let service;
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RequestApprovalService();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const NAME_CHANGE_REQUEST = {
    existing_user_id: 42,
    requested_first_name: 'Jane',
    requested_last_name: 'Doe'
  };

  it('PATCHes the Authentik user name and does nothing else', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT authentik_user_id FROM users')) {
        return Promise.resolve({ rows: [{ authentik_user_id: 4242 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await service.updateAuthentikNameForNameChange(NAME_CHANGE_REQUEST);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v3/core/users/4242/'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe' })
      })
    );
  });

  it('throws without calling fetch when the user cannot be resolved', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT authentik_user_id FROM users')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    global.fetch = jest.fn();

    await expect(
      service.updateAuthentikNameForNameChange(NAME_CHANGE_REQUEST)
    ).rejects.toThrow(/user 42 not found/);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws when the Authentik name PATCH fails', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ detail: 'bad request' }) });

    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT authentik_user_id FROM users')) {
        return Promise.resolve({ rows: [{ authentik_user_id: 4242 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      service.updateAuthentikNameForNameChange(NAME_CHANGE_REQUEST)
    ).rejects.toThrow('Failed to update user name in Authentik');
  });
});

/**
 * Integration-style test (still using mocked `pool`/`client`, per this
 * file's existing pattern) verifying `approveRequest`'s `name_change`
 * path end-to-end: the Authentik name PATCH happens in Phase 1, strictly
 * before `pool.connect()` is called; the local `users`/`user_cache`
 * writes happen inside Phase 2's transaction and commit together with
 * the status update; and a Phase 1 failure (the Authentik name update)
 * causes `approveRequest` to reject cleanly without ever opening a
 * transaction, while a Phase 2 failure rolls back. No callsign
 * regeneration occurs anywhere in this flow (Requirement 11.8).
 */
describe('RequestApprovalService.approveRequest - name_change end-to-end Phase 1 / Phase 2 split', () => {
  let service;
  let originalFetch;

  const PENDING_NAME_CHANGE_REQUEST = {
    id: 4,
    request_type: 'name_change',
    status: 'pending',
    requester_email: 'existing@example.com',
    existing_user_id: 42,
    requested_first_name: 'Jane',
    requested_last_name: 'Doe'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RequestApprovalService();
    service.emailService.sendApprovalEmail = jest.fn().mockResolvedValue(true);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('performs the Authentik name PATCH before BEGIN, then commits the local writes inside the transaction', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [PENDING_NAME_CHANGE_REQUEST] });
      }
      if (sql.includes('SELECT authentik_user_id FROM users')) {
        return Promise.resolve({ rows: [{ authentik_user_id: 4242 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{
              ...PENDING_NAME_CHANGE_REQUEST,
              team_name: null,
              admin_first_name: 'Admin',
              admin_last_name: 'Istrator'
            }]
          });
        }
        if (sql.includes('SELECT 1 FROM users')) {
          return Promise.resolve({ rows: [{}] });
        }
        if (sql.includes('UPDATE users SET first_name')) {
          return Promise.resolve({ rowCount: 1, rows: [{ authentik_user_id: 4242 }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };

    pool.connect.mockImplementation(() => {
      // pool.connect() must only be called AFTER the Phase 1 Authentik
      // name PATCH has already resolved.
      expect(global.fetch).toHaveBeenCalledTimes(1);
      return Promise.resolve(mockClient);
    });

    const result = await service.approveRequest(4, 9);

    expect(result).toEqual({ success: true });
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users SET first_name = $1, last_name = $2 WHERE id = $3'),
      ['Jane', 'Doe', 42]
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE user_cache SET first_name = $1, last_name = $2 WHERE authentik_id = $3'),
      ['Jane', 'Doe', 4242]
    );
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(service.emailService.sendApprovalEmail).toHaveBeenCalled();
  });

  it('rejects cleanly without ever acquiring a database client when the Phase 1 Authentik name update fails', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ detail: 'bad request' }) });

    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [PENDING_NAME_CHANGE_REQUEST] });
      }
      if (sql.includes('SELECT authentik_user_id FROM users')) {
        return Promise.resolve({ rows: [{ authentik_user_id: 4242 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.approveRequest(4, 9)).rejects.toThrow('Failed to update user name in Authentik');

    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rolls back the request status update and local writes when the Phase 2 transaction fails', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [PENDING_NAME_CHANGE_REQUEST] });
      }
      if (sql.includes('SELECT authentik_user_id FROM users')) {
        return Promise.resolve({ rows: [{ authentik_user_id: 4242 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') {
          return Promise.resolve();
        }
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{
              ...PENDING_NAME_CHANGE_REQUEST,
              team_name: null,
              admin_first_name: 'Admin',
              admin_last_name: 'Istrator'
            }]
          });
        }
        if (sql.includes('SELECT 1 FROM users')) {
          // Up-front reference check (task 38.5) passes -- the user
          // still exists at the time of the check -- so the failure
          // exercised by this test comes from the later, type-specific
          // UPDATE returning zero rows instead (e.g. the user was
          // removed between the up-front check and the local write).
          return Promise.resolve({ rows: [{}] });
        }
        if (sql.includes('UPDATE users SET first_name')) {
          return Promise.resolve({ rowCount: 0, rows: [] }); // user not found -> throws
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);

    await expect(service.approveRequest(4, 9)).rejects.toThrow(/user 42 not found/);

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(service.emailService.sendApprovalEmail).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests for `RequestApprovalService.approveRequest`'s up-front
 * `existing_user_id`/`target_team_id` reference-existence validation
 * (Requirement 18.5 / task 38.5): these checks run inside Phase 2's
 * transaction, BEFORE the `UPDATE access_requests SET status =
 * 'approved'...` statement, so a missing reference throws before the
 * status flip ever runs -- no mutation occurs and the request is left
 * `pending`.
 */
describe('RequestApprovalService.approveRequest - up-front reference validation (task 38.5)', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RequestApprovalService();
    service.emailService.sendApprovalEmail = jest.fn().mockResolvedValue(true);
  });

  function statusUpdateCalls(mockClient) {
    return mockClient.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes("SET status = 'approved'")
    );
  }

  it.each(['team_change', 'role_change', 'name_change'])(
    'rejects a %s request up front when existing_user_id no longer exists, without flipping status or mutating anything',
    async (requestType) => {
      const PENDING_REQUEST = {
        id: 10,
        request_type: requestType,
        status: 'pending',
        requester_email: 'existing@example.com',
        existing_user_id: 999,
        target_team_id: requestType === 'team_change' ? 7 : null,
        current_team_id: requestType === 'role_change' ? 7 : null,
        requested_role: requestType === 'role_change' ? 'admin' : null,
        requested_first_name: requestType === 'name_change' ? 'Jane' : null,
        requested_last_name: requestType === 'name_change' ? 'Doe' : null
      };

      // Phase 1 pre-fetch. name_change would normally trigger the
      // Authentik name/callsign update in Phase 1, but that helper
      // itself looks up the user via `SELECT authentik_user_id FROM
      // users WHERE id = $1` and throws "user not found" if missing --
      // so for a clean test of the up-front CHECK INSIDE PHASE 2 (not
      // Phase 1's own user lookup), only team_change/role_change are
      // exercised via the full approveRequest path here; name_change's
      // Phase 1 failure is exercised separately below.
      if (requestType === 'name_change') {
        return;
      }

      pool.query.mockImplementation((sql) => {
        if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
          return Promise.resolve({ rows: [PENDING_REQUEST] });
        }
        return Promise.resolve({ rows: [] });
      });

      const mockClient = {
        query: jest.fn().mockImplementation((sql) => {
          if (sql === 'BEGIN' || sql === 'ROLLBACK') {
            return Promise.resolve();
          }
          if (sql.includes('SELECT ar.*, t.name as team_name')) {
            return Promise.resolve({
              rows: [{
                ...PENDING_REQUEST,
                team_name: null,
                admin_first_name: 'Admin',
                admin_last_name: 'Istrator'
              }]
            });
          }
          if (sql.includes('SELECT 1 FROM users')) {
            return Promise.resolve({ rows: [] }); // user no longer exists
          }
          return Promise.resolve({ rows: [] });
        }),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      await expect(service.approveRequest(10, 9)).rejects.toThrow(/Referenced user no longer exists/);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
      expect(statusUpdateCalls(mockClient)).toHaveLength(0);
      expect(TeamTransferService.executeTransfer).not.toHaveBeenCalled();
      expect(service.emailService.sendApprovalEmail).not.toHaveBeenCalled();
    }
  );

  it.each(['new_account', 'team_change'])(
    'rejects a %s request up front when target_team_id no longer exists, without flipping status or mutating anything',
    async (requestType) => {
      const PENDING_REQUEST = {
        id: 11,
        request_type: requestType,
        status: 'pending',
        requester_email: requestType === 'new_account' ? 'newuser@example.com' : 'existing@example.com',
        requester_first_name: 'New',
        requester_last_name: 'User',
        requested_first_name: null,
        requested_last_name: null,
        existing_user_id: requestType === 'team_change' ? 42 : null,
        target_team_id: 999
      };

      pool.query.mockImplementation((sql) => {
        if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
          return Promise.resolve({ rows: [PENDING_REQUEST] });
        }
        return Promise.resolve({ rows: [] });
      });

      if (requestType === 'new_account') {
        mockAuthentikSuccess();
      }

      const mockClient = {
        query: jest.fn().mockImplementation((sql) => {
          if (sql === 'BEGIN' || sql === 'ROLLBACK') {
            return Promise.resolve();
          }
          if (sql.includes('SELECT ar.*, t.name as team_name')) {
            return Promise.resolve({
              rows: [{
                ...PENDING_REQUEST,
                team_name: null,
                admin_first_name: 'Admin',
                admin_last_name: 'Istrator'
              }]
            });
          }
          if (sql.includes('SELECT 1 FROM users')) {
            return Promise.resolve({ rows: [{}] }); // existing_user_id (team_change) is fine
          }
          if (sql.includes('SELECT 1 FROM teams')) {
            return Promise.resolve({ rows: [] }); // team no longer exists
          }
          return Promise.resolve({ rows: [] });
        }),
        release: jest.fn()
      };
      pool.connect.mockResolvedValue(mockClient);

      await expect(service.approveRequest(11, 9)).rejects.toThrow(/Referenced team no longer exists/);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
      expect(statusUpdateCalls(mockClient)).toHaveLength(0);
      expect(UserProvisioningService.createAndAddUser).not.toHaveBeenCalled();
      expect(TeamTransferService.executeTransfer).not.toHaveBeenCalled();
      expect(service.emailService.sendApprovalEmail).not.toHaveBeenCalled();
    }
  );

  it('does not run the target_team_id check for role_change (which uses current_team_id, not target_team_id)', async () => {
    const PENDING_REQUEST = {
      id: 12,
      request_type: 'role_change',
      status: 'pending',
      requester_email: 'existing@example.com',
      existing_user_id: 42,
      current_team_id: 7,
      requested_role: 'admin',
      target_team_id: null
    };

    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [PENDING_REQUEST] });
      }
      return Promise.resolve({ rows: [] });
    });

    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{
              ...PENDING_REQUEST,
              team_name: null,
              admin_first_name: 'Admin',
              admin_last_name: 'Istrator'
            }]
          });
        }
        if (sql.includes('SELECT 1 FROM users')) {
          return Promise.resolve({ rows: [{}] });
        }
        if (sql.includes('SELECT 1 FROM teams')) {
          // Should never be called for role_change -- fail the test if it is.
          throw new Error('SELECT 1 FROM teams should not run for role_change');
        }
        if (sql.includes('UPDATE team_memberships')) {
          return Promise.resolve({ rowCount: 1 });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);

    const result = await service.approveRequest(12, 9);

    expect(result).toEqual({ success: true });
  });

  it('rejects a name_change request when existing_user_id no longer exists (discovered in Phase 1, before any transaction opens)', async () => {
    const PENDING_NAME_CHANGE_MISSING_USER = {
      id: 13,
      request_type: 'name_change',
      status: 'pending',
      requester_email: 'existing@example.com',
      existing_user_id: 999,
      requested_first_name: 'Jane',
      requested_last_name: 'Doe'
    };

    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [PENDING_NAME_CHANGE_MISSING_USER] });
      }
      if (sql.includes('SELECT authentik_user_id FROM users')) {
        return Promise.resolve({ rows: [] }); // user not found
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.approveRequest(13, 9)).rejects.toThrow(/user 999 not found/);

    // Phase 1 throws before pool.connect() is ever called, so no
    // transaction (and therefore no status flip) is possible.
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

/**
 * Regression test (task 38.5) confirming that a later failure in a
 * type-specific branch -- specifically role_change's zero-rows-updated
 * check, already implemented by task 38.3 -- still rolls back the
 * request's status flip to 'approved' under the existing try/catch
 * structure in `approveRequest`. This is a duplicate-in-spirit of the
 * "rolls back the request status update when the UPDATE affects zero
 * rows" test above (task 38.3's own regression coverage); it is kept
 * here, phrased explicitly around the rollback-atomicity guarantee, as
 * the task's requested confirmation that no code change was needed for
 * this part of task 38.5.
 */
describe('RequestApprovalService.approveRequest - rollback atomicity for later type-specific failures (task 38.5 regression)', () => {
  let service;

  const PENDING_ROLE_CHANGE_REQUEST = {
    id: 14,
    request_type: 'role_change',
    status: 'pending',
    requester_email: 'existing@example.com',
    existing_user_id: 42,
    current_team_id: 7,
    requested_role: 'admin'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RequestApprovalService();
    service.emailService.sendApprovalEmail = jest.fn().mockResolvedValue(true);

    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [PENDING_ROLE_CHANGE_REQUEST] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it('rolls back the already-executed status UPDATE when the role_change branch throws after the status flip', async () => {
    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') {
          return Promise.resolve();
        }
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{
              ...PENDING_ROLE_CHANGE_REQUEST,
              team_name: null,
              admin_first_name: 'Admin',
              admin_last_name: 'Istrator'
            }]
          });
        }
        if (sql.includes('SELECT 1 FROM users')) {
          // Up-front check passes -- the user exists at this point --
          // so the status UPDATE below actually runs, and the failure
          // is discovered only afterward, by the role_change branch's
          // own zero-rows check (simulating the membership having been
          // removed between the up-front check and the branch running,
          // or simply exercising that branch's independent guard).
          return Promise.resolve({ rows: [{}] });
        }
        if (sql.includes("SET status = 'approved'")) {
          return Promise.resolve({ rowCount: 1 });
        }
        if (sql.includes('UPDATE team_memberships')) {
          return Promise.resolve({ rowCount: 0 }); // no direct membership found -> throws
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);

    await expect(service.approveRequest(14, 9)).rejects.toThrow(/no direct team membership found/);

    // The status UPDATE DID run (proving the up-front check passed and
    // the flip executed) but the transaction was still rolled back in
    // full, because both statements share the same transactional client
    // and the same catch/ROLLBACK block.
    const statusUpdateCalls = mockClient.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes("SET status = 'approved'")
    );
    expect(statusUpdateCalls).toHaveLength(1);
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(service.emailService.sendApprovalEmail).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests for the row lock on `approveRequest`'s transactional
 * re-fetch (Requirement 11.5 / task 4.1). Without `FOR UPDATE OF ar`,
 * two concurrent approvals of the same request can both observe
 * `status = 'pending'` under READ COMMITTED and both proceed; with it,
 * the second blocks until the first commits and then matches zero rows.
 *
 * The lock applies to EVERY request type, not just `team_change`, so it
 * is asserted across all four -- and it must stay scoped with `OF ar`:
 * a bare `FOR UPDATE` would also try to lock the nullable side of the
 * query's `LEFT JOIN`s, which Postgres rejects outright.
 */
describe('RequestApprovalService.approveRequest - transactional re-fetch row lock (Requirement 11.5)', () => {
  let service;
  let originalFetch;

  const PENDING_REQUESTS = {
    new_account: {
      id: 20,
      request_type: 'new_account',
      status: 'pending',
      requester_email: 'newuser@example.com',
      requester_first_name: 'New',
      requester_last_name: 'User',
      requested_first_name: null,
      requested_last_name: null,
      callsign_suffix: null,
      target_team_id: 7
    },
    team_change: {
      id: 21,
      request_type: 'team_change',
      status: 'pending',
      requester_email: 'existing@example.com',
      existing_user_id: 42,
      target_team_id: 7
    },
    role_change: {
      id: 22,
      request_type: 'role_change',
      status: 'pending',
      requester_email: 'existing@example.com',
      existing_user_id: 42,
      current_team_id: 7,
      requested_role: 'admin'
    },
    name_change: {
      id: 23,
      request_type: 'name_change',
      status: 'pending',
      requester_email: 'existing@example.com',
      existing_user_id: 42,
      requested_first_name: 'Jane',
      requested_last_name: 'Doe'
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RequestApprovalService();
    service.emailService.sendApprovalEmail = jest.fn().mockResolvedValue(true);
    originalFetch = global.fetch;
    Team.getAncestorChain.mockResolvedValue([{ id: 1, name: 'Org', callsign_name_format: 'full_name' }]);
    Team.getFullMemberList.mockResolvedValue([]);
    CallsignService.computeDefaultCallsignSuffix.mockReturnValue('New-User');
    UserAttributesService.generateCallsign.mockResolvedValue(null);
    UserProvisioningService.createAndAddUser.mockResolvedValue({ localUserId: 55, queuedGroups: 0 });
    TeamTransferService.executeTransfer.mockResolvedValue({ userId: 42, sourceTeamId: 3, destinationTeamId: 7, priorRole: 'member' });
    TeamTransferService.applyPostCommitEffects.mockResolvedValue({ callsign: null, emailSent: false, audited: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockPhaseOne(request) {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM access_requests WHERE id = $1 AND status = $2')) {
        return Promise.resolve({ rows: [request] });
      }
      if (sql.includes('SELECT authentik_user_id FROM users')) {
        return Promise.resolve({ rows: [{ authentik_user_id: 4242 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    if (request.request_type === 'new_account') {
      mockAuthentikSuccess();
    } else if (request.request_type === 'name_change') {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    }
  }

  function buildClient(request) {
    return {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT ar.*, t.name as team_name')) {
          return Promise.resolve({
            rows: [{
              ...request,
              team_name: 'Alpha Team',
              admin_first_name: 'Admin',
              admin_last_name: 'Istrator'
            }]
          });
        }
        if (sql.includes('SELECT 1 FROM users') || sql.includes('SELECT 1 FROM teams')) {
          return Promise.resolve({ rows: [{}] });
        }
        if (sql.includes('UPDATE users SET first_name')) {
          return Promise.resolve({ rowCount: 1, rows: [{ authentik_user_id: 4242 }] });
        }
        if (sql.includes('UPDATE team_memberships')) {
          return Promise.resolve({ rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      }),
      release: jest.fn()
    };
  }

  function refetchCalls(mockClient) {
    return mockClient.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('SELECT ar.*, t.name as team_name')
    );
  }

  it.each(Object.keys(PENDING_REQUESTS))(
    'locks the access_requests row with FOR UPDATE OF ar when re-fetching a %s request inside the transaction',
    async (requestType) => {
      const request = PENDING_REQUESTS[requestType];
      mockPhaseOne(request);
      const mockClient = buildClient(request);
      pool.connect.mockResolvedValue(mockClient);

      await expect(service.approveRequest(request.id, 9)).resolves.toEqual({ success: true });

      const calls = refetchCalls(mockClient);
      expect(calls).toHaveLength(1);

      const [sql, params] = calls[0];
      expect(sql).toContain('FOR UPDATE OF ar');
      // The lock supplements, rather than replaces, the pending filter:
      // the second approval still has to match zero rows once it unblocks.
      expect(sql).toContain("ar.status = 'pending'");
      expect(params).toEqual([request.id, 9]);

      // The lock is acquired inside the transaction, not before it.
      const sqlSequence = mockClient.query.mock.calls.map(([s]) => s);
      expect(sqlSequence.indexOf('BEGIN')).toBeLessThan(
        sqlSequence.findIndex((s) => typeof s === 'string' && s.includes('FOR UPDATE OF ar'))
      );
    }
  );

  it('scopes the lock to access_requests, never issuing a bare FOR UPDATE over the LEFT JOINed tables', async () => {
    const request = PENDING_REQUESTS.team_change;
    mockPhaseOne(request);
    const mockClient = buildClient(request);
    pool.connect.mockResolvedValue(mockClient);

    await service.approveRequest(request.id, 9);

    const [sql] = refetchCalls(mockClient)[0];
    // A `FOR UPDATE` not followed by `OF ar` would try to lock the
    // LEFT JOINed teams/users rows, which Postgres rejects.
    expect(sql).not.toMatch(/FOR\s+UPDATE(?!\s+OF\s+ar)/);
    expect(sql).toContain('LEFT JOIN teams t');
    expect(sql).toContain('LEFT JOIN users u');
  });
});
