const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireTeamAdmin } = require('../middleware/auth');
const User = require('../models/User');
const Team = require('../models/Team');
const authentikService = require('../services/authentik');
const UserAttributesService = require('../services/userAttributes');
const TeamMembershipService = require('../services/TeamMembershipService');
const pool = require('../config/database');
const router = express.Router();

// List all users
router.get('/', authenticateToken, async (req, res) => {
  try {
    console.log('Fetching users from Authentik...');
    // Fetch users from Authentik
    const authentikUsers = await authentikService.getUsers();
    console.log('Authentik users:', authentikUsers.length, 'users found');
    
    // Add team information to each user
    const usersWithTeams = await Promise.all(authentikUsers.map(async (user) => {
      try {
        const teamResult = await pool.query(`
          SELECT CASE 
            WHEN t.parent_team_id IS NOT NULL THEN 
              COALESCE(rt.callsign_prefix, rt.name, '') || ' - ' || t.name
            ELSE t.name
          END as team_name
          FROM users u
          JOIN team_memberships tm ON u.id = tm.user_id
          JOIN teams t ON tm.team_id = t.id
          LEFT JOIN teams rt ON rt.id = (
            WITH RECURSIVE root_team AS (
              SELECT id, name, callsign_prefix, parent_team_id FROM teams WHERE id = t.id
              UNION ALL
              SELECT p.id, p.name, p.callsign_prefix, p.parent_team_id 
              FROM teams p JOIN root_team r ON p.id = r.parent_team_id
            )
            SELECT id FROM root_team WHERE parent_team_id IS NULL
          )
          WHERE u.authentik_user_id = $1 AND tm.inherited_from_team_id IS NULL
        `, [user.pk]);
        
        return {
          ...user,
          team_name: teamResult.rows[0]?.team_name || null
        };
      } catch (error) {
        return {
          ...user,
          team_name: null
        };
      }
    }));
    
    res.json({ users: usersWithTeams });
  } catch (error) {
    console.error('Failed to fetch users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get current user profile
router.get('/me', authenticateToken, async (req, res) => {
  try {
    // Get user's direct team membership only (exclude inherited)
    const teamResult = await pool.query(`
      SELECT t.id, t.name, t.parent_team_id,
             CASE 
               WHEN t.parent_team_id IS NOT NULL THEN 
                 COALESCE(rt.callsign_prefix, rt.name, '') || ' - ' || t.name
               ELSE t.name
             END as display_name
      FROM users u
      JOIN team_memberships tm ON u.id = tm.user_id
      JOIN teams t ON tm.team_id = t.id
      LEFT JOIN teams rt ON rt.id = (
        WITH RECURSIVE root_team AS (
          SELECT id, name, callsign_prefix, parent_team_id FROM teams WHERE id = t.id
          UNION ALL
          SELECT p.id, p.name, p.callsign_prefix, p.parent_team_id 
          FROM teams p JOIN root_team r ON p.id = r.parent_team_id
        )
        SELECT id FROM root_team WHERE parent_team_id IS NULL
      )
      WHERE u.authentik_user_id = $1 AND tm.inherited_from_team_id IS NULL
    `, [req.user.id]);
    
    const teams = teamResult.rows;
    const channels = await User.getChannelMemberships(req.user.id);
    
    // Get fresh user data from Authentik
    let freshUserData = req.user;
    try {
      const authentikResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${req.user.id}/`, {
        headers: { Authorization: `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
      });
      if (authentikResponse.ok) {
        const authentikUser = await authentikResponse.json();
        
        // Fetch group names for the user's groups
        const groupNames = [];
        if (authentikUser.groups && authentikUser.groups.length > 0) {
          for (const groupId of authentikUser.groups) {
            try {
              const groupResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${groupId}/`, {
                headers: { Authorization: `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
              });
              if (groupResponse.ok) {
                const group = await groupResponse.json();
                groupNames.push(group.name);
              }
            } catch (groupError) {
              console.error('Failed to fetch group:', groupError);
            }
          }
        }
        
        freshUserData = {
          ...req.user,
          groups: groupNames,
          takCallsign: authentikUser.attributes?.takCallsign,
          takColor: authentikUser.attributes?.takColor,
          takRole: authentikUser.attributes?.takRole
        };
      }
    } catch (error) {
      console.error('Failed to fetch fresh user data:', error);
    }
    
    res.json({
      user: freshUserData,
      teams,
      channels
    });
  } catch (error) {
    console.error('Failed to fetch user profile:', error);
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

// Get available users (not in any team)
router.get('/available', authenticateToken, async (req, res) => {
  try {
    const { search } = req.query;
    let query = `
      SELECT uc.authentik_id as id, uc.email, uc.first_name, uc.last_name
      FROM user_cache uc
      LEFT JOIN users u ON uc.authentik_id::text = u.authentik_user_id::text
      LEFT JOIN team_memberships tm ON u.id = tm.user_id AND tm.inherited_from_team_id IS NULL
      WHERE tm.user_id IS NULL AND uc.is_active = true 
        AND uc.email IS NOT NULL AND uc.email != ''
        AND uc.first_name IS NOT NULL AND uc.first_name != ''
    `;
    const params = [];
    
    if (search) {
      query += ` AND (uc.first_name ILIKE $1 OR uc.last_name ILIKE $1 OR uc.email ILIKE $1)`;
      params.push(`%${search}%`);
    }
    
    query += ` ORDER BY uc.first_name, uc.last_name LIMIT 50`;
    
    const result = await pool.query(query, params);
    res.json({ users: result.rows });
  } catch (error) {
    console.error('Failed to fetch available users:', error);
    res.status(500).json({ error: 'Failed to fetch available users' });
  }
});

// Create new user in Authentik and add to team
router.post('/create-and-add', authenticateToken, [
  body('email').isEmail(),
  body('firstName').trim().isLength({ min: 1, max: 150 }),
  body('lastName').trim().isLength({ min: 1, max: 150 }),
  body('teamId').isInt()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { email, firstName, lastName, teamId } = req.body;
    
    // Check if email already exists in Authentik
    const existingUserResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
    });
    const existingUsers = await existingUserResponse.json();
    
    if (existingUsers.results && existingUsers.results.length > 0) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }
    
    // Create user in Authentik
    const username = email.split('@')[0];
    const createUserResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username,
        email,
        name: `${firstName} ${lastName}`,
        first_name: firstName,
        last_name: lastName,
        is_active: true
      })
    });
    
    if (!createUserResponse.ok) {
      const errorData = await createUserResponse.json();
      return res.status(400).json({ error: 'Failed to create user in Authentik', details: errorData });
    }
    
    const newUser = await createUserResponse.json();
    
    // Ensure user exists in users table
    await pool.query(
      'INSERT INTO users (authentik_user_id, username, email, first_name, last_name, is_active) VALUES ($1, $2, $3, $4, $5, true) ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2, email = $3, first_name = $4, last_name = $5, is_active = true',
      [newUser.pk, username, email, firstName, lastName]
    );
    
    // Get the local user ID
    const localUserResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [newUser.pk]
    );
    
    const localUserId = localUserResult.rows[0].id;
    
    // Remove any existing inherited memberships for this user from this team
    await pool.query(
      'DELETE FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id = $2',
      [localUserId, teamId]
    );
    
    // Add to team
    await pool.query(
      'INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3)',
      [teamId, localUserId, 'member']
    );
    
    // Add to all parent teams with inherited role
    const parentTeamsResult = await pool.query(`
      WITH RECURSIVE parent_teams AS (
        SELECT parent_team_id FROM teams WHERE id = $1 AND parent_team_id IS NOT NULL
        UNION ALL
        SELECT t.parent_team_id 
        FROM teams t 
        JOIN parent_teams pt ON t.id = pt.parent_team_id
        WHERE t.parent_team_id IS NOT NULL
      )
      SELECT parent_team_id as team_id FROM parent_teams
    `, [teamId]);
    
    for (const parentTeam of parentTeamsResult.rows) {
      await pool.query(
        'INSERT INTO team_memberships (team_id, user_id, role, inherited_from_team_id) VALUES ($1, $2, $3, $4)',
        [parentTeam.team_id, localUserId, 'inherited', teamId]
      );
      
      // Add to parent team's primary channel
      const parentChannelResult = await pool.query(
        'SELECT id, authentik_group_id FROM channels WHERE team_id = $1 AND is_primary = true',
        [parentTeam.team_id]
      );
      
      if (parentChannelResult.rows.length > 0) {
        const parentChannel = parentChannelResult.rows[0];
        
        // Add to channel in database
        await pool.query(
          'INSERT INTO channel_memberships (channel_id, user_id, permission) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [parentChannel.id, localUserId, 'read_write']
        );
        
        // Add to Authentik group if group exists
        if (parentChannel.authentik_group_id) {
          try {
            await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${parentChannel.authentik_group_id}/add_user/`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                pk: newUser.pk
              })
            });
          } catch (authentikError) {
            console.error('Failed to add user to parent team Authentik group:', authentikError);
          }
        }
      }
    }
    
    // Update user callsign and color
    const attributes = await UserAttributesService.generateCallsign(localUserId, teamId);
    if (attributes) {
      await UserAttributesService.updateUserAttributes(newUser.pk, attributes);
    }
    
    // Get team's primary channel
    const channelResult = await pool.query(
      'SELECT id, authentik_group_id FROM channels WHERE team_id = $1 AND is_primary = true',
      [teamId]
    );
    
    if (channelResult.rows.length > 0) {
      const channel = channelResult.rows[0];
      
      // Add to channel in database
      await pool.query(
        'INSERT INTO channel_memberships (channel_id, user_id, permission) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [channel.id, localUserId, 'read_write']
      );
      
      // Add to Authentik group if group exists
      if (channel.authentik_group_id) {
        try {
          await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${channel.authentik_group_id}/add_user/`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              pk: newUser.pk
            })
          });
        } catch (authentikError) {
          console.error('Failed to add user to Authentik group:', authentikError);
        }
      }
    }
    
    // Update user cache (handle column names gracefully)
    try {
      await pool.query(
        'INSERT INTO user_cache (authentik_id, username, email, first_name, last_name, is_active, takCallsign, takColor, takRole) VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8) ON CONFLICT (authentik_id) DO UPDATE SET username = $2, email = $3, first_name = $4, last_name = $5, is_active = true, takCallsign = $6, takColor = $7, takRole = $8',
        [newUser.pk, username, email, firstName, lastName, attributes?.callsign, attributes?.color, attributes?.role]
      );
    } catch (columnError) {
      // Fallback for old column names
      await pool.query(
        'INSERT INTO user_cache (authentik_id, username, email, first_name, last_name, is_active, tak_callsign, tak_color, tak_role) VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8) ON CONFLICT (authentik_id) DO UPDATE SET username = $2, email = $3, first_name = $4, last_name = $5, is_active = true, tak_callsign = $6, tak_color = $7, tak_role = $8',
        [newUser.pk, username, email, firstName, lastName, attributes?.callsign, attributes?.color, attributes?.role]
      );
    }
    
    res.status(201).json({ 
      user: {
        id: newUser.pk,
        username,
        email,
        first_name: firstName,
        last_name: lastName
      }
    });
  } catch (error) {
    console.error('Failed to create user:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Add existing user to team
router.post('/add-to-team', authenticateToken, [
  body('userId').notEmpty(),
  body('teamId').isInt()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { userId, teamId } = req.body;
    
    // Get user from user_cache
    const userResult = await pool.query(
      'SELECT authentik_id, username, email, first_name, last_name FROM user_cache WHERE authentik_id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userResult.rows[0];
    
    // Ensure user exists in users table
    await pool.query(
      'INSERT INTO users (authentik_user_id, username, email, first_name, last_name, is_active) VALUES ($1, $2, $3, $4, $5, true) ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2, email = $3, first_name = $4, last_name = $5, is_active = true',
      [user.authentik_id, user.username, user.email, user.first_name, user.last_name]
    );
    
    // Get the local user ID
    const localUserResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [user.authentik_id]
    );
    
    const localUserId = localUserResult.rows[0].id;
    
    // Check if user is already in a team (exclude inherited memberships)
    const existingMembership = await pool.query(
      'SELECT team_id FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL',
      [localUserId]
    );
    
    if (existingMembership.rows.length > 0) {
      return res.status(400).json({ error: 'User is already a member of another team' });
    }
    
    // Get the local user ID for the requesting user
    const requestingUserResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [req.user.id]
    );
    
    const requestingUserId = requestingUserResult.rows[0]?.id;
    
    // Use new service layer for team assignment
    const result = await TeamMembershipService.addUserToTeam(localUserId, teamId, 'member', requestingUserId);
    
    // Update user callsign and color
    const attributes = await UserAttributesService.generateCallsign(localUserId, teamId);
    if (attributes) {
      await UserAttributesService.updateUserAttributes(user.authentik_id, attributes);
      
      // Update user cache (handle column names gracefully)
      try {
        await pool.query(
          'UPDATE user_cache SET takCallsign = $1, takColor = $2, takRole = $3 WHERE authentik_id = $4',
          [attributes.callsign, attributes.color, attributes.role, user.authentik_id]
        );
      } catch (columnError) {
        // Fallback for old column names
        await pool.query(
          'UPDATE user_cache SET tak_callsign = $1, tak_color = $2, tak_role = $3 WHERE authentik_id = $4',
          [attributes.callsign, attributes.color, attributes.role, user.authentik_id]
        );
      }
    }
    
    res.json({ 
      message: 'User added to team successfully',
      operationsQueued: result.groupsQueued
    });
  } catch (error) {
    console.error('Failed to add user to team:', error);
    res.status(500).json({ error: 'Failed to add user to team' });
  }
});

// Remove user from team
router.delete('/remove-from-team/:userId', authenticateToken, [
  body('teamId').isInt()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { userId } = req.params;
    
    // Get user's Authentik ID
    const userResult = await pool.query(
      'SELECT authentik_user_id FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const authentikUserId = userResult.rows[0].authentik_user_id;
    
    // Get the local user ID for the requesting user
    const requestingUserResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [req.user.id]
    );
    
    const requestingUserId = requestingUserResult.rows[0]?.id;
    
    // Use new service layer for team removal
    const result = await TeamMembershipService.removeUserFromTeam(userId, requestingUserId);
    
    // Clear TAK attributes in Authentik
    await UserAttributesService.clearUserAttributes(authentikUserId);
    
    // Clear TAK callsign and color in user cache (handle missing columns gracefully)
    try {
      await pool.query(
        'UPDATE user_cache SET takCallsign = NULL, takColor = NULL WHERE authentik_id = $1',
        [authentikUserId]
      );
    } catch (columnError) {
      // Fallback for old column names
      try {
        await pool.query(
          'UPDATE user_cache SET tak_callsign = NULL, tak_color = NULL WHERE authentik_id = $1',
          [authentikUserId]
        );
      } catch (fallbackError) {
        console.error('Failed to clear TAK attributes:', fallbackError);
      }
    }
    
    res.json({ 
      message: 'User removed from team successfully',
      operationsQueued: result.groupsQueued
    });
  } catch (error) {
    console.error('Failed to remove user from team:', error);
    res.status(500).json({ error: 'Failed to remove user from team' });
  }
});

module.exports = router;