const pool = require('../config/database');
const authentikService = require('../services/authentik');
const TeamMembershipService = require('../services/TeamMembershipService');

class SyncWorker {
  constructor() {
    this.isRunning = false;
    this.pollInterval = 5000; // 5 seconds
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
        console.error('Worker error:', error);
        await this.sleep(this.pollInterval);
      }
    }
  }

  async stop() {
    this.isRunning = false;
    console.log('Sync worker stopped');
  }

  async processNextOperation() {
    const client = await pool.connect();
    
    try {
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
      
      const operation = result.rows[0];
      
      // Mark as processing
      await client.query(
        'UPDATE sync_operations SET status = $1, started_at = NOW() WHERE id = $2',
        ['processing', operation.id]
      );
      
      await client.query('COMMIT');
      
      // Process the operation
      await this.executeOperation(operation);
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async executeOperation(operation) {
    try {
      const payload = JSON.parse(operation.payload);
      
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
          
        default:
          throw new Error(`Unknown operation type: ${operation.operation_type}`);
      }
      
      // Mark as completed
      await pool.query(
        'UPDATE sync_operations SET status = $1, completed_at = NOW() WHERE id = $2',
        ['completed', operation.id]
      );
      
    } catch (error) {
      await this.handleOperationError(operation, error);
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
      await pool.query(`
        UPDATE bulk_operations 
        SET processed_items = processed_items + 1,
            progress_percentage = (processed_items::decimal / total_items) * 100
        WHERE id = $1
      `, [payload.bulk_operation_id]);
    }
  }

  async handleOperationError(operation, error) {
    const retryCount = operation.retry_count + 1;
    const maxRetries = operation.max_retries;
    
    if (retryCount >= maxRetries) {
      // Mark as failed
      await pool.query(
        'UPDATE sync_operations SET status = $1, error_message = $2, retry_count = $3 WHERE id = $4',
        ['failed', error.message, retryCount, operation.id]
      );
    } else {
      // Schedule retry with exponential backoff
      const nextRetry = new Date(Date.now() + Math.pow(2, retryCount) * 60000); // 2^n minutes
      
      await pool.query(
        'UPDATE sync_operations SET status = $1, error_message = $2, retry_count = $3, next_retry_at = $4 WHERE id = $5',
        ['pending', error.message, retryCount, nextRetry, operation.id]
      );
    }
  }

  async getUser(userId) {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    return result.rows[0];
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
  
  worker.start().catch(console.error);
}

module.exports = SyncWorker;