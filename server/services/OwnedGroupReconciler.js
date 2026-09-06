'use strict';

/**
 * Group-authoritative membership reconciler (Authentik scaling, Phase 2).
 *
 * For each Authentik group TAK Team Manager OWNS -- team primary-channel
 * groups, BCH read/write groups, region-channel groups, and CloudTAKAgency
 * groups -- TTM can compute the COMPLETE desired member set from its own
 * database. This module does exactly that and writes it with a SINGLE
 * full-replace group PATCH (`PATCH /core/groups/{uuid}/ {users:[...]}`),
 * collapsing the previous per-user add/remove fan-out into one call. Load
 * profiling proved a 15,000-member `users:[]` array PATCHes in sub-second
 * time (see `docs/authentik-ratelimit-profiling.md`), so no chunking is
 * needed at realistic team sizes.
 *
 * THE DESIRED-SET DEFINITIONS BELOW MUST MATCH THE EVENT-DRIVEN PATH.
 * Each query was derived from the existing per-user enqueue logic so the
 * reconciler and the event path converge on the identical member set:
 *   - team channel  -> any team_memberships row on the channel's team
 *                      (TeamMembershipService.addUserToTeam's direct +
 *                      inherited rows), active users, non-null pk.
 *   - BCH read       -> every active user, plus the channel's service
 *                      account (SyncWorker.assignUserToGlobalChannels +
 *                      provisionBchServiceAccount).
 *   - BCH write      -> the channel's service account ONLY.
 *   - region         -> direct-membership users whose Organisation's
 *                      response/support flag (per tier) is true
 *                      (assignUserToGlobalChannels).
 *   - cloudtak       -> the Team's Direct_Admin_Set (getDirectAdmins),
 *                      deliberately WITHOUT an is_active gate, to match
 *                      reconcileCloudTakMembers exactly.
 *
 * FAIL-CLOSED INVARIANT: a desired-set computation that THROWS (a DB
 * error, a partial read) must never be turned into a PATCH with an empty
 * or truncated `users:[]` -- that would empty the group in Authentik over
 * a transient fault. The reconciler discriminates on the OUTCOME of the
 * query (did it succeed?), never the SIZE of the returned set. A query
 * that legitimately returns zero members DOES PATCH `users:[]` (an
 * intentionally empty group is a valid state); a query that FAILED
 * propagates the error and no PATCH is issued.
 *
 * DRY-RUN: when `BULK_GROUP_RECONCILE_DRY_RUN` is on (the default while the
 * feature is being validated), the desired set is computed and LOGGED but
 * NO Authentik write is issued -- the read side is proven before write
 * authority is granted.
 */

const pool = require('../config/database');
const logger = require('../config/logger').createLogger('OwnedGroupReconciler');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const authentikRequest = require('./authentikRequest');
const { classifyFailure } = require('../workers/failureClassification');
const { AuthentikApiError } = require('../workers/apiErrors');
const { getDirectAdmins, groupName } = require('./CloudTakAgencyGroup');
const {
  isBulkGroupReconcileEnabled,
  isBulkGroupReconcileDryRun
} = require('../config/bulkGroupReconcile');

const AUTHENTIK_URL = () => process.env.AUTHENTIK_URL;
const AUTHENTIK_TOKEN = () => process.env.AUTHENTIK_API_TOKEN;

// ---------------------------------------------------------------------------
// Desired-set queries. Each returns an array of `authentik_user_id` strings.
// A thrown error means the set could not be computed -> the caller must NOT
// PATCH (fail-closed). These deliberately mirror the event-path definitions.
// ---------------------------------------------------------------------------

/**
 * Team primary-channel group. Every user with ANY team_memberships row
 * (direct or inherited) on the channel's owning team, active, non-null pk.
 * @param {number} teamId
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<string[]>}
 */
async function desiredTeamChannelMembers(teamId, client = pool) {
  // Behaviour-preserving (validated live 2026-09): NO `is_active` filter.
  // The event-driven path never removed a merely-deactivated user from their
  // team-channel group, so the reconciler must not either -- otherwise
  // enabling it would strip every inactive-but-present member from every
  // group on the first pass. Desired set = every present member (direct OR
  // inherited row) with a resolvable Authentik pk. (Purging inactive users
  // from groups is a separate, deliberate decision, not a side effect of
  // this scaling change.)
  const result = await client.query(
    `
    SELECT DISTINCT u.authentik_user_id
    FROM team_memberships tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = $1
      AND u.authentik_user_id IS NOT NULL
    `,
    [teamId]
  );
  return result.rows.map((r) => String(r.authentik_user_id));
}

/**
 * BCH read group. Every active user (non-null pk) UNION the channel's own
 * service account pk (from bch_channels.service_account_id), if any.
 * @param {number} bchChannelId
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<string[]>}
 */
async function desiredBchReadMembers(bchChannelId, client = pool) {
  // Behaviour-preserving: NO `is_active` filter (see desiredTeamChannelMembers).
  // Every user with a resolvable pk is a BCH-read target, matching the
  // event path's "never remove a deactivated user" behaviour.
  const usersResult = await client.query(
    `SELECT authentik_user_id FROM users WHERE authentik_user_id IS NOT NULL`
  );
  const members = usersResult.rows.map((r) => String(r.authentik_user_id));

  const saResult = await client.query(
    `SELECT service_account_id FROM bch_channels WHERE id = $1`,
    [bchChannelId]
  );
  const serviceAccountId = saResult.rows[0]?.service_account_id;
  if (serviceAccountId !== null && serviceAccountId !== undefined) {
    members.push(String(serviceAccountId));
  }
  return dedupe(members);
}

/**
 * BCH write group. The channel's service account ONLY -- no human user is
 * ever a member (assignUserToGlobalChannels never touches write_group_id).
 * A channel with no provisioned service account yet has an empty write
 * group, which is a legitimate empty set (not a failure).
 * @param {number} bchChannelId
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<string[]>}
 */
async function desiredBchWriteMembers(bchChannelId, client = pool) {
  const saResult = await client.query(
    `SELECT service_account_id FROM bch_channels WHERE id = $1`,
    [bchChannelId]
  );
  const serviceAccountId = saResult.rows[0]?.service_account_id;
  if (serviceAccountId === null || serviceAccountId === undefined) {
    return [];
  }
  return [String(serviceAccountId)];
}

/**
 * Region-channel group. Direct-membership users (`inherited_from_team_id
 * IS NULL`) whose Organisation's per-tier flag is true. The Organisation is
 * the root of the direct team's ancestor chain (parent_team_id IS NULL),
 * matching assignUserToGlobalChannels reading getAncestorChain[0]. A
 * teamless user has no direct-membership row and is therefore excluded.
 * @param {number} regionChannelId
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<string[]>}
 */
async function desiredRegionMembers(regionChannelId, client = pool) {
  // Resolve the tier from the row so the caller only needs the channel id.
  const rowResult = await client.query(
    `SELECT tier FROM region_channels WHERE id = $1`,
    [regionChannelId]
  );
  const tier = rowResult.rows[0]?.tier;
  if (tier !== 'response' && tier !== 'support') {
    // A missing/invalid tier is a permanent data problem, not a transient
    // one: surface it as a permanent Authentik-shaped error so the caller
    // does not retry forever, and never PATCH on it.
    throw new AuthentikApiError(
      `region_channels row ${regionChannelId} has no valid tier ("${tier}"); cannot reconcile`,
      'permanent'
    );
  }

  // The Organisation column to gate on, chosen by tier. Column name is NOT
  // interpolated from user input -- it is one of two literals selected here.
  const flagColumn =
    tier === 'response' ? 'response_channel_access' : 'support_channel_access';

  // NOTE: this query has NO bind parameters. Membership is gated purely on
  // the (literal, tier-chosen) `flagColumn` and the direct-membership /
  // non-null-pk predicates -- the region channel id is NOT referenced here
  // (it was already consumed by the tier lookup above). Passing a params
  // array to a parameterless statement makes Postgres reject the bind with
  // "bind message supplies 1 parameters, but prepared statement requires 0",
  // which made every `region` reconcile fail and retry for ~a day before
  // exhausting max_retries. So NO second argument is passed here.
  const result = await client.query(
    `
    SELECT u.authentik_user_id
    FROM team_memberships tm
    JOIN users u ON u.id = tm.user_id
    JOIN LATERAL (
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_team_id, response_channel_access, support_channel_access
        FROM teams WHERE id = tm.team_id
        UNION ALL
        SELECT t.id, t.parent_team_id, t.response_channel_access, t.support_channel_access
        FROM teams t JOIN ancestors a ON t.id = a.parent_team_id
      )
      SELECT ${flagColumn} AS flag
      FROM ancestors WHERE parent_team_id IS NULL
    ) org ON true
    WHERE tm.inherited_from_team_id IS NULL
      AND u.authentik_user_id IS NOT NULL
      AND COALESCE(org.flag, false) = true
    `
  );
  return dedupe(result.rows.map((r) => String(r.authentik_user_id)));
}

/**
 * CloudTAKAgency group. The Team's Direct_Admin_Set (getDirectAdmins):
 * role='admin' AND inherited_from_team_id IS NULL. Deliberately NO
 * is_active gate, to match reconcileCloudTakMembers exactly. Null pks
 * dropped.
 * @param {number} teamId
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<string[]>}
 */
async function desiredCloudTakMembers(teamId, client = pool) {
  const admins = await getDirectAdmins(teamId, client);
  return dedupe(
    admins
      .map((a) => a.authentik_user_id)
      .filter((id) => id !== null && id !== undefined)
      .map((id) => String(id))
  );
}

function dedupe(arr) {
  return [...new Set(arr)];
}

// ---------------------------------------------------------------------------
// The full-replace PATCH primitive.
// ---------------------------------------------------------------------------

/**
 * Set an Authentik group's ENTIRE membership to `memberPks` in one call:
 * `PATCH /core/groups/{groupUuid}/ {users: memberPks}`. Routed through the
 * shared rate limiter's write lane. In dry-run, logs and issues nothing.
 *
 * @param {string} groupUuid - the Authentik group pk (UUID string).
 * @param {number[]} memberPks - the COMPLETE desired member set (integer
 *   Authentik user pks). Authentik's users array is `type: integer`.
 * @param {object} logContext - extra fields for the structured log line.
 * @returns {Promise<{ patched: boolean, dryRun: boolean, memberCount: number }>}
 * @throws {AuthentikApiError} on a non-2xx / network failure (classified).
 */
async function replaceGroupMembers(groupUuid, memberPks, logContext = {}) {
  const dryRun = isBulkGroupReconcileDryRun();
  const numericPks = memberPks.map((pk) => Number(pk)).filter((n) => Number.isFinite(n));

  if (dryRun) {
    logger.info(
      { ...logContext, groupUuid, memberCount: numericPks.length, dryRun: true },
      'Dry-run: would PATCH group membership (no Authentik write issued)'
    );
    return { patched: false, dryRun: true, memberCount: numericPks.length };
  }

  let response;
  try {
    response = await authentikRequest.run({ kind: 'write' }, () =>
      fetchWithTimeout(`${AUTHENTIK_URL()}/api/v3/core/groups/${encodeURIComponent(groupUuid)}/`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${AUTHENTIK_TOKEN()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ users: numericPks })
      })
    );
  } catch (err) {
    // Network/timeout, or a RateLimitAcquireError -- all retryable. Never a
    // partial write: fetch either delivered the whole body or it did not.
    throw new AuthentikApiError(
      `Failed to PATCH group ${groupUuid} membership: ${err.message}`,
      classifyFailure(err)
    );
  }

  if (!response.ok) {
    throw new AuthentikApiError(
      `Failed to PATCH group ${groupUuid} membership: ${response.status} ${response.statusText}`,
      classifyFailure(response.status)
    );
  }

  logger.info(
    { ...logContext, groupUuid, memberCount: numericPks.length, dryRun: false },
    'Replaced group membership via full PATCH'
  );
  return { patched: true, dryRun: false, memberCount: numericPks.length };
}

module.exports = {
  desiredTeamChannelMembers,
  desiredBchReadMembers,
  desiredBchWriteMembers,
  desiredRegionMembers,
  desiredCloudTakMembers,
  replaceGroupMembers,
  // re-exported for the worker handler's convenience
  isBulkGroupReconcileEnabled,
  isBulkGroupReconcileDryRun,
  groupName
};
