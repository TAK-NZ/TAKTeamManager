/**
 * Real-Postgres migration smoke test for the Account_Status migration
 * `database/migrations/1788200000000_account-lifecycle-status.cjs`
 * (account-lifecycle-management task 1.2).
 *
 * Verifies claims about the shape of the schema a real deployment ends up
 * with after `npm run migrate:up`, which cannot be confirmed by reading the
 * migration source alone or by mocking `pool`: whether the column, its CHECK
 * constraint, its default, and its partial index actually exist -- and that
 * the constraint actually rejects a fourth value -- can only be observed by
 * running the real migration chain against a real Postgres instance and
 * interrogating the catalogs. That is what this file does.
 *
 * Throwaway *database*, not a throwaway *schema*, for the same reason
 * `tak-devices.integration.test.js` uses one (see that file's own comment):
 * the baseline migration and this one both qualify every object as
 * `public.<name>`, which bypasses `search_path` entirely, so a
 * schema-redirected run would still land in `public` and pollute the shared
 * test database.
 *
 * `node -e` child process rather than `require('node-pg-migrate')`, for the
 * same ESM-incompatibility reason documented in
 * `database/schemaConsistency.integration.test.js` and reused verbatim by
 * `tak-devices.integration.test.js`.
 *
 * Skipped rather than failed when no test database is reachable, via the
 * same `describeWithDatabase` connectivity-probe pattern. `testPathIgnorePatterns`
 * already excludes every `*.integration.test.js` file from `npm test`.
 *
 * Run explicitly:
 *
 *   npx jest database/migrations/__tests__/account-lifecycle-status.integration.test.js \
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

const MIGRATIONS_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(__dirname, '..', '..', '..');

/** The maintenance database used only to CREATE/DROP the throwaway one. */
const MAINTENANCE_DB = process.env.DB_NAME;

/**
 * Lower-case and free of anything needing quoting, so it is a legal
 * Postgres identifier; still uniquely named so concurrent runs cannot
 * collide.
 */
const THROWAWAY_DB = `tak_account_status_migration_test_${Date.now()}`;

const TABLE = 'users';
const COLUMN = 'account_status';
const CHECK_CONSTRAINT = 'users_account_status_check';
const PARTIAL_INDEX = 'idx_users_account_status';
const MIGRATION_NAME = '1788200000000_account-lifecycle-status';

/** Connection settings for an arbitrary database on the test server. */
function connection(database) {
  return {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: false
  };
}

/**
 * Runs a small script in a child Node process. Used both for the
 * connectivity probe (so it can be synchronous at module load) and for
 * the `node-pg-migrate` chain (so Jest's CommonJS transform never has to
 * load that ESM-only package).
 *
 * @param {string} script Source passed to `node -e`.
 * @param {'inherit'|'ignore'} stdio
 */
function runNodeScript(script, stdio = 'inherit') {
  execFileSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, stdio });
}

/**
 * Synchronous connectivity probe. Returns true when the configured test
 * Postgres accepts a connection to the maintenance database.
 */
function testDatabaseReachable() {
  try {
    runNodeScript(
      `
      const { Client } = require('pg');
      const client = new Client(${JSON.stringify(connection(MAINTENANCE_DB))});
      client.connect()
        .then(() => client.query('SELECT 1'))
        .then(() => client.end())
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
      `,
      'ignore'
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the migration chain into the throwaway database, using the same
 * `runner()` entry point `database/init.js` uses. Nothing is excluded: the
 * point of this test is the schema a real deployment ends up with after the
 * whole chain, this migration included.
 *
 * @param {object} [options]
 * @param {'up'|'down'} [options.direction]
 * @param {number} [options.count]
 */
function runMigrationChain({ direction = 'up', count } = {}) {
  runNodeScript(`
    const { runner } = require('node-pg-migrate');
    runner({
      databaseUrl: ${JSON.stringify(connection(THROWAWAY_DB))},
      dir: ${JSON.stringify(MIGRATIONS_DIR)},
      migrationsTable: 'pgmigrations',
      direction: ${JSON.stringify(direction)},
      ${count !== undefined ? `count: ${JSON.stringify(count)},` : ''}
      verbose: false
    }).then(() => process.exit(0)).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  `);
}

const describeWithDatabase = testDatabaseReachable() ? describe : describe.skip;

describeWithDatabase(
  'account_status migration against real Postgres (task 1.2)',
  () => {
    /** Connected to the throwaway database. */
    let pool;

    const q = (sql, params) => pool.query(sql, params);

    async function columnExists() {
      const { rows } = await q(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [TABLE, COLUMN]
      );
      return rows.length === 1;
    }

    beforeAll(async () => {
      // Create the throwaway database through the maintenance database.
      // CREATE DATABASE cannot run inside a transaction block, so this is
      // a bare query on its own short-lived pool.
      const maintenancePool = new Pool(connection(MAINTENANCE_DB));
      try {
        await maintenancePool.query(`CREATE DATABASE ${THROWAWAY_DB}`);
      } finally {
        await maintenancePool.end();
      }

      runMigrationChain();

      pool = new Pool(connection(THROWAWAY_DB));
    }, 120000);

    afterAll(async () => {
      if (pool) {
        await pool.end();
      }

      // DROP DATABASE is refused while any session is connected, and the
      // migration child processes have already exited, so the pool above
      // was the last one.
      const maintenancePool = new Pool(connection(MAINTENANCE_DB));
      try {
        await maintenancePool.query(`DROP DATABASE IF EXISTS ${THROWAWAY_DB}`);
      } finally {
        await maintenancePool.end();
      }

      process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
      process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
      process.env.DB_NAME = ORIGINAL_ENV.DB_NAME;
      process.env.DB_USER = ORIGINAL_ENV.DB_USER;
      process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
    }, 60000);

    describe('the column', () => {
      it('adds users.account_status when the migration chain is applied', async () => {
        await expect(columnExists()).resolves.toBe(true);
      });

      it('records the migration in pgmigrations', async () => {
        const { rows } = await q(
          `SELECT name FROM pgmigrations WHERE name = $1`,
          [MIGRATION_NAME]
        );
        expect(rows).toHaveLength(1);
      });

      it('is character varying(20), NOT NULL, defaulting to \'active\'', async () => {
        const { rows } = await q(
          `SELECT data_type, is_nullable, column_default, character_maximum_length
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
          [TABLE, COLUMN]
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          data_type: 'character varying',
          character_maximum_length: 20,
          is_nullable: 'NO'
        });
        expect(rows[0].column_default).toMatch(/'active'/);
      });

      it('defaults an inserted row with no explicit account_status to \'active\'', async () => {
        const { rows } = await q(
          `INSERT INTO public.users (username, email, first_name, last_name)
           VALUES ('account.status.migration', 'account.status.migration@example.com', 'Account', 'Status')
           RETURNING account_status`
        );

        expect(rows).toEqual([{ account_status: 'active' }]);
      });
    });

    describe('the CHECK constraint', () => {
      it('accepts each of the three documented values', async () => {
        for (const value of ['active', 'suspended', 'orphaned']) {
          const username = `account.status.${value}`;
          // eslint-disable-next-line no-await-in-loop
          const { rows } = await q(
            `INSERT INTO public.users (username, email, first_name, last_name, account_status)
             VALUES ($1, $2, 'Account', 'Status', $3)
             RETURNING account_status`,
            [username, `${username}@example.com`, value]
          );
          expect(rows).toEqual([{ account_status: value }]);
        }
      });

      it('rejects a fourth value', async () => {
        await expect(
          q(
            `INSERT INTO public.users (username, email, first_name, last_name, account_status)
             VALUES ('account.status.bogus', 'account.status.bogus@example.com', 'Account', 'Status', 'deleted')`
          )
        ).rejects.toMatchObject({ code: '23514' });
      });
    });

    describe('the partial index', () => {
      it('creates idx_users_account_status filtered to account_status <> \'active\'', async () => {
        const { rows } = await q(
          `SELECT indexdef FROM pg_indexes
           WHERE schemaname = 'public' AND indexname = $1`,
          [PARTIAL_INDEX]
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].indexdef).toContain('USING btree (account_status)');
        expect(rows[0].indexdef).toContain("WHERE ((account_status)::text <> 'active'::text)");
      });
    });

    describe('down then up', () => {
      it('drops the column, constraint and index on down, and re-creates them on up', async () => {
        runMigrationChain({ direction: 'down', count: 1 });
        await expect(columnExists()).resolves.toBe(false);

        runMigrationChain();
        await expect(columnExists()).resolves.toBe(true);

        const { rows } = await q(
          `SELECT indexname FROM pg_indexes
           WHERE schemaname = 'public' AND indexname = $1`,
          [PARTIAL_INDEX]
        );
        expect(rows).toHaveLength(1);
      }, 120000);
    });
  }
);
