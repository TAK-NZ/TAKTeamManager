const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireTeamAdmin } = require('../middleware/auth');
const pool = require('../config/database');
const authentikService = require('../services/authentik');
const router = express.Router();

// Get channels for team
router.get('/team/:teamId', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM channels WHERE team_id = $1 ORDER BY is_primary DESC, name',
      [req.params.teamId]
    );
    res.json({ channels: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// Create channel
router.post('/', authenticateToken, [
  body('name').trim().isLength({ min: 1, max: 255 }),
  body('displayName').trim().isLength({ min: 1, max: 255 }),
  body('description').optional().trim(),
  body('teamId').isInt(),
  body('isPrimary').optional().isBoolean()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { name, displayName, description, teamId, isPrimary = false } = req.body;
    
    // Verify team admin access
    const Team = require('../models/Team');
    const isAdmin = await Team.isAdmin(teamId, req.user.id);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Team admin access required' });
    }

    // Create main group in Authentik
    const groupName = `tak_${name}`;
    const mainGroup = await authentikService.createGroup({
      name: groupName,
      displayName,
      description: `${description} (Read-only broadcast channel)`
    });

    // Create READ group in Authentik
    const readGroupName = `${groupName}_READ`;
    const readGroup = await authentikService.createGroup({
      name: readGroupName,
      displayName: `${displayName} - Read`,
      description: `Read access for ${displayName}`
    });

    // Create local channel record
    const result = await pool.query(`
      INSERT INTO channels (name, display_name, description, team_id, authentik_group_id, authentik_read_group_id, is_primary)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [name, displayName, description, teamId, mainGroup.pk, readGroup.pk, isPrimary]);

    res.status(201).json({ channel: result.rows[0] });
  } catch (error) {
    console.error('Channel creation failed:', error);
    res.status(500).json({ error: 'Failed to create channel' });
  }
});

// Add user to channel
router.post('/:channelId/members', authenticateToken, requireTeamAdmin, [
  body('userId').isInt()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { channelId } = req.params;
    const { userId } = req.body;

    // Get channel info
    const channelResult = await pool.query('SELECT * FROM channels WHERE id = $1', [channelId]);
    const channel = channelResult.rows[0];
    
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Get user info
    const User = require('../models/User');
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Add to Authentik groups
    await authentikService.addUserToGroup(channel.authentik_group_id, user.authentik_user_id);
    await authentikService.addUserToGroup(channel.authentik_read_group_id, user.authentik_user_id);

    // Add to local channel membership
    await pool.query(
      'INSERT INTO channel_memberships (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [channelId, userId]
    );

    res.json({ message: 'User added to channel successfully' });
  } catch (error) {
    console.error('Failed to add user to channel:', error);
    res.status(500).json({ error: 'Failed to add user to channel' });
  }
});

// Remove user from channel
router.delete('/:channelId/members/:userId', authenticateToken, requireTeamAdmin, async (req, res) => {
  try {
    const { channelId, userId } = req.params;

    // Get channel and user info
    const channelResult = await pool.query('SELECT * FROM channels WHERE id = $1', [channelId]);
    const channel = channelResult.rows[0];
    
    const User = require('../models/User');
    const user = await User.findById(userId);

    if (!channel || !user) {
      return res.status(404).json({ error: 'Channel or user not found' });
    }

    // Remove from Authentik groups
    await authentikService.removeUserFromGroup(channel.authentik_group_id, user.authentik_user_id);
    await authentikService.removeUserFromGroup(channel.authentik_read_group_id, user.authentik_user_id);

    // Remove from local channel membership
    await pool.query('DELETE FROM channel_memberships WHERE channel_id = $1 AND user_id = $2', [channelId, userId]);

    res.json({ message: 'User removed from channel successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove user from channel' });
  }
});

// Get channel members
router.get('/:channelId/members', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.username, u.email, u.first_name, u.last_name
      FROM users u
      JOIN channel_memberships cm ON u.id = cm.user_id
      WHERE cm.channel_id = $1
      ORDER BY u.first_name, u.last_name
    `, [req.params.channelId]);

    res.json({ members: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch channel members' });
  }
});

module.exports = router;