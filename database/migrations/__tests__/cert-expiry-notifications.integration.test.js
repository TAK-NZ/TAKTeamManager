/**
 * Real-Postgres migration smoke test for the Cert_Expiry_Notification_Record
 * migration `database/migrations/1788600000000_cert-expiry-notifications.cjs`
 * (cert-expiry-notifications task 1.2, Requirement 1):
 *
 *   1.1 -- "THE App SHALL provide a new table, `cert_expiry_notifications`,
 *   with columns `client_uid`, `cert_id`, `threshold_days`, `notified_at`,
 *   and a UNIQUE constraint on `(client_uid, cert_id, threshold_days)`."
 *
 * These claims are about the shape of the schema a real deployment ends up
 * with after `npm run migrate:up`, so they cannot be verified by reading
 * the migration source or by mocking `pool`: the only way to observe "the
 * table, its columns, and its unique constraint exist after applying" is
 * to run the real migration chain against a real Postgres instance and
 * interrogate the catalogs. That is what this file does.
 *
 * Throwaway *database*, not a throwaway *schema*: this migration follows
 * the `pg_dump`-derived convention of explicitly qualifying every object as
 * `public.<name>`, which bypasses `search_path` entirely, so a
 * schema-redirected run would still land the objects in `public` and
 * pollute the shared test database. This test instead creates its own
 * uniquely-named throwaway *database*, runs the full chain into that
 * database's own `public` schema, asserts there, and drops the database in
 * `afterAll` regardless of pass or fail -- following
 * `tak-devices.integration.test.js`'s exact convention.
 *
 * `node -e` child process rather than `require('node-pg-migrate')`:
 * `node-pg-migrate` v9 is pure ESM and cannot be `require()`d through
 * Jest's CommonJS transform.
 *
 * Skipped rather than failed when no test database is reachable: the whole
 * suite is wrapped in `describeWithDatabase`. `package.json`'s Jest
 * `testPathIgnorePatterns` also excludes every `*.integration.test.js` file
 * from `npm test`.
 *
 * Run explicitly (this file is excluded from `npm test` by
 * `testPathIgnorePatterns`):
 *
 *   npx jest database/migrations/__tests__/cert-expiry-notifications.integration.test.js \
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

const THROWAWAY_DB = `tak_cert_expiry_migration_test_${Date.now()}`;

const TABLE = 'cert_expiry_notifications';
const PK_CONSTRAINT = 'cert_expiry_notifications_pkey';
const UNIQUE_CONSTRAINT = 'cert_expiry_notifications_client_uid_cert_id_threshold_key';
const CLIENT_UID_INDEX = 'idx_cert_expiry_notifications_client_uid';

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

function runNodeScript(script, stdio = 'inherit') {
  execFileSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, stdio });
}

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
  'cert_expiry_notifications migration against real Postgres (task 1.2, Requirement 1)',
  () => {
    /** Connected to the throwaway database. */
    let pool;

    const q = (sql, params) => pool.query(sql, params);

    async function tableExists() {
      const { rows } = await q(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1`,
        [TABLE]
      );
      return rows.length === 1;
    }

    beforeAll(async () => {
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

    describe('the table (Requirement 1.1)', () => {
      it('creates public.cert_expiry_notifications when the migration chain is applied', async () => {
        await expect(tableExists()).resolves.toBe(true);
      });

      it('records the migration in pgmigrations', async () => {
        const { rows } = await q(`SELECT name FROM pgmigrations WHERE name = $1`, [
          '1788600000000_cert-expiry-notifications'
        ]);
        expect(rows).toHaveLength(1);
      });
    });

    describe('the columns (Requirement 1.1)', () => {
      it('has exactly the specified columns with the specified types, nullability and defaults', async () => {
        const { rows } = await q(
          `SELECT column_name, data_type, is_nullable, column_default,
                  character_maximum_length
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1
           ORDER BY column_name`,
          [TABLE]
        );

        const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));

        expect(Object.keys(byName).sort()).toEqual([
          'cert_id',
          'client_uid',
          'id',
          'notified_at',
          'threshold_days'
        ]);

        expect(byName.id).toMatchObject({
          data_type: 'integer',
          is_nullable: 'NO'
        });
        expect(byName.id.column_default).toMatch(/nextval/);

        expect(byName.client_uid).toMatchObject({
          data_type: 'character varying',
          character_maximum_length: 255,
          is_nullable: 'NO'
        });

        expect(byName.cert_id).toMatchObject({
          data_type: 'integer',
          is_nullable: 'NO',
          column_default: null
        });

        expect(byName.threshold_days).toMatchObject({
          data_type: 'integer',
          is_nullable: 'NO',
          column_default: null
        });

        expect(byName.notified_at).toMatchObject({
          data_type: 'timestamp with time zone',
          is_nullable: 'NO'
        });
        expect(byName.notified_at.column_default).toMatch(/now\(\)/);
      });
    });

    describe('the constraints and index (Requirement 1.1)', () => {
      it('makes id the primary key', async () => {
        const { rows } = await q(
          `SELECT tc.constraint_name, kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
            AND tc.constraint_schema = kcu.constraint_schema
           WHERE tc.constraint_type = 'PRIMARY KEY'
             AND tc.table_schema = 'public'
             AND tc.table_name = $1`,
          [TABLE]
        );

        expect(rows).toEqual([{ constraint_name: PK_CONSTRAINT, column_name: 'id' }]);
      });

      it('has a UNIQUE constraint on (client_uid, cert_id, threshold_days)', async () => {
        const { rows } = await q(
          `SELECT kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
            AND tc.constraint_schema = kcu.constraint_schema
           WHERE tc.constraint_type = 'UNIQUE'
             AND tc.table_schema = 'public'
             AND tc.table_name = $1
             AND tc.constraint_name = $2
           ORDER BY kcu.ordinal_position`,
          [TABLE, UNIQUE_CONSTRAINT]
        );

        expect(rows.map((r) => r.column_name)).toEqual([
          'client_uid',
          'cert_id',
          'threshold_days'
        ]);
      });

      it('creates the client_uid btree index', async () => {
        const { rows } = await q(
          `SELECT indexname, indexdef FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = $1 AND indexname = $2`,
          [TABLE, CLIENT_UID_INDEX]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].indexdef).toContain('USING btree (client_uid)');
      });

      it('rejects a second row with the same (client_uid, cert_id, threshold_days)', async () => {
        await q(
          `INSERT INTO public.cert_expiry_notifications (client_uid, cert_id, threshold_days)
           VALUES ('ANDROID-cert-expiry-smoke', 4242, 30)`
        );

        await expect(
          q(
            `INSERT INTO public.cert_expiry_notifications (client_uid, cert_id, threshold_days)
             VALUES ('ANDROID-cert-expiry-smoke', 4242, 30)`
          )
        ).rejects.toMatchObject({ code: '23505' });
      });

      it('accepts the same client_uid/cert_id with a different threshold_days (no over-broad uniqueness)', async () => {
        const { rows } = await q(
          `INSERT INTO public.cert_expiry_notifications (client_uid, cert_id, threshold_days)
           VALUES ('ANDROID-cert-expiry-smoke', 4242, 15)
           RETURNING id`
        );
        expect(rows).toHaveLength(1);
      });

      it('accepts a row referencing a client_uid with no matching tak_devices row (no foreign key)', async () => {
        const { rows } = await q(
          `INSERT INTO public.cert_expiry_notifications (client_uid, cert_id, threshold_days)
           VALUES ('ANDROID-no-such-device', 9999, 1)
           RETURNING id, notified_at`
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].notified_at).toBeInstanceOf(Date);
      });
    });

    describe('down then up (Requirement 1.1)', () => {
      it('drops the table on down and re-creates it, with its unique constraint and index, on up', async () => {
        runMigrationChain({ direction: 'down', count: 1 });
        await expect(tableExists()).resolves.toBe(false);

        runMigrationChain();
        await expect(tableExists()).resolves.toBe(true);

        const { rows } = await q(
          `SELECT indexname FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = $1
           ORDER BY indexname`,
          [TABLE]
        );
        expect(rows.map((r) => r.indexname).sort()).toEqual(
          [CLIENT_UID_INDEX, PK_CONSTRAINT, UNIQUE_CONSTRAINT].sort()
        );
      }, 120000);
    });
  }
);
