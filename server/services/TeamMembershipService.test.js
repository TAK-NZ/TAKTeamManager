/**
 * Unit tests for `TeamMembershipService.addUserToTeam`/`removeUserFromTeam`
 * focused on Requirement 17.5: the `sync_operations` INSERT performed via
 * `EventPublisher.publishOperation` must run on the SAME transactional
 * client used for the membership-row writes, so that a failure in either
 * the membership write or the sync_operations insert rolls back both.
 */

jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));
jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn()
}));
jest.mock('../models/Team', () => ({
  getFullMemberList: jest.fn()
}));

const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
const Team = require('../models/Team');
const TeamMembershipService = require('./TeamMembershipService');

function buildMockClient(queryImpl) {
  return {
    query: jest.fn(queryImpl),
    release: jest.fn()
  };
}

describe('TeamMembershipService.addUserToTeam', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes the open transactional client through to every publishOperation call, and inserts a channel_memberships row for the same channel', async () => {
    mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.id, c.authentik_group_id')) {
        return Promise.resolve({ rows: [{ id: 55, authentik_group_id: 'grp-team' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await TeamMembershipService.addUserToTeam(1, 2, 'member', 9);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'add_user_to_group',
      { target_user_id: 1, target_group_id: 'grp-team' },
      9,
      mockClient
    );
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'assign_user_to_global_channels',
      { target_user_id: 1 },
      9,
      mockClient
    );

    // The local channel_memberships row (what the team detail page's
    // displayed member count actually reads) must be created too, not
    // just the Authentik-side sync operation.
    const channelMembershipInsert = mockClient.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO channel_memberships')
    );
    expect(channelMembershipInsert).toBeDefined();
    expect(channelMembershipInsert[1]).toEqual([55, 1, 'read_write']);

    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back the membership change when the sync_operations insert (publishOperation) fails', async () => {
    mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.id, c.authentik_group_id')) {
        return Promise.resolve({ rows: [{ id: 55, authentik_group_id: 'grp-team' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockRejectedValue(new Error('sync_operations insert failed'));

    await expect(
      TeamMembershipService.addUserToTeam(1, 2, 'member', 9)
    ).rejects.toThrow('sync_operations insert failed');

    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('rolls back everything (including any already-queued operation) when the membership INSERT itself fails', async () => {
    mockClient = buildMockClient((sql) => {
      if (sql.includes('INSERT INTO team_memberships')) {
        return Promise.reject(new Error('membership insert failed'));
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await expect(
      TeamMembershipService.addUserToTeam(1, 2, 'member', 9)
    ).rejects.toThrow('membership insert failed');

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
  });
});

describe('TeamMembershipService.addUserToTeam - externally-provided client (Requirement 18.2 / task 38.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the caller-provided client and does not call pool.connect, BEGIN, COMMIT, or release', async () => {
    const externalClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.id, c.authentik_group_id')) {
        return Promise.resolve({ rows: [{ id: 55, authentik_group_id: 'grp-team' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    const result = await TeamMembershipService.addUserToTeam(1, 2, 'member', 9, externalClient);

    expect(pool.connect).not.toHaveBeenCalled();
    expect(externalClient.query).not.toHaveBeenCalledWith('BEGIN');
    expect(externalClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(externalClient.release).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'add_user_to_group',
      { target_user_id: 1, target_group_id: 'grp-team' },
      9,
      externalClient
    );
    expect(result).toEqual({ success: true, groupsQueued: 1 });
  });

  it('propagates a failure without issuing ROLLBACK or release, leaving transaction control to the caller', async () => {
    const externalClient = buildMockClient((sql) => {
      if (sql.includes('INSERT INTO team_memberships')) {
        return Promise.reject(new Error('membership insert failed'));
      }
      return Promise.resolve({ rows: [] });
    });
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await expect(
      TeamMembershipService.addUserToTeam(1, 2, 'member', 9, externalClient)
    ).rejects.toThrow('membership insert failed');

    expect(externalClient.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(externalClient.release).not.toHaveBeenCalled();
  });

  it('falls back to acquiring its own client (original behavior) when no external client is given', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.id, c.authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await TeamMembershipService.addUserToTeam(1, 2, 'member', 9);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

/**
 * Requirement 11.18 (task 25.1): `addUserToTeam` must reject a membership
 * change that would create a same-Team `callsign_suffix` collision in the
 * DESTINATION team, checked via the shared `checkCallsignSuffixUniqueness`
 * (`CallsignSuffixUniquenessService`, task 23.1) BEFORE any
 * `DELETE`/`INSERT` write against `team_memberships` is attempted.
 *
 * `../models/Team` is mocked (not `./CallsignSuffixUniquenessService`
 * itself) so these tests exercise `addUserToTeam`'s own wiring into the
 * REAL shared uniqueness-check function, consistent with
 * `UserProvisioningService.test.js`'s existing convention for the same
 * dependency -- `checkCallsignSuffixUniqueness`'s own internals already
 * have a dedicated test file (`CallsignSuffixUniquenessService.test.js`).
 */
describe('TeamMembershipService.addUserToTeam - callsign_suffix uniqueness (Requirement 11.18)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects the membership change with CallsignSuffixConflictError when the user\'s own callsign_suffix collides with an existing member of the destination team, and never attempts a DELETE/INSERT write', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT callsign_suffix FROM users WHERE id = $1')) {
        return Promise.resolve({ rows: [{ callsign_suffix: 'J.Doe' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    Team.getFullMemberList.mockResolvedValue([
      { id: 999, callsign_suffix: 'j.doe' } // case-insensitive collision, different user
    ]);

    await expect(
      TeamMembershipService.addUserToTeam(1, 2, 'member', 9)
    ).rejects.toThrow('Callsign Suffix "J.Doe" is already in use within this Team');

    const sqlCalls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls.some((sql) => sql.trim().startsWith('DELETE FROM team_memberships'))).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes('INSERT INTO team_memberships'))).toBe(false);

    // Since ownsTransaction is true here, the failure still routes through
    // this method's existing catch block's ROLLBACK/release cleanup.
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('succeeds normally when the user\'s own callsign_suffix does not collide with anyone in the destination team', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT callsign_suffix FROM users WHERE id = $1')) {
        return Promise.resolve({ rows: [{ callsign_suffix: 'J.Doe' }] });
      }
      if (sql.includes('SELECT c.id, c.authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    Team.getFullMemberList.mockResolvedValue([
      { id: 999, callsign_suffix: 'A.Smith' }
    ]);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    const result = await TeamMembershipService.addUserToTeam(1, 2, 'member', 9);

    expect(result).toEqual({ success: true, groupsQueued: 0 });
    expect(mockClient.query).toHaveBeenCalledWith('DELETE FROM team_memberships WHERE user_id = $1', [1]);
    expect(mockClient.query).toHaveBeenCalledWith(
      'INSERT INTO team_memberships (user_id, team_id, role) VALUES ($1, $2, $3)',
      [1, 2, 'member']
    );
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });

  it('succeeds without a real uniqueness conflict when the user has no callsign_suffix set (null/empty short-circuits the check)', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT callsign_suffix FROM users WHERE id = $1')) {
        return Promise.resolve({ rows: [{ callsign_suffix: null }] });
      }
      if (sql.includes('SELECT c.id, c.authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    const result = await TeamMembershipService.addUserToTeam(1, 2, 'member', 9);

    expect(result).toEqual({ success: true, groupsQueued: 0 });
    // checkCallsignSuffixUniqueness short-circuits on a falsy candidate
    // value without even calling Team.getFullMemberList.
    expect(Team.getFullMemberList).not.toHaveBeenCalled();
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });

  it('runs the uniqueness check before any DELETE/INSERT team_memberships call (ordering)', async () => {
    const callOrder = [];
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT callsign_suffix FROM users WHERE id = $1')) {
        callOrder.push('select-own-suffix');
        return Promise.resolve({ rows: [{ callsign_suffix: 'J.Doe' }] });
      }
      if (sql.trim().startsWith('DELETE FROM team_memberships')) {
        callOrder.push('delete');
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO team_memberships')) {
        callOrder.push('insert');
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    Team.getFullMemberList.mockImplementation(async () => {
      callOrder.push('uniqueness-check');
      return [];
    });
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await TeamMembershipService.addUserToTeam(1, 2, 'member', 9);

    expect(callOrder).toEqual(['select-own-suffix', 'uniqueness-check', 'delete', 'insert']);
  });

  it('applies the same check when an externally-provided client is used', async () => {
    const externalClient = buildMockClient((sql) => {
      if (sql.includes('SELECT callsign_suffix FROM users WHERE id = $1')) {
        return Promise.resolve({ rows: [{ callsign_suffix: 'J.Doe' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    Team.getFullMemberList.mockResolvedValue([
      { id: 999, callsign_suffix: 'J.DOE' }
    ]);

    await expect(
      TeamMembershipService.addUserToTeam(1, 2, 'member', 9, externalClient)
    ).rejects.toThrow('Callsign Suffix "J.Doe" is already in use within this Team');

    expect(pool.connect).not.toHaveBeenCalled();
    const sqlCalls = externalClient.query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls.some((sql) => sql.trim().startsWith('DELETE FROM team_memberships'))).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes('INSERT INTO team_memberships'))).toBe(false);
    // No ROLLBACK/release for an externally-provided client -- the caller
    // owns the transaction lifecycle.
    expect(externalClient.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(externalClient.release).not.toHaveBeenCalled();
  });
});

/**
 * Task 58.4 (Requirement 12.2): "no-parent add", ">=1-parent add
 * (inherited rows created)", "removal also removes inherited rows", and
 * "duplicate-add attempt" examples.
 *
 * VERIFIED BY READING THE SOURCE (`TeamMembershipService.js`,
 * `UserProvisioningService.js`) before writing these tests:
 *
 *  - `addUserToTeam` itself performs exactly one membership write --
 *    `DELETE FROM team_memberships WHERE user_id = $1` (unconditional,
 *    no `team_id`/`inherited_from_team_id` filter) followed by
 *    `INSERT INTO team_memberships (user_id, team_id, role) VALUES (...)`
 *    (no `inherited_from_team_id` column at all, i.e. always a DIRECT
 *    row). It contains NO parent-team-walking logic and therefore never
 *    creates an inherited row itself, regardless of whether the target
 *    team has a parent.
 *  - `removeUserFromTeam`'s `DELETE FROM team_memberships WHERE user_id
 *    = $1` is the SAME unconditional shape -- it removes every row for
 *    the user (direct AND inherited) with no `inherited_from_team_id`
 *    filter.
 *  - The parent-chain "create one inherited `team_memberships` row per
 *    ancestor" behavior actually lives in
 *    `UserProvisioningService.createAndAddUser` (see that file's own
 *    recursive `parent_teams` CTE and its
 *    `INSERT INTO team_memberships (..., inherited_from_team_id) VALUES
 *    (...)` per parent).
 */
describe('TeamMembershipService.addUserToTeam / removeUserFromTeam - task 58.4 (Requirement 12.2) examples', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('"no-parent add": inserts exactly one direct team_memberships row, with no inherited_from_team_id column involved', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.id, c.authentik_group_id')) {
        // Team has no parent (and no primary channel either) -- the
        // recursive CTE's base case is the only row and yields nothing.
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await TeamMembershipService.addUserToTeam(5, 20, 'member', 9);

    const membershipInsertCalls = mockClient.query.mock.calls.filter(([sql]) =>
      sql.includes('INSERT INTO team_memberships')
    );
    expect(membershipInsertCalls).toHaveLength(1);

    const [insertSql, insertParams] = membershipInsertCalls[0];
    expect(insertSql).not.toContain('inherited_from_team_id');
    expect(insertParams).toEqual([5, 20, 'member']);
  });

  /**
   * Regression test: `addUserToTeam` previously queued only an
   * Authentik-side `add_user_to_group` sync operation for each team-
   * hierarchy primary channel, without ever writing a local
   * `channel_memberships` row. Since the team detail page's displayed
   * channel member count (`GET /channels/team/:teamId`) is computed
   * strictly via `COUNT(channel_memberships.user_id)`, a user added
   * through this method showed up correctly in `team_memberships` but
   * the team's own channel kept showing 0 members. This verifies the fix
   * inserts a `channel_memberships` row for every channel found (via
   * `ON CONFLICT DO NOTHING`, matching `UserProvisioningService
   * .createAndAddUser`'s established pattern), and that a channel with
   * no Authentik group id yet still gets its local row (only the
   * Authentik sync enqueue is skipped for that channel).
   */
  it('inserts a channel_memberships row for every team-hierarchy primary channel, even one with no authentik_group_id yet', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.id, c.authentik_group_id')) {
        return Promise.resolve({
          rows: [
            { id: 55, authentik_group_id: 'grp-team' },
            { id: 56, authentik_group_id: null }
          ]
        });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    const result = await TeamMembershipService.addUserToTeam(5, 20, 'member', 9);

    const channelMembershipInserts = mockClient.query.mock.calls.filter(([sql]) =>
      sql.includes('INSERT INTO channel_memberships')
    );
    expect(channelMembershipInserts).toHaveLength(2);
    expect(channelMembershipInserts[0][1]).toEqual([55, 5, 'read_write']);
    expect(channelMembershipInserts[0][0]).toContain('ON CONFLICT DO NOTHING');
    expect(channelMembershipInserts[1][1]).toEqual([56, 5, 'read_write']);

    // Only the channel with a real Authentik group id gets a sync
    // operation enqueued; the other channel still gets its local row.
    const addUserToGroupCalls = EventPublisher.publishOperation.mock.calls.filter(
      ([opType]) => opType === 'add_user_to_group'
    );
    expect(addUserToGroupCalls).toHaveLength(1);
    expect(addUserToGroupCalls[0][1]).toEqual({ target_user_id: 5, target_group_id: 'grp-team' });
    expect(result.groupsQueued).toBe(1);
  });

  /**
   * ">=1-parent add (inherited rows created)": since `addUserToTeam`
   * genuinely never creates inherited rows (confirmed above), this
   * example is NOT forced onto `addUserToTeam` here -- that would just
   * assert behavior that doesn't happen. It instead lives in
   * `UserProvisioningService.test.js`'s "creates an inherited
   * team_membership row and queues a group operation for each parent
   * team" test, which already exercises a 2-parent-team hierarchy
   * (>=1 parent) against `UserProvisioningService.createAndAddUser` --
   * the method that actually owns this behavior -- asserting one
   * inherited `team_memberships` INSERT per ancestor and a queued
   * `add_user_to_group` Sync_Operation for each ancestor that has a
   * primary channel with an Authentik group. No gap exists there, so no
   * additional test is added for this example.
   */

  it('removal also removes inherited rows: the DELETE has no inherited_from_team_id filter, so it removes both direct and inherited rows unconditionally', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT COUNT(*) as count FROM team_memberships')) {
        return Promise.resolve({ rows: [{ count: '1' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await TeamMembershipService.removeUserFromTeam(42, 9);

    const deleteCalls = mockClient.query.mock.calls.filter(([sql]) =>
      sql.trim().startsWith('DELETE FROM team_memberships')
    );
    expect(deleteCalls).toHaveLength(1);

    const [deleteSql, deleteParams] = deleteCalls[0];
    expect(deleteSql).not.toContain('inherited_from_team_id');
    expect(deleteSql).toContain('WHERE user_id = $1');
    expect(deleteParams).toEqual([42]);
  });

  it('"duplicate-add attempt": a second addUserToTeam call deletes the first call\'s row before inserting its own, so a repeated call is idempotent in row count (never additive)', async () => {
    // `TeamMembershipService.integration.test.js`'s Property 15 test
    // already proves the NET persisted-row-count effect of repeated add
    // calls against a real database (never more than one direct row
    // after consecutive adds). This test stays at the mocked-client
    // SQL-call-shape level -- asserting each call's own DELETE-then-
    // INSERT ordering -- to avoid pure duplication of that real-DB test.
    const firstClient = buildMockClient(() => Promise.resolve({ rows: [] }));
    const secondClient = buildMockClient(() => Promise.resolve({ rows: [] }));
    pool.connect.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await TeamMembershipService.addUserToTeam(7, 100, 'member', 9);
    await TeamMembershipService.addUserToTeam(7, 200, 'member', 9);

    const secondCallSqls = secondClient.query.mock.calls.map(([sql]) => sql);
    const deleteIndex = secondCallSqls.findIndex((sql) =>
      sql.trim().startsWith('DELETE FROM team_memberships')
    );
    const insertIndex = secondCallSqls.findIndex((sql) =>
      sql.includes('INSERT INTO team_memberships (user_id, team_id, role) VALUES')
    );
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(deleteIndex);

    const insertCalls = secondClient.query.mock.calls.filter(([sql]) =>
      sql.includes('INSERT INTO team_memberships (user_id, team_id, role) VALUES')
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1]).toEqual([7, 200, 'member']);
  });
});

describe('TeamMembershipService.removeUserFromTeam - externally-provided client (Requirement 17.5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the caller-provided client and does not call pool.connect, BEGIN, COMMIT, or release', async () => {
    const externalClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.authentik_group_id')) {
        return Promise.resolve({ rows: [{ authentik_group_id: 'grp-team' }] });
      }
      if (sql.includes('SELECT COUNT(*) as count FROM team_memberships')) {
        return Promise.resolve({ rows: [{ count: '1' }] }); // still has other teams
      }
      return Promise.resolve({ rows: [] });
    });
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    const result = await TeamMembershipService.removeUserFromTeam(1, 9, externalClient);

    expect(pool.connect).not.toHaveBeenCalled();
    expect(externalClient.query).not.toHaveBeenCalledWith('BEGIN');
    expect(externalClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(externalClient.release).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'remove_user_from_group',
      { target_user_id: 1, target_group_id: 'grp-team' },
      9,
      externalClient
    );
    expect(result).toEqual({ success: true, groupsQueued: 1 });
  });

  it('propagates a failure without issuing ROLLBACK or release, leaving transaction control to the caller (so a caller-level rollback also undoes the membership removal)', async () => {
    const externalClient = buildMockClient((sql) => {
      if (sql.includes('DELETE FROM team_memberships')) {
        return Promise.reject(new Error('membership delete failed'));
      }
      return Promise.resolve({ rows: [] });
    });
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await expect(
      TeamMembershipService.removeUserFromTeam(1, 9, externalClient)
    ).rejects.toThrow('membership delete failed');

    expect(externalClient.query).not.toHaveBeenCalledWith('BEGIN');
    expect(externalClient.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(externalClient.release).not.toHaveBeenCalled();
  });

  it('falls back to acquiring its own client (original behavior) when no external client is given', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT COUNT(*) as count FROM team_memberships')) {
        return Promise.resolve({ rows: [{ count: '1' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await TeamMembershipService.removeUserFromTeam(1, 9);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('TeamMembershipService.removeUserFromTeam', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes the open transactional client through to publishOperation for team-channel removal', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.authentik_group_id')) {
        return Promise.resolve({ rows: [{ authentik_group_id: 'grp-team' }] });
      }
      if (sql.includes('SELECT COUNT(*) as count FROM team_memberships')) {
        return Promise.resolve({ rows: [{ count: '1' }] }); // still has other teams
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await TeamMembershipService.removeUserFromTeam(1, 9);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'remove_user_from_group',
      { target_user_id: 1, target_group_id: 'grp-team' },
      9,
      mockClient
    );
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });

  it('passes the open transactional client through when also removing global-channel memberships (no teams left)', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT COUNT(*) as count FROM team_memberships')) {
        // NOTE: the implementation compares this strictly against the
        // number 0 (`=== 0`); mocking a numeric 0 here isolates the
        // "no teams left" branch under test rather than testing an
        // unrelated pg string-vs-number coercion quirk.
        return Promise.resolve({ rows: [{ count: 0 }] }); // no teams left
      }
      if (sql.includes('FROM bch_channels')) {
        return Promise.resolve({
          rows: [{ read_group_id: 'grp-read', write_group_id: 'grp-write' }]
        });
      }
      if (sql.includes('SELECT username FROM users WHERE id = $1')) {
        return Promise.resolve({ rows: [{ username: 'alice' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await TeamMembershipService.removeUserFromTeam(1, 9);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'remove_user_from_group',
      { target_user_id: 1, target_group_id: 'grp-read' },
      9,
      mockClient
    );
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'remove_user_from_group',
      { target_user_id: 1, target_group_id: 'grp-write' },
      9,
      mockClient
    );
  });

  it('enqueues a revoke_tak_certificates operation on the same client when the user has no teams left (Requirement 26.6)', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT COUNT(*) as count FROM team_memberships')) {
        return Promise.resolve({ rows: [{ count: 0 }] }); // no teams left
      }
      if (sql.includes('FROM bch_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT username FROM users WHERE id = $1')) {
        return Promise.resolve({ rows: [{ username: 'alice' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await TeamMembershipService.removeUserFromTeam(1, 9);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'revoke_tak_certificates',
      { target_user_id: 1, tak_usernames: ['alice'] },
      9,
      mockClient
    );
  });

  it('does not enqueue revoke_tak_certificates when the user still has other teams', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.authentik_group_id')) {
        return Promise.resolve({ rows: [{ authentik_group_id: 'grp-team' }] });
      }
      if (sql.includes('SELECT COUNT(*) as count FROM team_memberships')) {
        return Promise.resolve({ rows: [{ count: '1' }] }); // still has other teams
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await TeamMembershipService.removeUserFromTeam(1, 9);

    expect(EventPublisher.publishOperation).not.toHaveBeenCalledWith(
      'revoke_tak_certificates',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('does not enqueue revoke_tak_certificates when the user has no resolvable username', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT COUNT(*) as count FROM team_memberships')) {
        return Promise.resolve({ rows: [{ count: 0 }] });
      }
      if (sql.includes('FROM bch_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT username FROM users WHERE id = $1')) {
        return Promise.resolve({ rows: [] }); // user row not found
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await TeamMembershipService.removeUserFromTeam(1, 9);

    expect(EventPublisher.publishOperation).not.toHaveBeenCalledWith(
      'revoke_tak_certificates',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('rolls back the membership removal when the sync_operations insert (publishOperation) fails', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.authentik_group_id')) {
        return Promise.resolve({ rows: [{ authentik_group_id: 'grp-team' }] });
      }
      if (sql.includes('SELECT COUNT(*) as count FROM team_memberships')) {
        return Promise.resolve({ rows: [{ count: '1' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockRejectedValue(new Error('sync_operations insert failed'));

    await expect(TeamMembershipService.removeUserFromTeam(1, 9)).rejects.toThrow(
      'sync_operations insert failed'
    );

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('rolls back everything when the membership DELETE itself fails', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('DELETE FROM team_memberships')) {
        return Promise.reject(new Error('membership delete failed'));
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await expect(TeamMembershipService.removeUserFromTeam(1, 9)).rejects.toThrow(
      'membership delete failed'
    );

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
  });
});

/**
 * Unit tests for `TeamMembershipService.removeUserFromTeam`'s CloudTAK
 * membership enqueue site (Requirement 5.4 / 9.1 / 9.2 / 1.4, task
 * 8.3/8.4).
 *
 * Before deleting the user's `team_memberships` rows, the method captures
 * the Team ids where the user held a DIRECT admin row (`role = 'admin'
 * AND inherited_from_team_id IS NULL`). After deletion, and ONLY when
 * CloudTAK is enabled, it enqueues one `update_cloudtak_group` per such
 * Team id on the SAME transactional client so each affected group
 * re-reconciles without the removed user. When the flag is off, the
 * capture query never runs and no `update_cloudtak_group` is enqueued
 * (Requirement 1.4).
 *
 * `isCloudTakEnabled()` reads `process.env` at call time, so toggling
 * `process.env.CLOUDTAK_ENABLED` here is sufficient; it is saved and
 * restored around each test so no state leaks into other tests.
 */
describe('TeamMembershipService.removeUserFromTeam CloudTAK enqueue (Requirement 5.4 / 9.2 / 1.4)', () => {
  let savedFlag;

  beforeEach(() => {
    jest.clearAllMocks();
    savedFlag = process.env.CLOUDTAK_ENABLED;
  });

  afterEach(() => {
    if (savedFlag === undefined) {
      delete process.env.CLOUDTAK_ENABLED;
    } else {
      process.env.CLOUDTAK_ENABLED = savedFlag;
    }
  });

  it('enqueues one update_cloudtak_group per direct-admin Team on the same transactional client when the flag is on', async () => {
    process.env.CLOUDTAK_ENABLED = 'true';

    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      // The direct-admin capture query: user held direct admin on Teams 3 and 7.
      if (sql.includes("role = 'admin' AND inherited_from_team_id IS NULL")) {
        return Promise.resolve({ rows: [{ team_id: 3 }, { team_id: 7 }] });
      }
      if (sql.includes('SELECT COUNT(*) as count FROM team_memberships')) {
        return Promise.resolve({ rows: [{ count: '1' }] }); // still has other teams
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await TeamMembershipService.removeUserFromTeam(42, 9);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'update_cloudtak_group',
      { team_id: 3 },
      9,
      mockClient
    );
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'update_cloudtak_group',
      { team_id: 7 },
      9,
      mockClient
    );
    // Exactly one enqueue per captured direct-admin Team.
    const cloudtakCalls = EventPublisher.publishOperation.mock.calls.filter(
      ([op]) => op === 'update_cloudtak_group'
    );
    expect(cloudtakCalls).toHaveLength(2);
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });

  it('enqueues no update_cloudtak_group when the user held no direct-admin rows, even with the flag on', async () => {
    process.env.CLOUDTAK_ENABLED = 'true';

    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("role = 'admin' AND inherited_from_team_id IS NULL")) {
        return Promise.resolve({ rows: [] }); // no direct-admin rows
      }
      if (sql.includes('SELECT COUNT(*) as count FROM team_memberships')) {
        return Promise.resolve({ rows: [{ count: '1' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await TeamMembershipService.removeUserFromTeam(42, 9);

    expect(EventPublisher.publishOperation).not.toHaveBeenCalledWith(
      'update_cloudtak_group',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('enqueues NOTHING (and never runs the direct-admin capture query) when the flag is off (Requirement 1.4)', async () => {
    process.env.CLOUDTAK_ENABLED = 'false';

    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT COUNT(*) as count FROM team_memberships')) {
        return Promise.resolve({ rows: [{ count: '1' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    await TeamMembershipService.removeUserFromTeam(42, 9);

    expect(EventPublisher.publishOperation).not.toHaveBeenCalledWith(
      'update_cloudtak_group',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    // The direct-admin capture query is guarded by the flag and must not run.
    const capturedCapture = mockClient.query.mock.calls.some(([sql]) =>
      typeof sql === 'string' && sql.includes("role = 'admin' AND inherited_from_team_id IS NULL")
    );
    expect(capturedCapture).toBe(false);
  });
});
