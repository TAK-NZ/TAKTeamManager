'use strict';

/**
 * Shared real-Postgres throwaway-database helpers.
 *
 * Extracted from `database/migrations/__tests__/baselineMigration.integration.test.js`
 * (previously the only place these three functions lived) so a second
 * consumer -- `server/services/teamMembershipInvariants.model.integration.test.js`'s
 * stateful/model-based fast-check test -- doesn't have to duplicate them a
 * third time. Behaviour is unchanged from the original: every function
 * here is a verbatim lift, not a rewrite.
 *
 * A dedicated throwaway DATABASE (via `CREATE DATABASE`), not a dedicated
 * schema inside a shared database: `pg_dump` (which produced the baseline
 * migration's DDL -- see `1790200000000_baseline-schema.cjs`'s own header
 * comment) always schema-qualifies every statement
 * (`CREATE TABLE public.foo (...)`), so a `search_path` trick has no
 * effect and every run would collide with the real `public` schema
 * objects already present on a shared database. A dedicated throwaway
 * database's own `public` schema starts empty, so `public.foo` resolves
 * exactly where a real deployment's does.
 *
 * Connection convention (read by every function below, at call time --
 * NOT frozen at module-require time, so a caller may set
 * `process.env.DB_HOST` etc. any time before calling): `DB_HOST`/
 * `DB_PORT`/`DB_USER`/`DB_PASSWORD`, matching every other
 * `*.integration.test.js` file in this repo. Callers are responsible for
 * defaulting these (typically to the local Docker-based test container,
 * `tak_migration_test_501`, Postgres 15, host port 15433, user
 * `postgres`, password `postgres123`) and for restoring the original
 * values in their own `afterAll` -- this module has no opinion on
 * defaults or restoration, it only reads whatever is currently set.
 */

const { Pool } = require('pg');

function connectionConfig(database) {
  return {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
  };
}

/**
 * Creates a throwaway database named `dbName` via an admin connection to
 * the server's `postgres` maintenance database, and returns a `Pool`
 * already connected to the new database.
 *
 * @param {string} dbName
 * @param {string} guardName used only to name the caller in the
 *   connectivity-failure error message (e.g. "The origin_org_id FK
 *   guard", "The team-membership invariants model test").
 * @returns {Promise<import('pg').Pool>}
 */
async function createThrowawayDatabase(dbName, guardName) {
  const adminPool = new Pool(connectionConfig('postgres'));

  try {
    await adminPool.query('SELECT 1');
  } catch (error) {
    await adminPool.end();
    throw new Error(
      `Real Postgres test database is not reachable at ` +
        `${process.env.DB_HOST}:${process.env.DB_PORT} (user "${process.env.DB_USER}"). ` +
        `${guardName} requires a real, running Postgres instance. ` +
        `Underlying error: ${error.message}`,
      { cause: error }
    );
  }

  await adminPool.query(`CREATE DATABASE "${dbName}"`);
  await adminPool.end();

  return new Pool(connectionConfig(dbName));
}

/**
 * Drops `dbName` via an admin connection, terminating any lingering
 * backends on it first (a fresh Pool from the same test can otherwise
 * still hold a connection open, which blocks DROP DATABASE).
 *
 * @param {string} dbName
 */
async function dropThrowawayDatabase(dbName) {
  const adminPool = new Pool(connectionConfig('postgres'));

  await adminPool.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [dbName]
  );
  await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await adminPool.end();
}

/**
 * Runs the full migration chain against `dbName` out-of-process, using
 * the same `runner()` entry point `database/init.js` uses -- into that
 * database's own `public` schema, exactly as a real deployment does.
 *
 * `node -e` child process rather than `require('node-pg-migrate')`:
 * `node-pg-migrate` v9 is pure ESM and cannot be `require()`d through
 * Jest's CommonJS transform (documented at length in
 * `database/schemaConsistency.integration.test.js`). This shells out to a
 * small inline Node script that performs only the `runner()` call; every
 * assertion in the calling test is a plain `pg` query run from inside
 * Jest.
 *
 * @param {string} dbName
 * @param {string} migrationsDir absolute path to `database/migrations`.
 * @param {object} [options]
 * @param {'up'|'down'} [options.direction]
 * @param {number} [options.count] Only used for `down`.
 */
function runMigrationChain(dbName, migrationsDir, { direction = 'up', count } = {}) {
  const { execFileSync } = require('child_process');
  const repoRoot = require('path').join(__dirname, '..', '..');

  const script = `
    const { runner } = require('node-pg-migrate');
    runner({
      databaseUrl: {
        user: ${JSON.stringify(process.env.DB_USER)},
        host: ${JSON.stringify(process.env.DB_HOST)},
        database: ${JSON.stringify(dbName)},
        password: ${JSON.stringify(process.env.DB_PASSWORD)},
        port: ${JSON.stringify(process.env.DB_PORT)},
        ssl: false
      },
      dir: ${JSON.stringify(migrationsDir)},
      migrationsTable: 'pgmigrations',
      direction: ${JSON.stringify(direction)},
      ${count !== undefined ? `count: ${JSON.stringify(count)},` : ''}
      verbose: false
    }).then(() => process.exit(0)).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  `;

  execFileSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    stdio: 'inherit'
  });
}

module.exports = { createThrowawayDatabase, dropThrowawayDatabase, runMigrationChain };
