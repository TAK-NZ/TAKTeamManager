const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const AccessRequest = require('../models/AccessRequest');
const User = require('../models/User');
const Team = require('../models/Team');
const RequestApprovalService = require('../services/RequestApprovalService');
const pool = require('../config/database');
const router = express.Router();

const requestService = new RequestApprovalService();

// Public route - request team access (unauthenticated)
router.post('/team-access', [
  body('email').isEmail().normalizeEmail(),
  body('firstName').trim().isLength({ min: 1 }),
  body('lastName').trim().isLength({ min: 1 }),
  body('teamId').isInt(),
  body('reason').trim().isLength({ min: 10, max: 500 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, firstName, lastName, teamId, reason } = req.body;
  
  try {
    // Verify team exists and is joinable
    const team = await Team.findById(teamId);
    if (!team || !team.can_join || team.visibility !== 'public') {
      return res.status(400).json({ error: 'Team is not available for joining' });
    }

    const requestData = {
      request_type: 'new_account',
      requester_email: email,
      requester_first_name: firstName,
      requester_last_name: lastName,
      target_team_id: teamId,
      justification: reason
    };
    
    const result = await requestService.createAccessRequest(requestData);
    res.json({ 
      message: 'Access request submitted. Please check your email to verify your request.',
      requestId: result.requestId
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

    const teamIds = adminTeams.map(t => t.id);
    const placeholders = teamIds.map((_, i) => `$${i + 1}`).join(',');
    
    const result = await pool.query(`
      SELECT ar.*, t.name as team_name
      FROM access_requests ar
      LEFT JOIN teams t ON ar.target_team_id = t.id
      WHERE ar.target_team_id IN (${placeholders}) 
        AND ar.status = 'pending' 
        AND ar.email_verified = true
      ORDER BY ar.created_at ASC
    `, teamIds);

    res.json({ requests: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Approve request
router.post('/:requestId/approve', authenticateToken, [
  body('additionalDetails').optional().trim()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { requestId } = req.params;
    const { additionalDetails } = req.body;
    
    await requestService.approveRequest(requestId, req.user.id, additionalDetails);
    res.json({ message: 'Request approved successfully' });
  } catch (error) {
    console.error('Approval failed:', error);
    res.status(500).json({ error: 'Failed to approve request' });
  }
});

// Deny request
router.post('/:requestId/deny', authenticateToken, [
  body('denialReason').trim().isLength({ min: 1 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { requestId } = req.params;
    const { denialReason } = req.body;
    
    await requestService.denyRequest(requestId, req.user.id, denialReason);
    res.json({ message: 'Request denied successfully' });
  } catch (error) {
    console.error('Denial failed:', error);
    res.status(500).json({ error: 'Failed to deny request' });
  }
});

// Verify email token
router.get('/verify/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const request = await requestService.verifyEmail(token);
    
    res.json({ 
      message: 'Email verified successfully. Your request has been forwarded to the team administrator.',
      requestId: request.id
    });
  } catch (error) {
    console.error('Verification failed:', error);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;