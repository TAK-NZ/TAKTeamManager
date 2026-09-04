'use strict';

/**
 * Cleanup helper: deletes Authentik groups belonging to the team-channel
 * naming scheme (`tak_Teams - ...`, see `Team.createTeamChannel`) that have
 * NO corresponding local `channels` row referencing their `pk`.
 *
 * Why these orphans exist: `Team.createTeamChannel` used to create the
 * Authentik group synchronously and, on ANY failure of that call, silently
 * fall back to inserting the channel row with a NULL `authentik_group_id` --
 * even when Authentik had actually created (or already held) the group. On
 * team deletion, `_deleteSingleTeamInTransaction` enqueues a
 * `remove_team_channel_group` op carrying only the stored group id(s); a
 * NULL id means the worker has nothing to delete, so the real Authentik
 * group survives the team's deletion. This script reconciles that drift.
 *
 * Safety:
 *   - DRY-RUN BY DEFAULT. It only reports what it WOULD delete unless run
 *     with `--delete`.
 *   - It only ever considers groups whose name starts with the team-channel
 *     prefix (default `tak_Teams`, override with `--prefix=...`), and only
 *     those whose `pk` is not referenced by ANY channel group-id column
 *     across every channel table (`channels`, `bch_channels`,
 *     `region_channels`) -- so a live team/BCH/region channel group is never
 *     a deletion candidate even if its name happened to match.
 *
 * Usage:
 *   node scripts/cleanup-orphaned-team-groups.js            # dry run
 *   node scripts/cleanup-orphaned-team-groups.js --delete   # actually delete
 *   node scripts/cleanup-orphaned-team-groups.js --prefix="tak_Teams - LSAR"
 *
 * Modeled on the other operational scripts here (`process.stdout`/
 * `process.stderr` output, matching the lint-clean scripts convention).
 */

// Load .env exactly like server/index.js does, so this script can be run
// standalone (`node scripts/cleanup-orphaned-team-groups.js`) and still pick
// up DB_* and AUTHENTIK_* the same way the app does.
require('dotenv').config();

const pool = require('../server/config/database');
const authentik = require('../server/services/authentik');

function parseArgs(argv) {
  const args = { delete: false, prefix: 'tak_Teams' };
  for (const arg of argv.slice(2)) {
    if (arg === '--delete') {
      args.delete = true;
    } else if (arg.startsWith('--prefix=')) {
      args.prefix = arg.slice('--prefix='.length);
    }
  }
  return args;
}

// Collect every Authentik group id referenced by ANY local channel row,
// across every channel table and every group-id column, so a referenced
// (live) group is never treated as an orphan.
async function loadReferencedGroupIds() {
  const referenced = new Set();
  const add = (value) => {
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      referenced.add(String(value));
    }
  };

  const channels = await pool.query(
    'SELECT authentik_group_id, authentik_read_group_id, authentik_write_group_id FROM channels'
  );
  for (const row of channels.rows) {
    add(row.authentik_group_id);
    add(row.authentik_read_group_id);
    add(row.authentik_write_group_id);
  }

  const bch = await pool.query('SELECT read_group_id, write_group_id FROM bch_channels');
  for (const row of bch.rows) {
    add(row.read_group_id);
    add(row.write_group_id);
  }

  const regions = await pool.query('SELECT group_id FROM region_channels');
  for (const row of regions.rows) {
    add(row.group_id);
  }

  return referenced;
}

async function main() {
  const args = parseArgs(process.argv);

  process.stdout.write(
    `Scanning Authentik for orphaned team-channel groups (prefix "${args.prefix}")...\n` +
    (args.delete ? 'MODE: DELETE (orphans will be removed)\n' : 'MODE: DRY RUN (no changes; pass --delete to remove)\n')
  );

  const referencedGroupIds = await loadReferencedGroupIds();
  process.stdout.write(`Local channels reference ${referencedGroupIds.size} distinct Authentik group id(s)\n`);

  const allGroups = await authentik.getAllGroups();
  process.stdout.write(`Authentik returned ${allGroups.length} group(s) total\n`);

  const orphans = allGroups.filter(
    (group) =>
      typeof group.name === 'string' &&
      group.name.startsWith(args.prefix) &&
      !referencedGroupIds.has(String(group.pk))
  );

  if (orphans.length === 0) {
    process.stdout.write('No orphaned team-channel groups found. Nothing to do.\n');
    await pool.end();
    process.exit(0);
  }

  process.stdout.write(`Found ${orphans.length} orphaned team-channel group(s):\n`);
  for (const group of orphans) {
    process.stdout.write(`  - ${group.name} (pk=${group.pk})\n`);
  }

  if (!args.delete) {
    process.stdout.write('\nDry run complete. Re-run with --delete to remove the groups listed above.\n');
    await pool.end();
    process.exit(0);
  }

  let deleted = 0;
  let failed = 0;
  for (const group of orphans) {
    try {
      await authentik.deleteGroup(group.pk);
      deleted++;
      process.stdout.write(`✓ Deleted ${group.name} (pk=${group.pk})\n`);
    } catch (error) {
      failed++;
      process.stderr.write(
        `✗ Failed to delete ${group.name} (pk=${group.pk}): ${error && error.message ? error.message : error}\n`
      );
    }
  }

  process.stdout.write(`\nDone. Deleted ${deleted} group(s), ${failed} failure(s).\n`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  process.stderr.write(`Error cleaning up orphaned team groups: ${error && error.stack ? error.stack : error}\n`);
  try {
    await pool.end();
  } catch {
    // ignore pool teardown errors during a failure exit
  }
  process.exit(1);
});
