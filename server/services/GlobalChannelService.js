const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
const crypto = require('crypto');
const CredentialEncryptionService = require('./CredentialEncryptionService');
const logger = require('../config/logger').createLogger('GlobalChannelService');
const { REGION_CHANNEL_TIER_PREFIX, REGION_CHANNEL_TIER_DESCRIPTION_QUALIFIER, BCH_CHANNEL_CATEGORY_PREFIX } = require('../config/constants');
const { buildRegionSeedWorkItems } = require('../config/regions');

// Frozen allow-list mapping a channelType to its backing table name.
// Used to guard against SQL identifier interpolation from caller-controlled
// values (Requirements 5.1, 5.2, 5.3).
const CHANNEL_TABLE_ALLOWLIST = Object.freeze({
  bch: 'bch_channels',
  region: 'region_channels'
});

// region_channels.tier (region-channel-tiers migration): REGION_CHANNEL_TIER_PREFIX
// (imported above from server/config/constants.js, shared with
// syncWorker.js) maps 'response'/'support' to the Authentik group-name
// prefix for that tier, and doubles as the validation set every insert
// path here checks a supplied tier against.

class GlobalChannelService {
  // bch-channel-category: `channelData.category` defaults to 'BCH' when
  // omitted (every pre-existing caller keeps working unchanged), and if
  // supplied must be one of `BCH_CHANNEL_CATEGORY_PREFIX`'s keys --
  // validated BEFORE any INSERT is attempted, mirroring
  // `createRegionChannel`'s tier-validation placement/shape exactly.
  async createBchChannel(channelData, createdBy) {
    const category = channelData.category || 'BCH';
    const categoryPrefix = BCH_CHANNEL_CATEGORY_PREFIX[category];
    if (!categoryPrefix) {
      throw new Error("Invalid channel category: must be 'BCH' or 'UTL'");
    }

    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Generate service account credentials
      const serviceAccountUsername = `etl-${channelData.name.toLowerCase().replace(/\s+/g, '-')}`;
      const serviceAccountPassword = crypto.randomBytes(16).toString('hex');

      // Requirement 6.1: encrypt the password before it is persisted to the
      // bch_channels.service_account_password column. Only the DATABASE
      // COLUMN value is encrypted here — the plaintext serviceAccountPassword
      // is still sent to Authentik (below, via EventPublisher.publishOperation)
      // since Authentik needs the real password to create the service account.
      const encryptedServiceAccountPassword = CredentialEncryptionService.encrypt(serviceAccountPassword);

      // Create BCH channel record. display_name is NOT NULL with no
      // default (see baseline schema) -- mirrors name, same as every other
      // channel-like table's name/display_name pair.
      const result = await client.query(`
        INSERT INTO bch_channels (
          name, display_name, description, service_account_username, 
          service_account_password, category, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `, [
        channelData.name,
        channelData.name,
        channelData.description,
        serviceAccountUsername,
        encryptedServiceAccountPassword,
        category,
        createdBy
      ]);
      
      const channelId = result.rows[0].id;
      
      // Queue operations to create Authentik groups and service account.
      // `category` is passed through so the Sync_Worker's
      // createBchChannelGroups handler names the groups with the correct
      // category prefix (tak_BCH.../tak_XtraTools...) without needing a
      // separate DB lookup, mirroring create_region_channel_group's
      // `tier` field.
      //
      // Bugfix: `description` was missing from this payload entirely, so
      // a freshly created BCH/UTL channel's Authentik groups carried no
      // `attributes.description` at all -- confirmed live for a UTL
      // channel that had never been edited (a BCH channel that HAD been
      // edited at least once picked one up via update_bch_channel_group,
      // which always DID pass description through, masking the gap for
      // BCH). `channelData.description` is already validated/stored on
      // the `bch_channels` row above; forwarding it here keeps create and
      // update symmetric.
      await EventPublisher.publishOperation('create_bch_channel_groups', {
        bch_channel_id: channelId,
        channel_name: channelData.name,
        category,
        description: channelData.description,
        service_account_username: serviceAccountUsername,
        service_account_password: serviceAccountPassword
      }, createdBy);
      
      // Add group membership rules for all users. The rule/pattern prefix
      // is category-derived (categoryPrefix), not the literal 'BCH', so a
      // UTL channel's rules correctly reference tak_XtraTools... groups.
      const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
      await client.query(`
        INSERT INTO group_membership_rules (
          rule_name, rule_type, source_type, source_id, 
          target_group_pattern, permission_type, priority
        ) VALUES 
        ($1, 'bch_channels', 'bch_channel', $2, $3, 'read', 50),
        ($4, 'bch_channels', 'bch_channel', $2, $5, 'write', 51)
      `, [
        `${categoryPrefix} ${channelData.name} Read Access`,
        channelId,
        `tak_${categoryPrefix}${separator}${channelData.name}_READ`,
        `${categoryPrefix} ${channelData.name} Write Access`,
        `tak_${categoryPrefix}${separator}${channelData.name}`
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

  // region-channel-tiers: `channelData.tier` must be 'response' or
  // 'support' -- validated BEFORE any INSERT is attempted, mirroring the
  // CHANNEL_TABLE_ALLOWLIST guard's placement/shape above. Every insert
  // path (this method and seedRegionChannels) supplies a tier explicitly;
  // there is no default, matching the migration's own column (no DEFAULT).
  async createRegionChannel(channelData, createdBy) {
    const tierPrefix = REGION_CHANNEL_TIER_PREFIX[channelData.tier];
    if (!tierPrefix) {
      throw new Error("Invalid channel tier: must be 'response' or 'support'");
    }

    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Create region channel record. display_name is NOT NULL with no
      // default (see baseline schema) -- mirrors name, same as every other
      // channel-like table's name/display_name pair.
      const result = await client.query(`
        INSERT INTO region_channels (
          name, display_name, description, tier, created_by
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `, [
        channelData.name,
        channelData.name,
        channelData.description,
        channelData.tier,
        createdBy
      ]);
      
      const channelId = result.rows[0].id;
      
      // Queue operation to create Authentik group. `tier` is passed
      // through so the Sync_Worker's createRegionChannelGroup handler
      // names the group with the correct tier prefix (tak_Response.../
      // tak_Support...) without needing a separate DB lookup.
      await EventPublisher.publishOperation('create_region_channel_group', {
        region_channel_id: channelId,
        channel_name: channelData.name,
        tier: channelData.tier
      }, createdBy);
      
      // Add a group membership rule for read-write access. Region channels
      // are a SINGLE Authentik group per channel (region_channels has only
      // a `group_id` column, no read/write pair like BCH channels) -- there
      // is no "_READ" counterpart group for regions in Authentik. The
      // target_group_pattern's prefix is tier-specific (tak_Response.../
      // tak_Support...), replacing the former single untiered tak_Regions
      // prefix.
      const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
      await client.query(`
        INSERT INTO group_membership_rules (
          rule_name, rule_type, source_type, source_id, 
          target_group_pattern, permission_type, priority
        ) VALUES 
        ($1, 'region_channels', 'region_channel', $2, $3, 'write', 61)
      `, [
        `Region ${channelData.name} Read-Write Access`,
        channelId,
        `tak_${tierPrefix}${separator}${channelData.name}`
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

  /**
   * region-channel-tiers: pre-seeds the standard set of Response/Support
   * region channels -- the 16 ISO 3166-2:NZ regions (both tiers) plus the
   * two Special_Regions (`server/config/regions.js`'s `SPECIAL_REGIONS`:
   * Chatham Islands, both tiers; All of New Zealand, support tier only),
   * for a total of 35 channels on a deployment with none of them yet.
   *
   * Idempotent, per-row: for each (name, tier) pair, a case-insensitive
   * existence check runs BEFORE that row's `createRegionChannel` call, so
   * re-running this after some rows already exist (e.g. a region was
   * added to the standing list later, or a prior seed run partially
   * failed) only fills the gaps -- it never duplicates an already-seeded
   * channel. Each row's creation is independent: one row's Authentik/DB
   * failure is logged and does not abort the remaining rows, mirroring
   * `assignUserToGlobalChannels`'s per-group "continue on failure" shape
   * elsewhere in this codebase.
   *
   * @param {number|null} createdBy - local `users.id` of the acting
   *   Global_Manager, recorded on every created row via the same
   *   `createRegionChannel` path a manual single-channel creation uses.
   * @returns {Promise<{created: number, skipped: number, failed: number}>}
   */
  async seedRegionChannels(createdBy) {
    // The full standard (name, tier) work list -- shared with
    // `getMissingRegionSeedItems` below via `buildRegionSeedWorkItems`, so
    // the two can never define "the standard set" differently.
    const workItems = buildRegionSeedWorkItems();

    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const { name, tier } of workItems) {
      try {
        const existing = await pool.query(
          'SELECT id FROM region_channels WHERE name ILIKE $1 AND tier = $2',
          [name, tier]
        );

        if (existing.rows.length > 0) {
          skipped++;
          continue;
        }

        // Bugfix: `description: name` alone was IDENTICAL for the
        // response and support row of the same region (both just
        // "Auckland"), giving a user no way to distinguish
        // "Response - Auckland" from "Support - Auckland" from the
        // description text alone. Appending the tier qualifier fixes
        // that for every SEEDED channel; a manually created region
        // channel's description remains entirely caller-supplied.
        const description = `${name} (${REGION_CHANNEL_TIER_DESCRIPTION_QUALIFIER[tier]})`;
        await this.createRegionChannel({ name, description, tier }, createdBy);
        created++;
      } catch (error) {
        failed++;
        logger.error({ err: error, name, tier }, 'Failed to seed region channel');
        // Continue with the remaining work items even if one fails.
      }
    }

    return { created, skipped, failed };
  }

  /**
   * region-channel-tiers (bugfix): reports whether any of the standard
   * (name, tier) seed set is still missing, so the client can hide its
   * "Seed Standard Region Channels" action once the set is complete --
   * it was previously shown UNCONDITIONALLY, with no way to tell it had
   * already been run, and no way to distinguish "run the standard seed"
   * from "manage further/custom region channels" once seeding is done.
   *
   * A single batched query against every (name, tier) pair, rather than
   * one query per work item -- `seedRegionChannels` itself still checks
   * per-row before each individual create (needed there for its own
   * per-row create-or-skip control flow), but this read-only check has
   * no such requirement and would be 35 round-trips otherwise.
   *
   * @returns {Promise<{missingCount: number, totalCount: number}>}
   */
  async getRegionSeedStatus() {
    const workItems = buildRegionSeedWorkItems();

    const existingResult = await pool.query(
      `SELECT name, tier FROM region_channels WHERE tier IS NOT NULL`
    );
    const existingKeys = new Set(
      existingResult.rows.map((row) => `${row.name.toLowerCase()}::${row.tier}`)
    );

    const missingCount = workItems.filter(
      ({ name, tier }) => !existingKeys.has(`${name.toLowerCase()}::${tier}`)
    ).length;

    return { missingCount, totalCount: workItems.length };
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

    const credentials = result.rows[0];

    // Requirement 6.2: decrypt only at response-build time (i.e. right
    // before returning to the caller), never earlier and never logged.
    try {
      credentials.service_account_password = CredentialEncryptionService.decrypt(
        credentials.service_account_password
      );
    } catch (err) {
      // Requirement 6.3: on decrypt failure, do not leak the ciphertext or
      // the underlying crypto error. Log the failure (without plaintext or
      // ciphertext) and throw a generic error reusing the decrypt service's
      // own generic message.
      logger.error({
        channelId,
        actorId: requestingUserId,
        event: 'credential_decrypt_failure'
      }, 'Failed to decrypt BCH service account credentials');
      throw new Error('Decryption failed');
    }

    // Requirement 6.2: log the access as an auditable event recording the
    // requesting user's identifier, the accessed channel's identifier, and
    // the access timestamp. The decrypted plaintext itself is never logged.
    logger.info({
      actorId: requestingUserId,
      channelId,
      event: 'credential_access',
      accessedAt: new Date().toISOString()
    }, 'BCH service account credentials accessed');

    return credentials;
  }

  async updateBchChannel(channelId, channelData, updatedBy) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // bch-channel-category: `category` is immutable after creation (like
      // region_channels.tier) -- there is no rename-category API, only
      // name/description edits -- so it is read back off the row rather
      // than accepted from the caller, and forwarded to the Sync_Operation
      // below so the worker's rename PATCH builds the correct
      // tak_BCH.../tak_XtraTools... group name for THIS row's actual category.
      const existingResult = await client.query(
        'SELECT category FROM bch_channels WHERE id = $1',
        [channelId]
      );
      const category = existingResult.rows[0]?.category || 'BCH';

      await client.query(`
        UPDATE bch_channels 
        SET name = $1, description = $2
        WHERE id = $3
      `, [channelData.name, channelData.description, channelId]);
      
      // Queue operation to update Authentik group
      await EventPublisher.publishOperation('update_bch_channel_group', {
        bch_channel_id: channelId,
        channel_name: channelData.name,
        category,
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
    const table = CHANNEL_TABLE_ALLOWLIST[channelType];
    if (!table) {
      throw new Error('Invalid channel type');
    }

    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
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

  async syncExistingChannels(syncedBy) {
    try {
      // Queue operation to sync existing channels from Authentik
      await EventPublisher.publishOperation('sync_existing_global_channels', {
        synced_by: syncedBy
      }, syncedBy);
      
      // Return success - actual sync happens asynchronously
      return { success: true };
      
    } catch (error) {
      throw error;
    }
  }

  async deactivateGlobalChannel(channelId, channelType, deactivatedBy) {
    const table = CHANNEL_TABLE_ALLOWLIST[channelType];
    if (!table) {
      throw new Error('Invalid channel type');
    }

    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
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