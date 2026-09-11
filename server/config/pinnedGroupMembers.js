'use strict';

/**
 * Pinned owned-group members (server-side / Sync_Worker only).
 *
 * WHAT THIS IS. Four operator-controlled, comma-separated lists of Authentik
 * USERNAMES that must ALWAYS be members of a category/tier of TTM-owned
 * Authentik groups, regardless of whether TTM's database-derived desired set
 * would include them. The group-authoritative reconciler
 * (`OwnedGroupReconciler`) UNIONs the resolved pins into each group's desired
 * member set before its full-replace PATCH, so a pinned user is kept in the
 * group on every reconcile instead of being stripped as an out-of-band member.
 *
 * WHY. TTM owns the WHOLE membership of these groups (see
 * authentik-scaling.md) and full-replaces them, so a user added manually in
 * Authentik is removed on the next reconcile. There is no per-user exemption
 * in a group-authoritative model; the only correct way to keep a user in is
 * to make them part of the desired set. These lists do exactly that, for
 * users who have no TTM team membership that would otherwise place them in
 * the group (e.g. an admin/service principal like `ckadmin` that is
 * deliberately NOT materialised in the local `users` table).
 *
 * THE FOUR LISTS AND THEIR TARGET GROUPS (the mapping is INTENTIONALLY
 * ASYMMETRIC -- each var names a specific permission group, not a symmetric
 * "this category" bucket):
 *   - PINNED_MEMBERS_BCH        -> BCH-category channels' READ group.
 *   - PINNED_MEMBERS_XTRATOOLS  -> UTL-category (XtraTools) channels' WRITE group.
 *   - PINNED_MEMBERS_RESPONSE   -> Response-tier region groups.
 *   - PINNED_MEMBERS_SUPPORT    -> Support-tier region groups.
 * (BCH read vs XtraTools write is deliberate: the concrete need was
 * read-only visibility of BCH feeds but write access to XtraTools data
 * packages.)
 *
 * IDENTITY. Lists carry USERNAMES; group membership works in Authentik user
 * PKs. `resolvePinnedPks` resolves username -> pk LIVE via the Authentik API
 * (NOT the local `users` table -- a pinned user is often not materialised
 * locally, which is the whole point). Resolution is best-effort:
 *   - an unresolvable username is SKIPPED with a warning (never fails the
 *     reconcile -- a typo must not blank a group);
 *   - a total lookup failure returns an EMPTY pin set for that cycle, so the
 *     reconcile proceeds on the DB-derived set alone (the reconciler stays
 *     fail-closed on the DB set; pins are an additive best-effort overlay,
 *     never a reason to abort or to widen a group on garbage).
 * A short in-memory cache avoids one Authentik lookup per group during a
 * full sweep.
 *
 * Never surfaced through the Public_Config_Endpoint. Empty/unset by default
 * (pins nobody). Comma-separated, trimmed, empty entries dropped -- same
 * parsing shape as AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES.
 */

const logger = require('./logger').createLogger('pinnedGroupMembers');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const authentikRequest = require('./../services/authentikRequest');

/** The env var name for each pin category. */
const PIN_ENV_VARS = Object.freeze({
  bch: 'PINNED_MEMBERS_BCH',
  xtratools: 'PINNED_MEMBERS_XTRATOOLS',
  response: 'PINNED_MEMBERS_RESPONSE',
  support: 'PINNED_MEMBERS_SUPPORT'
});

/**
 * Parse one pin category's usernames from the environment.
 *
 * @param {'bch'|'xtratools'|'response'|'support'} category
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string[]} trimmed, non-empty usernames; empty array when unset.
 */
function getPinnedUsernames(category, env = process.env) {
  const varName = PIN_ENV_VARS[category];
  if (!varName) {
    return [];
  }
  const raw = env[varName];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return [];
  }
  return raw
    .split(',')
    .map((username) => username.trim())
    .filter((username) => username !== '');
}

// ---------------------------------------------------------------------------
// Username -> Authentik pk resolution (live, cached, best-effort).
// ---------------------------------------------------------------------------

// Short in-memory cache of username -> pk (or null when confirmed absent), so
// a full sweep resolving the same pinned usernames across many groups issues
// one lookup per username per TTL window rather than one per group. Cleared
// implicitly by TTL expiry; process-local (each worker/server resolves its
// own).
const CACHE_TTL_MS = 60 * 1000;
const pkCache = new Map(); // username -> { pk: string|null, at: number }

/**
 * Resolve one Authentik username to its user pk (string) via the Authentik
 * API. Returns null when no such user exists. Throws on a transport/HTTP
 * failure (the caller decides how to treat that).
 *
 * @param {string} username
 * @returns {Promise<string|null>}
 */
async function lookupPk(username) {
  const cached = pkCache.get(username);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.pk;
  }

  const response = await authentikRequest.run({ kind: 'read' }, () =>
    fetchWithTimeout(
      `${process.env.AUTHENTIK_URL}/api/v3/core/users/?username=${encodeURIComponent(username)}`,
      { headers: { Authorization: `Bearer ${process.env.AUTHENTIK_API_TOKEN}` } }
    )
  );
  if (!response.ok) {
    throw new Error(`Authentik user lookup for "${username}" failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  // Exact-username match (the `?username=` filter is exact, but be defensive).
  const match = (data?.results || []).find((u) => u.username === username) || null;
  const pk = match ? String(match.pk) : null;
  pkCache.set(username, { pk, at: Date.now() });
  return pk;
}

/**
 * Resolve the pinned members for a category to Authentik pks (strings).
 *
 * BEST-EFFORT by contract: never throws. An unresolvable username (no such
 * Authentik user) is skipped with a warning. A lookup transport failure is
 * logged and that username contributes nothing this cycle -- the reconcile
 * proceeds on its DB-derived set. Returns a deduped array of pk strings
 * (possibly empty).
 *
 * @param {'bch'|'xtratools'|'response'|'support'} category
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {Promise<string[]>}
 */
async function resolvePinnedPks(category, env = process.env) {
  const usernames = getPinnedUsernames(category, env);
  if (usernames.length === 0) {
    return [];
  }

  const pks = [];
  for (const username of usernames) {
    try {
      const pk = await lookupPk(username);
      if (pk === null) {
        logger.warn(
          { category, username },
          'Pinned member username not found in Authentik; skipping this pin (no group membership forced for it)'
        );
        continue;
      }
      pks.push(pk);
    } catch (error) {
      // Transport/HTTP failure: best-effort, so this username contributes
      // nothing this cycle. The reconcile still writes its DB-derived set;
      // the pin is re-attempted on the next reconcile (and the sweep).
      logger.warn(
        { category, username, err: error && error.message ? error.message : error },
        'Failed to resolve pinned member via Authentik; skipping this pin for this reconcile'
      );
    }
  }
  return [...new Set(pks)];
}

/**
 * Test-only: clear the resolution cache so a test controls lookup behaviour
 * deterministically.
 */
function _clearPinCache() {
  pkCache.clear();
}

module.exports = {
  PIN_ENV_VARS,
  getPinnedUsernames,
  resolvePinnedPks,
  _clearPinCache
};
