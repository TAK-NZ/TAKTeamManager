const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
const crypto = require('crypto');

class GlobalChannelService {
  async createBchChannel(channelData, createdBy) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Generate service account credentials
      const serviceAccountUsername = `etl-${channelData.name.toLowerCase().replace(/\s+/g, '-')}`;
      const serviceAccountPassword = crypto.randomBytes(16).toString('hex');
      
      // Create BCH channel record
      const result = await client.query(`
        INSERT INTO bch_channels (
          name, description, service_account_username, 
          service_account_password, created_by
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `, [
        channelData.name,
        channelData.description,
        serviceAccountUsername,
        serviceAccountPassword, // In production, this should be encrypted
        createdBy
      ]);
      
      const channelId = result.rows[0].id;
      
      // Queue operations to create Authentik groups and service account
      await EventPublisher.publishOperation('create_bch_channel_groups', {
        bch_channel_id: channelId,
        channel_name: channelData.name,
        service_account_username: serviceAccountUsername,
        service_account_password: serviceAccountPassword
      }, createdBy);
      
      // Add group membership rules for all users
      await client.query(`
        INSERT INTO group_membership_rules (
          rule_name, rule_type, source_type, source_id, 
          target_group_pattern, permission_type, priority
        ) VALUES 
        ($1, 'bch_channels', 'bch_channel', $2, $3, 'read', 50),
        ($4, 'bch_channels', 'bch_channel', $2, $5, 'write', 51)
      `, [
        `BCH ${channelData.name} Read Access`,
        channelId,
        `bch_${channelData.name.toLowerCase().replace(/\s+/g, '_')}_read`,
        `BCH ${channelData.name} Write Access`,
        `bch_${channelData.name.toLowerCase().replace(/\s+/g, '_')}_write`
      ]);
      
      await client.query('COMMIT');
      return { channelId, serviceAccountUsername };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createRegionChannel(channelData, createdBy) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Create region channel record
      const result = await client.query(`
        INSERT INTO region_channels (
          name, description, created_by
        ) VALUES ($1, $2, $3)
        RETURNING id
      `, [
        channelData.name,
        channelData.description,
        createdBy
      ]);
      
      const channelId = result.rows[0].id;
      
      // Queue operation to create Authentik group
      await EventPublisher.publishOperation('create_region_channel_group', {
        region_channel_id: channelId,
        channel_name: channelData.name
      }, createdBy);
      
      // Add group membership rule for all users
      await client.query(`
        INSERT INTO group_membership_rules (
          rule_name, rule_type, source_type, source_id, 
          target_group_pattern, permission_type, priority
        ) VALUES ($1, 'region_channels', 'region_channel', $2, $3, 'read_write', 60)
      `, [
        `Region ${channelData.name} Access`,
        channelId,
        `region_${channelData.name.toLowerCase().replace(/\s+/g, '_')}`
      ]);
      
      await client.query('COMMIT');
      return { channelId };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async assignAllUsersToGlobalChannels() {
    try {
      // Get all active users
      const usersResult = await pool.query('SELECT id FROM users WHERE is_active = true');
      const userIds = usersResult.rows.map(row => row.id);
      
      if (userIds.length === 0) return { usersProcessed: 0 };
      
      // Queue bulk operation for global channel assignment
      const bulkOpId = await EventPublisher.publishBulkOperation(
        `Assign ${userIds.length} users to global channels`,
        userIds.length,
        null // System operation
      );
      
      // Queue individual operations for each user
      for (const userId of userIds) {
        await EventPublisher.publishOperation('assign_user_to_global_channels', {
          target_user_id: userId,
          bulk_operation_id: bulkOpId
        });
      }
      
      return { usersProcessed: userIds.length, bulkOperationId: bulkOpId };
      
    } catch (error) {
      throw error;
    }
  }

  async getBchChannels() {
    const result = await pool.query(`
      SELECT bc.*, u.first_name, u.last_name
      FROM bch_channels bc
      LEFT JOIN users u ON bc.created_by = u.id
      WHERE bc.is_active = true
      ORDER BY bc.name
    `);
    
    return result.rows.map(row => ({
      ...row,
      created_by_name: row.first_name ? `${row.first_name} ${row.last_name}` : 'System'
    }));
  }

  async getRegionChannels() {
    const result = await pool.query(`
      SELECT rc.*, u.first_name, u.last_name
      FROM region_channels rc
      LEFT JOIN users u ON rc.created_by = u.id
      WHERE rc.is_active = true
      ORDER BY rc.name
    `);
    
    return result.rows.map(row => ({
      ...row,
      created_by_name: row.first_name ? `${row.first_name} ${row.last_name}` : 'System'
    }));
  }

  async getBchChannelCredentials(channelId, requestingUserId) {
    // Only global managers can access service account credentials
    const userResult = await pool.query(
      'SELECT is_global_manager FROM users WHERE id = $1',
      [requestingUserId]
    );
    
    if (!userResult.rows[0]?.is_global_manager) {
      throw new Error('Access denied: Global manager privileges required');
    }
    
    const result = await pool.query(`
      SELECT service_account_username, service_account_password
      FROM bch_channels 
      WHERE id = $1 AND is_active = true
    `, [channelId]);
    
    if (result.rows.length === 0) {
      throw new Error('BCH channel not found');
    }
    
    return result.rows[0];
  }

  async updateBchChannel(channelId, channelData, updatedBy) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      await client.query(`
        UPDATE bch_channels 
        SET name = $1, description = $2
        WHERE id = $3
      `, [channelData.name, channelData.description, channelId]);
      
      // Queue operation to update Authentik group
      await EventPublisher.publishOperation('update_bch_channel_group', {
        bch_channel_id: channelId,
        channel_name: channelData.name,
        description: channelData.description
      }, updatedBy);
      
      await client.query('COMMIT');
      return { success: true };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateRegionChannel(channelId, channelData, updatedBy) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      await client.query(`
        UPDATE region_channels 
        SET name = $1, description = $2
        WHERE id = $3
      `, [channelData.name, channelData.description, channelId]);
      
      // Queue operation to update Authentik group
      await EventPublisher.publishOperation('update_region_channel_group', {
        region_channel_id: channelId,
        channel_name: channelData.name,
        description: channelData.description
      }, updatedBy);
      
      await client.query('COMMIT');
      return { success: true };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteGlobalChannel(channelId, channelType, deletedBy) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const table = channelType === 'bch' ? 'bch_channels' : 'region_channels';
      
      // Delete channel
      await client.query(`DELETE FROM ${table} WHERE id = $1`, [channelId]);
      
      // Delete related group membership rules
      await client.query(`
        DELETE FROM group_membership_rules 
        WHERE source_type = $1 AND source_id = $2
      `, [channelType === 'bch' ? 'bch_channel' : 'region_channel', channelId]);
      
      // Queue operation to delete Authentik groups
      await EventPublisher.publishOperation('delete_global_channel', {
        channel_id: channelId,
        channel_type: channelType
      }, deletedBy);
      
      await client.query('COMMIT');
      return { success: true };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deactivateGlobalChannel(channelId, channelType, deactivatedBy) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const table = channelType === 'bch' ? 'bch_channels' : 'region_channels';
      
      // Deactivate channel
      await client.query(`
        UPDATE ${table} 
        SET is_active = false 
        WHERE id = $1
      `, [channelId]);
      
      // Deactivate related group membership rules
      await client.query(`
        UPDATE group_membership_rules 
        SET is_active = false 
        WHERE source_type = $1 AND source_id = $2
      `, [channelType === 'bch' ? 'bch_channel' : 'region_channel', channelId]);
      
      // Queue operation to remove all users from channel groups
      await EventPublisher.publishOperation('deactivate_global_channel', {
        channel_id: channelId,
        channel_type: channelType
      }, deactivatedBy);
      
      await client.query('COMMIT');
      return { success: true };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = GlobalChannelService;