const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const AccessRequest = require('../models/AccessRequest');
const User = require('../models/User');
const Team = require('../models/Team');
const authentikService = require('../services/authentik');
const pool = require('../config/database');
const router = express.Router();

// Public route - request team access (unauthenticated)
router.post('/team-access', [
  body('email').isEmail().normalizeEmail(),
  body('firstName').trim().isLength({ min: 1 }),
  body('lastName').trim().isLength({ min: 1 }),
  body('teamId').isInt(),
  body('teamName').optional().trim(),
  body('reason').trim().isLength({ min: 10, max: 500 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, firstName, lastName, teamId, teamName, reason } = req.body;
  
  try {
    // Verify team exists and is joinable
    const team = await Team.findById(teamId);
    if (!team || !team.can_join || team.visibility !== 'public') {
      return res.status(400).json({ error: 'Team is not available for joining' });
    }

    const requestData = {
      email,
      firstName,
      lastName,
      teamName: team.name,
      reason
    };
    
    const request = await AccessRequest.create(requestData);
    res.json({ 
      message: 'Access request submitted successfully',
      requestId: request.id
    });
  } catch (error) {
    console.error('Failed to submit request:', error);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// Get pending requests for team admin
router.get('/pending', authenticateToken, async (req, res) => {
  try {
    const userTeams = await User.getTeamMemberships(req.user.id);
    const adminTeams = userTeams.filter(t => t.role === 'admin');
    
    if (adminTeams.length === 0) {
      return res.json({ requests: [] });
    }

    const teamNames = adminTeams.map(t => t.name);
    const requests = [];
    
    for (const teamName of teamNames) {
      const teamRequests = await AccessRequest.getRequestsByTeam(teamName);
      requests.push(...teamRequests.filter(r => r.status === 'pending'));
    }

    res.json({ requests });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Approve/deny request
router.post('/:requestId/decision', authenticateToken, [
  body('decision').isIn(['approve', 'deny']),
  body('reason').optional().trim()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { requestId } = req.params;
    const { decision, reason } = req.body;
    
    const request = await AccessRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (decision === 'approve') {
      // Create user in Authentik
      const authentikUser = await authentikService.createUser({
        username: request.email.split('@')[0],
        name: `${request.first_name} ${request.last_name}`,
        email: request.email
      });

      // Create local user
      const localUser = await User.create({
        authentik_user_id: authentikUser.pk,
        username: authentikUser.username,
        email: request.email,
        first_name: request.first_name,
        last_name: request.last_name
      });

      // Find team and add user
      const team = await pool.query('SELECT id FROM teams WHERE name = $1', [request.team_name]);
      if (team.rows[0]) {
        await Team.addMember(team.rows[0].id, localUser.id, 'member');
      }
    }

    await AccessRequest.updateStatus(requestId, decision, req.user.id, reason);
    res.json({ message: `Request ${decision}d successfully` });
  } catch (error) {
    console.error('Decision processing failed:', error);
    res.status(500).json({ error: 'Failed to process decision' });
  }
});

module.exports = router;