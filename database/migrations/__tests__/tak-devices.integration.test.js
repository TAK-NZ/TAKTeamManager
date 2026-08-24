/**
 * Real-Postgres migration smoke test for the Device_Table migration
 * `database/migrations/1787518155760_tak-devices.cjs`
 * (device-management task 5.2, Requirements 4.1, 4.2):
 *
 *   4.1 -- "THE Device_Management SHALL define a Device_Table via a
 *   `node-pg-migrate` incremental migration in `database/migrations`,
 *   following the existing migration conventions and baseline schema."
 *
 *   4.2 -- "THE Device_Table SHALL have columns for `client_uid`
 *   (primary key), the associated local user, TAK certificate id,
 *   certificate issued timestamp, certificate expires timestamp,
 *   `last_seen_at` (nullable), `last_polled_at`, and a `revoked` boolean
 *   flag."
 *
 * Both claims are about the shape of the schema a real deployment ends up
 * with after `npm run migrate:up`, so neither can be verified by reading
 * the migration source or by mocking `pool`: the only way to observe "the
 * table, its columns and its indexes exist after applying" is to run the
 * real migration chain against a real Postgres instance and interrogate
 * the catalogs. That is what this file does.
 *
 * Throwaway *database*, not a throwaway *schema*: the sibling migration
 * tests (`server/config/migrations.teamTransfer.integration.test.js`,
 * `server/config/migrations.originOrgId.integration.test.js`,
 * `database/schemaConsistency.integration.test.js`) redirect the chain
 * into a uniquely-named Postgres schema via node-pg-migrate's
 * `schema`/`createSchema` options, which works only for DDL that names
 * objects *unqualified* and therefore resolves through `search_path`.
 * The baseline migration and this Device_Table migration both follow the
 * `pg_dump`-derived convention of explicitly qualifying every object as
 * `public.<name>` (`CREATE TABLE public.tak_devices`, `REFERENCES
 * public.users(id)`, ...), which bypasses `search_path` entirely -- a
 * schema-redirected run would still land the objects in `public` and
 * pollute the shared test database. So this test creates its own
 * uniquely-named throwaway *database*, runs the full chain into that
 * database's own `public` schema, asserts there, and drops the database
 * in `afterAll` regardless of pass or fail. Nothing is left behind.
 *
 * `node -e` child process rather than `require('node-pg-migrate')`:
 * `node-pg-migrate` v9 is pure ESM and cannot be `require()`d through
 * Jest's CommonJS transform (documented at length in
 * `database/schemaConsistency.integration.test.js`). The child script
 * performs only the `runner()` call -- the same entry point
 * `database/init.js` uses; every assertion below is a plain `pg` query.
 *
 * This file lives in `database/migrations/__tests__/`, i.e. a
 * *subdirectory* of the migrations directory. That is safe: node-pg-migrate's
 * directory scan keeps only entries where `dirent.isFile() ||
 * dirent.isSymbolicLink()` (see
 * `node_modules/node-pg-migrate/dist/legacy/migration.js`), so a
 * subdirectory is never picked up as a migration to parse. The chain run
 * by this very test would fail loudly if that ever changed.
 *
 * Skipped rather than failed when no test database is reachable: the
 * whole suite is wrapped in `describeWithDatabase`, which is `describe`
 * only when a connectivity probe succeeds and `describe.skip` otherwise,
 * so this file reports as skipped -- not failed -- in an environment
 * without Postgres. The probe runs in a `node -e` child process so it can
 * complete synchronously at module load, before the `describe` block is
 * declared. On top of that, `package.json`'s jest `testPathIgnorePatterns`
 * excludes every `*.integration.test.js` file from `npm test`, matching
 * the rest of the integration tests in this repo.
 *
 * Connection convention: `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/
 * `DB_PASSWORD` are read from the environment if already set, otherwise
 * defaulted to the local Docker-based test container
 * (`tak_migration_test_501`, Postgres 15, host port 15433, database
 * `tak_team_manager`, user `postgres`, password `postgres123`), matching
 * `server/config/migrations.teamTransfer.integration.test.js`. `DB_NAME`
 * is used only as the maintenance database for `CREATE DATABASE` /
 * `DROP DATABASE`; no object is ever created in it. They are restored in
 * `afterAll`.
 *
 * Run explicitly (this file is excluded from `npm test` by
 * `testPathIgnorePatterns`):
 *
 *   npx jest database/migrations/__tests__/tak-devices.integration.test.js \
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
const THROWAWAY_DB = `tak_devices_migration_test_${Date.now()}`;

const TABLE = 'tak_devices';
const PK_CONSTRAINT = 'tak_devices_pkey';
const USER_ID_INDEX = 'idx_tak_devices_user_id';
const CERT_ID_INDEX = 'idx_tak_devices_cert_id';

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
 * `runner()` entry point `database/init.js` uses. Nothing is excluded:
 * the point of this test is the schema a real deployment gets from the
 * whole chain, Device_Table migration included.
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
  'tak_devices migration against real Postgres (task 5.2, Requirements 4.1, 4.2)',
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

    async function indexNames() {
      const { rows } = await q(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = $1
         ORDER BY indexname`,
        [TABLE]
      );
      return rows.map((r) => r.indexname);
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

    describe('the table (Requirement 4.1)', () => {
      it('creates public.tak_devices when the migration chain is applied', async () => {
        await expect(tableExists()).resolves.toBe(true);
      });

      it('records the Device_Table migration in pgmigrations', async () => {
        // Matched by exact name rather than `LIKE '%tak-devices%'`: task 28.1
        // added `1787555044446_tak-devices-connected`, which the prefix
        // pattern also matched. This assertion is about the Device_Table
        // migration having run, so it names it.
        const { rows } = await q(
          `SELECT name FROM pgmigrations WHERE name = $1`,
          ['1787518155760_tak-devices']
        );
        expect(rows).toHaveLength(1);
      });
    });

    describe('the columns (Requirement 4.2)', () => {
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

        // Every column the requirement names, plus the created_at/updated_at
        // pair the baseline schema convention adds. Asserting the full set
        // (rather than a subset) also catches an accidentally extra column.
        // `connected` is added by the later
        // `1787555044446_tak-devices-connected` migration (task 28.1), which
        // is part of the chain this test applies; its own type, nullability
        // and default are asserted by task 28.6, not here.
        expect(Object.keys(byName).sort()).toEqual([
          'cert_id',
          'client_uid',
          'connected',
          'created_at',
          'expires_at',
          'issued_at',
          'last_polled_at',
          'last_seen_at',
          'revoked',
          'updated_at',
          'user_id'
        ]);

        // client_uid: the primary key, so NOT NULL and no default.
        expect(byName.client_uid).toMatchObject({
          data_type: 'character varying',
          character_maximum_length: 255,
          is_nullable: 'NO',
          column_default: null
        });

        // The associated local user: nullable (no local user may match a
        // certificate's creatorDn, and the FK resets it on user deletion).
        expect(byName.user_id).toMatchObject({
          data_type: 'integer',
          is_nullable: 'YES',
          column_default: null
        });

        // The TAK certificate id: always known for a synced certificate.
        expect(byName.cert_id).toMatchObject({
          data_type: 'integer',
          is_nullable: 'NO',
          column_default: null
        });

        // The four timestamps, all timestamptz and all nullable --
        // last_seen_at's nullability is explicitly required ("never seen").
        for (const column of ['issued_at', 'expires_at', 'last_seen_at', 'last_polled_at']) {
          expect(byName[column]).toMatchObject({
            data_type: 'timestamp with time zone',
            is_nullable: 'YES',
            column_default: null
          });
        }

        // The revoked flag: NOT NULL, defaulting to false.
        expect(byName.revoked).toMatchObject({
          data_type: 'boolean',
          is_nullable: 'NO'
        });
        expect(byName.revoked.column_default).toMatch(/false/);

        for (const column of ['created_at', 'updated_at']) {
          expect(byName[column]).toMatchObject({
            data_type: 'timestamp with time zone'
          });
          expect(byName[column].column_default).toMatch(/now\(\)/);
        }
      });
    });

    /**
     * device-management task 28.6 (Requirement 20.2): the `connected` column
     * added by `1787555044446_tak-devices-connected.cjs`, and the two column
     * comments that migration puts in place.
     *
     * Asserted here rather than in the column block above for the same reason
     * this file exists at all: the claim is about the schema a real deployment
     * ends up with after the whole chain is applied, and a comment in
     * particular is schema state that no amount of reading the migration source
     * can confirm was actually issued -- `COMMENT ON COLUMN` is silently a
     * no-op-shaped statement if it names a column that does not exist.
     *
     * The `last_seen_at` comment is the CORRECTED text: the Device_Table
     * migration originally said the value comes "from the live subscriptions
     * API", i.e. `/Marti/clients`, which answers 404 live and is absent from
     * `tak-server-openapispec.json`. Task 21.2 repointed Last_Seen at the
     * Client_Endpoints_API's reported `lastEventTime`, so the old wording is
     * asserted GONE, not merely the new wording present -- a second
     * `COMMENT ON COLUMN` that failed to overwrite would otherwise pass.
     */
    describe('the connected column and the corrected column comments (task 28.6, Requirement 20.2)', () => {
      it('adds connected as boolean NOT NULL DEFAULT false', async () => {
        const { rows } = await q(
          `SELECT data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'connected'`,
          [TABLE]
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          data_type: 'boolean',
          // NOT a nullable tri-state: nothing consumes a "never polled" state
          // distinct from "reported, not connected".
          is_nullable: 'NO'
        });
        expect(rows[0].column_default).toMatch(/false/);
      });

      it('defaults connected to false on an inserted row and refuses an explicit NULL', async () => {
        const { rows } = await q(
          `INSERT INTO public.tak_devices (client_uid, cert_id)
           VALUES ('ANDROID-connected-default', 5150)
           RETURNING client_uid, connected`
        );

        // The value an existing row is backfilled with by the ALTER, and the
        // value a re-inserted row starts at until the Subscription_Poller
        // observes otherwise (Requirement 20.11).
        expect(rows).toEqual([{ client_uid: 'ANDROID-connected-default', connected: false }]);

        await expect(
          q(
            `INSERT INTO public.tak_devices (client_uid, cert_id, connected)
             VALUES ('ANDROID-connected-null', 5151, NULL)`
          )
        ).rejects.toMatchObject({ code: '23502' });
      });

      it('carries the corrected connected and last_seen_at column comments', async () => {
        const { rows } = await q(
          `SELECT a.attname AS column_name,
                  col_description(a.attrelid, a.attnum) AS comment
           FROM pg_attribute a
           WHERE a.attrelid = ('public.' || $1)::regclass
             AND a.attname = ANY($2::text[])`,
          [TABLE, ['connected', 'last_seen_at']]
        );

        const comments = Object.fromEntries(rows.map((r) => [r.column_name, r.comment]));

        // The `connected` comment states the column's provenance, its single
        // writer, and the constraint that is the load-bearing one for
        // Requirement 20.3 -- that the write is NOT behind the Monotonic_Guard.
        expect(comments.connected).toContain('lastStatus');
        expect(comments.connected).toContain('Status_Collapse_Rule');
        expect(comments.connected).toContain('Subscription_Poller');
        expect(comments.connected).toMatch(/NOT behind the Monotonic_Guard/);

        // The corrected Last_Seen provenance: the endpoint that exists, and the
        // reported field it reads.
        expect(comments.last_seen_at).toContain('/Marti/api/clientEndPoints');
        expect(comments.last_seen_at).toContain('lastEventTime');
        // And the stale claim is gone, not sitting beside the new one.
        expect(comments.last_seen_at).not.toMatch(/live subscriptions API/);
        expect(comments.last_seen_at).not.toContain('/Marti/clients');
      });
    });

    describe('the indexes and constraints (Requirements 4.1, 4.2)', () => {
      it('makes client_uid the primary key', async () => {
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

        expect(rows).toEqual([
          { constraint_name: PK_CONSTRAINT, column_name: 'client_uid' }
        ]);
      });

      it('creates the user_id and cert_id btree indexes alongside the primary-key index', async () => {
        await expect(indexNames()).resolves.toEqual([
          CERT_ID_INDEX,
          USER_ID_INDEX,
          PK_CONSTRAINT
        ]);

        const { rows } = await q(
          `SELECT indexname, indexdef FROM pg_indexes
           WHERE schemaname = 'public' AND indexname = ANY($1::text[])
           ORDER BY indexname`,
          [[CERT_ID_INDEX, USER_ID_INDEX]]
        );

        const [certIndex, userIndex] = rows;
        expect(certIndex.indexdef).toContain('USING btree (cert_id)');
        expect(userIndex.indexdef).toContain('USING btree (user_id)');
      });

      it('references users(id) with ON DELETE SET NULL', async () => {
        const { rows } = await q(
          `SELECT rc.delete_rule,
                  ccu.table_name AS referenced_table,
                  ccu.column_name AS referenced_column
           FROM information_schema.table_constraints tc
           JOIN information_schema.referential_constraints rc
             ON tc.constraint_name = rc.constraint_name
            AND tc.constraint_schema = rc.constraint_schema
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
            AND tc.constraint_schema = kcu.constraint_schema
           JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name
            AND tc.constraint_schema = ccu.constraint_schema
           WHERE tc.constraint_type = 'FOREIGN KEY'
             AND tc.table_schema = 'public'
             AND tc.table_name = $1
             AND kcu.column_name = 'user_id'`,
          [TABLE]
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          delete_rule: 'SET NULL',
          referenced_table: 'users',
          referenced_column: 'id'
        });
      });
    });

    describe('the applied table is usable (Requirements 4.1, 4.2)', () => {
      it('accepts a minimal row, defaulting revoked to false and leaving last_seen_at NULL', async () => {
        const { rows: userRows } = await q(
          `INSERT INTO public.users (username, email, first_name, last_name)
           VALUES ('tak.devices.migration', 'tak.devices.migration@example.com', 'Tak', 'Devices')
           RETURNING id`
        );
        const userId = userRows[0].id;

        const { rows } = await q(
          `INSERT INTO public.tak_devices (client_uid, user_id, cert_id)
           VALUES ('ANDROID-migration-smoke', $1, 4242)
           RETURNING client_uid, user_id, cert_id, revoked, last_seen_at,
                     last_polled_at, created_at, updated_at`,
          [userId]
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          client_uid: 'ANDROID-migration-smoke',
          user_id: userId,
          cert_id: 4242,
          revoked: false,
          last_seen_at: null,
          last_polled_at: null
        });
        expect(rows[0].created_at).toBeInstanceOf(Date);
        expect(rows[0].updated_at).toBeInstanceOf(Date);
      });

      it('rejects a second row with the same client_uid', async () => {
        await expect(
          q(
            `INSERT INTO public.tak_devices (client_uid, cert_id)
             VALUES ('ANDROID-migration-smoke', 9999)`
          )
        ).rejects.toMatchObject({ code: '23505' });
      });
    });

    describe('down then up (Requirement 4.1)', () => {
      it('drops the table on down and re-creates it, with both indexes, on up', async () => {
        // Two steps, not one: task 28.1 added
        // `1787555044446_tak-devices-connected` on top of the Device_Table
        // migration, so reaching the pre-Device_Table state means reversing
        // that one first. Keep this count in step with any further migration
        // stacked on `tak_devices`.
        runMigrationChain({ direction: 'down', count: 2 });
        await expect(tableExists()).resolves.toBe(false);

        runMigrationChain();
        await expect(tableExists()).resolves.toBe(true);
        await expect(indexNames()).resolves.toEqual([
          CERT_ID_INDEX,
          USER_ID_INDEX,
          PK_CONSTRAINT
        ]);
      }, 120000);
    });
  }
);
