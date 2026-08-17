/**
 * Real-Postgres property-based test for design.md's Property 15 (task
 * 36.5):
 *
 *   "Property 15: Team membership add/remove is a round trip
 *
 *   For any team hierarchy and user, adding the user to a leaf team and
 *   then immediately removing them leaves that user's `team_memberships`
 *   and `channel_memberships` rows empty, matching the state before the
 *   add.
 *
 *   Validates: Requirements 12.2, 17.5"
 *
 * `server/services/TeamMembershipService.test.js` already covers
 * Requirement 17.5's transactional-client-passthrough behavior with a
 * fully mocked `pool`/`client` (asserting `EventPublisher.publishOperation`
 * is called with the same client used for the membership writes, and that
 * a failure in either rolls back the other). It does NOT exercise the
 * round-trip PROPERTY itself: it never runs a real sequence of
 * `addUserToTeam`/`removeUserFromTeam` calls and inspects the net,
 * persisted `team_memberships` state that results.
 *
 * DB-vs-mock decision (documented per the task's instructions): this test
 * uses a REAL Postgres database rather than a mocked client/pool. The
 * property under test is about the NET EFFECT of a *sequence* of
 * `addUserToTeam`/`removeUserFromTeam` calls on real, persisted
 * `team_memberships` rows -- in particular, that `addUserToTeam`'s
 * "DELETE any existing direct row, then INSERT the new one" behavior
 * never leaves two direct rows for the same user, and that a
 * `removeUserFromTeam` call truly leaves zero rows behind. A mocked
 * client can only assert on the exact SQL statements issued per call; it
 * cannot prove the real `idx_team_memberships_one_direct_per_user`
 * partial-unique-index-backed table actually ends up in the state those
 * statements imply once several calls are chained together against a
 * real connection pool. Following the existing separation convention in
 * this codebase (`syncWorker.test.js` / `syncWorker.integration.test.js`,
 * `Channel.test.js` / `Channel.integration.test.js`,
 * `health.test.js` / `health.integration.test.js`), this real-DB test
 * lives in its own `*.integration.test.js` file rather than being added
 * to the existing mocked `TeamMembershipService.test.js`.
 *
 * `EventPublisher.publishOperation` is mocked (module-level `jest.mock`)
 * exactly as it already is in `TeamMembershipService.test.js` -- there is
 * no real Authentik/sync-worker involved in this property, and mocking it
 * here avoids needing to satisfy `sync_operations.created_by`'s FK
 * against a real `users` row for every queued operation type
 * (`add_user_to_group`, `assign_user_to_global_channels`,
 * `remove_user_from_group`, `revoke_tak_certificates`), none of which
 * this property cares about.
 *
 * Connection convention: mirrors `server/workers/syncWorker.integration
 * .test.js` and `server/models/Channel.integration.test.js` exactly --
 * `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` are read from the
 * environment if already set, otherwise defaulted to the local
 * Docker-based test container (`tak_migration_test_501`, Postgres 15,
 * host port 15433, database `tak_team_manager`, user `postgres`,
 * password `postgres123`). These are set on `process.env` BEFORE
 * `../config/database` (required transitively by
 * `./TeamMembershipService`) is first required anywhere in this file's
 * module graph, and restored in `afterAll`.
 */

const ORIGINAL_ENV = {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD
};

process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '15433';
process.env.DB_NAME = process.env.DB_NAME || 'tak_team_manager';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres123';

jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn().mockResolvedValue('op-id')
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const crypto = require('crypto');

const pool = require('../config/database');
const TeamMembershipService = require('./TeamMembershipService');

describe('Property 15: Team membership add/remove is a round trip (Requirements 12.2, 17.5), against a real Postgres database', () => {
  let teamAId;
  let teamBId;
  const createdUserIds = [];

  beforeAll(async () => {
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `Real Postgres test database is not reachable at ` +
          `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} ` +
          `(user "${process.env.DB_USER}"). This property test (task 36.5, design.md's ` +
          `Property 15) deliberately runs against a real, already-migrated Postgres ` +
          `instance rather than a mocked pool/client, since it verifies the net effect ` +
          `of a sequence of addUserToTeam/removeUserFromTeam calls on real, persisted ` +
          `team_memberships rows. Underlying error: ${error.message}`,
        { cause: error }
      );
    }

    // Seed 2 real, top-level teams (no parent hierarchy needed for this
    // property -- it exercises the direct-membership round trip, not
    // parent-team inheritance, which is already covered separately by
    // Requirement 12.2's example tests in TeamMembershipService.test.js).
    const teamA = await pool.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING id`,
      ['Property15 Team A', 'P15A']
    );
    teamAId = teamA.rows[0].id;

    const teamB = await pool.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING id`,
      ['Property15 Team B', 'P15B']
    );
    teamBId = teamB.rows[0].id;
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await pool.query('DELETE FROM team_memberships WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM channel_memberships WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    }
    await pool.query('DELETE FROM teams WHERE id = ANY($1)', [[teamAId, teamBId]]);
    // Note: pool.end() and env-var restoration are deferred to this
    // file's single top-level afterAll (below both describe blocks), not
    // done here -- the second describe block (channel_memberships
    // regression test) still needs a live pool after this block's tests
    // finish.
  });

  /**
   * Generates a random sequence of 1-5 operations against a single,
   * freshly-created user: each element is either an "add" (targeting one
   * of the 2 seeded teams, with a random role) or a "remove". This
   * covers both concrete cases called for by the task:
   *   - an "add" immediately followed by a "remove" (true round trip back
   *     to the no-membership starting state), and
   *   - two consecutive "add"s to different teams (the delete-current-
   *     then-insert-new behavior must leave exactly one row -- the
   *     second -- never two),
   * as well as longer arbitrary sequences mixing both.
   */
  const roleArb = fc.constantFrom('member', 'admin');
  const teamIndexArb = fc.constantFrom(0, 1);
  const addOpArb = fc.record({ type: fc.constant('add'), teamIndex: teamIndexArb, role: roleArb });
  const removeOpArb = fc.record({ type: fc.constant('remove') });
  const opArb = fc.oneof(addOpArb, removeOpArb);
  const sequenceArb = fc.array(opArb, { minLength: 1, maxLength: 5 });

  // Feature: production-hardening, Property 15: Team membership add/remove is a round trip
  test.prop([sequenceArb], { numRuns: 100 })(
    'after any sequence of add/remove operations, team_memberships holds exactly what the last operation established (a true empty round trip after add-then-remove, and never more than one direct row after consecutive adds)',
    async (sequence) => {
      const username = `p15-${crypto.randomUUID()}`;
      const userResult = await pool.query(
        `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id`,
        [username, `${username}@example.invalid`]
      );
      const userId = userResult.rows[0].id;
      createdUserIds.push(userId);

      try {
        // Independently-tracked reference model of "what the last
        // operation established" -- re-derived directly from the
        // property's own wording, without reusing
        // TeamMembershipService's internals, so a bug in the real
        // implementation cannot also be baked into the oracle meant to
        // catch it.
        let expected = null; // null = no membership; else { teamId, role }

        for (const op of sequence) {
          if (op.type === 'add') {
            const teamId = op.teamIndex === 0 ? teamAId : teamBId;
            await TeamMembershipService.addUserToTeam(userId, teamId, op.role, userId);
            expected = { teamId, role: op.role };
          } else {
            await TeamMembershipService.removeUserFromTeam(userId, userId);
            expected = null;
          }
        }

        const directRows = await pool.query(
          `SELECT team_id, role FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL`,
          [userId]
        );
        const channelRows = await pool.query(
          `SELECT id FROM channel_memberships WHERE user_id = $1`,
          [userId]
        );

        if (expected === null) {
          // True round trip: no team_memberships row and no
          // channel_memberships row remain -- matching the pre-add
          // starting state.
          expect(directRows.rows).toHaveLength(0);
          expect(channelRows.rows).toHaveLength(0);
        } else {
          // Never more than one direct row, and it reflects exactly the
          // last "add" -- never a stale row from an earlier add.
          expect(directRows.rows).toHaveLength(1);
          expect(directRows.rows[0].team_id).toBe(expected.teamId);
          expect(directRows.rows[0].role).toBe(expected.role);
        }
      } finally {
        // Isolate each fast-check run from the next: leave no residue
        // for the next randomly-generated sequence to accidentally
        // interact with (a fresh user is created per run above, but
        // its rows are cleaned up here rather than deferred entirely to
        // afterAll, keeping the shared test database tidy run-to-run).
        await pool.query('DELETE FROM team_memberships WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM channel_memberships WHERE user_id = $1', [userId]);
      }
    }
  );
});

/**
 * Regression test: `addUserToTeam` previously left the team's own primary
 * channel's member count stuck at 0 even after a real user was added
 * (visible on the team detail page, whose displayed count is
 * `COUNT(channel_memberships.user_id)` -- see `GET /channels/team/:teamId`
 * in `server/routes/channels.js`) because no `channel_memberships` row
 * was ever inserted. This test seeds a REAL team WITH a real primary
 * channel row (unlike Property 15's teams above, which have none) and
 * proves, against real Postgres, that adding a user creates the
 * corresponding `channel_memberships` row.
 */
describe('addUserToTeam creates a channel_memberships row for the team\'s real primary channel, against a real Postgres database', () => {
  let teamId;
  let channelId;
  let userId;

  beforeAll(async () => {
    await pool.query('SELECT 1');

    const team = await pool.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING id`,
      ['ChannelMembershipRegression Team', 'CMR']
    );
    teamId = team.rows[0].id;

    // A real primary channel row for this team, mirroring what
    // Team.createTeamChannel would create (minus the Authentik call --
    // authentik_group_id is left NULL here, which also exercises the
    // "channel with no group id yet still gets its local row" branch of
    // the fix).
    const channel = await pool.query(
      `INSERT INTO channels (name, display_name, team_id, is_primary) VALUES ($1, $2, $3, true) RETURNING id`,
      ['cmr-team-channel', 'CMR Team Channel', teamId]
    );
    channelId = channel.rows[0].id;

    const username = `cmr-${crypto.randomUUID()}`;
    const user = await pool.query(
      `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id`,
      [username, `${username}@example.invalid`]
    );
    userId = user.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM channel_memberships WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM team_memberships WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM channels WHERE id = $1', [channelId]);
    await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
  });

  it('inserts a channel_memberships row, so the channel\'s member count (COUNT query) is 1, not 0', async () => {
    await TeamMembershipService.addUserToTeam(userId, teamId, 'member', userId);

    const membershipRow = await pool.query(
      'SELECT * FROM channel_memberships WHERE channel_id = $1 AND user_id = $2',
      [channelId, userId]
    );
    expect(membershipRow.rows).toHaveLength(1);
    expect(membershipRow.rows[0].permission).toBe('read_write');

    // Exact query used by GET /channels/team/:teamId to compute the
    // displayed member_count.
    const countResult = await pool.query(
      `SELECT c.id, COUNT(cm.user_id) as member_count
       FROM channels c
       LEFT JOIN channel_memberships cm ON c.id = cm.channel_id
       WHERE c.id = $1
       GROUP BY c.id`,
      [channelId]
    );
    expect(Number(countResult.rows[0].member_count)).toBe(1);
  });
});

afterAll(async () => {
  await pool.end();

  process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
  process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
  process.env.DB_NAME = ORIGINAL_ENV.DB_NAME;
  process.env.DB_USER = ORIGINAL_ENV.DB_USER;
  process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
});
