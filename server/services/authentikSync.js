const axios = require('axios');
const db = require('../config/database');

class AuthentikSyncService {
  constructor() {
    this.isRunning = false;
    this.lastSync = null;
  }

  async syncUsers() {
    if (this.isRunning) {
      console.log('Sync already running, skipping...');
      return;
    }

    this.isRunning = true;
    console.log('Starting Authentik user sync...');

    try {
      // Update sync status
      await db.query(
        'UPDATE sync_status SET status = $1, last_sync = CURRENT_TIMESTAMP WHERE sync_type = $2',
        ['running', 'user_sync']
      );

      let allUsers = [];
      let nextUrl = `${process.env.AUTHENTIK_URL}/api/v3/core/users/`;
      
      // Fetch all users with pagination
      while (nextUrl) {
        const response = await axios.get(nextUrl, {
          headers: { Authorization: `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` },
          timeout: 30000
        });

        allUsers = allUsers.concat(response.data.results);
        nextUrl = response.data.next;
        
        console.log(`Fetched ${response.data.results.length} users, total: ${allUsers.length}`);
      }

      console.log(`Total users to sync: ${allUsers.length}`);

      // Process users in batches
      const batchSize = 50;
      let syncedCount = 0;

      for (let i = 0; i < allUsers.length; i += batchSize) {
        const batch = allUsers.slice(i, i + batchSize);
        await this.processBatch(batch);
        syncedCount += batch.length;
        console.log(`Synced ${syncedCount}/${allUsers.length} users`);
      }

      // Update sync status
      await db.query(
        'UPDATE sync_status SET status = $1, records_synced = $2, error_message = NULL WHERE sync_type = $3',
        ['success', syncedCount, 'user_sync']
      );

      this.lastSync = new Date();
      console.log(`Sync completed successfully. Synced ${syncedCount} users.`);

    } catch (error) {
      console.error('Sync failed:', error.message);
      
      await db.query(
        'UPDATE sync_status SET status = $1, error_message = $2 WHERE sync_type = $3',
        ['error', error.message, 'user_sync']
      );
    } finally {
      this.isRunning = false;
    }
  }

  async processBatch(users) {
    const adminGroupName = process.env.ADMIN_GROUP_NAME || 'TakTeamManager_Admin';

    // Fetch all groups with pagination to map UUIDs to names
    let allGroups = [];
    let currentPage = 1;
    let hasMorePages = true;
    
    while (hasMorePages) {
      const groupsResponse = await axios.get(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/?page=${currentPage}`, {
        headers: { Authorization: `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` },
        timeout: 30000
      });
      
      allGroups = allGroups.concat(groupsResponse.data.results);
      
      if (groupsResponse.data.pagination && groupsResponse.data.pagination.next) {
        currentPage = groupsResponse.data.pagination.next;
      } else {
        hasMorePages = false;
      }
    }
    
    const groupMap = {};
    allGroups.forEach(group => {
      groupMap[group.pk] = group.name;
    });

    for (const user of users) {
      try {
        const groupNames = user.groups?.map(groupId => groupMap[groupId]).filter(Boolean) || [];
        const isAdmin = groupNames.includes(adminGroupName);


        await db.query(`
          INSERT INTO user_cache (
            authentik_id, username, email, first_name, last_name, 
            is_active, tak_role, tak_color, tak_callsign, groups, is_admin
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (authentik_id) DO UPDATE SET
            username = EXCLUDED.username,
            email = EXCLUDED.email,
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            is_active = EXCLUDED.is_active,
            tak_role = EXCLUDED.tak_role,
            tak_color = EXCLUDED.tak_color,
            tak_callsign = EXCLUDED.tak_callsign,
            groups = EXCLUDED.groups,
            is_admin = EXCLUDED.is_admin,
            updated_at = CURRENT_TIMESTAMP
        `, [
          user.pk,
          user.username,
          user.email,
          user.first_name || user.name || user.username,
          user.last_name || '',
          user.is_active,
          user.attributes?.takRole,
          user.attributes?.takColor,
          user.attributes?.takCallsign,
          groupNames,
          isAdmin
        ]);
      } catch (error) {
        console.error(`Failed to sync user ${user.username}:`, error.message);
      }
    }
  }

  async getUserFromCache(username) {
    const result = await db.query(
      'SELECT * FROM user_cache WHERE username = $1 AND is_active = true',
      [username]
    );
    return result.rows[0];
  }

  async getSyncStatus() {
    const result = await db.query(
      'SELECT * FROM sync_status WHERE sync_type = $1',
      ['user_sync']
    );
    return result.rows[0];
  }

  startPeriodicSync() {
    const intervalMinutes = parseInt(process.env.SYNC_INTERVAL_MINUTES) || 10;
    console.log(`Starting periodic sync every ${intervalMinutes} minutes`);
    
    // Run initial sync
    setTimeout(() => this.syncUsers(), 5000); // 5 second delay on startup
    
    // Set up periodic sync
    setInterval(() => this.syncUsers(), intervalMinutes * 60 * 1000);
  }
}

module.exports = new AuthentikSyncService();