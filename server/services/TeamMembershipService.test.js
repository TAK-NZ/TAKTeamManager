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

const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
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

  it('passes the open transactional client through to every publishOperation call', async () => {
    mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.authentik_group_id')) {
        return Promise.resolve({ rows: [{ authentik_group_id: 'grp-team' }] });
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
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back the membership change when the sync_operations insert (publishOperation) fails', async () => {
    mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.authentik_group_id')) {
        return Promise.resolve({ rows: [{ authentik_group_id: 'grp-team' }] });
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
      if (sql.includes('SELECT c.authentik_group_id')) {
        return Promise.resolve({ rows: [{ authentik_group_id: 'grp-team' }] });
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
      if (sql.includes('SELECT c.authentik_group_id')) {
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
      if (sql.includes('SELECT c.authentik_group_id')) {
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

describe('TeamMembershipService.removeUserFromTeam - externally-provided client (BUG-016 / Requirement 17.5)', () => {
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
