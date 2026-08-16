const axios = require('axios');
const pLimit = require('p-limit');
const db = require('../config/database');
const { createLogger } = require('../config/logger');

const logger = createLogger('authentikSync');

// Requirement 11.2: bounded concurrency for processBatch's per-user Authentik
// sync work, configurable via AUTHENTIK_SYNC_CONCURRENCY and clamped to the
// 1-20 range (default 5), following the same
// `Math.min(<max>, Math.max(<min>, parseInt(...) || <default>))` clamp
// pattern already established for SYNC_WORKER_BATCH_SIZE in
// server/workers/syncWorker.js.
function getAuthentikSyncConcurrency() {
  return Math.min(20, Math.max(1, parseInt(process.env.AUTHENTIK_SYNC_CONCURRENCY, 10) || 5));
}

class AuthentikSyncService {
  constructor() {
    this.isRunning = false;
    this.lastSync = null;
  }

  async syncUsers() {
    if (this.isRunning) {
      logger.info('Authentik sync already running, skipping');
      return;
    }

    this.isRunning = true;
    logger.info('Starting Authentik user sync');

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

        logger.debug(
          { fetchedCount: response.data.results.length, totalFetched: allUsers.length },
          'Fetched a page of Authentik users'
        );
      }

      logger.info({ totalUsers: allUsers.length }, 'Total users to sync');

      // Requirement 11.6: fetch the full Authentik group list once per sync
      // run, in its own dedicated try/catch, so that a failure on ANY page
      // of the pagination loop (the first page, or a later page after some
      // earlier pages already succeeded) is caught here explicitly and
      // aborts the run BEFORE the `for` loop below ever calls
      // processBatch/syncSingleUser. This makes the "no partial user_cache
      // write" guarantee explicit in the code rather than relying solely on
      // the outer try/catch's exception propagation -- a partial
      // `allGroups`/`groupMap` (from an interrupted pagination loop) must
      // never be used to process a user batch.
      let groupMap;
      try {
        groupMap = await this.fetchGroupMap();
      } catch (groupFetchError) {
        logger.error({ err: groupFetchError }, 'Authentik group list fetch failed; aborting user sync before any user_cache write');

        await db.query(
          'UPDATE sync_status SET status = $1, error_message = $2 WHERE sync_type = $3',
          ['error', `Group list fetch failed: ${groupFetchError.message}`, 'user_sync']
        );

        return; // Explicit early return: abort before the processBatch loop.
      }

      // Process users in batches
      const batchSize = 50;
      let syncedCount = 0;

      for (let i = 0; i < allUsers.length; i += batchSize) {
        const batch = allUsers.slice(i, i + batchSize);
        await this.processBatch(batch, groupMap);
        syncedCount += batch.length;
        logger.debug({ syncedCount, totalUsers: allUsers.length }, 'Synced a batch of users');
      }

      // Update sync status
      await db.query(
        'UPDATE sync_status SET status = $1, records_synced = $2, error_message = NULL WHERE sync_type = $3',
        ['success', syncedCount, 'user_sync']
      );

      this.lastSync = new Date();
      logger.info({ syncedCount }, 'Authentik user sync completed successfully');

    } catch (error) {
      logger.error({ err: error }, 'Authentik user sync failed');

      await db.query(
        'UPDATE sync_status SET status = $1, error_message = $2 WHERE sync_type = $3',
        ['error', error.message, 'user_sync']
      );
    } finally {
      this.isRunning = false;
    }
  }

  // Requirement 11.1/11.6: fetches the full Authentik group list, paginated,
  // exactly once per sync run, and returns the completed pk->name map.
  // Throws if any page of the pagination loop fails, so a partial
  // `allGroups` list is never returned to the caller and never used to
  // build a groupMap for processBatch.
  async fetchGroupMap() {
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

    return groupMap;
  }

  async processBatch(users, groupMap) {
    const adminGroupName = process.env.ADMIN_GROUP_NAME || 'TakTeamManager_Admin';

    // Requirement 11.2: bounded concurrency instead of a fully serial `for`
    // loop. Each user's sync task is wrapped by `limit(...)`, and
    // syncSingleUser's own try/catch continues to swallow per-user
    // failures internally (logging via logger.error) so Promise.all never
    // observes a rejection from a single user's failure -- one user's
    // failure must not abort or delay other users in the batch.
    const limit = pLimit(getAuthentikSyncConcurrency());

    await Promise.all(
      users.map(user => limit(() => this.syncSingleUser(user, groupMap, adminGroupName)))
    );
  }

  async syncSingleUser(user, groupMap, adminGroupName) {
    try {
      const groupNames = user.groups?.map(groupId => groupMap[groupId]).filter(Boolean) || [];
      const isAdmin = groupNames.includes(adminGroupName);

      // Also upsert a corresponding row into the local `users` table, keyed
      // on authentik_user_id, following the same pattern used by
      // UserProvisioningService.createAndAddUser. Without this, a user who
      // only ever came in through this periodic sync (and never through an
      // explicit provisioning flow) would exist in `user_cache` but have no
      // row in `users`, causing any route that resolves the acting admin's
      // local user id via `SELECT id FROM users WHERE authentik_user_id = $1`
      // to fail. Uses the same first_name/last_name fallback expressions as
      // the user_cache insert below so both rows stay consistent.
      //
      // Skipped when the Authentik user has no email: `users.email` is a
      // UNIQUE NOT NULL column, and this Authentik instance has several
      // service-account/API-token users (e.g. etl-adsbx, ak-outpost-<uuid>)
      // with no email set. The first such user to sync would claim the
      // empty-string email, causing every subsequent emailless user to hit
      // a "duplicate key value violates unique constraint users_email_key"
      // error. These service accounts never log into this app and don't
      // need a `users` row for team-membership/audit-trail purposes, so
      // they're only kept in `user_cache` below (which has no such
      // constraint).
      if (user.email) {
        await db.query(
          'INSERT INTO users (authentik_user_id, username, email, first_name, last_name, is_active) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2, email = $3, first_name = $4, last_name = $5, is_active = $6',
          [
            user.pk,
            user.username,
            user.email,
            user.first_name || user.name || user.username,
            user.last_name || '',
            user.is_active
          ]
        );
      }

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
      logger.error({ err: error, username: user.username }, 'Failed to sync user');
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
    logger.info({ intervalMinutes }, 'Starting periodic Authentik sync');

    // Run initial sync. syncUsers() already has its own internal try/catch
    // (which logs via the structured logger and updates sync_status on
    // failure), but setTimeout's callback return value is discarded either
    // way, so this is a fire-and-forget invocation of an async function.
    // The .catch() below is a defensive backstop per Requirement 8.7: if a
    // future change ever removes that internal try/catch, or an error is
    // thrown outside of it (e.g. synchronously, before the try block), the
    // rejection is still routed through the structured logger instead of
    // becoming an unhandled rejection or falling back to console.error.
    setTimeout(() => {
      this.syncUsers().catch(err =>
        logger.error({ err }, 'Periodic Authentik sync failed (initial run)')
      );
    }, 5000); // 5 second delay on startup

    // Set up periodic sync. Same fire-and-forget reasoning applies here:
    // setInterval never awaits or catches the promise returned by
    // syncUsers(), so an explicit .catch() backstop routes any error
    // through the structured logger.
    setInterval(() => {
      this.syncUsers().catch(err =>
        logger.error({ err }, 'Periodic Authentik sync failed')
      );
    }, intervalMinutes * 60 * 1000);
  }
}

module.exports = new AuthentikSyncService();
// Exposed for unit testing the concurrency clamp logic (Requirement 11.2)
// independent of the singleton instance's internal state.
module.exports.getAuthentikSyncConcurrency = getAuthentikSyncConcurrency;