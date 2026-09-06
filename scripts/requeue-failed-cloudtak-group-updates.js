'use strict';

/**
 * One-time requeue: re-enqueues `update_cloudtak_group` Sync_Operations that
 * previously FAILED payload validation because their `team_id` was a STRING
 * ("3") instead of a number (3).
 *
 * Why those rows exist: `Team.update`/`Team.addMember` (and the create-and-add
 * admin-promotion route) enqueued `update_cloudtak_group` with `teamId` taken
 * straight from `req.params.teamId`/`req.body.teamId` -- a STRING. The op's
 * payload schema (`server/workers/operationSchemas.js`) requires
 * `team_id: 'number'`, so every one failed at dequeue with
 * `payload_validation: field "team_id" has type "string", expected "number"`,
 * classified `validation` (PERMANENT, no retry) -- so they sit `failed`
 * forever. The enqueue-site coercion (`Number(teamId)`) now prevents NEW ones;
 * this script clears the already-failed backlog.
 *
 * What it does:
 *   - Finds the DISTINCT `team_id`s across all failed `update_cloudtak_group`
 *     rows (parsing the string payload to an integer).
 *   - Requeues ONE fresh `update_cloudtak_group` op per team that STILL
 *     EXISTS, with a correct numeric `team_id`, via
 *     `EventPublisher.publishOperation` (so it gets the right derived
 *     priority and correlation handling). The old `failed` rows are LEFT in
 *     place as an audit trail -- this never mutates or deletes them.
 *   - SKIPS teams that no longer exist: the worker's `updateCloudTakGroup`
 *     handler treats a missing team as a no-op success, so requeuing one is
 *     pointless queue churn. (The stale failed row for a deleted team is
 *     moot -- the group is handled by its own `delete_cloudtak_group`.)
 *
 * Idempotency & safety:
 *   - `update_cloudtak_group` recomputes the Team's COMPLETE Direct_Admin_Set
 *     and Agency_Attributes from the DB at run time, so requeuing only
 *     converges each group to current truth -- safe to run more than once.
 *   - DRY-RUN BY DEFAULT: reports which teams it WOULD requeue (and which it
 *     skips as deleted) unless run with `--apply`.
 *   - Guarded by CloudTAK being enabled: if `CLOUDTAK_ENABLED` is not
 *     'true', the requeued ops would drain as no-ops at best; the script
 *     refuses to run unless `--force` is passed, so it isn't run pointlessly
 *     against a deployment with the feature off.
 *
 * Usage:
 *   node scripts/requeue-failed-cloudtak-group-updates.js            # dry run
 *   node scripts/requeue-failed-cloudtak-group-updates.js --apply    # requeue
 *   node scripts/requeue-failed-cloudtak-group-updates.js --apply --force
 */

// Load .env exactly like server/index.js and the sibling scripts do.
require('dotenv').config();

const pool = require('../server/config/database');
const EventPublisher = require('../server/services/EventPublisher');
const { isCloudTakEnabled } = require('../server/config/cloudtak');

function parseArgs(argv) {
  const args = { apply: false, force: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--force') args.force = true;
  }
  return args;
}

// The distinct, still-existing team ids behind the failed
// update_cloudtak_group rows, each as a real integer. A non-numeric payload
// (should not exist, but be defensive) is skipped by the `~ '^[0-9]+$'`
// filter. The LEFT JOIN classifies each as live (teams.id present) or
// deleted.
async function loadAffectedTeams() {
  const result = await pool.query(
    `
    WITH failed_team_ids AS (
      SELECT DISTINCT (payload->>'team_id') AS team_id_str
      FROM sync_operations
      WHERE operation_type = 'update_cloudtak_group'
        AND status = 'failed'
        AND (payload->>'team_id') ~ '^[0-9]+$'
    )
    SELECT
      f.team_id_str::int AS team_id,
      (t.id IS NOT NULL)  AS team_exists
    FROM failed_team_ids f
    LEFT JOIN teams t ON t.id = f.team_id_str::int
    ORDER BY f.team_id_str::int
    `
  );
  return result.rows;
}

async function main() {
  const args = parseArgs(process.argv);
  const out = (line) => process.stdout.write(line + '\n');

  if (!isCloudTakEnabled() && !args.force) {
    out('CLOUDTAK_ENABLED is not "true" -- requeued ops would be no-ops. ' +
        'Refusing to run; pass --force to override.');
    await pool.end();
    process.exit(0);
  }

  out('Requeue: failed update_cloudtak_group ops (string team_id -> numeric)');
  out(args.apply ? 'MODE: APPLY (fresh ops will be enqueued)'
                 : 'MODE: DRY RUN (no changes; pass --apply to enqueue)');
  out('');

  const teams = await loadAffectedTeams();
  const live = teams.filter((t) => t.team_exists);
  const deleted = teams.filter((t) => !t.team_exists);

  out(`Distinct affected teams: ${teams.length} (${live.length} live, ${deleted.length} deleted/skipped)`);
  if (deleted.length > 0) {
    out(`  Skipping deleted teams (handler no-ops for them): ${deleted.map((t) => t.team_id).join(', ')}`);
  }
  if (live.length === 0) {
    out('\nNo live teams to requeue. Nothing to do.');
    await pool.end();
    process.exit(0);
  }

  let enqueued = 0;
  let failed = 0;
  for (const { team_id: teamId } of live) {
    if (!args.apply) {
      out(`  - would requeue update_cloudtak_group { team_id: ${teamId} } (number)`);
      continue;
    }
    try {
      // created_by = null: this is a system-initiated repair, not an admin
      // action, mirroring the model-level enqueue sites' own attribution.
      const id = await EventPublisher.publishOperation('update_cloudtak_group', { team_id: teamId }, null);
      enqueued++;
      out(`  ✓ requeued update_cloudtak_group { team_id: ${teamId} } as op ${id}`);
    } catch (error) {
      failed++;
      process.stderr.write(
        `  ✗ failed to requeue team ${teamId}: ${error && error.message ? error.message : error}\n`
      );
    }
  }

  out('\nSummary:');
  if (args.apply) {
    out(`  requeued: ${enqueued}`);
    out(`  failed:   ${failed}`);
  } else {
    out(`  would requeue: ${live.length}`);
  }
  out(`  deleted teams skipped: ${deleted.length}`);
  if (!args.apply) out('\nDry run complete. Re-run with --apply to enqueue the ops above.');

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  process.stderr.write(`Requeue error: ${error && error.stack ? error.stack : error}\n`);
  try {
    await pool.end();
  } catch {
    // ignore pool teardown errors during a failure exit
  }
  process.exit(1);
});
