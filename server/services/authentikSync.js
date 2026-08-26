const axios = require('axios');
const pLimit = require('p-limit');
const db = require('../config/database');
const { createLogger } = require('../config/logger');
const { normaliseAuthentikEmail } = require('../utils/authentikEmail');

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
      let currentPage = 1;
      let hasMorePages = true;

      // Fetch all users with pagination. Authentik's pagination metadata
      // lives under `response.data.pagination.next` (a page NUMBER), not
      // a top-level `response.data.next` URL -- the same shape
      // `fetchGroupMap` below already handles correctly. This loop
      // previously read the wrong field, which is always `undefined`, so
      // it silently terminated after page 1 every run: with the default
      // page_size of 20 and this Authentik instance now having 24+
      // users, any user beyond the first page (e.g. a normal, active,
      // non-admin user alphabetically/insertion-ordered past the first
      // 20) was NEVER written to user_cache, causing their every login
      // attempt to hit the "not found in cache" path indefinitely -- not
      // just a delay until the next sync, since that next sync had the
      // exact same bug.
      while (hasMorePages) {
        const response = await axios.get(
          `${process.env.AUTHENTIK_URL}/api/v3/core/users/?page=${currentPage}`,
          {
            headers: { Authorization: `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` },
            timeout: 30000
          }
        );

        allUsers = allUsers.concat(response.data.results);

        logger.debug(
          { fetchedCount: response.data.results.length, totalFetched: allUsers.length },
          'Fetched a page of Authentik users'
        );

        if (response.data.pagination && response.data.pagination.next) {
          currentPage = response.data.pagination.next;
        } else {
          hasMorePages = false;
        }
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

      // TAK Team Manager is authoritative for all user attributes after
      // initial bootstrap. The periodic sync pushes local values to Authentik
      // when they differ (see push-to-Authentik section below).
      //
      // Upsert into the local `users` table, keyed on authentik_user_id.
      // On INSERT (new user): seeds first_name/last_name from Authentik
      // attributes (bootstrap), sets is_active = true always, seeds tak_role
      // from Authentik if present.
      // On UPDATE (existing user): only identity fields (username, email) are
      // synced from Authentik. first_name, last_name, is_active, and tak_role
      // are LOCAL-authoritative and never overwritten by Authentik values.
      //
      // takserver-enrollment Requirement 5.6: this upsert is NOT skipped for
      // an emailless Authentik principal any more. `users.email` is nullable
      // now (Requirement 5.3), guarded instead by the
      // users_email_required_unless_device CHECK constraint -- a Team_Owned_
      // Device satisfies it via its existing is_team_device = true row and
      // therefore syncs normally. The one remaining reason a sync can still
      // skip a principal is a genuinely emailless NON-device row with no
      // local `users` row yet: the CHECK constraint rejects that INSERT, and
      // the narrow catch below (23514 on
      // users_email_required_unless_device) is what decides it, logging at
      // warn and skipping that principal's users AND user_cache writes,
      // rather than silently excluding it as the old `if (user.email)` guard
      // did for every emailless principal including every Team_Owned_Device.
      const takRoleFromAuthentik = user.attributes?.takRole ?? null;
      const seedFirstName = user.attributes?.first_name || user.name || user.username;
      const seedLastName = user.attributes?.last_name || '';

      // takserver-enrollment Requirement 5.5: normalise Authentik's
      // Empty_String_Email ('') to null exactly once, and bind that single
      // value to `email` in BOTH the `users` upsert and the `user_cache`
      // upsert below, so "no email" is NULL consistently on both tables for
      // the same principal rather than NULL on one and '' on the other.
      const email = normaliseAuthentikEmail(user.email);

      // BUGFIX (found during takserver-enrollment task 12.2 live
      // verification): `is_team_device` was omitted from the INSERT's
      // column list below, so Postgres evaluated the tentative INSERT
      // tuple's `is_team_device` at the column DEFAULT (false) against the
      // users_email_required_unless_device CHECK constraint BEFORE
      // `ON CONFLICT ... DO UPDATE` ever ran -- per Postgres's documented
      // INSERT ... ON CONFLICT semantics, the proposed row is checked
      // against constraints before conflict resolution. For an EXISTING
      // Team_Owned_Device row (email NULL, is_team_device already true in
      // the stored row), that made the tentative tuple (email=NULL,
      // is_team_device=false) violate the CHECK constraint on EVERY sync,
      // even though the real stored row already satisfied it -- and the
      // catch below misclassified it as "genuinely emailless principal
      // with no local row", silently skipping this device's users AND
      // user_cache writes on every run. The device kept working (its
      // `users` row was written once by DeviceEnrollmentService.createDevice)
      // but was never reconciled by sync again.
      //
      // The fix: the VALUES clause's own `is_team_device` expression reads
      // the row's EXISTING stored value via a same-statement subquery
      // keyed on authentik_user_id (reusing $1 -- no new bound parameter),
      // defaulting to false only when no row exists yet (a genuinely new
      // principal, which is never a device on this path -- devices are
      // created by DeviceEnrollmentService.createDevice's own INSERT, never
      // materialized for the first time here). Doing this as a subquery
      // inside the single INSERT statement, rather than a separate SELECT
      // issued beforehand, keeps the read and the write atomic within one
      // round trip: there is no window between "read is_team_device" and
      // "write the row" for Postgres to race in, which is a strictly
      // tighter guarantee than the other reads in this function settle for
      // (e.g. the push-to-Authentik SELECTs below, which already tolerate a
      // race against a concurrent write for the same principal). It is
      // deliberately NOT added to `ON CONFLICT ... DO UPDATE SET`: the
      // local `users` row is the authority for this column, and the update
      // path must leave whatever value the row already holds untouched.
      let isTeamDevice = false;
      let localUserId = null;
      try {
        const usersUpsertResult = await db.query(
          'INSERT INTO users (authentik_user_id, username, email, first_name, last_name, is_active, tak_role, is_team_device) VALUES ($1, $2, $3, $4, $5, true, COALESCE($6, \'Team Member\'), COALESCE((SELECT is_team_device FROM users WHERE authentik_user_id = $1), false)) ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2, email = $3 RETURNING id, is_team_device',
          [
            user.pk,
            user.username,
            email,
            seedFirstName,
            seedLastName,
            takRoleFromAuthentik
          ]
        );
        localUserId = usersUpsertResult.rows[0]?.id ?? null;
        isTeamDevice = usersUpsertResult.rows[0]?.is_team_device === true;
      } catch (usersUpsertError) {
        if (
          usersUpsertError.code === '23514' &&
          usersUpsertError.constraint === 'users_email_required_unless_device'
        ) {
          logger.warn(
            { authentikUserId: user.pk },
            'Skipped users/user_cache sync for an emailless Authentik principal with no local row (users_email_required_unless_device)'
          );
          return;
        }
        throw usersUpsertError;
      }

      // user_cache upsert: TAK Team Manager is authoritative for first_name,
      // last_name, tak_role, tak_color, tak_callsign, is_active after initial
      // bootstrap. On INSERT, seed all values from Authentik. On UPDATE, only
      // sync identity fields (username, email) and admin-related fields
      // (groups, is_admin) from Authentik.
      //
      // takserver-enrollment Requirement 5.6: is_team_device is added to the
      // INSERT column list, sourced from the `users` upsert's
      // RETURNING is_team_device above -- the local `users` row is the
      // authority for it, since Authentik carries no such field.
      // Deliberately absent from ON CONFLICT DO UPDATE SET, so the cache
      // adopts the flag on first insert and never overwrites it afterwards,
      // matching how this upsert already treats first_name/tak_role as
      // bootstrap-then-local.
      await db.query(`
        INSERT INTO user_cache (
          authentik_id, username, email, first_name, last_name, 
          is_active, tak_role, tak_color, tak_callsign, groups, is_admin, is_team_device
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (authentik_id) DO UPDATE SET
          username = EXCLUDED.username,
          email = EXCLUDED.email,
          groups = EXCLUDED.groups,
          is_admin = EXCLUDED.is_admin,
          updated_at = CURRENT_TIMESTAMP
      `, [
        user.pk,
        user.username,
        email,
        seedFirstName,
        seedLastName,
        true,
        user.attributes?.takRole,
        user.attributes?.takColor,
        user.attributes?.takCallsign,
        groupNames,
        isAdmin,
        isTeamDevice
      ]);

      // --- Push local-authoritative attributes to Authentik when they differ ---
      // TAK Team Manager is authoritative for: first_name, last_name,
      // tak_callsign, tak_color, tak_role, is_active. Only PATCH if at least
      // one value differs (avoids unnecessary API calls).
      //
      // takserver-enrollment Requirement 5.6: this guard is keyed on "has a
      // local `users` row" (localUserId), not "has an email" -- that is the
      // condition the comment above always meant. With email now nullable,
      // "has an email" and "has a local row" are different questions: there
      // is nothing local to push for a principal with no local row, and a
      // Team_Owned_Device with a local row and no email has a tak_role
      // worth pushing back like any other principal.
      if (localUserId) {
        try {
          // Read the LOCAL authoritative values for this user
          const localResult = await db.query(
            'SELECT first_name, last_name, tak_role, is_active FROM users WHERE authentik_user_id = $1',
            [user.pk]
          );
          const cacheResult = await db.query(
            'SELECT tak_callsign, tak_color FROM user_cache WHERE authentik_id = $1',
            [String(user.pk)]
          );

          if (localResult.rows.length > 0) {
            const local = localResult.rows[0];
            const cache = cacheResult.rows[0] || {};

            // Current Authentik values (from the user object we already fetched)
            const authentikAttrs = user.attributes || {};
            const authentikName = user.name || '';

            // Local authoritative values
            const localFirstName = local.first_name || '';
            const localLastName = local.last_name || '';
            const localTakCallsign = cache.tak_callsign || '';
            const localTakColor = cache.tak_color || '';
            const localTakRole = local.tak_role || 'Team Member';
            const localIsActive = local.is_active !== false; // default true
            const localFullName = `${localFirstName}${localLastName ? ' ' + localLastName : ''}`;

            // Check if anything differs
            const nameChanged = authentikName !== localFullName;
            const isActiveChanged = user.is_active !== localIsActive;
            const attrsChanged = (
              (authentikAttrs.first_name || '') !== localFirstName ||
              (authentikAttrs.last_name || '') !== localLastName ||
              (authentikAttrs.takCallsign || '') !== localTakCallsign ||
              (authentikAttrs.takColor || '') !== localTakColor ||
              (authentikAttrs.takRole || '') !== localTakRole
            );

            if (nameChanged || isActiveChanged || attrsChanged) {
              const mergedAttributes = {
                ...authentikAttrs,
                first_name: localFirstName,
                last_name: localLastName,
                takCallsign: localTakCallsign,
                takColor: localTakColor,
                takRole: localTakRole
              };

              const patchPayload = {
                name: localFullName,
                is_active: localIsActive,
                attributes: mergedAttributes
              };

              const patchResponse = await axios.patch(
                `${process.env.AUTHENTIK_URL}/api/v3/core/users/${user.pk}/`,
                patchPayload,
                {
                  headers: {
                    'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
                    'Content-Type': 'application/json'
                  },
                  timeout: 10000
                }
              );

              if (patchResponse.status >= 200 && patchResponse.status < 300) {
                logger.debug({ username: user.username }, 'Pushed local attributes to Authentik');
              }
            }
          }
        } catch (pushError) {
          // Non-fatal: log and continue — the next sync will retry
          logger.error({ err: pushError, username: user.username }, 'Failed to push attributes to Authentik');
        }
      }
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
    // Clamped to a 1-minute floor, mirroring the guard already used for the
    // Sync_Worker's own scheduled jobs (ExpiryScheduler, RetentionCleanupJob,
    // SubscriptionPoller, DeviceSync, AdminCredentialRefreshJob): a
    // misconfigured 0 or negative value would otherwise fire `setInterval`
    // on effectively every tick. `this.isRunning` already collapses any
    // overlapping tick into a no-op, so the floor is a sanity guard against
    // busy-looping the timer itself, not a correctness requirement. No
    // upper bound is imposed -- nothing pins a maximum staleness for this
    // reconciliation sweep.
    const MIN_INTERVAL_MINUTES = 1;
    const DEFAULT_INTERVAL_MINUTES = 10;

    const intervalMinutes = Math.max(
      MIN_INTERVAL_MINUTES,
      parseInt(process.env.SYNC_INTERVAL_MINUTES, 10) || DEFAULT_INTERVAL_MINUTES
    );
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