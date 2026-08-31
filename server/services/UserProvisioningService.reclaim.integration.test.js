/**
 * Real-Postgres integration test for account-lifecycle-management
 * Requirement 5.3, 5.5 (task 11.6): `UserProvisioningService
 * .createAndAddUser`'s `reclaimedUserId` branch, performing a full
 * Account_Reclaim against a real Postgres instance and asserting that
 * `audit_logs` rows written against the pre-reclaim row remain queryable
 * and attributed to the SAME row (by `id`) after the reclaim.
 *
 * `UserProvisioningService.test.js` already covers this branch's SQL
 * shape with a mocked transactional `client` (task 11.5) -- this file
 * closes the same gap the project's other `*.integration.test.js` files
 * close for their own subject: a mocked assertion proves the exact SQL
 * string/params the code ISSUES, but not that a real `UPDATE ... WHERE
 * id = $reclaimedUserId RETURNING id` against a real Postgres row
 * actually preserves that row's `id` (and therefore its FK-linked
 * history) through the round trip, the way Requirement 5.5 claims.
 *
 * Throwaway *database*, following `SignupFlowService.reclaim.integration
 * .test.js`'s own pattern and its own reasoning: this feature's
 * migration (task 1.1, `account_status`) has not been applied to the
 * shared docker-compose dev database at the time this task runs, so this
 * file creates its own throwaway database, runs the full migration chain
 * into it, and drops it in `afterAll` -- the shared dev database other
 * concurrent sessions may be using is never touched.
 *
 * Connection convention: `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD` from
 * the environment if already set, otherwise the local Docker-based
 * Postgres service (`localhost:5432`, user `postgres`, password
 * `postgres`) -- the same defaults `SignupFlowService.reclaim.integration
 * .test.js` uses.
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

jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn().mockResolvedValue('op-id')
}));

const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const MAINTENANCE_DB = process.env.DB_NAME || 'tak_team_manager';
const THROWAWAY_DB = `tak_reclaim_provisioning_test_${Date.now()}`;
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

describeWithDatabase('UserProvisioningService.createAndAddUser Account_Reclaim against a real Postgres database (account-lifecycle-management Requirement 5.3, 5.5, task 11.6)', () => {
  let pool;
  let UserProvisioningService;
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

    process.env.DB_NAME = THROWAWAY_DB;
    pool = require('../config/database');
    UserProvisioningService = require('./UserProvisioningService');
  }, 120000);

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await pool.query('DELETE FROM audit_logs WHERE resource_type = $1 AND resource_id = ANY($2)', ['user', createdUserIds]);
      await pool.query('DELETE FROM team_memberships WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM channel_memberships WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    }
    if (createdTeamIds.length > 0) {
      for (const teamId of [...createdTeamIds].reverse()) {
        await pool.query('DELETE FROM channels WHERE team_id = $1', [teamId]);
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

  it('preserves the row\'s id (and therefore its prior audit_logs history) across a full Account_Reclaim', async () => {
    // Seed a target team (new sign-ups are approved against a team; the
    // reclaim's own team-assignment logic needs a real teams row).
    const teamResult = await pool.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING id`,
      [`Reclaim Provisioning Test ${crypto.randomUUID()}`, null]
    );
    const teamId = teamResult.rows[0].id;
    createdTeamIds.push(teamId);

    // Seed the ORPHANED row this reclaim will adopt -- a past account
    // whose Authentik identity has since disappeared (account_status =
    // 'orphaned', authentik_user_id NULL, is_active false -- mirroring
    // what the Reconciliation_Sweep itself writes).
    const email = `orphaned-${crypto.randomUUID()}@example.com`;
    const originalUsername = `orphaned-${crypto.randomUUID()}`;
    const orphanedResult = await pool.query(
      `INSERT INTO users (username, email, first_name, last_name, account_status, is_active, authentik_user_id)
       VALUES ($1, $2, 'Original', 'Person', 'orphaned', false, NULL) RETURNING id`,
      [originalUsername, email]
    );
    const reclaimedUserId = orphanedResult.rows[0].id;
    createdUserIds.push(reclaimedUserId);

    // A prior audit_logs row referencing this exact id, from BEFORE the
    // reclaim -- e.g. the 'user.orphaned' row the Reconciliation_Sweep
    // itself would have written. `audit_logs.user_id` carries a real FK
    // to `users.id` (there is no seeded sentinel row for SYSTEM_USER_ID
    // in this schema), so `user_id` is left NULL here -- this test's own
    // subject is whether the ROW (keyed by `resource_id`) survives the
    // reclaim, not who the actor was.
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [null, 'user.orphaned', 'user', reclaimedUserId, JSON.stringify({ reason: 'authentik_account_missing' })]
    );

    // Perform the reclaim: a fresh Authentik identity (a new
    // authentik_user_id, a new username derived from the SAME email)
    // adopts the existing row by id.
    const newAuthentikUserId = Math.floor(Math.random() * 1000000) + 1;
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await UserProvisioningService.createAndAddUser(client, {
        authentikUserId: newAuthentikUserId,
        username: email,
        email,
        firstName: 'Reclaimed',
        lastName: 'Person',
        teamId,
        callsign_suffix: 'Reclaimed1',
        createdBy: -1,
        reclaimedUserId
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // Requirement 5.5: the id is unchanged.
    expect(result.localUserId).toBe(reclaimedUserId);

    // The row itself now reflects the reclaim.
    const { rows: [reclaimedRow] } = await pool.query(
      'SELECT id, authentik_user_id, username, email, account_status, is_active, callsign_suffix FROM users WHERE id = $1',
      [reclaimedUserId]
    );
    expect(reclaimedRow).toMatchObject({
      id: reclaimedUserId,
      authentik_user_id: newAuthentikUserId,
      username: email,
      email,
      account_status: 'active',
      is_active: true,
      callsign_suffix: 'Reclaimed1'
    });

    // Requirement 5.5: the PRE-reclaim audit_logs row is still queryable
    // and still attributed to this exact id -- no migration/backfill
    // needed, since it was never touched.
    const { rows: auditRows } = await pool.query(
      'SELECT action, resource_id FROM audit_logs WHERE resource_type = $1 AND resource_id = $2 ORDER BY id ASC',
      ['user', reclaimedUserId]
    );
    expect(auditRows.some((row) => row.action === 'user.orphaned' && row.resource_id === reclaimedUserId)).toBe(true);

    // Requirement 5.4: no automatic restoration of a previous
    // team/role -- the fresh team assignment from THIS approval is the
    // only membership row for this user (there was none before the
    // reclaim, since the orphaned seed row had none either).
    const { rows: membershipRows } = await pool.query(
      'SELECT team_id, role, inherited_from_team_id FROM team_memberships WHERE user_id = $1',
      [reclaimedUserId]
    );
    expect(membershipRows).toEqual([{ team_id: teamId, role: 'member', inherited_from_team_id: null }]);
  }, 30000);
});
