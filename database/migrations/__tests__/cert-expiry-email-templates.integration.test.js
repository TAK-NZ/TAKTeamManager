/**
 * Real-Postgres migration smoke test for the Cert_Expiry_Notification
 * email templates migration
 * `database/migrations/1788700000000_cert-expiry-email-templates.cjs`
 * (cert-expiry-notifications task 7.3, Requirements 3.3, 4.3):
 *
 *   3.3 -- "THE digest email SHALL state, for each listed device, a
 *   human-readable device identifier and its certificate's expiry date,
 *   and SHALL advise the recipient that if they no longer need the
 *   device, they should revoke its certificate..."
 *
 *   4.3 -- the Team-Owned_Device counterpart of the same advisory.
 *
 * These claims are about a real seeded row existing in `email_templates`
 * after the migration chain runs, and about `EmailService.sendEmail`'s
 * own `SELECT subject_template, body_template FROM email_templates WHERE
 * template_key = $1` finding it -- neither is verifiable by reading the
 * migration source alone, since `INSERT ... ON CONFLICT DO NOTHING` is
 * silently a no-op-shaped statement if the row already exists with
 * different content, or a real deployment ran an earlier ancestor of
 * this migration under a different literal.
 *
 * Follows `cert-expiry-notifications.integration.test.js`'s throwaway-
 * database convention exactly (same reasoning: this migration's INSERTs
 * are unqualified-table-name statements that resolve through
 * `search_path`, but the safest, most mechanically consistent choice in
 * this directory is still a dedicated throwaway database rather than a
 * schema-redirected run against the shared test database).
 *
 * Run explicitly (this file is excluded from `npm test` by
 * `testPathIgnorePatterns`):
 *
 *   npx jest database/migrations/__tests__/cert-expiry-email-templates.integration.test.js \
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

const MAINTENANCE_DB = process.env.DB_NAME;
const THROWAWAY_DB = `tak_cert_expiry_templates_test_${Date.now()}`;

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
  'cert-expiry email templates migration against real Postgres (task 7.3, Requirements 3.3, 4.3)',
  () => {
    let pool;

    const q = (sql, params) => pool.query(sql, params);

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

    it('records the migration in pgmigrations', async () => {
      const { rows } = await q(`SELECT name FROM pgmigrations WHERE name = $1`, [
        '1788700000000_cert-expiry-email-templates'
      ]);
      expect(rows).toHaveLength(1);
    });

    it('seeds cert_expiry_self_digest with the expected placeholders and advisory text', async () => {
      const { rows } = await q(
        `SELECT subject_template, body_template FROM email_templates WHERE template_key = $1`,
        ['cert_expiry_self_digest']
      );
      expect(rows).toHaveLength(1);
      const { subject_template: subject, body_template: body } = rows[0];

      expect(subject.length).toBeGreaterThan(0);
      expect(body).toContain('{{first_name}}');
      expect(body).toContain('{{device_list}}');
      expect(body).toContain('{{revoke_hint_url}}');
      // Requirement 3.3's advisory: revoke instead of letting it lapse.
      expect(body.toLowerCase()).toContain('revoke');
    });

    it('seeds cert_expiry_team_digest with the expected placeholders and advisory text', async () => {
      const { rows } = await q(
        `SELECT subject_template, body_template FROM email_templates WHERE template_key = $1`,
        ['cert_expiry_team_digest']
      );
      expect(rows).toHaveLength(1);
      const { subject_template: subject, body_template: body } = rows[0];

      expect(subject.length).toBeGreaterThan(0);
      expect(body).toContain('{{first_name}}');
      expect(body).toContain('{{team_sections}}');
      expect(body).toContain('{{revoke_hint_url}}');
      expect(body.toLowerCase()).toContain('revoke');
    });

    it('is findable by the exact query EmailService.sendEmail issues', async () => {
      for (const templateKey of ['cert_expiry_self_digest', 'cert_expiry_team_digest']) {
        const { rows } = await q(
          'SELECT subject_template, body_template FROM email_templates WHERE template_key = $1',
          [templateKey]
        );
        expect(rows).toHaveLength(1);
      }
    });

    describe('down then up', () => {
      it('removes both rows on down and re-seeds them on up', async () => {
        runMigrationChain({ direction: 'down', count: 1 });

        const afterDown = await q(
          `SELECT template_key FROM email_templates WHERE template_key IN ('cert_expiry_self_digest', 'cert_expiry_team_digest')`
        );
        expect(afterDown.rows).toHaveLength(0);

        runMigrationChain();

        const afterUp = await q(
          `SELECT template_key FROM email_templates WHERE template_key IN ('cert_expiry_self_digest', 'cert_expiry_team_digest') ORDER BY template_key`
        );
        expect(afterUp.rows.map((r) => r.template_key)).toEqual([
          'cert_expiry_self_digest',
          'cert_expiry_team_digest'
        ]);
      }, 120000);
    });
  }
);
