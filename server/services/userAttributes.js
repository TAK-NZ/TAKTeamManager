const pool = require('../config/database');

class UserAttributesService {
  static splitFullName(fullName) {
    const parts = fullName.trim().split(' ');
    if (parts.length === 1) {
      return { firstName: parts[0], lastName: '' };
    }
    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(' ')
    };
  }

  static async generateCallsign(userId, teamId) {
    try {
      // Get user info
      const userResult = await pool.query(
        'SELECT first_name, last_name FROM users WHERE id = $1',
        [userId]
      );
      
      if (userResult.rows.length === 0) return null;
      
      const user = userResult.rows[0];
      
      // Get team hierarchy from root to target team
      const teamResult = await pool.query(`
        WITH RECURSIVE team_path AS (
          -- Start from target team and go up to root
          SELECT id, name, callsign_prefix, parent_team_id,
                 callsign_subteam_depth, callsign_name_format, color,
                 ARRAY[id] as path
          FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id, t.name, t.callsign_prefix, t.parent_team_id,
                 t.callsign_subteam_depth, t.callsign_name_format, t.color,
                 t.id || tp.path
          FROM teams t
          JOIN team_path tp ON t.id = tp.parent_team_id
        ),
        root_team AS (
          SELECT * FROM team_path WHERE parent_team_id IS NULL
        )
        SELECT t.id, t.name, t.callsign_prefix, t.parent_team_id,
               rt.callsign_subteam_depth, rt.callsign_name_format, rt.color,
               array_position(rt.path, t.id) as position
        FROM root_team rt,
             unnest(rt.path) WITH ORDINALITY AS u(team_id, pos)
        JOIN teams t ON t.id = u.team_id
        ORDER BY u.pos
      `, [teamId]);
      
      if (teamResult.rows.length === 0) return null;
      
      const rootTeam = teamResult.rows[0];
      const teamPath = teamResult.rows;
      
      // Build callsign parts
      const parts = [];
      
      // Add team prefixes based on depth setting
      const depth = rootTeam.callsign_subteam_depth || 1;
      for (let i = 0; i < Math.min(teamPath.length, depth + 1); i++) {
        if (teamPath[i].callsign_prefix) {
          parts.push(teamPath[i].callsign_prefix);
        }
      }
      
      // Format name based on root team setting (trim whitespace)
      let firstName = user.first_name.trim();
      let lastName = (user.last_name || '').trim();
      
      // If last_name is empty, split the first_name
      if (!lastName && firstName.includes(' ')) {
        const splitName = this.splitFullName(firstName);
        firstName = splitName.firstName;
        lastName = splitName.lastName;
      }
      
      let nameFormat;
      switch (rootTeam.callsign_name_format) {
        case 'first_initial_last':
          if (lastName) {
            nameFormat = `${firstName.charAt(0)} ${lastName}`;
          } else {
            nameFormat = firstName;
          }
          break;
        case 'first_last_initial':
          if (lastName) {
            nameFormat = `${firstName} ${lastName.charAt(0)}`;
          } else {
            nameFormat = firstName;
          }
          break;
        default:
          nameFormat = `${firstName} ${lastName}`.trim();
      }
      
      parts.push(nameFormat);
      
      return {
        callsign: parts.join('-').trim(),
        color: rootTeam.color,
        role: 'Team Member'
      };
    } catch (error) {
      console.error('Error generating callsign:', error);
      return null;
    }
  }
  
  static async updateUserAttributes(authentikUserId, attributes) {
    try {
      const payload = {
        attributes: {
          takCallsign: attributes.callsign,
          takColor: attributes.color,
          takRole: attributes.role
        }
      };
      
      console.log('Updating user attributes:', authentikUserId, payload);
      
      const response = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        throw new Error(`Failed to update user attributes: ${response.statusText}`);
      }
      
      return true;
    } catch (error) {
      console.error('Error updating user attributes in Authentik:', error);
      return false;
    }
  }
  
  static async clearUserAttributes(authentikUserId) {
    try {
      // Get current user attributes
      const getUserResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`, {
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`
        }
      });
      
      if (!getUserResponse.ok) {
        throw new Error(`Failed to get user: ${getUserResponse.statusText}`);
      }
      
      const user = await getUserResponse.json();
      const currentAttributes = user.attributes || {};
      
      // Remove takCallsign and takColor, keep everything else including takRole
      delete currentAttributes.takCallsign;
      delete currentAttributes.takColor;
      
      const response = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          attributes: currentAttributes
        })
      });
      
      if (!response.ok) {
        throw new Error(`Failed to clear user attributes: ${response.statusText}`);
      }
      
      return true;
    } catch (error) {
      console.error('Error clearing user attributes in Authentik:', error);
      return false;
    }
  }
  
  static async updateTeamUserAttributes(teamId) {
    try {
      // Get all users in team and sub-teams
      const usersResult = await pool.query(`
        WITH RECURSIVE team_tree AS (
          SELECT id FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id FROM teams t
          JOIN team_tree tt ON t.parent_team_id = tt.id
        )
        SELECT u.id, u.authentik_user_id, tm.team_id
        FROM users u
        JOIN team_memberships tm ON u.id = tm.user_id
        JOIN team_tree tt ON tm.team_id = tt.id
      `, [teamId]);
      
      // Update each user's attributes
      for (const user of usersResult.rows) {
        const attributes = await this.generateCallsign(user.id, user.team_id);
        if (attributes) {
          await this.updateUserAttributes(user.authentik_user_id, attributes);
          
          // Update user cache (handle column names gracefully)
          try {
            await pool.query(
              'UPDATE user_cache SET takCallsign = $1, takColor = $2, takRole = $3 WHERE authentik_id = $4',
              [attributes.callsign, attributes.color, attributes.role, user.authentik_user_id]
            );
          } catch (columnError) {
            // Fallback for old column names
            await pool.query(
              'UPDATE user_cache SET tak_callsign = $1, tak_color = $2, tak_role = $3 WHERE authentik_id = $4',
              [attributes.callsign, attributes.color, attributes.role, user.authentik_user_id]
            );
          }
        }
      }
      
      return true;
    } catch (error) {
      console.error('Error updating team user attributes:', error);
      return false;
    }
  }
}

module.exports = UserAttributesService;