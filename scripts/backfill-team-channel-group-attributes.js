'use strict';

/**
 * One-off backfill: sets the CloudTAK attribute set
 * (`agencyId`/`channelId`/`channelName`/`description`) on every existing
 * team-owned "main" Authentik group, which today carry only `description`.
 *
 * MUST RUN AFTER THE FIX IS DEPLOYED. It enqueues `update_channel_group`
 * Sync_Operations, whose handler (in the deployed code) re-derives the full
 * attribute set from the `channels` row and PATCHes the MAIN group
 * (`authentik_group_id`) with it — a primary team channel's sole group, or a
 * custom channel's read/write (main) group. The `_READ`/`_WRITE` groups keep
 * description-only, exactly as the handler does at steady state.
 *
 * Scope: every `channels` row that is team-owned (`team_id IS NOT NULL`) and
 * has a non-null `authentik_group_id` (its main group exists in Authentik).
 * A channel whose group has not been reconciled yet (`authentik_group_id IS
 * NULL`) is skipped — its pending `reconcile_team_channel_group` will create
 * the group WITH the full attributes (the deployed reconcile handler sets
 * them), so there is nothing to backfill for it.
 *
 * Why enqueue rather than PATCH directly: the `update_channel_group` handler
 * is the single source of truth for what a main group's attributes should be
 * (it re-derives from the row), so routing through it guarantees the backfill
 * writes the SAME shape steady-state writes do — no risk of this script and
 * the handler drifting. It is also idempotent (converges to current row
 * truth), rate-limited and retryable via the worker, per the codebase's
 * "Authentik writes go through the queue" convention.
 *
 * Idempotency & safety:
 *   - DRY-RUN BY DEFAULT: reports how many channels it WOULD enqueue for and
 *     does nothing unless run with `--apply`.
 *   - Leaves every `channels` row and Authentik group untouched itself; it
 *     only enqueues ops. Re-running only re-converges.
 *
 * Usage:
 *   node scripts/backfill-team-channel-group-attributes.js            # dry run
 *   node scripts/backfill-team-channel-group-attributes.js --apply    # enqueue
 */

// Load .env exactly like server/index.js and the sibling scripts do.
require('dotenv').config();

const pool = require('../server/config/database');
const EventPublisher = require('../server/services/EventPublisher');

function parseArgs(argv) {
  const args = { apply: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') args.apply = true;
  }
  return args;
}

// Every team-owned channel whose main Authentik group exists. Ordered by id
// for a stable, legible report.
async function loadTeamChannelsWithGroup() {
  const result = await pool.query(`
    SELECT id AS channel_id, team_id, display_name, is_primary, authentik_group_id
    FROM channels
    WHERE team_id IS NOT NULL
      AND authentik_group_id IS NOT NULL
    ORDER BY id
  `);
  return result.rows;
}

async function main() {
  const args = parseArgs(process.argv);
  const out = (line) => process.stdout.write(line + '\n');

  out('Backfill: set CloudTAK attributes (agencyId/channelId/channelName/description)');
  out('          on existing team-channel MAIN Authentik groups');
  out(args.apply ? 'MODE: APPLY (update_channel_group ops will be enqueued)'
                 : 'MODE: DRY RUN (no changes; pass --apply to enqueue)');
  out('');

  const channels = await loadTeamChannelsWithGroup();
  const primary = channels.filter((c) => c.is_primary);
  const custom = channels.filter((c) => !c.is_primary);

  out(`Team-owned channels with a main group: ${channels.length} (${primary.length} primary, ${custom.length} custom)`);
  out('');

  if (channels.length === 0) {
    out('No team-channel main groups to backfill. Nothing to do.');
    await pool.end();
    process.exit(0);
  }

  for (const c of channels) {
    out(`  ${c.is_primary ? '[primary]' : '[custom] '} channel ${c.channel_id} (team ${c.team_id}) "${c.display_name}" -> agencyId=${c.team_id}, channelId=${c.channel_id}`);
  }
  out('');

  if (!args.apply) {
    out('Dry run complete. Re-run with --apply to enqueue update_channel_group for each channel above.');
    await pool.end();
    process.exit(0);
  }

  let enqueued = 0;
  let failed = 0;
  for (const c of channels) {
    try {
      // Payload is just { channel_id }: the handler re-derives the full
      // attribute set from the row (single source of truth).
      const id = await EventPublisher.publishOperation('update_channel_group', { channel_id: c.channel_id }, null);
      enqueued++;
      out(`  ✓ channel ${c.channel_id}: update_channel_group enqueued as op ${id}`);
    } catch (error) {
      failed++;
      process.stderr.write(
        `  ✗ channel ${c.channel_id} (team ${c.team_id}): ${error && error.message ? error.message : error}\n`
      );
    }
  }

  out('\nSummary:');
  out(`  enqueued: ${enqueued}`);
  out(`  failed:   ${failed}`);

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
