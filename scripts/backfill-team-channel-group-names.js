'use strict';

/**
 * One-off backfill: reconciles existing primary Team_Channel Authentik
 * groups (`tak_Teams - ...`) whose names are STALE or COLLIDED, after the fix
 * that (1) composes an Organisation's `country_code` into the derived group
 * name and (2) renames the group when a team is renamed.
 *
 * MUST RUN AFTER THE FIX IS DEPLOYED. This script recomputes each channel's
 * correct group name via the SAME shared helper the fixed code uses
 * (`server/utils/teamChannelGroupName.js`). Run against the OLD code it would
 * reproduce the old, wrong (and colliding) names, so it is only meaningful
 * once the fixed helper is present — which it is, in this same change.
 *
 * A channel needs repair if EITHER its freshly derived name differs from its
 * stored `channels.display_name` (name drift) OR its `authentik_group_id` is
 * SHARED with another channel (a collision), even when the name already
 * matches. The repair classes:
 *
 *   1. RENAME — a uniquely-owned group whose name is stale (Bug 1: a team was
 *      renamed and nothing renamed its group). Fix: update the local
 *      `channels.name`/`display_name`/`description`, then enqueue a
 *      `rename_team_channel_group` so the worker PATCHes the Authentik group
 *      `name` — exactly what `Team.update` now does for a fresh rename.
 *
 *   2. COLLISION — two (or more) channels SHARE one `authentik_group_id`
 *      (Bug 2: two Organisations sharing a `callsign_prefix` under different
 *      `country_code`s both derived `tak_Teams - CDEM` and were pointed at
 *      ONE group). A rename cannot split one group into two. Fix: keep the
 *      shared group on ONE deterministic member (lowest channel id) and
 *      RENAME it to that keeper's correct, now-unique name; every OTHER
 *      member is RECONCILEd — its local name corrected, its
 *      `authentik_group_id` NULLed, and a `reconcile_team_channel_group`
 *      enqueued so the worker create-or-reuses a distinct correctly-named
 *      group and writes the fresh pk back. The old shared group survives as
 *      the keeper's group; no group is orphaned by a split.
 *
 *      CRITICALLY, a collision is detected INDEPENDENT of name drift: the
 *      real-world aftermath of Bug 2 on an already-partly-fixed deployment is
 *      exactly two channels whose local `display_name`s were corrected
 *      (`Teams - CHL-CDEM`, `Teams - USA-CDEM`) yet STILL point at the one
 *      old shared group. Pure name-drift detection misses that entirely; the
 *      shared-`authentik_group_id` check is what catches it.
 *
 * A channel with a NULL `authentik_group_id` (group never reconciled) whose
 * name is stale is treated as a RECONCILE too: its local name is corrected
 * and a `reconcile_team_channel_group` is enqueued to create the group under
 * the correct name.
 *
 * Idempotency & safety:
 *   - DRY-RUN BY DEFAULT: reports the per-channel plan (current name → new
 *     name, and rename vs reconcile) and does nothing unless run with
 *     `--apply`.
 *   - Only PRIMARY team channels (`is_primary = true`, `team_id NOT NULL`) are
 *     considered — a custom channel's name is independent of the team name.
 *   - Enqueues via `EventPublisher.publishOperation` (correct priority /
 *     correlation), the same path `Team.update`/`createTeamChannel` use. The
 *     worker handlers are idempotent, so re-running only re-converges.
 *   - Local `channels` rows are updated FIRST (inside `--apply`) so a
 *     re-run sees the corrected name and enqueues nothing further for an
 *     already-repaired channel.
 *
 * Usage:
 *   node scripts/backfill-team-channel-group-names.js            # dry run
 *   node scripts/backfill-team-channel-group-names.js --apply    # repair
 */

// Load .env exactly like server/index.js and the sibling scripts do.
require('dotenv').config();

const pool = require('../server/config/database');
const EventPublisher = require('../server/services/EventPublisher');
const { toAsciiIdentifier } = require('../server/utils/asciiNormalize');
const { resolveChannelFolderSeparator } = require('../server/utils/channelFolderSeparator');
const { deriveTeamChannelName } = require('../server/utils/teamChannelGroupName');

function parseArgs(argv) {
  const args = { apply: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') args.apply = true;
  }
  return args;
}

// Every PRIMARY team channel, joined to its team's own name/parent flag and
// to its Organisation's callsign_prefix/country_code (resolved by walking to
// the root of each team's ancestor chain). This is the exact set of
// primitives the shared name helper needs, mirroring
// `Team.renameTeamChannelGroups`' own query.
async function loadPrimaryTeamChannels() {
  const result = await pool.query(`
    WITH RECURSIVE anc AS (
      SELECT id AS start_id, id, callsign_prefix, country_code, parent_team_id
      FROM teams
      UNION ALL
      SELECT a.start_id, p.id, p.callsign_prefix, p.country_code, p.parent_team_id
      FROM teams p JOIN anc a ON p.id = a.parent_team_id
    ),
    roots AS (
      SELECT start_id AS team_id, callsign_prefix AS root_prefix, country_code AS root_country_code
      FROM anc
      WHERE parent_team_id IS NULL
    )
    SELECT t.id AS team_id, t.name AS team_name, t.parent_team_id,
           r.root_prefix, r.root_country_code,
           c.id AS channel_id, c.display_name, c.authentik_group_id
    FROM teams t
    JOIN roots r ON r.team_id = t.id
    JOIN channels c ON c.team_id = t.id AND c.is_primary = true
    ORDER BY t.id
  `);
  return result.rows;
}

async function main() {
  const args = parseArgs(process.argv);
  const out = (line) => process.stdout.write(line + '\n');

  out('Backfill: reconcile stale/collided team-channel Authentik group names');
  out(args.apply ? 'MODE: APPLY (local names updated + ops enqueued)'
                 : 'MODE: DRY RUN (no changes; pass --apply to repair)');
  out('');

  const separator = resolveChannelFolderSeparator();
  const channels = await loadPrimaryTeamChannels();

  // Count how many channels share each non-null Authentik group id, so a
  // stale channel pointing at a SHARED group is repaired by reconcile (split
  // into its own group), not by a rename (which would rename the one shared
  // group both point at).
  const groupIdRefCount = new Map();
  for (const row of channels) {
    if (row.authentik_group_id != null) {
      const key = String(row.authentik_group_id);
      groupIdRefCount.set(key, (groupIdRefCount.get(key) || 0) + 1);
    }
  }

  // For each SHARED (collided) group id, at most ONE channel may keep it;
  // every other member must be split off into its own group. We pick the
  // lowest channel id as the keeper deterministically. The keeper still gets
  // a rename (its group is renamed to the keeper's correct, now-unique name);
  // the rest get reconcile (a fresh distinct group). This is the ONLY way to
  // repair a collision whose local names ALREADY match the derived names
  // (Bug 2 aftermath: the `channels` rows were name-corrected but never
  // repointed off the one shared Authentik group) — a case pure name-drift
  // detection misses entirely.
  const collisionKeeperByGroupId = new Map();
  for (const row of channels) {
    if (row.authentik_group_id == null) continue;
    const key = String(row.authentik_group_id);
    if ((groupIdRefCount.get(key) || 0) <= 1) continue; // not shared
    const currentKeeper = collisionKeeperByGroupId.get(key);
    if (currentKeeper == null || row.channel_id < currentKeeper) {
      collisionKeeperByGroupId.set(key, row.channel_id);
    }
  }

  const plan = [];
  for (const row of channels) {
    const { channelName, authentikGroupName } = deriveTeamChannelName({
      rootPrefix: row.root_prefix,
      rootCountryCode: row.root_country_code,
      teamName: row.team_name,
      isSubTeam: row.parent_team_id !== null,
      separator,
      toAsciiIdentifier
    });

    const nameDrifted = channelName !== row.display_name;
    const shared =
      row.authentik_group_id != null &&
      (groupIdRefCount.get(String(row.authentik_group_id)) || 0) > 1;
    const isCollisionKeeper =
      shared && collisionKeeperByGroupId.get(String(row.authentik_group_id)) === row.channel_id;

    // A channel needs repair if its name drifted OR it is a NON-keeper member
    // of a shared (collided) group. A collision keeper with a correct name is
    // repaired ONLY if its group must be renamed (name drift) — otherwise the
    // shared group already carries the keeper's correct name and nothing is
    // needed for it.
    if (!nameDrifted && !(shared && !isCollisionKeeper)) {
      continue;
    }

    // Action:
    //  - a NON-keeper member of a shared group -> reconcile (split off into a
    //    distinct group), regardless of whether its name drifted.
    //  - a not-yet-reconciled channel (null id) -> reconcile.
    //  - otherwise (unique group id, or the collision keeper) -> rename.
    let action;
    if ((shared && !isCollisionKeeper) || row.authentik_group_id == null) {
      action = 'reconcile';
    } else {
      action = 'rename';
    }

    plan.push({
      channelId: row.channel_id,
      teamId: row.team_id,
      oldName: row.display_name,
      newName: channelName,
      authentikGroupName,
      description: `Users from ${channelName} (Location sharing enabled)`,
      channelDbName: channelName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      groupId: row.authentik_group_id,
      action,
      reason: nameDrifted ? 'name-drift' : 'collision-split'
    });
  }

  out(`Primary team channels scanned: ${channels.length}`);
  out(`Channels needing repair:       ${plan.length}`);
  const renameCount = plan.filter((p) => p.action === 'rename').length;
  const reconcileCount = plan.filter((p) => p.action === 'reconcile').length;
  const collisionCount = plan.filter((p) => p.reason === 'collision-split').length;
  out(`  rename (group renamed in place):        ${renameCount}`);
  out(`  reconcile (split off / no group):       ${reconcileCount}`);
  out(`  of which collision splits (name was OK): ${collisionCount}`);
  out('');

  if (plan.length === 0) {
    out('Nothing to repair. Every primary team channel has a correctly-named, uniquely-owned group.');
    await pool.end();
    process.exit(0);
  }

  for (const p of plan) {
    out(`  [${p.action}] channel ${p.channelId} (team ${p.teamId}) [${p.reason}]`);
    out(`      ${JSON.stringify(p.oldName)} -> ${JSON.stringify(p.newName)}`);
    out(`      group name: ${p.authentikGroupName}${p.groupId ? ` (current pk ${p.groupId})` : ' (no pk yet)'}`);
  }
  out('');

  if (!args.apply) {
    out('Dry run complete. Re-run with --apply to update local names and enqueue the ops above.');
    await pool.end();
    process.exit(0);
  }

  let enqueued = 0;
  let failed = 0;
  for (const p of plan) {
    try {
      if (p.action === 'reconcile') {
        // Correct the local name AND null the (shared/absent) group id so the
        // idempotent reconcile handler creates-or-reuses the correctly-named
        // group and writes the fresh pk back (its write-back is guarded on
        // `authentik_group_id IS NULL`).
        await pool.query(
          'UPDATE channels SET name = $1, display_name = $2, description = $3, authentik_group_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
          [p.channelDbName, p.newName, p.description, p.channelId]
        );
        const id = await EventPublisher.publishOperation(
          'reconcile_team_channel_group',
          { channel_id: p.channelId, authentik_group_name: p.authentikGroupName, description: p.description },
          null
        );
        out(`  ✓ channel ${p.channelId}: local name updated, group id cleared, reconcile enqueued as op ${id}`);
      } else {
        // Unique group id, stale name: correct the local name and rename the
        // one group in place.
        await pool.query(
          'UPDATE channels SET name = $1, display_name = $2, description = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
          [p.channelDbName, p.newName, p.description, p.channelId]
        );
        const id = await EventPublisher.publishOperation(
          'rename_team_channel_group',
          { channel_id: p.channelId, authentik_group_name: p.authentikGroupName, description: p.description },
          null
        );
        out(`  ✓ channel ${p.channelId}: local name updated, rename enqueued as op ${id}`);
      }
      enqueued++;
    } catch (error) {
      failed++;
      process.stderr.write(
        `  ✗ channel ${p.channelId} (team ${p.teamId}): ${error && error.message ? error.message : error}\n`
      );
    }
  }

  out('\nSummary:');
  out(`  repaired (ops enqueued): ${enqueued}`);
  out(`  failed:                  ${failed}`);
  out('\nNote: for COLLISION repairs the old shared Authentik group is left in place.');
  out('Once every collided channel has been repointed, run');
  out('  node scripts/cleanup-orphaned-team-groups.js');
  out('to remove any now-orphaned shared group(s).');

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
