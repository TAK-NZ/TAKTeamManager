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
  connect: jest.fn(),
  query: jest.fn()
}));
jest.mock('../models/Team', () => ({
  isAdmin: jest.fn(),
  create: jest.fn()
}));
jest.mock('./authentik', () => ({
  createUser: jest.fn()
}));
jest.mock('./userAttributes', () => ({
  generateCallsign: jest.fn(),
  updateUserAttributes: jest.fn()
}));
jest.mock('./UserProvisioningService', () => {
  class CallsignSuffixRequiredError extends Error {
    constructor(message = "A callsign suffix is required for this Organisation's user_defined callsign format") {
      super(message);
      this.name = 'CallsignSuffixRequiredError';
    }
  }
  return {
    createAndAddUser: jest.fn(),
    // takserver-enrollment Requirements 6.3, 6.6, 6.8 (task 5.3):
    // replaces the removed `resolveCallsignSuffixForNewUser`.
    resolveNewUserIdentity: jest.fn(),
    CallsignSuffixRequiredError
  };
});
jest.mock('./ManagedIdentifierService', () => {
  class OrganisationPrefixMissingError extends Error {
    constructor(organisationId) {
      super(`Organisation ${organisationId} has no Organisation_Prefix. A Managed_Identifier cannot be minted for it, and none was.`);
      this.name = 'OrganisationPrefixMissingError';
      this.organisationId = organisationId;
    }
  }
  class ManagedIdentifierExhaustionError extends Error {
    constructor(organisationId, typeMarker, attempts) {
      super(`Exhausted ${attempts} Managed_Identifier mint attempt(s) for organisation ${organisationId} (type marker ${typeMarker}). No identifier could be claimed.`);
      this.name = 'ManagedIdentifierExhaustionError';
    }
  }
  return { OrganisationPrefixMissingError, ManagedIdentifierExhaustionError };
});

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const Team = require('../models/Team');
const authentikService = require('./authentik');
const UserAttributesService = require('./userAttributes');
const UserProvisioningService = require('./UserProvisioningService');
const BulkImportService = require('./BulkImportService');
const { buildImportGraph } = BulkImportService;

function buildMockClient() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn()
  };
}

function csvFromRows(rows) {
  const header = 'email,firstName,lastName,teamId';
  const lines = rows.map((r) => [r.email ?? '', r.firstName ?? '', r.lastName ?? '', r.teamId ?? ''].join(','));
  return [header, ...lines].join('\n');
}

describe('BulkImportService.importUsers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.connect.mockImplementation(() => Promise.resolve(buildMockClient()));
    pool.query.mockResolvedValue({ rows: [] });
    authentikService.createUser.mockResolvedValue({ pk: 1000 });
    // Post-commit Phase 3 (callsign compute + Authentik push + user_cache
    // mirror) -- mocked so the importUsers batch tests don't hit real
    // Authentik/DB; asserted directly in its own describe block below.
    UserAttributesService.generateCallsign.mockResolvedValue({ callsign: 'FENZ-CS', color: 'Red', role: 'Team Member' });
    UserAttributesService.updateUserAttributes.mockResolvedValue(true);
    UserProvisioningService.createAndAddUser.mockResolvedValue({ localUserId: 42, queuedGroups: 1 });
    UserProvisioningService.resolveNewUserIdentity.mockImplementation((client, { requestedUsername }) =>
      Promise.resolve({
        username: requestedUsername,
        callsignSuffix: null,
        pseudonymous: false,
        organisationId: 1,
        organisationPrefix: 'ORG',
        claimId: null
      })
    );
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
 * Unit tests for `BulkImportService.importTeams` (Requirements 9.6,
 * 9.7, 9.9, 9.10, 9.11; task 18.1's two-phase pipeline):
 *   - Global_Manager-only authorization for the WHOLE batch (rejected
 *     before any row is even read from the CSV, not per-row)
 *   - a row's parent resolved by `parentTeamName` (lookup by exact name)
 *   - a row's parent resolved by `parentTeamId` (used directly)
 *   - a root row with neither column (parent_team_id resolves to null)
 *   - one row fails (`parentTeamName` not found) while the rest continue
 *   - a multi-level `rowId`/`parentRowRef` chain creates every team in
 *     ONE call, in topological order, with each child's `Team.create`
 *     receiving the ACTUAL created parent id (not the string `rowId`)
 *   - a whole-file rejection (duplicate `rowId`, cycle) creates zero
 *     teams and returns `{rejected: true, ...}`
 *   - a dangling `parentRowRef` fails only its dependent subtree while
 *     unrelated rows still succeed
 *   - an error thrown from inside `Team.create` itself (e.g.
 *     `TeamDepthExceededError`) is caught and recorded as that row's
 *     OWN per-row failure, not a whole-batch failure
 */
function csvFromTeamRows(rows) {
  const header = 'rowId,parentRowRef,name,parentTeamName,parentTeamId,visibility,callsignPrefix,color,canJoin';
  const lines = rows.map((r) => [
    r.rowId ?? '',
    r.parentRowRef ?? '',
    r.name ?? '',
    r.parentTeamName ?? '',
    r.parentTeamId ?? '',
    r.visibility ?? '',
    r.callsignPrefix ?? '',
    // Bugfix (CSV bulk team import mandatory TAK Colour): every
    // pre-existing test in this describe block builds a ROOT
    // Organisation row (no parentTeamName/parentTeamId/parentRowRef),
    // for which `color` is now a required field -- defaulted here to a
    // valid `TAK_COLOR_NAMES` value so none of those pre-existing tests
    // need to individually opt in to a value they were never testing.
    // Tests specifically covering `color` itself (below) override this
    // default explicitly, including to `''` to test the missing-value
    // rejection.
    r.color ?? 'Red',
    // `canJoin` is an optional column (default false when blank). Left
    // blank unless a test opts in, so every pre-existing test keeps its
    // original meaning (a non-joinable team). Tests covering `canJoin`
    // itself (below) set it explicitly, including to an invalid value.
    r.canJoin ?? ''
  ].join(','));
  return [header, ...lines].join('\n');
}

describe('BulkImportService.importTeams', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('rejects the entire batch upfront when the importing user is not a Global_Manager', async () => {
    const csv = csvFromTeamRows([{ name: 'Southland District' }]);
    const importingUser = { userId: 7, is_global_manager: false };

    await expect(BulkImportService.importTeams(csv, importingUser)).rejects.toThrow(
      /Global_Manager/
    );

    // The batch is rejected before any row is even read from the CSV.
    expect(Team.create).not.toHaveBeenCalled();
  });

  it('imports rows resolving a parent by name, by id, and with no parent (root team)', async () => {
    const csv = csvFromTeamRows([
      { name: 'Southland District', parentTeamName: 'FENZ' },
      { name: 'Otago District', parentTeamId: '3' },
      { name: 'FENZ' }
    ]);

    pool.query.mockImplementation((sql, params) => {
      if (sql === 'SELECT id FROM teams WHERE name = $1' && params[0] === 'FENZ') {
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Creation order for these 3 independent (no in-file dependency)
    // rows follows Kahn's algorithm's queue order, which for all-in-
    // degree-0 nodes matches Map insertion order -- i.e. file order.
    Team.create.mockImplementation((teamData) => {
      const idsByName = { 'Southland District': 101, 'Otago District': 102, FENZ: 103 };
      return Promise.resolve({ id: idsByName[teamData.name], name: teamData.name, parent_team_id: teamData.parent_team_id });
    });

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.successCount).toBe(3);
    expect(summary.failureCount).toBe(0);
    expect(summary.rejected).toBeUndefined();
    expect(summary.results).toEqual([
      { row: 1, success: true, teamId: 101 },
      { row: 2, success: true, teamId: 102 },
      { row: 3, success: true, teamId: 103 }
    ]);

    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Southland District', parent_team_id: 1 }));
    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Otago District', parent_team_id: 3 }));
    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'FENZ', parent_team_id: null }));
  });

  it('continues processing remaining rows when a parentTeamName lookup fails to find a match', async () => {
    const csv = csvFromTeamRows([
      { name: 'Southland District', parentTeamName: 'FENZ' },
      { name: 'Orphan Team', parentTeamName: 'DoesNotExist' },
      { name: 'Otago District', parentTeamName: 'FENZ' }
    ]);

    pool.query.mockImplementation((sql, params) => {
      if (sql === 'SELECT id FROM teams WHERE name = $1' && params[0] === 'FENZ') {
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    Team.create.mockImplementation((teamData) => {
      const idsByName = { 'Southland District': 201, 'Otago District': 203 };
      return Promise.resolve({ id: idsByName[teamData.name], name: teamData.name, parent_team_id: teamData.parent_team_id });
    });

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

  it('imports a multi-level rowId/parentRowRef chain in one call, in topological order, passing each real created parent id', async () => {
    // Deliberately out of dependency order in the file: Station 40
    // (deepest) appears first, Organisation (root) appears last.
    const csv = csvFromTeamRows([
      { rowId: 'station1', parentRowRef: 'district1', name: 'Station 40' },
      { rowId: 'district1', parentRowRef: 'region1', name: 'Canterbury' },
      { rowId: 'region1', parentRowRef: 'org1', name: 'Te Ihu' },
      { rowId: 'org1', name: 'FENZ' }
    ]);

    const idsByName = { FENZ: 1, 'Te Ihu': 2, Canterbury: 3, 'Station 40': 4 };
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: idsByName[teamData.name], name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.successCount).toBe(4);
    expect(summary.failureCount).toBe(0);
    // Results are in ORIGINAL file order, not creation order.
    expect(summary.results).toEqual([
      { row: 1, success: true, teamId: 4 },
      { row: 2, success: true, teamId: 3 },
      { row: 3, success: true, teamId: 2 },
      { row: 4, success: true, teamId: 1 }
    ]);

    // Team.create was called in TOPOLOGICAL (parent-before-child) order,
    // regardless of file order, and each child received the ACTUAL
    // created parent id (an integer), never the string rowId.
    const callOrder = Team.create.mock.calls.map(([teamData]) => teamData.name);
    expect(callOrder.indexOf('FENZ')).toBeLessThan(callOrder.indexOf('Te Ihu'));
    expect(callOrder.indexOf('Te Ihu')).toBeLessThan(callOrder.indexOf('Canterbury'));
    expect(callOrder.indexOf('Canterbury')).toBeLessThan(callOrder.indexOf('Station 40'));

    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'FENZ', parent_team_id: null }));
    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Te Ihu', parent_team_id: 1 }));
    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Canterbury', parent_team_id: 2 }));
    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Station 40', parent_team_id: 3 }));
  });

  it('rejects the whole file and creates zero teams when a rowId is duplicated', async () => {
    const csv = csvFromTeamRows([
      { rowId: 'org1', name: 'FENZ A' },
      { rowId: 'org1', name: 'FENZ B' }
    ]);

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.rejected).toBe(true);
    expect(summary.successCount).toBe(0);
    expect(summary.failureCount).toBe(2);
    expect(summary.results).toEqual([
      { error: 'Duplicate rowId: org1', rowIds: ['org1'] }
    ]);
    expect(Team.create).not.toHaveBeenCalled();
  });

  it('rejects the whole file and creates zero teams when a parentRowRef cycle exists', async () => {
    const csv = csvFromTeamRows([
      { rowId: 'a', parentRowRef: 'b', name: 'Team A' },
      { rowId: 'b', parentRowRef: 'a', name: 'Team B' }
    ]);

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.rejected).toBe(true);
    expect(summary.successCount).toBe(0);
    expect(summary.failureCount).toBe(2);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].error).toMatch(/Cycle detected/);
    expect(Team.create).not.toHaveBeenCalled();
  });

  it('fails only a dangling parentRowRef row and its dependents, while unrelated rows still succeed', async () => {
    const csv = csvFromTeamRows([
      { rowId: 'org1', name: 'FENZ' },
      { rowId: 'orphan', parentRowRef: 'missing-ref', name: 'Orphan' },
      { rowId: 'orphanChild', parentRowRef: 'orphan', name: 'Orphan Child' }
    ]);

    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 1, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.rejected).toBeUndefined();
    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(2);
    expect(summary.results[0]).toEqual({ row: 1, success: true, teamId: 1 });
    expect(summary.results[1].success).toBe(false);
    expect(summary.results[1].error).toMatch(/missing-ref/);
    expect(summary.results[2].success).toBe(false);
    expect(summary.results[2].error).toMatch(/parent row failed/);

    // Neither the dangling row nor its dependent ever reached Team.create.
    expect(Team.create).toHaveBeenCalledTimes(1);
  });

  it('records an error thrown from inside Team.create itself as that row\'s own per-row failure, continuing the batch', async () => {
    const csv = csvFromTeamRows([
      { name: 'Deep Team' },
      { name: 'Fine Team' }
    ]);

    class TeamDepthExceededError extends Error {
      constructor() {
        super('Maximum team depth (5) exceeded');
        this.name = 'TeamDepthExceededError';
      }
    }

    Team.create.mockImplementation((teamData) => {
      if (teamData.name === 'Deep Team') {
        return Promise.reject(new TeamDepthExceededError());
      }
      return Promise.resolve({ id: 55, name: teamData.name, parent_team_id: null });
    });

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.rejected).toBeUndefined();
    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[0]).toEqual({
      row: 1,
      success: false,
      error: 'Maximum team depth (5) exceeded'
    });
    expect(summary.results[1]).toEqual({ row: 2, success: true, teamId: 55 });
    expect(Team.create).toHaveBeenCalledTimes(2);
  });

  /**
   * Unit tests for the `visibility`/`callsignPrefix` Team_Import_Row
   * columns (Requirements 9.7, 9.8; task 18.2).
   */
  it('creates a Team with visibility: public when the row explicitly sets it', async () => {
    const csv = csvFromTeamRows([{ name: 'Explicit Public Org', visibility: 'public' }]);
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 1, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'public' }));
  });

  it('creates a Team with visibility: public (the new default) when the row omits visibility', async () => {
    const csv = csvFromTeamRows([{ name: 'Default Visibility Org' }]);
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 1, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'public' }));
  });

  it('fails only the row with an invalid visibility value, continuing the batch', async () => {
    const csv = csvFromTeamRows([
      { name: 'Weird Org', visibility: 'weird' },
      { name: 'Fine Org' }
    ]);
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 9, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.rejected).toBeUndefined();
    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[0]).toEqual({
      row: 1,
      success: false,
      error: 'Invalid visibility: weird'
    });
    expect(summary.results[1]).toEqual({ row: 2, success: true, teamId: 9 });
    // The invalid row never reached Team.create.
    expect(Team.create).toHaveBeenCalledTimes(1);
  });

  it('creates a Team with the row\'s valid callsignPrefix', async () => {
    const csv = csvFromTeamRows([{ name: 'FENZ', callsignPrefix: 'FENZ' }]);
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 1, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ callsign_prefix: 'FENZ' }));
  });

  it('creates a Team with callsign_prefix: null when the row omits callsignPrefix', async () => {
    const csv = csvFromTeamRows([{ name: 'No Prefix Org' }]);
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 1, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ callsign_prefix: null }));
  });

  // Foreign-partner-prefix extension: a bare hyphenated prefix like
  // 'NZ-POL' is now VALID (server/utils/callsignValidation.js), so this
  // row-level rejection test uses a shape the extension still rejects: a
  // segment matching the Managed_Identifier marker+body shape.
  it('fails only the row with an invalid callsignPrefix (a marker+body-shaped segment), without ever calling Team.create for that row', async () => {
    const csv = csvFromTeamRows([
      { name: 'NZ Police', callsignPrefix: 'NZ-D2345678' },
      { name: 'Fine Org' }
    ]);
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 9, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.rejected).toBeUndefined();
    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[0]).toEqual({
      row: 1,
      success: false,
      error:
        'Invalid callsignPrefix: NZ-D2345678 (letters and digits only, optionally split into segments with a single hyphen, e.g. AUS-FIRE)'
    });
    expect(summary.results[1]).toEqual({ row: 2, success: true, teamId: 9 });
    // The invalid row never reached Team.create.
    expect(Team.create).toHaveBeenCalledTimes(1);
  });

  // Foreign-partner-prefix extension: a well-formed hyphenated prefix is
  // now accepted end-to-end through the bulk-import row parser.
  it('accepts a well-formed multi-segment callsignPrefix (e.g. "AUS-FIRE")', async () => {
    const csv = csvFromTeamRows([{ name: 'Australia Fire', callsignPrefix: 'AUS-FIRE' }]);
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 10, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(0);
    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ callsign_prefix: 'AUS-FIRE' }));
  });

  /**
   * Bugfix (CSV bulk team import mandatory TAK Colour): a new
   * Organisation row (no parentTeamName/parentTeamId/parentRowRef) is
   * created with `parent_team_id: null`, so `color` is required and
   * validated against the fixed 14-name `TAK_COLOR_NAMES` set --
   * closing the bug where `createRowsInOrder` used to hardcode `color:
   * '#3B82F6'` for every row regardless of what (if anything) the CSV
   * supplied, meaning no CSV import ever set a real TAK Colour.
   */
  it('creates a new Organisation row with the row\'s valid color', async () => {
    const csv = csvFromTeamRows([{ name: 'FENZ', callsignPrefix: 'FENZ', color: 'Dark Blue' }]);
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 1, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(0);
    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ color: 'Dark Blue' }));
  });

  it('fails only the row with a missing color when creating a new Organisation, continuing the batch', async () => {
    const csv = csvFromTeamRows([
      { name: 'No Color Org', color: '' },
      { name: 'Fine Org' }
    ]);
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 9, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.rejected).toBeUndefined();
    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[0].success).toBe(false);
    expect(summary.results[0].error).toMatch(/Missing required field: color/);
    expect(summary.results[1]).toEqual({ row: 2, success: true, teamId: 9 });
    // The invalid row never reached Team.create.
    expect(Team.create).toHaveBeenCalledTimes(1);
  });

  it('fails only the row with a color that is not one of the 14 canonical TAK Colour names', async () => {
    const csv = csvFromTeamRows([
      { name: 'Hex Org', color: '#3B82F6' },
      { name: 'Fine Org' }
    ]);
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 9, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[0].success).toBe(false);
    expect(summary.results[0].error).toMatch(/Invalid color: #3B82F6/);
    expect(Team.create).toHaveBeenCalledTimes(1);
  });

  it('passes a Sub_Team row\'s color straight through unvalidated, since Team.create ignores it', async () => {
    // A Sub_Team's color is silently overridden by Team.create with its
    // Organisation's current value regardless of what is supplied, so
    // this deliberately supplies a non-canonical value to prove it is
    // never rejected at the CSV layer for a non-root row.
    const csv = csvFromTeamRows([
      { name: 'Southland District', parentTeamName: 'FENZ', color: 'not-a-real-color' }
    ]);
    pool.query.mockImplementation((sql, params) => {
      if (sql === 'SELECT id FROM teams WHERE name = $1' && params[0] === 'FENZ') {
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 101, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(0);
    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ color: 'not-a-real-color' }));
  });

  /**
   * Unit tests for the `canJoin` Team_Import_Row column -- whether the
   * team/org is flagged Joinable. Optional, default false, accepts only
   * the literal booleans `true`/`false` (case-insensitively); any other
   * value fails that row alone. Mirrors the `visibility` column's own
   * validate-then-throw, per-row-failure behaviour above.
   */
  it('creates a Team with can_join: false (the default) when the row omits canJoin', async () => {
    const csv = csvFromTeamRows([{ name: 'Default CanJoin Org' }]);
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 1, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ can_join: false }));
  });

  it('creates a Team with can_join: true when the row sets canJoin to true (case-insensitively)', async () => {
    const csv = csvFromTeamRows([{ name: 'Joinable Org', canJoin: 'TRUE' }]);
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 1, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ can_join: true }));
  });

  it('creates a Team with can_join: false when the row explicitly sets canJoin to false', async () => {
    const csv = csvFromTeamRows([{ name: 'Explicit Not Joinable Org', canJoin: 'false' }]);
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 1, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ can_join: false }));
  });

  it('fails only the row with an invalid canJoin value, continuing the batch', async () => {
    const csv = csvFromTeamRows([
      { name: 'Weird Join Org', canJoin: 'yes' },
      { name: 'Fine Org' }
    ]);
    Team.create.mockImplementation((teamData) =>
      Promise.resolve({ id: 9, name: teamData.name, parent_team_id: teamData.parent_team_id })
    );

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.rejected).toBeUndefined();
    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[0]).toEqual({
      row: 1,
      success: false,
      error: 'Invalid canJoin: yes (must be true or false)'
    });
    expect(summary.results[1]).toEqual({ row: 2, success: true, teamId: 9 });
    // The invalid row never reached Team.create.
    expect(Team.create).toHaveBeenCalledTimes(1);
  });

  /**
   * Bugfix (parentRowRef transitive-creation-failure): a row whose
   * parentRowRef points at a row that fails at `Team.create` TIME
   * (not a file-level dangling reference or cycle -- both already
   * covered above) must fail too, rather than being silently created
   * as a brand new root Organisation. Reproduced directly against a
   * live database before this fix: `resolveNodeParentTeamId` used to
   * return `undefined` for such a child, which `Team.create` reads as
   * `parent_team_id: null`.
   */
  it('fails a child row whose parentRowRef points at a row that failed Team.create (e.g. a callsignPrefix conflict), instead of creating it as a new root Organisation', async () => {
    const csv = csvFromTeamRows([
      { rowId: 'org1', name: 'Colliding Org', callsignPrefix: 'FENZ' },
      { rowId: 'org2', name: 'Independent Org', callsignPrefix: 'IND1' },
      { rowId: 'child1', parentRowRef: 'org1', name: 'Child Of Failed Org' }
    ]);

    class CallsignPrefixConflictError extends Error {
      constructor(conflictingValue) {
        super(`Callsign Prefix "${conflictingValue}" is already in use by another team`);
        this.name = 'CallsignPrefixConflictError';
      }
    }

    Team.create.mockImplementation((teamData) => {
      if (teamData.name === 'Colliding Org') {
        return Promise.reject(new CallsignPrefixConflictError('FENZ'));
      }
      return Promise.resolve({ id: 42, name: teamData.name, parent_team_id: teamData.parent_team_id });
    });

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.rejected).toBeUndefined();
    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(2);

    expect(summary.results[0]).toEqual({
      row: 1,
      success: false,
      error: 'Callsign Prefix "FENZ" is already in use by another team'
    });
    expect(summary.results[1]).toEqual({ row: 2, success: true, teamId: 42 });
    expect(summary.results[2].success).toBe(false);
    expect(summary.results[2].error).toMatch(/Parent row failed to create: org1/);

    // Team.create was called exactly twice: once for the colliding org
    // (which threw) and once for the independent org. The child row
    // must NEVER reach Team.create at all -- confirming it was not
    // silently created as a new root Organisation.
    expect(Team.create).toHaveBeenCalledTimes(2);
    expect(Team.create).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'Child Of Failed Org' }));
  });

  // Org-wide-team-name-uniqueness: two rows with the SAME name under
  // DIFFERENT parents in the SAME org. `Team.create` (real model)
  // enforces org-wide name uniqueness and throws TeamNameConflictError
  // for the second one; here `Team.create` is mocked, so this asserts
  // the SERVICE surfaces that thrown error as the second row's OWN
  // per-row failure (never a whole-batch rejection), the same per-row
  // isolation the callsign-conflict case above relies on.
  it('records a TeamNameConflictError from Team.create as that row\'s own per-row failure, continuing the batch', async () => {
    const csv = csvFromTeamRows([
      { rowId: 'org1', name: 'LandSAR', callsignPrefix: 'LSAR' },
      { rowId: 'regionA', parentRowRef: 'org1', name: 'Region A', callsignPrefix: 'RA' },
      { rowId: 'regionB', parentRowRef: 'org1', name: 'Region B', callsignPrefix: 'RB' },
      // Two "Auckland" sub-teams under different parents (Region A and
      // Region B) but the SAME org -- the second must fail org-wide.
      { rowId: 'aucklandA', parentRowRef: 'regionA', name: 'Auckland' },
      { rowId: 'aucklandB', parentRowRef: 'regionB', name: 'Auckland' }
    ]);

    class TeamNameConflictError extends Error {
      constructor(conflictingName) {
        super(`A team named "${conflictingName}" already exists in this Organisation`);
        this.name = 'TeamNameConflictError';
      }
    }

    let seenAuckland = false;
    let nextId = 100;
    Team.create.mockImplementation((teamData) => {
      if (teamData.name === 'Auckland') {
        if (seenAuckland) {
          // The real model would throw this once the first 'Auckland'
          // exists in the org subtree.
          return Promise.reject(new TeamNameConflictError('Auckland'));
        }
        seenAuckland = true;
      }
      return Promise.resolve({ id: nextId++, name: teamData.name, parent_team_id: teamData.parent_team_id });
    });

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importTeams(csv, importingUser);

    expect(summary.rejected).toBeUndefined();
    // org1, regionA, regionB, and ONE Auckland succeed; the second
    // Auckland fails on its own, without affecting the rest.
    expect(summary.successCount).toBe(4);
    expect(summary.failureCount).toBe(1);

    const failed = summary.results.filter((r) => !r.success);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe('A team named "Auckland" already exists in this Organisation');
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
      teamId
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
    UserProvisioningService.resolveNewUserIdentity.mockImplementation((client, { requestedUsername }) =>
      Promise.resolve({
        username: requestedUsername,
        callsignSuffix: null,
        pseudonymous: false,
        organisationId: 1,
        organisationPrefix: 'ORG',
        claimId: null
      })
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

/**
 * Unit tests for `BulkImportService.buildImportGraph` (Requirements 9.1,
 * 9.2, 9.3, 9.5; task 17.1). This is PURE logic -- no mocks needed --
 * covering node keying (synthetic `__row_N` keys vs. explicit `rowId`),
 * whole-file rejection for a duplicate `rowId` and for a
 * `parentRowRef`+`parentTeamName`/`parentTeamId` combo on one row, and
 * edge resolution for each of `parentRowRef`-only,
 * `parentTeamName`/`parentTeamId`-only, and neither.
 */
describe('BulkImportService.buildImportGraph', () => {
  it('assigns synthetic __row_N keys to rows with no rowId at all', () => {
    const rows = [
      { name: 'Org A' },
      { name: 'Org B' }
    ];

    const graph = buildImportGraph(rows);

    expect(Array.from(graph.nodes.keys())).toEqual(['__row_1', '__row_2']);
    expect(graph.wholeFileErrors).toEqual([]);
    // Both rows are independent roots (no parentRowRef) -- task 17.3's
    // Kahn's-algorithm pass includes both in creationOrder.
    expect(graph.creationOrder.slice().sort()).toEqual(['__row_1', '__row_2']);
  });

  it('keys rows with unique rowId values by those values', () => {
    const rows = [
      { rowId: 'org1', name: 'FENZ' },
      { rowId: 'region1', name: 'Te Ihu' }
    ];

    const graph = buildImportGraph(rows);

    expect(Array.from(graph.nodes.keys())).toEqual(['org1', 'region1']);
    expect(graph.wholeFileErrors).toEqual([]);
  });

  it('rejects the whole file with an error naming the value when a rowId is duplicated', () => {
    const rows = [
      { rowId: 'org1', name: 'FENZ' },
      { rowId: 'org1', name: 'Duplicate FENZ' }
    ];

    const graph = buildImportGraph(rows);

    expect(graph.wholeFileErrors).toEqual([
      { error: 'Duplicate rowId: org1', rowIds: ['org1'] }
    ]);
  });

  it('reports each distinct duplicated rowId value as its own wholeFileErrors entry', () => {
    const rows = [
      { rowId: 'org1', name: 'FENZ A' },
      { rowId: 'org1', name: 'FENZ B' },
      { rowId: 'region1', name: 'Region A' },
      { rowId: 'region1', name: 'Region B' },
      { rowId: 'region1', name: 'Region C' },
      { rowId: 'unique1', name: 'Standalone' }
    ];

    const graph = buildImportGraph(rows);

    expect(graph.wholeFileErrors).toHaveLength(2);
    expect(graph.wholeFileErrors).toContainEqual({ error: 'Duplicate rowId: org1', rowIds: ['org1'] });
    expect(graph.wholeFileErrors).toContainEqual({ error: 'Duplicate rowId: region1', rowIds: ['region1'] });
  });

  it('rejects the whole file when a row supplies both parentRowRef and parentTeamName', () => {
    const rows = [
      { rowId: 'org1', name: 'FENZ' },
      { rowId: 'region1', name: 'Te Ihu', parentRowRef: 'org1', parentTeamName: 'Some Existing Team' }
    ];

    const graph = buildImportGraph(rows);

    expect(graph.wholeFileErrors).toContainEqual({
      error: 'Row region1 supplies both parentRowRef and parentTeamName/parentTeamId; only one parent-reference method may be used per row',
      rowIds: ['region1']
    });
  });

  it('rejects the whole file when a row supplies both parentRowRef and parentTeamId', () => {
    const rows = [
      { rowId: 'org1', name: 'FENZ' },
      { rowId: 'region1', name: 'Te Ihu', parentRowRef: 'org1', parentTeamId: '42' }
    ];

    const graph = buildImportGraph(rows);

    expect(graph.wholeFileErrors).toContainEqual({
      error: 'Row region1 supplies both parentRowRef and parentTeamName/parentTeamId; only one parent-reference method may be used per row',
      rowIds: ['region1']
    });
  });

  it('resolves a row with only parentRowRef to resolvedParentKey, not resolvedParentTeamId', () => {
    const rows = [
      { rowId: 'org1', name: 'FENZ' },
      { rowId: 'region1', name: 'Te Ihu', parentRowRef: 'org1' }
    ];

    const graph = buildImportGraph(rows);

    const regionNode = graph.nodes.get('region1');
    expect(regionNode.resolvedParentKey).toBe('org1');
    expect(regionNode.parentTeamNameRef).toBeUndefined();
    expect(regionNode.parentTeamIdRef).toBeUndefined();
    expect(regionNode.resolvedParentTeamId).toBeUndefined();
  });

  it('resolves a row with only parentTeamName to the raw-ref field, not resolvedParentKey', () => {
    const rows = [
      { name: 'Southland District', parentTeamName: 'FENZ' }
    ];

    const graph = buildImportGraph(rows);

    const node = graph.nodes.get('__row_1');
    expect(node.parentTeamNameRef).toBe('FENZ');
    expect(node.resolvedParentKey).toBeUndefined();
    expect(node.parentTeamIdRef).toBeUndefined();
  });

  it('resolves a row with only parentTeamId to the raw-ref field, not resolvedParentKey', () => {
    const rows = [
      { name: 'Otago District', parentTeamId: '7' }
    ];

    const graph = buildImportGraph(rows);

    const node = graph.nodes.get('__row_1');
    expect(node.parentTeamIdRef).toBe('7');
    expect(node.resolvedParentKey).toBeUndefined();
    expect(node.parentTeamNameRef).toBeUndefined();
  });

  it('treats a row with none of rowId/parentRowRef/parentTeamName/parentTeamId as a valid root node', () => {
    const rows = [
      { name: 'FENZ' }
    ];

    const graph = buildImportGraph(rows);

    expect(graph.wholeFileErrors).toEqual([]);
    const node = graph.nodes.get('__row_1');
    expect(node.resolvedParentKey).toBeUndefined();
    expect(node.parentTeamNameRef).toBeUndefined();
    expect(node.parentTeamIdRef).toBeUndefined();
    expect(node.teamId).toBeUndefined();
    expect(node.status).toBeUndefined();
  });
});

/**
 * Unit tests for cycle detection over `parentRowRef` edges (Requirement
 * 9.13; task 17.2), added to `buildImportGraph`'s existing whole-file
 * validation pass. Covers a simple 2-node cycle, a longer 3-node cycle,
 * a self-referencing (degenerate 1-node) cycle, a no-cycle regression
 * case, a dangling `parentRowRef` (not this task's concern), multiple
 * independent cycles reported exactly once each, and cycle detection
 * coexisting with a duplicate-rowId whole-file error.
 */
describe('BulkImportService.buildImportGraph cycle detection', () => {
  it('detects a simple 2-node cycle (A references B, B references A)', () => {
    const rows = [
      { rowId: 'a', name: 'Team A', parentRowRef: 'b' },
      { rowId: 'b', name: 'Team B', parentRowRef: 'a' }
    ];

    const graph = buildImportGraph(rows);

    const cycleErrors = graph.wholeFileErrors.filter((e) => e.error.startsWith('Cycle detected'));
    expect(cycleErrors).toHaveLength(1);
    expect(cycleErrors[0].rowIds.slice().sort()).toEqual(['a', 'b']);
  });

  it('detects a longer cycle (A -> B -> C -> A)', () => {
    const rows = [
      { rowId: 'a', name: 'Team A', parentRowRef: 'b' },
      { rowId: 'b', name: 'Team B', parentRowRef: 'c' },
      { rowId: 'c', name: 'Team C', parentRowRef: 'a' }
    ];

    const graph = buildImportGraph(rows);

    const cycleErrors = graph.wholeFileErrors.filter((e) => e.error.startsWith('Cycle detected'));
    expect(cycleErrors).toHaveLength(1);
    expect(cycleErrors[0].rowIds.slice().sort()).toEqual(['a', 'b', 'c']);
  });

  it('detects a self-referencing row as a degenerate 1-node cycle', () => {
    const rows = [
      { rowId: 'a', name: 'Team A', parentRowRef: 'a' }
    ];

    const graph = buildImportGraph(rows);

    const cycleErrors = graph.wholeFileErrors.filter((e) => e.error.startsWith('Cycle detected'));
    expect(cycleErrors).toHaveLength(1);
    expect(cycleErrors[0].rowIds).toEqual(['a']);
  });

  it('reports no cycle-related error for a file with no cycle', () => {
    const rows = [
      { rowId: 'org1', name: 'FENZ' },
      { rowId: 'region1', name: 'Te Ihu', parentRowRef: 'org1' },
      { rowId: 'district1', name: 'Canterbury', parentRowRef: 'region1' }
    ];

    const graph = buildImportGraph(rows);

    expect(graph.wholeFileErrors.filter((e) => e.error.startsWith('Cycle detected'))).toEqual([]);
  });

  it('does not report a cycle for a parentRowRef pointing at a nonexistent rowId (dangling, not a cycle)', () => {
    const rows = [
      { rowId: 'a', name: 'Team A', parentRowRef: 'does-not-exist' }
    ];

    const graph = buildImportGraph(rows);

    expect(graph.wholeFileErrors.filter((e) => e.error.startsWith('Cycle detected'))).toEqual([]);
  });

  it('reports each of multiple independent cycles exactly once with the correct member rows', () => {
    const rows = [
      { rowId: 'a', name: 'Team A', parentRowRef: 'b' },
      { rowId: 'b', name: 'Team B', parentRowRef: 'a' },
      { rowId: 'x', name: 'Team X', parentRowRef: 'y' },
      { rowId: 'y', name: 'Team Y', parentRowRef: 'z' },
      { rowId: 'z', name: 'Team Z', parentRowRef: 'x' },
      { rowId: 'standalone', name: 'Standalone Org' }
    ];

    const graph = buildImportGraph(rows);

    const cycleErrors = graph.wholeFileErrors.filter((e) => e.error.startsWith('Cycle detected'));
    expect(cycleErrors).toHaveLength(2);

    const memberSets = cycleErrors.map((e) => e.rowIds.slice().sort());
    expect(memberSets).toContainEqual(['a', 'b']);
    expect(memberSets).toContainEqual(['x', 'y', 'z']);

    // No cross-contamination between the two cycles, and the standalone
    // row is not attributed to either.
    const abCycle = cycleErrors.find((e) => e.rowIds.includes('a'));
    expect(abCycle.rowIds).not.toEqual(expect.arrayContaining(['x', 'y', 'z']));
    const xyzCycle = cycleErrors.find((e) => e.rowIds.includes('x'));
    expect(xyzCycle.rowIds).not.toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('reports a cycle alongside a duplicate-rowId whole-file error in the same result', () => {
    const rows = [
      { rowId: 'dup', name: 'First Dup' },
      { rowId: 'dup', name: 'Second Dup' },
      { rowId: 'a', name: 'Team A', parentRowRef: 'b' },
      { rowId: 'b', name: 'Team B', parentRowRef: 'a' }
    ];

    const graph = buildImportGraph(rows);

    const duplicateErrors = graph.wholeFileErrors.filter((e) => e.error.startsWith('Duplicate rowId'));
    const cycleErrors = graph.wholeFileErrors.filter((e) => e.error.startsWith('Cycle detected'));

    expect(duplicateErrors).toEqual([{ error: 'Duplicate rowId: dup', rowIds: ['dup'] }]);
    expect(cycleErrors).toHaveLength(1);
    expect(cycleErrors[0].rowIds.slice().sort()).toEqual(['a', 'b']);
  });
});

/**
 * Unit tests for dangling-`parentRowRef` row failure, transitive
 * failure propagation, and Kahn's-algorithm topological ordering
 * (Requirements 9.4, 9.6, 9.12; task 17.3), added to `buildImportGraph`.
 */
describe('BulkImportService.buildImportGraph dangling-reference failure and creationOrder', () => {
  it('marks a row with a dangling parentRowRef as failed with an error, without a whole-file rejection', () => {
    const rows = [
      { rowId: 'a', name: 'Team A', parentRowRef: 'does-not-exist' }
    ];

    const graph = buildImportGraph(rows);

    expect(graph.wholeFileErrors).toEqual([]);
    const node = graph.nodes.get('a');
    expect(node.status).toBe('failed');
    expect(node.error).toMatch(/does-not-exist/);
    expect(graph.creationOrder).not.toContain('a');
  });

  it('propagates failure transitively through an arbitrarily long chain (A -> B -> C, C dangling)', () => {
    const rows = [
      { rowId: 'a', name: 'Team A', parentRowRef: 'b' },
      { rowId: 'b', name: 'Team B', parentRowRef: 'c' },
      { rowId: 'c', name: 'Team C', parentRowRef: 'does-not-exist' }
    ];

    const graph = buildImportGraph(rows);

    expect(graph.wholeFileErrors).toEqual([]);
    expect(graph.nodes.get('a').status).toBe('failed');
    expect(graph.nodes.get('b').status).toBe('failed');
    expect(graph.nodes.get('c').status).toBe('failed');
    expect(graph.creationOrder).toEqual([]);
  });

  it('never includes a failed node in creationOrder', () => {
    const rows = [
      { rowId: 'org1', name: 'FENZ' },
      { rowId: 'region1', name: 'Te Ihu', parentRowRef: 'org1' },
      { rowId: 'orphan', name: 'Orphan', parentRowRef: 'missing' },
      { rowId: 'orphanChild', name: 'Orphan Child', parentRowRef: 'orphan' }
    ];

    const graph = buildImportGraph(rows);

    expect(graph.nodes.get('org1').status).toBeUndefined();
    expect(graph.nodes.get('region1').status).toBeUndefined();
    expect(graph.nodes.get('orphan').status).toBe('failed');
    expect(graph.nodes.get('orphanChild').status).toBe('failed');

    expect(graph.creationOrder.sort()).toEqual(['org1', 'region1'].sort());
    expect(graph.creationOrder).not.toContain('orphan');
    expect(graph.creationOrder).not.toContain('orphanChild');
  });

  it('orders parentTeamName/parentTeamId-rooted rows before any parentRowRef row that depends on them', () => {
    const rows = [
      { rowId: 'district1', name: 'Canterbury', parentRowRef: 'region1' },
      { rowId: 'region1', name: 'Te Ihu', parentTeamName: 'FENZ' },
      { rowId: 'station1', name: 'Station 40', parentRowRef: 'district1' }
    ];

    const graph = buildImportGraph(rows);

    expect(graph.wholeFileErrors).toEqual([]);
    expect(graph.creationOrder).toHaveLength(3);

    const indexOf = (key) => graph.creationOrder.indexOf(key);
    // region1 has no in-file dependency (parentTeamName only) -> sorts first.
    expect(indexOf('region1')).toBeLessThan(indexOf('district1'));
    expect(indexOf('district1')).toBeLessThan(indexOf('station1'));
  });

  it('excludes a cyclic row from creationOrder and marks it failed, without an infinite loop', () => {
    const rows = [
      { rowId: 'a', name: 'Team A', parentRowRef: 'b' },
      { rowId: 'b', name: 'Team B', parentRowRef: 'a' },
      { rowId: 'independent', name: 'Independent Org' }
    ];

    const graph = buildImportGraph(rows);

    const cycleErrors = graph.wholeFileErrors.filter((e) => e.error.startsWith('Cycle detected'));
    expect(cycleErrors).toHaveLength(1);

    expect(graph.nodes.get('a').status).toBe('failed');
    expect(graph.nodes.get('b').status).toBe('failed');
    expect(graph.nodes.get('independent').status).toBeUndefined();

    expect(graph.creationOrder).toEqual(['independent']);
  });

  it('produces the same set of failed rowKeys and the same relative ordering constraints regardless of row order', () => {
    const baseRows = [
      { rowId: 'org1', name: 'FENZ', parentTeamName: 'ExistingRoot' },
      { rowId: 'region1', name: 'Te Ihu', parentRowRef: 'org1' },
      { rowId: 'district1', name: 'Canterbury', parentRowRef: 'region1' },
      { rowId: 'station1', name: 'Station 40', parentRowRef: 'district1' },
      { rowId: 'orphan', name: 'Orphan', parentRowRef: 'missing-ref' },
      { rowId: 'orphanChild', name: 'Orphan Child', parentRowRef: 'orphan' },
      { rowId: 'standalone', name: 'Standalone Org' }
    ];

    // A handful of shuffled permutations of the same row set.
    const permutations = [
      baseRows,
      [...baseRows].reverse(),
      [baseRows[3], baseRows[0], baseRows[5], baseRows[1], baseRows[6], baseRows[2], baseRows[4]],
      [baseRows[6], baseRows[5], baseRows[4], baseRows[3], baseRows[2], baseRows[1], baseRows[0]]
    ];

    const results = permutations.map((rows) => buildImportGraph(rows));

    // Every permutation must produce the identical SET of failed rowKeys.
    const failedSets = results.map((graph) => {
      const failed = [];
      for (const [key, node] of graph.nodes.entries()) {
        if (node.status === 'failed') {
          failed.push(key);
        }
      }
      return failed.sort();
    });
    for (const failedSet of failedSets) {
      expect(failedSet).toEqual(['orphan', 'orphanChild']);
    }

    // Every permutation's creationOrder must satisfy the same relative
    // ordering constraints: for every live parentRowRef edge, the
    // parent's index precedes the child's index.
    const expectedEdges = [
      ['org1', 'region1'],
      ['region1', 'district1'],
      ['district1', 'station1']
    ];
    for (const graph of results) {
      for (const [parentKey, childKey] of expectedEdges) {
        expect(graph.creationOrder.indexOf(parentKey)).toBeLessThan(graph.creationOrder.indexOf(childKey));
      }
      expect(graph.creationOrder.sort()).toEqual(
        ['org1', 'region1', 'district1', 'station1', 'standalone'].sort()
      );
    }
  });
});

/**
 * Property-based test (design.md's Property 14: "Parent-resolution
 * failure isolates exactly its dependent subtree") for
 * `buildImportGraph`'s dangling-`parentRowRef` failure propagation
 * (Requirements 9.4, 9.12; task 17.5).
 *
 * NOTE on naming collision: this file already contains an unrelated
 * `describe('Property 14: CSV batch row processing is isolated', ...)`
 * block (above) covering `importUsers`'s per-row CSV-batch isolation
 * for USER import -- a different design.md property, from a different
 * feature (production-hardening), that happens to also be numbered
 * "14" in ITS OWN design doc. THIS block is org-team-hierarchy's
 * design.md Property 14, about `buildImportGraph`'s TEAM-import
 * dependency-graph dangling-reference propagation -- a completely
 * different concern. The describe name below is deliberately written
 * as "Property 14 (design.md): ..." to avoid being confused with the
 * pre-existing block.
 *
 * This is PURE logic -- no mocks needed -- matching the surrounding
 * `describe('BulkImportService.buildImportGraph', ...)` and
 * `describe('BulkImportService.buildImportGraph dangling-reference
 * failure and creationOrder', ...)` blocks' conventions.
 *
 * Generator: a forest of rows built from a fixed pool of candidate
 * `rowId` values (1-10). Each row's `parentRowRef` is one of:
 *   - empty (a root row), or
 *   - a reference to an EARLIER-generated row's `rowId` in the same
 *     tree (mirroring task 3.2's/15.2's earlier-id-only parent
 *     generators, guaranteeing this edge alone can never create a
 *     cycle), or
 *   - a reference to a `rowId` value guaranteed to not exist anywhere
 *     in the generated row set (a deliberately dangling edge, drawn
 *     from a disjoint "poison" pool).
 * At least one row is forced to carry a dangling reference so the
 * generator's space always includes a broken edge, rather than relying
 * on chance.
 *
 * Feature: org-team-hierarchy, task 17.5
 * Validates: Requirements 9.4, 9.12
 */
describe('Property 14 (design.md): Parent-resolution failure isolates exactly its dependent subtree', () => {
  // A pool of rowId values used for real, in-file rows.
  const ROW_ID_POOL = Array.from({ length: 10 }, (_, i) => `row${i}`);
  // A disjoint pool of rowId values that never appear as an actual
  // row's own rowId -- referencing one of these is, by construction,
  // always a dangling parentRowRef.
  const POISON_POOL = ['ghost0', 'ghost1', 'ghost2'];

  // teamCount rows drawn (without replacement) from ROW_ID_POOL, each
  // with a parentRowRef that is either empty, a reference to an
  // earlier row in the array (guaranteed acyclic, guaranteed to
  // resolve), or a reference to a POISON_POOL value (guaranteed
  // dangling). At least one dangling reference is forced via
  // `forcedDanglingIndex`, biasing the generator's space so a broken
  // edge is always present.
  const forestArb = fc.integer({ min: 1, max: 10 }).chain((teamCount) => {
    const rowIds = ROW_ID_POOL.slice(0, teamCount);

    // For each row (by index), a parent choice: 'none', 'earlier', or
    // 'dangling'. When 'earlier' is chosen for row i (i > 0), a
    // uniformly chosen earlier index 0..i-1 supplies the actual
    // parentRowRef value.
    const parentChoiceArb = fc.array(
      fc.oneof(fc.constant('none'), fc.constant('earlier'), fc.constant('dangling')),
      { minLength: teamCount, maxLength: teamCount }
    );

    const earlierIndexArb = fc.array(fc.nat({ max: Math.max(teamCount - 1, 0) }), {
      minLength: teamCount,
      maxLength: teamCount
    });

    const poisonArb = fc.array(fc.constantFrom(...POISON_POOL), {
      minLength: teamCount,
      maxLength: teamCount
    });

    // Which row index (if any) is forced to carry a dangling
    // reference, guaranteeing the generated space always includes at
    // least one broken edge.
    const forcedDanglingIndexArb = fc.nat({ max: teamCount - 1 });

    return fc.tuple(parentChoiceArb, earlierIndexArb, poisonArb, forcedDanglingIndexArb).map(
      ([parentChoices, earlierIndexes, poisonValues, forcedDanglingIndex]) => {
        const rows = rowIds.map((rowId, i) => {
          let choice = parentChoices[i];
          if (i === forcedDanglingIndex) {
            choice = 'dangling';
          }
          // A row with no earlier row available can never use
          // 'earlier' -- fall back to 'none' in that case only.
          if (i === 0 && choice === 'earlier') {
            choice = 'none';
          }
          if (choice === 'none') {
            return { rowId, name: `Team ${rowId}` };
          }
          if (choice === 'earlier') {
            // Clamp into 0..i-1 so this edge can never point at itself
            // or a later/nonexistent index -- guaranteed resolvable
            // and guaranteed acyclic.
            const earlierIndex = earlierIndexes[i] % i;
            return { rowId, name: `Team ${rowId}`, parentRowRef: rowIds[earlierIndex] };
          }
          // 'dangling': reference a value from the disjoint poison
          // pool, which by construction never matches any rowId in
          // `rowIds`.
          return { rowId, name: `Team ${rowId}`, parentRowRef: poisonValues[i] };
        });
        return rows;
      }
    );
  });

  /**
   * Independently (fresh, not via `buildImportGraph`'s own
   * `markFailedRowsAndComputeCreationOrder`) computes the expected set
   * of failed rowKeys: any row whose `parentRowRef` does not resolve
   * to an existing rowId in the file is failed; then transitively, any
   * row whose resolved parent is itself in the failed set is also
   * failed -- repeated to a fixed point.
   */
  function computeExpectedFailedSet(rows) {
    const byRowId = new Map(rows.map((row) => [row.rowId, row]));
    const failed = new Set();

    for (const row of rows) {
      const parentRef = row.parentRowRef;
      if (parentRef !== undefined && parentRef !== '' && !byRowId.has(parentRef)) {
        failed.add(row.rowId);
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (failed.has(row.rowId)) {
          continue;
        }
        const parentRef = row.parentRowRef;
        if (parentRef !== undefined && parentRef !== '' && failed.has(parentRef)) {
          failed.add(row.rowId);
          changed = true;
        }
      }
    }

    return failed;
  }

  test.prop([forestArb], { numRuns: 100 })(
    'every row transitively dependent on a broken parentRowRef edge fails, and every other row succeeds',
    (rows) => {
      const graph = buildImportGraph(rows);
      const expectedFailed = computeExpectedFailedSet(rows);

      // This generator's forced-dangling-index construction should
      // always yield at least one failed row; guard so the property is
      // never vacuously true.
      expect(expectedFailed.size).toBeGreaterThan(0);

      for (const row of rows) {
        const node = graph.nodes.get(row.rowId);
        const shouldFail = expectedFailed.has(row.rowId);

        expect(node.status === 'failed').toBe(shouldFail);

        if (shouldFail) {
          expect(graph.creationOrder).not.toContain(row.rowId);
        } else {
          expect(graph.creationOrder).toContain(row.rowId);
        }
      }
    }
  );
});

/**
 * Property-based test (design.md's Property 15: "CSV import outcome is
 * independent of row order") for `buildImportGraph`'s row-order
 * confluence (Requirement 9.6; task 17.6).
 *
 * This generalizes the hand-constructed
 * `'produces the same set of failed rowKeys and the same relative
 * ordering constraints regardless of row order'` test above (a single
 * fixed row set with a handful of hand-picked permutations) to many
 * randomly generated valid row sets, each checked against many random
 * permutations of itself.
 *
 * This is PURE logic -- no mocks needed -- matching the surrounding
 * `describe('BulkImportService.buildImportGraph', ...)` blocks'
 * conventions.
 *
 * Generator: a GUARANTEED-VALID (acyclic, non-duplicated-rowId) forest
 * of rows, built the same way as task 17.5's Property 14 generator
 * above -- each row's `rowId` is drawn, without replacement, from a
 * fixed pool, and each row's `parentRowRef` is either empty (a root) or
 * a reference to an EARLIER-generated row's own `rowId` in the same
 * array, which by construction can never form a cycle and can never be
 * dangling. Unlike task 17.5's generator, no `'dangling'` choice (and no
 * poison pool) is offered here, since this property is scoped to VALID
 * row sets only.
 *
 * A random permutation of the same row set is drawn via
 * `fc.shuffledSubarray` with `minLength`/`maxLength` both set to the
 * full array's length -- the same technique the `Property 14: CSV batch
 * row processing is isolated` test (above) uses to shuffle a batch
 * while preserving its full membership.
 *
 * Feature: org-team-hierarchy, task 17.6
 * Validates: Requirements 9.6
 */
describe('Property 15 (design.md): CSV import outcome is independent of row order', () => {
  const ROW_ID_POOL = Array.from({ length: 15 }, (_, i) => `row${i}`);

  // teamCount rows drawn (without replacement, so rowId is always
  // unique) from ROW_ID_POOL, each with a parentRowRef that is either
  // empty or a reference to an EARLIER row in the array -- guaranteed
  // acyclic and guaranteed to resolve, so the whole generated set is
  // always valid (no duplicate rowId, no dangling reference, no
  // cycle).
  const validForestArb = fc.integer({ min: 1, max: 15 }).chain((teamCount) => {
    const rowIds = ROW_ID_POOL.slice(0, teamCount);

    const parentChoiceArb = fc.array(fc.boolean(), { minLength: teamCount, maxLength: teamCount });
    const earlierIndexArb = fc.array(fc.nat({ max: Math.max(teamCount - 1, 0) }), {
      minLength: teamCount,
      maxLength: teamCount
    });

    return fc.tuple(parentChoiceArb, earlierIndexArb).map(([hasParentChoices, earlierIndexes]) =>
      rowIds.map((rowId, i) => {
        // A row with no earlier row available is always a root.
        const wantsParent = hasParentChoices[i] && i > 0;
        if (!wantsParent) {
          return { rowId, name: `Team ${rowId}` };
        }
        // Clamp into 0..i-1 so this edge can never point at itself or
        // a later/nonexistent index -- guaranteed resolvable and
        // guaranteed acyclic.
        const earlierIndex = earlierIndexes[i] % i;
        return { rowId, name: `Team ${rowId}`, parentRowRef: rowIds[earlierIndex] };
      })
    );
  });

  // Pairs a generated valid forest with a random permutation of the
  // SAME rows (full membership preserved, only order shuffled).
  const forestWithShuffleArb = validForestArb.chain((rows) =>
    fc
      .shuffledSubarray(rows, { minLength: rows.length, maxLength: rows.length })
      .map((shuffledRows) => ({ rows, shuffledRows }))
  );

  function failedRowKeySet(graph) {
    const failed = [];
    for (const [key, node] of graph.nodes.entries()) {
      if (node.status === 'failed') {
        failed.push(key);
      }
    }
    return failed.sort();
  }

  test.prop([forestWithShuffleArb], { numRuns: 100 })(
    'every permutation of a valid row set produces the same failed-rowKey set, the same per-row resolved parent, and the same topological-ordering constraints',
    ({ rows, shuffledRows }) => {
      const originalGraph = buildImportGraph(rows);
      const shuffledGraph = buildImportGraph(shuffledRows);

      // This generator only produces valid (acyclic, non-duplicated)
      // row sets -- no row should ever be failed in either graph, but
      // assert it defensively (a generator bug would otherwise slip
      // through unnoticed).
      expect(failedRowKeySet(originalGraph)).toEqual([]);
      expect(failedRowKeySet(shuffledGraph)).toEqual([]);

      // Every row's resolved parent is the SAME parent rowKey in both
      // graphs, looked up by rowKey (not by array position, since
      // shuffling changes position but not rowId).
      for (const row of rows) {
        const originalNode = originalGraph.nodes.get(row.rowId);
        const shuffledNode = shuffledGraph.nodes.get(row.rowId);
        expect(shuffledNode.resolvedParentKey).toBe(originalNode.resolvedParentKey);
      }

      // Both creationOrder arrays are valid topological orderings of
      // the SAME dependency graph: for every row with a resolved
      // parent, the parent's position precedes the row's position,
      // in BOTH graphs -- the two arrays need not be identical
      // element-for-element, since Kahn's algorithm's exact output can
      // depend on queue iteration order when multiple nodes are
      // simultaneously eligible.
      for (const graph of [originalGraph, shuffledGraph]) {
        for (const row of rows) {
          const node = graph.nodes.get(row.rowId);
          if (node.resolvedParentKey !== undefined) {
            const parentIndex = graph.creationOrder.indexOf(node.resolvedParentKey);
            const rowIndex = graph.creationOrder.indexOf(row.rowId);
            expect(parentIndex).toBeLessThan(rowIndex);
          }
        }
        // Both creationOrder arrays contain exactly the same SET of
        // rowKeys (every row in this valid forest, none failed).
        expect(graph.creationOrder.slice().sort()).toEqual(rows.map((r) => r.rowId).sort());
      }
    }
  );
});

/**
 * Property-based test (design.md's Property 13: "Duplicate `rowId`
 * values reject the entire import before any creation") for
 * `buildImportGraph`'s whole-file duplicate-`rowId` rejection
 * (Requirement 9.2; task 17.4).
 *
 * This is PURE logic -- no mocks needed -- matching the surrounding
 * `describe('BulkImportService.buildImportGraph', ...)` and
 * `describe('BulkImportService.buildImportGraph cycle detection', ...)`
 * blocks' conventions.
 *
 * Generator: a small pool of candidate rowId values (2-5), and a list of
 * 2-15 rows each assigned a rowId drawn from that pool (with
 * replacement) plus a name. A small pool relative to the row count
 * guarantees at least one rowId value is duplicated by construction
 * (pigeonhole), without needing to explicitly special-case a "first
 * duplicate pair".
 *
 * Feature: org-team-hierarchy, task 17.4
 * Validates: Requirements 9.2
 */
describe('Property 13: Duplicate rowId values reject the entire import before any creation', () => {
  // Generated candidate rowId values are constrained to strings that are
  // already equal to their own trimmed form (buildImportGraph reads
  // every field via `readOptionalField`, which trims -- so a generated
  // value that differs only in leading/trailing whitespace from another
  // would collide there but not in this test's own untrimmed count,
  // producing a false property failure unrelated to duplicate-rowId
  // rejection itself).
  const rowIdPoolArb = fc.uniqueArray(
    fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim() === s && s !== ''),
    { minLength: 2, maxLength: 5 }
  );

  // A row count comfortably larger than the pool's max size (5) so that,
  // combined with a pool of only 2-5 distinct values, the pigeonhole
  // principle guarantees at least one value is duplicated.
  const rowsFromPoolArb = rowIdPoolArb.chain((pool) =>
    fc
      .array(fc.integer({ min: 0, max: pool.length - 1 }), { minLength: 6, maxLength: 15 })
      .map((poolIndexes) => poolIndexes.map((i, rowIndex) => ({ rowId: pool[i], name: `Row ${rowIndex}` })))
  );

  test.prop([rowsFromPoolArb], { numRuns: 100 })(
    'wholeFileErrors names exactly the set of rowId values that occur 2+ times, and no team is created from that file',
    (rows) => {
      const graph = buildImportGraph(rows);

      // Independently compute (fresh, not via buildImportGraph's own
      // counting logic) which rowId values are duplicated 2+ times.
      const counts = new Map();
      rows.forEach((row) => {
        counts.set(row.rowId, (counts.get(row.rowId) || 0) + 1);
      });
      const duplicatedValues = Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([rowId]) => rowId);

      // This generator's pool-vs-row-count construction should always
      // yield at least one duplicate; guard so the property is never
      // vacuously true.
      expect(duplicatedValues.length).toBeGreaterThan(0);

      const duplicateErrors = graph.wholeFileErrors.filter((e) => e.error.startsWith('Duplicate rowId'));

      // Exactly one wholeFileErrors entry per duplicated value -- no
      // fewer, no more -- each naming that value.
      expect(duplicateErrors).toHaveLength(duplicatedValues.length);
      for (const value of duplicatedValues) {
        expect(duplicateErrors).toContainEqual({ error: `Duplicate rowId: ${value}`, rowIds: [value] });
      }

      // "No team is created from that file" is enforced one layer up,
      // by `importTeams`'s own `if (graph.wholeFileErrors.length > 0)
      // return {..., rejected: true}` short-circuit before Phase 2 ever
      // runs `Team.create` (covered by the existing 'rejects the whole
      // file and creates zero teams when a rowId is duplicated' test
      // above) -- this property, scoped to `buildImportGraph` itself,
      // only needs to confirm the file IS flagged for rejection via a
      // non-empty `wholeFileErrors`.
      expect(graph.wholeFileErrors.length).toBeGreaterThan(0);
    }
  );
});

/**
 * Unit tests for `BulkImportService.importUserRow`'s identity resolution
 * wiring (takserver-enrollment Requirements 6.3, 6.6, 6.8; task 5.3 --
 * replacing the removed `resolveCallsignSuffixForNewUser` with
 * `resolveNewUserIdentity`).
 *
 * Covers: a successful import passing an optional `callsignSuffix` CSV
 * column and the `row.username || email.split('@')[0]` derivation through
 * to `resolveNewUserIdentity` and on to `createAndAddUser`; a
 * `CallsignSuffixRequiredError`/`CallsignSuffixConflictError`/
 * `OrganisationPrefixMissingError`/`ManagedIdentifierExhaustionError`
 * thrown for one row being recorded as THAT row's own failure via
 * `importUsers`'s existing per-row catch, with the rest of the batch
 * continuing; that the RESOLVED username (not the raw CSV-derived one)
 * reaches `authentikService.createUser`; and confirming
 * `authentikService.createUser` is never called for a failing row.
 */
describe('BulkImportService.importUserRow identity resolution (takserver-enrollment task 5.3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.connect.mockImplementation(() => Promise.resolve(buildMockClient()));
    pool.query.mockResolvedValue({ rows: [] });
    authentikService.createUser.mockResolvedValue({ pk: 1000 });
    UserAttributesService.generateCallsign.mockResolvedValue({ callsign: 'FENZ-CS', color: 'Red', role: 'Team Member' });
    UserAttributesService.updateUserAttributes.mockResolvedValue(true);
    UserProvisioningService.createAndAddUser.mockResolvedValue({ localUserId: 42, queuedGroups: 1 });
    Team.isAdmin.mockResolvedValue(true);
  });

  function csvFromUserRowsWithSuffix(rows) {
    const header = 'email,firstName,lastName,teamId,callsignSuffix';
    const lines = rows.map((r) => [
      r.email ?? '', r.firstName ?? '', r.lastName ?? '', r.teamId ?? '', r.callsignSuffix ?? ''
    ].join(','));
    return [header, ...lines].join('\n');
  }

  it('reads the optional callsignSuffix column and passes the email verbatim as requestedUsername through to createAndAddUser', async () => {
    UserProvisioningService.resolveNewUserIdentity.mockResolvedValue({
      username: 'jdoe@example.com',
      callsignSuffix: 'J.Doe',
      pseudonymous: false,
      organisationId: 1,
      organisationPrefix: 'ORG',
      claimId: null
    });
    const csv = csvFromUserRowsWithSuffix([
      { email: 'jdoe@example.com', firstName: 'John', lastName: 'Doe', teamId: '5', callsignSuffix: 'J.Doe' }
    ]);

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importUsers(csv, importingUser);

    expect(summary.successCount).toBe(1);
    // Bugfix: requestedUsername is the email VERBATIM -- matching
    // `POST /api/users/create-and-add`'s own derivation -- never a
    // CSV-supplied override and never the email's local part alone.
    expect(UserProvisioningService.resolveNewUserIdentity).toHaveBeenCalledWith(null, {
      firstName: 'John',
      lastName: 'Doe',
      email: 'jdoe@example.com',
      teamId: 5,
      requestedUsername: 'jdoe@example.com',
      requestedCallsignSuffix: 'J.Doe'
    });
    // The RESOLVED username reaches the Authentik call.
    expect(authentikService.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'jdoe@example.com' })
    );
    expect(UserProvisioningService.createAndAddUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ username: 'jdoe@example.com', callsign_suffix: 'J.Doe' })
    );
  });

  // Bugfix (bulk-imported users showed callsign "-" in the Members tab and
  // empty takCallsign/takColor in Authentik): importUserRow now runs the
  // same post-commit Phase 3 the single-user create-and-add route runs --
  // compute the callsign, PATCH Authentik, and mirror into user_cache.
  // `createAndAddUser` (shared by both paths) only stores callsign_suffix.
  it('after commit, computes the callsign, pushes it to Authentik, and mirrors it into user_cache (Phase 3)', async () => {
    UserProvisioningService.resolveNewUserIdentity.mockResolvedValue({
      username: 'jdoe@example.com',
      callsignSuffix: 'J.Doe',
      pseudonymous: false,
      claimId: null
    });
    UserProvisioningService.createAndAddUser.mockResolvedValue({ localUserId: 777, queuedGroups: 1 });
    authentikService.createUser.mockResolvedValue({ pk: 'authentik-pk-777' });
    UserAttributesService.generateCallsign.mockResolvedValue({ callsign: 'FENZ-J.Doe', color: 'Red', role: 'Team Member' });

    const csv = csvFromRows([
      { email: 'jdoe@example.com', firstName: 'John', lastName: 'Doe', teamId: '5' }
    ]);
    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importUsers(csv, importingUser);

    expect(summary.results[0].success).toBe(true);

    // Callsign computed from the just-created local user + target team.
    expect(UserAttributesService.generateCallsign).toHaveBeenCalledWith(777, 5);
    // Pushed to Authentik under the created user's pk, carrying callsign/color.
    expect(UserAttributesService.updateUserAttributes).toHaveBeenCalledWith(
      'authentik-pk-777',
      expect.objectContaining({ callsign: 'FENZ-J.Doe', color: 'Red', firstName: 'John', lastName: 'Doe' })
    );
    // Mirrored into user_cache with the computed tak_callsign/tak_color.
    const cacheCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO user_cache')
    );
    expect(cacheCall).toBeDefined();
    // params: authentik_id, username, email, first, last, [is_active literal], tak_callsign, tak_color, tak_role, callsign_suffix
    expect(cacheCall[1]).toEqual([
      'authentik-pk-777', 'jdoe@example.com', 'jdoe@example.com', 'John', 'Doe',
      'FENZ-J.Doe', 'Red', 'Team Member', 'J.Doe'
    ]);
  });

  it('still counts the row as imported when the post-commit callsign/Authentik sync fails (best-effort, non-rollback)', async () => {
    UserProvisioningService.resolveNewUserIdentity.mockResolvedValue({
      username: 'jdoe@example.com',
      callsignSuffix: 'J.Doe',
      pseudonymous: false,
      claimId: null
    });
    // Phase 3 Authentik push throws -- must NOT fail the already-created row.
    UserAttributesService.updateUserAttributes.mockRejectedValue(new Error('Authentik unreachable'));

    const csv = csvFromRows([
      { email: 'jdoe@example.com', firstName: 'John', lastName: 'Doe', teamId: '5' }
    ]);
    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importUsers(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(0);
    expect(summary.results[0].success).toBe(true);
  });

  it('passes undefined requestedCallsignSuffix when the CSV column is omitted/empty', async () => {
    UserProvisioningService.resolveNewUserIdentity.mockResolvedValue({
      username: 'jdoe@example.com',
      callsignSuffix: 'J-Doe',
      pseudonymous: false,
      claimId: null
    });
    const csv = csvFromRows([
      { email: 'jdoe@example.com', firstName: 'John', lastName: 'Doe', teamId: '5' }
    ]);

    const importingUser = { userId: 1, is_global_manager: true };
    await BulkImportService.importUsers(csv, importingUser);

    expect(UserProvisioningService.resolveNewUserIdentity).toHaveBeenCalledWith(null, {
      firstName: 'John',
      lastName: 'Doe',
      email: 'jdoe@example.com',
      teamId: 5,
      requestedUsername: 'jdoe@example.com',
      requestedCallsignSuffix: undefined
    });
  });

  it("uses the resolved (minted) username for the Authentik call, and passes claimId through to createAndAddUser, for a pseudonymous Organisation", async () => {
    UserProvisioningService.resolveNewUserIdentity.mockResolvedValue({
      username: 'ORG-U7K3QMX',
      callsignSuffix: 'Ghost1',
      pseudonymous: true,
      organisationId: 1,
      organisationPrefix: 'ORG',
      claimId: 999
    });
    const csv = csvFromRows([
      { email: 'jdoe@example.com', firstName: 'John', lastName: 'Doe', teamId: '5' }
    ]);

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importUsers(csv, importingUser);

    expect(summary.successCount).toBe(1);
    // The Authentik create-user call uses the RESOLVED (minted)
    // username, never the caller-supplied email.
    expect(authentikService.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'ORG-U7K3QMX' })
    );
    expect(UserProvisioningService.createAndAddUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ username: 'ORG-U7K3QMX', claimId: 999 })
    );
  });

  it('records a CallsignSuffixRequiredError as that row\'s own failure, continuing the rest of the batch, without calling Authentik for that row', async () => {
    const { CallsignSuffixRequiredError } = jest.requireActual('./UserProvisioningService');
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '5' },
      { email: 'bob@example.com', firstName: 'Bob', lastName: 'Jones', teamId: '5' },
      { email: 'carol@example.com', firstName: 'Carol', lastName: 'Lee', teamId: '5' }
    ]);

    UserProvisioningService.resolveNewUserIdentity
      .mockResolvedValueOnce({ username: 'alice', callsignSuffix: 'A.Smith', pseudonymous: false, claimId: null })
      .mockRejectedValueOnce(new CallsignSuffixRequiredError())
      .mockResolvedValueOnce({ username: 'carol', callsignSuffix: 'C.Lee', pseudonymous: false, claimId: null });

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importUsers(csv, importingUser);

    expect(summary.successCount).toBe(2);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[1].success).toBe(false);
    expect(summary.results[1].error).toMatch(/callsign suffix is required/i);

    // The failing row never reached Authentik user creation.
    expect(authentikService.createUser).toHaveBeenCalledTimes(2);
    expect(authentikService.createUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ email: 'bob@example.com' })
    );
  });

  it('records an OrganisationPrefixMissingError as that row\'s own failure, continuing the rest of the batch, without calling Authentik for that row', async () => {
    const { OrganisationPrefixMissingError } = jest.requireActual('./ManagedIdentifierService');
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '5' },
      { email: 'bob@example.com', firstName: 'Bob', lastName: 'Jones', teamId: '5' }
    ]);

    UserProvisioningService.resolveNewUserIdentity
      .mockResolvedValueOnce({ username: 'alice', callsignSuffix: 'A.Smith', pseudonymous: false, claimId: null })
      .mockRejectedValueOnce(new OrganisationPrefixMissingError(1));

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importUsers(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[1].success).toBe(false);
    expect(summary.results[1].error).toMatch(/Organisation_Prefix/);
    expect(authentikService.createUser).toHaveBeenCalledTimes(1);
    expect(authentikService.createUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ email: 'bob@example.com' })
    );
  });

  it('records a ManagedIdentifierExhaustionError as that row\'s own failure, continuing the rest of the batch, without calling Authentik for that row', async () => {
    const { ManagedIdentifierExhaustionError } = jest.requireActual('./ManagedIdentifierService');
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '5' },
      { email: 'bob@example.com', firstName: 'Bob', lastName: 'Jones', teamId: '5' }
    ]);

    UserProvisioningService.resolveNewUserIdentity
      .mockResolvedValueOnce({ username: 'alice', callsignSuffix: 'A.Smith', pseudonymous: false, claimId: null })
      .mockRejectedValueOnce(new ManagedIdentifierExhaustionError(1, 'U', 5));

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importUsers(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[1].success).toBe(false);
    expect(summary.results[1].error).toMatch(/Exhausted/);
    expect(authentikService.createUser).toHaveBeenCalledTimes(1);
    expect(authentikService.createUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ email: 'bob@example.com' })
    );
  });

  it('records a CallsignSuffixConflictError as that row\'s own failure, continuing the rest of the batch, without calling Authentik for that row', async () => {
    const { CallsignSuffixConflictError } = jest.requireActual('./CallsignSuffixUniquenessService');
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '5' },
      { email: 'bob@example.com', firstName: 'Bob', lastName: 'Jones', teamId: '5' }
    ]);

    UserProvisioningService.resolveNewUserIdentity
      .mockResolvedValueOnce({ username: 'alice', callsignSuffix: 'A.Smith', pseudonymous: false, claimId: null })
      .mockRejectedValueOnce(new CallsignSuffixConflictError('A.Smith'));

    const importingUser = { userId: 1, is_global_manager: true };
    const summary = await BulkImportService.importUsers(csv, importingUser);

    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[1].success).toBe(false);
    expect(summary.results[1].error).toMatch(/A\.Smith/);

    expect(authentikService.createUser).toHaveBeenCalledTimes(1);
    expect(authentikService.createUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ email: 'bob@example.com' })
    );
  });
});

/**
 * Unit tests for `BulkImportService`'s additions:
 *   - `defaultTeamId` (team-scoped import: a row's own `teamId` column
 *     still wins when present, but a blank/absent column falls back to
 *     the caller-supplied default).
 *   - `importUsers`'s `rowNumbers` option (preview-then-confirm commit:
 *     only the named 1-based row numbers are processed; every other row
 *     is skipped with no Authentik call, no DB write, and no `results`
 *     entry).
 *   - `previewUsers` (the read-only dry run backing the preview step):
 *     new / invalid / unauthorized / duplicate_in_file /
 *     duplicate_existing classification, and its single batched
 *     existing-user lookup query.
 */
describe('BulkImportService defaultTeamId fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.connect.mockImplementation(() => Promise.resolve(buildMockClient()));
    pool.query.mockResolvedValue({ rows: [] });
    authentikService.createUser.mockResolvedValue({ pk: 1000 });
    UserAttributesService.generateCallsign.mockResolvedValue({ callsign: 'FENZ-CS', color: 'Red', role: 'Team Member' });
    UserAttributesService.updateUserAttributes.mockResolvedValue(true);
    UserProvisioningService.createAndAddUser.mockResolvedValue({ localUserId: 42, queuedGroups: 1 });
    UserProvisioningService.resolveNewUserIdentity.mockImplementation((client, { requestedUsername }) =>
      Promise.resolve({ username: requestedUsername, callsignSuffix: null, pseudonymous: false, claimId: null })
    );
    Team.isAdmin.mockResolvedValue(true);
  });

  it('uses defaultTeamId for a row whose own teamId column is blank', async () => {
    const csv = 'email,firstName,lastName,teamId\nalice@example.com,Alice,Smith,\n';
    const importingUser = { userId: 1, is_global_manager: true };

    await BulkImportService.importUsers(csv, importingUser, { defaultTeamId: 7 });

    expect(Team.isAdmin).not.toHaveBeenCalled(); // is_global_manager: true skips the check
    expect(UserProvisioningService.resolveNewUserIdentity).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ teamId: 7 })
    );
  });

  it('prefers a row\'s own non-blank teamId column over defaultTeamId', async () => {
    const csv = 'email,firstName,lastName,teamId\nalice@example.com,Alice,Smith,9\n';
    const importingUser = { userId: 1, is_global_manager: true };

    await BulkImportService.importUsers(csv, importingUser, { defaultTeamId: 7 });

    expect(UserProvisioningService.resolveNewUserIdentity).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ teamId: 9 })
    );
  });

  it('still rejects the row when neither the column nor defaultTeamId supplies a teamId', async () => {
    const csv = 'email,firstName,lastName,teamId\nalice@example.com,Alice,Smith,\n';
    const importingUser = { userId: 1, is_global_manager: true };

    const summary = await BulkImportService.importUsers(csv, importingUser, {});

    expect(summary.failureCount).toBe(1);
    expect(summary.results[0].error).toBe('Missing required field: teamId');
  });
});

describe('BulkImportService.importUsers rowNumbers filtering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.connect.mockImplementation(() => Promise.resolve(buildMockClient()));
    pool.query.mockResolvedValue({ rows: [] });
    authentikService.createUser.mockResolvedValue({ pk: 1000 });
    UserAttributesService.generateCallsign.mockResolvedValue({ callsign: 'FENZ-CS', color: 'Red', role: 'Team Member' });
    UserAttributesService.updateUserAttributes.mockResolvedValue(true);
    UserProvisioningService.createAndAddUser.mockResolvedValue({ localUserId: 42, queuedGroups: 1 });
    UserProvisioningService.resolveNewUserIdentity.mockImplementation((client, { requestedUsername }) =>
      Promise.resolve({ username: requestedUsername, callsignSuffix: null, pseudonymous: false, claimId: null })
    );
    Team.isAdmin.mockResolvedValue(true);
  });

  it('processes only the named row numbers, skipping every other row entirely', async () => {
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '5' },
      { email: 'bob@example.com', firstName: 'Bob', lastName: 'Jones', teamId: '5' },
      { email: 'carol@example.com', firstName: 'Carol', lastName: 'Lee', teamId: '5' }
    ]);
    const importingUser = { userId: 1, is_global_manager: true };

    const summary = await BulkImportService.importUsers(csv, importingUser, { rowNumbers: [1, 3] });

    expect(summary.results).toEqual([
      { row: 1, success: true, userId: 42 },
      { row: 3, success: true, userId: 42 }
    ]);
    expect(authentikService.createUser).toHaveBeenCalledTimes(2);
    expect(authentikService.createUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ email: 'bob@example.com' })
    );
  });

  it('processes every row when rowNumbers is omitted, matching pre-existing behaviour', async () => {
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '5' },
      { email: 'bob@example.com', firstName: 'Bob', lastName: 'Jones', teamId: '5' }
    ]);
    const importingUser = { userId: 1, is_global_manager: true };

    const summary = await BulkImportService.importUsers(csv, importingUser);

    expect(summary.successCount).toBe(2);
  });
});

describe('BulkImportService.previewUsers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [] });
    Team.isAdmin.mockResolvedValue(true);
  });

  it('classifies a well-formed, non-duplicate row as new', async () => {
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '5' }
    ]);
    const importingUser = { userId: 1, is_global_manager: true };

    const { rows } = await BulkImportService.previewUsers(csv, importingUser);

    expect(rows).toEqual([
      {
        row: 1,
        email: 'alice@example.com',
        firstName: 'Alice',
        lastName: 'Smith',
        teamId: 5,
        username: 'alice@example.com',
        status: 'new'
      }
    ]);
    // Read-only: no Authentik call, no client acquired.
    expect(authentikService.createUser).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('classifies a row missing a required field as invalid, without querying the DB for duplicates', async () => {
    const csv = csvFromRows([
      { email: '', firstName: 'Alice', lastName: 'Smith', teamId: '5' }
    ]);
    const importingUser = { userId: 1, is_global_manager: true };

    const { rows } = await BulkImportService.previewUsers(csv, importingUser);

    expect(rows[0].status).toBe('invalid');
    expect(rows[0].reason).toBe('Missing required field: email');
  });

  it('classifies a row targeting a team the importing team admin does not administer as unauthorized', async () => {
    Team.isAdmin.mockResolvedValue(false);
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '99' }
    ]);
    const importingUser = { userId: 7, is_global_manager: false };

    const { rows } = await BulkImportService.previewUsers(csv, importingUser);

    expect(rows[0].status).toBe('unauthorized');
    expect(rows[0].reason).toMatch(/Unauthorized/);
    expect(Team.isAdmin).toHaveBeenCalledWith(99, 7);
  });

  it('flags every occurrence after the first of a duplicated email within the same file as duplicate_in_file', async () => {
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '5' },
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Jones', teamId: '5' }
    ]);
    const importingUser = { userId: 1, is_global_manager: true };

    const { rows } = await BulkImportService.previewUsers(csv, importingUser);

    expect(rows[0].status).toBe('new');
    expect(rows[1].status).toBe('duplicate_in_file'); // same email (== username) as row 1
  });

  it('flags a row matching an existing users row (by username OR email) as duplicate_existing, via one batched query', async () => {
    pool.query.mockResolvedValue({
      rows: [{ username: 'alice@example.com', email: 'someoneelse@example.com' }]
    });
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '5' },
      { email: 'someoneelse@example.com', firstName: 'Bob', lastName: 'Jones', teamId: '5' }
    ]);
    const importingUser = { userId: 1, is_global_manager: true };

    const { rows } = await BulkImportService.previewUsers(csv, importingUser);

    expect(rows[0].status).toBe('duplicate_existing');
    expect(rows[1].status).toBe('duplicate_existing');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('an invalid or unauthorized row is never additionally reported as a duplicate', async () => {
    Team.isAdmin.mockResolvedValue(false);
    const csv = csvFromRows([
      { email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', teamId: '99' },
      { email: 'alice@example.com', firstName: 'Bob', lastName: 'Jones', teamId: '99' }
    ]);
    const importingUser = { userId: 7, is_global_manager: false };

    const { rows } = await BulkImportService.previewUsers(csv, importingUser);

    expect(rows[0].status).toBe('unauthorized');
    expect(rows[1].status).toBe('unauthorized');
  });

  it('applies defaultTeamId to a row whose own teamId column is blank, matching importUsers', async () => {
    const csv = 'email,firstName,lastName,teamId\nalice@example.com,Alice,Smith,\n';
    const importingUser = { userId: 1, is_global_manager: true };

    const { rows } = await BulkImportService.previewUsers(csv, importingUser, 7);

    expect(rows[0].status).toBe('new');
    expect(rows[0].teamId).toBe(7);
  });
});
