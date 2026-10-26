/**
 * Real-Postgres guard for `1790500000002_standardize-location-sharing-suffix.cjs`.
 *
 * Brings legacy descriptions to the unified " (Bi-directional location sharing)"
 * suffix:
 *   - region channels stored without any suffix gain it;
 *   - primary team channels carrying the old " (Location sharing enabled)"
 *     qualifier have it replaced (no doubling), and ones carrying neither gain it;
 *   - already-unified, empty and NULL descriptions are left alone;
 *   - custom channels (not primary) are out of scope and untouched.
 *
 * METHOD: run the full chain up, step this migration down (a deliberate no-op,
 * which just un-records it), seed legacy rows, then run it up again.
 *
 * Excluded from `npm test` (`*.integration.test.js`). Run explicitly:
 *
 *   npx jest database/migrations/__tests__/standardizeLocationSharingSuffix.integration.test.js \
 *     --testPathIgnorePatterns=/node_modules/ /client/
 */
const fs = require('fs');
const path = require('path');
const {
  createThrowawayDatabase,
  dropThrowawayDatabase,
  runMigrationChain
} = require('../../testHelpers/throwawayDatabase');
const { LOCATION_SHARING_DESCRIPTION_SUFFIX: SUFFIX } = require('../../../server/config/constants');

const MIGRATIONS_DIR = path.join(__dirname, '..');
const MIGRATION_FILE = '1790500000002_standardize-location-sharing-suffix.cjs';
const migrationPresent = fs.existsSync(path.join(MIGRATIONS_DIR, MIGRATION_FILE));
const STEPS_FROM_THIS_MIGRATION = migrationPresent
  ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.cjs') && f >= MIGRATION_FILE).length
  : 0;

const ORIGINAL_ENV = {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD
};
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '15433';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres123';

const OLD = ' (Location sharing enabled)';
const describeIfPresent = migrationPresent ? describe : describe.skip;

describeIfPresent('standardize location-sharing suffix migration', () => {
  const DB_NAME = `standardize_suffix_test_${Date.now()}`;
  let pool;
  let teamId;

  async function seedLegacy() {
    await pool.query(`
      INSERT INTO region_channels (name, display_name, description, tier) VALUES
        ('Legacy',  'Legacy',  'All of New Zealand (Coordination - All Agencies)', 'coordination'),
        ('Current', 'Current', 'Auckland (Response - Emergency Services)${SUFFIX}', 'response'),
        ('Empty',   'Empty',   '', 'response'),
        ('Nulled',  'Nulled',  NULL, 'coordination')
    `);
    const { rows } = await pool.query(`INSERT INTO teams (name, color) VALUES ('Suffix Org', 'Red') RETURNING id`);
    teamId = rows[0].id;
    await pool.query(
      `INSERT INTO channels (name, display_name, description, team_id, is_primary, channel_type) VALUES
        ('old-q',    'Old Q',    'Users from Old Q${OLD}',        $1, true,  'primary'),
        ('no-q',     'No Q',     'Users from No Q',               $1, true,  'primary'),
        ('current',  'Current',  'Users from Current${SUFFIX}',   $1, true,  'primary'),
        ('empty',    'Empty',    '',                              $1, true,  'primary'),
        ('custom',   'Custom',   'Custom channel: x${OLD}',       $1, false, 'custom'),
        ('no-team',  'No Team',  'Users from Nobody${OLD}',       NULL, true, 'primary')`,
      [teamId]
    );
  }

  beforeAll(async () => {
    pool = await createThrowawayDatabase(DB_NAME, 'The location-sharing suffix guard');
    runMigrationChain(DB_NAME, MIGRATIONS_DIR);
    runMigrationChain(DB_NAME, MIGRATIONS_DIR, { direction: 'down', count: STEPS_FROM_THIS_MIGRATION });
    await seedLegacy();
    runMigrationChain(DB_NAME, MIGRATIONS_DIR);
  }, 180000);

  afterAll(async () => {
    if (pool) await pool.end();
    await dropThrowawayDatabase(DB_NAME);
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it('appends the suffix to region channels that lack it, and leaves unified, empty and NULL rows alone', async () => {
    const { rows } = await pool.query(`SELECT name, description FROM region_channels ORDER BY name`);
    expect(rows).toEqual([
      { name: 'Current', description: `Auckland (Response - Emergency Services)${SUFFIX}` },
      { name: 'Empty', description: '' },
      { name: 'Legacy', description: `All of New Zealand (Coordination - All Agencies)${SUFFIX}` },
      { name: 'Nulled', description: null }
    ]);
  });

  it('replaces the old team qualifier with the unified suffix, without doubling', async () => {
    const { rows } = await pool.query(`SELECT name, description FROM channels WHERE name = 'old-q'`);
    expect(rows).toEqual([{ name: 'old-q', description: `Users from Old Q${SUFFIX}` }]);
    expect(rows[0].description).not.toContain('Location sharing enabled');
  });

  it('appends the suffix to a primary team channel that carries no qualifier', async () => {
    const { rows } = await pool.query(`SELECT description FROM channels WHERE name = 'no-q'`);
    expect(rows).toEqual([{ description: `Users from No Q${SUFFIX}` }]);
  });

  it('leaves an already-unified or empty primary team channel alone', async () => {
    const { rows } = await pool.query(`SELECT name, description FROM channels WHERE name IN ('current', 'empty') ORDER BY name`);
    expect(rows).toEqual([
      { name: 'current', description: `Users from Current${SUFFIX}` },
      { name: 'empty', description: '' }
    ]);
  });

  it('does not touch custom channels or channels with no team', async () => {
    const { rows } = await pool.query(`SELECT name, description FROM channels WHERE name IN ('custom', 'no-team') ORDER BY name`);
    expect(rows).toEqual([
      { name: 'custom', description: `Custom channel: x${OLD}` },
      { name: 'no-team', description: `Users from Nobody${OLD}` }
    ]);
  });

  it('is idempotent: running it again changes nothing', async () => {
    const before = await pool.query(`SELECT name, description FROM channels UNION ALL SELECT name, description FROM region_channels ORDER BY 1, 2`);
    runMigrationChain(DB_NAME, MIGRATIONS_DIR, { direction: 'down', count: STEPS_FROM_THIS_MIGRATION });
    runMigrationChain(DB_NAME, MIGRATIONS_DIR);
    const after = await pool.query(`SELECT name, description FROM channels UNION ALL SELECT name, description FROM region_channels ORDER BY 1, 2`);
    expect(after.rows).toEqual(before.rows);
  });
});
