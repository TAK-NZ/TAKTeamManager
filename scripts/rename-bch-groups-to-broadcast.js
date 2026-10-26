'use strict';

/**
 * One-off rename: moves existing BCH-category Authentik groups from the old
 * `tak_BCH - ...` naming to the new `tak_Broadcast - ...` naming, after the
 * change that set `BCH_CHANNEL_CATEGORY_PREFIX.BCH` to 'Broadcast'
 * (server/config/constants.js).
 *
 * Why it is needed: that constant only names groups created or edited from
 * now on. The Sync_Worker renames a BCH group only when someone edits that
 * channel, so every existing `tak_BCH - ...` group would otherwise keep its
 * old name. Until renamed, "Sync Existing Channels" does not recognise it,
 * the Dashboard/descriptions endpoint cannot classify it, and TAK clients
 * keep showing the old folder name.
 *
 * What it renames: only groups that BOTH (a) start with `tak_BCH<separator>`
 * AND (b) are referenced by a `bch_channels` row of category 'BCH' as its
 * read or write group. The only change is the prefix swap, so the rest of
 * the name (including any `_READ` suffix) is preserved exactly. The DB is
 * not modified: `bch_channels` refers to groups by id, and its `name` column
 * never stored the prefix.
 *
 * Safety:
 *   - DRY-RUN BY DEFAULT. Reports the plan and changes nothing unless run
 *     with `--apply`.
 *   - Renames in place by pk with a name-only PATCH, so membership and
 *     attributes are untouched and no federated identity is ever deleted.
 *   - A group is skipped, and reported, if its target name is already taken
 *     by a DIFFERENT group (Authentik group names are unique).
 *   - A `tak_BCH - ...` group NOT linked to a BCH-category channel is left
 *     alone and listed. That includes XtraTools (UTL) groups that happen to
 *     carry the prefix. Rename those by hand if you want them imported.
 *   - Idempotent: an already-renamed group no longer matches the old
 *     prefix, so a re-run only picks up what is left.
 *
 * Afterwards the periodic Authentik sync refreshes `user_cache.groups` with
 * the new names.
 *
 * Usage:
 *   node scripts/rename-bch-groups-to-broadcast.js            # dry run
 *   node scripts/rename-bch-groups-to-broadcast.js --apply    # rename
 */

// Load .env exactly like server/index.js and the sibling scripts do.
require('dotenv').config();

const pool = require('../server/config/database');
const authentik = require('../server/services/authentik');
const { BCH_CHANNEL_CATEGORY_PREFIX } = require('../server/config/constants');
const { resolveChannelFolderSeparator } = require('../server/utils/channelFolderSeparator');

// The display prefix BCH-category groups used before the rename. Deliberately
// a literal: it is history, not configuration, so it must not follow the
// constant.
const LEGACY_PREFIX = 'BCH';

function parseArgs(argv) {
  const args = { apply: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') args.apply = true;
  }
  return args;
}

// Every Authentik group id referenced by a BCH-category channel, as strings.
async function loadBchCategoryGroupIds() {
  const result = await pool.query(
    "SELECT read_group_id, write_group_id FROM bch_channels WHERE category = 'BCH'"
  );
  const ids = new Set();
  for (const row of result.rows) {
    for (const value of [row.read_group_id, row.write_group_id]) {
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        ids.add(String(value));
      }
    }
  }
  return ids;
}

async function main() {
  const args = parseArgs(process.argv);
  const out = (line) => process.stdout.write(line + '\n');

  const separator = resolveChannelFolderSeparator();
  const oldPrefix = `tak_${LEGACY_PREFIX}${separator}`;
  const newPrefix = `tak_${BCH_CHANNEL_CATEGORY_PREFIX.BCH}${separator}`;

  out(`Rename BCH-category Authentik groups: "${oldPrefix}..." -> "${newPrefix}..."`);
  out(args.apply ? 'MODE: APPLY (groups will be renamed)'
                 : 'MODE: DRY RUN (no changes; pass --apply to rename)');
  out('');

  if (oldPrefix === newPrefix) {
    out('The configured BCH display prefix is still the legacy one; nothing to rename.');
    await pool.end();
    process.exit(0);
  }

  const linkedGroupIds = await loadBchCategoryGroupIds();
  out(`BCH-category channels reference ${linkedGroupIds.size} distinct Authentik group id(s)`);

  const allGroups = await authentik.getAllGroups();
  out(`Authentik returned ${allGroups.length} group(s) total`);
  out('');

  const namesInUse = new Map();
  for (const group of allGroups) {
    if (typeof group.name === 'string') namesInUse.set(group.name, String(group.pk));
  }

  const toRename = [];
  const conflicts = [];
  const unlinked = [];
  for (const group of allGroups) {
    if (typeof group.name !== 'string' || !group.name.startsWith(oldPrefix)) continue;

    if (!linkedGroupIds.has(String(group.pk))) {
      unlinked.push(group);
      continue;
    }

    const newName = newPrefix + group.name.slice(oldPrefix.length);
    const holder = namesInUse.get(newName);
    if (holder !== undefined && holder !== String(group.pk)) {
      conflicts.push({ group, newName, holderPk: holder });
      continue;
    }
    toRename.push({ group, newName });
  }

  out(`To rename:                          ${toRename.length}`);
  out(`Skipped (target name already used): ${conflicts.length}`);
  out(`Left alone (not a BCH channel group): ${unlinked.length}`);
  out('');

  for (const { group, newName } of toRename) {
    out(`  [rename] ${group.name} -> ${newName} (pk=${group.pk})`);
  }
  for (const { group, newName, holderPk } of conflicts) {
    out(`  [skip]   ${group.name} (pk=${group.pk}): "${newName}" already exists as pk=${holderPk}`);
  }
  for (const group of unlinked) {
    out(`  [alone]  ${group.name} (pk=${group.pk}): not referenced by a BCH-category channel`);
  }
  if (toRename.length + conflicts.length + unlinked.length > 0) out('');

  if (toRename.length === 0) {
    out('Nothing to rename.');
    await pool.end();
    process.exit(conflicts.length > 0 ? 1 : 0);
  }

  if (!args.apply) {
    out('Dry run complete. Re-run with --apply to rename the groups listed above.');
    await pool.end();
    process.exit(0);
  }

  let renamed = 0;
  let failed = 0;
  for (const { group, newName } of toRename) {
    try {
      await authentik.renameGroup(group.pk, newName);
      renamed++;
      out(`  ✓ Renamed ${group.name} -> ${newName} (pk=${group.pk})`);
    } catch (error) {
      failed++;
      process.stderr.write(
        `  ✗ Failed to rename ${group.name} (pk=${group.pk}): ${error && error.message ? error.message : error}\n`
      );
    }
  }

  out(`\nDone. Renamed ${renamed} group(s), ${failed} failure(s), ${conflicts.length} skipped.`);
  if (renamed > 0) {
    out('The next periodic Authentik sync refreshes cached group names for users.');
  }

  await pool.end();
  process.exit(failed > 0 || conflicts.length > 0 ? 1 : 0);
}

main().catch(async (error) => {
  process.stderr.write(`Rename error: ${error && error.stack ? error.stack : error}\n`);
  try {
    await pool.end();
  } catch {
    // ignore pool teardown errors during a failure exit
  }
  process.exit(1);
});
