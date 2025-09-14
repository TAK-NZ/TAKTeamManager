const { Pool } = require('pg');
const authentikService = require('../services/authentik');
const TeamMembershipService = require('../services/TeamMembershipService');

class SyncWorker {
  constructor() {
    this.isRunning = false;
    this.pollInterval = 5000; // 5 seconds
    this.maxRetries = 3;
    this.retryDelay = 1000; // 1 second
    
    // Create dedicated connection pool for worker
    this.pool = new Pool({
      host: process.env.DB_HOST || 'postgres',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'tak_team_manager',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      max: 5, // Maximum pool size
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    
    // Handle pool errors
    this.pool.on('error', (err) => {
      console.error('Database pool error:', err.message);
    });
  }

  async start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    console.log('Sync worker started');
    
    while (this.isRunning) {
      try {
        await this.processNextOperation();
        await this.sleep(this.pollInterval);
      } catch (error) {
        console.error('Worker loop error:', error.message);
        
        // If it's a database connection error, wait longer before retrying
        if (error.message.includes('connection') || error.message.includes('database')) {
          console.log('Database connection issue detected, waiting 30 seconds before retry');
          await this.sleep(30000); // 30 seconds
        } else {
          await this.sleep(this.pollInterval);
        }
      }
    }
  }

  async stop() {
    this.isRunning = false;
    console.log('Sync worker stopping...');
    
    try {
      await this.pool.end();
      console.log('Database pool closed');
    } catch (error) {
      console.error('Error closing database pool:', error.message);
    }
  }

  async processNextOperation() {
    let client;
    let operation;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        client = await this.pool.connect();
        await client.query('BEGIN');
        
        // Get next pending operation with row lock
        const result = await client.query(`
          SELECT * FROM sync_operations 
          WHERE status = 'pending' AND next_retry_at <= NOW()
          ORDER BY created_at ASC 
          LIMIT 1 
          FOR UPDATE SKIP LOCKED
        `);
        
        if (result.rows.length === 0) {
          await client.query('ROLLBACK');
          return;
        }
        
        operation = result.rows[0];
        
        // Mark as processing
        await client.query(
          'UPDATE sync_operations SET status = $1, started_at = NOW() WHERE id = $2',
          ['processing', operation.id]
        );
        
        await client.query('COMMIT');
        break; // Success, exit retry loop
        
      } catch (error) {
        console.error(`Database error (attempt ${attempt}/${this.maxRetries}):`, error.message);
        
        if (client) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            console.error('Rollback error:', rollbackError.message);
          }
          client.release();
          client = null;
        }
        
        if (attempt === this.maxRetries) {
          throw new Error(`Failed to get operation after ${this.maxRetries} attempts`);
        }
        
        await this.sleep(this.retryDelay * attempt); // Exponential backoff
      } finally {
        if (client) {
          client.release();
          client = null;
        }
      }
    }
    
    if (operation) {
      // Process the operation with separate error handling
      await this.executeOperationSafely(operation);
    }
  }

  async executeOperationSafely(operation) {
    let operationSuccess = false;
    let operationError = null;
    
    try {
      await this.executeOperation(operation);
      operationSuccess = true;
      console.log(`Operation ${operation.id} completed successfully`);
      
    } catch (error) {
      operationError = error;
      console.error(`Operation ${operation.id} failed:`, error.message);
    }
    
    // Always try to update operation status, even if the operation failed
    try {
      if (operationSuccess) {
        await this.markOperationCompleted(operation.id);
      } else {
        await this.handleOperationError(operation, operationError);
      }
    } catch (statusError) {
      console.error(`Failed to update status for operation ${operation.id}:`, statusError.message);
      // Don't throw - we don't want to crash the worker over status update failures
    }
  }

  async executeOperation(operation) {
    console.log('Processing operation:', operation.id, operation.operation_type);
    console.log('Raw payload:', operation.payload);
    
    let payload;
    try {
      console.log('Payload type:', typeof operation.payload);
      console.log('Payload value:', operation.payload);
      
      // Handle case where payload might already be an object
      if (typeof operation.payload === 'object' && operation.payload !== null) {
        payload = operation.payload;
        console.log('Payload is already an object:', payload);
      } else if (typeof operation.payload === 'string') {
        payload = JSON.parse(operation.payload);
        console.log('Parsed payload from string:', payload);
      } else {
        throw new Error(`Unexpected payload type: ${typeof operation.payload}`);
      }
    } catch (parseError) {
      console.error('Failed to parse operation payload:', parseError.message);
      console.error('Payload type:', typeof operation.payload);
      console.error('Payload content:', operation.payload);
      throw new Error(`Invalid payload: ${parseError.message}`);
    }
    
    switch (operation.operation_type) {
      case 'add_user_to_group':
        await this.addUserToGroup(payload);
        break;
        
      case 'remove_user_from_group':
        await this.removeUserFromGroup(payload);
        break;
        
      case 'create_group':
        await this.createGroup(payload);
        break;
        
      case 'bulk_add_user_to_team':
        await this.bulkAddUserToTeam(payload);
        break;
        
      case 'create_bch_channel_groups':
        await this.createBchChannelGroups(payload);
        break;
        
      case 'create_region_channel_group':
        await this.createRegionChannelGroup(payload);
        break;
        
      case 'update_bch_channel_group':
        await this.updateBchChannelGroup(payload);
        break;
        
      case 'update_region_channel_group':
        await this.updateRegionChannelGroup(payload);
        break;
        
      case 'delete_global_channel':
        await this.deleteGlobalChannelGroup(payload);
        break;
        
      case 'assign_user_to_global_channels':
        await this.assignUserToGlobalChannels(payload);
        break;
        
      case 'deactivate_global_channel':
        await this.deactivateGlobalChannel(payload);
        break;
        
      default:
        throw new Error(`Unknown operation type: ${operation.operation_type}`);
    }
  }

  async markOperationCompleted(operationId) {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        await this.pool.query(
          'UPDATE sync_operations SET status = $1, completed_at = NOW() WHERE id = $2',
          ['completed', operationId]
        );
        return; // Success
      } catch (error) {
        console.error(`Failed to mark operation ${operationId} as completed (attempt ${attempt}):`, error.message);
        if (attempt === this.maxRetries) {
          console.error(`Giving up on marking operation ${operationId} as completed`);
        } else {
          await this.sleep(this.retryDelay * attempt);
        }
      }
    }
  }

  async handleOperationError(operation, error) {
    const retryCount = operation.retry_count + 1;
    const maxRetries = operation.max_retries;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        if (retryCount >= maxRetries) {
          // Mark as failed
          await this.pool.query(
            'UPDATE sync_operations SET status = $1, error_message = $2, retry_count = $3 WHERE id = $4',
            ['failed', error.message, retryCount, operation.id]
          );
        } else {
          // Schedule retry with exponential backoff
          const nextRetry = new Date(Date.now() + Math.pow(2, retryCount) * 60000); // 2^n minutes
          
          await this.pool.query(
            'UPDATE sync_operations SET status = $1, error_message = $2, retry_count = $3, next_retry_at = $4 WHERE id = $5',
            ['pending', error.message, retryCount, nextRetry, operation.id]
          );
        }
        return; // Success
      } catch (dbError) {
        console.error(`Failed to update operation error status (attempt ${attempt}):`, dbError.message);
        if (attempt === this.maxRetries) {
          console.error(`Giving up on updating operation ${operation.id} error status`);
        } else {
          await this.sleep(this.retryDelay * attempt);
        }
      }
    }
  }

  async addUserToGroup(payload) {
    const user = await this.getUser(payload.target_user_id);
    if (!user) throw new Error(`User ${payload.target_user_id} not found`);
    
    // Add user to Authentik group using existing service
    const response = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${payload.target_group_id}/add_user/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ pk: user.authentik_user_id })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to add user to group: ${response.statusText}`);
    }
  }

  async removeUserFromGroup(payload) {
    const user = await this.getUser(payload.target_user_id);
    if (!user) throw new Error(`User ${payload.target_user_id} not found`);
    
    // Remove user from Authentik group
    const response = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${payload.target_group_id}/remove_user/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ pk: user.authentik_user_id })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to remove user from group: ${response.statusText}`);
    }
  }

  async createGroup(payload) {
    const response = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: payload.group_name,
        attributes: payload.group_attributes || {}
      })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to create group: ${response.statusText}`);
    }
  }

  async bulkAddUserToTeam(payload) {
    await TeamMembershipService.addUserToTeam(
      payload.target_user_id,
      payload.team_id,
      payload.role
    );
    
    // Update bulk operation progress
    if (payload.bulk_operation_id) {
      await this.pool.query(`
        UPDATE bulk_operations 
        SET processed_items = processed_items + 1,
            progress_percentage = (processed_items::decimal / total_items) * 100
        WHERE id = $1
      `, [payload.bulk_operation_id]);
    }
  }

  async createBchChannelGroups(payload) {
    const { channel_name, service_account_username, service_account_password, bch_channel_id } = payload;
    
    // Create read and write groups
    const readGroupName = `bch_${channel_name.toLowerCase().replace(/\s+/g, '_')}_read`;
    const writeGroupName = `bch_${channel_name.toLowerCase().replace(/\s+/g, '_')}_write`;
    
    const readGroupResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: readGroupName,
        attributes: { channel_type: 'bch', permission: 'read' }
      })
    });
    
    const writeGroupResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: writeGroupName,
        attributes: { channel_type: 'bch', permission: 'write' }
      })
    });
    
    if (!readGroupResponse.ok || !writeGroupResponse.ok) {
      throw new Error('Failed to create BCH channel groups');
    }
    
    const readGroup = await readGroupResponse.json();
    const writeGroup = await writeGroupResponse.json();
    
    // Create service account
    const userResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: service_account_username,
        name: `ETL Service Account - ${channel_name}`,
        is_active: true,
        type: 'service_account',
        attributes: { service_type: 'etl', channel_name }
      })
    });
    
    if (!userResponse.ok) {
      throw new Error('Failed to create service account');
    }
    
    const serviceAccount = await userResponse.json();
    
    // Set service account password
    await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${serviceAccount.pk}/set_password/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password: service_account_password })
    });
    
    // Add service account to write group
    await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${writeGroup.pk}/add_user/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ pk: serviceAccount.pk })
    });
    
    // Update database with group IDs
    await this.pool.query(`
      UPDATE bch_channels 
      SET service_account_id = $1, read_group_id = $2, write_group_id = $3
      WHERE id = $4
    `, [serviceAccount.pk, readGroup.pk, writeGroup.pk, bch_channel_id]);
  }

  async createRegionChannelGroup(payload) {
    const { channel_name, region_channel_id } = payload;
    
    const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
    const groupName = `tak_Regions${separator}${channel_name}`;
    
    console.log('Creating region channel group:', groupName);
    
    // Get channel description from database
    const channelResult = await this.pool.query(
      'SELECT description FROM region_channels WHERE id = $1',
      [region_channel_id]
    );
    
    const description = channelResult.rows[0]?.description || channel_name;
    const authentikDescription = `${description} (Bi-directional location sharing)`;
    
    const groupResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: groupName,
        attributes: { 
          channel_type: 'region',
          description: authentikDescription
        }
      })
    });
    
    if (!groupResponse.ok) {
      const errorText = await groupResponse.text();
      console.error('Authentik API error:', groupResponse.status, errorText);
      throw new Error(`Failed to create region channel group: ${groupResponse.status} ${errorText}`);
    }
    
    const responseText = await groupResponse.text();
    let group;
    try {
      group = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Failed to parse Authentik response as JSON:', responseText);
      throw new Error(`Invalid JSON response from Authentik: ${responseText}`);
    }
    console.log('Created group:', group.pk, group.name);
    
    // Update database with group ID
    await this.pool.query(`
      UPDATE region_channels 
      SET group_id = $1
      WHERE id = $2
    `, [group.pk, region_channel_id]);
  }

  async updateBchChannelGroup(payload) {
    const { bch_channel_id, channel_name, description } = payload;
    
    console.log('Updating BCH channel group:', { bch_channel_id, channel_name, description });
    
    // Get current group IDs
    const channelResult = await this.pool.query(
      'SELECT read_group_id, write_group_id FROM bch_channels WHERE id = $1',
      [bch_channel_id]
    );
    
    if (channelResult.rows.length === 0) {
      console.log('No BCH channel found with ID:', bch_channel_id);
      return;
    }
    
    const { read_group_id, write_group_id } = channelResult.rows[0];
    console.log('Found group IDs:', { read_group_id, write_group_id });
    
    // Update read group
    if (read_group_id) {
      const readRequestBody = {
        name: `bch_${channel_name.toLowerCase().replace(/\s+/g, '_')}_read`,
        attributes: { channel_type: 'bch', permission: 'read', description }
      };
      
      console.log('Updating read group:', readRequestBody);
      
      const readResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${read_group_id}/`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(readRequestBody)
      });
      
      console.log('Read group response status:', readResponse.status);
      
      if (!readResponse.ok) {
        const errorText = await readResponse.text();
        console.error('Read group error:', errorText);
        throw new Error(`Failed to update BCH read group: ${readResponse.status} ${errorText}`);
      }
      
      console.log('Read group updated successfully');
    }
    
    // Update write group
    if (write_group_id) {
      const writeRequestBody = {
        name: `bch_${channel_name.toLowerCase().replace(/\s+/g, '_')}_write`,
        attributes: { channel_type: 'bch', permission: 'write', description }
      };
      
      console.log('Updating write group:', writeRequestBody);
      
      const writeResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${write_group_id}/`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(writeRequestBody)
      });
      
      console.log('Write group response status:', writeResponse.status);
      
      if (!writeResponse.ok) {
        const errorText = await writeResponse.text();
        console.error('Write group error:', errorText);
        throw new Error(`Failed to update BCH write group: ${writeResponse.status} ${errorText}`);
      }
      
      console.log('Write group updated successfully');
    }
  }

  async updateRegionChannelGroup(payload) {
    const { region_channel_id, channel_name, description } = payload;
    
    console.log('Updating region channel group:', { region_channel_id, channel_name, description });
    
    // Get current group ID
    const channelResult = await this.pool.query(
      'SELECT group_id FROM region_channels WHERE id = $1',
      [region_channel_id]
    );
    
    if (channelResult.rows.length === 0) {
      console.log('No channel found with ID:', region_channel_id);
      return;
    }
    
    const { group_id } = channelResult.rows[0];
    console.log('Found group_id:', group_id);
    
    if (!group_id) {
      console.log('No group_id set for channel');
      return;
    }
    
    const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
    const authentikDescription = `${description} (Bi-directional location sharing)`;
    const requestBody = {
      name: `tak_Regions${separator}${channel_name}`,
      attributes: { 
        channel_type: 'region',
        description: authentikDescription
      }
    };
    
    console.log('Sending PATCH request to Authentik:', {
      url: `${process.env.AUTHENTIK_URL}/api/v3/core/groups/${group_id}/`,
      body: requestBody
    });
    
    try {
      const updateResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${group_id}/`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      console.log('Authentik response status:', updateResponse.status);
      console.log('Authentik response headers:', Object.fromEntries(updateResponse.headers.entries()));
      
      if (!updateResponse.ok) {
        let errorText;
        try {
          errorText = await updateResponse.text();
        } catch (textError) {
          errorText = `Failed to read error response: ${textError.message}`;
        }
        console.error('Authentik error response:', errorText);
        throw new Error(`Failed to update region group: ${updateResponse.status} ${errorText}`);
      }
      
      // Successfully updated - don't try to read response body
      console.log('Region channel group updated successfully in Authentik');
      
      console.log('Region channel group updated successfully');
      
    } catch (fetchError) {
      console.error('Fetch error:', fetchError);
      throw fetchError;
    }
  }

  async deleteGlobalChannelGroup(payload) {
    const { channel_id, channel_type } = payload;
    
    if (channel_type === 'bch') {
      // Get BCH channel group IDs
      const channelResult = await this.pool.query(
        'SELECT read_group_id, write_group_id, service_account_id FROM bch_channels WHERE id = $1',
        [channel_id]
      );
      
      if (channelResult.rows.length > 0) {
        const { read_group_id, write_group_id, service_account_id } = channelResult.rows[0];
        
        // Delete groups and service account
        if (read_group_id) {
          await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${read_group_id}/`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
          });
        }
        
        if (write_group_id) {
          await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${write_group_id}/`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
          });
        }
        
        if (service_account_id) {
          await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${service_account_id}/`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
          });
        }
      }
    } else if (channel_type === 'region') {
      // Get region channel group ID
      const channelResult = await this.pool.query(
        'SELECT group_id FROM region_channels WHERE id = $1',
        [channel_id]
      );
      
      if (channelResult.rows.length > 0) {
        const { group_id } = channelResult.rows[0];
        
        if (group_id) {
          await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${group_id}/`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
          });
        }
      }
    }
  }

  async assignUserToGlobalChannels(payload) {
    const user = await this.getUser(payload.target_user_id);
    if (!user) throw new Error(`User ${payload.target_user_id} not found`);
    
    // Get all active global channel group IDs
    const bchResult = await this.pool.query(`
      SELECT read_group_id, write_group_id 
      FROM bch_channels 
      WHERE is_active = true AND read_group_id IS NOT NULL
    `);
    
    const regionResult = await this.pool.query(`
      SELECT group_id 
      FROM region_channels 
      WHERE is_active = true AND group_id IS NOT NULL
    `);
    
    const groupIds = [];
    
    // Add BCH read groups (all users get read access)
    for (const bch of bchResult.rows) {
      if (bch.read_group_id) {
        groupIds.push(bch.read_group_id);
      }
    }
    
    // Add region groups (all users get read-write access)
    for (const region of regionResult.rows) {
      if (region.group_id) {
        groupIds.push(region.group_id);
      }
    }
    
    // Add user to each group
    for (const groupId of groupIds) {
      try {
        await this.addUserToGroup({
          target_user_id: payload.target_user_id,
          target_group_id: groupId
        });
      } catch (error) {
        console.error(`Failed to add user ${payload.target_user_id} to group ${groupId}:`, error.message);
        // Continue with other groups even if one fails
      }
    }
    
    // Update bulk operation progress
    if (payload.bulk_operation_id) {
      await this.pool.query(`
        UPDATE bulk_operations 
        SET processed_items = processed_items + 1,
            progress_percentage = (processed_items::decimal / total_items) * 100
        WHERE id = $1
      `, [payload.bulk_operation_id]);
    }
  }

  async deactivateGlobalChannel(payload) {
    // This would remove all users from the channel groups
    // Implementation depends on specific requirements
    console.log('Deactivating global channel:', payload.channel_id);
  }

  async getUser(userId) {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this.pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        return result.rows[0];
      } catch (error) {
        console.error(`Failed to get user ${userId} (attempt ${attempt}):`, error.message);
        if (attempt === this.maxRetries) {
          throw error;
        }
        await this.sleep(this.retryDelay * attempt);
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Start worker if run directly
if (require.main === module) {
  const worker = new SyncWorker();
  
  process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down gracefully...');
    await worker.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    await worker.stop();
    process.exit(0);
  });
  
  worker.start().catch(console.error);
}

module.exports = SyncWorker;