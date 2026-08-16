/**
 * Unit tests for `BulkImportService.importUsers` (Requirement 29 Criteria
 * 2-4, 6; task 51.1):
 *   - all rows succeed
 *   - one row fails (Authentik creation error) while the rest continue
 *   - a row targeting a team the importing team-admin does not
 *     administer is rejected while the rest continue
 *   - a row missing a required field is rejected while the rest continue
 *
 * Each row's local writes are wrapped in their OWN transaction on their
 * OWN acquired client, so these tests also assert that a failing row's
 * client is rolled back and released without affecting any other row's
 * (separately acquired) client.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

jest.mock('../config/database', () => ({
  connect: jest.fn()
}));
jest.mock('../models/Team', () => ({
  isAdmin: jest.fn(),
  create: jest.fn()
}));
jest.mock('./authentik', () => ({
  createUser: jest.fn()
}));
jest.mock('./UserProvisioningService', () => ({
  createAndAddUser: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const Team = require('../models/Team');
const authentikService = require('./authentik');
const UserProvisioningService = require('./UserProvisioningService');
const BulkImportService = require('./BulkImportService');

function buildMockClient() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn()
  };
}

function csvFromRows(rows) {
  const header = 'email,firstName,lastName,teamId,username';
  const lines = rows.map((r) => [r.email ?? '', r.firstName ?? '', r.lastName ?? '', r.teamId ?? '', r.username ?? ''].join(','));
  return [header, ...lines].join('\n');
}

describe('BulkImportService.importUsers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.connect.mockImplementation(() => Promise.resolve(buildMockClient()));
    authentikService.createUser.mockResolvedValue({ pk: 1000 });
    UserProvisioningService.createAndAddUser.mockResolvedValue({ localUserId: 42, queuedGroups: 1 });
    Team.isAdmin.mockResolvedValue(true);
  });

  it('imports every row successfully when all rows are valid and authorized', async () => {
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '5' },
      { email: 'bob@example.com', firstName: 'Bob', lastName: 'Jones', teamId: '5' }
    ]);

    UserProvisioningService.createAndAddUser
      .mockResolvedValueOnce({ localUserId: 101, queuedGroups: 1 })
      .mockResolvedValueOnce({ localUserId: 102, queuedGroups: 1 });

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importUsers(csv, importingUser);

    expect(summary.successCount).toBe(2);
    expect(summary.failureCount).toBe(0);
    expect(summary.results).toEqual([
      { row: 1, success: true, userId: 101 },
      { row: 2, success: true, userId: 102 }
    ]);
    expect(authentikService.createUser).toHaveBeenCalledTimes(2);
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });

  it('continues processing remaining rows when one row fails Authentik user creation', async () => {
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '5' },
      { email: 'bob@example.com', firstName: 'Bob', lastName: 'Jones', teamId: '5' },
      { email: 'carol@example.com', firstName: 'Carol', lastName: 'Lee', teamId: '5' }
    ]);

    authentikService.createUser
      .mockResolvedValueOnce({ pk: 201 })
      .mockRejectedValueOnce(new Error('Authentik unreachable'))
      .mockResolvedValueOnce({ pk: 203 });

    UserProvisioningService.createAndAddUser
      .mockResolvedValueOnce({ localUserId: 301, queuedGroups: 1 })
      .mockResolvedValueOnce({ localUserId: 303, queuedGroups: 1 });

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importUsers(csv, importingUser);

    expect(summary.successCount).toBe(2);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[0]).toEqual({ row: 1, success: true, userId: 301 });
    expect(summary.results[1]).toEqual({ row: 2, success: false, error: 'Authentik unreachable' });
    expect(summary.results[2]).toEqual({ row: 3, success: true, userId: 303 });

    // Only 2 rows ever reached the local-transaction phase (row 2's
    // Authentik call failed before any client was acquired for it).
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });

  it('rejects a row targeting a team the importing team admin does not administer, continuing the rest', async () => {
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '5' },
      { email: 'bob@example.com', firstName: 'Bob', lastName: 'Jones', teamId: '99' },
      { email: 'carol@example.com', firstName: 'Carol', lastName: 'Lee', teamId: '5' }
    ]);

    Team.isAdmin.mockImplementation((teamId) => Promise.resolve(Number(teamId) === 5));

    UserProvisioningService.createAndAddUser
      .mockResolvedValueOnce({ localUserId: 401, queuedGroups: 1 })
      .mockResolvedValueOnce({ localUserId: 403, queuedGroups: 1 });

    const importingUser = { userId: 7, is_global_manager: false };
    const summary = await BulkImportService.importUsers(csv, importingUser);

    expect(summary.successCount).toBe(2);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[1].success).toBe(false);
    expect(summary.results[1].error).toMatch(/Unauthorized/);

    // The unauthorized row never called Authentik or acquired a client.
    expect(authentikService.createUser).toHaveBeenCalledTimes(2);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(Team.isAdmin).toHaveBeenCalledWith(5, 7);
    expect(Team.isAdmin).toHaveBeenCalledWith(99, 7);
  });

  it('rejects a row missing a required field, continuing the rest', async () => {
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '5' },
      { email: '', firstName: 'Bob', lastName: 'Jones', teamId: '5' },
      { email: 'carol@example.com', firstName: 'Carol', lastName: 'Lee', teamId: '5' }
    ]);

    UserProvisioningService.createAndAddUser
      .mockResolvedValueOnce({ localUserId: 501, queuedGroups: 1 })
      .mockResolvedValueOnce({ localUserId: 503, queuedGroups: 1 });

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importUsers(csv, importingUser);

    expect(summary.successCount).toBe(2);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[1]).toEqual({
      row: 2,
      success: false,
      error: 'Missing required field: email'
    });

    // The invalid row never reached Authentik or acquired a client.
    expect(authentikService.createUser).toHaveBeenCalledTimes(2);
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });

  it('rolls back and releases only the failing row\'s client when the local transaction fails', async () => {
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '5' },
      { email: 'bob@example.com', firstName: 'Bob', lastName: 'Jones', teamId: '5' }
    ]);

    const failingClient = buildMockClient();
    const succeedingClient = buildMockClient();
    pool.connect
      .mockResolvedValueOnce(failingClient)
      .mockResolvedValueOnce(succeedingClient);

    UserProvisioningService.createAndAddUser
      .mockRejectedValueOnce(new Error('constraint violation'))
      .mockResolvedValueOnce({ localUserId: 601, queuedGroups: 1 });

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importUsers(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[0]).toEqual({ row: 1, success: false, error: 'constraint violation' });
    expect(summary.results[1]).toEqual({ row: 2, success: true, userId: 601 });

    expect(failingClient.query).toHaveBeenCalledWith('BEGIN');
    expect(failingClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(failingClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(failingClient.release).toHaveBeenCalledTimes(1);

    expect(succeedingClient.query).toHaveBeenCalledWith('BEGIN');
    expect(succeedingClient.query).toHaveBeenCalledWith('COMMIT');
    expect(succeedingClient.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(succeedingClient.release).toHaveBeenCalledTimes(1);
  });
});

/**
 * Unit tests for `BulkImportService.importTeams` (Requirement 29.5;
 * task 51.2):
 *   - Global_Manager-only authorization for the WHOLE batch (rejected
 *     before any row is even read from the CSV, not per-row)
 *   - a row's parent resolved by `parentTeamName` (lookup by exact name)
 *   - a row's parent resolved by `parentTeamId` (used directly)
 *   - a root row with neither column (parent_team_id resolves to null)
 *   - one row fails (`parentTeamName` not found) while the rest continue
 */
function csvFromTeamRows(rows) {
  const header = 'name,parentTeamName,parentTeamId';
  const lines = rows.map((r) => [r.name ?? '', r.parentTeamName ?? '', r.parentTeamId ?? ''].join(','));
  return [header, ...lines].join('\n');
}

describe('BulkImportService.importTeams', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn()
    };
    pool.connect.mockImplementation(() => Promise.resolve(mockClient));
  });

  it('rejects the entire batch upfront when the importing user is not a Global_Manager', async () => {
    const csv = csvFromTeamRows([{ name: 'Southland District' }]);
    const importingUser = { userId: 7, is_global_manager: false };

    await expect(BulkImportService.importTeams(csv, importingUser)).rejects.toThrow(
      /Global_Manager/
    );

    // The batch is rejected before any row is read: no client acquired,
    // no Team.create call, unlike importUsers's per-row authorization.
    expect(pool.connect).not.toHaveBeenCalled();
    expect(Team.create).not.toHaveBeenCalled();
  });

  it('imports rows resolving a parent by name, by id, and with no parent (root team)', async () => {
    const csv = csvFromTeamRows([
      { name: 'Southland District', parentTeamName: 'FENZ' },
      { name: 'Otago District', parentTeamId: '3' },
      { name: 'FENZ' }
    ]);

    mockClient.query.mockImplementation((sql, params) => {
      if (sql === 'SELECT id FROM teams WHERE name = $1' && params[0] === 'FENZ') {
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    Team.create
      .mockResolvedValueOnce({ id: 101, name: 'Southland District', parent_team_id: 1 })
      .mockResolvedValueOnce({ id: 102, name: 'Otago District', parent_team_id: 3 })
      .mockResolvedValueOnce({ id: 103, name: 'FENZ', parent_team_id: null });

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.successCount).toBe(3);
    expect(summary.failureCount).toBe(0);
    expect(summary.results).toEqual([
      { row: 1, success: true, teamId: 101 },
      { row: 2, success: true, teamId: 102 },
      { row: 3, success: true, teamId: 103 }
    ]);

    expect(Team.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: 'Southland District', parent_team_id: 1 }));
    expect(Team.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: 'Otago District', parent_team_id: 3 }));
    expect(Team.create).toHaveBeenNthCalledWith(3, expect.objectContaining({ name: 'FENZ', parent_team_id: null }));
  });

  it('continues processing remaining rows when a parentTeamName lookup fails to find a match', async () => {
    const csv = csvFromTeamRows([
      { name: 'Southland District', parentTeamName: 'FENZ' },
      { name: 'Orphan Team', parentTeamName: 'DoesNotExist' },
      { name: 'Otago District', parentTeamName: 'FENZ' }
    ]);

    mockClient.query.mockImplementation((sql, params) => {
      if (sql === 'SELECT id FROM teams WHERE name = $1' && params[0] === 'FENZ') {
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    Team.create
      .mockResolvedValueOnce({ id: 201, name: 'Southland District', parent_team_id: 1 })
      .mockResolvedValueOnce({ id: 203, name: 'Otago District', parent_team_id: 1 });

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.successCount).toBe(2);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[0]).toEqual({ row: 1, success: true, teamId: 201 });
    expect(summary.results[1]).toEqual({
      row: 2,
      success: false,
      error: 'Parent team not found: DoesNotExist'
    });
    expect(summary.results[2]).toEqual({ row: 3, success: true, teamId: 203 });

    // The failing row never reached Team.create.
    expect(Team.create).toHaveBeenCalledTimes(2);
  });
});

// Feature: production-hardening, Property 14: CSV batch row processing is isolated
/**
 * Property-based test (design.md's Property 14) for `importUsers`'s
 * per-row isolation (Requirement 29.2, 29.6): each row's outcome must be
 * determined solely by that row's own content, independent of any other
 * row's validity and independent of row ordering within the batch.
 *
 * Each generated row "spec" is one of four kinds -- `valid`,
 * `missingField` (blank required `email`), `unauthorizedTeam` (a team id
 * this team-admin importing user does not administer), or
 * `authentikFailure` (Authentik user creation rejects for this row's
 * email) -- and every mock (`Team.isAdmin`, `authentikService.
 * createUser`) is configured to key its per-call behavior off of THAT
 * row's own unique teamId/email, never off of row position or any other
 * row's spec, so the resulting per-row outcome is a faithful test of
 * content-determined (not order/neighbor-determined) behavior.
 */
describe('Property 14: CSV batch row processing is isolated', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const rowSpecKindArb = fc.constantFrom('valid', 'missingField', 'unauthorizedTeam', 'authentikFailure');

  // Each spec gets a unique `uid` (its index at generation time), used to
  // build a unique teamId/email per row so per-row mock behavior never
  // collides across rows, and to look up a row's outcome after shuffling
  // reorders it away from its original array position.
  const specsWithShuffleArb = fc
    .array(rowSpecKindArb, { minLength: 1, maxLength: 8 })
    .map((kinds) => kinds.map((kind, uid) => ({ kind, uid })))
    .chain((specs) =>
      fc
        .shuffledSubarray(specs, { minLength: specs.length, maxLength: specs.length })
        .map((shuffledSpecs) => ({ specs, shuffledSpecs }))
    );

  function teamIdForSpec(spec) {
    return 1000 + spec.uid;
  }

  function emailForSpec(spec) {
    return `row-${spec.uid}@example.com`;
  }

  function buildCsvRowForSpec(spec) {
    const teamId = String(teamIdForSpec(spec));
    const email = spec.kind === 'missingField' ? '' : emailForSpec(spec);
    return {
      email,
      firstName: `First${spec.uid}`,
      lastName: `Last${spec.uid}`,
      teamId,
      username: `user${spec.uid}`
    };
  }

  // Configures every mock's per-call behavior purely from THIS batch's
  // specs (keyed by each row's own unique teamId/email) -- never from
  // row position -- so the same spec produces the same mocked behavior
  // no matter where it lands in the batch.
  function configureMocksForBatch(specs) {
    const unauthorizedTeamIds = new Set(
      specs.filter((s) => s.kind === 'unauthorizedTeam').map(teamIdForSpec)
    );
    const authentikFailureEmails = new Set(
      specs.filter((s) => s.kind === 'authentikFailure').map(emailForSpec)
    );

    Team.isAdmin.mockImplementation((teamId) => Promise.resolve(!unauthorizedTeamIds.has(teamId)));
    authentikService.createUser.mockImplementation(({ email }) => {
      if (authentikFailureEmails.has(email)) {
        return Promise.reject(new Error(`Authentik creation failure for ${email}`));
      }
      return Promise.resolve({ pk: email });
    });
    UserProvisioningService.createAndAddUser.mockImplementation((client, params) =>
      Promise.resolve({ localUserId: params.teamId, queuedGroups: 1 })
    );
    pool.connect.mockImplementation(() => Promise.resolve(buildMockClient()));
  }

  function expectedSuccess(spec) {
    return spec.kind === 'valid';
  }

  // Runs `importUsers` on the given ordered specs and returns a Map from
  // each spec's unique `uid` to its outcome, keyed independently of the
  // row's position in this particular run's CSV.
  async function runBatchAndGetOutcomesByUid(specs) {
    configureMocksForBatch(specs);
    const csv = csvFromRows(specs.map(buildCsvRowForSpec));
    const importingUser = { userId: 1, is_global_manager: false };
    const summary = await BulkImportService.importUsers(csv, importingUser);

    const outcomesByUid = new Map();
    specs.forEach((spec, index) => {
      outcomesByUid.set(spec.uid, summary.results[index].success);
    });
    return outcomesByUid;
  }

  test.prop([specsWithShuffleArb], { numRuns: 100 })(
    "each row's success/failure outcome matches its own spec and is unaffected by neighboring rows' validity or ordering",
    async ({ specs, shuffledSpecs }) => {
      const originalOutcomes = await runBatchAndGetOutcomesByUid(specs);

      // --- Content-determined outcome: matches what THIS row's own
      // spec predicts, regardless of any other row's validity. ---
      for (const spec of specs) {
        expect(originalOutcomes.get(spec.uid)).toBe(expectedSuccess(spec));
      }

      // --- Order-independence: re-running the SAME multiset of row
      // specs in a shuffled order produces identical per-row outcomes,
      // looked up by each row's own uid rather than by position. ---
      const shuffledOutcomes = await runBatchAndGetOutcomesByUid(shuffledSpecs);
      for (const spec of specs) {
        expect(shuffledOutcomes.get(spec.uid)).toBe(originalOutcomes.get(spec.uid));
      }
    }
  );
});
