const pool = require('../config/database');
const Team = require('../models/Team');
const logger = require('../config/logger').createLogger('TeamVisibilityService');

/**
 * TeamVisibilityService
 *
 * Requirement 6 (Organisation-Scoped and Private-Branch-Cascading
 * Visibility): resolves whether a given Team is a Visible_Branch for a
 * given viewing user, per requirements.md's Glossary definition:
 *
 *   "For a given viewing user, a Team T is a Visible_Branch if EITHER
 *   T's `visibility` is `public` AND no Team in T's Ancestor_Chain
 *   (including T itself) has `visibility` set to `private`, OR the
 *   viewing user is a member (direct or inherited) or a Team_Admin
 *   (direct or inherited, per Requirement 4) of T or of any Team in T's
 *   Ancestor_Chain, OR the viewing user is a Global_Manager."
 *
 * Requirement 6.2 layers an additional, absolute rule on top of the
 * above with NO membership exception: a non-Global_Manager user can
 * never see a Team belonging to an Organisation other than their own,
 * regardless of that Team's own visibility or the viewer's membership.
 * This is why the decision table below checks `same_organisation`
 * FIRST, ahead of the private-ancestor-cascade check -- per design.md's
 * "Visibility resolution query" section:
 *
 *   - `same_organisation` is false and caller is not Global_Manager ->
 *     not visible (404, Requirement 6.2).
 *   - `has_private_ancestor` is true and `is_member_or_admin_of_chain`
 *     is false -> not visible (404, Requirement 6.3/6.8).
 *   - Otherwise -> visible.
 *   - A Global_Manager bypasses ALL of the above (Requirement 6.4).
 *
 * Task 13.1 implements `isVisibleBranch`; task 13.2 adds the batched
 * `filterVisibleBranches` (Requirements 6.5/6.6), a one-or-two-query-
 * per-Organisation equivalent of calling `isVisibleBranch` per row --
 * see its own doc comment below for the batching strategy.
 *
 * This function is NOT used for the fully-anonymous, unauthenticated
 * public join-request flow -- that flow has its own, simpler,
 * unconditional private-branch exclusion rule with no Global_Manager or
 * membership exception (Requirement 7), implemented separately against
 * `Team.getJoinableTeams`. Conflating the two would incorrectly apply
 * Requirement 6's Organisation-scoping (which assumes an authenticated
 * viewer with their own Organisation membership) to a flow that has no
 * viewer at all.
 */
class TeamVisibilityService {
  /**
   * Resolves whether `teamId` is a Visible_Branch for `user`.
   *
   * @param {number|string} teamId - the Team being checked for
   *   visibility.
   * @param {{userId?: number, is_global_manager?: boolean}|null|undefined} user -
   *   the viewing user. `null`/`undefined`, or a user with no `userId`,
   *   is treated as an anonymous/non-member viewer -- see the
   *   anonymous-viewer note below.
   * @returns {Promise<boolean>} `true` if `teamId` is a Visible_Branch
   *   for `user`.
   */
  static async isVisibleBranch(teamId, user) {
    // Requirement 6.4: a Global_Manager bypasses every other check in
    // this function -- checked first, and unconditionally, so no
    // Ancestor_Chain lookup is even attempted for a Global_Manager.
    if (user && user.is_global_manager) {
      return true;
    }

    // Requirement 6.1-6.3/6.7-6.8 are all defined in terms of `teamId`'s
    // Ancestor_Chain. A `teamId` that does not exist at all (an empty
    // Ancestor_Chain) is deliberately treated as NOT visible, rather
    // than throwing or returning some other sentinel: a nonexistent Team
    // can never be a Visible_Branch for anyone (a later task, 14.1's
    // `'team:read'` resolver, maps "not visible" to a 404 either way, so
    // a missing team and a hidden team both end up 404 -- consistent
    // with Requirement 6.2/6.3's "respond as though that Team does not
    // exist" wording).
    const ancestorChain = await Team.getAncestorChain(teamId);
    if (!ancestorChain || ancestorChain.length === 0) {
      return false;
    }

    // The Team's Organisation is the ROOT (depth 0) row of its
    // Ancestor_Chain, per `getAncestorChain`'s root-first contract.
    const organisation = ancestorChain[0];

    // Anonymous-viewer note: a `user` with no resolvable `userId` (e.g.
    // `null`/`undefined`, or an object with no `userId`) has no
    // Organisation membership of its own, so `same_organisation` can
    // never be true for them below -- this function therefore always
    // returns `false` for such a viewer, for every Team, regardless of
    // that Team's own visibility. This is intentional and consistent
    // with Requirement 6 applying only to an authenticated,
    // already-provisioned user (an "Org_Member" or a Global_Manager);
    // it is not a bug requiring a separate early-return, since letting
    // it fall through the same `same_organisation` check below already
    // produces the correct result.
    const userId = user && user.userId;
    if (!userId) {
      return false;
    }

    // The viewer's own membership set -- every team_id they hold a
    // direct OR inherited `team_memberships` row for. Deliberately a
    // purpose-built query here (not `User.getTeamMemberships`, which
    // filters to `inherited_from_team_id IS NULL` only, i.e. direct
    // membership alone), since Requirement 6's Org_Member/Visible_Branch
    // definitions both explicitly include "direct or inherited".
    const viewerMembershipTeamIds = await this._getViewerMembershipTeamIds(userId);

    // Requirement 6.2: cross-Organisation exclusion is absolute for a
    // non-Global_Manager -- checked first, with no membership exception.
    const sameOrganisation = await this._isSameOrganisation(viewerMembershipTeamIds, organisation.id);
    if (!sameOrganisation) {
      return false;
    }

    // Requirement 6.1/6.5 (the simple "public branch, no private
    // ancestor" case): if no Team in the Ancestor_Chain (including the
    // target Team itself, the LAST row) is private, the Team is visible
    // to any same-Organisation viewer without needing to check
    // membership/admin status at all.
    const hasPrivateAncestor = ancestorChain.some((team) => team.visibility === 'private');
    if (!hasPrivateAncestor) {
      return true;
    }

    // Requirement 6.3/6.8: a private ancestor exists, so the Team is
    // only visible if the viewer is a member (direct or inherited) or a
    // Team_Admin (direct or inherited, via `Team.isAdmin`'s own
    // Ancestor_Chain walk) of the target Team or of any Team in its
    // Ancestor_Chain.
    return this._isMemberOrAdminOfChain(ancestorChain, viewerMembershipTeamIds, teamId, userId);
  }

  /**
   * Batched equivalent of calling `isVisibleBranch(team.id, user)` for
   * every row in `teams` (Requirements 6.5/6.6), returning the subset of
   * `teams` that is a Visible_Branch for `user`, preserving `teams`'
   * original order and object references.
   *
   * `teams` is any array of Team rows with at least `id`,
   * `parent_team_id`, and `visibility` (the shape returned by
   * `Team.getSubTeams`/`Team.getAllTeams`/similar list queries) -- it may
   * span multiple Organisations, or be a single Organisation's whole
   * hierarchy; the caller decides.
   *
   * Per design.md's "Visibility resolution query" section, this avoids
   * an isVisibleBranch-per-row N+1 by:
   *   1. Building an in-memory `id -> row` adjacency map directly from
   *      `teams` itself, and walking `parent_team_id` chains WITHIN that
   *      map (no DB call at all) to resolve each row's Organisation id
   *      and "has a private ancestor" flag -- correct with zero extra
   *      queries whenever `teams` is a connected hierarchy (the realistic
   *      call-site shape: an Organisation's own full sub-tree).
   *   2. Falling back to `Team.getAncestorChain` (the same primitive
   *      `isVisibleBranch` uses) only for a row whose ancestor chain is
   *      NOT fully contained within `teams` -- keeping this function
   *      correct for ANY input shape, not only a connected hierarchy,
   *      while staying efficient for the common case.
   *   3. Resolving the viewer's own membership set AND the set of
   *      Organisation ids they belong to ONCE, up front (not per row),
   *      turning the per-row `same_organisation` check into an O(1) Set
   *      lookup.
   *   4. Only ever calling `Team.isAdmin` for a row that has a private
   *      ancestor AND for which the viewer holds no membership anywhere
   *      in that row's Ancestor_Chain -- i.e. never for a plain public
   *      branch, keeping this rare rather than N+1.
   *
   * @param {Array<{id: number, parent_team_id: number|null, visibility: string}>} teams
   * @param {{userId?: number, is_global_manager?: boolean}|null|undefined} user
   * @returns {Promise<Array<object>>} the Visible_Branch subset of `teams`.
   */
  static async filterVisibleBranches(teams, user) {
    const teamList = Array.isArray(teams) ? teams : [];

    // Requirement 6.4: a Global_Manager sees every row, matching
    // isVisibleBranch's own fast path -- no DB calls at all.
    if (user && user.is_global_manager) {
      return teamList;
    }

    // Anonymous/no-userId viewer: matches isVisibleBranch's own
    // anonymous-viewer behavior (never visible to anyone).
    const userId = user && user.userId;
    if (!userId) {
      return [];
    }

    if (teamList.length === 0) {
      return [];
    }

    // The "already-small, already-fetched adjacency list" from
    // design.md -- built directly from `teams`, no extra query.
    const idMap = new Map(teamList.map((team) => [team.id, team]));
    // Memoizes `_computeLocalAncestryInfo` results per team id so a
    // shared ancestor is only ever walked once across the whole batch,
    // regardless of how many rows in `teams` descend from it.
    const memo = new Map();

    const viewerMembershipTeamIds = await this._getViewerMembershipTeamIds(userId);
    const viewerMembershipSet = new Set(viewerMembershipTeamIds);
    const viewerOrganisationIds = await this._resolveViewerOrganisationIds(
      viewerMembershipTeamIds,
      idMap,
      memo
    );

    const visibleTeams = [];
    for (const team of teamList) {
      const info = await this._resolveTeamAncestryInfo(team, idMap, memo);
      if (!info) {
        // A team that cannot be resolved at all (e.g. it no longer
        // exists) is never visible, consistent with isVisibleBranch's
        // own empty-Ancestor_Chain behavior.
        continue;
      }

      // Requirement 6.2: cross-Organisation exclusion is absolute for a
      // non-Global_Manager -- checked first, with no membership
      // exception, exactly mirroring isVisibleBranch's own ordering.
      if (!viewerOrganisationIds.has(info.rootId)) {
        continue;
      }

      // Requirement 6.1/6.5: a public branch with no private ancestor is
      // visible to any same-Organisation viewer, no membership/admin
      // check needed.
      if (!info.hasPrivateAncestor) {
        visibleTeams.push(team);
        continue;
      }

      // Requirement 6.3/6.8: a private ancestor exists -- visible only
      // if the viewer is a member (direct or inherited) of the row
      // itself or any Team in its Ancestor_Chain...
      const isMemberOfChain = [...info.ancestorIds].some((id) => viewerMembershipSet.has(id));
      if (isMemberOfChain) {
        visibleTeams.push(team);
        continue;
      }

      // ...or a Team_Admin (direct or inherited) of the row itself or
      // any Team in its Ancestor_Chain. `Team.isAdmin` is deliberately
      // only ever reached here -- never for a row that already passed
      // the "no private ancestor" check above -- keeping this call rare
      // rather than N+1 for a typical mostly-public hierarchy.
      const isAdminOfChain = await Team.isAdmin(team.id, userId);
      if (isAdminOfChain) {
        visibleTeams.push(team);
      }
    }

    return visibleTeams;
  }

  /**
   * Resolves `team`'s Organisation id, "has a private ancestor" flag,
   * and full Ancestor_Chain id set, preferring the in-memory `idMap`
   * (built from the caller's own `teams` array, zero DB calls) and
   * falling back to `Team.getAncestorChain` only when `team`'s chain is
   * not fully contained within `idMap`.
   *
   * @param {{id: number}} team
   * @param {Map<number, object>} idMap
   * @param {Map<number, object>} memo
   * @returns {Promise<{rootId: number, hasPrivateAncestor: boolean, ancestorIds: Set<number>}|null>}
   */
  static async _resolveTeamAncestryInfo(team, idMap, memo) {
    const local = this._computeLocalAncestryInfo(team.id, idMap, memo);
    if (local && local.complete) {
      return local;
    }

    const ancestorChain = await Team.getAncestorChain(team.id);
    if (!ancestorChain || ancestorChain.length === 0) {
      return null;
    }
    return {
      rootId: ancestorChain[0].id,
      hasPrivateAncestor: ancestorChain.some((ancestor) => ancestor.visibility === 'private'),
      ancestorIds: new Set(ancestorChain.map((ancestor) => ancestor.id)),
      complete: true
    };
  }

  /**
   * Walks `teamId`'s `parent_team_id` chain entirely WITHIN `idMap` (no
   * DB access), memoizing per team id so a shared ancestor is only ever
   * walked once for the whole batch. Returns `{ complete: false }` as
   * soon as an ancestor is not found in `idMap` (the row itself, or any
   * ancestor of it, is missing from the caller's `teams` array) -- the
   * caller falls back to `Team.getAncestorChain` in that case.
   *
   * @param {number} teamId
   * @param {Map<number, object>} idMap
   * @param {Map<number, object>} memo
   * @returns {{rootId: number, hasPrivateAncestor: boolean, ancestorIds: Set<number>, complete: true}|{complete: false}}
   */
  static _computeLocalAncestryInfo(teamId, idMap, memo) {
    if (memo.has(teamId)) {
      return memo.get(teamId);
    }

    const node = idMap.get(teamId);
    if (!node) {
      const incomplete = { complete: false };
      memo.set(teamId, incomplete);
      return incomplete;
    }

    let info;
    if (node.parent_team_id === null || node.parent_team_id === undefined) {
      // Root of the chain (an Organisation) -- includes itself in
      // `ancestorIds` and in the private-visibility check, matching
      // isVisibleBranch's own "Ancestor_Chain including T itself" rule.
      info = {
        rootId: node.id,
        hasPrivateAncestor: node.visibility === 'private',
        ancestorIds: new Set([node.id]),
        complete: true
      };
    } else {
      const parentInfo = this._computeLocalAncestryInfo(node.parent_team_id, idMap, memo);
      if (!parentInfo.complete) {
        info = { complete: false };
      } else {
        const ancestorIds = new Set(parentInfo.ancestorIds);
        ancestorIds.add(node.id);
        info = {
          rootId: parentInfo.rootId,
          hasPrivateAncestor: parentInfo.hasPrivateAncestor || node.visibility === 'private',
          ancestorIds,
          complete: true
        };
      }
    }

    memo.set(teamId, info);
    return info;
  }

  /**
   * Resolves the set of Organisation ids the viewer belongs to (via any
   * direct or inherited membership), preferring the local `idMap` and
   * falling back to `Team.getAncestorChain` per membership team id not
   * covered by it. A user typically has few memberships, so this is
   * resolved ONCE per batch (not per row) -- turning every row's
   * `same_organisation` check into an O(1) Set lookup.
   *
   * @param {Array<number>} viewerMembershipTeamIds
   * @param {Map<number, object>} idMap
   * @param {Map<number, object>} memo
   * @returns {Promise<Set<number>>}
   */
  static async _resolveViewerOrganisationIds(viewerMembershipTeamIds, idMap, memo) {
    const organisationIds = new Set();
    for (const membershipTeamId of viewerMembershipTeamIds) {
      const local = this._computeLocalAncestryInfo(membershipTeamId, idMap, memo);
      if (local && local.complete) {
        organisationIds.add(local.rootId);
        continue;
      }
      const chain = await Team.getAncestorChain(membershipTeamId);
      if (chain && chain.length > 0) {
        organisationIds.add(chain[0].id);
      }
    }
    return organisationIds;
  }

  /**
   * Every team_id `userId` holds a direct OR inherited
   * `team_memberships` row for, as a flat array (no team metadata --
   * callers resolve whatever else they need themselves). Deliberately
   * omits the `inherited_from_team_id IS NULL` filter that
   * `User.getTeamMemberships` applies, so an inherited membership row
   * counts here too.
   *
   * @param {number|string} userId
   * @returns {Promise<Array<number>>}
   */
  static async _getViewerMembershipTeamIds(userId) {
    try {
      const result = await pool.query(
        'SELECT DISTINCT team_id FROM team_memberships WHERE user_id = $1',
        [userId]
      );
      return result.rows.map((row) => row.team_id);
    } catch (error) {
      logger.error({ err: error, userId }, 'Error fetching viewer membership team ids');
      throw error;
    }
  }

  /**
   * Requirement 6.2: does the viewer hold ANY membership (direct or
   * inherited) whose resolved Organisation id equals `organisationId`?
   * A user typically has few memberships, so this resolves each
   * membership's Organisation one at a time via `Team.getAncestorChain`,
   * exiting as soon as a match is found, rather than a single bulk SQL
   * query -- acceptable at this scale per design.md's own guidance for a
   * single-team visibility check (as opposed to the batched list-endpoint
   * path, `filterVisibleBranches`, which does need to avoid a
   * per-row correlated lookup).
   *
   * @param {Array<number>} viewerMembershipTeamIds
   * @param {number|string} organisationId
   * @returns {Promise<boolean>}
   */
  static async _isSameOrganisation(viewerMembershipTeamIds, organisationId) {
    for (const membershipTeamId of viewerMembershipTeamIds) {
      const chain = await Team.getAncestorChain(membershipTeamId);
      if (chain.length > 0 && chain[0].id === organisationId) {
        return true;
      }
    }
    return false;
  }

  /**
   * Requirement 6.3/6.8's "member (direct or inherited) or Team_Admin
   * (direct or inherited) of T or of any Team in T's Ancestor_Chain"
   * check. Membership is tested by intersecting the viewer's own
   * membership team_ids against the Ancestor_Chain's team ids (`T`
   * itself is the last row of `ancestorChain`, so it is covered by this
   * intersection without a separate check). Admin status is tested via
   * `Team.isAdmin(teamId, userId)` directly, since `isAdmin`'s own CTE
   * already walks upward from `teamId` through its full Ancestor_Chain,
   * covering "Team_Admin of T or of any ancestor of T" in one call.
   *
   * @param {Array<{id: number}>} ancestorChain
   * @param {Array<number>} viewerMembershipTeamIds
   * @param {number|string} teamId
   * @param {number|string} userId
   * @returns {Promise<boolean>}
   */
  static async _isMemberOrAdminOfChain(ancestorChain, viewerMembershipTeamIds, teamId, userId) {
    const ancestorIds = new Set(ancestorChain.map((team) => team.id));
    const isMemberOfChain = viewerMembershipTeamIds.some((membershipTeamId) => ancestorIds.has(membershipTeamId));
    if (isMemberOfChain) {
      return true;
    }
    return Team.isAdmin(teamId, userId);
  }
}

module.exports = TeamVisibilityService;
