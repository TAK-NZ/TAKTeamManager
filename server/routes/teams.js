const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireTeamAdmin } = require('../middleware/auth');
const Team = require('../models/Team');
const pool = require('../config/database');
const router = express.Router();

// Get joinable teams (public endpoint)
router.get('/joinable', async (req, res) => {
  try {
    const teams = await Team.getJoinableTeams();
    res.json({ teams });
  } catch (error) {
    console.error('Failed to fetch joinable teams:', error);
    res.status(500).json({ error: 'Failed to fetch joinable teams' });
  }
});

// Get user's teams
router.get('/my-teams', authenticateToken, async (req, res) => {
  try {
    let teams;
    if (req.user.isAdmin) {
      // Global admins see all teams
      teams = await Team.getAllTeams();
    } else {
      // Regular users see only their teams
      teams = await Team.getUserTeams(req.user.id);
    }
    res.json({ teams });
  } catch (error) {
    console.error('Failed to fetch teams:', error);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

// Create team
router.post('/', authenticateToken, [
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
    const { name, description, callsignPrefix, color, visibility, canJoin, parentTeamId, callsignSubteamDepth, callsignNameFormat } = req.body;
    
    // If creating top-level team, verify global admin access
    if (!parentTeamId && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Global admin access required to create top-level teams' });
    }
    
    // If creating sub-team, verify admin access to parent
    if (parentTeamId) {
      console.log('Creating sub-team for parent:', parentTeamId, 'by user:', req.user.id);
      // For now, allow any authenticated user to create sub-teams
      // TODO: Implement proper team admin checking when team memberships are set up
    }

    console.log('Creating team with data:', {
      name,
      description,
      callsign_prefix: callsignPrefix,
      color,
      visibility: visibility || 'private',
      can_join: canJoin || false,
      parent_team_id: parentTeamId
    });
    
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
    console.error('Team creation error:', error);
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to create team', details: error.message });
  }
});

// Update team
router.put('/:teamId', authenticateToken, [
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
    // Only global admins can update teams for now
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required to update teams' });
    }

    const team = await Team.findById(req.params.teamId);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const { name, description, callsignPrefix, visibility, canJoin, parentTeamId, callsignSubteamDepth, callsignNameFormat } = req.body;
    const updatedTeam = await Team.update(req.params.teamId, {
      name,
      description,
      callsign_prefix: callsignPrefix,
      visibility,
      can_join: canJoin,
      parent_team_id: parentTeamId,
      callsign_subteam_depth: callsignSubteamDepth,
      callsign_name_format: callsignNameFormat
    });

    res.json({ team: updatedTeam });
  } catch (error) {
    console.error('Failed to update team:', error);
    res.status(500).json({ error: 'Failed to update team' });
  }
});

// Get team details
router.get('/:teamId', authenticateToken, async (req, res) => {
  try {
    console.log('Fetching team details for ID:', req.params.teamId);
    
    const team = await Team.findById(req.params.teamId);
    if (!team) {
      console.log('Team not found:', req.params.teamId);
      return res.status(404).json({ error: 'Team not found' });
    }

    console.log('Team found:', team);
    
    let members = [];
    let channels = [];
    try {
      members = await Team.getMembers(req.params.teamId);
      console.log('Members fetched:', members?.length || 0);
    } catch (memberError) {
      console.error('Error fetching members, continuing with empty array:', memberError);
      members = [];
    }

    try {
      const channelResult = await pool.query('SELECT * FROM channels WHERE team_id = $1', [req.params.teamId]);
      channels = channelResult.rows;
      console.log('Channels fetched:', channels?.length || 0);
    } catch (channelError) {
      console.error('Error fetching channels, continuing with empty array:', channelError);
      channels = [];
    }

    res.json({ team, members: members || [], channels: channels || [] });
  } catch (error) {
    console.error('Failed to fetch team details:', error);
    res.status(500).json({ error: 'Failed to fetch team', details: error.message });
  }
});

// Add member to team
router.post('/:teamId/members', authenticateToken, requireTeamAdmin, [
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
router.get('/:teamId/hierarchy', authenticateToken, async (req, res) => {
  try {
    const hierarchy = await Team.getTeamHierarchy(req.params.teamId);
    res.json({ hierarchy });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch hierarchy' });
  }
});

// Get sub-teams
router.get('/:teamId/sub-teams', authenticateToken, async (req, res) => {
  try {
    const subTeams = await Team.getSubTeams(req.params.teamId);
    res.json({ subTeams: subTeams || [] });
  } catch (error) {
    console.error('Failed to fetch sub-teams:', error);
    res.status(500).json({ error: 'Failed to fetch sub-teams' });
  }
});

// Delete team (global admin only)
router.delete('/:teamId', authenticateToken, async (req, res) => {
  try {
    // Only global admins can delete teams
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Global admin access required to delete teams' });
    }

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

    await Team.delete(req.params.teamId);
    res.json({ message: 'Team deleted successfully' });
  } catch (error) {
    console.error('Failed to delete team:', error);
    res.status(500).json({ error: 'Failed to delete team' });
  }
});

module.exports = router;