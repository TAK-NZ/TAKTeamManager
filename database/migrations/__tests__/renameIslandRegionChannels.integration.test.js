/**
 * Real-Postgres guard for `1790500000001_rename-island-region-channels.cjs`.
 *
 * An environment that already seeded the island channels under their short
 * names ("North Island" / "South Island") must end up with the "All of ..."
 * names, with the channel's membership rule following. The migration must also
 * be safe where it has nothing to do, where an operator customised the
 * description, and where the target name already exists.
 *
 * METHOD: run the full chain up, step this ONE migration down, seed rows in the
 * old shape, then run it up again.
 *
 * Excluded from `npm test` (`*.integration.test.js`). Run explicitly:
 *
 *   npx jest database/migrations/__tests__/renameIslandRegionChannels.integration.test.js \
 *     --testPathIgnorePatterns=/node_modules/ /client/
 */
const fs = require('fs');
const path = require('path');
const {
  createThrowawayDatabase,
  dropThrowawayDatabase,
  runMigrationChain
} = require('../../testHelpers/throwawayDatabase');

const MIGRATIONS_DIR = path.join(__dirname, '..');
const MIGRATION_FILE = '1790500000001_rename-island-region-channels.cjs';
const migrationPresent = fs.existsSync(path.join(MIGRATIONS_DIR, MIGRATION_FILE));
// This migration plus every later one.
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

const describeIfPresent = migrationPresent ? describe : describe.skip;

describeIfPresent('rename island region channels migration', () => {
  const DB_NAME = `rename_island_channels_test_${Date.now()}`;
  let pool;

  const addRule = (name, tier) => pool.query(
    `INSERT INTO group_membership_rules
       (rule_name, rule_type, source_type, source_id, target_group_pattern, permission_type, priority)
     SELECT 'Region ' || name || ' Read-Write Access', 'region_channels', 'region_channel', id,
            $2 || ' - ' || name, 'write', 61
       FROM region_channels WHERE name = $1 AND tier = $3`,
    [name, tier === 'coordination' ? 'tak_Coordination' : 'tak_Response', tier]
  );

  async function seedOldShape() {
    await pool.query(`
      INSERT INTO region_channels (name, display_name, description, group_id, tier) VALUES
        ('North Island', 'North Island', 'North Island (Coordination - All Agencies) loc', 'g-n', 'coordination'),
        ('South Island', 'South Island', 'hand written by an operator', 'g-s', 'coordination'),
        ('Waikato', 'Waikato', 'Waikato (Coordination - All Agencies)', 'g-w', 'coordination'),
        ('North Island', 'North Island', 'unrelated response row', 'g-rn', 'response')
    `);
    await addRule('North Island', 'coordination');
    await addRule('South Island', 'coordination');
    await addRule('Waikato', 'coordination');
  }

  beforeAll(async () => {
    pool = await createThrowawayDatabase(DB_NAME, 'The island channel rename guard');
    runMigrationChain(DB_NAME, MIGRATIONS_DIR);
    runMigrationChain(DB_NAME, MIGRATIONS_DIR, { direction: 'down', count: STEPS_FROM_THIS_MIGRATION });
    await seedOldShape();
    runMigrationChain(DB_NAME, MIGRATIONS_DIR);
  }, 180000);

  afterAll(async () => {
    if (pool) await pool.end();
    await dropThrowawayDatabase(DB_NAME);
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it('renames the coordination island channels, keeps their group ids, and leaves other rows alone', async () => {
    const { rows } = await pool.query(
      `SELECT name, display_name, tier, group_id FROM region_channels ORDER BY tier, group_id`
    );
    expect(rows).toEqual([
      { name: 'All of North Island', display_name: 'All of North Island', tier: 'coordination', group_id: 'g-n' },
      { name: 'All of South Island', display_name: 'All of South Island', tier: 'coordination', group_id: 'g-s' },
      { name: 'Waikato', display_name: 'Waikato', tier: 'coordination', group_id: 'g-w' },
      // The same short name in the RESPONSE tier is a different channel; untouched.
      { name: 'North Island', display_name: 'North Island', tier: 'response', group_id: 'g-rn' }
    ]);
  });

  it('rewrites only a stock description, preserving the suffix and any custom text', async () => {
    const { rows } = await pool.query(
      `SELECT group_id, description FROM region_channels WHERE tier = 'coordination' ORDER BY group_id`
    );
    expect(rows).toEqual([
      { group_id: 'g-n', description: 'All of North Island (Coordination - All Agencies) loc' },
      { group_id: 'g-s', description: 'hand written by an operator' },
      { group_id: 'g-w', description: 'Waikato (Coordination - All Agencies)' }
    ]);
  });

  it('moves the membership rules to the new name', async () => {
    const { rows } = await pool.query(
      `SELECT rule_name, target_group_pattern FROM group_membership_rules ORDER BY id`
    );
    expect(rows).toEqual([
      { rule_name: 'Region All of North Island Read-Write Access', target_group_pattern: 'tak_Coordination - All of North Island' },
      { rule_name: 'Region All of South Island Read-Write Access', target_group_pattern: 'tak_Coordination - All of South Island' },
      { rule_name: 'Region Waikato Read-Write Access', target_group_pattern: 'tak_Coordination - Waikato' }
    ]);
  });

  it('round-trips through down and up', async () => {
    runMigrationChain(DB_NAME, MIGRATIONS_DIR, { direction: 'down', count: STEPS_FROM_THIS_MIGRATION });
    const { rows: down } = await pool.query(
      `SELECT name FROM region_channels WHERE tier = 'coordination' AND group_id IN ('g-n','g-s') ORDER BY group_id`
    );
    expect(down.map((r) => r.name)).toEqual(['North Island', 'South Island']);
    runMigrationChain(DB_NAME, MIGRATIONS_DIR);
    const { rows: up } = await pool.query(
      `SELECT name FROM region_channels WHERE tier = 'coordination' AND group_id IN ('g-n','g-s') ORDER BY group_id`
    );
    expect(up.map((r) => r.name)).toEqual(['All of North Island', 'All of South Island']);
  });

  it('skips a rename whose target name already exists, rather than violating the (name, tier) unique index', async () => {
    runMigrationChain(DB_NAME, MIGRATIONS_DIR, { direction: 'down', count: STEPS_FROM_THIS_MIGRATION });
    await pool.query(
      `INSERT INTO region_channels (name, display_name, description, group_id, tier)
       VALUES ('All of South Island', 'All of South Island', 'already there', 'g-existing', 'coordination')`
    );
    runMigrationChain(DB_NAME, MIGRATIONS_DIR);
    const { rows } = await pool.query(
      `SELECT group_id, name FROM region_channels WHERE group_id IN ('g-s','g-existing') ORDER BY group_id`
    );
    expect(rows).toEqual([
      { group_id: 'g-existing', name: 'All of South Island' },
      { group_id: 'g-s', name: 'South Island' }
    ]);
  });
});
