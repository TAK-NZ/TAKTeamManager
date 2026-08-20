const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireTeamAdmin } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const { paginationParams } = require('../middleware/pagination');
const Team = require('../models/Team');
const User = require('../models/User');
const pool = require('../config/database');
const { isValidCallsignPrefix, isValidCallsignSuffix } = require('../utils/callsignValidation');
const { TAK_ROLE_VALUES } = require('./settings');
const { checkCallsignSuffixUniqueness, CallsignSuffixConflictError } = require('../services/CallsignSuffixUniquenessService');
const TeamVisibilityService = require('../services/TeamVisibilityService');
const router = express.Router();

// Get joinable teams (public endpoint)
router.get('/joinable', async (req, res) => {
  try {
    const teams = await Team.getJoinableTeams();
    res.json({ teams });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch joinable teams');
    res.status(500).json({ error: 'Failed to fetch joinable teams' });
  }
});

// Get user's teams
//
// Requirement 11.4: the admin "all teams" branch (`Team.getAllTeams()`) is
// the potentially-large, unbounded list this task scopes pagination to;
// the regular-user branch (`Team.getUserTeams()`) is inherently bounded by
// how many teams one user belongs to, so it is left unpaginated and simply
// doesn't consume `req.pagination`. `paginationParams` still runs
// unconditionally ahead of the handler -- it's a cheap query-param
// validation step regardless of which branch ends up using it.
//
// Requirement 6.6 (task 14.3): an optional `?scope=organisation` query
// parameter is layered on top of the above, ADDITIVELY -- when present,
// it takes over the response entirely (every Visible_Branch Team within
// the caller's own Organisation, via `TeamVisibilityService.
// filterVisibleBranches`), regardless of `req.user.isAdmin`, and returns
// before either of the two existing branches runs. When ABSENT, the
// existing admin-paginated-all-teams vs. regular-user-own-teams-only
// behavior is completely unchanged.
router.get('/my-teams', authenticateToken, authorize, paginationParams, async (req, res) => {
  try {
    if (req.query.scope === 'organisation') {
      const orgTeams = await resolveOwnOrganisationTeams(req.user);
      const visibleTeams = await TeamVisibilityService.filterVisibleBranches(orgTeams, req.user);
      return res.json({ teams: visibleTeams });
    }

    let teams;
    let pagination;
    if (req.user.isAdmin) {
      // Global admins see all teams, paginated.
      const { page, pageSize, offset } = req.pagination;
      const [pagedTeams, total] = await Promise.all([
        Team.getAllTeams(pageSize, offset),
        Team.getTeamCount()
      ]);
      teams = pagedTeams;
      pagination = { page, pageSize, total };
    } else {
      // Regular users see all teams within their organisation, filtered
      // by visibility (private teams hidden unless they're a member/admin).
      const orgTeams = await resolveOwnOrganisationTeams(req.user, true);
      teams = await TeamVisibilityService.filterVisibleBranches(orgTeams, req.user);
    }
    res.json(pagination ? { teams, pagination } : { teams });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch teams');
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

// Requirement 6.6 (task 14.3): resolves the caller's OWN Organisation's
// full Team hierarchy (every Team belonging to the same Organisation as
// any of the caller's own team memberships, direct or inherited), for
// `?scope=organisation` to filter through `TeamVisibilityService.
// filterVisibleBranches`.
//
// Deliberately queries `team_memberships` directly (both direct AND
// inherited rows, i.e. no `inherited_from_team_id IS NULL` filter),
// rather than reusing `Team.getUserTeams` (which filters to direct
// membership only) -- Requirement 6.6's "any of the caller's own team
// memberships" is explicitly direct-or-inherited, matching the
// Org_Member glossary definition.
//
// A caller's own memberships are all necessarily within a single
// Organisation in practice (Requirement 6.2's Organisation-scoping), so
// resolving the Organisation of the FIRST membership found is a
// reasonable simplification -- this does not need to reconcile multiple
// memberships that happen to resolve to different Organisations.
//
// A Global_Manager may hold no team membership of their own at all
// (Requirement 6.4's visibility bypass does not require any membership),
// so "their own Organisation" is ill-defined for them. This deliberately
// takes the SIMPLER of the two possible interpretations documented in
// this task: `scope=organisation` means "MY organisation", so a caller
// with no resolvable Organisation of their own (Global_Manager or
// otherwise) gets an empty list here, rather than falling back to every
// Team across every Organisation.
async function resolveOwnOrganisationTeams(user, includeDetails = false) {
  const membershipResult = await pool.query(
    'SELECT team_id FROM team_memberships WHERE user_id = $1 LIMIT 1',
    [user.userId]
  );
  const membershipTeamId = membershipResult.rows[0]?.team_id;
  if (!membershipTeamId) {
    return [];
  }
  const ancestorChain = await Team.getAncestorChain(membershipTeamId);
  if (!ancestorChain || ancestorChain.length === 0) {
    return [];
  }
  const organisationId = ancestorChain[0].id;
  return Team.getOrganisationTeams(organisationId, includeDetails ? user.userId : null);
}

// Create team
router.post('/', authenticateToken, authorize, [
  body('name').trim().isLength({ min: 1, max: 255 }),
  body('description').optional().trim(),
  body('callsignPrefix').optional().trim().custom(value => isValidCallsignPrefix(value))
    .withMessage('callsignPrefix may only contain letters and digits'),
  body('color').optional().trim(),
  body('visibility').optional().isIn(['public', 'private']),
  body('canJoin').optional().isBoolean(),
  // .optional({ nullable: true }) (not plain .optional()) since the client
  // always sends parentTeamId: null for a top-level team -- plain
  // .optional() only skips validation when the field is ABSENT, not when
  // it's present-but-null, so .isInt() was running against null and
  // failing every top-level team creation with a 400. Same fix already
  // applied elsewhere for this exact bug class (see deploymentChannels.js,
  // mou.js, vendorChannels.js) and the PUT /:teamId route just below,
  // which already handles this correctly via a custom validator.
  body('parentTeamId').optional({ nullable: true }).isInt(),
  body('callsignNameFormat').optional().isIn(['full_name', 'first_initial_last', 'first_last_initial', 'first_initial_dot_last', 'user_defined']),
  // Requirement 5.1/5.2 (task 8.2): basic request-shape validation only
  // (an array of integers) -- the actual 1..MAX_TEAM_DEPTH range check and
  // the Sub_Team-rejection rule (Requirement 5.6) are enforced by
  // `Team.create` itself (task 8.1) and mapped to their specific 400
  // messages in this route's catch block below, not duplicated here.
  body('callsignLevelSelection').optional().isArray()
    .custom(value => value === undefined || (Array.isArray(value) && value.every(v => Number.isInteger(v))))
    .withMessage('callsignLevelSelection must be an array of integers')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    let { name, description, callsignPrefix, color, visibility, canJoin, parentTeamId, callsignNameFormat, callsignLevelSelection } = req.body;

    // Authorization (root team requires Global_Manager, sub-team requires
    // Global_Manager or parent-team admin) is enforced centrally by
    // authorize.js via the 'POST /api/teams': ['team:create:root_or_sub']
    // Permission_Registry entry.

    // Requirement 3.2 (task 6.1): the actual inherited color/
    // callsign_name_format VALUES are now resolved by `Team.create` itself
    // (from the Sub_Team's Organisation, not necessarily its immediate
    // parent), so this route no longer sets `color` from `parentTeam.color`
    // here -- doing so would be redundant with, and could conflict with,
    // `Team.create`'s own inheritance logic. This lookup is kept only for
    // its existing "Parent team not found" 400 validation.
    if (parentTeamId) {
      getLogger().debug({ parentTeamId, actorId: req.user.userId }, 'Creating sub-team for parent');
      const parentTeam = await Team.findById(parentTeamId);
      if (!parentTeam) {
        return res.status(400).json({ error: 'Parent team not found' });
      }
    }

    getLogger().debug({
      name,
      description,
      callsign_prefix: callsignPrefix,
      color,
      visibility: visibility || 'private',
      can_join: canJoin || false,
      parent_team_id: parentTeamId
    }, 'Creating team with data');
    
    const team = await Team.create({
      name,
      description,
      callsign_prefix: callsignPrefix,
      color,
      visibility: visibility || 'private',
      can_join: canJoin || false,
      parent_team_id: parentTeamId,
      created_by: null, // Skip created_by for now since user ID is string
      callsign_name_format: !parentTeamId ? callsignNameFormat : null,
      callsign_level_selection: callsignLevelSelection
    });

    // Skip adding creator as admin for now since user ID is string

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'team.create', 'team', team.id, JSON.stringify({ name: team.name, parentTeamId: team.parent_team_id })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.status(201).json({ team });
  } catch (error) {
    // Requirement 2.3 (task 5.2): Team.create throws this BEFORE any
    // INSERT is attempted when the requested Sub_Team would sit deeper
    // than MAX_TEAM_DEPTH, so no team is created in this branch.
    if (error instanceof Team.TeamDepthExceededError) {
      return res.status(400).json({ error: error.message });
    }
    // Requirement 5.2 (task 8.2): Team.create throws this BEFORE any
    // INSERT is attempted when a supplied callsignLevelSelection value is
    // out of the 1..MAX_TEAM_DEPTH range.
    if (error instanceof Team.CallsignLevelSelectionRangeError) {
      return res.status(400).json({ error: error.message });
    }
    // Requirement 5.6 (task 8.2): Team.create throws this BEFORE any
    // INSERT is attempted when callsignLevelSelection is supplied on a
    // Sub_Team creation request (parentTeamId present).
    if (error instanceof Team.CallsignLevelSelectionSubTeamError) {
      return res.status(400).json({ error: error.message });
    }
    getLogger().error({ err: error }, 'Team creation error');
    res.status(500).json({ error: 'Failed to create team', details: error.message });
  }
});

// Update team
router.put('/:teamId', authenticateToken, authorize, [
  body('name').optional().trim().isLength({ min: 1, max: 255 }),
  body('description').optional().trim(),
  body('callsignPrefix').optional().trim().custom(value => isValidCallsignPrefix(value))
    .withMessage('callsignPrefix may only contain letters and digits'),
  body('color').optional().trim(),
  body('visibility').optional().isIn(['public', 'private']),
  body('canJoin').optional().isBoolean(),
  body('parentTeamId').optional().custom(value => value === null || Number.isInteger(Number(value))),
  body('callsignNameFormat').optional().isIn(['full_name', 'first_initial_last', 'first_last_initial', 'first_initial_dot_last', 'user_defined']),
  // Requirement 5.1/5.2 (task 8.2): basic request-shape validation only
  // (an array of integers) -- the actual 1..MAX_TEAM_DEPTH range check and
  // the Sub_Team-rejection rule (Requirement 5.6) are enforced by
  // `Team.update` itself (task 8.1) and mapped to their specific 400
  // messages in this route's catch block below, not duplicated here.
  body('callsignLevelSelection').optional().isArray()
    .custom(value => value === undefined || (Array.isArray(value) && value.every(v => Number.isInteger(v))))
    .withMessage('callsignLevelSelection must be an array of integers')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    // Authorization (global admin or team admin) is enforced centrally by
    // authorize.js via the 'PUT /api/teams/:teamId': ['team:update']
    // Permission_Registry entry.

    const team = await Team.findById(req.params.teamId);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const { name, description, callsignPrefix, color, visibility, canJoin, parentTeamId, callsignNameFormat, callsignLevelSelection } = req.body;

    // Requirement 3.3 (task 6.1): `color`/`callsignNameFormat` are passed
    // straight through to `Team.update`, which silently ignores them
    // (preserving the team's existing stored values, never rejecting the
    // request) when `teamId` is a Sub_Team. An Organisation's own
    // `color`/`callsignNameFormat` remain freely updatable here.
    const updatedTeam = await Team.update(req.params.teamId, {
      name,
      description,
      color,
      visibility,
      can_join: canJoin,
      parent_team_id: parentTeamId,
      callsign_name_format: callsignNameFormat,
      callsign_level_selection: callsignLevelSelection
    });

    // When canJoin is explicitly set to false, revoke any existing
    // sign-up code for this team so the code is no longer usable.
    if (canJoin === false) {
      await pool.query('DELETE FROM signup_codes WHERE team_id = $1', [req.params.teamId]);
    }

    // Update user attributes if callsign settings changed. Requirement
    // 5.12 (task 11.6): a Callsign_Level_Selection change must also
    // trigger this regeneration, consistent with the existing
    // callsignNameFormat-change trigger. `updateTeamUserAttributes` ->
    // `generateCallsign` -> `computeCallsignAttributes` only ever READS
    // the user's stored `callsign_suffix` (never recomputes/writes it,
    // per task 11.1), so this regeneration cannot alter it.
    const UserAttributesService = require('../services/userAttributes');
    if (callsignNameFormat !== undefined || callsignLevelSelection !== undefined) {
      await UserAttributesService.updateTeamUserAttributes(req.params.teamId);
    }

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'team.update', 'team', parseInt(req.params.teamId, 10), JSON.stringify({ name: updatedTeam.name })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ team: updatedTeam });
  } catch (error) {
    // Requirement 5.2 (task 8.2): Team.update throws this BEFORE any
    // UPDATE is attempted when a supplied callsignLevelSelection value is
    // out of the 1..MAX_TEAM_DEPTH range.
    if (error instanceof Team.CallsignLevelSelectionRangeError) {
      return res.status(400).json({ error: error.message });
    }
    // Requirement 5.6 (task 8.2): Team.update throws this BEFORE any
    // UPDATE is attempted when callsignLevelSelection is supplied on a
    // Sub_Team update request.
    if (error instanceof Team.CallsignLevelSelectionSubTeamError) {
      return res.status(400).json({ error: error.message });
    }
    getLogger().error({ err: error }, 'Failed to update team');
    res.status(500).json({ error: 'Failed to update team' });
  }
});

// Get team details
router.get('/:teamId', authenticateToken, authorize, async (req, res) => {
  try {
    getLogger().debug({ teamId: req.params.teamId }, 'Fetching team details');
    
    const team = await Team.findById(req.params.teamId);
    if (!team) {
      getLogger().debug({ teamId: req.params.teamId }, 'Team not found');
      return res.status(404).json({ error: 'Team not found' });
    }

    getLogger().debug({ team }, 'Team found');
    
    let members = [];
    let channels = [];
    try {
      members = await Team.getMembers(req.params.teamId);
      getLogger().debug({ count: members?.length || 0 }, 'Members fetched');
    } catch (memberError) {
      getLogger().error({ err: memberError }, 'Error fetching members, continuing with empty array');
      members = [];
    }

    try {
      const channelResult = await pool.query('SELECT * FROM channels WHERE team_id = $1', [req.params.teamId]);
      channels = channelResult.rows;
      getLogger().debug({ count: channels?.length || 0 }, 'Channels fetched');
    } catch (channelError) {
      getLogger().error({ err: channelError }, 'Error fetching channels, continuing with empty array');
      channels = [];
    }

    res.json({ team, members: members || [], channels: channels || [] });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch team details');
    res.status(500).json({ error: 'Failed to fetch team', details: error.message });
  }
});

// Add member to team
router.post('/:teamId/members', authenticateToken, authorize, requireTeamAdmin, [
  body('userId').isInt(),
  body('role').optional().isIn(['admin', 'member'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { userId, role = 'member' } = req.body;
    const membership = await Team.addMember(req.params.teamId, userId, role);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'team.member_add', 'team', parseInt(req.params.teamId, 10), JSON.stringify({ addedUserId: userId, role })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.status(201).json({ membership });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// Edit a Member_List member's name, TAK_Role, and/or callsign_suffix
// (Requirements 11.4, 11.16, 13.2, 13.3, 13.4, 13.5, 13.6, 13.9, task 28.1).
//
// All body fields are optional -- only the fields actually present are
// written. `email` is intentionally NOT an accepted field: if present in
// the body it is silently ignored (Requirement 13.3's defense-in-depth;
// the Client never sends it, but this route independently never applies
// it even if sent directly).
//
// Authorization ('team:members:edit') is enforced centrally by
// authorize.js via the Permission_Registry entry added alongside this
// route (task 28.2 implements the resolver itself; until then this
// route simply references the permission identifier).
router.patch('/:teamId/members/:userId', authenticateToken, authorize, [
  body('firstName').optional().trim().isLength({ min: 1, max: 150 }),
  body('lastName').optional().trim().isLength({ min: 1, max: 150 }),
  body('takRole').optional().isIn(TAK_ROLE_VALUES)
    .withMessage('Invalid takRole value'),
  body('callsignSuffix').optional().trim().custom(value => isValidCallsignSuffix(value))
    .withMessage('callsignSuffix may only contain letters, digits, "-", and "."')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { teamId, userId } = req.params;
    const { firstName, lastName, takRole, callsignSuffix } = req.body;

    // Requirement 11.16: validate callsign_suffix uniqueness BEFORE any
    // write, so a conflicting value never reaches the database. Excludes
    // the user being edited (`userId`) from the comparison set, so a
    // user's own unchanged callsign_suffix never spuriously conflicts
    // with itself.
    if (callsignSuffix !== undefined) {
      try {
        await checkCallsignSuffixUniqueness(teamId, callsignSuffix, parseInt(userId, 10));
      } catch (conflictError) {
        if (conflictError instanceof CallsignSuffixConflictError) {
          return res.status(400).json({ error: conflictError.message });
        }
        throw conflictError;
      }
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updateFields = {};
    if (firstName !== undefined) {
      updateFields.first_name = firstName;
    }
    if (lastName !== undefined) {
      updateFields.last_name = lastName;
    }
    if (callsignSuffix !== undefined) {
      updateFields.callsign_suffix = callsignSuffix;
    }
    if (takRole !== undefined) {
      updateFields.tak_role = takRole;
    }

    const updatedUser = await User.update(userId, updateFields);

    // Requirement 11.4 dual-write: callsign_suffix mirrors to user_cache,
    // keyed by authentik_id (not the local users.id).
    if (callsignSuffix !== undefined) {
      await pool.query(
        'UPDATE user_cache SET callsign_suffix = $1 WHERE authentik_id = $2',
        [callsignSuffix, targetUser.authentik_user_id]
      );
    }

    // Requirement 13.6: takRole writes dual-write to user_cache and push
    // to Authentik via the fetch-merge-PATCH updateUserAttributes (task
    // 11.4), so this write cannot clobber, and cannot be clobbered by, a
    // concurrent callsign regeneration.
    if (takRole !== undefined) {
      await pool.query(
        'UPDATE user_cache SET tak_role = $1 WHERE authentik_id = $2',
        [takRole, targetUser.authentik_user_id]
      );

      const UserAttributesService = require('../services/userAttributes');
      await UserAttributesService.updateUserAttributes(targetUser.authentik_user_id, { role: takRole });
    }

    // Push first_name/last_name to Authentik custom attributes (same
    // one-way-sync pattern as takRole above: local edit pushes to Authentik,
    // periodic sync reads back from Authentik).
    if (firstName !== undefined || lastName !== undefined) {
      const UserAttributesService = require('../services/userAttributes');
      const nameAttrs = {};
      if (firstName !== undefined) nameAttrs.firstName = firstName;
      if (lastName !== undefined) nameAttrs.lastName = lastName;
      await UserAttributesService.updateUserAttributes(targetUser.authentik_user_id, nameAttrs);
      // Also mirror to user_cache
      if (firstName !== undefined) {
        await pool.query('UPDATE user_cache SET first_name = $1 WHERE authentik_id = $2', [firstName, targetUser.authentik_user_id]);
      }
      if (lastName !== undefined) {
        await pool.query('UPDATE user_cache SET last_name = $1 WHERE authentik_id = $2', [lastName, targetUser.authentik_user_id]);
      }
    }

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'team.member_edit', 'team', parseInt(teamId, 10), JSON.stringify({ editedUserId: parseInt(userId, 10) })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ member: updatedUser });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to update team member');
    res.status(500).json({ error: 'Failed to update team member' });
  }
});

// Get team hierarchy
router.get('/:teamId/hierarchy', authenticateToken, authorize, async (req, res) => {
  try {
    const hierarchy = await Team.getTeamHierarchy(req.params.teamId);
    res.json({ hierarchy });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch hierarchy' });
  }
});

// Get callsign level options (Requirement 5.8-5.11, task 8.3): the flat
// { team_depth, callsign_prefix } rows Team.getSubTeamsForCallsignLevel
// returns for :teamId's whole hierarchy, used by the Client to label each
// Callsign_Level_Selection toggle. Authorization ('team:read') is enforced
// centrally by authorize.js, matching the sibling GET /:teamId,
// /:teamId/hierarchy, and /:teamId/sub-teams routes above.
router.get('/:teamId/callsign-level-options', authenticateToken, authorize, async (req, res) => {
  try {
    const options = await Team.getSubTeamsForCallsignLevel(req.params.teamId);
    res.json({ options });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch callsign level options');
    res.status(500).json({ error: 'Failed to fetch callsign level options' });
  }
});

// Get sub-teams
//
// Requirement 6.5 (task 14.2): this route's OWN access to `:teamId` is
// already gated by the `'team:read'` row-scoped Visible_Branch check
// (enforced centrally via `authorize`, task 14.1) -- by the time this
// handler runs, the caller is already confirmed able to see `:teamId`
// itself. What's filtered here is the CHILDREN in the returned list:
// some of `:teamId`'s direct sub-teams may themselves be private (or
// have a private ancestor of their own), and those must be excluded
// from the returned list rather than causing the whole request to 404.
router.get('/:teamId/sub-teams', authenticateToken, authorize, async (req, res) => {
  try {
    const subTeams = await Team.getSubTeams(req.params.teamId);
    const visibleSubTeams = await TeamVisibilityService.filterVisibleBranches(subTeams || [], req.user);
    res.json({ subTeams: visibleSubTeams });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch sub-teams');
    res.status(500).json({ error: 'Failed to fetch sub-teams' });
  }
});

// Delete team (global admin only)
router.delete('/:teamId', authenticateToken, authorize, async (req, res) => {
  try {
    // Authorization (global admin only) is enforced centrally by
    // authorize.js via the 'DELETE /api/teams/:teamId': ['team:delete:global']
    // Permission_Registry entry.

    const team = await Team.findById(req.params.teamId);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // Check if team has sub-teams - prevent deletion to maintain hierarchy integrity
    const subTeams = await Team.getSubTeams(req.params.teamId);
    if (subTeams.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete team with sub-teams. Delete sub-teams first to maintain hierarchy integrity.' 
      });
    }

    // req.user.userId is the local users.id (see server/middleware/auth.js),
    // which is what Team.delete records as `created_by` on any
    // remove_team_channel_group Sync_Operations it enqueues.
    await Team.delete(req.params.teamId, req.user.userId);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'team.delete', 'team', parseInt(req.params.teamId, 10), null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ message: 'Team deleted successfully' });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to delete team');
    res.status(500).json({ error: 'Failed to delete team' });
  }
});

module.exports = router;