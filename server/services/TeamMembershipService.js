const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
const GroupMembershipCalculator = require('./GroupMembershipCalculator');

class TeamMembershipService {
  static async addUserToTeam(userId, teamId, role = 'member', createdBy = null) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Remove user from current team if any
      await client.query('DELETE FROM team_memberships WHERE user_id = $1', [userId]);
      
      // Add to new team
      await client.query(
        'INSERT INTO team_memberships (user_id, team_id, role) VALUES ($1, $2, $3)',
        [userId, teamId, role]
      );
      
      // Get team hierarchy and their channels
      const teamChannels = await client.query(`
        WITH RECURSIVE team_hierarchy AS (
          SELECT id, parent_team_id FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id, t.parent_team_id 
          FROM teams t 
          JOIN team_hierarchy th ON t.id = th.parent_team_id
        )
        SELECT c.authentik_group_id 
        FROM team_hierarchy th
        JOIN channels c ON th.id = c.team_id AND c.is_primary = true
        WHERE c.authentik_group_id IS NOT NULL
      `, [teamId]);
      
      // Queue operations to add user to team channels
      for (const channel of teamChannels.rows) {
        await EventPublisher.publishOperation('add_user_to_group', {
          target_user_id: userId,
          target_group_id: channel.authentik_group_id
        }, createdBy);
      }
      
      // Also ensure user is assigned to all global channels
      await EventPublisher.publishOperation('assign_user_to_global_channels', {
        target_user_id: userId
      }, createdBy);
      
      await client.query('COMMIT');
      return { success: true, groupsQueued: teamChannels.rows.length };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async removeUserFromTeam(userId, createdBy = null) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get current team channels before removal
      const currentChannels = await client.query(`
        SELECT c.authentik_group_id 
        FROM team_memberships tm
        JOIN channels c ON tm.team_id = c.team_id AND c.is_primary = true
        WHERE tm.user_id = $1 AND c.authentik_group_id IS NOT NULL
      `, [userId]);
      
      // Remove from team and channel memberships
      await client.query('DELETE FROM team_memberships WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM channel_memberships WHERE user_id = $1', [userId]);
      
      // Check if user has any remaining team memberships
      const remainingTeams = await client.query(
        'SELECT COUNT(*) as count FROM team_memberships WHERE user_id = $1',
        [userId]
      );
      
      // Queue removal operations for team channels
      for (const channel of currentChannels.rows) {
        await EventPublisher.publishOperation('remove_user_from_group', {
          target_user_id: userId,
          target_group_id: channel.authentik_group_id
        }, createdBy);
      }
      
      // If user has no teams left, remove from all global channels too
      if (remainingTeams.rows[0].count === 0) {
        // Get all global channel group IDs
        const globalChannels = await client.query(`
          SELECT read_group_id, write_group_id FROM bch_channels WHERE is_active = true AND read_group_id IS NOT NULL
          UNION ALL
          SELECT group_id as read_group_id, NULL as write_group_id FROM region_channels WHERE is_active = true AND group_id IS NOT NULL
        `);
        
        // Queue removal from global channels
        for (const channel of globalChannels.rows) {
          if (channel.read_group_id) {
            await EventPublisher.publishOperation('remove_user_from_group', {
              target_user_id: userId,
              target_group_id: channel.read_group_id
            }, createdBy);
          }
          if (channel.write_group_id) {
            await EventPublisher.publishOperation('remove_user_from_group', {
              target_user_id: userId,
              target_group_id: channel.write_group_id
            }, createdBy);
          }
        }
      }
      
      await client.query('COMMIT');
      return { success: true, groupsQueued: currentChannels.rows.length };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async bulkAddUsersToTeam(userIds, teamId, role = 'member', createdBy = null) {
    const bulkOpId = await EventPublisher.publishBulkOperation(
      `Add ${userIds.length} users to team ${teamId}`,
      userIds.length,
      createdBy
    );
    
    // Queue individual operations
    for (const userId of userIds) {
      await EventPublisher.publishOperation('bulk_add_user_to_team', {
        target_user_id: userId,
        team_id: teamId,
        role: role,
        bulk_operation_id: bulkOpId
      }, createdBy);
    }
    
    return { bulkOperationId: bulkOpId, usersQueued: userIds.length };
  }
}

module.exports = TeamMembershipService;