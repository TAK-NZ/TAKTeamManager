const pool = require('../config/database');

class Channel {
  static async create(channelData) {
    const { name, display_name, description, team_id, authentik_group_id, authentik_read_group_id, authentik_write_group_id, is_primary, channel_type, custom_suffix } = channelData;
    const result = await pool.query(
      'INSERT INTO channels (name, display_name, description, team_id, authentik_group_id, authentik_read_group_id, authentik_write_group_id, is_primary, channel_type, custom_suffix) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
      [name, display_name, description, team_id, authentik_group_id, authentik_read_group_id, authentik_write_group_id, is_primary, channel_type, custom_suffix]
    );
    return result.rows[0];
  }

  static async findById(id) {
    const result = await pool.query('SELECT * FROM channels WHERE id = $1', [id]);
    return result.rows[0];
  }

  static async getByTeam(teamId) {
    const result = await pool.query('SELECT * FROM channels WHERE team_id = $1 ORDER BY is_primary DESC, name', [teamId]);
    return result.rows;
  }

  static async addMember(channelId, userId, permission = 'read_write') {
    const result = await pool.query(
      'INSERT INTO channel_memberships (channel_id, user_id, permission) VALUES ($1, $2, $3) ON CONFLICT (user_id, channel_id) DO UPDATE SET permission = $3 RETURNING *',
      [channelId, userId, permission]
    );
    return result.rows[0];
  }

  static async getMembers(channelId) {
    const result = await pool.query(`
      SELECT u.id, u.username, u.email, u.first_name, u.last_name, cm.permission
      FROM users u
      JOIN channel_memberships cm ON u.id = cm.user_id
      WHERE cm.channel_id = $1
      ORDER BY u.first_name, u.last_name
    `, [channelId]);
    return result.rows;
  }
  
  static async getChannelCount(teamId) {
    const result = await pool.query('SELECT COUNT(*) as count FROM channels WHERE team_id = $1', [teamId]);
    return parseInt(result.rows[0].count);
  }
  
  static async createCustomChannel(teamId, customSuffix, memberPermissions) {
    try {
      // Get team with root team info for naming
      const teamResult = await pool.query(`
        WITH RECURSIVE root_team AS (
          SELECT id, name, callsign_prefix, parent_team_id FROM teams WHERE id = $1
          UNION ALL
          SELECT p.id, p.name, p.callsign_prefix, p.parent_team_id 
          FROM teams p JOIN root_team r ON p.id = r.parent_team_id
        )
        SELECT t.id, t.name, t.parent_team_id,
               rt.callsign_prefix as root_prefix
        FROM teams t
        LEFT JOIN (SELECT name, callsign_prefix FROM root_team WHERE parent_team_id IS NULL) rt ON true
        WHERE t.id = $1
      `, [teamId]);
      
      if (!teamResult.rows[0]) throw new Error('Team not found');
      
      const team = teamResult.rows[0];
      
      // Generate channel name
      const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
      let baseChannelName;
      if (team.parent_team_id) {
        baseChannelName = `Teams${separator}${team.root_prefix}${separator}${team.name}`;
      } else {
        baseChannelName = `Teams${separator}${team.root_prefix || team.name}`;
      }
      
      const fullChannelName = `${baseChannelName} - ${customSuffix}`;
      const description = `Custom channel: ${fullChannelName}`;
      const channelDbName = fullChannelName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      
      // Create Authentik groups
      const authentikGroupName = `tak_${fullChannelName}`;
      
      const groupPromises = [
        // Read/Write group (main group)
        fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: authentikGroupName,
            attributes: {
              CN: fullChannelName,
              description: description
            }
          })
        }),
        // Read-only group
        fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: `${authentikGroupName}_READ`,
            attributes: {
              CN: `${fullChannelName} (Read Only)`,
              description: `${description} - Read Only`
            }
          })
        }),
        // Write-only group
        fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: `${authentikGroupName}_WRITE`,
            attributes: {
              CN: `${fullChannelName} (Write Only)`,
              description: `${description} - Write Only`
            }
          })
        })
      ];
      
      const [rwGroupResponse, readGroupResponse, writeGroupResponse] = await Promise.all(groupPromises);
      const [rwGroup, readGroup, writeGroup] = await Promise.all([
        rwGroupResponse.json(),
        readGroupResponse.json(),
        writeGroupResponse.json()
      ]);
      
      // Create channel in database
      const channelResult = await pool.query(
        'INSERT INTO channels (name, display_name, description, team_id, authentik_group_id, authentik_read_group_id, authentik_write_group_id, is_primary, channel_type, custom_suffix) VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9) RETURNING *',
        [channelDbName, fullChannelName, description, teamId, rwGroup.pk, readGroup.pk, writeGroup.pk, 'custom', customSuffix]
      );
      
      const channel = channelResult.rows[0];
      
      // Add members with permissions
      for (const memberPerm of memberPermissions) {
        await this.addMember(channel.id, memberPerm.userId, memberPerm.permission);
      }
      
      return channel;
    } catch (error) {
      console.error('Error creating custom channel:', error);
      throw error;
    }
  }
}

module.exports = Channel;