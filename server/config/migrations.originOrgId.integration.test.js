/**
 * Real-Postgres migration tests for the `users.origin_org_id` provenance
 * migration (task 13.5, Requirements 13.1, 13.2, 15.13):
 *
 *   13.1 -- "THE App SHALL add an `origin_org_id` column to `users`,
 *   nullable, referencing `teams(id)` with `ON DELETE SET NULL`, plus a
 *   partial index `idx_users_origin_org_id` over the non-null rows."
 *
 *   13.2 -- "THE App SHALL add the column additively, leaving every
 *   pre-existing `users` row's other column values unchanged and its
 *   `origin_org_id` NULL."
 *
 * Both claims are about what happens to *pre-existing data* and about a
 * foreign-key behaviour, so neither can be verified by reading the
 * migration source or by mocking `pool`: the only way to observe "every
 * other column value is unchanged", "the new column is NULL", and "a
 * deleted Organisation sets the value back to NULL rather than deleting
 * the user" is to put rows in a real table, run the real migration
 * against them, and diff / mutate / diff. That is what this file does.
 *
 * Method (mirrors `server/config/migrations.teamTransfer.integration.test.js`
 * and `database/schemaConsistency.integration.test.js`, the two existing
 * precedents in this repo for running the migration chain from a test):
 *
 *   1. Create a dedicated, uniquely-named Postgres *schema* in the shared
 *      test database and run the migration chain into it with the
 *      `origin_org_id` migration excluded via `ignorePattern`. That
 *      leaves a schema in exactly the state a real deployment is in
 *      immediately before this migration ships -- `users` with no
 *      `origin_org_id` column at all.
 *   2. Seed `teams` (two rows: an Organisation and a sub-team) and four
 *      `users` rows spanning the presence combinations that matter
 *      (all fields populated, some NULL, a global manager, an inactive
 *      user), so "left unchanged" is asserted over a variety of shapes.
 *   3. Snapshot every row of `users` as `jsonb`, so the comparison is
 *      over *all* columns rather than a hand-maintained column list.
 *   4. Run the `origin_org_id` migration, snapshot again, and diff:
 *      every pre-existing row keeps its other columns and its new
 *      `origin_org_id` is NULL.
 *   5. FK behaviour: set one user's `origin_org_id` to a real team, then
 *      DELETE that team, and assert the user row survives with
 *      `origin_org_id` reset to NULL (ON DELETE SET NULL) -- not deleted
 *      (CASCADE) and not blocked (RESTRICT).
 *   6. Idempotence: run `down` (drops the index then the column), assert
 *      both are gone, then run `up` again, asserting the column and the
 *      partial index are re-created cleanly with no error.
 *
 * All of the mutation runs once in `beforeAll` and the individual tests
 * then assert against the captured snapshots / final schema state, so the
 * tests are independent of Jest's declaration-order execution.
 *
 * `node -e` child process rather than `require('node-pg-migrate')`:
 * `node-pg-migrate` v9 is pure ESM and cannot be `require()`d through
 * Jest's CommonJS transform (documented at length in
 * `database/schemaConsistency.integration.test.js`). The child script
 * performs only the `runner()` call; every assertion below is a plain
 * `pg` query. The `down` direction is driven the same way, with
 * `count: Infinity` so every migration recorded in this throwaway
 * schema's `pgmigrations` table since the exclusion boundary is not a
 * concern -- only the single `origin_org_id` migration is ever recorded
 * as pending here, because it is the one the baseline chain skipped.
 *
 * The throwaway schema is dropped in `afterAll` regardless of pass or
 * fail, so nothing is left behind in the shared test database. The
 * migration file under test is never modified.
 *
 * Connection convention: `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/
 * `DB_PASSWORD` are read from the environment if already set, otherwise
 * defaulted to the local Docker-based test container
 * (`tak_migration_test_501`, Postgres 15, host port 15433, database
 * `tak_team_manager`, user `postgres`, password `postgres123`), matching
 * the top of `server/config/migrations.teamTransfer.integration.test.js`.
 * They are restored in `afterAll`.
 *
 * Run explicitly (this file is excluded from `npm test` by
 * `testPathIgnorePatterns`):
 *
 *   npx jest server/config/migrations.originOrgId.integration.test.js \
 *     --testPathIgnorePatterns=/node_modules/ /client/
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

const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'database', 'migrations');
const REPO_ROOT = path.join(__dirname, '..', '..');

const SCHEMA_NAME = `origin_org_id_migration_test_${Date.now()}`;

/** The migration under test, by filename timestamp prefix. */
const ORIGIN_ORG_ID_PREFIX = '1786940000000';

const ORIGIN_ORG_ID_INDEX = 'idx_users_origin_org_id';

/**
 * `ignorePattern` is anchored by node-pg-migrate as `^<pattern>$` against
 * each directory entry's base name (see
 * `node_modules/node-pg-migrate/dist/legacy/migration.js`), and supplying
 * it *replaces* the built-in `^\..*` default -- hence the explicit
 * dot-file branch, without which `database/migrations/.gitkeep` would be
 * loaded as a migration.
 */
const IGNORE_ORIGIN_ORG_ID_MIGRATION = `(\\..*|${ORIGIN_ORG_ID_PREFIX}_.*)`;

/**
 * Runs the migration chain into SCHEMA_NAME out-of-process, using the
 * same `runner()` entry point `database/init.js` uses.
 *
 * @param {object} [options]
 * @param {string} [options.ignorePattern] Base-name regex of migration
 *   files to skip.
 * @param {boolean} [options.createSchema] Whether the schema may need
 *   creating (only true for the first, baseline run).
 * @param {'up'|'down'} [options.direction] Migration direction.
 * @param {number} [options.count] How many migrations to run (only used
 *   for `down`, where the default of 1 already suffices but is stated
 *   explicitly for clarity).
 */
function runMigrationChain({
  ignorePattern,
  createSchema = false,
  direction = 'up',
  count
} = {}) {
  const script = `
    const { runner } = require('node-pg-migrate');
    runner({
      databaseUrl: {
        user: ${JSON.stringify(process.env.DB_USER)},
        host: ${JSON.stringify(process.env.DB_HOST)},
        database: ${JSON.stringify(process.env.DB_NAME)},
        password: ${JSON.stringify(process.env.DB_PASSWORD)},
        port: ${JSON.stringify(process.env.DB_PORT)},
        ssl: false
      },
      dir: ${JSON.stringify(MIGRATIONS_DIR)},
      ${ignorePattern ? `ignorePattern: ${JSON.stringify(ignorePattern)},` : ''}
      schema: ${JSON.stringify(SCHEMA_NAME)},
      createSchema: ${JSON.stringify(createSchema)},
      migrationsTable: 'pgmigrations',
      migrationsSchema: ${JSON.stringify(SCHEMA_NAME)},
      createMigrationsSchema: ${JSON.stringify(createSchema)},
      direction: ${JSON.stringify(direction)},
      ${count !== undefined ? `count: ${JSON.stringify(count)},` : ''}
      verbose: false
    }).then(() => process.exit(0)).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  `;

  execFileSync(process.execPath, ['-e', script], {
    cwd: REPO_ROOT,
    stdio: 'inherit'
  });
}

describe('users.origin_org_id migration against real Postgres (task 13.5, Requirements 13.1, 13.2, 15.13)', () => {
  let pool;

  /** Snapshots of every column of every users row, keyed by phase. */
  const users = { before: null, afterUp: null };

  /** Ids captured during seeding, for the FK-behaviour test. */
  let originTeamId = null;
  let fkUserId = null;

  /** Populated in beforeAll so the down/up idempotence tests can assert. */
  let columnAfterDown = null;
  let indexAfterDown = null;
  let secondUpError = null;

  const q = (sql, params) => pool.query(sql, params);

  /**
   * `to_jsonb(row)` captures whatever columns the table actually has at
   * the moment of the call, which is the point: no column list here can
   * drift out of date as later migrations add columns.
   */
  async function snapshotUsers() {
    const { rows } = await q(
      `SELECT to_jsonb(u) AS row FROM "${SCHEMA_NAME}".users u ORDER BY u.id`
    );
    return rows.map((r) => r.row);
  }

  /** Drops the new column from a snapshot so pre/post can be diffed. */
  function withoutOriginOrgId(rows) {
    return rows.map((row) => {
      const copy = { ...row };
      delete copy.origin_org_id;
      return copy;
    });
  }

  async function columnExists() {
    const { rows } = await q(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'origin_org_id'`,
      [SCHEMA_NAME]
    );
    return rows[0] || null;
  }

  async function indexRow() {
    const { rows } = await q(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = $1 AND indexname = $2`,
      [SCHEMA_NAME, ORIGIN_ORG_ID_INDEX]
    );
    return rows[0] || null;
  }

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    });

    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `Real Postgres test database is not reachable at ` +
          `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} ` +
          `(user "${process.env.DB_USER}"). These migration tests (task 13.5) require a ` +
          `real, running Postgres instance. Underlying error: ${error.message}`,
        { cause: error }
      );
    }

    // --- Phase 1: the schema as it stands immediately before this migration ---
    runMigrationChain({
      ignorePattern: IGNORE_ORIGIN_ORG_ID_MIGRATION,
      createSchema: true
    });

    // Sanity: the migration under test did not run in the baseline chain,
    // so `users` genuinely has no origin_org_id column yet.
    const baselineColumn = await columnExists();
    if (baselineColumn !== null) {
      throw new Error(
        'Baseline migration chain unexpectedly created users.origin_org_id; ' +
          'the ignorePattern no longer matches the migration under test.'
      );
    }

    // --- Phase 2: seed pre-existing teams and users ---
    const { rows: teamRows } = await q(
      `INSERT INTO "${SCHEMA_NAME}".teams (name, description, callsign_prefix)
       VALUES ('OriginOrgId Test Org', 'seeded by task 13.5', 'OOI'),
              ('OriginOrgId Test Sub', 'seeded by task 13.5', 'OOS')
       RETURNING id`
    );
    // The Organisation root is the team the FK-behaviour test points a
    // user's provenance at and then deletes; the sub-team is a second
    // seeded team left untouched, so the delete is genuinely of one
    // referenced row and not "the only team".
    originTeamId = teamRows[0].id;

    // Four users spanning several column-presence shapes, so
    // "every other column value is unchanged" is asserted over a variety
    // of rows rather than a single uniform one.
    const { rows: userRows } = await q(
      `INSERT INTO "${SCHEMA_NAME}".users
         (username, email, first_name, last_name, is_global_manager, is_active)
       VALUES
         ('origin.test.full',   'origin.test.full@example.com',   'Full',   'Row',   false, true),
         ('origin.test.nonames','origin.test.nonames@example.com', NULL,     NULL,    false, true),
         ('origin.test.gm',     'origin.test.gm@example.com',     'Global', 'Manager', true,  true),
         ('origin.test.inactive','origin.test.inactive@example.com','In',    'Active', false, false)
       RETURNING id`
    );
    // The first seeded user is the one used for the FK-behaviour test.
    fkUserId = userRows[0].id;

    users.before = await snapshotUsers();

    // --- Phase 3: run the migration under test (up) ---
    runMigrationChain();
    users.afterUp = await snapshotUsers();

    // --- Phase 4: FK behaviour, ON DELETE SET NULL ---
    // Point one user's provenance at a real team, then delete the team.
    await q(
      `UPDATE "${SCHEMA_NAME}".users SET origin_org_id = $1 WHERE id = $2`,
      [originTeamId, fkUserId]
    );
    // The FK assertions read the post-delete state in their own `it`
    // blocks; the mutation itself happens in the FK-behaviour describe's
    // own beforeAll so the "before delete" state can be asserted too.

    // --- Phase 5: idempotence via down/up ---
    // These run last so they leave the schema in the migrated ("up")
    // state, matching a real deployment, though the schema is dropped in
    // afterAll regardless.
  }, 120000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_NAME}" CASCADE`);
      await pool.end();
    }

    process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
    process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
    process.env.DB_NAME = ORIGINAL_ENV.DB_NAME;
    process.env.DB_USER = ORIGINAL_ENV.DB_USER;
    process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
  });

  describe('the origin_org_id column and its index (Requirement 13.1)', () => {
    it('adds origin_org_id as a nullable integer column with no default', async () => {
      const column = await columnExists();
      expect(column).toEqual({
        column_name: 'origin_org_id',
        data_type: 'integer',
        is_nullable: 'YES',
        column_default: null
      });
    });

    it('creates the partial index over the non-null rows only', async () => {
      const index = await indexRow();
      expect(index).not.toBeNull();
      expect(index.indexname).toBe(ORIGIN_ORG_ID_INDEX);
      expect(index.indexdef).toContain('(origin_org_id)');
      expect(index.indexdef).toMatch(/WHERE .*origin_org_id IS NOT NULL/);
    });

    it('creates the teams(id) foreign key with ON DELETE SET NULL', async () => {
      const { rows } = await q(
        `SELECT rc.delete_rule, ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.referential_constraints rc
           ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = ccu.constraint_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = $1
           AND tc.table_name = 'users'
           AND kcu.column_name = 'origin_org_id'`,
        [SCHEMA_NAME]
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].delete_rule).toBe('SET NULL');
      expect(rows[0].referenced_table).toBe('teams');
      expect(rows[0].referenced_column).toBe('id');
    });
  });

  describe('additivity: pre-existing rows (Requirement 13.2)', () => {
    it('leaves every other column value on every pre-existing row unchanged', () => {
      expect(users.before).toHaveLength(4);
      expect(users.afterUp).toHaveLength(4);
      expect(withoutOriginOrgId(users.afterUp)).toEqual(users.before);
    });

    it('leaves the new origin_org_id column NULL on every pre-existing row', () => {
      for (const row of users.afterUp) {
        expect(row).toHaveProperty('origin_org_id', null);
      }
    });
  });

  describe('foreign key ON DELETE SET NULL behaviour (Requirement 13.1)', () => {
    let beforeDelete = null;

    beforeAll(async () => {
      // The seeded user's provenance was pointed at `originTeamId` in the
      // outer beforeAll. Confirm that starting state, then delete the
      // referenced Organisation (team) row.
      const before = await q(
        `SELECT id, origin_org_id FROM "${SCHEMA_NAME}".users WHERE id = $1`,
        [fkUserId]
      );
      beforeDelete = before.rows[0];

      await q(`DELETE FROM "${SCHEMA_NAME}".teams WHERE id = $1`, [originTeamId]);
    });

    it('had the user pointing at the referenced team before the delete', () => {
      expect(beforeDelete).toBeDefined();
      expect(beforeDelete.origin_org_id).toBe(originTeamId);
    });

    it('does not delete the user row when its referenced team is deleted', async () => {
      const { rows } = await q(
        `SELECT id FROM "${SCHEMA_NAME}".users WHERE id = $1`,
        [fkUserId]
      );
      expect(rows).toHaveLength(1);
    });

    it('sets origin_org_id back to NULL rather than vetoing the delete', async () => {
      const { rows } = await q(
        `SELECT origin_org_id FROM "${SCHEMA_NAME}".users WHERE id = $1`,
        [fkUserId]
      );
      expect(rows[0].origin_org_id).toBeNull();

      // And the referenced team really is gone -- the delete was not
      // blocked (RESTRICT/NO ACTION would have raised 23503 above).
      const teamRows = await q(
        `SELECT id FROM "${SCHEMA_NAME}".teams WHERE id = $1`,
        [originTeamId]
      );
      expect(teamRows.rows).toHaveLength(0);
    });
  });

  describe('idempotence: down then up (Requirement 15.13)', () => {
    beforeAll(async () => {
      // `down` drops the index then the column. Only the origin_org_id
      // migration is recorded as pending-reversible in this schema's
      // pgmigrations table (the baseline chain skipped it, then Phase 3
      // ran only it), so a single-step `down` reverses exactly this one.
      runMigrationChain({ direction: 'down', count: 1 });
      columnAfterDown = await columnExists();
      indexAfterDown = await indexRow();

      // Re-apply `up` and capture any error, to prove the re-create is
      // clean.
      try {
        runMigrationChain({ direction: 'up' });
      } catch (error) {
        secondUpError = error;
      }
    }, 120000);

    it('down cleanly drops both the column and the partial index', () => {
      expect(columnAfterDown).toBeNull();
      expect(indexAfterDown).toBeNull();
    });

    it('re-running up succeeds without error', () => {
      expect(secondUpError).toBeNull();
    });

    it('re-creates exactly one copy of the column and the partial index', async () => {
      const column = await columnExists();
      const index = await indexRow();

      expect(column).toEqual({
        column_name: 'origin_org_id',
        data_type: 'integer',
        is_nullable: 'YES',
        column_default: null
      });

      expect(index).not.toBeNull();
      expect(index.indexname).toBe(ORIGIN_ORG_ID_INDEX);
      expect(index.indexdef).toMatch(/WHERE .*origin_org_id IS NOT NULL/);

      // Exactly one index of that name -- a duplicate would show as a
      // second pg_indexes row.
      const { rows } = await q(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = $1 AND indexname = $2`,
        [SCHEMA_NAME, ORIGIN_ORG_ID_INDEX]
      );
      expect(rows).toHaveLength(1);
    });
  });
});
