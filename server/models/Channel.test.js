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

const pool = require('../config/database');
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
      return Promise.resolve({ rows: [{ id: 501, name: 'teams-alpha-radio', team_id: 7 }] });
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
