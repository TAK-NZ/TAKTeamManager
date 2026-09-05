const pool = require('../config/database');
const logger = require('../config/logger').createLogger('userAttributes');
const Team = require('../models/Team');
const CallsignService = require('./CallsignService');
const { MAX_TEAM_DEPTH } = require('../config/constants');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');

class UserAttributesService {
  static splitFullName(fullName) {
    const parts = fullName.trim().split(' ');
    if (parts.length === 1) {
      return { firstName: parts[0], lastName: '' };
    }
    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(' ')
    };
  }

  /**
   * Requirement 11.2/3.4/5.4/5.5/8.4 (task 11.1): thin, stable wrapper
   * kept for backward compatibility with its existing callers
   * (`server/routes/users.js`'s two call sites,
   * `updateTeamUserAttributes` below). Since `computeCallsignAttributes`
   * now takes `(userId, teamId)` directly and does its own `users`
   * lookup (including the "user not found -> null" behavior), this is a
   * direct delegation with no additional logic of its own.
   *
   * @param {number} userId
   * @param {number} teamId
   * @returns {Promise<{callsign: string, color: string, role: string}|null>}
   */
  static async generateCallsign(userId, teamId) {
    return this.computeCallsignAttributes(userId, teamId);
  }

  /**
   * Requirement 3.4, 5.4, 5.5, 8.4 (task 11.1): computes a user's
   * callsign/color/role attributes from their Ancestor_Chain.
   *
   * Per Requirement 8.4/11.2, the Name segment of a generated callsign is
   * ALWAYS that user's STORED `callsign_suffix` value -- never computed
   * live from a name. This function therefore takes a `userId` (not name
   * strings) and looks up the stored `callsign_suffix` itself.
   *
   * Steps:
   * 1. Look up the user's stored `callsign_suffix` (Requirement 11.2). If
   *    no user row is found, return `null`.
   * 2. Resolve the Ancestor_Chain via `Team.getAncestorChain(teamId)`. If
   *    empty (team not found), return `null`.
   * 3. The Organisation is `ancestorChain[0]` (depth 0, root-first per
   *    `getAncestorChain`'s contract). Its `callsign_level_selection`
   *    defaults to `[1..MAX_TEAM_DEPTH]` when null/undefined
   *    (Requirement 5.3).
   * 4. Filter the ancestor chain's `depth >= 1` rows to those whose
   *    `depth` is a member of the resolved Callsign_Level_Selection AND
   *    whose `callsign_prefix` is non-empty (Requirement 5.4/5.5) -- a
   *    selected depth absent from the chain (a shallower branch) is
   *    simply skipped, without error.
   * 5. Assemble the callsign via `CallsignService.assembleCallsign`.
   * 6. Return `{ callsign, color: ancestorChain[0].color, role: 'Team
   *    Member' }` -- color continues to come from the Organisation
   *    (Requirement 3.4); the `role` hardcoding is pre-existing behavior
   *    this task does not touch (Requirement 13's TAK_Role work is a
   *    separate later phase).
   *
   * This function no longer reads `callsign_subteam_depth` or
   * `callsign_name_format` at generation time (Requirement 3.4/8.4).
   *
   * @param {number} userId
   * @param {number} teamId
   * @returns {Promise<{callsign: string, color: string, role: string}|null>}
   */
  static async computeCallsignAttributes(userId, teamId) {
    try {
      const userResult = await pool.query(
        'SELECT callsign_suffix FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) return null;

      const { callsign_suffix: callsignSuffix } = userResult.rows[0];

      const ancestorChain = await Team.getAncestorChain(teamId);

      if (ancestorChain.length === 0) return null;

      const organisation = ancestorChain[0];

      const callsignLevelSelection =
        organisation.callsign_level_selection == null
          ? Array.from({ length: MAX_TEAM_DEPTH }, (_, i) => i + 1)
          : organisation.callsign_level_selection;

      const teamSegmentPrefixes = ancestorChain
        .filter(
          (team) =>
            team.depth >= 1 &&
            callsignLevelSelection.includes(team.depth) &&
            !!team.callsign_prefix
        )
        .map((team) => team.callsign_prefix);

      // Foreign_Partner Organisation country prefix feature: when the
      // Organisation carries a `country_code` (ISO 3166-1 alpha-3, e.g.
      // 'FJI'), it is composed as the LEADING segment of the effective
      // Organisation prefix -- 'FJI' + prefix 'FIRE' -> 'FJI-FIRE'. A
      // domestic Organisation (country_code null) is unchanged: the
      // effective prefix is just its own callsign_prefix. Both `country_code`
      // and `callsign_prefix` are already validated/normalised on the
      // `teams` row; either could in principle be absent, so this joins only
      // the non-empty parts with `-` (mirroring assembleCallsign's own
      // empty-segment handling) rather than emitting a stray leading/trailing
      // separator.
      const organisationPrefix = [organisation.country_code, organisation.callsign_prefix]
        .filter((segment) => !!segment && String(segment).trim() !== '')
        .join('-');

      // Callsign Team-segment separator toggle: an Organisation may opt
      // into hyphenating its Team segment (`NSW-SYD` instead of the
      // default `NSWSYD`) via `callsign_team_hyphenated`. `null`/`false`
      // (every Organisation that has not opted in) reproduces the
      // original no-separator concatenation exactly.
      const teamSegmentSeparator = organisation.callsign_team_hyphenated ? '-' : '';

      const callsign = CallsignService.assembleCallsign({
        organisationPrefix,
        teamSegmentPrefixes,
        nameSegment: callsignSuffix,
        teamSegmentSeparator
      });

      return {
        callsign,
        color: organisation.color,
        role: 'Team Member'
      };
    } catch (error) {
      logger.error({ err: error, userId, teamId }, 'Error generating callsign');
      return null;
    }
  }
  
  /**
   * Requirements 13.6, 13.8 (task 11.4, Flagged Design Decision 2):
   * fetch-current-Authentik-attributes-then-merge-supplied-keys-then-PATCH,
   * replacing the previous blind full-object PATCH.
   *
   * `attributes` may be a PARTIAL object containing any subset of
   * `{callsign, color, role}`. Only keys ACTUALLY PRESENT on `attributes`
   * (checked via `!== undefined`, not a falsy check, so an explicit empty
   * string is honored) are mapped to their Authentik attribute names
   * (`callsign` -> `takCallsign`, `color` -> `takColor`, `role` ->
   * `takRole`) and overlaid onto the user's CURRENT Authentik attributes
   * before PATCHing -- so a partial call (e.g. only `{callsign, color}`)
   * can no longer clobber an existing `takRole` (or any other existing
   * attribute) that it didn't supply.
   *
   * Mirrors `clearUserAttributes`'s existing GET-then-PATCH fetch shape
   * and error-handling convention below.
   *
   * @param {string} authentikUserId
   * @param {{callsign?: string, color?: string, role?: string}} attributes
   * @returns {Promise<boolean>}
   */
  static async updateUserAttributes(authentikUserId, attributes) {
    try {
      // Fetch the user's CURRENT Authentik attributes first, so the PATCH
      // below is a merge, never a wholesale replace.
      const getUserResponse = await fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`, {
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`
        }
      });

      if (!getUserResponse.ok) {
        throw new Error(`Failed to get user: ${getUserResponse.statusText}`);
      }

      const user = await getUserResponse.json();
      const currentAttributes = user.attributes || {};

      const mergedAttributes = { ...currentAttributes };
      if (attributes.callsign !== undefined) {
        mergedAttributes.takCallsign = attributes.callsign;
      }
      if (attributes.color !== undefined) {
        mergedAttributes.takColor = attributes.color;
      }
      if (attributes.role !== undefined) {
        mergedAttributes.takRole = attributes.role;
      }
      if (attributes.firstName !== undefined) {
        mergedAttributes.first_name = attributes.firstName;
      }
      if (attributes.lastName !== undefined) {
        mergedAttributes.last_name = attributes.lastName;
      }

      const payload = { attributes: mergedAttributes };
      // Also update Authentik's display name when first/last name changes
      if (attributes.firstName !== undefined || attributes.lastName !== undefined) {
        const firstName = attributes.firstName !== undefined ? attributes.firstName : (currentAttributes.first_name || '');
        const lastName = attributes.lastName !== undefined ? attributes.lastName : (currentAttributes.last_name || '');
        payload.name = `${firstName}${lastName ? ' ' + lastName : ''}`;
      }

      logger.debug({ authentikUserId, payload }, 'Updating user attributes');
      
      const response = await fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        throw new Error(`Failed to update user attributes: ${response.statusText}`);
      }
      
      return true;
    } catch (error) {
      logger.error({ err: error, authentikUserId }, 'Error updating user attributes in Authentik');
      return false;
    }
  }
  
  static async clearUserAttributes(authentikUserId) {
    try {
      // Get current user attributes
      const getUserResponse = await fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`, {
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`
        }
      });
      
      if (!getUserResponse.ok) {
        throw new Error(`Failed to get user: ${getUserResponse.statusText}`);
      }
      
      const user = await getUserResponse.json();
      const currentAttributes = user.attributes || {};
      
      // Remove takCallsign and takColor, keep everything else including takRole
      delete currentAttributes.takCallsign;
      delete currentAttributes.takColor;
      
      const response = await fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          attributes: currentAttributes
        })
      });
      
      if (!response.ok) {
        throw new Error(`Failed to clear user attributes: ${response.statusText}`);
      }
      
      return true;
    } catch (error) {
      logger.error({ err: error, authentikUserId }, 'Error clearing user attributes in Authentik');
      return false;
    }
  }
  
  /**
   * Bugfix (Dashboard/Enrollment callsign-and-color divergence): clears a
   * single user's team-derived attributes -- `callsign`/`color` -- back
   * to the explicit string `'None'`, both in Authentik (via
   * `updateUserAttributes`, so `takRole` is left untouched -- it is not
   * team-derived) and in this application's own `user_cache` mirror.
   *
   * `'None'` rather than a blank string or a color like `'White'`: an
   * empty string reads as "unset" only until the render layer decides
   * otherwise, and `'White'` is itself a real, assignable
   * `TAK_Color` in this deployment (see `TeamFormDialog.jsx`'s color
   * list) -- using it here would make "has no team" indistinguishable
   * from "was actually assigned White". `'None'` matches the SAME
   * fallback `DeviceEnrollmentService#resolvePrincipalPreview` and
   * `EnrollmentView.jsx`'s `orNone()` already use for a principal with
   * no team, so both surfaces converge on one "no data" convention
   * instead of two.
   *
   * Intended for a user who has just lost their LAST `team_memberships`
   * row (e.g. `Team.delete` removing the only team they belonged to) --
   * the caller is responsible for having already established that no
   * membership row remains, since this method does no such check itself
   * and would otherwise blindly clear a still-valid callsign/color out
   * from under a user who is still a member of some OTHER team.
   *
   * No-ops (returns `false`, logs, does not throw) when `userId` does not
   * resolve to a `users` row, mirroring `computeCallsignAttributes`'s own
   * "not found -> give up quietly" convention rather than
   * `updateUserAttributes`'s throw-and-catch shape.
   *
   * @param {number} userId
   * @returns {Promise<boolean>}
   */
  static async clearTeamAttributes(userId) {
    try {
      const userResult = await pool.query(
        'SELECT authentik_user_id FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        logger.warn({ userId }, 'Cannot clear team attributes: no users row found');
        return false;
      }

      const { authentik_user_id: authentikUserId } = userResult.rows[0];

      // `updateUserAttributes` catches its own errors and returns
      // `false` rather than throwing (see its own doc comment), so its
      // result must be checked explicitly here rather than relying on
      // this method's own try/catch to notice a failed Authentik call.
      const authentikUpdated = await this.updateUserAttributes(authentikUserId, {
        callsign: 'None',
        color: 'None'
      });

      if (!authentikUpdated) {
        logger.error({ userId, authentikUserId }, 'Failed to clear team attributes in Authentik');
        return false;
      }

      await pool.query(
        'UPDATE user_cache SET tak_callsign = $1, tak_color = $2 WHERE authentik_id = $3',
        ['None', 'None', authentikUserId]
      );

      return true;
    } catch (error) {
      logger.error({ err: error, userId }, 'Error clearing team attributes');
      return false;
    }
  }

  static async updateTeamUserAttributes(teamId) {
    try {
      // Get all users in team and sub-teams.
      //
      // Bugfix (Dashboard/Orgs & Teams stale-callsign defect): filtered to
      // `tm.inherited_from_team_id IS NULL` -- a DIRECT membership row
      // only. A user directly in a Sub_Team also holds an INHERITED
      // membership row in every ancestor up to the Organisation (see
      // `TeamMembershipService.addUserToTeam`'s parent-team insert loop),
      // and every one of those ancestor teams is inside this SAME
      // recursive team_tree whenever `teamId` is the Organisation itself.
      // Without this filter, that user's callsign/color/role got
      // regenerated ONCE PER MEMBERSHIP ROW -- once correctly from the
      // Sub_Team (`generateCallsign(userId, subTeamId)`, which includes
      // the Sub_Team's own callsign_prefix segment) and once incorrectly
      // from the inherited Organisation row
      // (`generateCallsign(userId, organisationId)`, which has no
      // Sub_Team segment to include at all) -- with `user_cache` left
      // holding whichever generation ran last in the loop below,
      // regardless of which one is actually correct for that user's real,
      // direct membership. `computeCallsignAttributes` already resolves
      // the FULL Ancestor_Chain from the direct team id via
      // `Team.getAncestorChain`, so it needs no help finding the
      // Sub_Team's own segment -- it only needs to be called with the
      // user's actual direct team, exactly once.
      const usersResult = await pool.query(`
        WITH RECURSIVE team_tree AS (
          SELECT id FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id FROM teams t
          JOIN team_tree tt ON t.parent_team_id = tt.id
        )
        SELECT u.id, u.authentik_user_id, tm.team_id
        FROM users u
        JOIN team_memberships tm ON u.id = tm.user_id
        JOIN team_tree tt ON tm.team_id = tt.id
        WHERE tm.inherited_from_team_id IS NULL
      `, [teamId]);
      
      // Update each user's attributes
      for (const user of usersResult.rows) {
        const attributes = await this.generateCallsign(user.id, user.team_id);
        if (attributes) {
          await this.updateUserAttributes(user.authentik_user_id, attributes);
          
          // Update user cache. `tak_role` is deliberately NOT included
          // here. `computeCallsignAttributes` returns a hardcoded
          // `role: 'Team Member'` -- role is not team-derived,
          // so writing it into `user_cache.tak_role` for every user in
          // the subtree clobbered each user's REAL role with that
          // placeholder value. Every other caller of
          // `generateCallsign`/`computeCallsignAttributes` in this
          // codebase (e.g. `server/routes/teams.js`) already omits
          // `tak_role` from its own `user_cache` UPDATE for exactly this
          // reason -- this was the one outlier.
          await pool.query(
            'UPDATE user_cache SET tak_callsign = $1, tak_color = $2 WHERE authentik_id = $3',
            [attributes.callsign, attributes.color, user.authentik_user_id]
          );
        }
      }
      
      return true;
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error updating team user attributes');
      return false;
    }
  }
}

module.exports = UserAttributesService;