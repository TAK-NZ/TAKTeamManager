/**
 * Real-Postgres integration test for account-lifecycle-management
 * Requirement 5.1 (task 10.3): `SignupFlowService.determineEmailState`
 * against a genuine orphaned `users` row.
 *
 * `SignupFlowService.test.js` already covers this behaviour with a
 * mocked `pool.query` (task 10.2) -- this file closes the same gap the
 * project's other `*.integration.test.js` files close for their own
 * subject: a mocked assertion proves the SQL string/row-shape the code
 * READS is handled correctly, but not that a REAL `account_status =
 * 'orphaned'` row, joined through a REAL `team_memberships` row via a
 * REAL Postgres query planner, actually produces that row shape in the
 * first place.
 *
 * Throwaway *database* (not the shared dev/docker-compose one this
 * repo's other integration tests connect to for an ALREADY-migrated
 * schema): as of this task, the `account_status` column this test
 * exercises has not yet been applied to that shared database via
 * `npm run migrate:up` (it is a NEW migration from THIS feature, task
 * 1.1), so this file runs the full migration chain into its own
 * throwaway database first -- mirroring
 * `database/migrations/__tests__/account-lifecycle-status.integration
 * .test.js`'s own throwaway-database pattern (and its own comment on
 * why a throwaway *schema* would not suffice: every migration qualifies
 * objects as `public.<name>`, bypassing `search_path`). This also means
 * the shared dev database other concurrent sessions may be using is
 * never touched by this file.
 *
 * Connection convention: the MAINTENANCE database (used only to
 * CREATE/DROP the throwaway one) is `DB_HOST`/`DB_PORT`/`DB_NAME`/
 * `DB_USER`/`DB_PASSWORD` from the environment if already set, otherwise
 * the local Docker-based Postgres service (`localhost:5432`, database
 * `tak_team_manager`, user `postgres`, password `postgres`) -- the SAME
 * defaults `account-lifecycle-status.integration.test.js` uses. Once the
 * throwaway database exists and is migrated, `process.env.DB_NAME` is
 * repointed to it BEFORE `../config/database` (required transitively by
 * `SignupFlowService`) is first required, so the module-level `pool`
 * this service uses connects to the throwaway database, not the
 * maintenance one.
 */

const ORIGINAL_ENV = {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD
};

process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';

const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const MAINTENANCE_DB = process.env.DB_NAME || 'tak_team_manager';
const THROWAWAY_DB = `tak_reclaim_migration_test_${Date.now()}`;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'database', 'migrations');
const REPO_ROOT = path.join(__dirname, '..', '..');

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

/** Mirrors `account-lifecycle-status.integration.test.js`'s identical helper. */
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

function runMigrationChain() {
  runNodeScript(`
    const { runner } = require('node-pg-migrate');
    runner({
      databaseUrl: ${JSON.stringify(connection(THROWAWAY_DB))},
      dir: ${JSON.stringify(MIGRATIONS_DIR)},
      migrationsTable: 'pgmigrations',
      direction: 'up',
      verbose: false
    }).then(() => process.exit(0)).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  `);
}

const describeWithDatabase = testDatabaseReachable() ? describe : describe.skip;

describeWithDatabase('SignupFlowService.determineEmailState against a real orphaned users row (account-lifecycle-management Requirement 5.1, task 10.3)', () => {
  let pool;
  let service;
  const createdUserIds = [];
  const createdTeamIds = [];

  beforeAll(async () => {
    const maintenancePool = new Pool(connection(MAINTENANCE_DB));
    try {
      await maintenancePool.query(`CREATE DATABASE ${THROWAWAY_DB}`);
    } finally {
      await maintenancePool.end();
    }

    runMigrationChain();

    // Repoint process.env.DB_NAME BEFORE requiring ../config/database
    // (transitively required by SignupFlowService) so this module's own
    // connection pool targets the throwaway, now-migrated database.
    process.env.DB_NAME = THROWAWAY_DB;
    pool = require('../config/database');
    service = new (require('./SignupFlowService'))();
  }, 120000);

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await pool.query('DELETE FROM team_memberships WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    }
    if (createdTeamIds.length > 0) {
      for (const teamId of [...createdTeamIds].reverse()) {
        await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
      }
    }

    await pool.end();

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

  async function seedTeam() {
    const result = await pool.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING id`,
      [`Reclaim Test Org ${crypto.randomUUID()}`, null]
    );
    createdTeamIds.push(result.rows[0].id);
    return result.rows[0].id;
  }

  /**
   * Seeds a `users` row with a direct `team_memberships` row -- the exact
   * shape the OLD, unfixed `determineEmailState` query would classify as
   * `'active'` regardless of `account_status` -- at the given
   * `account_status`.
   */
  async function seedUserWithDirectMembership({ accountStatus }) {
    const teamId = await seedTeam();
    const email = `reclaim-${crypto.randomUUID()}@example.com`;
    const username = `reclaim-${crypto.randomUUID()}`;

    const userResult = await pool.query(
      `INSERT INTO users (username, email, first_name, last_name, account_status)
       VALUES ($1, $2, 'Reclaim', 'Test', $3) RETURNING id`,
      [username, email, accountStatus]
    );
    const userId = userResult.rows[0].id;
    createdUserIds.push(userId);

    await pool.query(
      `INSERT INTO team_memberships (team_id, user_id, role, inherited_from_team_id)
       VALUES ($1, $2, 'member', NULL)`,
      [teamId, userId]
    );

    return { userId, email };
  }

  it('classifies a real orphaned account\'s email as "new", not "active", even with a real direct team_memberships row', async () => {
    const { email } = await seedUserWithDirectMembership({ accountStatus: 'orphaned' });

    const state = await service.determineEmailState(email);

    expect(state).toBe('new');
  }, 30000);

  it('still classifies a real active account\'s email as "active" (regression guard: the fix must not break the ordinary case)', async () => {
    const { email } = await seedUserWithDirectMembership({ accountStatus: 'active' });

    const state = await service.determineEmailState(email);

    expect(state).toBe('active');
  }, 30000);

  it('does not classify a real suspended account\'s email as "active" either', async () => {
    const { email } = await seedUserWithDirectMembership({ accountStatus: 'suspended' });

    const state = await service.determineEmailState(email);

    expect(state).not.toBe('active');
  }, 30000);
});
