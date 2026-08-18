const pool = require('../config/database');
const logger = require('../config/logger').createLogger('Team');
const EventPublisher = require('../services/EventPublisher');
const { MAX_TEAM_DEPTH } = require('../config/constants');

/**
 * Requirement 2.2-2.3 (task 5.1): thrown by `Team.create` when the
 * Sub_Team it would create sits at a Team_Depth greater than
 * `MAX_TEAM_DEPTH`. Thrown BEFORE any INSERT is attempted, from a guard
 * that runs ahead of `create`'s existing try/catch (whose catch block
 * falls back to a basic INSERT when new columns don't exist), so this
 * error is never swallowed by that fallback path and always propagates to
 * the caller distinctly. Callers (e.g. `POST /api/teams`, task 5.2) can
 * check `error instanceof Team.TeamDepthExceededError` to respond with a
 * 400 naming Max_Team_Depth, without creating the team.
 */
class TeamDepthExceededError extends Error {
  constructor(message = `Maximum team depth (${MAX_TEAM_DEPTH}) exceeded`) {
    super(message);
    this.name = 'TeamDepthExceededError';
  }
}

/**
 * Requirement 5.2 (task 8.1): thrown by `Team.create`/`Team.update` when a
 * supplied `callsign_level_selection` value is not an array of integers
 * each between 1 and `MAX_TEAM_DEPTH` inclusive. Thrown BEFORE any
 * INSERT/UPDATE is attempted, mirroring `TeamDepthExceededError`'s
 * placement outside the existing try/catch, so it is never swallowed by
 * that catch's fallback-to-basic-creation behaviour. A later task (8.2)
 * maps `error instanceof Team.CallsignLevelSelectionRangeError` to a 400
 * response: "callsignLevelSelection values must be between 1 and 5".
 */
class CallsignLevelSelectionRangeError extends Error {
  constructor(message = `callsignLevelSelection values must be between 1 and ${MAX_TEAM_DEPTH}`) {
    super(message);
    this.name = 'CallsignLevelSelectionRangeError';
  }
}

/**
 * Requirement 5.6 (task 8.1): thrown by `Team.create`/`Team.update` when a
 * `callsign_level_selection` value is supplied for a Sub_Team (a team
 * whose `parent_team_id` is not null). Thrown BEFORE any INSERT/UPDATE is
 * attempted, for the same reason as `TeamDepthExceededError`. A later
 * task (8.2) maps `error instanceof Team.CallsignLevelSelectionSubTeamError`
 * to a 400 response: "callsignLevelSelection can only be set on an
 * Organisation".
 */
class CallsignLevelSelectionSubTeamError extends Error {
  constructor(message = 'callsignLevelSelection can only be set on an Organisation') {
    super(message);
    this.name = 'CallsignLevelSelectionSubTeamError';
  }
}

class Team {
  static async create(teamData) {
    const { name, description, callsign_prefix, visibility, can_join, parent_team_id, created_by } = teamData;
    // Requirement 3.2 (task 6.1): `color`/`callsign_name_format` are
    // Organisation-only fields -- declared with `let` (not `const`)
    // because, when `parent_team_id` is present, they are overridden
    // below with the Sub_Team's Organisation's CURRENT values, regardless
    // of whatever value was supplied on `teamData`.
    let { color, callsign_name_format } = teamData;
    // Requirement 5.1/5.3/5.6 (task 8.1): `callsign_level_selection` is an
    // Organisation-only field, declared with `let` because it is
    // validated/defaulted (root team) or forced to `null` (Sub_Team)
    // below, before ever reaching the INSERT.
    let { callsign_level_selection } = teamData;

    // Requirement 2.2/2.3: compute the Team_Depth this Sub_Team would
    // occupy (the parent's Team_Depth plus one), or 0 for a root
    // Organisation, BEFORE attempting any INSERT. This guard is
    // deliberately OUTSIDE the try/catch below, so a TeamDepthExceededError
    // is never caught and swallowed by that catch block's
    // fallback-to-basic-creation behaviour -- it always propagates
    // distinctly to the caller.
    const targetDepth = parent_team_id
      ? (await this.getTeamDepth(parent_team_id)) + 1
      : 0;
    if (targetDepth > MAX_TEAM_DEPTH) {
      throw new TeamDepthExceededError();
    }

    // Requirement 3.2 (task 6.1): a Sub_Team's `color`/`callsign_name_format`
    // are always set to its ORGANISATION's current values -- not
    // necessarily its immediate parent's -- so this resolves the root
    // (depth 0) row of the Ancestor_Chain via `getAncestorChain`
    // (root-first ordering, per its own contract) rather than trusting
    // the immediate parent's own stored value to already be correct.
    // Any `color`/`callsign_name_format` value supplied on `teamData` is
    // silently overridden here, never rejected. This is deliberately
    // OUTSIDE the try/catch below for the same reason the depth guard is:
    // a failure resolving the Ancestor_Chain must propagate to the
    // caller, not be swallowed by the fallback-to-basic-creation catch.
    if (parent_team_id) {
      const ancestorChain = await this.getAncestorChain(parent_team_id);
      const organisation = ancestorChain[0];
      if (organisation) {
        color = organisation.color;
        callsign_name_format = organisation.callsign_name_format;
      }
    }

    // Requirement 5.1/5.2/5.3/5.6 (task 8.1): `callsign_level_selection`
    // is only ever stored on an Organisation row (`parent_team_id IS
    // NULL`) -- a Sub_Team's value is always `NULL`, and it is never
    // read at Sub_Team level (design.md's Data Models section). This
    // guard is deliberately OUTSIDE the try/catch below, for the same
    // reason the depth guard and Organisation-field-inheritance lookup
    // above are: a typed rejection here must propagate to the caller,
    // never be swallowed by the fallback-to-basic-creation catch.
    if (parent_team_id) {
      // Sub_Team: reject if the caller supplied a value at all (Requirement
      // 5.6). `undefined`/`null` means "not supplied" and is accepted
      // silently, always storing NULL.
      if (callsign_level_selection !== undefined && callsign_level_selection !== null) {
        throw new CallsignLevelSelectionSubTeamError();
      }
      callsign_level_selection = null;
    } else {
      // Organisation (root team): default to every Team_Depth position
      // 1..MAX_TEAM_DEPTH when omitted (Requirement 5.3); otherwise
      // validate every element is an integer in [1, MAX_TEAM_DEPTH]
      // (Requirement 5.1/5.2).
      if (callsign_level_selection === undefined || callsign_level_selection === null) {
        callsign_level_selection = Array.from({ length: MAX_TEAM_DEPTH }, (_, i) => i + 1);
      } else if (
        !Array.isArray(callsign_level_selection) ||
        !callsign_level_selection.every(
          (value) => Number.isInteger(value) && value >= 1 && value <= MAX_TEAM_DEPTH
        )
      ) {
        throw new CallsignLevelSelectionRangeError();
      }
    }

    try {
      const result = await pool.query(
        'INSERT INTO teams (name, description, callsign_prefix, color, visibility, can_join, parent_team_id, created_by, callsign_name_format, callsign_level_selection) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
        [name, description, callsign_prefix, color, visibility, can_join, parent_team_id, created_by, callsign_name_format, callsign_level_selection]
      );
      
      const team = result.rows[0];
      
      // Auto-create team channel
      await this.createTeamChannel(team.id);
      
      return team;
    } catch (error) {
      logger.error({ err: error }, 'Error creating team');
      // Fallback to basic creation if new columns don't exist
      const result = await pool.query(
        'INSERT INTO teams (name, description, parent_team_id, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
        [name, description, parent_team_id, created_by]
      );
      return result.rows[0];
    }
  }

  static async findById(id) {
    const result = await pool.query('SELECT * FROM teams WHERE id = $1', [id]);
    return result.rows[0];
  }

  static async getSubTeams(parentId) {
    const result = await pool.query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM team_memberships tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = t.id AND u.is_team_device IS NOT TRUE) as member_count,
        (SELECT COUNT(*) FROM teams t2 WHERE t2.parent_team_id = t.id) as sub_teams_count
      FROM teams t
      WHERE t.parent_team_id = $1
    `, [parentId]);
    return result.rows;
  }

  static async getTeamHierarchy(teamId) {
    const result = await pool.query(`
      WITH RECURSIVE team_hierarchy AS (
        SELECT id, name, parent_team_id, 0 as level
        FROM teams WHERE id = $1
        UNION ALL
        SELECT t.id, t.name, t.parent_team_id, th.level + 1
        FROM teams t
        JOIN team_hierarchy th ON t.parent_team_id = th.id
      )
      SELECT * FROM team_hierarchy ORDER BY level
    `, [teamId]);
    return result.rows;
  }

  /**
   * Requirement 2.1 (design.md's shared ancestor-chain utility): returns
   * the given Team's Ancestor_Chain -- every Team from its Organisation
   * (root, `parent_team_id IS NULL`) down to and including the given Team
   * itself -- ordered ROOT-FIRST, each row carrying `id`, `name`,
   * `callsign_prefix`, `color`, `callsign_name_format`, `visibility`,
   * `parent_team_id`, and `depth` (0 at the Organisation, incrementing by
   * one per level down to the given Team).
   *
   * Implemented as a single recursive CTE that walks UPWARD from `teamId`
   * (counting `hops_from_target`, which is easy to compute without knowing
   * the chain's total length in advance), then re-derives the root-first
   * `depth` value from that hop count in the final SELECT
   * (`MAX(hops_from_target) - hops_from_target`), per design.md.
   *
   * This is the shared primitive every other Ancestor_Chain-based
   * consumer (Team_Admin inheritance, Max_Team_Depth enforcement,
   * Organisation-only field inheritance, the Callsign_Generator, and
   * Visible_Branch resolution) is built on top of, rather than each
   * repeating its own recursive CTE.
   *
   * @param {number|string} teamId
   * @returns {Promise<Array<object>>} root-first ancestor chain rows.
   */
  static async getAncestorChain(teamId) {
    try {
      const result = await pool.query(`
        WITH RECURSIVE ancestors AS (
          SELECT id, parent_team_id, name, callsign_prefix, color,
                 callsign_name_format, visibility, callsign_level_selection,
                 0 AS hops_from_target
          FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id, t.parent_team_id, t.name, t.callsign_prefix, t.color,
                 t.callsign_name_format, t.visibility, t.callsign_level_selection,
                 a.hops_from_target + 1
          FROM teams t JOIN ancestors a ON t.id = a.parent_team_id
        )
        SELECT id, parent_team_id, name, callsign_prefix, color,
               callsign_name_format, visibility, callsign_level_selection,
               (SELECT MAX(hops_from_target) FROM ancestors) - hops_from_target AS depth
        FROM ancestors ORDER BY depth ASC
      `, [teamId]);
      return result.rows;
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error fetching ancestor chain');
      throw error;
    }
  }

  /**
   * Requirement 2.1: the depth-only sibling of `getAncestorChain` -- the
   * given Team's Team_Depth (0 at its Organisation, incrementing by one
   * per level down to the given Team), computed directly rather than by
   * calling `getAncestorChain` and reading the last row's `depth`, for
   * efficiency (a single scalar `MAX(hops_from_target)` rather than every
   * ancestor's full row).
   *
   * @param {number|string} teamId
   * @returns {Promise<number>} the given Team's Team_Depth.
   */
  static async getTeamDepth(teamId) {
    try {
      const result = await pool.query(`
        WITH RECURSIVE ancestors AS (
          SELECT id, parent_team_id, 0 AS hops_from_target
          FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id, t.parent_team_id, a.hops_from_target + 1
          FROM teams t JOIN ancestors a ON t.id = a.parent_team_id
        )
        SELECT MAX(hops_from_target) AS depth FROM ancestors
      `, [teamId]);
      return parseInt(result.rows[0]?.depth, 10);
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error fetching team depth');
      throw error;
    }
  }

  /**
   * Requirement 5.8-5.11 (task 8.3): returns, for the given Organisation's
   * whole hierarchy, ONE flat row per (Team_Depth, `callsign_prefix`)
   * pair present among that Organisation's Sub_Teams at Team_Depth 1
   * through `MAX_TEAM_DEPTH`, e.g.:
   * `[{ team_depth: 1, callsign_prefix: 'CB' }, { team_depth: 1, callsign_prefix: 'AUK' }, ...]`.
   *
   * This is the data source for the Client's Callsign_Level_Selection
   * toggle labels (design.md's "Callsign_Level_Selection toggle-labelling
   * query"): the Client -- not this method -- groups these rows by
   * `team_depth`, de-duplicates `callsign_prefix` values per depth, sorts
   * them, and applies the "up to 3 examples, then an ellipsis" truncation
   * (Requirement 5.10) purely in rendering code. This method deliberately
   * returns every distinct prefix per depth, un-grouped and un-truncated
   * -- bounded only by the Organisation's total Team count, never large.
   *
   * Implemented as a single recursive CTE walking DOWNWARD from
   * `organisationId` (the opposite direction from `getAncestorChain`/
   * `getTeamDepth`, which walk upward from a descendant), numbering
   * `team_depth` directly from 0 at `organisationId` itself. `$2` is
   * `MAX_TEAM_DEPTH` (imported at the top of this file), not a hardcoded
   * `5`, so the query stays bounded by the single shared constant.
   * Team_Depth 0 (the Organisation's own row) is excluded from the
   * result, since Requirement 5.7 never renders a toggle for it, and a
   * row is only included when its `callsign_prefix` is non-null and
   * non-empty.
   *
   * @param {number|string} organisationId
   * @returns {Promise<Array<{team_depth: number, callsign_prefix: string}>>}
   */
  static async getSubTeamsForCallsignLevel(organisationId) {
    try {
      const result = await pool.query(`
        WITH RECURSIVE tree AS (
          SELECT id, callsign_prefix, 0 AS team_depth FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id, t.callsign_prefix, tr.team_depth + 1
          FROM teams t JOIN tree tr ON t.parent_team_id = tr.id
        )
        SELECT team_depth, callsign_prefix FROM tree
        WHERE team_depth BETWEEN 1 AND $2 AND callsign_prefix IS NOT NULL AND callsign_prefix != ''
      `, [organisationId, MAX_TEAM_DEPTH]);
      return result.rows;
    } catch (error) {
      logger.error({ err: error, organisationId }, 'Error fetching sub-teams for callsign level');
      throw error;
    }
  }

  /**
   * Requirement 6.6 (task 14.3): returns every Team belonging to the
   * given Organisation's hierarchy (the Organisation's own row plus
   * every descendant Team at any depth), as a flat list of full `teams`
   * rows (every column, including `visibility` and `parent_team_id`),
   * for `GET /api/teams/my-teams?scope=organisation` to hand to
   * `TeamVisibilityService.filterVisibleBranches`.
   *
   * Walks DOWNWARD from `organisationId` (the opposite direction from
   * `getAncestorChain`, which walks upward from a descendant), mirroring
   * `getTeamHierarchy`'s own recursive-CTE shape but selecting every
   * column (`t.*`) rather than only `id`/`name`/`parent_team_id`/`level`,
   * since `filterVisibleBranches` needs `visibility` on every row and
   * this route's response is expected to carry full Team rows,
   * consistent with every other Team list endpoint. Deliberately a NEW
   * method rather than an extension of `getTeamHierarchy`'s own existing
   * SELECT, so `getTeamHierarchy`'s other caller (`GET /:teamId/hierarchy`,
   * which expects its current narrower shape) is never affected.
   *
   * @param {number|string} organisationId
   * @returns {Promise<Array<object>>} every Team in the Organisation's
   *   hierarchy (the Organisation's own row plus every descendant), in
   *   no particular guaranteed order.
   */
  static async getOrganisationTeams(organisationId) {
    try {
      const result = await pool.query(`
        WITH RECURSIVE org_hierarchy AS (
          SELECT * FROM teams WHERE id = $1
          UNION ALL
          SELECT t.* FROM teams t
          JOIN org_hierarchy oh ON t.parent_team_id = oh.id
        )
        SELECT * FROM org_hierarchy
      `, [organisationId]);
      return result.rows;
    } catch (error) {
      logger.error({ err: error, organisationId }, 'Error fetching organisation teams');
      throw error;
    }
  }

  static async addMember(teamId, userId, role = 'member') {
    try {
      const result = await pool.query(
        'INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, team_id) DO UPDATE SET role = $3 RETURNING *',
        [teamId, userId, role]
      );
      return result.rows[0];
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error adding team member');
      // Fallback to basic membership without role if column doesn't exist
      const result = await pool.query(
        'INSERT INTO team_memberships (team_id, user_id) VALUES ($1, $2) RETURNING *',
        [teamId, userId]
      );
      return result.rows[0];
    }
  }

  /**
   * Requirement 11.14, 13.1 (task 21.1): every direct + inherited
   * member/admin of `teamId`, for both the Client's Member_List display
   * (Requirement 13.1, hence the explicit `u.callsign_suffix`/`u.tak_role`
   * columns alongside `u.*`) and the `callsign_suffix` per-Team
   * uniqueness check (Requirement 11.14, via `getFullMemberList` below).
   * `u.callsign_suffix`/`u.tak_role` are re-listed explicitly here (even
   * though `u.*` already includes them) so this query's contract with
   * its callers -- both of whom depend on these two columns being
   * present -- stays visible at a glance and isn't silently broken by a
   * future change to `u.*`'s column set.
   */
  static async getMembers(teamId) {
    try {
      // Get members including inherited memberships
      const result = await pool.query(`
        SELECT u.*, u.callsign_suffix, u.tak_role, tm.role, tm.inherited_from_team_id,
               uc.tak_callsign,
               CASE 
                 WHEN tm.inherited_from_team_id IS NOT NULL THEN t.name
                 ELSE NULL
               END as inherited_from_team_name
        FROM users u 
        JOIN team_memberships tm ON u.id = tm.user_id 
        LEFT JOIN teams t ON tm.inherited_from_team_id = t.id
        LEFT JOIN user_cache uc ON u.authentik_user_id::text = uc.authentik_id::text
        WHERE tm.team_id = $1
        ORDER BY tm.role DESC, u.first_name, u.last_name
      `, [teamId]);
      return result.rows;
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error fetching team members with users table');
      try {
        // Fallback to just team memberships
        const result = await pool.query(`
          SELECT tm.user_id as id, tm.role, tm.inherited_from_team_id,
                 tm.user_id::text as first_name, 
                 '' as last_name, 
                 tm.user_id::text || '@example.com' as email,
                 NULL as inherited_from_team_name
          FROM team_memberships tm 
          WHERE tm.team_id = $1
        `, [teamId]);
        return result.rows;
      } catch (fallbackError) {
        logger.error({ err: fallbackError, teamId }, 'Error in fallback team members query');
        return [];
      }
    }
  }

  /**
   * Requirement 11.14, 13.1 (task 21.1): a deliberate ALIAS of
   * `getMembers`, not a separate implementation -- design.md's "Shared
   * Member_List roster query" section requires this to be exactly
   * today's `getMembers(teamId)` result, reused verbatim. Used by both
   * the Client's Member_List view (Requirement 13.1) and every
   * `callsign_suffix` per-Team uniqueness check (Requirement
   * 11.14-11.18): callers compare a candidate `callsign_suffix` value
   * case-insensitively against every returned row's `callsign_suffix`
   * (excluding the row being edited, for an update). Given a second name
   * here purely to make that dual use explicit at call sites -- no new
   * query is introduced.
   *
   * @param {number|string} teamId
   * @returns {Promise<Array<object>>} identical to `getMembers(teamId)`.
   */
  static async getFullMemberList(teamId) {
    return this.getMembers(teamId);
  }

  /**
   * Requirement 4.1-4.3 (task 3.1): a user is a Team_Admin of `teamId` if
   * they hold a direct (non-inherited, `inherited_from_team_id IS NULL`)
   * `role = 'admin'` `team_memberships` row for `teamId` itself, OR for
   * any Team in `teamId`'s Ancestor_Chain. Computed at check time via a
   * self-contained recursive CTE walking upward from `teamId` (the
   * `ancestors` CTE here includes `id = $1`, i.e. the team itself, so no
   * separate "check the team itself" branch is needed).
   *
   * This is a deliberately minimal, standalone CTE (only `id`/
   * `parent_team_id`) rather than a reuse of `getAncestorChain`, per
   * design.md -- it only needs to know WHICH teams are ancestors, not any
   * of their other columns, and this is the single most frequently called
   * authorization check in the app.
   *
   * `tm.role = 'admin' AND tm.inherited_from_team_id IS NULL` matches
   * only a DIRECT admin row on an ancestor -- this is independent of, and
   * does not modify, the pre-existing `inherited_from_team_id` upward
   * membership-inheritance mechanism (Requirement 4.4).
   *
   * Every existing caller continues to call `Team.isAdmin(teamId, userId)`
   * exactly as before and transparently receives inherited-admin
   * behaviour (Requirement 4.3).
   *
   * @param {number|string} teamId
   * @param {number|string} userId
   * @returns {Promise<boolean>}
   */
  static async isAdmin(teamId, userId) {
    try {
      const result = await pool.query(`
        WITH RECURSIVE ancestors AS (
          SELECT id, parent_team_id FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id, t.parent_team_id FROM teams t
          JOIN ancestors a ON t.id = a.parent_team_id
        )
        SELECT 1 FROM team_memberships tm
        JOIN ancestors a ON tm.team_id = a.id
        WHERE tm.user_id = $2 AND tm.role = 'admin' AND tm.inherited_from_team_id IS NULL
        LIMIT 1
      `, [teamId, userId]);
      return result.rows.length > 0;
    } catch (error) {
      logger.error({ err: error, teamId, userId }, 'Error checking admin status');
      return false;
    }
  }

  // Requirement 27.9 (task 49.5): `member_count` here is a dashboard-style
  // member count displayed on the Teams/TeamDetail pages, so it must
  // exclude Team_Owned_Device rows (`users.is_team_device = true`) the
  // same way `GET /api/users` does -- a device should never inflate a
  // displayed member count. The subquery joins `team_memberships` ->
  // `users` (on `user_id`) to reach `is_team_device`, using `IS NOT TRUE`
  // (rather than `= false`) so a NULL `is_team_device` value -- which
  // should never occur given the column's `NOT NULL DEFAULT false`
  // migration, but also matches how boolean flags are treated elsewhere
  // in this codebase, e.g. `Channel.getChannelCount`/`is_active` checks
  // that never need to special-case NULL -- is still counted as "not a
  // device" rather than excluded by a stricter `= false` comparison that
  // would silently drop an unexpected NULL row.
  static async getUserTeams(userId) {
    try {
      const result = await pool.query(`
        SELECT t.*, tm.role, 
          (SELECT COUNT(*) FROM team_memberships tm2
           JOIN users u2 ON u2.id = tm2.user_id
           WHERE tm2.team_id = t.id AND u2.is_team_device IS NOT TRUE) as member_count
        FROM teams t
        LEFT JOIN team_memberships tm ON t.id = tm.team_id AND tm.user_id = $1
        WHERE tm.user_id IS NOT NULL AND tm.inherited_from_team_id IS NULL
        ORDER BY t.name
      `, [userId]);
      return result.rows;
    } catch (error) {
      logger.error({ err: error, userId }, 'Error fetching user teams');
      return [];
    }
  }

  // Requirement 11.4: pagination for the admin "all teams" case of
  // `GET /api/teams/my-teams`. `limit`/`offset` are optional so that any
  // other caller of `getAllTeams()` (there are none elsewhere in the
  // codebase today, per a repo-wide grep) keeps the original unbounded
  // behavior by simply omitting them.
  //
  // Requirement 27.9 (task 49.5): `member_count` here is the same
  // dashboard-style column as `getUserTeams` above and gets the identical
  // `is_team_device IS NOT TRUE` exclusion, for the same reason.
  // `sub_teams_count` counts `teams` rows, not users, and is intentionally
  // left unchanged.
  static async getAllTeams(limit, offset) {
    try {
      const hasPagination = Number.isInteger(limit) && Number.isInteger(offset);
      const query = `
        SELECT t.*, 'admin' as role,
          (SELECT COUNT(*) FROM team_memberships tm
           JOIN users u ON u.id = tm.user_id
           WHERE tm.team_id = t.id AND u.is_team_device IS NOT TRUE) as member_count,
          (SELECT COUNT(*) FROM teams t2 WHERE t2.parent_team_id = t.id) as sub_teams_count
        FROM teams t
        ORDER BY t.name
        ${hasPagination ? 'LIMIT $1 OFFSET $2' : ''}
      `;
      const result = hasPagination
        ? await pool.query(query, [limit, offset])
        : await pool.query(query);
      return result.rows;
    } catch (error) {
      logger.error({ err: error }, 'Error fetching all teams');
      return [];
    }
  }

  // Requirement 11.4: total team count, used alongside the paginated
  // `getAllTeams()` result to report pagination metadata.
  static async getTeamCount() {
    try {
      const result = await pool.query('SELECT COUNT(*) as count FROM teams');
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ err: error }, 'Error counting teams');
      return 0;
    }
  }

  static async update(teamId, updateData) {
    const { name, description, visibility, can_join, parent_team_id } = updateData;
    // Requirement 3.3 (task 6.1): `color`/`callsign_name_format` are
    // Organisation-only fields -- declared with `let` (not `const`)
    // because, when the team being updated is a Sub_Team, any
    // client-supplied value here is silently discarded (set to
    // `undefined`) below so the SQL's own `COALESCE(..., <column>)`
    // fallback preserves the Sub_Team's existing stored value unchanged,
    // rather than applying the supplied override. The request is NEVER
    // rejected for supplying these fields on a Sub_Team -- Requirement
    // 3.3 requires the value be ignored, not an error.
    let { color, callsign_name_format } = updateData;
    // Requirement 5.2/5.6 (task 8.1): `callsign_level_selection` is
    // validated/rejected below, before ever reaching the UPDATE.
    let { callsign_level_selection } = updateData;

    // Requirement 3.3/5.6: determine whether `teamId` is a Sub_Team (a
    // non-null `parent_team_id`) BEFORE building the UPDATE, so the
    // ignore-on-Sub_Team behaviour (color/callsign_name_format) and the
    // reject-on-Sub_Team behaviour (callsign_level_selection) both apply
    // regardless of whether this same call is also moving the team to a
    // new parent (`updateData.parent_team_id`) -- the check is against
    // the team's CURRENT (pre-update) parent, consistent with `color`/
    // `callsign_name_format` already having been fixed to the
    // Organisation's value at creation time and only ever needing to be
    // ignored (never re-derived) on update. This single `findById` lookup
    // is reused for both checks to avoid a duplicate query when multiple
    // Organisation-only fields are updated together.
    let existingTeam;
    if (
      color !== undefined ||
      callsign_name_format !== undefined ||
      callsign_level_selection !== undefined
    ) {
      existingTeam = await this.findById(teamId);
    }

    if (existingTeam && existingTeam.parent_team_id !== null) {
      if (color !== undefined || callsign_name_format !== undefined) {
        color = undefined;
        callsign_name_format = undefined;
      }
      // Requirement 5.6: reject (never silently ignore) a
      // callsign_level_selection value supplied on a Sub_Team update --
      // this is deliberately OUTSIDE the try/catch below, for the same
      // reason as `Team.create`'s equivalent guard, so it always
      // propagates to the caller distinctly.
      if (callsign_level_selection !== undefined) {
        throw new CallsignLevelSelectionSubTeamError();
      }
    } else if (callsign_level_selection !== undefined && callsign_level_selection !== null) {
      // Organisation: validate every element is an integer in
      // [1, MAX_TEAM_DEPTH] (Requirement 5.2). `null` is accepted
      // (explicitly clearing the value); `undefined` means "not
      // supplied", handled below via COALESCE.
      if (
        !Array.isArray(callsign_level_selection) ||
        !callsign_level_selection.every(
          (value) => Number.isInteger(value) && value >= 1 && value <= MAX_TEAM_DEPTH
        )
      ) {
        throw new CallsignLevelSelectionRangeError();
      }
    }

    try {
      const result = await pool.query(
        'UPDATE teams SET name = COALESCE($1, name), description = COALESCE($2, description), visibility = COALESCE($3, visibility), can_join = COALESCE($4, can_join), parent_team_id = $5, callsign_name_format = COALESCE($6, callsign_name_format), color = COALESCE($8, color), callsign_level_selection = COALESCE($9, callsign_level_selection), updated_at = CURRENT_TIMESTAMP WHERE id = $7 RETURNING *',
        [name, description, visibility, can_join, parent_team_id, callsign_name_format, teamId, color, callsign_level_selection]
      );
      const updatedTeam = result.rows[0];

      // Bugfix (Requirement 3.2/3.3): a Sub_Team's `color`/
      // `callsign_name_format` is only ever COPIED from its
      // Organisation's then-current values at CREATION time
      // (`Team.create`'s ancestor-chain lookup above) -- it is never
      // re-read afterward. Without this cascade, changing an
      // Organisation's own `color`/`callsign_name_format` here would
      // only ever update the Organisation's own row, leaving every
      // already-created descendant Sub_Team's stored (denormalized)
      // value permanently stale -- exactly the reported bug ("the
      // sub-team's format does not update"). When the team just updated
      // is itself an Organisation (`parent_team_id IS NULL`, checked
      // against the POST-update row so a same-request re-parent to root
      // is also handled correctly) AND at least one of these two fields
      // was actually supplied on this update, push the new value down to
      // every existing descendant Sub_Team's own row too, in one
      // recursive-CTE-scoped UPDATE. `COALESCE` here mirrors the
      // Organisation row's own update above: a field that was NOT
      // supplied on this request (`undefined`) leaves each descendant's
      // existing stored value for that field untouched.
      if (
        updatedTeam &&
        updatedTeam.parent_team_id === null &&
        (color !== undefined || callsign_name_format !== undefined)
      ) {
        await pool.query(
          `WITH RECURSIVE descendants AS (
            SELECT id FROM teams WHERE parent_team_id = $1
            UNION ALL
            SELECT t.id FROM teams t JOIN descendants d ON t.parent_team_id = d.id
          )
          UPDATE teams
          SET color = COALESCE($2, color),
              callsign_name_format = COALESCE($3, callsign_name_format),
              updated_at = CURRENT_TIMESTAMP
          WHERE id IN (SELECT id FROM descendants)`,
          [teamId, color, callsign_name_format]
        );
      }

      return updatedTeam;
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error updating team');
      throw error;
    }
  }

  /**
   * Requirement 17.3/17.4 (task 36.3): deletes a team, and everything that
   * references it, inside a single transaction on one acquired client, in
   * FK-dependency order (deepest first): `channel_memberships` for every
   * channel belonging to this team, then the `channels` rows themselves,
   * then `team_memberships`, then the `teams` row. The baseline schema's
   * `channels.team_id`/`channel_memberships.channel_id` foreign keys do
   * NOT declare `ON DELETE CASCADE` (only `teams.parent_team_id` and
   * `team_memberships.team_id`/`.user_id` do), so those two deletes must
   * be performed explicitly here rather than relying on the database to
   * cascade them.
   *
   * On successful commit, one `remove_team_channel_group` Sync_Operation
   * is enqueued per deleted channel (each carrying that channel's
   * `authentik_group_id`/`authentik_read_group_id`/
   * `authentik_write_group_id`, whichever are non-null) so the
   * Sync_Worker can asynchronously delete the corresponding Authentik
   * group(s). Per Requirement 17.5's established pattern
   * (`TeamMembershipService`, `UserProvisioningService`), the enqueue
   * itself happens INSIDE the same transaction, passing the open `client`
   * through to `EventPublisher.publishOperation`, so the `sync_operations`
   * rows commit/roll back atomically with the deletion.
   *
   * Requirement 26.7 (task 48.4): additionally enqueues a SINGLE bulk
   * `revoke_tak_certificates` Sync_Operation covering every user who is a
   * direct or inherited member of this team OR any of its sub-teams
   * (resolved via the same descendants-of-`teamId` recursive query
   * `getTeamHierarchy` already uses), carrying the full list of affected
   * users' TAK usernames (`users.username`) in one payload so
   * `TakServerService.listCertificates()` only needs to be called once
   * for the whole batch when the Sync_Worker processes it (task 48.5),
   * rather than once per user -- the same N+1-avoidance principle already
   * established in Requirement 11. That membership list is resolved
   * BEFORE the `team_memberships` rows are deleted below (step 3), since
   * the membership rows are the only way to know which users are
   * affected. Nothing is enqueued when no affected user has a resolvable
   * username (e.g. an empty team).
   *
   * IF any step fails, the entire transaction is rolled back, leaving the
   * team and its associated records unchanged, and the error is
   * propagated to the caller.
   *
   * @param {number|string} teamId
   * @param {number|null} [deletedBy] - local user id of the actor
   *   performing the deletion, recorded on queued Sync_Operations.
   * @returns {Promise<object>} the deleted team row.
   */
  static async delete(teamId, deletedBy = null) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Fetch the channels belonging to this team BEFORE deleting them,
      // so their Authentik group ids are available for the post-delete
      // Sync_Operation enqueue below.
      const channelsResult = await client.query(
        'SELECT id, authentik_group_id, authentik_read_group_id, authentik_write_group_id FROM channels WHERE team_id = $1',
        [teamId]
      );
      const deletedChannels = channelsResult.rows;
      const channelIds = deletedChannels.map((channel) => channel.id);

      // Requirement 26.7: resolve every affected user's TAK username
      // (this team's members plus every sub-team's members, direct or
      // inherited) BEFORE any team_memberships row is deleted. The
      // recursive CTE mirrors getTeamHierarchy's descendants-of-teamId
      // traversal (its recursive step joins t.parent_team_id = th.id,
      // i.e. "find children of the accumulated set"), scoped here to just
      // the id column since only team_memberships.team_id membership is
      // needed.
      const affectedUsersResult = await client.query(
        `WITH RECURSIVE team_and_subteams AS (
          SELECT id FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id FROM teams t JOIN team_and_subteams ts ON t.parent_team_id = ts.id
        )
        SELECT DISTINCT u.username
        FROM team_memberships tm
        JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id IN (SELECT id FROM team_and_subteams) AND u.username IS NOT NULL`,
        [teamId]
      );
      const affectedTakUsernames = affectedUsersResult.rows.map((row) => row.username);

      // 1. channel_memberships for every channel belonging to this team.
      if (channelIds.length > 0) {
        await client.query('DELETE FROM channel_memberships WHERE channel_id = ANY($1)', [channelIds]);
      }

      // 2. channels rows for this team.
      await client.query('DELETE FROM channels WHERE team_id = $1', [teamId]);

      // 3. team_memberships for this team.
      await client.query('DELETE FROM team_memberships WHERE team_id = $1', [teamId]);

      // 4. the teams row itself.
      const result = await client.query('DELETE FROM teams WHERE id = $1 RETURNING *', [teamId]);

      // Requirement 17.4: enqueue one remove_team_channel_group
      // Sync_Operation per deleted channel, inside this same transaction
      // (Requirement 17.5's client-threading pattern), so the enqueue
      // commits/rolls back atomically with the deletion above. Group-id
      // fields that are null on the channel row are omitted entirely
      // (rather than passed through as `null`) so that
      // `operationSchemas.js`'s optional-field type check -- which only
      // skips a field when it is `undefined`, not merely falsy -- doesn't
      // reject an otherwise-valid payload for a channel that never had a
      // read/write group pair (e.g. a primary team channel).
      for (const channel of deletedChannels) {
        const payload = { channel_id: channel.id };
        if (channel.authentik_group_id != null) {
          payload.authentik_group_id = channel.authentik_group_id;
        }
        if (channel.authentik_read_group_id != null) {
          payload.authentik_read_group_id = channel.authentik_read_group_id;
        }
        if (channel.authentik_write_group_id != null) {
          payload.authentik_write_group_id = channel.authentik_write_group_id;
        }
        await EventPublisher.publishOperation('remove_team_channel_group', payload, deletedBy, client);
      }

      // Requirement 26.7: a single bulk revoke_tak_certificates
      // Sync_Operation for the whole team + sub-team batch, rather than
      // one operation per affected user.
      if (affectedTakUsernames.length > 0) {
        await EventPublisher.publishOperation(
          'revoke_tak_certificates',
          { tak_usernames: affectedTakUsernames },
          deletedBy,
          client
        );
      }

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ err: error, teamId }, 'Error deleting team');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Requirement 7.1/7.2 (task 15.1): the public, unauthenticated
   * team-access-request flow's joinable-teams listing. In addition to
   * the existing `t.can_join = true AND t.visibility = 'public'` filter
   * (which already excludes a Team whose OWN `visibility` is `private`,
   * Requirement 7.1), this also excludes a Team whose Ancestor_Chain
   * contains a `private` Team, even when the Team itself is `public`
   * (Requirement 7.2) -- a private-branch cascade.
   *
   * This is DELIBERATELY a standalone, unconditional exclusion rule, not
   * a call into `TeamVisibilityService` (Requirement 6's Visible_Branch):
   * this route has no `req.user` at all (it is fully anonymous), and
   * Requirement 7's rule is simpler than Visible_Branch -- there is no
   * Global_Manager bypass and no membership exception here, full stop.
   * See `TeamVisibilityService`'s own doc comment for the same point
   * from the other side.
   *
   * Implemented as a correlated `NOT EXISTS` subquery per row, matching
   * this query's own existing style of a recursive-CTE-per-correlated-
   * subquery (as already done above for the `rt` LEFT JOIN): for each
   * candidate Team `t`, walk its Ancestor_Chain via a recursive CTE
   * (starting from `t.parent_team_id`, i.e. `t`'s STRICT ancestors --
   * `t`'s own `visibility` is already constrained to `'public'` by the
   * outer `WHERE`, so it does not need to be re-checked here) and check
   * whether any row reached that way is `private`.
   *
   * Requirement 11.9/11.10 (task 34.1): each row also carries the
   * resolved root Team's (i.e. `t`'s Organisation's) `callsign_name_format`
   * value as `callsignNameFormat`, reusing the same `rt` LEFT JOIN already
   * computed above for `display_name` rather than adding a second
   * root-resolution subquery. The Client (`RequestAccess.jsx`) uses this
   * to conditionally render a required "Preferred Callsign Suffix" input
   * only when the selected Team's Organisation's format is `user_defined`,
   * without an extra request.
   */
  static async getJoinableTeams() {
    try {
      const result = await pool.query(`
        SELECT t.id, t.name, t.description, t.visibility,
               rt.callsign_name_format AS "callsignNameFormat",
               CASE 
                 WHEN t.parent_team_id IS NOT NULL THEN 
                   COALESCE(rt.callsign_prefix, rt.name, '') || ' - ' || t.name
                 ELSE t.name
               END as display_name
        FROM teams t
        LEFT JOIN teams rt ON rt.id = (
          WITH RECURSIVE root_team AS (
            SELECT id, name, parent_team_id FROM teams WHERE id = t.id
            UNION ALL
            SELECT p.id, p.name, p.parent_team_id 
            FROM teams p JOIN root_team r ON p.id = r.parent_team_id
          )
          SELECT id FROM root_team WHERE parent_team_id IS NULL
        )
        WHERE t.can_join = true AND t.visibility = 'public'
        AND NOT EXISTS (
          WITH RECURSIVE ancestors AS (
            SELECT parent_team_id FROM teams WHERE id = t.id
            UNION ALL
            SELECT p.parent_team_id FROM teams p
            JOIN ancestors a ON p.id = a.parent_team_id
          )
          SELECT 1 FROM teams anc
          JOIN ancestors a ON anc.id = a.parent_team_id
          WHERE anc.visibility = 'private'
        )
        ORDER BY display_name
      `);
      return result.rows;
    } catch (error) {
      logger.error({ err: error }, 'Error fetching joinable teams');
      return [];
    }
  }

  static async createTeamChannel(teamId) {
    try {
      // Get team with root team info
      const teamResult = await pool.query(`
        WITH RECURSIVE root_team AS (
          SELECT id, name, callsign_prefix, parent_team_id FROM teams WHERE id = $1
          UNION ALL
          SELECT p.id, p.name, p.callsign_prefix, p.parent_team_id 
          FROM teams p JOIN root_team r ON p.id = r.parent_team_id
        )
        SELECT t.id, t.name, t.parent_team_id,
               rt.callsign_prefix as root_prefix,
               CASE 
                 WHEN t.parent_team_id IS NOT NULL THEN 
                   COALESCE(rt.callsign_prefix, rt.name, '') || ' - ' || t.name
                 ELSE t.name
               END as display_name
        FROM teams t
        LEFT JOIN (SELECT name, callsign_prefix FROM root_team WHERE parent_team_id IS NULL) rt ON true
        WHERE t.id = $1
      `, [teamId]);
      
      if (!teamResult.rows[0]) return null;
      
      const team = teamResult.rows[0];
      
      // Generate channel name
      const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
      let channelName;
      if (team.parent_team_id) {
        // Sub-team: "Teams - FENZ - Southland District"
        channelName = `Teams${separator}${team.root_prefix}${separator}${team.name}`;
      } else {
        // Root team: "Teams - FENZ"
        channelName = `Teams${separator}${team.root_prefix || team.name}`;
      }
      
      const description = `Users from ${team.display_name} (Location sharing enabled)`;
      
      // Create groups in Authentik with tak_ prefix
      const authentikGroupName = `tak_${channelName}`;
      const channelDbName = channelName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      
      try {
        // Create read/write group. If a group with this name already
        // exists in Authentik (e.g. left over from an earlier
        // partially-failed team creation, or created out-of-band), the
        // POST fails with a 400 (unique-name constraint) -- reuse that
        // existing group's pk instead of silently proceeding with no
        // group id, which is what happened before this check existed
        // (groupResponse.ok was never verified, so `group.pk` was
        // `undefined` and got inserted as NULL with no error surfaced).
        let group;
        const groupResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: authentikGroupName,
            attributes: {
              description: description
            }
          })
        });

        if (groupResponse.ok) {
          group = await groupResponse.json();
        } else {
          const lookupResponse = await fetch(
            `${process.env.AUTHENTIK_URL}/api/v3/core/groups/?name=${encodeURIComponent(authentikGroupName)}`,
            { headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` } }
          );
          const lookupData = lookupResponse.ok ? await lookupResponse.json() : null;
          group = lookupData?.results?.find((g) => g.name === authentikGroupName);

          if (!group) {
            const errorText = await groupResponse.text();
            throw new Error(
              `Failed to create or find existing Authentik group "${authentikGroupName}": ${groupResponse.status} ${errorText}`
            );
          }
          logger.info(
            { teamId, authentikGroupName, groupId: group.pk },
            'Reused existing Authentik group instead of creating a duplicate'
          );
        }
        
        // Create channel with Authentik group ID
        const channelResult = await pool.query(
          'INSERT INTO channels (name, display_name, description, team_id, authentik_group_id, is_primary) VALUES ($1, $2, $3, $4, $5, true) RETURNING *',
          [channelDbName, channelName, description, teamId, group.pk]
        );
        
        return channelResult.rows[0];
      } catch (authentikError) {
        logger.error({ err: authentikError, teamId }, 'Error creating Authentik groups');
        
        // Fallback: create channel without Authentik groups
        const channelResult = await pool.query(
          'INSERT INTO channels (name, display_name, description, team_id, is_primary) VALUES ($1, $2, $3, $4, true) RETURNING *',
          [channelDbName, channelName, description, teamId]
        );
        
        return channelResult.rows[0];
      }
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error creating team channel');
      return null;
    }
  }
}

Team.TeamDepthExceededError = TeamDepthExceededError;
Team.CallsignLevelSelectionRangeError = CallsignLevelSelectionRangeError;
Team.CallsignLevelSelectionSubTeamError = CallsignLevelSelectionSubTeamError;

module.exports = Team;