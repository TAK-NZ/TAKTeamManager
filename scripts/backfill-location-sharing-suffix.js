'use strict';

/**
 * One-off backfill: normalizes the location-sharing suffix on existing
 * PRIMARY team-channel and Response/Support (region) channel descriptions to
 * the unified `(Bi-directional location sharing)`, and enqueues the matching
 * Authentik-sync op so each group's `attributes.description` (LDAP-visible)
 * and the /dashboard tree converge on the same stored value.
 *
 * MUST RUN AFTER THE FIX IS DEPLOYED. The unified suffix now lives IN the
 * stored `description` column (single source of truth); this script brings
 * pre-fix rows up to that shape:
 *
 *   - TEAM primary channels (`channels`, is_primary, team_id NOT NULL):
 *     old rows end with `(Location sharing enabled)`. Replace that trailing
 *     qualifier with `(Bi-directional location sharing)`. If a row has some
 *     other (or no) trailing qualifier, the suffix is appended. Then enqueue
 *     `update_channel_group { channel_id }` -- the handler re-derives the
 *     full attribute set (incl. description) from the row and PATCHes the
 *     MAIN group.
 *
 *   - REGION channels (`region_channels`): old rows have NO suffix (it was
 *     previously appended only at Authentik-write time and stripped back out
 *     of the DB). Append `(Bi-directional location sharing)` if missing. Then
 *     enqueue `update_region_channel_group { region_channel_id, channel_name,
 *     description }` so the Authentik group PATCHes to the stored value.
 *
 * Idempotency & safety:
 *   - DRY-RUN BY DEFAULT: reports the per-row before/after and does nothing
 *     unless run with `--apply`.
 *   - Append-once: a row whose description ALREADY ends with the unified
 *     suffix is skipped (no update, no enqueue).
 *   - Only the trailing `(Location sharing enabled)` qualifier is rewritten
 *     for team rows; any other description text is preserved. A region row's
 *     base text (incl. the seed's `(Response - ...)`/`(Support - ...)`
 *     qualifier) is preserved and the suffix appended after it.
 *   - Local rows are updated FIRST, then the sync op enqueued, so a re-run
 *     sees the corrected row and does nothing further.
 *
 * Usage:
 *   node scripts/backfill-location-sharing-suffix.js            # dry run
 *   node scripts/backfill-location-sharing-suffix.js --apply    # apply
 */

// Load .env exactly like server/index.js and the sibling scripts do.
require('dotenv').config();

const pool = require('../server/config/database');
const EventPublisher = require('../server/services/EventPublisher');
const { LOCATION_SHARING_DESCRIPTION_SUFFIX } = require('../server/config/constants');

// The exact old team-channel qualifier (with its leading space) that must be
// rewritten to the unified suffix.
const OLD_TEAM_SUFFIX = ' (Location sharing enabled)';

function parseArgs(argv) {
  const args = { apply: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') args.apply = true;
  }
  return args;
}

/**
 * Compute the normalized description for a row, or null if it already ends
 * with the unified suffix (nothing to do).
 */
function normalize(description) {
  const base = description || '';
  if (base.endsWith(LOCATION_SHARING_DESCRIPTION_SUFFIX)) {
    return null; // already correct
  }
  // Strip a trailing OLD team qualifier if present, then append the unified
  // suffix. (Region rows have no trailing qualifier to strip; the suffix is
  // simply appended after their base text.)
  const stripped = base.endsWith(OLD_TEAM_SUFFIX)
    ? base.slice(0, -OLD_TEAM_SUFFIX.length)
    : base;
  return `${stripped}${LOCATION_SHARING_DESCRIPTION_SUFFIX}`;
}

async function loadTeamChannels() {
  const result = await pool.query(`
    SELECT id, team_id, display_name, description
    FROM channels
    WHERE is_primary = true AND team_id IS NOT NULL
    ORDER BY id
  `);
  return result.rows;
}

async function loadRegionChannels() {
  const result = await pool.query(`
    SELECT id, name, description
    FROM region_channels
    ORDER BY id
  `);
  return result.rows;
}

async function main() {
  const args = parseArgs(process.argv);
  const out = (line) => process.stdout.write(line + '\n');

  out('Backfill: unify location-sharing suffix -> "(Bi-directional location sharing)"');
  out(args.apply ? 'MODE: APPLY (descriptions updated + sync ops enqueued)'
                 : 'MODE: DRY RUN (no changes; pass --apply)');
  out('');

  const [teamChannels, regionChannels] = await Promise.all([
    loadTeamChannels(),
    loadRegionChannels()
  ]);

  const teamPlan = teamChannels
    .map((row) => ({ row, newDescription: normalize(row.description) }))
    .filter((p) => p.newDescription !== null);
  const regionPlan = regionChannels
    .map((row) => ({ row, newDescription: normalize(row.description) }))
    .filter((p) => p.newDescription !== null);

  out(`Team primary channels: ${teamChannels.length} scanned, ${teamPlan.length} to update`);
  out(`Region channels:       ${regionChannels.length} scanned, ${regionPlan.length} to update`);
  out('');

  for (const { row, newDescription } of teamPlan) {
    out(`  [team]   channel ${row.id} (team ${row.team_id})`);
    out(`      ${JSON.stringify(row.description)} -> ${JSON.stringify(newDescription)}`);
  }
  for (const { row, newDescription } of regionPlan) {
    out(`  [region] channel ${row.id} "${row.name}"`);
    out(`      ${JSON.stringify(row.description)} -> ${JSON.stringify(newDescription)}`);
  }
  out('');

  if (teamPlan.length === 0 && regionPlan.length === 0) {
    out('Nothing to update. Every description already carries the unified suffix.');
    await pool.end();
    process.exit(0);
  }

  if (!args.apply) {
    out('Dry run complete. Re-run with --apply to update descriptions and enqueue sync ops.');
    await pool.end();
    process.exit(0);
  }

  let updated = 0;
  let failed = 0;

  for (const { row, newDescription } of teamPlan) {
    try {
      await pool.query(
        'UPDATE channels SET description = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [newDescription, row.id]
      );
      // update_channel_group re-derives the full attribute set (incl.
      // description) from the row and PATCHes the MAIN group only.
      const opId = await EventPublisher.publishOperation(
        'update_channel_group',
        { channel_id: row.id },
        null
      );
      updated++;
      out(`  ✓ team channel ${row.id}: description updated, update_channel_group enqueued as op ${opId}`);
    } catch (error) {
      failed++;
      process.stderr.write(`  ✗ team channel ${row.id}: ${error && error.message ? error.message : error}\n`);
    }
  }

  for (const { row, newDescription } of regionPlan) {
    try {
      await pool.query(
        'UPDATE region_channels SET description = $1 WHERE id = $2',
        [newDescription, row.id]
      );
      const opId = await EventPublisher.publishOperation(
        'update_region_channel_group',
        { region_channel_id: row.id, channel_name: row.name, description: newDescription },
        null
      );
      updated++;
      out(`  ✓ region channel ${row.id}: description updated, update_region_channel_group enqueued as op ${opId}`);
    } catch (error) {
      failed++;
      process.stderr.write(`  ✗ region channel ${row.id}: ${error && error.message ? error.message : error}\n`);
    }
  }

  out('\nSummary:');
  out(`  updated (ops enqueued): ${updated}`);
  out(`  failed:                 ${failed}`);

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  process.stderr.write(`Backfill error: ${error && error.stack ? error.stack : error}\n`);
  try {
    await pool.end();
  } catch {
    // ignore pool teardown errors during a failure exit
  }
  process.exit(1);
});
