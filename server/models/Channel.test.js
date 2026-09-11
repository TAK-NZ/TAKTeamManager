/**
 * Unit tests for `Channel.createCustomChannel` (Requirement 16.6, task
 * 35.6): the 3-channel-per-team limit must be re-validated inside a
 * `SERIALIZABLE` transaction immediately before the `channels` INSERT,
 * using the same client for the re-check SELECT and the INSERT, and this
 * mechanism must be used uniformly for every call -- not only when a race
 * actually occurs.
 *
 * These tests mock `pool.connect`/`pool.query` and `global.fetch` (the
 * Authentik group-creation calls), and verify:
 *  - Phase 1 (team lookup + Authentik group creation) happens BEFORE
 *    `pool.connect()` is called (no open transaction during external HTTP
 *    calls, mirroring `UserProvisioningService`'s established pattern).
 *  - Phase 2 issues `BEGIN ISOLATION LEVEL SERIALIZABLE`, the count
 *    re-check `SELECT`, and the `channels` `INSERT` all on the SAME
 *    acquired client, followed by `COMMIT`.
 *  - A "concurrent" second call (mocked, not a real DB race) whose
 *    re-check SELECT sees the limit already reached is rejected with
 *    `Channel.ChannelLimitError`, and its transaction is rolled back
 *    without inserting a channel row.
 *  - A Postgres `serialization_failure` (SQLSTATE 40001) surfaced at
 *    COMMIT time is also treated as a `ChannelLimitError`.
 */

jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

// Bugfix (silent Authentik sync gap): `insertCustomChannelAndMembers`'s
// member loop, and the new `removeMember`/`deleteCustomChannel` methods,
// enqueue Sync_Operations via `EventPublisher.publishOperation` -- mocked
// here so no real `sync_operations` INSERT is attempted.
jest.mock('../services/EventPublisher', () => ({
  publishOperation: jest.fn()
}));

const pool = require('../config/database');
const EventPublisher = require('../services/EventPublisher');
const Channel = require('./Channel');

const TEAM_ROW = {
  id: 7,
  name: 'Alpha',
  parent_team_id: null,
  root_prefix: 'ALPHA'
};

function mockAuthentikGroupCreationSuccess() {
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ pk: 'grp-rw' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ pk: 'grp-read' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ pk: 'grp-write' }) });
}

/**
 * Builds a mock transactional client whose count re-check SELECT returns
 * `existingCount`, and whose `channels` INSERT (if reached) returns a
 * fabricated channel row.
 */
function buildMockClient(existingCount) {
  const client = {
    query: jest.fn(),
    release: jest.fn()
  };

  client.query.mockImplementation((sql) => {
    if (typeof sql === 'string' && sql.includes('SELECT COUNT(*) as count FROM channels WHERE team_id')) {
      return Promise.resolve({ rows: [{ count: String(existingCount) }] });
    }
    if (typeof sql === 'string' && sql.startsWith('INSERT INTO channels')) {
      // Bugfix (silent Authentik sync gap): the fabricated channel row
      // now carries the same three group ids `prepareCustomChannelCreation`
      // resolves in these tests (grp-rw/grp-read/grp-write), so
      // `resolveGroupIdForPermission` -- and therefore the
      // `add_user_to_group` enqueue -- has real values to resolve
      // against, matching what the real INSERT (which selects these
      // same values straight through) actually returns.
      return Promise.resolve({
        rows: [{
          id: 501,
          name: 'teams-alpha-radio',
          team_id: 7,
          authentik_group_id: 'grp-rw',
          authentik_read_group_id: 'grp-read',
          authentik_write_group_id: 'grp-write'
        }]
      });
    }
    // BEGIN / COMMIT / ROLLBACK / channel_memberships INSERT all just
    // need to resolve.
    return Promise.resolve({ rows: [] });
  });

  return client;
}

describe('Channel.createCustomChannel', () => {
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE root_team')) {
        return Promise.resolve({ rows: [TEAM_ROW] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('creates the Authentik groups (Phase 1) before acquiring any database client (Phase 2)', async () => {
    mockAuthentikGroupCreationSuccess();
    const client = buildMockClient(0);
    pool.connect.mockImplementation(() => {
      // By the time pool.connect() is invoked, all 3 Authentik group
      // creation calls must already have resolved.
      expect(global.fetch).toHaveBeenCalledTimes(3);
      return Promise.resolve(client);
    });

    const channel = await Channel.createCustomChannel(7, 'Radio', [
      { userId: 1, permission: 'read_write' }
    ]);

    expect(channel.id).toBe(501);
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  // Bugfix (Create Custom Channel dialog had no way to set a description
  // at creation time -- only via the later "Edit channel" action): a
  // supplied description is used verbatim, in the local INSERT and in
  // ALL THREE Authentik groups' attributes.description (with the
  // Read/Write-Only suffixes still appended, matching the generated-
  // default behaviour exactly).
  describe('with a custom description supplied', () => {
    it('uses the supplied description for the local INSERT and every Authentik group, instead of the generated default', async () => {
      mockAuthentikGroupCreationSuccess();
      const client = buildMockClient(0);
      pool.connect.mockResolvedValue(client);

      await Channel.createCustomChannel(7, 'Radio', [], 'Ops channel for Alpha team');

      const groupCreateBodies = global.fetch.mock.calls.map(([, options]) => JSON.parse(options.body));
      expect(groupCreateBodies[0].attributes.description).toBe('Ops channel for Alpha team');
      expect(groupCreateBodies[1].attributes.description).toBe('Ops channel for Alpha team - Read Only');
      expect(groupCreateBodies[2].attributes.description).toBe('Ops channel for Alpha team - Write Only');

      const insertCall = client.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.startsWith('INSERT INTO channels'));
      expect(insertCall[1]).toContain('Ops channel for Alpha team');
    });

    it('falls back to the generated default description when omitted (preserves existing behaviour)', async () => {
      mockAuthentikGroupCreationSuccess();
      const client = buildMockClient(0);
      pool.connect.mockResolvedValue(client);

      await Channel.createCustomChannel(7, 'Radio', []);

      const [, options] = global.fetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.attributes.description).toContain('Custom channel:');
    });

    it('falls back to the generated default description when an empty string is supplied', async () => {
      mockAuthentikGroupCreationSuccess();
      const client = buildMockClient(0);
      pool.connect.mockResolvedValue(client);

      await Channel.createCustomChannel(7, 'Radio', [], '');

      const [, options] = global.fetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.attributes.description).toContain('Custom channel:');
    });
  });

  it('runs BEGIN ISOLATION LEVEL SERIALIZABLE, the count re-check SELECT, and the channels INSERT on the same client, then COMMITs', async () => {
    mockAuthentikGroupCreationSuccess();
    const client = buildMockClient(2); // 2 existing channels -> still under the limit of 3
    pool.connect.mockResolvedValue(client);

    await Channel.createCustomChannel(7, 'Radio', []);

    const sqlCalls = client.query.mock.calls.map(([sql]) => sql);

    expect(sqlCalls[0]).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const selectIndex = sqlCalls.findIndex((sql) =>
      typeof sql === 'string' && sql.includes('SELECT COUNT(*) as count FROM channels WHERE team_id')
    );
    const insertIndex = sqlCalls.findIndex((sql) =>
      typeof sql === 'string' && sql.startsWith('INSERT INTO channels')
    );

    expect(selectIndex).toBeGreaterThan(0);
    expect(insertIndex).toBeGreaterThan(selectIndex);
    expect(sqlCalls).toContain('COMMIT');
    expect(sqlCalls).not.toContain('ROLLBACK');

    // Exactly one client was acquired and released for the whole
    // re-check + insert + member-add sequence.
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('adds members using the same transactional client as the count re-check and insert', async () => {
    mockAuthentikGroupCreationSuccess();
    const client = buildMockClient(0);
    pool.connect.mockResolvedValue(client);

    await Channel.createCustomChannel(7, 'Radio', [
      { userId: 42, permission: 'read' }
    ]);

    const memberInsertCall = client.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO channel_memberships')
    );
    expect(memberInsertCall).toBeDefined();
    // Called against `client.query`, not `pool.query` -- i.e. on the same
    // open transaction as the count re-check and the channel insert.
    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO channel_memberships'),
      expect.anything()
    );
  });

  it('rejects when the re-check sees the team already at the 3-channel limit, rolling back without inserting a channel row', async () => {
    mockAuthentikGroupCreationSuccess();
    const client = buildMockClient(3); // already at the limit
    pool.connect.mockResolvedValue(client);

    await expect(Channel.createCustomChannel(7, 'Radio', [])).rejects.toThrow(Channel.ChannelLimitError);

    const sqlCalls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls.some((sql) => typeof sql === 'string' && sql.startsWith('INSERT INTO channels'))).toBe(false);
    expect(sqlCalls).toContain('ROLLBACK');
    expect(sqlCalls).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('simulates two "concurrent" calls where the second call\'s re-check sees the limit already reached and is rejected', async () => {
    // First "concurrent" call: re-check sees 2 existing channels (under
    // the limit), succeeds and would bring the team to 3.
    mockAuthentikGroupCreationSuccess();
    const firstClient = buildMockClient(2);
    pool.connect.mockResolvedValueOnce(firstClient);

    const firstChannel = await Channel.createCustomChannel(7, 'Radio', []);
    expect(firstChannel.id).toBe(501);
    expect(firstClient.query.mock.calls.map(([sql]) => sql)).toContain('COMMIT');

    // Second "concurrent" call: its re-check (mocked, not a real DB race)
    // now sees 3 existing channels -- i.e. it observes the first call's
    // effect -- and must be rejected without inserting a 4th channel row.
    mockAuthentikGroupCreationSuccess();
    const secondClient = buildMockClient(3);
    pool.connect.mockResolvedValueOnce(secondClient);

    await expect(Channel.createCustomChannel(7, 'Radio2', [])).rejects.toThrow(Channel.ChannelLimitError);

    const secondSqlCalls = secondClient.query.mock.calls.map(([sql]) => sql);
    expect(secondSqlCalls.some((sql) => typeof sql === 'string' && sql.startsWith('INSERT INTO channels'))).toBe(false);
    expect(secondSqlCalls).toContain('ROLLBACK');
  });

  it('treats a Postgres serialization_failure (SQLSTATE 40001) surfaced at COMMIT as a ChannelLimitError', async () => {
    mockAuthentikGroupCreationSuccess();
    const client = buildMockClient(0);
    // Override COMMIT to reject with a serialization_failure, simulating
    // a real conflict detected only at commit time under SERIALIZABLE
    // isolation.
    client.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT COUNT(*) as count FROM channels WHERE team_id')) {
        return Promise.resolve({ rows: [{ count: '0' }] });
      }
      if (typeof sql === 'string' && sql.startsWith('INSERT INTO channels')) {
        return Promise.resolve({ rows: [{ id: 501, name: 'teams-alpha-radio', team_id: 7 }] });
      }
      if (sql === 'COMMIT') {
        const err = new Error('could not serialize access due to concurrent update');
        err.code = '40001';
        return Promise.reject(err);
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(client);

    await expect(Channel.createCustomChannel(7, 'Radio', [])).rejects.toThrow(Channel.ChannelLimitError);
    expect(client.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
  });

  it('rejects before acquiring any database client if the team is not found (Phase 1 failure)', async () => {
    pool.query.mockResolvedValue({ rows: [] }); // no team found
    await expect(Channel.createCustomChannel(999, 'Radio', [])).rejects.toThrow('Team not found');
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

/**
 * Bugfix (silent Authentik sync gap): `Channel.addMember` alone never
 * enqueued an `add_user_to_group` Sync_Operation, so a member added to a
 * custom channel at creation time never actually appeared in the
 * channel's Authentik group. `insertCustomChannelAndMembers`'s member
 * loop now enqueues `add_user_to_group` (on the same transactional
 * client) alongside each `addMember` call, resolving the target group
 * id via `resolveGroupIdForPermission`.
 */
describe('Channel.resolveGroupIdForPermission', () => {
  const channel = {
    authentik_group_id: 'grp-rw',
    authentik_read_group_id: 'grp-read',
    authentik_write_group_id: 'grp-write'
  };

  it('maps read_write to authentik_group_id (the "main" RW group)', () => {
    expect(Channel.resolveGroupIdForPermission(channel, 'read_write')).toBe('grp-rw');
  });

  it('maps read to authentik_read_group_id', () => {
    expect(Channel.resolveGroupIdForPermission(channel, 'read')).toBe('grp-read');
  });

  it('maps write to authentik_write_group_id', () => {
    expect(Channel.resolveGroupIdForPermission(channel, 'write')).toBe('grp-write');
  });

  it('returns null for an unrecognized permission value', () => {
    expect(Channel.resolveGroupIdForPermission(channel, 'admin')).toBeNull();
  });

  it('returns null when the channel has no group of the resolved kind', () => {
    expect(Channel.resolveGroupIdForPermission({ authentik_group_id: null }, 'read_write')).toBeNull();
  });
});

describe('Channel.createCustomChannel: add_user_to_group enqueue (bugfix: silent Authentik sync gap)', () => {
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE root_team')) {
        return Promise.resolve({ rows: [TEAM_ROW] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('enqueues add_user_to_group on the transactional client for each member, targeting the group matching their permission', async () => {
    mockAuthentikGroupCreationSuccess();
    const client = buildMockClient(0);
    pool.connect.mockResolvedValue(client);

    await Channel.createCustomChannel(7, 'Radio', [
      { userId: 42, permission: 'read' },
      { userId: 43, permission: 'write' },
      { userId: 44, permission: 'read_write' }
    ]);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'add_user_to_group',
      { target_user_id: 42, target_group_id: 'grp-read' },
      null,
      client
    );
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'add_user_to_group',
      { target_user_id: 43, target_group_id: 'grp-write' },
      null,
      client
    );
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'add_user_to_group',
      { target_user_id: 44, target_group_id: 'grp-rw' },
      null,
      client
    );
    // 3 add_user_to_group + 1 update_channel_group (CloudTAK attributes for
    // the main group, enqueued once per creation on the same client).
    const addCalls = EventPublisher.publishOperation.mock.calls.filter(([op]) => op === 'add_user_to_group');
    expect(addCalls).toHaveLength(3);
    const updateCalls = EventPublisher.publishOperation.mock.calls.filter(([op]) => op === 'update_channel_group');
    expect(updateCalls).toHaveLength(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(4);
  });

  it('enqueues update_channel_group (CloudTAK attributes) with just { channel_id } on the transactional client, once per creation', async () => {
    mockAuthentikGroupCreationSuccess();
    const client = buildMockClient(0);
    pool.connect.mockResolvedValue(client);

    await Channel.createCustomChannel(7, 'Radio', [{ userId: 42, permission: 'read' }]);

    const updateCalls = EventPublisher.publishOperation.mock.calls.filter(([op]) => op === 'update_channel_group');
    expect(updateCalls).toHaveLength(1);
    const [, payload, createdBy, passedClient] = updateCalls[0];
    expect(payload).toEqual({ channel_id: expect.any(Number) });
    expect(createdBy).toBeNull();
    expect(passedClient).toBe(client);
  });

  it('adds the channel_memberships row via addMember AND enqueues add_user_to_group for the SAME member -- neither happens without the other', async () => {
    mockAuthentikGroupCreationSuccess();
    const client = buildMockClient(0);
    pool.connect.mockResolvedValue(client);

    await Channel.createCustomChannel(7, 'Radio', [{ userId: 42, permission: 'read' }]);

    const memberInsertCall = client.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO channel_memberships')
    );
    expect(memberInsertCall).toBeDefined();
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'add_user_to_group',
      expect.objectContaining({ target_user_id: 42 }),
      null,
      client
    );
  });

  it('skips the enqueue (without failing the whole creation) when no matching group id can be resolved', async () => {
    mockAuthentikGroupCreationSuccess();
    const client = buildMockClient(0);
    // Override the channels INSERT to return a channel with NO group ids
    // at all -- resolveGroupIdForPermission returns null for every
    // permission, so the enqueue must be skipped rather than sending an
    // invalid target_group_id.
    client.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT COUNT(*) as count FROM channels WHERE team_id')) {
        return Promise.resolve({ rows: [{ count: '0' }] });
      }
      if (typeof sql === 'string' && sql.startsWith('INSERT INTO channels')) {
        return Promise.resolve({ rows: [{ id: 501, team_id: 7 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(client);

    const channel = await Channel.createCustomChannel(7, 'Radio', [{ userId: 42, permission: 'read' }]);

    expect(channel.id).toBe(501);
    // No add_user_to_group (no resolvable group id), but the
    // update_channel_group CloudTAK-attributes enqueue still happens once.
    const addCalls = EventPublisher.publishOperation.mock.calls.filter(([op]) => op === 'add_user_to_group');
    expect(addCalls).toHaveLength(0);
    const updateCalls = EventPublisher.publishOperation.mock.calls.filter(([op]) => op === 'update_channel_group');
    expect(updateCalls).toHaveLength(1);
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 501, userId: 42, permission: 'read' }),
      expect.stringContaining('Skipped add_user_to_group enqueue')
    );
  });
});

describe('Channel.removeMember (bugfix: Channels tab had no manage-members action)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes the channel_memberships row and enqueues remove_user_from_group targeting the group matching the REMOVED permission', async () => {
    const client = {
      query: jest.fn()
    };
    client.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT authentik_group_id')) {
        return Promise.resolve({
          rows: [{ authentik_group_id: 'grp-rw', authentik_read_group_id: 'grp-read', authentik_write_group_id: 'grp-write' }]
        });
      }
      if (typeof sql === 'string' && sql.startsWith('DELETE FROM channel_memberships')) {
        return Promise.resolve({ rows: [{ permission: 'write' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const removed = await Channel.removeMember(10, 42, client);

    expect(removed).toBe(true);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'remove_user_from_group',
      { target_user_id: 42, target_group_id: 'grp-write' },
      null,
      client
    );
  });

  it('returns false and enqueues nothing when no matching membership row exists', async () => {
    const client = {
      query: jest.fn().mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT authentik_group_id')) {
          return Promise.resolve({ rows: [{ authentik_group_id: 'grp-rw' }] });
        }
        if (typeof sql === 'string' && sql.startsWith('DELETE FROM channel_memberships')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      })
    };

    const removed = await Channel.removeMember(10, 999, client);

    expect(removed).toBe(false);
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('falls back to the shared pool when no client is supplied', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT authentik_group_id')) {
        return Promise.resolve({ rows: [{ authentik_group_id: 'grp-rw' }] });
      }
      if (typeof sql === 'string' && sql.startsWith('DELETE FROM channel_memberships')) {
        return Promise.resolve({ rows: [{ permission: 'read_write' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const removed = await Channel.removeMember(10, 42);

    expect(removed).toBe(true);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'remove_user_from_group',
      { target_user_id: 42, target_group_id: 'grp-rw' },
      null,
      null
    );
  });
});

describe('Channel.deleteCustomChannel (bugfix: Channels tab had no delete-channel action)', () => {
  function buildDeleteMockClient(channelRow) {
    const client = { query: jest.fn(), release: jest.fn() };
    client.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.startsWith('SELECT * FROM channels WHERE id')) {
        return Promise.resolve({ rows: channelRow ? [channelRow] : [] });
      }
      return Promise.resolve({ rows: [] });
    });
    return client;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes channel_memberships then the channels row, enqueues remove_team_channel_group with only the non-null group ids, then commits', async () => {
    const channelRow = {
      id: 10,
      team_id: 7,
      is_primary: false,
      authentik_group_id: 'grp-rw',
      authentik_read_group_id: 'grp-read',
      authentik_write_group_id: null
    };
    const client = buildDeleteMockClient(channelRow);
    pool.connect.mockResolvedValue(client);

    const deleted = await Channel.deleteCustomChannel(10, 9);

    expect(deleted).toEqual(channelRow);
    const sqlCalls = client.query.mock.calls.map(([sql]) => sql);
    const membershipDeleteIndex = sqlCalls.findIndex((sql) => typeof sql === 'string' && sql.startsWith('DELETE FROM channel_memberships'));
    const channelDeleteIndex = sqlCalls.findIndex((sql) => typeof sql === 'string' && sql === 'DELETE FROM channels WHERE id = $1');
    expect(membershipDeleteIndex).toBeGreaterThan(-1);
    expect(channelDeleteIndex).toBeGreaterThan(membershipDeleteIndex);
    expect(sqlCalls).toContain('COMMIT');

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'remove_team_channel_group',
      { channel_id: 10, authentik_group_id: 'grp-rw', authentik_read_group_id: 'grp-read' },
      9,
      client
    );
  });

  it('returns null and rolls back without deleting anything when the channel is a PRIMARY channel', async () => {
    // The lookup query itself filters `is_primary = false`, so a primary
    // channel's row never comes back at all.
    const client = buildDeleteMockClient(null);
    pool.connect.mockResolvedValue(client);

    const deleted = await Channel.deleteCustomChannel(11, 9);

    expect(deleted).toBeNull();
    const sqlCalls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls).toContain('ROLLBACK');
    expect(sqlCalls.some((sql) => typeof sql === 'string' && sql.startsWith('DELETE FROM channels'))).toBe(false);
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('returns null when no channel with this id exists at all', async () => {
    const client = buildDeleteMockClient(null);
    pool.connect.mockResolvedValue(client);

    const deleted = await Channel.deleteCustomChannel(999, 9);

    expect(deleted).toBeNull();
  });

  it('rolls back and rethrows when a delete step fails', async () => {
    const channelRow = { id: 10, team_id: 7, is_primary: false, authentik_group_id: 'grp-rw' };
    const client = { query: jest.fn(), release: jest.fn() };
    client.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.startsWith('SELECT * FROM channels WHERE id')) {
        return Promise.resolve({ rows: [channelRow] });
      }
      if (typeof sql === 'string' && sql.startsWith('DELETE FROM channel_memberships')) {
        return Promise.reject(new Error('membership delete failed'));
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(client);

    await expect(Channel.deleteCustomChannel(10, 9)).rejects.toThrow('membership delete failed');

    const sqlCalls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls).toContain('ROLLBACK');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

// Bugfix (Channels tab has no edit action, and no way to add/edit a
// custom channel's Authentik/LDAP description).
describe('Channel.updateCustomChannel (bugfix: no edit action / no way to set a custom channel description)', () => {
  function buildUpdateMockClient(existingRow, updatedRow) {
    const client = { query: jest.fn(), release: jest.fn() };
    client.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.startsWith('SELECT * FROM channels WHERE id')) {
        return Promise.resolve({ rows: existingRow ? [existingRow] : [] });
      }
      if (typeof sql === 'string' && sql.startsWith('UPDATE channels SET description')) {
        return Promise.resolve({ rows: updatedRow ? [updatedRow] : [] });
      }
      return Promise.resolve({ rows: [] });
    });
    return client;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates description, enqueues update_channel_group with every non-null group id, then commits', async () => {
    const existingRow = {
      id: 10,
      team_id: 7,
      is_primary: false,
      description: 'Old description',
      authentik_group_id: 'grp-rw',
      authentik_read_group_id: 'grp-read',
      authentik_write_group_id: null
    };
    const updatedRow = { ...existingRow, description: 'New description' };
    const client = buildUpdateMockClient(existingRow, updatedRow);
    pool.connect.mockResolvedValue(client);

    const updated = await Channel.updateCustomChannel(10, { description: 'New description' }, 9);

    expect(updated).toEqual(updatedRow);
    const sqlCalls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls).toContain('COMMIT');

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'update_channel_group',
      {
        channel_id: 10,
        description: 'New description',
        authentik_group_id: 'grp-rw',
        authentik_read_group_id: 'grp-read'
      },
      9,
      client
    );
  });

  it('normalizes a falsy description to an empty string, both in the UPDATE and the enqueued payload', async () => {
    const existingRow = { id: 10, team_id: 7, is_primary: false, authentik_group_id: 'grp-rw' };
    const updatedRow = { ...existingRow, description: '' };
    const client = buildUpdateMockClient(existingRow, updatedRow);
    pool.connect.mockResolvedValue(client);

    await Channel.updateCustomChannel(10, { description: null }, 9);

    const updateCall = client.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.startsWith('UPDATE channels SET description')
    );
    expect(updateCall[1]).toEqual(['', 10]);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'update_channel_group',
      expect.objectContaining({ description: '' }),
      9,
      client
    );
  });

  it('returns null and rolls back without updating anything when the channel is a PRIMARY channel', async () => {
    const client = buildUpdateMockClient(null, null);
    pool.connect.mockResolvedValue(client);

    const updated = await Channel.updateCustomChannel(11, { description: 'x' }, 9);

    expect(updated).toBeNull();
    const sqlCalls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls).toContain('ROLLBACK');
    expect(sqlCalls.some((sql) => typeof sql === 'string' && sql.startsWith('UPDATE channels'))).toBe(false);
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('returns null when no channel with this id exists at all', async () => {
    const client = buildUpdateMockClient(null, null);
    pool.connect.mockResolvedValue(client);

    const updated = await Channel.updateCustomChannel(999, { description: 'x' }, 9);

    expect(updated).toBeNull();
  });

  it('rolls back and rethrows when the UPDATE fails', async () => {
    const existingRow = { id: 10, team_id: 7, is_primary: false, authentik_group_id: 'grp-rw' };
    const client = { query: jest.fn(), release: jest.fn() };
    client.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.startsWith('SELECT * FROM channels WHERE id')) {
        return Promise.resolve({ rows: [existingRow] });
      }
      if (typeof sql === 'string' && sql.startsWith('UPDATE channels SET description')) {
        return Promise.reject(new Error('update failed'));
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(client);

    await expect(Channel.updateCustomChannel(10, { description: 'x' }, 9)).rejects.toThrow('update failed');

    const sqlCalls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls).toContain('ROLLBACK');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
