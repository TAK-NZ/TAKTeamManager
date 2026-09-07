/**
 * Real-Postgres guards for the squashed baseline migration
 * (`database/migrations/*.cjs`, currently the single
 * `1790200000000_baseline-schema.cjs`).
 *
 * =====================================================================
 * WHY THIS FILE EXISTS
 * =====================================================================
 *
 * This repo periodically squashes its incremental migration chain into a
 * single new baseline file and deletes the superseded ones (most
 * recently: 10 incremental migrations folded into
 * `1790200000000_baseline-schema.cjs`, which replaced the earlier
 * `1789200000000_baseline-schema.cjs` squash, itself replacing one
 * before that). Two prior integration tests --
 * `server/config/migrations.originOrgId.integration.test.js` and
 * `server/config/migrations.teamTransfer.integration.test.js` -- named a
 * specific pre-squash migration file by its timestamp prefix
 * (`1786940000000_*`, `1786920000000_*`/`1786930000000_*`) and used
 * `ignorePattern` to run the chain up to "just before" that file, so they
 * could observe its effect in isolation. Both prefixes were already
 * absorbed into an EARLIER squash by the time this repo's migrations
 * directory reached its current state, so both files silently referenced
 * migration files that no longer existed and always failed. They were
 * deleted rather than repaired, because "run up to migration N-1, then
 * apply migration N in isolation" is a premise a single-file baseline
 * cannot satisfy -- there is no "migration N-1" once everything is one
 * file.
 *
 * What is NOT lost by deleting them: the write-once
 * `COALESCE(users.origin_org_id, EXCLUDED.origin_org_id)` provenance rule
 * is still covered by `UserProvisioningService.test.js`'s Property 19,
 * and the `origin_org_id` visibility disjunct is still covered by
 * `server/routes/users.directoryScope.integration.test.js`. What WAS
 * genuinely lost, and what this file replaces, is real-Postgres coverage
 * of three things only a live database can prove, scoped generically to
 * "whatever the current baseline produces" rather than to any specific
 * migration filename -- so, like `callsignPrefixNullable.test.js`, this
 * file keeps working unmodified across a future squash:
 *
 *   1. The `users.origin_org_id -> teams(id)` foreign key really is
 *      `ON DELETE SET NULL`, not `CASCADE` (which would delete the user)
 *      or `RESTRICT`/`NO ACTION` (which would block the delete). This is
 *      pure Postgres behaviour -- nothing in `server/` decides it, so
 *      nothing in `server/`'s unit tests can catch a future accidental
 *      edit to that clause.
 *   2. Every seed block in the baseline's `up()` is genuinely re-run-safe
 *      (`ON CONFLICT DO NOTHING` / an equivalently guarded `UPDATE`): an
 *      operator who has customised a seeded `site_config`/
 *      `email_templates` row must not have that customisation clobbered
 *      by a later migration run. `database/init.js`'s own seed inserts
 *      carry the same guarantee and are exercised the same way.
 *   3. The baseline's `down()` actually reverses what its `up()` created
 *      -- dropping every table `up()` created (and the shared trigger
 *      function), leaving nothing behind. This was previously unverified
 *      by anything automated; the two prior tests only ever drove `down`
 *      on migrations far more narrow than a full baseline.
 *
 * =====================================================================
 * METHOD
 * =====================================================================
 *
 * Each guard below runs against its OWN dedicated, uniquely-named
 * throwaway Postgres *database* (`CREATE DATABASE ... ` on the same
 * server the other `*.integration.test.js` files connect to), dropped in
 * its own `afterAll` regardless of pass/fail.
 *
 * This is a deliberate DEPARTURE from the "dedicated schema inside the
 * shared test database" convention `database/schemaConsistency.integration.test.js`
 * and the two now-deleted `migrations.*.integration.test.js` files used:
 * that trick relies on node-pg-migrate's `schema` option pointing
 * `search_path` at the throwaway schema so every UNQUALIFIED
 * `CREATE TABLE foo (...)` in a migration lands there instead of
 * `public`. The current baseline (`1790200000000_baseline-schema.cjs`)
 * is a cleaned `pg_dump --schema-only` copy (see that file's own header
 * comment), and `pg_dump` always schema-qualifies every statement
 * (`CREATE TABLE public.foo (...)`, `CREATE FUNCTION public.bar() ...`)
 * -- so `search_path` has no effect and every run collides with the real
 * `public` schema objects already present on the shared test database,
 * regardless of the `schema` option. (This also means
 * `database/schemaConsistency.integration.test.js` itself has been
 * broken by this same cause since the PRIOR squash introduced
 * schema-qualified DDL; that is a pre-existing defect this file does not
 * attempt to fix.) A dedicated throwaway DATABASE has no such collision:
 * its own `public` schema starts empty, so `public.foo` resolves exactly
 * where a real deployment's does.
 *
 * `node -e` child process rather than `require('node-pg-migrate')`:
 * `node-pg-migrate` v9 is pure ESM and cannot be `require()`d through
 * Jest's CommonJS transform (documented at length in
 * `database/schemaConsistency.integration.test.js`). Every migration run
 * below shells out to a small inline Node script that performs only the
 * `runner()` call; every assertion is a plain `pg` query run from inside
 * Jest.
 *
 * The three throwaway-database primitives (`createThrowawayDatabase`,
 * `dropThrowawayDatabase`, the underlying `runMigrationChain`) live in
 * `database/testHelpers/throwawayDatabase.js`, shared with
 * `server/services/teamMembershipInvariants.model.integration.test.js`'s
 * stateful/model-based fast-check test -- this file no longer defines
 * its own copies.
 *
 * Scoped generically to every `.cjs` file present in
 * `database/migrations/` (there is currently exactly one), not to a
 * named baseline filename -- the migration chain simply runs `direction:
 * 'up'`/`'down'` with no `ignorePattern`, so this file requires no edit
 * the next time this repo re-squashes.
 *
 * Connection convention: `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD` are
 * read from the environment if already set, otherwise defaulted to the
 * local Docker-based test container (`tak_migration_test_501`, Postgres
 * 15, host port 15433, user `postgres`, password `postgres123`),
 * matching every other `*.integration.test.js` file in this repo.
 * `DB_NAME` itself is NOT reused from the environment/default here --
 * each guard creates and connects to its own uniquely-named throwaway
 * database instead, via an admin connection to the server's `postgres`
 * maintenance database. Original env vars are restored in each
 * `afterAll`.
 *
 * Run explicitly (this file is excluded from `npm test` by
 * `testPathIgnorePatterns`):
 *
 *   npx jest database/migrations/__tests__/baselineMigration.integration.test.js \
 *     --testPathIgnorePatterns=/node_modules/ /client/
 */

const path = require('path');
const {
  createThrowawayDatabase,
  dropThrowawayDatabase,
  runMigrationChain: runMigrationChainAgainst
} = require('../../testHelpers/throwawayDatabase');

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

const MIGRATIONS_DIR = path.join(__dirname, '..');

function restoreEnv() {
  process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
  process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
  process.env.DB_USER = ORIGINAL_ENV.DB_USER;
  process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
}

/**
 * Thin wrapper binding `database/testHelpers/throwawayDatabase.js`'s
 * generic `runMigrationChain(dbName, migrationsDir, options)` to THIS
 * file's own `MIGRATIONS_DIR`, so every call site below reads exactly as
 * it did before this helper was extracted (`runMigrationChain(DB_NAME)` /
 * `runMigrationChain(DB_NAME, { direction: 'down', count })`).
 *
 * @param {string} dbName
 * @param {object} [options]
 * @param {'up'|'down'} [options.direction]
 * @param {number} [options.count] Only used for `down`.
 */
function runMigrationChain(dbName, options) {
  runMigrationChainAgainst(dbName, MIGRATIONS_DIR, options);
}

describe('users.origin_org_id -> teams(id) foreign key is ON DELETE SET NULL', () => {
  const DB_NAME = `baseline_fk_test_${Date.now()}`;
  let pool;
  let teamId;
  let userId;

  beforeAll(async () => {
    pool = await createThrowawayDatabase(DB_NAME, 'The origin_org_id FK guard');
    runMigrationChain(DB_NAME);

    const { rows: teamRows } = await pool.query(
      `INSERT INTO teams (name, description)
       VALUES ('FK Guard Test Org', 'seeded by baselineMigration.integration.test.js')
       RETURNING id`
    );
    teamId = teamRows[0].id;

    const { rows: userRows } = await pool.query(
      `INSERT INTO users (username, email, origin_org_id)
       VALUES ('fk.guard.test.user', 'fk.guard.test.user@example.com', $1)
       RETURNING id`,
      [teamId]
    );
    userId = userRows[0].id;
  }, 120000);

  afterAll(async () => {
    if (pool) await pool.end();
    await dropThrowawayDatabase(DB_NAME);
    restoreEnv();
  });

  it('the referential constraint is declared ON DELETE SET NULL (anti-vacuity: the constraint exists at all)', async () => {
    const { rows } = await pool.query(
      `SELECT rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.referential_constraints rc
         ON tc.constraint_name = rc.constraint_name AND tc.constraint_schema = rc.constraint_schema
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = 'public'
         AND tc.table_name = 'users'
         AND kcu.column_name = 'origin_org_id'`
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].delete_rule).toBe('SET NULL');
  });

  it('the seeded user really was pointing at the seeded team before the delete (anti-vacuity)', async () => {
    const { rows } = await pool.query(
      `SELECT origin_org_id FROM users WHERE id = $1`,
      [userId]
    );
    expect(rows[0].origin_org_id).toBe(teamId);
  });

  it('deleting the referenced team does not delete the user row, and resets origin_org_id to NULL', async () => {
    await pool.query(`DELETE FROM teams WHERE id = $1`, [teamId]);

    const { rows } = await pool.query(
      `SELECT id, origin_org_id FROM users WHERE id = $1`,
      [userId]
    );

    // Not deleted: a CASCADE clause would have removed this row too.
    expect(rows).toHaveLength(1);
    // Reset to NULL: a RESTRICT/NO ACTION clause would instead have
    // raised a foreign-key violation on the DELETE above, never reaching
    // this assertion.
    expect(rows[0].origin_org_id).toBeNull();
  });
});

/**
 * Every migration file's `up()` is a sequence of `pgm.sql(...)` calls
 * (see `1790200000000_baseline-schema.cjs`'s own header comment: raw SQL
 * via `pgm.sql(...)` rather than the schema-builder API, for byte-for-byte
 * `pg_dump` fidelity). Unlike the pure-DDL block(s), every SEED block in
 * this codebase's convention is written `ON CONFLICT ... DO NOTHING` (or,
 * for the two content UPDATEs still folded into `database/init.js`
 * rather than the migration itself, an equivalently guarded `WHERE`) --
 * that is the textual signature this codebase already uses to mark "this
 * statement is meant to be safe to run again". Extracting exactly the
 * blocks containing `ON CONFLICT` is therefore a content-based rule, not
 * a position- or filename-based one: it survives a future squash whether
 * the seed blocks move, get reordered, or get split across more than one
 * migration file, because it is the SQL text's own idempotency marker
 * being tested, not where it happens to live.
 *
 * The migration file is loaded via plain `require()` (it is CommonJS,
 * unlike `node-pg-migrate` itself -- see the file-level comment on why
 * `node-pg-migrate` needs the child-process workaround but this does
 * not), with a minimal mock `pgm` whose `.sql()` just records the SQL
 * text passed to it, so `up()` runs with no real database connection at
 * all during EXTRACTION -- only the later re-execution touches the
 * throwaway database.
 */
function extractSeedSqlBlocks() {
  const fs = require('fs');
  const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.cjs'));

  const seedBlocks = [];
  for (const file of migrationFiles) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const migration = require(path.join(MIGRATIONS_DIR, file));
    if (typeof migration.up !== 'function') continue;

    const recordedSql = [];
    const mockPgm = { sql: (text) => recordedSql.push(text) };
    migration.up(mockPgm);

    for (const sql of recordedSql) {
      // A seed block is an ON CONFLICT-guarded DATA statement. The DDL block
      // must be excluded even though it may itself CONTAIN the phrase "ON
      // CONFLICT" -- the baseline's cleaned pg_dump text includes a
      // `COMMENT ON INDEX ... 'Enqueue uses ON CONFLICT DO NOTHING ...'` whose
      // human-readable comment body trips a bare /ON CONFLICT/ match. A block
      // that creates schema objects (CREATE TABLE/FUNCTION/SEQUENCE, ALTER
      // TABLE) is DDL, not a re-runnable seed, so it is filtered out here.
      const isDdl = /\bCREATE (TABLE|FUNCTION|SEQUENCE|INDEX|TRIGGER)\b|\bALTER (TABLE|SEQUENCE)\b/i.test(sql);
      if (/ON CONFLICT/i.test(sql) && !isDdl) {
        seedBlocks.push(sql);
      }
    }
  }
  return seedBlocks;
}

describe('baseline seed blocks are re-run-safe: a customised seeded row survives being re-run', () => {
  const DB_NAME = `baseline_seed_idempotence_test_${Date.now()}`;
  let pool;
  let seedBlocks;

  /** Deliberately different from anything the baseline's own seed text
   * would insert, so "left unchanged" is distinguishable from
   * "overwritten with the migration's own text". */
  const CUSTOM_SITE_CONFIG_VALUE = 'OPERATOR CUSTOMISED VALUE - do not overwrite';
  const CUSTOM_TEMPLATE_SUBJECT = 'OPERATOR CUSTOMISED SUBJECT - do not overwrite';

  beforeAll(async () => {
    pool = await createThrowawayDatabase(DB_NAME, 'The seed-idempotence guard');
    runMigrationChain(DB_NAME);
    seedBlocks = extractSeedSqlBlocks();
  }, 120000);

  afterAll(async () => {
    if (pool) await pool.end();
    await dropThrowawayDatabase(DB_NAME);
    restoreEnv();
  });

  it('found at least one ON CONFLICT-guarded seed block, and at least one seeded site_config/email_templates row to customise (anti-vacuity)', async () => {
    expect(seedBlocks.length).toBeGreaterThan(0);

    const siteConfig = await pool.query(`SELECT config_key FROM site_config LIMIT 1`);
    const emailTemplates = await pool.query(`SELECT template_key FROM email_templates LIMIT 1`);
    expect(siteConfig.rows.length).toBeGreaterThan(0);
    expect(emailTemplates.rows.length).toBeGreaterThan(0);
  });

  it('a customised value on EVERY seeded site_config/email_templates row survives every ON CONFLICT-guarded seed block being re-executed', async () => {
    // Every currently-seeded row is customised, not just one -- there are
    // several separate ON-CONFLICT-guarded seed blocks (one per former
    // migration; see the baseline file's own numbered comments), each
    // touching a different subset of rows. Customising only a single,
    // arbitrarily-picked row (`LIMIT 1` with no deterministic ordering)
    // would make this guard's bite depend on which block happened to own
    // that row -- a regression in a DIFFERENT block would pass unnoticed.
    // Customising every row removes that non-determinism: a regression
    // in ANY block's guard is caught regardless of row order.
    const { rows: siteConfigRows } = await pool.query(`SELECT config_key FROM site_config`);
    const { rows: templateRows } = await pool.query(`SELECT template_key FROM email_templates`);

    await pool.query(`UPDATE site_config SET config_value = $1`, [CUSTOM_SITE_CONFIG_VALUE]);
    await pool.query(`UPDATE email_templates SET subject_template = $1`, [CUSTOM_TEMPLATE_SUBJECT]);

    // Re-execute the REAL seed SQL text a second time, directly -- not
    // via node-pg-migrate (which would skip already-recorded migrations
    // unless pgmigrations rows were removed, and removing them would
    // force the migration's non-idempotent DDL portion to run again too,
    // which fails outright against a schema that already has every
    // table -- that failure is expected and is not this guard's concern).
    for (const sql of seedBlocks) {
      await pool.query(sql);
    }

    const { rows: afterSiteConfig } = await pool.query(
      `SELECT config_key, config_value FROM site_config
       WHERE config_key = ANY($1::text[])`,
      [siteConfigRows.map((r) => r.config_key)]
    );
    const { rows: afterTemplates } = await pool.query(
      `SELECT template_key, subject_template FROM email_templates
       WHERE template_key = ANY($1::text[])`,
      [templateRows.map((r) => r.template_key)]
    );

    for (const row of afterSiteConfig) {
      expect(row.config_value).toBe(CUSTOM_SITE_CONFIG_VALUE);
    }
    for (const row of afterTemplates) {
      expect(row.subject_template).toBe(CUSTOM_TEMPLATE_SUBJECT);
    }
  });
});

describe('down() reverses everything up() created', () => {
  const DB_NAME = `baseline_down_smoke_test_${Date.now()}`;
  let pool;
  let migrationCount;

  function nonMigrationsTableCount() {
    return pool.query(
      `SELECT count(*)::int AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> 'pgmigrations'`
    );
  }

  beforeAll(async () => {
    pool = await createThrowawayDatabase(DB_NAME, 'The down() smoke test');
    runMigrationChain(DB_NAME);

    const { rows } = await pool.query(`SELECT count(*)::int AS count FROM pgmigrations`);
    migrationCount = rows[0].count;
  }, 120000);

  afterAll(async () => {
    if (pool) await pool.end();
    await dropThrowawayDatabase(DB_NAME);
    restoreEnv();
  });

  it('up() created at least one non-pgmigrations table (anti-vacuity)', async () => {
    const { rows } = await nonMigrationsTableCount();
    expect(rows[0].count).toBeGreaterThan(0);
  });

  it('running down() for every applied migration leaves no non-pgmigrations table behind', async () => {
    runMigrationChain(DB_NAME, { direction: 'down', count: migrationCount });

    const { rows } = await nonMigrationsTableCount();
    expect(rows[0].count).toBe(0);
  });

  it('running down() also drops the shared update_updated_at_column() trigger function', async () => {
    const { rows } = await pool.query(
      `SELECT proname FROM pg_proc
       JOIN pg_namespace ON pg_proc.pronamespace = pg_namespace.oid
       WHERE pg_namespace.nspname = 'public' AND proname = 'update_updated_at_column'`
    );
    expect(rows).toHaveLength(0);
  });
});
