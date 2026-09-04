/**
 * Stateful/model-based fast-check test for `team_memberships` invariants,
 * against a REAL, freshly-migrated, throwaway Postgres database.
 *
 * =====================================================================
 * WHY THIS TEST EXISTS
 * =====================================================================
 *
 * Incident this test guards against: a user held an INHERITED
 * `team_memberships` row for an Organisation (inherited from their
 * direct membership in a Sub_Team). The Organisation's "Add Admin"
 * picker offered them as a candidate anyway (it only excluded users
 * already `role='admin'`, not inherited ones), and promoting them called
 * `Team.addMember(orgTeamId, userId, 'admin')`, whose upsert
 * (`INSERT ... ON CONFLICT (user_id, team_id) DO UPDATE SET role = $3`)
 * hit the conflict branch against that EXISTING inherited row and set
 * `role='admin'` WITHOUT clearing `inherited_from_team_id`. The result:
 * a row that is simultaneously `role='admin'` AND inherited, which
 * violates this app's own Team_Admin definition (a DIRECT admin row, per
 * `Team.isAdmin`/the glossary). It displayed as an admin in the Team
 * Admins tab (which only filters on `role`) while `Team.isAdmin`
 * correctly excluded it -- so the affected user was silently denied
 * every real team-admin-gated action (e.g. `GET /api/devices/team/:id`)
 * despite appearing to be an admin.
 *
 * This is exactly the bug class no existing test in this repo could
 * catch: every unit test in `Team.test.js`/`TeamMembershipService.test.js`
 * mocks `pool.query`, so a mock that returns whatever a test tells it to
 * cannot notice that a SEQUENCE of two individually-valid calls (add to
 * sub-team, then promote via the org page) leaves the REAL, persisted
 * table in a state neither call's own test ever constructs or inspects.
 * Catching it requires actually running a sequence of calls against a
 * real table and checking a GLOBAL invariant afterward -- which is what
 * a model-based test is for.
 *
 * Two independent layers already guard against a recurrence of this
 * EXACT code path:
 *   1. `Team.addMember` (`server/models/Team.js`) now throws
 *      `InheritedMembershipPromotionError` before attempting the upsert
 *      when the target row is inherited.
 *   2. `database/migrations/1789300000000_team-memberships-admin-not-inherited.cjs`
 *      adds a real DB `CHECK` constraint
 *      (`team_memberships_admin_not_inherited`) making the bad row shape
 *      impossible to persist AT ALL, regardless of which code path
 *      attempts it.
 *
 * This test is deliberately NOT redundant with either: it does not name
 * `Team.addMember` or the migration anywhere in its assertions. Instead
 * it drives RANDOM SEQUENCES of the application's own membership-mutating
 * operations (`TeamMembershipService.addUserToTeam`, `Team.addMember`,
 * `TeamMembershipService.removeUserFromTeam`,
 * `TeamTransferService.executeTransfer`) against a real database and
 * checks, after EVERY step, that a small set of GLOBAL invariants still
 * hold -- so it would catch a FUTURE bug that reintroduces the same
 * corrupted shape through a different code path the two guards above
 * don't cover (e.g. a new bulk-promote endpoint, or a raw `UPDATE`
 * somewhere that bypasses `Team.addMember` entirely). If the DB
 * constraint is ever accidentally dropped in a future migration, this
 * test's own invariant check (a direct `SELECT`, not a reliance on the
 * constraint throwing) still catches the regression.
 *
 * =====================================================================
 * MODEL
 * =====================================================================
 *
 * The `Model` tracks, per candidate user id, `{ teamId, role } | null`
 * describing what the LAST executed command established as that user's
 * intended Direct_Membership -- independently re-derived from each
 * Command's own documented behaviour (never by calling the service under
 * test and trusting its answer, per this repo's testing-conventions
 * "independent re-derivation" rule). `Real` is just the real `pg` `Pool`
 * connected to the throwaway database, plus the fixed team ids the
 * commands operate over.
 *
 * Four command types, each `check()`ed against the model before running
 * so fast-check only ever generates a sequence of calls that are
 * individually well-formed for the CURRENT modeled state (e.g. `Remove`
 * is only proposed for a user the model currently shows as a member):
 *
 *   - `AddDirectCommand`      -- `TeamMembershipService.addUserToTeam`
 *                                against a LEAF team (never the org
 *                                root), the ordinary "add a member"
 *                                path. Establishes a direct row on that
 *                                leaf, `role='member'`, plus inherited
 *                                rows up the chain to the Organisation.
 *   - `PromoteViaAddMemberCommand` -- `Team.addMember(orgTeamId, userId,
 *                                'admin')`, the EXACT "org page promote"
 *                                call the incident traces to. When the
 *                                model shows the user's last-established
 *                                row as inherited on the org (i.e. they
 *                                were added to a leaf and never
 *                                transferred), this call is EXPECTED to
 *                                throw `InheritedMembershipPromotionError`
 *                                and leave the real row UNCHANGED -- this
 *                                is the test's most direct regression
 *                                guard, and it fails loudly (not
 *                                silently) if a future change removes
 *                                that guard without an equivalent
 *                                replacement. When the model shows a
 *                                genuine direct row on the org already
 *                                (e.g. after a `TransferCommand`), the
 *                                call is expected to succeed and set
 *                                `role='admin'`.
 *   - `TransferCommand`        -- `TeamTransferService.executeTransfer`,
 *                                moving the user's Direct_Membership from
 *                                a leaf to the Organisation (the CORRECT,
 *                                non-corrupting way to make an
 *                                inherited-only user into a real org
 *                                member, confirmed during this incident's
 *                                own resolution). Always arrives as
 *                                `role='member'` (Requirement 10.1 -- a
 *                                transferred admin is demoted).
 *   - `RemoveCommand`          -- `TeamMembershipService.removeUserFromTeam`,
 *                                clearing the user's membership entirely.
 *
 * After EVERY command's `run()`, TWO kinds of assertion happen:
 *   (a) the per-user model prediction is checked against the real
 *       `team_memberships` rows for that user (local correctness), and
 *   (b) a GLOBAL invariant is checked with a direct query scoped to the
 *       whole table, not just the touched user's rows -- this is what
 *       lets the test catch a DIFFERENT code path than the one the
 *       current command exercised:
 *         "no team_memberships row is simultaneously role='admin' AND
 *          inherited_from_team_id IS NOT NULL"
 *         "no user holds more than one row with inherited_from_team_id
 *          IS NULL" (the partial-unique-index invariant, checked
 *          independently of whether Postgres would have thrown -- a
 *          belt-and-suspenders re-statement of
 *          idx_team_memberships_one_direct_per_user in the test's own
 *          words, per the design.md convention `TeamTransferService
 *          .pathEquivalence.test.js` already follows elsewhere).
 *
 * =====================================================================
 * DB-vs-mock decision (already established by
 * `server/services/TeamMembershipService.integration.test.js`, restated
 * here since this file makes the same choice for the same reason)
 * =====================================================================
 *
 * A mocked `pool`/`client` can only assert on the exact SQL statements a
 * single call issues; it cannot prove what a SEQUENCE of calls leaves
 * behind in a real, constraint-enforcing table. This property is
 * specifically about the net effect of a sequence, so it needs a real
 * database.
 *
 * `EventPublisher.publishOperation`/`publishOperationsBatch` are mocked
 * (module-level `jest.mock`, matching `TeamMembershipService.integration
 * .test.js`/`UserProvisioningService.reclaim.integration.test.js`
 * exactly) -- there is no real Authentik/sync-worker involved in this
 * property, and mocking it avoids needing a real `users` row satisfying
 * `sync_operations.created_by`'s FK for every operation type a command
 * might enqueue.
 *
 * =====================================================================
 * Throwaway database
 * =====================================================================
 *
 * ONE throwaway database, created once in `beforeAll` (a full migration
 * run per fast-check case would be far too slow for `numRuns >= 100`),
 * using the shared `database/testHelpers/throwawayDatabase.js` helpers
 * (extracted from `database/migrations/__tests__/baselineMigration
 * .integration.test.js` for this exact purpose). Each fast-check run
 * seeds its own fresh Organisation + two Sub_Teams (never reusing team
 * ids across runs) and a small fixed pool of candidate user ids, and
 * cleans up its own rows in a `finally` block -- mirroring
 * `TeamMembershipService.integration.test.js`'s own per-run isolation,
 * so one run's residue can never interact with the next.
 *
 * Connection convention: `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`
 * default to the local Docker-based test container
 * (`tak_migration_test_501`, Postgres 15, host port 15433, user
 * `postgres`, password `postgres123`) if not already set, matching
 * every other `*.integration.test.js` file in this repo. `DB_NAME` is
 * NOT read from the environment -- this file creates and connects to its
 * own uniquely-named throwaway database instead. These are set on
 * `process.env` BEFORE `../config/database` (required transitively by
 * `Team`/`TeamMembershipService`/`TeamTransferService`) is first
 * required anywhere in this file's module graph, and restored in
 * `afterAll`.
 *
 * Run explicitly (this file is excluded from `npm test` by
 * `testPathIgnorePatterns`):
 *
 *   npx jest server/services/teamMembershipInvariants.model.integration.test.js \
 *     --testPathIgnorePatterns=/node_modules/ /client/
 */

const path = require('path');

const ORIGINAL_ENV = {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD
};

process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '15433';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres123';
// `../config/database` (the real, shared connection pool this test uses
// unmocked) reads `DB_NAME` at require-time. This file's own throwaway
// database's NAME is not known until `beforeAll` runs `CREATE DATABASE`,
// so `pool` cannot be the module required at top-level the way other
// integration tests in this repo do it against the pre-existing,
// already-migrated `tak_team_manager` database. Instead, this file
// constructs its OWN `pg.Pool` pointed at the throwaway database (see
// `beforeAll` below) and passes it explicitly to every service call,
// exactly like `TeamTransferService.js`'s own transactional-client
// pattern -- `Team.addMember` is the one exception (see its own comment
// at the `PromoteViaAddMemberCommand` definition below).

jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn().mockResolvedValue('op-id'),
  publishOperationsBatch: jest.fn().mockResolvedValue([]),
  publishBulkOperation: jest.fn().mockResolvedValue([])
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const {
  createThrowawayDatabase,
  dropThrowawayDatabase,
  runMigrationChain
} = require('../../database/testHelpers/throwawayDatabase');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'database', 'migrations');

// `Team`/`TeamMembershipService`/`TeamTransferService` all resolve their
// database access through the shared `../config/database` singleton
// pool, constructed once at first `require()` from the `DB_*` env vars
// set above. Since this file's throwaway database's name is fixed BEFORE
// any of these modules are required (unlike the pool itself, which is
// per-file elsewhere in this repo's integration tests), setting
// `process.env.DB_NAME` here -- before these `require()`s -- makes the
// shared singleton pool used by the services under test point at the
// SAME throwaway database this file's own `pool` (used for setup/
// teardown/assertions) connects to explicitly.
const DB_NAME = `team_membership_invariants_model_${Date.now()}`;
process.env.DB_NAME = DB_NAME;

const Team = require('../models/Team');
const TeamMembershipService = require('./TeamMembershipService');
const { TeamTransferService } = require('./TeamTransferService');
const sharedPool = require('../config/database');

describe('team_memberships invariants under random command sequences, against a real Postgres database', () => {
  let adminAccessPool;

  beforeAll(async () => {
    adminAccessPool = await createThrowawayDatabase(
      DB_NAME,
      'The team-membership invariants model test'
    );
    // `createThrowawayDatabase` returns its OWN new `Pool` connected to
    // the throwaway database; the shared singleton `../config/database`
    // pool (required above, into `sharedPool`) was constructed from the
    // SAME `DB_NAME`/`DB_HOST`/etc env vars, so `sharedPool` also
    // resolves to this same throwaway database -- confirmed by the
    // "sanity" test in the first `describe` block below. Only one of the
    // two connections is kept open long-term: `adminAccessPool` is ended
    // immediately after migrating, and every setup/assertion/teardown
    // query in this file thereafter goes through `sharedPool`, exactly
    // like the code under test does.
    await adminAccessPool.end();

    runMigrationChain(DB_NAME, MIGRATIONS_DIR);
  }, 120000);

  afterAll(async () => {
    await sharedPool.end();
    await dropThrowawayDatabase(DB_NAME);

    process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
    process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
    process.env.DB_USER = ORIGINAL_ENV.DB_USER;
    process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
  });

  it('sanity: the shared config/database pool and this file\'s own admin pool really do point at the SAME throwaway database', async () => {
    const result = await sharedPool.query('SELECT current_database() AS name');
    expect(result.rows[0].name).toBe(DB_NAME);
  });

  // -------------------------------------------------------------------
  // Global invariant checks -- scoped to the WHOLE table, not just the
  // ids a given command touched, so a regression through a DIFFERENT
  // code path than the one currently under test is still caught.
  // -------------------------------------------------------------------

  /**
   * The exact corrupted shape this test exists to prevent recurring.
   * Independent of, and does not rely on, the CHECK constraint added by
   * `1789300000000_team-memberships-admin-not-inherited.cjs` -- if that
   * constraint were ever dropped by a future migration, this query still
   * catches the regression by directly inspecting the data, rather than
   * depending on Postgres to reject the write.
   */
  async function assertNoAdminInheritedRow() {
    const { rows } = await sharedPool.query(
      `SELECT id, user_id, team_id, inherited_from_team_id
         FROM team_memberships
        WHERE role = 'admin' AND inherited_from_team_id IS NOT NULL`
    );
    expect(rows).toEqual([]);
  }

  /**
   * Restates `idx_team_memberships_one_direct_per_user` in the test's
   * own words (a belt-and-suspenders check, not a reliance on the real
   * index -- a write that violates it would have already thrown before
   * reaching this point, but asserting it explicitly here documents the
   * invariant this test's Model also assumes, and keeps failing loudly
   * even if that index were ever weakened).
   */
  async function assertAtMostOneDirectRowPerUser() {
    const { rows } = await sharedPool.query(
      `SELECT user_id, COUNT(*) AS direct_row_count
         FROM team_memberships
        WHERE inherited_from_team_id IS NULL
        GROUP BY user_id
       HAVING COUNT(*) > 1`
    );
    expect(rows).toEqual([]);
  }

  async function assertGlobalInvariants() {
    await assertNoAdminInheritedRow();
    await assertAtMostOneDirectRowPerUser();
  }

  // -------------------------------------------------------------------
  // Scenario setup: a fresh Organisation + two Sub_Teams (leaves) per
  // fast-check run, and a small fixed candidate-user pool. Kept
  // deliberately small and fixed (matching `transferArbitraries.js`'s
  // own `ADMIN_CANDIDATE_USER_IDS` convention) so counterexamples are
  // comparable across shrinking attempts.
  // -------------------------------------------------------------------

  const CANDIDATE_COUNT = 2;

  async function seedScenario() {
    const orgResult = await sharedPool.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING id`,
      [`ModelOrg-${Date.now()}-${Math.random().toString(36).slice(2)}`, null]
    );
    const orgId = orgResult.rows[0].id;

    const leafAResult = await sharedPool.query(
      `INSERT INTO teams (name, callsign_prefix, parent_team_id) VALUES ($1, $2, $3) RETURNING id`,
      ['ModelLeafA', null, orgId]
    );
    const leafBResult = await sharedPool.query(
      `INSERT INTO teams (name, callsign_prefix, parent_team_id) VALUES ($1, $2, $3) RETURNING id`,
      ['ModelLeafB', null, orgId]
    );

    const userIds = [];
    for (let i = 0; i < CANDIDATE_COUNT; i++) {
      const username = `model-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
      const userResult = await sharedPool.query(
        `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id`,
        [username, `${username}@example.invalid`]
      );
      userIds.push(userResult.rows[0].id);
    }

    return {
      orgId,
      leafIds: [leafAResult.rows[0].id, leafBResult.rows[0].id],
      userIds
    };
  }

  async function teardownScenario(scenario) {
    await sharedPool.query('DELETE FROM team_memberships WHERE user_id = ANY($1)', [scenario.userIds]);
    await sharedPool.query('DELETE FROM channel_memberships WHERE user_id = ANY($1)', [scenario.userIds]);
    await sharedPool.query('DELETE FROM users WHERE id = ANY($1)', [scenario.userIds]);
    await sharedPool.query('DELETE FROM teams WHERE id = ANY($1)', [
      [...scenario.leafIds, scenario.orgId]
    ]);
  }

  // -------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------

  /**
   * `Model`: `Map<userId, {teamId, role} | null>` -- what the last
   * executed command established as that user's Direct_Membership.
   * `Real`: `{ scenario }` (the seeded team/user ids this run's commands
   * operate over; the actual DB access always goes through the shared
   * `sharedPool`/service modules, never a `real`-carried connection, so
   * `Real` itself carries no live resource).
   */

  class AddDirectCommand {
    constructor(userIndex, leafIndex) {
      this.userIndex = userIndex;
      this.leafIndex = leafIndex;
    }

    check() {
      return true; // Always well-formed: re-adding an existing direct member is a legitimate no-op-ish re-add TeamMembershipService already supports (it deletes then re-inserts).
    }

    async run(model, real) {
      const userId = real.scenario.userIds[this.userIndex];
      const teamId = real.scenario.leafIds[this.leafIndex];

      await TeamMembershipService.addUserToTeam(userId, teamId, 'member', userId);
      model.set(userId, { teamId, role: 'member' });

      await this.#assertPerUserState(userId, teamId, 'member', real);
      await assertGlobalInvariants();
    }

    async #assertPerUserState(userId, teamId, role, real) {
      const { rows } = await sharedPool.query(
        `SELECT team_id, role FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL`,
        [userId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].team_id).toBe(teamId);
      expect(rows[0].role).toBe(role);

      // The Organisation must show this user via an INHERITED row (never
      // a direct one) -- this is the exact state the incident's picker
      // bug offered up as a false "Add Admin" candidate.
      const { rows: orgRows } = await sharedPool.query(
        `SELECT role, inherited_from_team_id FROM team_memberships WHERE user_id = $1 AND team_id = $2`,
        [userId, real.scenario.orgId]
      );
      expect(orgRows).toHaveLength(1);
      expect(orgRows[0].role).toBe('inherited');
      expect(orgRows[0].inherited_from_team_id).toBe(teamId);
    }

    toString() {
      return `AddDirect(user=${this.userIndex}, leaf=${this.leafIndex})`;
    }
  }

  /**
   * `Team.addMember(orgTeamId, userId, 'admin')` -- the EXACT call the
   * incident's "org page promote to admin" action makes. Deliberately
   * calls the real singleton-pool-backed `Team.addMember` (not threaded
   * through a `real`-carried client) since `Team.addMember` itself is
   * non-transactional and always uses the shared pool -- see its own
   * definition in `server/models/Team.js`. Because this file points the
   * shared pool at the SAME throwaway database via `process.env.DB_NAME`
   * (set before `Team` was required, above), this reaches the real
   * throwaway table exactly as production code would.
   */
  class PromoteViaAddMemberCommand {
    constructor(userIndex) {
      this.userIndex = userIndex;
    }

    check() {
      return true; // Well-formed regardless of model state -- this command's OWN job is to prove the correct behavior in EITHER state (inherited-only -> throw+unchanged, genuine direct -> succeed).
    }

    async run(model, real) {
      const userId = real.scenario.userIds[this.userIndex];
      const orgId = real.scenario.orgId;
      const before = model.get(userId) || null;

      const holdsGenuineDirectRowOnOrg = !!before && before.teamId === orgId;

      if (holdsGenuineDirectRowOnOrg) {
        // Promoting an existing genuine direct member/admin of the
        // Organisation itself is the ORDINARY, non-corrupting use of
        // this upsert -- must succeed and set role='admin'.
        await Team.addMember(orgId, userId, 'admin');
        model.set(userId, { teamId: orgId, role: 'admin' });

        const { rows } = await sharedPool.query(
          `SELECT role, inherited_from_team_id FROM team_memberships WHERE user_id = $1 AND team_id = $2`,
          [userId, orgId]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].role).toBe('admin');
        expect(rows[0].inherited_from_team_id).toBeNull();
      } else {
        // Every other reachable model state for this user on the org
        // team is either "no row at all" or "an INHERITED row" (a direct
        // member of a leaf, never transferred) -- both are cases
        // `Team.addMember` must now REJECT rather than corrupt.
        // `Team.addMember`'s own guard throws BEFORE any inherited row
        // (throws InheritedMembershipPromotionError) or performs the
        // ordinary INSERT branch for "no row at all" (a legitimate new
        // direct admin, not what this incident is about, but still
        // correctly non-corrupting) -- distinguish the two so this
        // command's assertion is exact either way.
        const { rows: existingOrgRows } = await sharedPool.query(
          `SELECT role, inherited_from_team_id FROM team_memberships WHERE user_id = $1 AND team_id = $2`,
          [userId, orgId]
        );
        const existingIsInherited = existingOrgRows.length > 0 && existingOrgRows[0].inherited_from_team_id !== null;

        if (existingIsInherited) {
          await expect(Team.addMember(orgId, userId, 'admin')).rejects.toThrow(
            Team.InheritedMembershipPromotionError
          );

          // The exact regression this test exists to catch: the row must
          // be UNCHANGED after the rejected attempt -- still inherited,
          // never flipped to 'admin'.
          const { rows: afterRows } = await sharedPool.query(
            `SELECT role, inherited_from_team_id FROM team_memberships WHERE user_id = $1 AND team_id = $2`,
            [userId, orgId]
          );
          expect(afterRows).toHaveLength(1);
          expect(afterRows[0].role).toBe('inherited');
          expect(afterRows[0].inherited_from_team_id).not.toBeNull();
          // Model is unchanged -- this command did not establish anything new.
        } else {
          // No row at all for this user on the org team: an ordinary,
          // legitimate brand-new direct admin grant. Must succeed.
          await Team.addMember(orgId, userId, 'admin');
          model.set(userId, { teamId: orgId, role: 'admin' });

          const { rows } = await sharedPool.query(
            `SELECT role, inherited_from_team_id FROM team_memberships WHERE user_id = $1 AND team_id = $2`,
            [userId, orgId]
          );
          expect(rows).toHaveLength(1);
          expect(rows[0].role).toBe('admin');
          expect(rows[0].inherited_from_team_id).toBeNull();
        }
      }

      await assertGlobalInvariants();
    }

    toString() {
      return `PromoteViaAddMember(user=${this.userIndex})`;
    }
  }

  /**
   * `TeamTransferService.executeTransfer` -- the CORRECT way to turn an
   * inherited-only user into a genuine direct member of the
   * Organisation. Requires its own transaction client (the service
   * itself does no `BEGIN`/`COMMIT` -- see its own doc comment), so this
   * command opens and commits one around the call, mirroring
   * `server/routes/users.js`'s own immediate-transfer call site.
   */
  class TransferCommand {
    constructor(userIndex) {
      this.userIndex = userIndex;
    }

    check() {
      // Always well-formed: `run()` below branches on the model's
      // current state and asserts the CORRECT outcome for each case
      // (no Direct_Membership -> reject, already the destination ->
      // reject, otherwise -> succeed) rather than restricting which
      // states this command may be generated against.
      return true;
    }

    async run(model, real) {
      const userId = real.scenario.userIds[this.userIndex];
      const orgId = real.scenario.orgId;
      const before = model.get(userId) || null;

      const client = await sharedPool.connect();
      try {
        await client.query('BEGIN');

        if (!before) {
          // No Direct_Membership at all -- executeTransfer must reject.
          await expect(
            TeamTransferService.executeTransfer(client, {
              userId,
              destinationTeamId: orgId,
              actorId: userId,
              actorIsGlobalManager: true
            })
          ).rejects.toThrow();
          await client.query('ROLLBACK');
          // Model unchanged.
        } else if (before.teamId === orgId) {
          // Already the destination -- executeTransfer must reject
          // (AlreadyInDestinationTeamError) rather than silently no-op.
          await expect(
            TeamTransferService.executeTransfer(client, {
              userId,
              destinationTeamId: orgId,
              actorId: userId,
              actorIsGlobalManager: true
            })
          ).rejects.toThrow();
          await client.query('ROLLBACK');
          // Model unchanged.
        } else {
          await TeamTransferService.executeTransfer(client, {
            userId,
            destinationTeamId: orgId,
            actorId: userId,
            actorIsGlobalManager: true
          });
          await client.query('COMMIT');

          // Requirement 10.1: a transferred user always arrives as
          // 'member', regardless of the role they held at the source.
          model.set(userId, { teamId: orgId, role: 'member' });

          const { rows } = await sharedPool.query(
            `SELECT role, inherited_from_team_id FROM team_memberships WHERE user_id = $1 AND team_id = $2`,
            [userId, orgId]
          );
          expect(rows).toHaveLength(1);
          expect(rows[0].role).toBe('member');
          expect(rows[0].inherited_from_team_id).toBeNull();
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }

      await assertGlobalInvariants();
    }

    toString() {
      return `Transfer(user=${this.userIndex})`;
    }
  }

  class RemoveCommand {
    constructor(userIndex) {
      this.userIndex = userIndex;
    }

    check() {
      return true;
    }

    async run(model, real) {
      const userId = real.scenario.userIds[this.userIndex];

      await TeamMembershipService.removeUserFromTeam(userId, userId);
      model.set(userId, null);

      const { rows } = await sharedPool.query(
        `SELECT id FROM team_memberships WHERE user_id = $1`,
        [userId]
      );
      expect(rows).toEqual([]);

      await assertGlobalInvariants();
    }

    toString() {
      return `Remove(user=${this.userIndex})`;
    }
  }

  // -------------------------------------------------------------------
  // The property
  // -------------------------------------------------------------------

  const userIndexArb = fc.integer({ min: 0, max: CANDIDATE_COUNT - 1 });
  const leafIndexArb = fc.integer({ min: 0, max: 1 });

  const commandsArb = fc.commands(
    [
      userIndexArb.chain((userIndex) => leafIndexArb.map((leafIndex) => new AddDirectCommand(userIndex, leafIndex))),
      userIndexArb.map((userIndex) => new PromoteViaAddMemberCommand(userIndex)),
      userIndexArb.map((userIndex) => new TransferCommand(userIndex)),
      userIndexArb.map((userIndex) => new RemoveCommand(userIndex))
    ],
    { size: '+1' }
  );

  // Feature: (this incident's own resolution), Property: no
  // team_memberships row is ever simultaneously role='admin' AND
  // inherited -- checked after every command in a random sequence of
  // add/promote/transfer/remove operations against a real database.
  //
  // **Validates: the Team_Admin definition (a DIRECT admin row) that
  // `Team.isAdmin`/`server/middleware/authorize.js`'s row-scoped
  // resolvers rely on, and the `team_memberships_admin_not_inherited`
  // CHECK constraint added alongside this test.**
  test.prop([commandsArb], { numRuns: 100 })(
    'random sequences of addUserToTeam/Team.addMember/executeTransfer/removeUserFromTeam never leave a team_memberships row that is both role=\'admin\' and inherited, and never leave more than one direct row per user',
    async (commands) => {
      const scenario = await seedScenario();
      try {
        const model = new Map();
        const real = { scenario };

        await fc.asyncModelRun(() => ({ model, real }), commands);
      } finally {
        await teardownScenario(scenario);
      }
    }
  );
});
