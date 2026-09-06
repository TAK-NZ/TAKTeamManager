/**
 * Real-Postgres regression guard for the bugfix in
 * `1789800000000_scope-callsign-prefix-uniqueness-to-country.cjs`.
 *
 * `idx_teams_callsign_prefix` protects the Organisation-prefix SEGMENT
 * (`teams.callsign_prefix`) fed into `ManagedIdentifierService`, not the
 * Organisation's EFFECTIVE composed prefix (`country_code` + `-` +
 * `callsign_prefix` when a Foreign_Partner country is set). Before this
 * migration the index was `UNIQUE (callsign_prefix) WHERE ...`, so two
 * Foreign_Partner Organisations sharing a bare `callsign_prefix` under
 * DIFFERENT countries (e.g. Fiji's `FIRE`/`FJI` and Australia's
 * `FIRE`/`AUS`, both composing to entirely distinct effective prefixes
 * `FJI-FIRE`/`AUS-FIRE`) incorrectly collided -- confirmed live against
 * the dev database before writing this fix.
 *
 * This is real-Postgres-only coverage: `Team.test.js`'s existing `23505`
 * translation tests mock `pool.query` directly and assert nothing about
 * the ACTUAL index definition -- they would pass identically whether the
 * index were scoped correctly or not, since they simulate the constraint
 * violation rather than triggering a real one. Only a live database can
 * prove the index itself has the right shape.
 *
 * Follows `baselineMigration.integration.test.js`'s own throwaway-
 * database convention (own dedicated `CREATE DATABASE`, full migration
 * chain via `runMigrationChain`, dropped in `afterAll` regardless of
 * pass/fail) and its `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`
 * environment convention -- but defaults to this repo's own local dev
 * Postgres (`localhost:5432`, `postgres`/`postgres`, see `.env`) rather
 * than the separate `tak_migration_test_501` container on 15433, since no
 * such dedicated container exists in this environment and the throwaway-
 * database helpers are agnostic to which server they run against.
 *
 * Run explicitly (this file is excluded from `npm test` by
 * `testPathIgnorePatterns`):
 *
 *   npx jest database/migrations/__tests__/callsignPrefixCountryScoping.integration.test.js \
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
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';

const MIGRATIONS_DIR = path.join(__dirname, '..');

function restoreEnv() {
  process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
  process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
  process.env.DB_USER = ORIGINAL_ENV.DB_USER;
  process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
}

function runMigrationChain(dbName, options) {
  runMigrationChainAgainst(dbName, MIGRATIONS_DIR, options);
}

describe('idx_teams_callsign_prefix scoping (Foreign_Partner Organisation country prefix bugfix)', () => {
  const DB_NAME = `callsign_prefix_country_scoping_test_${Date.now()}`;
  let pool;

  beforeAll(async () => {
    pool = await createThrowawayDatabase(DB_NAME, 'The callsign-prefix/country scoping guard');
    runMigrationChain(DB_NAME);
  }, 120000);

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
    await dropThrowawayDatabase(DB_NAME);
    restoreEnv();
  }, 60000);

  async function insertOrg({ name, callsignPrefix, countryCode = null }) {
    return pool.query(
      `INSERT INTO teams (name, callsign_prefix, country_code, color, visibility, can_join)
       VALUES ($1, $2, $3, 'Blue', 'public', true)
       RETURNING id`,
      [name, callsignPrefix, countryCode]
    );
  }

  it('allows two Foreign_Partner Organisations to share a bare callsign_prefix under DIFFERENT countries (the bug this fixes)', async () => {
    await insertOrg({ name: 'National Fire Authority of Fiji', callsignPrefix: 'FIRE', countryCode: 'FJI' });

    // Before the fix, this INSERT failed with a duplicate-key violation
    // on idx_teams_callsign_prefix, even though FJI-FIRE and AUS-FIRE
    // are entirely distinct effective prefixes.
    const result = await insertOrg({
      name: 'National Fire Authority of Australia',
      callsignPrefix: 'FIRE',
      countryCode: 'AUS'
    });

    expect(result.rows).toHaveLength(1);
  });

  it('still rejects two DOMESTIC Organisations (no country_code) sharing the same bare callsign_prefix', async () => {
    await insertOrg({ name: 'Fire and Emergency New Zealand', callsignPrefix: 'FENZ' });

    await expect(
      insertOrg({ name: 'Duplicate FENZ', callsignPrefix: 'FENZ' })
    ).rejects.toMatchObject({ code: '23505', constraint: 'idx_teams_callsign_prefix' });
  });

  it('still rejects two Organisations sharing the same callsign_prefix AND the same country_code', async () => {
    await insertOrg({ name: 'First AUS Org', callsignPrefix: 'POLC', countryCode: 'AUS' });

    await expect(
      insertOrg({ name: 'Second AUS Org, same prefix', callsignPrefix: 'POLC', countryCode: 'AUS' })
    ).rejects.toMatchObject({ code: '23505', constraint: 'idx_teams_callsign_prefix' });
  });

  it('allows a Foreign_Partner Organisation to share a callsign_prefix with an UNRELATED domestic Organisation (different, NULL country)', async () => {
    await insertOrg({ name: 'Domestic Rescue', callsignPrefix: 'RESC' });

    const result = await insertOrg({ name: 'Foreign Rescue', callsignPrefix: 'RESC', countryCode: 'AUS' });

    expect(result.rows).toHaveLength(1);
  });

  it('a Sub_Team may freely repeat any callsign_prefix regardless of country_code (the index only applies to parent_team_id IS NULL rows)', async () => {
    const { rows: orgRows } = await insertOrg({ name: 'Parent Org For Subteams', callsignPrefix: 'PRNT' });
    const orgId = orgRows[0].id;

    await pool.query(
      `INSERT INTO teams (name, callsign_prefix, parent_team_id, color, visibility, can_join)
       VALUES ('Sub A', 'DUPE', $1, 'Blue', 'public', true)`,
      [orgId]
    );

    // A second Sub_Team under the SAME org, same prefix -- unaffected by
    // idx_teams_callsign_prefix either way (it only covers parent_team_id
    // IS NULL rows); this asserts that scope is unchanged by this fix.
    const result = await pool.query(
      `INSERT INTO teams (name, callsign_prefix, parent_team_id, color, visibility, can_join)
       VALUES ('Sub B', 'DUPE', $1, 'Blue', 'public', true)
       RETURNING id`,
      [orgId]
    );

    expect(result.rows).toHaveLength(1);
  });
});
