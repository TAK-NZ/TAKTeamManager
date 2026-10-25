/**
 * Real-Postgres guard for `1790500000000_rename-support-tier-to-coordination.cjs`.
 *
 * Proves, against a live database holding data in the OLD ("support") shape,
 * that the migration:
 *   - re-tags `region_channels.tier` and swaps the CHECK constraint;
 *   - renames `teams.support_channel_access` without losing values;
 *   - rewrites the stored description qualifier and the region membership
 *     rules' `tak_Support` prefix;
 *   - rewrites `tier: 'support'` in NON-TERMINAL queued `sync_operations`
 *     payloads (and leaves completed history alone), so a queued operation is
 *     not permanently failed by the worker after the rename;
 *   - does NOT enqueue any Authentik group rename (that is done by the
 *     periodic `AuthentikSyncService.reconcileRegionChannelGroupNames`, which
 *     is robust to old Sync_Worker tasks running during a deploy);
 *   - reverses cleanly on `down`.
 *
 * METHOD: run the full chain up, step back down through this migration and
 * every migration after it (so the schema is in its pre-rename shape), seed
 * old-shape rows, then run the chain up again.
 * That avoids naming any other migration file, so a future baseline squash
 * only means this guard is skipped once the migration file is folded in.
 *
 * Excluded from `npm test` (`*.integration.test.js`). Run explicitly:
 *
 *   npx jest database/migrations/__tests__/renameSupportTierToCoordination.integration.test.js \
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
const MIGRATION_FILE = '1790500000000_rename-support-tier-to-coordination.cjs';
const migrationPresent = fs.existsSync(path.join(MIGRATIONS_DIR, MIGRATION_FILE));
// This migration plus every later one, so `down` lands on the pre-rename shape
// however many migrations are stacked on top of it.
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

describeIfPresent('rename support tier -> coordination migration', () => {
  const DB_NAME = `rename_support_tier_test_${Date.now()}`;
  let pool;

  async function seedOldShape() {
    await pool.query(`
      INSERT INTO region_channels (name, display_name, description, group_id, tier) VALUES
        ('Auckland', 'Auckland', 'Auckland (Response - Emergency Services)', 'g-resp', 'response'),
        ('Auckland', 'Auckland', 'Auckland (Support - All Agencies)', 'g-sup', 'support'),
        ('Waikato',  'Waikato',  'custom text', 'g-sup2', 'support'),
        ('Otago',    'Otago',    'Otago (Support - All Agencies)', NULL, 'support')
    `);
    await pool.query(`
      INSERT INTO group_membership_rules
        (rule_name, rule_type, source_type, source_id, target_group_pattern, permission_type, priority)
      SELECT 'r-' || id, 'region_channels', 'region_channel', id,
             'tak_' || CASE tier WHEN 'support' THEN 'Support' ELSE 'Response' END || ' - ' || name,
             'write', 61
        FROM region_channels
    `);
    await pool.query(`
      INSERT INTO sync_operations (operation_type, payload, status) VALUES
        ('create_region_channel_group', '{"region_channel_id":4,"channel_name":"Otago","tier":"support"}', 'pending'),
        ('resync_org_channel_tier_access', '{"organisation_id":1,"tier":"support"}', 'failed'),
        ('resync_org_channel_tier_access', '{"organisation_id":1,"tier":"support"}', 'completed'),
        ('create_region_channel_group', '{"region_channel_id":1,"channel_name":"Auckland","tier":"response"}', 'pending')
    `);
    await pool.query(`INSERT INTO teams (name, color, support_channel_access) VALUES ('Org A', 'Red', true), ('Org B', 'Red', false)`);
  }

  beforeAll(async () => {
    pool = await createThrowawayDatabase(DB_NAME, 'The support->coordination rename guard');
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

  it('re-tags support rows and leaves response rows alone', async () => {
    const { rows } = await pool.query(`SELECT tier, count(*)::int AS n FROM region_channels GROUP BY tier ORDER BY tier`);
    expect(rows).toEqual([
      { tier: 'coordination', n: 3 },
      { tier: 'response', n: 1 }
    ]);
  });

  it('the CHECK constraint admits coordination and rejects the old value', async () => {
    await expect(
      pool.query(`INSERT INTO region_channels (name, display_name, tier) VALUES ('X', 'X', 'support')`)
    ).rejects.toThrow(/region_channels_tier_check/);
    await expect(
      pool.query(`INSERT INTO region_channels (name, display_name, tier) VALUES ('Probe', 'Probe', 'coordination')`)
    ).resolves.toBeDefined();
  });

  it('renames the teams flag column and preserves its values', async () => {
    const { rows: cols } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'teams' AND column_name LIKE '%channel_access'
        ORDER BY column_name`
    );
    expect(cols.map((c) => c.column_name)).toEqual(['coordination_channel_access', 'response_channel_access']);
    const { rows } = await pool.query(`SELECT name, coordination_channel_access AS v FROM teams WHERE name LIKE 'Org %' ORDER BY name`);
    expect(rows).toEqual([{ name: 'Org A', v: true }, { name: 'Org B', v: false }]);
  });

  it('rewrites the description qualifier only where it was the stock text', async () => {
    const { rows } = await pool.query(`SELECT name, description FROM region_channels WHERE tier = 'coordination' AND name <> 'Probe' ORDER BY name`);
    expect(rows).toEqual([
      { name: 'Auckland', description: 'Auckland (Coordination - All Agencies)' },
      { name: 'Otago', description: 'Otago (Coordination - All Agencies)' },
      { name: 'Waikato', description: 'custom text' }
    ]);
  });

  it('rewrites the region membership rule prefix', async () => {
    const { rows } = await pool.query(`SELECT target_group_pattern AS p FROM group_membership_rules ORDER BY id`);
    expect(rows.map((r) => r.p)).toEqual([
      'tak_Response - Auckland',
      'tak_Coordination - Auckland',
      'tak_Coordination - Waikato',
      'tak_Coordination - Otago'
    ]);
  });

  it('rewrites tier in non-terminal queued payloads but not in completed history', async () => {
    const { rows } = await pool.query(
      `SELECT operation_type, status, payload ->> 'tier' AS tier FROM sync_operations
        WHERE operation_type <> 'update_region_channel_group' ORDER BY id`
    );
    expect(rows).toEqual([
      { operation_type: 'create_region_channel_group', status: 'pending', tier: 'coordination' },
      { operation_type: 'resync_org_channel_tier_access', status: 'failed', tier: 'coordination' },
      { operation_type: 'resync_org_channel_tier_access', status: 'completed', tier: 'support' },
      { operation_type: 'create_region_channel_group', status: 'pending', tier: 'response' }
    ]);
  });

  it('does not enqueue any Authentik group rename (the periodic reconcile owns that)', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM sync_operations WHERE operation_type = 'update_region_channel_group'`
    );
    expect(rows[0].n).toBe(0);
  });

  it('down reverses the schema and data rewrites', async () => {
    runMigrationChain(DB_NAME, MIGRATIONS_DIR, { direction: 'down', count: STEPS_FROM_THIS_MIGRATION });
    const { rows: tiers } = await pool.query(`SELECT DISTINCT tier FROM region_channels ORDER BY tier`);
    expect(tiers.map((t) => t.tier)).toEqual(['response', 'support']);
    const { rows: cols } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'teams' AND column_name = 'support_channel_access'`
    );
    expect(cols).toHaveLength(1);
  });
});
