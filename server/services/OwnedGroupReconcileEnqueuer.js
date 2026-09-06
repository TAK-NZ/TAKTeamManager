'use strict';

/**
 * Thin enqueuer for `reconcile_owned_group` Sync_Operations (Authentik
 * scaling, Phase 3).
 *
 * The event-driven enqueue sites (team join/leave, transfer, channel-access
 * flag flip, the "reconcile everyone" driver) call these helpers to enqueue
 * ONE reconcile op per AFFECTED owned group, instead of the old per-user
 * `add_user_to_group`/`remove_user_from_group`/`assign_user_to_global_channels`
 * fan-out. The worker's `reconcileOwnedGroup` handler then computes each
 * group's complete desired member set and writes it with a single
 * full-replace PATCH.
 *
 * This module does NO membership computation and issues NO Authentik call --
 * it only writes queue rows. The desired-set queries live in
 * `OwnedGroupReconciler` and run at worker execution time, so a reconcile
 * enqueued now reflects the DB state whenever it is later drained (which is
 * exactly what makes the op idempotent and the sweep and event paths
 * converge).
 *
 * GATING IS THE CALLER'S JOB, NOT THIS MODULE'S. Every call site wraps these
 * in `if (isBulkGroupReconcileEnabled())` so that, with the feature off, the
 * old per-user path runs byte-for-byte unchanged and NOTHING here is
 * reached. Keeping the flag check at the call site (rather than inside these
 * helpers) keeps the "old path vs new path" fork visible where the two
 * alternatives actually live.
 *
 * Every helper accepts an optional `client` (an open transactional client)
 * forwarded to `EventPublisher.publishOperation`, so a reconcile enqueued
 * inside a membership transaction commits/rolls back atomically with it --
 * the same client-threading contract the old ops used. Non-transactional
 * sites (the channel-access route, the global driver) pass `null`.
 */

const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');

/**
 * Enqueue a team primary-channel reconcile for one channel.
 * @param {number} channelId - a `channels.id`.
 * @param {number|null} createdBy
 * @param {import('pg').PoolClient|null} [client]
 * @returns {Promise<number>} the enqueued op id.
 */
function enqueueTeamChannelReconcile(channelId, createdBy = null, client = null) {
  return EventPublisher.publishReconcileOwnedGroup(
    { group_kind: 'team_channel', channel_id: channelId },
    createdBy,
    client
  );
}

/**
 * Enqueue a team primary-channel reconcile for each of several channels
 * (deduped). Used for the target-team + ancestor-chain channel set.
 * @param {number[]} channelIds
 * @param {number|null} createdBy
 * @param {import('pg').PoolClient|null} [client]
 * @returns {Promise<number[]>}
 */
async function enqueueTeamChannelReconciles(channelIds, createdBy = null, client = null) {
  const unique = [...new Set(channelIds.filter((id) => id !== null && id !== undefined))];
  const ids = [];
  for (const channelId of unique) {
    ids.push(await enqueueTeamChannelReconcile(channelId, createdBy, client));
  }
  return ids;
}

/**
 * Enqueue reconciles for EVERY owned global-channel group: each active BCH
 * channel's read AND write group, and each active region channel's group.
 * This is the group-authoritative replacement for the "reconcile every user
 * into the global channels" per-user fan-out -- O(groups) ops instead of
 * O(users). Reads the active channel id lists (NOT their membership) via the
 * supplied `client` or the shared pool.
 * @param {number|null} createdBy
 * @param {import('pg').PoolClient|null} [client]
 * @returns {Promise<{ bchOps: number[], regionOps: number[] }>}
 */
async function enqueueAllGlobalChannelReconciles(createdBy = null, client = null) {
  const executor = client || pool;

  const bchResult = await executor.query('SELECT id FROM bch_channels WHERE is_active = true');
  const regionResult = await executor.query('SELECT id FROM region_channels WHERE is_active = true');

  const bchOps = [];
  for (const row of bchResult.rows) {
    bchOps.push(
      await EventPublisher.publishReconcileOwnedGroup({ group_kind: 'bch_read', bch_channel_id: row.id }, createdBy, client)
    );
    bchOps.push(
      await EventPublisher.publishReconcileOwnedGroup({ group_kind: 'bch_write', bch_channel_id: row.id }, createdBy, client)
    );
  }

  const regionOps = [];
  for (const row of regionResult.rows) {
    regionOps.push(
      await EventPublisher.publishReconcileOwnedGroup({ group_kind: 'region', region_channel_id: row.id }, createdBy, client)
    );
  }

  return { bchOps, regionOps };
}

/**
 * Enqueue a region reconcile for each active region channel of a given tier
 * ('response' | 'support'). This is the group-authoritative replacement for
 * `resync_org_channel_tier_access`'s per-user fan-out: an Organisation's
 * tier-flag flip changes the desired membership of exactly that tier's
 * region groups, so one reconcile per such group recomputes them all
 * (`desiredRegionMembers` re-gates on the org flag for every org).
 * @param {'response'|'support'} tier
 * @param {number|null} createdBy
 * @param {import('pg').PoolClient|null} [client]
 * @returns {Promise<number[]>}
 */
async function enqueueRegionTierReconciles(tier, createdBy = null, client = null) {
  const executor = client || pool;
  const result = await executor.query(
    'SELECT id FROM region_channels WHERE is_active = true AND tier = $1',
    [tier]
  );
  const ids = [];
  for (const row of result.rows) {
    ids.push(
      await EventPublisher.publishReconcileOwnedGroup({ group_kind: 'region', region_channel_id: row.id }, createdBy, client)
    );
  }
  return ids;
}

/**
 * Anti-drift sweep: enqueue a reconcile for EVERY owned group, so any drift
 * a missed event left behind is corrected on the next pass. Enumerates the
 * owned-group id lists from the local DB and enqueues one op each:
 *   - every primary team channel  -> team_channel per channels.id
 *   - every active BCH channel     -> bch_read + bch_write per bch_channels.id
 *   - every active region channel  -> region per region_channels.id
 *   - every team                   -> cloudtak per teams.id (only when
 *                                     `includeCloudTak`, i.e. CloudTAK is on)
 *
 * Only ENQUEUES (cheap); the rate-limited worker drains at the Authentik
 * write ceiling. Non-transactional (a sweep is a standalone background
 * pass), so `createdBy` is null and no client is threaded. Returns per-kind
 * counts for the sweep's log line.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.includeCloudTak=false] - enqueue cloudtak reconciles
 *   (pass `isCloudTakEnabled()` from the caller so a disabled integration is
 *   not swept).
 * @returns {Promise<{ teamChannel: number, bch: number, region: number, cloudtak: number }>}
 */
async function sweepAllOwnedGroups({ includeCloudTak = false } = {}) {
  const counts = { teamChannel: 0, bch: 0, region: 0, cloudtak: 0 };

  const channelResult = await pool.query('SELECT id FROM channels WHERE is_primary = true');
  for (const row of channelResult.rows) {
    await enqueueTeamChannelReconcile(row.id, null, null);
    counts.teamChannel += 1;
  }

  const { bchOps, regionOps } = await enqueueAllGlobalChannelReconciles(null, null);
  counts.bch = bchOps.length;
  counts.region = regionOps.length;

  if (includeCloudTak) {
    const teamResult = await pool.query('SELECT id FROM teams');
    for (const row of teamResult.rows) {
      await EventPublisher.publishReconcileOwnedGroup({ group_kind: 'cloudtak', team_id: row.id }, null, null);
      counts.cloudtak += 1;
    }
  }

  return counts;
}

module.exports = {
  enqueueTeamChannelReconcile,
  enqueueTeamChannelReconciles,
  enqueueAllGlobalChannelReconciles,
  enqueueRegionTierReconciles,
  sweepAllOwnedGroups
};
