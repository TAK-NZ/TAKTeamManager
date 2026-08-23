/**
 * Real-Postgres migration tests for the two Team_Transfer migrations
 * (task 1.3, Requirements 3.2 and 13.2):
 *
 *   3.2 -- "THE App SHALL add `approval_team_id` and `initiated_by` to
 *   `access_requests` as nullable columns with no default, leaving every
 *   pre-existing row's other column values unchanged."
 *
 *   13.2 -- "THE App SHALL seed a `team_transfer_completed`
 *   `email_templates` row, leaving an existing row with that
 *   `template_key` unchanged."
 *
 * Both claims are about what happens to *pre-existing data*, so neither
 * can be verified by reading the migration source or by mocking `pool`:
 * the only way to observe "every other column value is unchanged" is to
 * put rows in a real table, run the real migration against them, and
 * diff. That is what this file does.
 *
 * Method (mirrors `database/schemaConsistency.integration.test.js`, which
 * is the existing precedent in this repo for running the migration chain
 * from a test):
 *
 *   1. Create a dedicated, uniquely-named Postgres *schema* in the shared
 *      test database and run the migration chain into it with the two
 *      Team_Transfer migrations excluded via `ignorePattern`. That leaves
 *      a schema in exactly the state a real deployment is in immediately
 *      before this feature ships.
 *   2. Seed `teams`, `users`, four `access_requests` rows spanning every
 *      `request_type`/`status` combination that matters here (including a
 *      pending `team_change` row, so the new *unique* partial index is
 *      built over data it actually covers), and an `email_templates` row
 *      that already holds the `team_transfer_completed` key with
 *      deliberately different subject/body/description text.
 *   3. Snapshot every row of both tables as `jsonb`, so the comparison is
 *      over *all* columns rather than a hand-maintained column list --
 *      later migrations have already added columns to `access_requests`
 *      (`callsign_suffix`, `signup_code_used`) and a hardcoded list would
 *      silently stop covering them.
 *   4. Run the two Team_Transfer migrations, snapshot again, and diff.
 *   5. Delete the two rows the runner wrote to `pgmigrations` and run
 *      them a second time. Without that deletion `node-pg-migrate` simply
 *      skips already-recorded migrations, so re-running the chain would
 *      prove nothing about the migration bodies; forcing the bodies to
 *      execute a second time against a schema that already has the
 *      columns, the indexes and the template row is what actually
 *      exercises their `ifNotExists` / `ON CONFLICT DO NOTHING` guards.
 *   6. Snapshot a third time and diff again.
 *
 * All of steps 1-6 run once in `beforeAll` and the individual tests then
 * assert against the captured snapshots. Doing the mutation up front (as
 * opposed to one phase per test) keeps the tests independent of Jest's
 * declaration-order execution -- nothing here silently changes meaning if
 * a test is reordered or run with `-t`.
 *
 * `node -e` child process rather than `require('node-pg-migrate')`:
 * `node-pg-migrate` v9 is pure ESM and cannot be `require()`d through
 * Jest's CommonJS transform (documented at length in
 * `database/schemaConsistency.integration.test.js`). The child script
 * performs only the `runner()` call; every assertion below is a plain
 * `pg` query.
 *
 * The throwaway schema is dropped in `afterAll` regardless of pass or
 * fail, so nothing is left behind in the shared test database. Neither
 * migration file is modified by this test.
 *
 * Connection convention: `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/
 * `DB_PASSWORD` are read from the environment if already set, otherwise
 * defaulted to the local Docker-based test container
 * (`tak_migration_test_501`, Postgres 15, host port 15433, database
 * `tak_team_manager`, user `postgres`, password `postgres123`), matching
 * the top of `server/routes/requests.approval.integration.test.js`.
 * They are restored in `afterAll`.
 *
 * Run explicitly (this file is excluded from `npm test` by
 * `testPathIgnorePatterns`):
 *
 *   npx jest server/config/migrations.teamTransfer.integration.test.js \
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

const SCHEMA_NAME = `team_transfer_migration_test_${Date.now()}`;

/** The two migrations under test, by filename timestamp prefix. */
const TRANSFER_COLUMNS_PREFIX = '1786920000000';
const TEMPLATE_SEED_PREFIX = '1786930000000';

/**
 * `ignorePattern` is anchored by node-pg-migrate as `^<pattern>$` against
 * each directory entry's base name (see
 * `node_modules/node-pg-migrate/dist/legacy/migration.js`), and supplying
 * it *replaces* the built-in `^\..*` default -- hence the explicit
 * dot-file branch, without which `database/migrations/.gitkeep` would be
 * loaded as a migration.
 */
const IGNORE_TRANSFER_MIGRATIONS =
  `(\\..*|${TRANSFER_COLUMNS_PREFIX}_.*|${TEMPLATE_SEED_PREFIX}_.*)`;

const APPROVAL_TEAM_PENDING_INDEX = 'idx_access_requests_approval_team_pending';
const ONE_PENDING_TEAM_CHANGE_PER_USER_INDEX =
  'idx_access_requests_one_pending_team_change_per_user';

const TEMPLATE_KEY = 'team_transfer_completed';

/**
 * Deliberately different from the values the seed migration would insert,
 * so "left unchanged" is distinguishable from "overwritten with the
 * migration's own text".
 */
const PRE_EXISTING_TEMPLATE = {
  subject: 'PRE-EXISTING SUBJECT - operator customised',
  body: 'PRE-EXISTING BODY for {{first_name}} - operator customised',
  description: 'PRE-EXISTING DESCRIPTION'
};

/**
 * Runs the migration chain into SCHEMA_NAME out-of-process, using the
 * same `runner()` entry point `database/init.js` uses.
 *
 * @param {object} [options]
 * @param {string} [options.ignorePattern] Base-name regex of migration
 *   files to skip.
 * @param {boolean} [options.createSchema] Whether the schema may need
 *   creating (only true for the first, baseline run).
 */
function runMigrationChain({ ignorePattern, createSchema = false } = {}) {
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
      direction: 'up',
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

describe('Team_Transfer migrations against real Postgres (task 1.3, Requirements 3.2, 13.2)', () => {
  let pool;

  /** Snapshots of every column of every row, keyed by phase. */
  const accessRequests = { before: null, afterFirstRun: null, afterSecondRun: null };
  const emailTemplates = { before: null, afterFirstRun: null, afterSecondRun: null };

  /** Populated in beforeAll so the idempotence test can assert on it. */
  let recordedMigrationsRemoved = null;
  let secondRunError = null;

  const q = (sql, params) => pool.query(sql, params);

  /**
   * `to_jsonb(row)` captures whatever columns the table actually has at
   * the moment of the call, which is the point: no column list here can
   * drift out of date as later migrations add columns.
   */
  async function snapshotAccessRequests() {
    const { rows } = await q(
      `SELECT to_jsonb(ar) AS row FROM "${SCHEMA_NAME}".access_requests ar ORDER BY ar.id`
    );
    return rows.map((r) => r.row);
  }

  async function snapshotEmailTemplates() {
    const { rows } = await q(
      `SELECT to_jsonb(et) AS row FROM "${SCHEMA_NAME}".email_templates et ORDER BY et.template_key`
    );
    return rows.map((r) => r.row);
  }

  /** Drops the two new columns from a snapshot so pre/post can be diffed. */
  function withoutTransferColumns(rows) {
    return rows.map((row) => {
      const copy = { ...row };
      delete copy.approval_team_id;
      delete copy.initiated_by;
      return copy;
    });
  }

  function templateRow(rows) {
    return rows.find((row) => row.template_key === TEMPLATE_KEY);
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
          `(user "${process.env.DB_USER}"). These migration tests (task 1.3) require a ` +
          `real, running Postgres instance. Underlying error: ${error.message}`,
        { cause: error }
      );
    }

    // --- Phase 1: the schema as it stands immediately before this feature ---
    runMigrationChain({
      ignorePattern: IGNORE_TRANSFER_MIGRATIONS,
      createSchema: true
    });

    // Sanity: neither migration under test ran in the baseline chain.
    const baselineColumns = await q(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'access_requests'
         AND column_name IN ('approval_team_id', 'initiated_by')`,
      [SCHEMA_NAME]
    );
    if (baselineColumns.rowCount !== 0) {
      throw new Error(
        'Baseline migration chain unexpectedly created approval_team_id/initiated_by; ' +
          'the ignorePattern no longer matches the migrations under test.'
      );
    }

    // --- Phase 2: seed pre-existing data ---
    const { rows: teamRows } = await q(
      `INSERT INTO "${SCHEMA_NAME}".teams (name, description, callsign_prefix)
       VALUES ('Migration Test Org', 'seeded by task 1.3', 'MTO'),
              ('Migration Test Sub', 'seeded by task 1.3', 'MTS')
       RETURNING id`
    );
    const [sourceTeamId, destinationTeamId] = teamRows.map((r) => r.id);

    const { rows: userRows } = await q(
      `INSERT INTO "${SCHEMA_NAME}".users (username, email, first_name, last_name)
       VALUES ('migration.test.user', 'migration.test.user@example.com', 'Mig', 'Test')
       RETURNING id`
    );
    const seededUserId = userRows[0].id;

    // Four rows spanning every request_type, and a status mix. The
    // pending `team_change` row matters most: it is the only seeded row
    // the new *unique* partial index covers, so its presence proves the
    // index can be built over pre-existing matching data.
    await q(
      `INSERT INTO "${SCHEMA_NAME}".access_requests
         (request_type, requester_email, requester_first_name, requester_last_name,
          existing_user_id, target_team_id, current_team_id, requested_role,
          requested_first_name, requested_last_name, justification, status,
          email_verified, escalation_level, denial_reason)
       VALUES
         ('new_account', 'new.account@example.com', 'New', 'Account',
          NULL, $1, NULL, 'member', NULL, NULL, 'wants access', 'pending',
          true, 0, NULL),
         ('role_change', 'role.change@example.com', 'Role', 'Change',
          $2, NULL, $3, 'admin', NULL, NULL, 'promote me', 'approved',
          true, 1, NULL),
         ('team_change', 'legacy.transfer@example.com', 'Legacy', 'Transfer',
          $2, $1, $3, NULL, NULL, NULL, 'legacy pre-feature row', 'pending',
          true, 0, NULL),
         ('name_change', 'name.change@example.com', 'Name', 'Change',
          $2, NULL, $3, NULL, 'Newfirst', 'Newlast', 'legal name change', 'denied',
          false, 2, 'not verified')`,
      [destinationTeamId, seededUserId, sourceTeamId]
    );

    await q(
      `INSERT INTO "${SCHEMA_NAME}".email_templates
         (template_key, subject_template, body_template, description)
       VALUES ($1, $2, $3, $4)`,
      [TEMPLATE_KEY, PRE_EXISTING_TEMPLATE.subject, PRE_EXISTING_TEMPLATE.body,
        PRE_EXISTING_TEMPLATE.description]
    );

    accessRequests.before = await snapshotAccessRequests();
    emailTemplates.before = await snapshotEmailTemplates();

    // --- Phase 3: run the two migrations under test ---
    runMigrationChain();
    accessRequests.afterFirstRun = await snapshotAccessRequests();
    emailTemplates.afterFirstRun = await snapshotEmailTemplates();

    // --- Phase 4: force both migration bodies to execute a second time ---
    const removal = await q(
      `DELETE FROM "${SCHEMA_NAME}".pgmigrations
       WHERE name LIKE $1 OR name LIKE $2`,
      [`${TRANSFER_COLUMNS_PREFIX}%`, `${TEMPLATE_SEED_PREFIX}%`]
    );
    recordedMigrationsRemoved = removal.rowCount;

    try {
      runMigrationChain();
    } catch (error) {
      secondRunError = error;
    }

    accessRequests.afterSecondRun = await snapshotAccessRequests();
    emailTemplates.afterSecondRun = await snapshotEmailTemplates();
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

  describe('access_requests transfer columns (Requirement 3.2)', () => {
    it('adds approval_team_id and initiated_by as nullable integer columns with no default', async () => {
      const { rows } = await q(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'access_requests'
           AND column_name IN ('approval_team_id', 'initiated_by')
         ORDER BY column_name`,
        [SCHEMA_NAME]
      );

      expect(rows).toEqual([
        { column_name: 'approval_team_id', data_type: 'integer', is_nullable: 'YES', column_default: null },
        { column_name: 'initiated_by', data_type: 'integer', is_nullable: 'YES', column_default: null }
      ]);
    });

    it('creates both partial indexes over pending team_change rows', async () => {
      const { rows } = await q(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = $1 AND indexname = ANY($2::text[])
         ORDER BY indexname`,
        [SCHEMA_NAME, [APPROVAL_TEAM_PENDING_INDEX, ONE_PENDING_TEAM_CHANGE_PER_USER_INDEX]]
      );

      expect(rows.map((r) => r.indexname)).toEqual([
        APPROVAL_TEAM_PENDING_INDEX,
        ONE_PENDING_TEAM_CHANGE_PER_USER_INDEX
      ]);

      const [approvalTeamIndex, onePendingIndex] = rows;

      expect(approvalTeamIndex.indexdef).toContain('(approval_team_id)');
      expect(approvalTeamIndex.indexdef).not.toMatch(/CREATE UNIQUE INDEX/);
      expect(approvalTeamIndex.indexdef).toMatch(/WHERE .*'pending'/);
      expect(approvalTeamIndex.indexdef).toMatch(/WHERE .*'team_change'/);

      expect(onePendingIndex.indexdef).toMatch(/CREATE UNIQUE INDEX/);
      expect(onePendingIndex.indexdef).toContain('(existing_user_id)');
      expect(onePendingIndex.indexdef).toMatch(/WHERE .*'pending'/);
      expect(onePendingIndex.indexdef).toMatch(/WHERE .*'team_change'/);
    });

    it('leaves every other column value on every pre-existing row unchanged', () => {
      expect(accessRequests.before).toHaveLength(4);
      expect(accessRequests.afterFirstRun).toHaveLength(4);
      expect(withoutTransferColumns(accessRequests.afterFirstRun)).toEqual(accessRequests.before);
    });

    it('leaves both new columns NULL on every pre-existing row', () => {
      for (const row of accessRequests.afterFirstRun) {
        expect(row).toHaveProperty('approval_team_id', null);
        expect(row).toHaveProperty('initiated_by', null);
      }
    });
  });

  describe('team_transfer_completed email template (Requirement 13.2)', () => {
    it('leaves a pre-existing row with that template_key completely untouched', () => {
      const seeded = templateRow(emailTemplates.before);
      const after = templateRow(emailTemplates.afterFirstRun);

      expect(seeded).toBeDefined();
      expect(after).toEqual(seeded);
      expect(after.subject_template).toBe(PRE_EXISTING_TEMPLATE.subject);
      expect(after.body_template).toBe(PRE_EXISTING_TEMPLATE.body);
      expect(after.description).toBe(PRE_EXISTING_TEMPLATE.description);
    });

    it('leaves every other pre-existing email_templates row unchanged and inserts no duplicate', () => {
      expect(emailTemplates.afterFirstRun).toEqual(emailTemplates.before);

      const matching = emailTemplates.afterFirstRun.filter(
        (row) => row.template_key === TEMPLATE_KEY
      );
      expect(matching).toHaveLength(1);
    });
  });

  describe('idempotence: both migrations run a second time', () => {
    it('re-executes both migration bodies (the pgmigrations records were removed first)', () => {
      expect(recordedMigrationsRemoved).toBe(2);
      expect(secondRunError).toBeNull();
    });

    it('changes no access_requests row and adds no further column', () => {
      expect(accessRequests.afterSecondRun).toEqual(accessRequests.afterFirstRun);
    });

    it('changes no email_templates row and adds no duplicate template', () => {
      expect(emailTemplates.afterSecondRun).toEqual(emailTemplates.afterFirstRun);

      const matching = emailTemplates.afterSecondRun.filter(
        (row) => row.template_key === TEMPLATE_KEY
      );
      expect(matching).toHaveLength(1);
    });

    it('leaves exactly one copy of each partial index', async () => {
      const { rows } = await q(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = $1 AND indexname = ANY($2::text[])`,
        [SCHEMA_NAME, [APPROVAL_TEAM_PENDING_INDEX, ONE_PENDING_TEAM_CHANGE_PER_USER_INDEX]]
      );

      expect(rows).toHaveLength(2);
    });
  });
});
