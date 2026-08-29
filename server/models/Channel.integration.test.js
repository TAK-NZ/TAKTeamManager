/**
 * Real-Postgres integration test for Requirement 16.6 (task 35.7):
 *
 *   "WHEN concurrent channel-creation attempts against a team already at
 *   its limit are made, THE App SHALL allow exactly one to succeed and
 *   reject the rest with `Channel.ChannelLimitError`, verified by an
 *   automated integration test running real concurrent
 *   `Channel.createCustomChannel` calls against a real database."
 *
 * `server/models/Channel.test.js` mocks `pool.connect`/`pool.query`
 * entirely and only SIMULATES a "concurrent" second call by feeding it a
 * pre-scripted re-check SELECT result -- it never proves the real
 * `SERIALIZABLE` transaction (task 35.6) actually prevents a 4th channel
 * row from being inserted when multiple calls race against a REAL
 * Postgres connection pool. This file fills that gap and does NOT modify
 * or duplicate anything in `Channel.test.js`, mirroring the existing
 * separation convention between `syncWorker.test.js` /
 * `syncWorker.integration.test.js` and `health.test.js` /
 * `health.integration.test.js`.
 *
 * Connection convention: mirrors `server/workers/syncWorker.integration
 * .test.js` exactly -- `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/
 * `DB_PASSWORD` are read from the environment if already set, otherwise
 * defaulted to the local Docker-based test container
 * (`tak_migration_test_501`, Postgres 15, host port 15433, database
 * `tak_team_manager`, user `postgres`, password `postgres123`). These
 * are set on `process.env` BEFORE `../config/database` (required
 * transitively by `./Channel`) is first required anywhere in this
 * file's module graph, and restored in `afterAll`.
 *
 * Only `global.fetch` (the Authentik group-creation HTTP calls made by
 * `Channel.prepareCustomChannelCreation`) is mocked -- there is no real
 * Authentik instance in this test environment. `pool`/`pg` are
 * deliberately NOT mocked: the whole point of this test is to exercise
 * the real `SERIALIZABLE` transaction and real `information_schema`
 * constraints against a real, seeded `teams`/`channels` table.
 */

const ORIGINAL_ENV = {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
  AUTHENTIK_URL: process.env.AUTHENTIK_URL,
  AUTHENTIK_API_TOKEN: process.env.AUTHENTIK_API_TOKEN
};

process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '15433';
process.env.DB_NAME = process.env.DB_NAME || 'tak_team_manager';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres123';
process.env.AUTHENTIK_URL = process.env.AUTHENTIK_URL || 'https://authentik.example.com';
process.env.AUTHENTIK_API_TOKEN = process.env.AUTHENTIK_API_TOKEN || 'admin-token-value';

const pool = require('../config/database');
const Channel = require('./Channel');

const CHANNEL_LIMIT = 3;

/**
 * Mocks `global.fetch` (the 3 Authentik group-creation POSTs issued by
 * `prepareCustomChannelCreation` per `createCustomChannel` call) to
 * always succeed, returning a fresh, unique NUMERIC `pk` per call.
 *
 * Unlike `Channel.test.js`'s mocked-pool unit tests (which never touch a
 * real column and can get away with string pks like `'grp-rw'`), this
 * pk is persisted into the REAL `channels.authentik_group_id` /
 * `authentik_read_group_id` / `authentik_write_group_id` columns, which
 * are `INTEGER` in the real schema -- so it must be a real number, and
 * unique enough across the several concurrent calls in the test below to
 * avoid any incidental collision.
 */
function mockAuthentikGroupCreationSuccess() {
  let pk = 900000;
  global.fetch = jest.fn().mockImplementation(() => {
    pk += 1;
    return Promise.resolve({ ok: true, json: async () => ({ pk }) });
  });
}

describe('Channel.createCustomChannel concurrent creation against a real Postgres database (Requirement 16.6, task 35.7)', () => {
  let originalFetch;
  let teamId;

  beforeAll(async () => {
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `Real Postgres test database is not reachable at ` +
          `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} ` +
          `(user "${process.env.DB_USER}"). This integration test (task 35.7) requires ` +
          `a real, running, already-migrated Postgres instance -- it deliberately does not ` +
          `mock "pool"/"pg", since the whole point is to exercise the real SERIALIZABLE ` +
          `transaction from task 35.6. Underlying error: ${error.message}`,
        { cause: error }
      );
    }
  });

  afterAll(async () => {
    await pool.end();

    process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
    process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
    process.env.DB_NAME = ORIGINAL_ENV.DB_NAME;
    process.env.DB_USER = ORIGINAL_ENV.DB_USER;
    process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
    process.env.AUTHENTIK_URL = ORIGINAL_ENV.AUTHENTIK_URL;
    process.env.AUTHENTIK_API_TOKEN = ORIGINAL_ENV.AUTHENTIK_API_TOKEN;
  });

  beforeEach(async () => {
    originalFetch = global.fetch;
    mockAuthentikGroupCreationSuccess();

    const teamResult = await pool.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING id`,
      ['Channel Limit Test Team', 'CLTT']
    );
    teamId = teamResult.rows[0].id;

    // Seed the team to ONE BELOW its 3-channel limit, so that of the
    // concurrent creation attempts fired below, at most one more can
    // succeed before the limit (re-validated inside the real
    // SERIALIZABLE transaction, task 35.6) is reached.
    await pool.query(
      `INSERT INTO channels (name, display_name, team_id, channel_type, is_primary)
       VALUES ($1, $2, $3, 'custom', false), ($4, $5, $3, 'custom', false)`,
      ['seed-channel-one', 'Seed Channel One', teamId, 'seed-channel-two', 'Seed Channel Two']
    );
  });

  afterEach(async () => {
    global.fetch = originalFetch;

    // Leave no residue in the shared test database.
    await pool.query('DELETE FROM channel_memberships WHERE channel_id IN (SELECT id FROM channels WHERE team_id = $1)', [teamId]);
    await pool.query('DELETE FROM channels WHERE team_id = $1', [teamId]);
    await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
  });

  it('allows exactly one of several real concurrent createCustomChannel calls to succeed once the team is at its limit, rejecting the rest with ChannelLimitError, and never exceeds the limit in the database', async () => {
    const preCount = await Channel.getChannelCount(teamId);
    expect(preCount).toBe(CHANNEL_LIMIT - 1);

    // Fire 3 REAL concurrent createCustomChannel calls (distinct
    // suffixes, so any failure is attributable to the channel-limit
    // re-check and not an unrelated UNIQUE(name, team_id) collision).
    // Only one of these can bring the team from 2 to 3 channels; the
    // other two must observe the limit already reached once the
    // SERIALIZABLE transaction that got there first commits.
    const results = await Promise.allSettled([
      Channel.createCustomChannel(teamId, 'radio-one', []),
      Channel.createCustomChannel(teamId, 'radio-two', []),
      Channel.createCustomChannel(teamId, 'radio-three', [])
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(Channel.ChannelLimitError);
    }

    // The real database never exceeds the limit: exactly 3 channel rows
    // exist for this team once all concurrent attempts have settled.
    const postCount = await Channel.getChannelCount(teamId);
    expect(postCount).toBe(CHANNEL_LIMIT);

    // The one channel that did succeed is actually present, using the
    // suffix from the fulfilled call.
    const dbRows = await pool.query('SELECT custom_suffix FROM channels WHERE team_id = $1 ORDER BY id', [teamId]);
    expect(dbRows.rows).toHaveLength(CHANNEL_LIMIT);
    const customSuffixes = dbRows.rows.map((row) => row.custom_suffix).filter(Boolean);
    expect(customSuffixes).toHaveLength(1);
    expect(['radio-one', 'radio-two', 'radio-three']).toContain(customSuffixes[0]);
  });

  it('rejects a single createCustomChannel call outright when the team is already exactly at its limit', async () => {
    // Bring the team to exactly the limit first (sequential, not
    // concurrent), then attempt one more real call.
    await Channel.createCustomChannel(teamId, 'radio-filler', []);
    expect(await Channel.getChannelCount(teamId)).toBe(CHANNEL_LIMIT);

    await expect(Channel.createCustomChannel(teamId, 'radio-overflow', [])).rejects.toBeInstanceOf(
      Channel.ChannelLimitError
    );

    expect(await Channel.getChannelCount(teamId)).toBe(CHANNEL_LIMIT);
  });
});
