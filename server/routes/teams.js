const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireTeamAdmin } = require('../middleware/auth');
const Team = require('../models/Team');
const router = express.Router();

// Get user's teams
router.get('/my-teams', authenticateToken, async (req, res) => {
  try {
    const teams = await req.user.getTeamMemberships(req.user.id);
    res.json({ teams });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

// Create team
router.post('/', authenticateToken, [
  body('name').trim().isLength({ min: 1, max: 255 }),
  body('description').optional().trim(),
  body('parentTeamId').optional().isInt()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { name, description, parentTeamId } = req.body;
    
    // If creating sub-team, verify admin access to parent
    if (parentTeamId) {
      const isAdmin = await Team.isAdmin(parentTeamId, req.user.id);
      if (!isAdmin) {
        return res.status(403).json({ error: 'Parent team admin access required' });
      }
    }

    const team = await Team.create({
      name,
      description,
      parent_team_id: parentTeamId,
      created_by: req.user.id
    });

    // Add creator as admin
    await Team.addMember(team.id, req.user.id, 'admin');

    res.status(201).json({ team });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create team' });
  }
});

// Get team details
router.get('/:teamId', authenticateToken, async (req, res) => {
  try {
    const team = await Team.findById(req.params.teamId);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const members = await Team.getMembers(req.params.teamId);
    const subTeams = await Team.getSubTeams(req.params.teamId);

    res.json({ team, members, subTeams });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch team' });
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

module.exports = router;