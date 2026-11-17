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
 *                      response/coordination flag (per tier) is true
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
const { resolvePinnedPks } = require('../config/pinnedGroupMembers');
const { isIgnoredAuthentikUsername, getIgnoredUsernamePrefixes } = require('../config/authentikSyncIgnore');
const { sameMemberSet } = require('../utils/groupMembershipDiff');
const { extractMissingUserPks } = require('../utils/authentikValidationErrors');

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
    `SELECT category, service_account_id FROM bch_channels WHERE id = $1`,
    [bchChannelId]
  );
  const serviceAccountId = saResult.rows[0]?.service_account_id;
  if (serviceAccountId !== null && serviceAccountId !== undefined) {
    members.push(String(serviceAccountId));
  }

  // Pinned members (best-effort, additive): PINNED_MEMBERS_BCH targets the
  // READ group of BCH-CATEGORY channels only (not UTL/XtraTools). A pinned
  // user who is already a member (every user is a BCH-read target) is a
  // dedup no-op; the pin matters for a principal NOT in the local `users`
  // table (e.g. an admin resolved live from Authentik).
  if (saResult.rows[0]?.category === 'BCH') {
    const pinned = await resolvePinnedPks('bch');
    members.push(...pinned);
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
    `SELECT category, service_account_id FROM bch_channels WHERE id = $1`,
    [bchChannelId]
  );
  const serviceAccountId = saResult.rows[0]?.service_account_id;
  const members = [];
  if (serviceAccountId !== null && serviceAccountId !== undefined) {
    members.push(String(serviceAccountId));
  }

  // Pinned members (best-effort, additive): PINNED_MEMBERS_XTRATOOLS targets
  // the WRITE group of UTL-CATEGORY (XtraTools) channels only. This group is
  // otherwise service-account-only (no humans), so a pin here is the sole way
  // to grant a human write access to XtraTools without a team membership.
  if (saResult.rows[0]?.category === 'UTL') {
    const pinned = await resolvePinnedPks('xtratools');
    members.push(...pinned);
  }

  return dedupe(members);
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
  if (tier !== 'response' && tier !== 'coordination') {
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
    tier === 'response' ? 'response_channel_access' : 'coordination_channel_access';

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
        SELECT id, parent_team_id, response_channel_access, coordination_channel_access
        FROM teams WHERE id = tm.team_id
        UNION ALL
        SELECT t.id, t.parent_team_id, t.response_channel_access, t.coordination_channel_access
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
  const members = result.rows.map((r) => String(r.authentik_user_id));

  // Pinned members (best-effort, additive): PINNED_MEMBERS_RESPONSE /
  // PINNED_MEMBERS_COORDINATION target their own tier's region groups. `tier` was
  // validated to be exactly 'response' or 'coordination' above, so it maps
  // directly to the pin category.
  const pinned = await resolvePinnedPks(tier);
  members.push(...pinned);

  return dedupe(members);
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
// Ignored-prefix member PRESERVATION.
//
// A user whose Authentik username matches AUTHENTIK_SYNC_IGNORED_USERNAME_
// PREFIXES (e.g. `etl-`, service accounts) is deliberately NOT materialised
// as a local `users` row (authentikSync.syncSingleUser skips it). Every
// desired-set query above is DB-computed, so it can never include an ignored
// user -- and the full-replace PATCH would therefore STRIP such a user from a
// group they were added to out-of-band. That contradicts the whole point of
// the ignore list: a user TTM is told to ignore is one it must not touch.
//
// The fix, applied uniformly to EVERY owned-group family via replaceGroupMembers
// below: before the full replace, read the group's CURRENT members, keep those
// whose username matches an ignored prefix, and union their pks into the
// desired set. This is:
//   - ADDITIVE ONLY -- it can only KEEP an ignored user who is ALREADY in the
//     group; it never adds an ignored user that isn't there, and never affects
//     a non-ignored user (who is still governed entirely by the DB desired set).
//   - FAIL-CLOSED -- if the current-member read fails, we cannot prove the
//     replace won't strip an ignored user, so the caller throws (retryable) and
//     issues NO PATCH, consistent with the module's existing fail-closed
//     invariant on a thrown desired-set query.
//   - SKIPPED entirely when no ignored prefixes are configured (the common
//     case), so it adds no per-group read then.
// ---------------------------------------------------------------------------

/**
 * Fetch a group's CURRENT members from Authentik as { pk, username } pairs.
 * Reads the group detail's `users_obj` (the expanded member list, which
 * carries `pk` + `username`), via the shared rate limiter's READ lane.
 *
 * @param {string} groupUuid
 * @returns {Promise<Array<{pk: string, username: string}>>}
 * @throws {AuthentikApiError} on a non-2xx / network failure (classified) --
 *   the caller treats this as fail-closed (no PATCH).
 */
async function fetchGroupMemberUsernames(groupUuid) {
  let response;
  try {
    response = await authentikRequest.run({ kind: 'read' }, () =>
      fetchWithTimeout(
        `${AUTHENTIK_URL()}/api/v3/core/groups/${encodeURIComponent(groupUuid)}/?include_users=true`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${AUTHENTIK_TOKEN()}`,
            'Content-Type': 'application/json'
          }
        }
      )
    );
  } catch (err) {
    throw new AuthentikApiError(
      `Failed to read current members of group ${groupUuid}: ${err.message}`,
      classifyFailure(err)
    );
  }

  if (!response.ok) {
    throw new AuthentikApiError(
      `Failed to read current members of group ${groupUuid}: ${response.status} ${response.statusText}`,
      classifyFailure(response.status)
    );
  }

  const body = await response.json();
  // Every current member, not only the ones with a readable username: this
  // list is also compared against the desired set to decide whether the PATCH
  // can be skipped, so a member dropped here would look like "not a member" and
  // a stale one could be left in place. A member with no string username is
  // kept with an empty username (never matches an ignored prefix). The bare
  // `users` pk array, when Authentik returns it, is unioned in as a cross-check:
  // a superset can only make the sets differ, which means "PATCH", never "skip".
  const byPk = new Map();
  const usersObj = Array.isArray(body?.users_obj) ? body.users_obj : [];
  for (const u of usersObj) {
    if (!u || u.pk === null || u.pk === undefined) continue;
    byPk.set(String(u.pk), typeof u.username === 'string' ? u.username : '');
  }
  const bareUsers = Array.isArray(body?.users) ? body.users : [];
  for (const pk of bareUsers) {
    if (pk === null || pk === undefined) continue;
    if (!byPk.has(String(pk))) byPk.set(String(pk), '');
  }
  return [...byPk.entries()].map(([pk, username]) => ({ pk, username }));
}

/**
 * Union the pks of any CURRENTLY-PRESENT ignored-prefix members into
 * `desiredPks`, so the full replace does not strip them. Returns the desired
 * set unchanged (and issues no read) when no ignored prefixes are configured.
 *
 * @param {string} groupUuid
 * @param {string[]} desiredPks  the DB-computed desired set.
 * @param {object} logContext
 * @param {Array<{pk: string, username: string}>|null} [knownCurrentMembers]
 *   the group's current members if the caller already read them; when null the
 *   members are read here.
 * @returns {Promise<string[]>} the desired set with preserved ignored members
 *   unioned in.
 * @throws {AuthentikApiError} if the current-member read fails (fail-closed).
 */
async function preserveIgnoredMembers(groupUuid, desiredPks, logContext = {}, knownCurrentMembers = null) {
  // No configured prefixes -> nothing to preserve, and no reason to spend a
  // read on every group.
  if (getIgnoredUsernamePrefixes().length === 0) {
    return desiredPks;
  }

  // A caller that has already read the members (replaceGroupMembers does, to
  // decide whether it can skip the PATCH) passes them in, so one write cycle
  // uses one consistent snapshot and one read.
  const currentMembers = knownCurrentMembers ?? (await fetchGroupMemberUsernames(groupUuid));
  const preserved = currentMembers
    .filter((m) => isIgnoredAuthentikUsername(m.username))
    .map((m) => m.pk);

  if (preserved.length === 0) {
    return desiredPks;
  }

  logger.info(
    { ...logContext, groupUuid, preservedCount: preserved.length },
    'Preserving ignored-prefix members already in the group (not stripping them from an owned group)'
  );
  return dedupe([...desiredPks, ...preserved]);
}

// ---------------------------------------------------------------------------
// Users Authentik no longer has.
//
// Team Manager can keep a local `users` row (with its `authentik_user_id`) for a
// user whose Authentik account no longer exists. Two known ways: the
// remove-user routes delete the Authentik account first and the local row
// second, and the local `DELETE FROM users` fails on the non-cascading
// audit_logs FK for any user with audit history, so the row survives and the
// Reconciliation_Sweep later marks it `orphaned` (an orphaned row is never
// deleted and keeps its pk); or the account was deleted directly in Authentik.
// The "every user" desired sets (BCH read) still contain that pk, and Authentik
// rejects the WHOLE group PATCH with HTTP 400
//   { "users": ["Invalid pk \"474\" - object does not exist."] }
// and nothing is written, so every group that contains the stale pk failed on
// every sweep, permanently (seen 2026-11: all 13 BCH-read groups, hourly, from
// the day one user was removed this way).
//
// Authentik is the authority on whether a user exists. When it names a pk that
// does not exist, that pk cannot be a member, so omit it and retry. This only
// ever REMOVES an id from what we were about to write (it can never add or keep
// anyone), it acts only on Authentik's own exact validation message, and a 400
// writes nothing, so the retry is safe. Anything else about a 400 still fails
// the operation exactly as before.
//
// DRF reports one invalid pk per response, so a few deleted users need a few
// rounds; MAX_MISSING_PK_RETRIES bounds that. Learned pks are remembered for the
// life of the process so later groups omit them up front (and, with them gone,
// are then recognised as unchanged and skipped). The stale local row is
// logged, not repaired: that is an operator decision.
// ---------------------------------------------------------------------------
const MAX_MISSING_PK_RETRIES = 5;
const knownMissingUserPks = new Set();

/** Test hook: forget learned pks so tests are independent. */
function resetKnownMissingUserPks() {
  knownMissingUserPks.clear();
}

/**
 * Read and parse an error response body, never throwing and never reading more
 * than needed. Returns { body, snippet }: `body` the parsed JSON (or null) and
 * `snippet` a short single-line text of it for error messages.
 */
async function readErrorBody(response) {
  try {
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const snippet = String(text).replace(/\s+/g, ' ').trim().slice(0, 300);
    return { body, snippet };
  } catch {
    return { body: null, snippet: '' };
  }
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
 * Issues no PATCH when the group's current members, read just before, are
 * provably identical to `memberPks` (plus preserved ignored members): the
 * result then has `unchanged: true`.
 *
 * @returns {Promise<{ patched: boolean, unchanged: boolean, dryRun: boolean, memberCount: number }>}
 * @throws {AuthentikApiError} on a non-2xx / network failure (classified).
 */
async function replaceGroupMembers(groupUuid, memberPks, logContext = {}) {
  const dryRun = isBulkGroupReconcileDryRun();

  // Read the group's current members once. It serves two purposes:
  //   1. ignored-prefix preservation (below);
  //   2. skipping a PATCH that would change nothing. Authentik turns every
  //      group PATCH into an event plus queued event-trigger and SCIM tasks even
  //      when the membership is identical, so the hourly anti-drift sweep used
  //      to saturate the Authentik database on an environment with many owned
  //      groups, nearly all of them already correct.
  //
  // Failure handling keeps the previous contract exactly:
  //   - ignored prefixes configured: the read is required to prove the replace
  //     will not strip an ignored member, so a failure throws (retryable) and no
  //     PATCH is issued (fail-closed), as before;
  //   - no ignored prefixes: no read was ever needed, so a failed read only
  //     means we cannot prove the group is unchanged. Fall back to the
  //     unconditional PATCH, as before, rather than blocking the reconcile.
  const prefixesConfigured = getIgnoredUsernamePrefixes().length > 0;
  let currentMembers = null;
  try {
    currentMembers = await fetchGroupMemberUsernames(groupUuid);
  } catch (err) {
    if (prefixesConfigured) throw err;
    logger.warn(
      { ...logContext, groupUuid, err: err.message },
      'Could not read current group members to check for changes; writing membership unconditionally'
    );
  }

  // Preserve any currently-present ignored-prefix members (e.g. `etl-`
  // service accounts) so the full replace never strips a user TTM was told
  // to ignore. Additive-only. Runs before the dry-run branch too, so the
  // dry-run log reflects the set that WOULD be written.
  const preservedPks = await preserveIgnoredMembers(groupUuid, memberPks, logContext, currentMembers);
  let numericPks = preservedPks.map((pk) => Number(pk)).filter((n) => Number.isFinite(n));
  if (knownMissingUserPks.size > 0) {
    const omitted = numericPks.filter((pk) => knownMissingUserPks.has(pk));
    if (omitted.length > 0) {
      numericPks = numericPks.filter((pk) => !knownMissingUserPks.has(pk));
      logger.debug(
        { ...logContext, groupUuid, omittedPks: omitted },
        'Omitting user pks Authentik previously reported as non-existent'
      );
    }
  }

  // Nothing to write: Authentik already holds exactly this member set. Only
  // reached when the current members were read successfully AND provably equal
  // the set about to be written (any doubt returns false and we PATCH).
  if (currentMembers && sameMemberSet(currentMembers.map((m) => m.pk), numericPks)) {
    logger.info(
      { ...logContext, groupUuid, memberCount: numericPks.length, dryRun },
      'Group membership already matches; PATCH skipped'
    );
    return { patched: false, unchanged: true, dryRun, memberCount: numericPks.length };
  }

  if (dryRun) {
    logger.info(
      { ...logContext, groupUuid, memberCount: numericPks.length, dryRun: true },
      'Dry-run: would PATCH group membership (no Authentik write issued)'
    );
    return { patched: false, unchanged: false, dryRun: true, memberCount: numericPks.length };
  }

  const droppedMissingPks = [];
  let response;
  for (let attempt = 0; ; attempt += 1) {
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
    if (response.ok) break;

    // A 400 that names users Authentik does not have: omit them and retry (see
    // the block comment above). Nothing was written by the rejected request.
    let detail = '';
    if (response.status === 400) {
      const { body, snippet } = await readErrorBody(response);
      detail = snippet ? ` - ${snippet}` : '';
      const missing = extractMissingUserPks(body).filter((pk) => numericPks.includes(pk));
      if (missing.length > 0 && attempt < MAX_MISSING_PK_RETRIES) {
        for (const pk of missing) {
          knownMissingUserPks.add(pk);
          droppedMissingPks.push(pk);
        }
        numericPks = numericPks.filter((pk) => !knownMissingUserPks.has(pk));
        logger.warn(
          { ...logContext, groupUuid, missingPks: missing, retriesLeft: MAX_MISSING_PK_RETRIES - attempt - 1 },
          'Authentik reports user(s) that do not exist; omitting them from the group membership and retrying (a local users row still points at a deleted Authentik user)'
        );
        continue;
      }
    }
    throw new AuthentikApiError(
      `Failed to PATCH group ${groupUuid} membership: ${response.status} ${response.statusText}${detail}`,
      classifyFailure(response.status)
    );
  }

  logger.info(
    {
      ...logContext,
      groupUuid,
      memberCount: numericPks.length,
      dryRun: false,
      ...(droppedMissingPks.length > 0 ? { droppedMissingPks } : {})
    },
    'Replaced group membership via full PATCH'
  );
  return { patched: true, unchanged: false, dryRun: false, memberCount: numericPks.length, droppedMissingPks };
}

module.exports = {
  desiredTeamChannelMembers,
  desiredBchReadMembers,
  desiredBchWriteMembers,
  desiredRegionMembers,
  desiredCloudTakMembers,
  replaceGroupMembers,
  resetKnownMissingUserPks,
  preserveIgnoredMembers,
  fetchGroupMemberUsernames,
  // re-exported for the worker handler's convenience
  isBulkGroupReconcileEnabled,
  isBulkGroupReconcileDryRun,
  groupName
};
