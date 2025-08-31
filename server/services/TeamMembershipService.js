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
      
      // Calculate required groups
      const requiredGroups = await GroupMembershipCalculator.calculateUserGroups(userId);
      
      // Queue sync operations for each group
      for (const group of requiredGroups) {
        await EventPublisher.publishOperation('add_user_to_group', {
          target_user_id: userId,
          target_group_id: group.name,
          permission: group.permission
        }, createdBy);
      }
      
      // Also ensure user is assigned to all global channels
      await EventPublisher.publishOperation('assign_user_to_global_channels', {
        target_user_id: userId
      }, createdBy);
      
      await client.query('COMMIT');
      return { success: true, groupsQueued: requiredGroups.length };
      
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
      
      // Get current groups before removal
      const currentGroups = await GroupMembershipCalculator.calculateUserGroups(userId);
      
      // Remove from team
      await client.query('DELETE FROM team_memberships WHERE user_id = $1', [userId]);
      
      // Queue removal operations for all current groups
      for (const group of currentGroups) {
        await EventPublisher.publishOperation('remove_user_from_group', {
          target_user_id: userId,
          target_group_id: group.name
        }, createdBy);
      }
      
      await client.query('COMMIT');
      return { success: true, groupsQueued: currentGroups.length };
      
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