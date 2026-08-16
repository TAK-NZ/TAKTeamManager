const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireTeamAdmin } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const { paginationParams } = require('../middleware/pagination');
const Team = require('../models/Team');
const pool = require('../config/database');
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
router.get('/my-teams', authenticateToken, authorize, paginationParams, async (req, res) => {
  try {
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
      // Regular users see only their teams (inherently small; not paginated).
      teams = await Team.getUserTeams(req.user.id);
    }
    res.json(pagination ? { teams, pagination } : { teams });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch teams');
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

// Create team
router.post('/', authenticateToken, authorize, [
  body('name').trim().isLength({ min: 1, max: 255 }),
  body('description').optional().trim(),
  body('callsignPrefix').optional().trim(),
  body('color').optional().trim(),
  body('visibility').optional().isIn(['public', 'private']),
  body('canJoin').optional().isBoolean(),
  body('parentTeamId').optional().isInt(),
  body('callsignSubteamDepth').optional().isInt({ min: 0, max: 5 }),
  body('callsignNameFormat').optional().isIn(['full_name', 'first_initial_last', 'first_last_initial'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    let { name, description, callsignPrefix, color, visibility, canJoin, parentTeamId, callsignSubteamDepth, callsignNameFormat } = req.body;

    // Authorization (root team requires Global_Manager, sub-team requires
    // Global_Manager or parent-team admin) is enforced centrally by
    // authorize.js via the 'POST /api/teams': ['team:create:root_or_sub']
    // Permission_Registry entry.

    // If creating sub-team, inherit color from parent
    if (parentTeamId) {
      getLogger().debug({ parentTeamId, actorId: req.user.id }, 'Creating sub-team for parent');
      const parentTeam = await Team.findById(parentTeamId);
      if (!parentTeam) {
        return res.status(400).json({ error: 'Parent team not found' });
      }
      // Sub-teams inherit color from parent
      color = parentTeam.color;
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
      callsign_subteam_depth: !parentTeamId ? callsignSubteamDepth : null,
      callsign_name_format: !parentTeamId ? callsignNameFormat : null
    });

    // Skip adding creator as admin for now since user ID is string

    res.status(201).json({ team });
  } catch (error) {
    getLogger().error({ err: error }, 'Team creation error');
    res.status(500).json({ error: 'Failed to create team', details: error.message });
  }
});

// Update team
router.put('/:teamId', authenticateToken, authorize, [
  body('name').optional().trim().isLength({ min: 1, max: 255 }),
  body('description').optional().trim(),
  body('callsignPrefix').optional().trim(),
  body('visibility').optional().isIn(['public', 'private']),
  body('canJoin').optional().isBoolean(),
  body('parentTeamId').optional().custom(value => value === null || Number.isInteger(Number(value))),
  body('callsignSubteamDepth').optional().isInt({ min: 0, max: 5 }),
  body('callsignNameFormat').optional().isIn(['full_name', 'first_initial_last', 'first_last_initial'])
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

    const { name, description, callsignPrefix, visibility, canJoin, parentTeamId, callsignSubteamDepth, callsignNameFormat } = req.body;
    
    const updatedTeam = await Team.update(req.params.teamId, {
      name,
      description,
      visibility,
      can_join: canJoin,
      parent_team_id: parentTeamId,
      callsign_subteam_depth: callsignSubteamDepth,
      callsign_name_format: callsignNameFormat
      // Note: color is intentionally excluded - cannot be changed after creation
    });

    // Update user attributes if callsign settings changed
    const UserAttributesService = require('../services/userAttributes');
    if (callsignSubteamDepth !== undefined || callsignNameFormat !== undefined) {
      await UserAttributesService.updateTeamUserAttributes(req.params.teamId);
    }

    res.json({ team: updatedTeam });
  } catch (error) {
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
    res.status(201).json({ membership });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add member' });
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

// Get sub-teams
router.get('/:teamId/sub-teams', authenticateToken, authorize, async (req, res) => {
  try {
    const subTeams = await Team.getSubTeams(req.params.teamId);
    res.json({ subTeams: subTeams || [] });
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
    res.json({ message: 'Team deleted successfully' });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to delete team');
    res.status(500).json({ error: 'Failed to delete team' });
  }
});

module.exports = router;