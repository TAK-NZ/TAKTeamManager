/**
 * Real-Postgres integration test for sign-up eligibility
 * (`server/services/signupEligibility.js`) as used by
 * `SignupFlowService.getAvailableTeams` and `SignupFlowService.submitTeamAccess`.
 *
 * The unit tests mock `pool.query`, so they cannot prove the SQL itself: the
 * recursive ancestor walks, the sign-up code gate, the Organisation domain
 * restriction and the "Organisation code covers its Sub_Teams" rule are all
 * decided inside Postgres. This file runs the full migration chain into a
 * throwaway database (the same pattern as
 * `SignupFlowService.reclaim.integration.test.js`) and exercises both entry
 * points against real rows.
 *
 * Fixture (names are prefixed per run so they never collide):
 *
 *   A   Organisation, joinable, code ORG_A, covers Sub_Teams
 *     A1     Sub_Team, joinable, no code of its own
 *       A1x  Sub_Sub_Team, joinable, no code (depth 2)
 *     A2     Sub_Team, joinable, own code SUB_A2
 *     A3     Sub_Team, NOT joinable
 *     A4     Sub_Team, joinable, PRIVATE
 *       A4x  Sub_Sub_Team, joinable and public, but under a private ancestor
 *   B   Organisation, joinable, no code, flag off      -> open
 *     B1     Sub_Team, joinable                           -> open
 *   C   Organisation, joinable, no code, flag ON        -> C open, C1 hidden (fail closed)
 *     C1     Sub_Team, joinable
 *   D   Organisation, joinable, code ORG_D, flag off    -> D gated by its code
 *     D1     Sub_Team, joinable, no code                  -> open (flag is off)
 *   E   Organisation, joinable, code ORG_E, flag ON, allowed domain "example.org"
 *     E1     Sub_Team, joinable
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
const THROWAWAY_DB = `tak_signup_eligibility_test_${Date.now()}`;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'database', 'migrations');
const REPO_ROOT = path.join(__dirname, '..', '..');

// Valid Identifier_Alphabet codes (no I, L, O, 0, 1).
const ORG_A = 'ABCD2345';
const SUB_A2 = 'EFGH6789';
const ORG_D = 'JKMN2345';
const ORG_E = 'PQRS6789';

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

describeWithDatabase('sign-up eligibility against real Postgres', () => {
  let pool;
  let service;
  let adminUserId;
  const run = crypto.randomBytes(3).toString('hex');
  const id = {}; // fixture key -> team id
  const n = (key) => `${key}-${run}`; // team name for a fixture key

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
    service = new (require('./SignupFlowService'))();

    const user = await pool.query(
      `INSERT INTO users (username, email, first_name, last_name)
       VALUES ($1, $2, 'Code', 'Admin') RETURNING id`,
      [`admin-${run}`, `admin-${run}@example.com`]
    );
    adminUserId = user.rows[0].id;

    async function team(key, { parent = null, canJoin = true, visibility = 'public', covers = null } = {}) {
      const result = await pool.query(
        `INSERT INTO teams (name, callsign_prefix, visibility, can_join, parent_team_id, signup_code_covers_sub_teams)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [n(key), parent ? null : key.toUpperCase(), visibility, canJoin, parent ? id[parent] : null, covers]
      );
      id[key] = result.rows[0].id;
    }
    async function code(key, value) {
      await pool.query(
        'INSERT INTO signup_codes (team_id, code, created_by) VALUES ($1, $2, $3)',
        [id[key], value, adminUserId]
      );
    }

    await team('A', { covers: true });
    await team('A1', { parent: 'A' });
    await team('A1x', { parent: 'A1' });
    await team('A2', { parent: 'A' });
    await team('A3', { parent: 'A', canJoin: false });
    await team('A4', { parent: 'A', visibility: 'private' });
    await team('A4x', { parent: 'A4' });
    await team('B', { covers: false });
    await team('B1', { parent: 'B' });
    await team('C', { covers: true });
    await team('C1', { parent: 'C' });
    await team('D', { covers: false });
    await team('D1', { parent: 'D' });
    await team('E', { covers: true });
    await team('E1', { parent: 'E' });

    await code('A', ORG_A);
    await code('A2', SUB_A2);
    await code('D', ORG_D);
    await code('E', ORG_E);
    await pool.query('INSERT INTO org_allowed_domains (org_id, domain) VALUES ($1, $2)', [id.E, 'example.org']);
  }, 120000);

  afterAll(async () => {
    await pool.end();
    const maintenancePool = new Pool(connection(MAINTENANCE_DB));
    try {
      await maintenancePool.query(`DROP DATABASE IF EXISTS ${THROWAWAY_DB}`);
    } finally {
      await maintenancePool.end();
    }
    for (const key of Object.keys(ORIGINAL_ENV)) {
      if (ORIGINAL_ENV[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = ORIGINAL_ENV[key];
      }
    }
  }, 60000);

  /** Creates a verification token as /requests/initiate would, optionally with a stored code. */
  async function startSignup({ email = 'person@example.com', code = null } = {}) {
    const token = crypto.randomUUID();
    await pool.query(
      `INSERT INTO access_requests
         (requester_email, email_verification_token, email_verification_expires_at,
          email_verified, status, request_type, signup_code_used)
       VALUES ($1, $2, NOW() + INTERVAL '1 day', false, 'pending', 'new_account', $3)`,
      [email, token, code]
    );
    return token;
  }

  async function offered(options) {
    const token = await startSignup(options);
    const result = await service.getAvailableTeams(token, null);
    const names = result.teams.map((t) => t.name.replace(`-${run}`, ''));
    return { ...result, names: new Set(names) };
  }

  async function canSubmit(teamKey, options) {
    const token = await startSignup(options);
    try {
      await service.submitTeamAccess({
        token, firstName: 'Test', lastName: 'Person', teamId: id[teamKey], reason: 'Integration test reason'
      });
      return true;
    } catch (err) {
      if (err.message === 'Selected team is not available') return false;
      throw err;
    }
  }

  const OPEN = ['B', 'B1', 'C', 'D1'];

  describe('a person without a code', () => {
    it('sees only teams that are open to everyone', async () => {
      const { names, codeScope } = await offered();
      expect([...names].sort()).toEqual([...OPEN].sort());
      expect(codeScope).toBeUndefined();
    }, 30000);

    it('never sees the sub-teams of an Organisation whose code covers them', async () => {
      const { names } = await offered();
      for (const hidden of ['A', 'A1', 'A1x', 'A2', 'C1', 'E', 'E1']) {
        expect(names.has(hidden)).toBe(false);
      }
    }, 30000);

    it('treats an unknown or wrong code like no code', async () => {
      const { names } = await offered({ code: 'ZZZZ2222' });
      expect([...names].sort()).toEqual([...OPEN].sort());
    }, 30000);

    it('cannot submit a request for a gated sub-team, a sub-sub-team, or the Organisation', async () => {
      for (const key of ['A', 'A1', 'A1x', 'A2', 'C1']) {
        expect({ key, allowed: await canSubmit(key) }).toEqual({ key, allowed: false });
      }
    }, 60000);

    it('can still submit for a team that is open to everyone', async () => {
      for (const key of OPEN) {
        expect({ key, allowed: await canSubmit(key) }).toEqual({ key, allowed: true });
      }
    }, 60000);
  });

  describe('a person with the Organisation code (covers sub-teams)', () => {
    it('is offered the Organisation and its eligible descendants, and nothing else', async () => {
      const { names, codeScope, codeTeamId } = await offered({ code: ORG_A });
      expect([...names].sort()).toEqual(['A', 'A1', 'A1x', 'A2']);
      expect(codeScope).toBe('organisation');
      expect(codeTeamId).toBe(id.A);
    }, 30000);

    it('never sees a non-joinable team, a private team, or a team under a private ancestor', async () => {
      const { names } = await offered({ code: ORG_A });
      for (const hidden of ['A3', 'A4', 'A4x']) {
        expect(names.has(hidden)).toBe(false);
      }
    }, 30000);

    it('can submit for the Organisation, a sub-team, a sub-sub-team and a sub-team that has its own code', async () => {
      for (const key of ['A', 'A1', 'A1x', 'A2']) {
        expect({ key, allowed: await canSubmit(key, { code: ORG_A }) }).toEqual({ key, allowed: true });
      }
    }, 60000);

    it('cannot submit for a non-joinable team or anything under a private branch', async () => {
      for (const key of ['A3', 'A4', 'A4x']) {
        expect({ key, allowed: await canSubmit(key, { code: ORG_A }) }).toEqual({ key, allowed: false });
      }
    }, 60000);

    it('cannot use the code to reach another Organisation\'s sub-teams', async () => {
      expect(await canSubmit('C1', { code: ORG_A })).toBe(false);
      expect(await canSubmit('E1', { code: ORG_A, email: 'person@example.org' })).toBe(false);
    }, 30000);
  });

  describe('a person with only a sub-team\'s own code', () => {
    it('is locked to that team (team scope) and is not offered its siblings', async () => {
      const { names, codeScope, codeTeamId } = await offered({ code: SUB_A2 });
      expect(codeScope).toBe('team');
      expect(codeTeamId).toBe(id.A2);
      expect(names.has('A2')).toBe(true);
      expect(names.has('A1')).toBe(false);
      expect(names.has('A')).toBe(false);
    }, 30000);

    it('can submit for that team only', async () => {
      expect(await canSubmit('A2', { code: SUB_A2 })).toBe(true);
      expect(await canSubmit('A1', { code: SUB_A2 })).toBe(false);
    }, 30000);
  });

  describe('an Organisation whose flag is off', () => {
    it('keeps its code-free sub-teams open to everyone, and gates only the Organisation', async () => {
      const without = await offered();
      expect(without.names.has('D1')).toBe(true);
      expect(without.names.has('D')).toBe(false);

      const withCode = await offered({ code: ORG_D });
      expect(withCode.names.has('D')).toBe(true);
      expect(withCode.codeScope).toBe('team');
    }, 30000);
  });

  describe('fail closed', () => {
    it('hides the sub-teams of a flagged Organisation that has no code, from everyone', async () => {
      const { names } = await offered();
      expect(names.has('C')).toBe(true);
      expect(names.has('C1')).toBe(false);
      expect(await canSubmit('C1')).toBe(false);
    }, 30000);

    it('stops offering and accepting sub-teams the moment the Organisation code is revoked', async () => {
      const token = await startSignup({ code: ORG_A });
      const before = await service.getAvailableTeams(token, null);
      expect(before.teams.some((t) => t.name === n('A1'))).toBe(true);

      await pool.query('DELETE FROM signup_codes WHERE team_id = $1', [id.A]);
      try {
        const after = await service.getAvailableTeams(token, null);
        expect(after.teams.some((t) => t.name === n('A1'))).toBe(false);
        expect(await canSubmit('A1', { code: ORG_A })).toBe(false);
      } finally {
        await pool.query(
          'INSERT INTO signup_codes (team_id, code, created_by) VALUES ($1, $2, $3)',
          [id.A, ORG_A, adminUserId]
        );
      }
    }, 60000);
  });

  describe('the Organisation domain restriction', () => {
    it('is never bypassed by the Organisation code', async () => {
      const wrongDomain = await offered({ code: ORG_E, email: 'person@example.com' });
      expect(wrongDomain.names.has('E')).toBe(false);
      expect(wrongDomain.names.has('E1')).toBe(false);
      expect(wrongDomain.codeTeamMessage).toMatch(/requires an email address/);
      // The list is left as it was (the open teams), not emptied.
      expect([...wrongDomain.names].sort()).toEqual([...OPEN].sort());

      expect(await canSubmit('E', { code: ORG_E, email: 'person@example.com' })).toBe(false);
      expect(await canSubmit('E1', { code: ORG_E, email: 'person@example.com' })).toBe(false);
    }, 60000);

    it('admits a person on an allowed domain who presents the code', async () => {
      const { names, codeScope } = await offered({ code: ORG_E, email: 'person@example.org' });
      expect([...names].sort()).toEqual(['E', 'E1']);
      expect(codeScope).toBe('organisation');
      expect(await canSubmit('E1', { code: ORG_E, email: 'person@example.org' })).toBe(true);
    }, 60000);
  });
});
