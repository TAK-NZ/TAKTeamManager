const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireTeamAdmin } = require('../middleware/auth');
const User = require('../models/User');
const Team = require('../models/Team');
const authentikService = require('../services/authentik');
const router = express.Router();

// List all users
router.get('/', authenticateToken, async (req, res) => {
  try {
    console.log('Fetching users from Authentik...');
    // Fetch users from Authentik
    const authentikUsers = await authentikService.getUsers();
    console.log('Authentik users:', authentikUsers.length, 'users found');
    
    res.json({ users: authentikUsers });
  } catch (error) {
    console.error('Failed to fetch users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get current user profile
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const teams = await User.getTeamMemberships(req.user.id);
    const channels = await User.getChannelMemberships(req.user.id);
    
    res.json({
      user: req.user,
      teams,
      channels
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Create new user in Authentik and local DB
router.post('/', authenticateToken, [
  body('username').trim().isLength({ min: 1, max: 150 }),
  body('email').isEmail().normalizeEmail(),
  body('firstName').trim().isLength({ min: 1, max: 150 }),
  body('lastName').trim().isLength({ min: 1, max: 150 }),
  body('password').isLength({ min: 8 }),
  body('teamId').isInt()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { username, email, firstName, lastName, password, teamId } = req.body;
    
    // Verify admin access to target team
    const isAdmin = await Team.isAdmin(teamId, req.user.id);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Team admin access required' });
    }

    // Create user in Authentik
    const authentikUser = await authentikService.createUser({
      username,
      name: `${firstName} ${lastName}`,
      email
    });

    // Set password
    await authentikService.setUserPassword(authentikUser.pk, password);

    // Create local user record
    const localUser = await User.create({
      authentik_user_id: authentikUser.pk,
      username,
      email,
      first_name: firstName,
      last_name: lastName
    });

    // Add to team
    await Team.addMember(teamId, localUser.id, 'member');

    res.status(201).json({ 
      user: localUser,
      message: 'User created successfully'
    });
  } catch (error) {
    console.error('User creation failed:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Move user to holding pen (remove from all teams)
router.post('/:userId/holding-pen', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Get user's current teams
    const userTeams = await User.getTeamMemberships(userId);
    
    // Verify admin access to at least one of user's teams
    let hasAdminAccess = false;
    for (const team of userTeams) {
      if (await Team.isAdmin(team.id, req.user.id)) {
        hasAdminAccess = true;
        break;
      }
    }
    
    if (!hasAdminAccess) {
      return res.status(403).json({ error: 'Admin access required for user teams' });
    }

    // Remove from all teams and channels
    await pool.query('DELETE FROM team_memberships WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM channel_memberships WHERE user_id = $1', [userId]);

    res.json({ message: 'User moved to holding pen' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to move user' });
  }
});

// Search users
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Search query too short' });
    }

    const result = await pool.query(`
      SELECT id, username, email, first_name, last_name 
      FROM users 
      WHERE (username ILIKE $1 OR email ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1)
      AND is_active = true
      LIMIT 20
    `, [`%${q}%`]);

    res.json({ users: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;