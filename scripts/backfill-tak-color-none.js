'use strict';

/**
 * One-time backfill: corrects every `user_cache` row whose `tak_color` or
 * `tak_callsign` carries a FORBIDDEN legacy value -- the literal string
 * `'None'` or an empty string `''` -- and repairs the mirrored Authentik
 * `takColor`/`takCallsign` attributes to match.
 *
 * Why these rows exist: the periodic sync's Reconciliation_Sweep used to
 * clear a candidate's cached callsign/colour to the literal `'None'` when it
 * (often FALSELY) believed the Authentik identity was missing -- a
 * pagination race during a concurrent bulk import once falsely orphaned
 * ~180 real accounts. The orphan-recovery paths restored `is_active` but
 * never recomputed the team-derived callsign/colour, so `'None'` became
 * permanent and was then pushed up to Authentik's `takColor` attribute --
 * surfacing as the impossible `takColor: None` on users who actually hold a
 * team membership (e.g. every FENZ member should be `Red`). The sync-side
 * root-cause fixes (the teamless-gated sweep clear + the recovery recompute
 * + the ABSENT-not-'None' push) stop NEW rows appearing; this script
 * repairs the ones already written before those fixes shipped.
 *
 * What it does per affected row, matching the app's own single-user paths
 * exactly (never inventing a value):
 *   - TEAMED user (has a DIRECT `team_memberships` row): recompute the real
 *     callsign/colour from the Organisation via
 *     `UserAttributesService.generateCallsign(userId, directTeamId)`, PATCH
 *     Authentik (`takCallsign`/`takColor`) and mirror into `user_cache` --
 *     the same write the `/api/users/add-to-team` route performs.
 *   - TEAMLESS user (no direct membership): `clearTeamAttributes`, which
 *     DELETES the `takCallsign`/`takColor` keys in Authentik and sets the
 *     `user_cache` columns to SQL `NULL` -- ABSENT, never `'None'`/`''`.
 *
 * ABSENT-not-'None' rule (see product.md): a teamless user's
 * `takColor`/`takCallsign` must be ABSENT (Authentik key deleted, cache
 * NULL), never the literal `'None'` or `''`. This script never writes
 * either of those values back.
 *
 * All Authentik calls route through `UserAttributesService`, whose
 * GET/PATCH pairs already go through the SHARED Authentik rate limiter
 * (`authentikRequest`) -- so this bulk repair draws from the same read/write
 * token budget as the app and the Sync_Worker rather than a fourth
 * independent stream. A small inter-row delay (`--delay-ms`, default 100) is
 * added on top as extra headroom for a large run.
 *
 * Safety:
 *   - DRY-RUN BY DEFAULT. Reports what it WOULD change (and the recomputed
 *     colour for each teamed user) unless run with `--apply`.
 *   - Team_Owned_Device rows (`is_team_device = true`) are skipped: they
 *     carry no team-derived callsign/colour.
 *   - Each row is independent; one failure is logged and the run continues.
 *   - `--limit=N` processes only the first N affected rows (useful for a
 *     cautious first pass).
 *
 * Usage:
 *   node scripts/backfill-tak-color-none.js                 # dry run (all)
 *   node scripts/backfill-tak-color-none.js --limit=10      # dry run, first 10
 *   node scripts/backfill-tak-color-none.js --apply         # apply to all
 *   node scripts/backfill-tak-color-none.js --apply --limit=50 --delay-ms=200
 */

// Load .env exactly like server/index.js and the sibling scripts do, so this
// can run standalone and still pick up DB_* and AUTHENTIK_* the same way.
require('dotenv').config();

const pool = require('../server/config/database');
const UserAttributesService = require('../server/services/userAttributes');

// The forbidden legacy values this backfill hunts for, in BOTH columns.
const FORBIDDEN_VALUES = ['None', ''];

function parseArgs(argv) {
  const args = { apply: false, limit: null, delayMs: 100 };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg.startsWith('--limit=')) {
      const n = parseInt(arg.slice('--limit='.length), 10);
      if (Number.isInteger(n) && n > 0) args.limit = n;
    } else if (arg.startsWith('--delay-ms=')) {
      const n = parseInt(arg.slice('--delay-ms='.length), 10);
      if (Number.isInteger(n) && n >= 0) args.delayMs = n;
    }
  }
  return args;
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// Every affected user_cache row joined to its local users row (for the local
// id needed by generateCallsign/clearTeamAttributes) and its DIRECT team
// (inherited_from_team_id IS NULL), if any. A NULL direct_team_id means the
// user is genuinely teamless.
async function loadAffectedRows() {
  const result = await pool.query(
    `SELECT
        uc.authentik_id,
        uc.username,
        uc.tak_callsign,
        uc.tak_color,
        u.id            AS local_user_id,
        u.is_team_device,
        dm.team_id      AS direct_team_id
       FROM user_cache uc
       JOIN users u ON u.authentik_user_id::text = uc.authentik_id
       LEFT JOIN team_memberships dm
         ON dm.user_id = u.id AND dm.inherited_from_team_id IS NULL
      WHERE uc.tak_color = ANY($1::text[])
         OR uc.tak_callsign = ANY($1::text[])
      ORDER BY uc.authentik_id`,
    [FORBIDDEN_VALUES]
  );
  return result.rows;
}

async function repairTeamedUser(row, apply, out) {
  const attributes = await UserAttributesService.generateCallsign(row.local_user_id, row.direct_team_id);
  if (!attributes) {
    out(`  ! ${row.username} (id=${row.local_user_id}): could not resolve callsign/colour ` +
        `for direct team ${row.direct_team_id} (user/team not found); SKIPPED`);
    return { status: 'skipped' };
  }

  out(`  - ${row.username} (id=${row.local_user_id}) team=${row.direct_team_id}: ` +
      `${row.tak_callsign ?? 'NULL'}/${row.tak_color ?? 'NULL'} -> ` +
      `${attributes.callsign}/${attributes.color}`);

  if (!apply) return { status: 'would-fix' };

  // Push to Authentik (takCallsign/takColor). NOT role -- generateCallsign
  // hardcodes 'Team Member' and tak_role is separately managed (same rule
  // the /add-to-team and Member_List edit paths follow).
  const pushed = await UserAttributesService.updateUserAttributes(row.authentik_id, {
    callsign: attributes.callsign,
    color: attributes.color
  });
  if (!pushed) {
    out(`  ✗ ${row.username}: Authentik PATCH failed; cache NOT updated (will retry on re-run)`);
    return { status: 'failed' };
  }

  // Mirror into user_cache -- callsign/colour only, never tak_role.
  await pool.query(
    'UPDATE user_cache SET tak_callsign = $1, tak_color = $2 WHERE authentik_id = $3',
    [attributes.callsign, attributes.color, row.authentik_id]
  );
  out(`  ✓ ${row.username}: fixed to ${attributes.callsign}/${attributes.color}`);
  return { status: 'fixed' };
}

async function repairTeamlessUser(row, apply, out) {
  out(`  - ${row.username} (id=${row.local_user_id}) TEAMLESS: ` +
      `${row.tak_callsign ?? 'NULL'}/${row.tak_color ?? 'NULL'} -> ABSENT (delete keys / NULL)`);

  if (!apply) return { status: 'would-clear' };

  // clearTeamAttributes deletes the Authentik keys and NULLs the cache.
  const cleared = await UserAttributesService.clearTeamAttributes(row.local_user_id);
  if (!cleared) {
    out(`  ✗ ${row.username}: clearTeamAttributes failed (will retry on re-run)`);
    return { status: 'failed' };
  }
  out(`  ✓ ${row.username}: cleared to ABSENT`);
  return { status: 'cleared' };
}

async function main() {
  const args = parseArgs(process.argv);
  const out = (line) => process.stdout.write(line + '\n');

  out('Backfill: repairing user_cache rows with a forbidden tak_color/tak_callsign ' +
      `(${FORBIDDEN_VALUES.map((v) => `'${v}'`).join(' or ')})`);
  out(args.apply ? 'MODE: APPLY (Authentik + user_cache will be written)'
                 : 'MODE: DRY RUN (no changes; pass --apply to write)');
  if (args.limit) out(`LIMIT: first ${args.limit} affected row(s)`);
  out(`Inter-row delay: ${args.delayMs}ms\n`);

  let rows = await loadAffectedRows();
  out(`Found ${rows.length} affected user_cache row(s).`);
  if (args.limit) rows = rows.slice(0, args.limit);
  if (rows.length === 0) {
    out('Nothing to do.');
    await pool.end();
    process.exit(0);
  }

  const tally = {
    fixed: 0, cleared: 0, 'would-fix': 0, 'would-clear': 0,
    skipped: 0, failed: 0, device: 0
  };

  for (const row of rows) {
    try {
      if (row.is_team_device) {
        // A Team_Owned_Device has no team-derived callsign/colour to repair.
        out(`  · ${row.username} (id=${row.local_user_id}): Team_Owned_Device, SKIPPED`);
        tally.device++;
      } else if (row.direct_team_id !== null && row.direct_team_id !== undefined) {
        const { status } = await repairTeamedUser(row, args.apply, out);
        tally[status] = (tally[status] || 0) + 1;
      } else {
        const { status } = await repairTeamlessUser(row, args.apply, out);
        tally[status] = (tally[status] || 0) + 1;
      }
    } catch (error) {
      tally.failed++;
      process.stderr.write(
        `  ✗ ${row.username} (id=${row.local_user_id}): ${error && error.message ? error.message : error}\n`
      );
    }
    await sleep(args.delayMs);
  }

  out('\nSummary:');
  if (args.apply) {
    out(`  fixed (teamed):   ${tally.fixed}`);
    out(`  cleared (teamless): ${tally.cleared}`);
  } else {
    out(`  would fix (teamed):    ${tally['would-fix']}`);
    out(`  would clear (teamless): ${tally['would-clear']}`);
  }
  out(`  skipped (unresolvable): ${tally.skipped}`);
  out(`  team devices skipped:   ${tally.device}`);
  out(`  failed:                 ${tally.failed}`);
  if (!args.apply) out('\nDry run complete. Re-run with --apply to write the changes above.');

  await pool.end();
  process.exit(tally.failed > 0 ? 1 : 0);
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
