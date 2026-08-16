/**
 * Real-Postgres property-based test for design.md's Property 11 (task
 * 43.2):
 *
 *   "Property 11: Time-bounded access records deactivate exactly once
 *   past expiry
 *
 *   For any set of Vendor_Channel_Grant or Deployment_Channel records
 *   with arbitrary expiry timestamps and arbitrary prior active/revoked
 *   state, after running the expiry cleanup pass, every record whose
 *   expiry timestamp has passed and was not already inactive becomes
 *   inactive, and every other record's active state is unchanged.
 *
 *   Validates: Requirements 21.6, 21.7, 22.8, 22.9"
 *
 * DB-vs-mock decision (documented per the task's instructions): this
 * test uses a REAL Postgres database rather than a mocked
 * `pool`/client. `VendorChannelService.expireGrants()`'s and
 * `DeploymentChannelService.deactivateExpired()`'s core correctness
 * guarantee is a bulk `UPDATE ... WHERE expires_at <= NOW() AND
 * revoked_at IS NULL` / `WHERE deployment_end_date <= NOW() AND
 * is_active = true` correctly PARTITIONING an arbitrary set of rows by
 * their expiry timestamp relative to a REAL `NOW()`. A mocked
 * `pool.query` can only ever assert on the exact SQL string issued; to
 * make it "faithful" it would have to reimplement that same WHERE-clause
 * predicate in JavaScript and apply it to the fixture rows before
 * returning them -- at which point the test would just be checking the
 * mock's own reimplementation against itself, not the real
 * `expires_at <= NOW()`/`deployment_end_date <= NOW()` SQL semantics
 * (exactly the tautology risk this task's instructions call out).
 * Running this against a real, already-migrated Postgres instance is
 * the only way to prove the WHERE clause itself -- and hence the
 * production SQL, not a JS stand-in for it -- correctly separates
 * past-expiry-and-unrevoked rows from every other row. Following the
 * existing separation convention in this codebase (`Channel.test.js` /
 * `Channel.integration.test.js`, `TeamMembershipService.test.js` /
 * `TeamMembershipService.integration.test.js`), this real-DB property
 * test lives in its own file rather than being added to either
 * `VendorChannelService.test.js` or `DeploymentChannelService.test.js`,
 * both of which already cover `expireGrants`/`deactivateExpired` at the
 * mocked-pool unit level (no-expired-rows no-op, single/multiple expired
 * rows, per-row-failure-continues-the-batch).
 *
 * `EventPublisher.publishOperation` is mocked (module-level `jest.mock`,
 * exactly as it already is in `VendorChannelService.test.js`/
 * `DeploymentChannelService.test.js`/
 * `TeamMembershipService.integration.test.js`) -- there is no real
 * Authentik/sync-worker involved in this property, and mocking it here
 * also sidesteps `sync_operations.created_by`'s real `REFERENCES
 * users(id)` foreign key, which the production code's `SYSTEM_USER_ID`
 * sentinel (`-1`) does not satisfy against a real `users` table.
 *
 * Connection convention: mirrors `server/services
 * /TeamMembershipService.integration.test.js`/`server/models
 * /Channel.integration.test.js` exactly -- `DB_HOST`/`DB_PORT`/
 * `DB_NAME`/`DB_USER`/`DB_PASSWORD` are read from the environment if
 * already set, otherwise defaulted to the local Docker-based test
 * container (`tak_migration_test_501`, Postgres 15, host port 15433,
 * database `tak_team_manager`, user `postgres`, password
 * `postgres123`). These are set on `process.env` BEFORE `../config
 * /database` (required transitively by `./VendorChannelService`/
 * `./DeploymentChannelService`/`./ExpiryScheduler`) is first required
 * anywhere in this file's module graph, and restored in `afterAll`.
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
const EventPublisher = require('./EventPublisher');
const VendorChannelService = require('./VendorChannelService');
const DeploymentChannelService = require('./DeploymentChannelService');
const ExpiryScheduler = require('./ExpiryScheduler');

const { SYSTEM_USER_ID } = VendorChannelService;

describe('Property 11: Time-bounded access records deactivate exactly once past expiry (Requirements 21.6, 21.7, 22.8, 22.9), against a real Postgres database', () => {
  let managerId;
  let vendorUserId;
  let vendorChannelId;
  const vendorChannelGroupId = `vnd-test-group-${crypto.randomUUID()}`;

  beforeAll(async () => {
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `Real Postgres test database is not reachable at ` +
          `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} ` +
          `(user "${process.env.DB_USER}"). This property test (task 43.2, design.md's ` +
          `Property 11) deliberately runs against a real, already-migrated Postgres ` +
          `instance rather than a mocked pool/client, since it verifies that the real ` +
          `"expires_at <= NOW()"/"deployment_end_date <= NOW()" WHERE-clause predicates ` +
          `correctly partition rows -- a guarantee a mocked pool cannot faithfully prove ` +
          `without reimplementing (and thus tautologically re-testing) that same ` +
          `predicate. Underlying error: ${error.message}`,
        { cause: error }
      );
    }

    const managerResult = await pool.query(
      `INSERT INTO users (username, email, is_global_manager) VALUES ($1, $2, true) RETURNING id`,
      [`p11-manager-${crypto.randomUUID()}`, `p11-manager-${crypto.randomUUID()}@example.invalid`]
    );
    managerId = managerResult.rows[0].id;

    const vendorUserResult = await pool.query(
      `INSERT INTO users (username, email, is_vendor) VALUES ($1, $2, true) RETURNING id`,
      [`p11-vendor-${crypto.randomUUID()}`, `p11-vendor-${crypto.randomUUID()}@example.invalid`]
    );
    vendorUserId = vendorUserResult.rows[0].id;

    // Requirement 21 Criterion 11: at most one active vendor_channels row
    // at a time -- seed exactly one for this whole file, reused (never
    // duplicated) across every fast-check run below.
    const vendorChannelResult = await pool.query(
      `INSERT INTO vendor_channels (name, display_name, authentik_group_id, is_active, created_by)
       VALUES ('VND', 'VND', $1, true, $2) RETURNING id`,
      [vendorChannelGroupId, managerId]
    );
    vendorChannelId = vendorChannelResult.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM vendor_channel_grants WHERE user_id = $1', [vendorUserId]);
    await pool.query('DELETE FROM vendor_channels WHERE id = $1', [vendorChannelId]);
    await pool.query('DELETE FROM deployment_channels WHERE requested_by = $1', [managerId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[managerId, vendorUserId]]);

    await pool.end();

    process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
    process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
    process.env.DB_NAME = ORIGINAL_ENV.DB_NAME;
    process.env.DB_USER = ORIGINAL_ENV.DB_USER;
    process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
  });

  /**
   * Each generated record spec is either a Vendor_Channel_Grant or a
   * Deployment_Channel, with:
   *   - `offsetMinutes`: the record's expiry timestamp expressed as an
   *     offset (in minutes, computed against the DATABASE's own NOW() at
   *     insert time, not the test process's clock) from "now" -- negative
   *     means already expired, zero means expired by the time the sweep
   *     runs a moment later, positive means still in the future. Range
   *     covers several hours either side of "now" so the boundary is
   *     exercised alongside comfortably-past and comfortably-future
   *     cases.
   *   - `alreadyProcessed`: whether the record starts out already
   *     revoked (Vendor_Channel_Grant) / already inactive
   *     (Deployment_Channel), independent of `offsetMinutes` -- covering
   *     "already revoked/inactive with a past expiry" and "already
   *     revoked/inactive with a future expiry" alike.
   */
  const offsetMinutesArb = fc.integer({ min: -600, max: 600 });
  const vendorGrantSpecArb = fc.record({
    kind: fc.constant('vendorGrant'),
    offsetMinutes: offsetMinutesArb,
    alreadyProcessed: fc.boolean()
  });
  const deploymentChannelSpecArb = fc.record({
    kind: fc.constant('deploymentChannel'),
    offsetMinutes: offsetMinutesArb,
    alreadyProcessed: fc.boolean()
  });
  const recordSpecArb = fc.oneof(vendorGrantSpecArb, deploymentChannelSpecArb);
  const recordsArb = fc.array(recordSpecArb, { minLength: 1, maxLength: 3 });

  /**
   * Inserts one real row for `spec`, computing its expiry timestamp
   * relative to the DATABASE's own `NOW()` (`NOW() + ($n * INTERVAL '1
   * minute')`) rather than a JS-computed `Date`, so the test is immune
   * to any clock skew between the test process and the database server
   * -- the property is about the SQL predicate's behavior relative to
   * its own `NOW()`, not the test host's clock.
   */
  async function seedRecord(spec) {
    if (spec.kind === 'vendorGrant') {
      // Computed in JS (rather than a SQL CASE expression) so each
      // parameter's Postgres type is unambiguous from a plain bound
      // value -- a `CASE WHEN $bool THEN <timestamp-or-int> ELSE NULL
      // END` construct otherwise leaves Postgres unable to infer the
      // NULL branch's type from context in every driver/version
      // combination.
      const revokedAtParam = spec.alreadyProcessed ? new Date(Date.now() - 60 * 60 * 1000) : null;
      const revokedByParam = spec.alreadyProcessed ? managerId : null;

      const result = await pool.query(
        `INSERT INTO vendor_channel_grants (user_id, channel_id, granted_by, expires_at, revoked_at, revoked_by)
         VALUES (
           $1, $2, $3,
           NOW() + ($4 * INTERVAL '1 minute'),
           $5,
           $6
         )
         RETURNING id, revoked_at, revoked_by`,
        [vendorUserId, vendorChannelId, managerId, spec.offsetMinutes, revokedAtParam, revokedByParam]
      );
      const row = result.rows[0];

      return {
        kind: 'vendorGrant',
        id: row.id,
        originalRevokedAt: row.revoked_at,
        originalRevokedBy: row.revoked_by,
        expectProcessedAfterSweep1: !spec.alreadyProcessed && spec.offsetMinutes <= 0
      };
    }

    const isActiveParam = !spec.alreadyProcessed;

    const result = await pool.query(
      `INSERT INTO deployment_channels (name, description, deployment_end_date, authentik_group_id, is_active, requested_by)
       VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 minute'), $4, $5, $6)
       RETURNING id, is_active`,
      [
        `Overseas - Property11 ${crypto.randomUUID()}`,
        'Property 11 test fixture',
        spec.offsetMinutes,
        `grp-p11-${crypto.randomUUID()}`,
        isActiveParam,
        managerId
      ]
    );
    const row = result.rows[0];

    return {
      kind: 'deploymentChannel',
      id: row.id,
      originalIsActive: row.is_active,
      expectProcessedAfterSweep1: !spec.alreadyProcessed && spec.offsetMinutes <= 0
    };
  }

  async function readVendorGrantState(id) {
    const { rows } = await pool.query('SELECT revoked_at, revoked_by FROM vendor_channel_grants WHERE id = $1', [id]);
    return rows[0];
  }

  async function readDeploymentChannelState(id) {
    const { rows } = await pool.query('SELECT is_active FROM deployment_channels WHERE id = $1', [id]);
    return rows[0];
  }

  async function cleanupRecord(rec) {
    if (rec.kind === 'vendorGrant') {
      await pool.query('DELETE FROM vendor_channel_grants WHERE id = $1', [rec.id]);
    } else {
      await pool.query('DELETE FROM deployment_channels WHERE id = $1', [rec.id]);
    }
  }

  // Feature: production-hardening, Property 11: Time-bounded access records deactivate exactly once past expiry
  test.prop([recordsArb], { numRuns: 100 })(
    'every unrevoked/active record whose expiry has passed deactivates exactly once, every other record is left untouched, and an immediate second sweep is idempotent',
    async (specs) => {
      const seededRecords = [];

      try {
        for (const spec of specs) {
          seededRecords.push(await seedRecord(spec));
        }

        const scheduler = new ExpiryScheduler();

        // --- Sweep 1 -------------------------------------------------
        await scheduler.runSweep();

        for (const rec of seededRecords) {
          if (rec.kind === 'vendorGrant') {
            const state = await readVendorGrantState(rec.id);

            if (rec.expectProcessedAfterSweep1) {
              // Requirement 21.6/21.7: an expired, previously-unrevoked
              // grant becomes revoked, attributed to the automated
              // process's sentinel id.
              expect(state.revoked_at).not.toBeNull();
              expect(state.revoked_by).toBe(SYSTEM_USER_ID);
            } else {
              // Every other record's active state is unchanged: a
              // future-expiry, previously-unrevoked grant stays
              // unrevoked; an already-revoked grant keeps its original
              // revoked_at/revoked_by exactly (not overwritten by this
              // sweep), regardless of its expiry.
              expect(state.revoked_at).toEqual(rec.originalRevokedAt);
              expect(state.revoked_by).toEqual(rec.originalRevokedBy);
            }

            rec.stateAfterSweep1 = state;
          } else {
            const state = await readDeploymentChannelState(rec.id);

            if (rec.expectProcessedAfterSweep1) {
              // Requirement 22.8/22.9: an expired, previously-active
              // Deployment_Channel becomes inactive.
              expect(state.is_active).toBe(false);
            } else {
              // Every other record's active state is unchanged.
              expect(state.is_active).toBe(rec.originalIsActive);
            }

            rec.stateAfterSweep1 = state;
          }
        }

        // --- Sweep 2 (idempotency) ------------------------------------
        // The WHERE clause guards (revoked_at IS NULL / is_active = true)
        // mean a row already processed by sweep 1 can never re-match
        // sweep 2's UPDATE, regardless of how far past its expiry it now
        // is.
        const callCountBeforeSweep2 = EventPublisher.publishOperation.mock.calls.length;

        await scheduler.runSweep();

        const newCallsDuringSweep2 = EventPublisher.publishOperation.mock.calls.slice(callCountBeforeSweep2);

        for (const rec of seededRecords) {
          if (rec.kind === 'vendorGrant') {
            const state = await readVendorGrantState(rec.id);
            // revoked_at/revoked_by are byte-for-byte unchanged from
            // whatever sweep 1 left them at -- no double-processing.
            expect(state.revoked_at).toEqual(rec.stateAfterSweep1.revoked_at);
            expect(state.revoked_by).toEqual(rec.stateAfterSweep1.revoked_by);
          } else {
            const state = await readDeploymentChannelState(rec.id);
            expect(state.is_active).toBe(rec.stateAfterSweep1.is_active);

            // No additional remove_all_members_from_group enqueue for
            // THIS channel during sweep 2 (channel_id is unique per
            // deploymentChannel record, so this filter is precise).
            const matchingCalls = newCallsDuringSweep2.filter(
              ([operationType, payload]) =>
                operationType === 'remove_all_members_from_group' && payload.channel_id === rec.id
            );
            expect(matchingCalls).toHaveLength(0);
          }
        }

        // No additional remove_user_from_group enqueue for this run's
        // vendor user/channel combo during sweep 2. Every vendorGrant
        // record in this run shares the same seeded (vendorUserId,
        // vendorChannelGroupId) pair, so this is checked once per run
        // (not per record): since every due grant was already revoked
        // by sweep 1, sweep 2 must find none left to process for this
        // pair, regardless of how many vendorGrant records the run
        // contained.
        const matchingVendorCalls = newCallsDuringSweep2.filter(
          ([operationType, payload]) =>
            operationType === 'remove_user_from_group' &&
            payload.target_user_id === vendorUserId &&
            payload.target_group_id === vendorChannelGroupId
        );
        expect(matchingVendorCalls).toHaveLength(0);
      } finally {
        for (const rec of seededRecords) {
          await cleanupRecord(rec);
        }
      }
    }
  );
});
