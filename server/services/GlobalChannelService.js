const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
const crypto = require('crypto');
const CredentialEncryptionService = require('./CredentialEncryptionService');
const authentikService = require('./authentik');
const logger = require('../config/logger').createLogger('GlobalChannelService');
const { REGION_CHANNEL_TIER_PREFIX, REGION_CHANNEL_TIER_DESCRIPTION_QUALIFIER, BCH_CHANNEL_CATEGORY_PREFIX } = require('../config/constants');
const { buildRegionSeedWorkItems } = require('../config/regions');
// Bugfix (service-account provisioning/naming): the single source of
// truth for the `etl-` prefix and the default-name derivation, shared by
// `createBchChannel` (a brand-new channel), `provisionServiceAccount`'s
// default-name path (a channel discovered via Sync Existing Channels,
// with no service account of its own yet), and `provisionServiceAccount`'s
// admin-supplied-name path (the "Add Service Account" dialog) -- all
// three can never disagree on the naming convention, since none of them
// builds or validates a username with its own inline logic.
const { buildDefaultServiceAccountUsername, isValidServiceAccountUsername } = require('../utils/serviceAccountUsername');

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
      const serviceAccountUsername = buildDefaultServiceAccountUsername(channelData.name);
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

    // Performance-hardening: one multi-row INSERT (chunked internally by
    // EventPublisher.publishOperationsBatch) instead of one INSERT per
    // user -- at the documented 50,000-user scale, the former issued
    // 50,000 sequential round trips before the Sync_Worker even started
    // draining the queue.
    await EventPublisher.publishOperationsBatch(
      'assign_user_to_global_channels',
      userIds.map((userId) => ({ target_user_id: userId, bulk_operation_id: bulkOpId }))
    );

    return { usersProcessed: userIds.length, bulkOperationId: bulkOpId };
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
    // Bugfix: this used to re-check Global_Manager status itself via
    // `SELECT is_global_manager FROM users WHERE id = $1` -- but
    // `users.is_global_manager` is a dead column nothing in this codebase
    // ever writes (the live flag is `user_cache.is_admin`, aliased onto
    // `req.user.is_global_manager` by `server/middleware/auth.js` and
    // already checked by the `authorize` middleware via this route's
    // `global_channel:credentials` Permission_Registry entry -- see
    // `globalChannels.js`). That made this re-check always false, 403ing
    // every real Global_Manager unconditionally. `authorize` already
    // gates this method's only caller, so the check is redundant, not
    // just broken -- removed rather than repaired against the live
    // column, per the server-conventions rule that authorization checks
    // belong in `authorize.js`'s resolvers, not duplicated inline in a
    // service.
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
    } catch {
      // Requirement 6.3: on decrypt failure, do not leak the ciphertext or
      // the underlying crypto error (not even as `cause`). Log the
      // failure (without plaintext or ciphertext) and throw a generic
      // error reusing the decrypt service's own generic message.
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

  /**
   * Bugfix (collision/takeover risk): checks whether `username` is safe
   * to provision as a NEW service account for `channelId`, i.e. whether
   * creating it would collide with anything already using that exact
   * name. Two independent sources are checked, since a collision can
   * come from either:
   *
   *   1. Another `bch_channels` row already recorded as owning this
   *      username (any OTHER channel's `service_account_username`
   *      matching it, active or not -- an inactive/soft-deleted row's
   *      name is not free to reuse if its Authentik account was never
   *      actually cleaned up).
   *   2. Authentik itself already having a user with this username --
   *      REGARDLESS of what created it. This is deliberately not
   *      narrowed to "another service account" or "type=service_account
   *      only": a human's own login username is just as real a
   *      collision as another channel's service account, and the
   *      Sync_Worker's Create_Or_Reuse fallback (`provisionBchServiceAccount`)
   *      would reuse either one identically if this check didn't exist.
   *
   * `excludeChannelId` lets a caller re-checking the SAME channel it is
   * about to provision for skip source 1's self-match (relevant for a
   * future "rename before provisioning" flow; today's only caller,
   * `provisionServiceAccount`, always passes the channel it is
   * provisioning FOR, which by construction has no
   * `service_account_username` of its own yet -- so this exclusion is a
   * defensive no-op today, not yet exercised, but keeps the method's
   * contract correct for that future caller too).
   *
   * A Authentik lookup failure (network error, non-2xx) is NOT treated
   * as "available" -- fails closed, propagating the error, rather than
   * risking a takeover on an inconclusive check. This mirrors this
   * codebase's general "directory scope never falls back to unscoped on
   * error" posture (`DirectoryScopeService`): an inconclusive safety
   * check is not a pass.
   *
   * @param {string} username - a full username, e.g. `'etl-data-packages'`.
   * @param {number|string|null} [excludeChannelId] - a `bch_channels.id`
   *   to exclude from source 1's comparison.
   * @returns {Promise<{available: true} | {available: false, reason: string}>}
   */
  async checkServiceAccountUsernameAvailability(username, excludeChannelId = null) {
    const localConflictResult = await pool.query(`
      SELECT id, name
      FROM bch_channels
      WHERE service_account_username = $1 AND ($2::int IS NULL OR id <> $2)
    `, [username, excludeChannelId]);

    if (localConflictResult.rows.length > 0) {
      return {
        available: false,
        reason: `"${username}" is already the service account for another channel ("${localConflictResult.rows[0].name}")`
      };
    }

    const authentikUser = await authentikService.getUserByUsername(username);
    if (authentikUser) {
      return {
        available: false,
        reason: `"${username}" already exists in Authentik and cannot be reused for a new service account`
      };
    }

    return { available: true };
  }

  /**
   * Bugfix (a BCH/UTL channel imported via "Sync Existing Channels" has
   * no service account): `syncExistingGlobalChannels` (server/workers/
   * syncWorker.js) only ever discovers a channel's read/write GROUP pair
   * from Authentik's group list -- it has no way to discover or create a
   * service account, since Authentik's group-list API carries no
   * password to capture even if a same-named service account happened to
   * already exist. This method is the missing "provision one now" action
   * for exactly that gap: a channel whose row already exists (created by
   * either path) but has no `service_account_username` yet.
   *
   * Mirrors `createBchChannel`'s own credential-generation shape
   * exactly -- same random password, same encrypt-before-persist
   * ordering, same plaintext-in-payload handoff to the Sync_Worker
   * (which needs the real password to set it in Authentik). Unlike
   * `createBchChannel`, this UPDATEs an existing row rather than
   * INSERTing a new one, and the enqueued operation must reuse the
   * channel's ALREADY-KNOWN `read_group_id`/`write_group_id` (present on
   * every BCH/UTL row, whichever path created it) so the Sync_Worker
   * handler can add the new service account to both without a second
   * database round trip of its own.
   *
   * The username is either the channel-name-derived default
   * (`buildDefaultServiceAccountUsername`, matching `createBchChannel`'s
   * own behaviour) or an admin-supplied custom name from the "Add
   * Service Account" dialog -- both go through
   * `isValidServiceAccountUsername`'s `etl-` prefix requirement, so
   * every service account this app ever creates is guaranteed to start
   * with that literal prefix regardless of which path named it.
   *
   * @param {number|string} channelId
   * @param {number} requestingUserId - local `users.id`, attributed as
   *   `sync_operations.created_by` and the audit log's actor (written by
   *   the caller route, not here).
   * @param {string|null} [customUsername] - an admin-supplied name from
   *   the "Add Service Account" dialog, validated against
   *   `isValidServiceAccountUsername` (must start with `etl-`) before
   *   use. When omitted/null, falls back to the channel-name-derived
   *   default, exactly as before this parameter existed.
   * @returns {Promise<{serviceAccountUsername: string}>}
   * @throws {Error} 'BCH channel not found' when no active row matches
   *   `channelId`.
   * @throws {Error} 'This channel already has a service account
   *   configured' when `service_account_username` is already set --
   *   provisioning never overwrites an existing service account; use the
   *   channel's own edit path if a genuine replacement is ever needed.
   * @throws {Error} "Service account username must start with \"etl-\"
   *   and contain only lowercase letters, digits and hyphens after the
   *   prefix" when `customUsername` is supplied but invalid.
   */
  async provisionServiceAccount(channelId, requestingUserId, customUsername = null) {
    // Validated BEFORE ever connecting to the database, mirroring
    // `createBchChannel`'s/`createRegionChannel`'s own
    // validate-before-any-INSERT placement -- a bad custom name should
    // never even open a transaction.
    if (customUsername != null && !isValidServiceAccountUsername(customUsername)) {
      throw new Error('Service account username must start with "etl-" and contain only lowercase letters, digits and hyphens after the prefix');
    }

    // A preliminary (non-locking) read: fails fast on the two conditions
    // that don't need a transaction at all, and gives the DEFAULT-name
    // path (no customUsername) the channel's own name to derive a
    // candidate from -- needed before the availability check below, so
    // that check can cover the auto-derived name too, not just an
    // admin-typed one (two channels of different categories sharing a
    // display name, e.g. a BCH and a UTL "Data Packages", derive the
    // IDENTICAL default username, since category isn't part of the
    // slug -- this is a real, not just hypothetical, collision source).
    const precheckResult = await pool.query(`
      SELECT name, service_account_username
      FROM bch_channels
      WHERE id = $1 AND is_active = true
    `, [channelId]);

    if (precheckResult.rows.length === 0) {
      throw new Error('BCH channel not found');
    }
    if (precheckResult.rows[0].service_account_username) {
      throw new Error('This channel already has a service account configured');
    }

    const candidateUsername = customUsername || buildDefaultServiceAccountUsername(precheckResult.rows[0].name);

    // Bugfix (collision/takeover risk): the candidate username -- default
    // OR custom -- must be checked for availability BEFORE anything is
    // written or enqueued, and before a database transaction/row lock is
    // ever opened (this check makes a real Authentik HTTP call, which
    // should not run while holding a `FOR UPDATE` lock). Without this,
    // `provisionBchServiceAccount`'s own Create_Or_Reuse fallback in the
    // Sync_Worker would happily "reuse" (reset the password of, and add
    // to this channel's read/write groups) ANY pre-existing Authentik
    // account with a matching username -- another channel's service
    // account, or an unrelated human/service account entirely -- and
    // report success either way, with no indication a takeover just
    // happened. See `checkServiceAccountUsernameAvailability`'s own doc
    // comment for exactly what it checks.
    const availability = await this.checkServiceAccountUsernameAvailability(candidateUsername, channelId);
    if (!availability.available) {
      throw new Error(availability.reason);
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Re-read WITH the row lock inside the transaction: the
      // availability check above ran against a point-in-time snapshot,
      // with no lock held, so a concurrent request could have changed
      // either fact in between. Re-checking both conditions here closes
      // that race rather than trusting the precheck's now-possibly-stale
      // answer.
      const existingResult = await client.query(`
        SELECT name, service_account_username, read_group_id, write_group_id
        FROM bch_channels
        WHERE id = $1 AND is_active = true
        FOR UPDATE
      `, [channelId]);

      if (existingResult.rows.length === 0) {
        throw new Error('BCH channel not found');
      }

      const channel = existingResult.rows[0];

      if (channel.service_account_username) {
        throw new Error('This channel already has a service account configured');
      }

      const serviceAccountUsername = candidateUsername;
      const serviceAccountPassword = crypto.randomBytes(16).toString('hex');
      const encryptedServiceAccountPassword = CredentialEncryptionService.encrypt(serviceAccountPassword);

      await client.query(`
        UPDATE bch_channels
        SET service_account_username = $1, service_account_password = $2
        WHERE id = $3
      `, [serviceAccountUsername, encryptedServiceAccountPassword, channelId]);

      // The Sync_Worker handler needs both group ids to add the new
      // service account to each -- read AND write access, per explicit
      // product requirement -- without a second lookup of its own. A
      // null group id is OMITTED from the payload entirely (never passed
      // through as the literal `null`), mirroring `Team.delete`'s own
      // `remove_team_channel_group` enqueue: `operationSchemas.js`'s
      // optional-field type check only skips a field that is `undefined`,
      // and `typeof null === 'object'` would otherwise fail it against
      // this field's declared `'string'` type for a channel whose sibling
      // write group was never found in Authentik.
      const payload = {
        bch_channel_id: Number(channelId),
        service_account_username: serviceAccountUsername,
        service_account_password: serviceAccountPassword
      };
      if (channel.read_group_id != null) {
        payload.read_group_id = channel.read_group_id;
      }
      if (channel.write_group_id != null) {
        payload.write_group_id = channel.write_group_id;
      }
      await EventPublisher.publishOperation('provision_bch_service_account', payload, requestingUserId, client);

      await client.query('COMMIT');
      return { serviceAccountUsername };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Rotates a BCH/UTL channel's existing service account password.
   * Generates a fresh random password, encrypts and persists it in the
   * SAME UPDATE as `provisionServiceAccount`'s own create path, and
   * enqueues a Sync_Worker operation carrying the plaintext so Authentik
   * can be updated to match -- mirroring `provisionServiceAccount`'s
   * encrypt-then-enqueue-plaintext ordering exactly. The username and
   * group ids are unchanged by a rotation; only the password moves.
   *
   * @param {number|string} channelId
   * @param {number} requestingUserId - local `users.id`, attributed as
   *   `sync_operations.created_by` and the audit log's actor (written by
   *   the caller route, not here).
   * @returns {Promise<{serviceAccountUsername: string}>}
   * @throws {Error} 'BCH channel not found' when no active row matches
   *   `channelId`.
   * @throws {Error} 'This channel has no service account to rotate' when
   *   `service_account_username` is not set -- there is nothing in
   *   Authentik for a rotation to update; provision one first.
   */
  async rotateServiceAccountPassword(channelId, requestingUserId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const existingResult = await client.query(`
        SELECT service_account_username
        FROM bch_channels
        WHERE id = $1 AND is_active = true
        FOR UPDATE
      `, [channelId]);

      if (existingResult.rows.length === 0) {
        throw new Error('BCH channel not found');
      }

      const { service_account_username: serviceAccountUsername } = existingResult.rows[0];

      if (!serviceAccountUsername) {
        throw new Error('This channel has no service account to rotate');
      }

      const newPassword = crypto.randomBytes(16).toString('hex');
      const encryptedPassword = CredentialEncryptionService.encrypt(newPassword);

      await client.query(`
        UPDATE bch_channels
        SET service_account_password = $1
        WHERE id = $2
      `, [encryptedPassword, channelId]);

      await EventPublisher.publishOperation('rotate_bch_service_account_password', {
        bch_channel_id: Number(channelId),
        service_account_username: serviceAccountUsername,
        service_account_password: newPassword
      }, requestingUserId, client);

      await client.query('COMMIT');
      return { serviceAccountUsername };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Deletes a BCH/UTL channel's service account -- the Authentik user
   * plus this app's own record of it -- WITHOUT touching the channel's
   * read/write groups or the channel row itself. A channel with its
   * service account removed reverts to exactly the "discovered, no
   * service account" state `provisionServiceAccount`/the "Add Service
   * Account" dialog already handle, so it can be re-provisioned or given
   * a new custom-named account afterwards.
   *
   * Clears the local `service_account_id`/`service_account_username`/
   * `service_account_password` columns IMMEDIATELY (inside this same
   * transaction), rather than waiting for the Sync_Worker to confirm the
   * Authentik-side delete -- mirroring this app's `account_status =
   * 'orphaned'` convention elsewhere of updating the local, authoritative
   * record synchronously and letting the asynchronous cleanup catch up.
   * The enqueued operation carries the Authentik user id/username so the
   * Sync_Worker can still delete the real Authentik account even though
   * the local columns no longer reference it.
   *
   * @param {number|string} channelId
   * @param {number} requestingUserId - local `users.id`, attributed as
   *   `sync_operations.created_by` and the audit log's actor (written by
   *   the caller route, not here).
   * @returns {Promise<{serviceAccountUsername: string}>} the username
   *   that was removed, so the caller route can log it before it's gone.
   * @throws {Error} 'BCH channel not found' when no active row matches
   *   `channelId`.
   * @throws {Error} 'This channel has no service account to delete' when
   *   `service_account_username` is not set already.
   */
  async deleteServiceAccount(channelId, requestingUserId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const existingResult = await client.query(`
        SELECT service_account_id, service_account_username
        FROM bch_channels
        WHERE id = $1 AND is_active = true
        FOR UPDATE
      `, [channelId]);

      if (existingResult.rows.length === 0) {
        throw new Error('BCH channel not found');
      }

      const { service_account_id: serviceAccountId, service_account_username: serviceAccountUsername } = existingResult.rows[0];

      if (!serviceAccountUsername) {
        throw new Error('This channel has no service account to delete');
      }

      await client.query(`
        UPDATE bch_channels
        SET service_account_id = NULL, service_account_username = NULL, service_account_password = NULL
        WHERE id = $1
      `, [channelId]);

      // `service_account_id` (the Authentik user pk) is preferred when
      // present -- an exact id lookup needs no username-based search on
      // the Sync_Worker side -- but a channel provisioned before
      // `service_account_id` was ever populated (or one where the
      // create/provision operation is still queued) may only have the
      // username. Both are passed through when known; the Sync_Worker
      // handler falls back to a username lookup when the id is absent.
      const payload = {
        bch_channel_id: Number(channelId),
        service_account_username: serviceAccountUsername
      };
      if (serviceAccountId != null) {
        payload.service_account_id = serviceAccountId;
      }
      await EventPublisher.publishOperation('delete_bch_service_account', payload, requestingUserId, client);

      await client.query('COMMIT');
      return { serviceAccountUsername };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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

  /**
   * Enqueues a `sync_existing_global_channels` Sync_Operation, handled by
   * `SyncWorker.syncExistingGlobalChannels` (`server/workers/syncWorker.js`).
   * That handler fetches every Authentik group, recognises BCH/UTL and
   * Region channel groups by their naming convention, and for each one
   * either INSERTs a new local row (a group Authentik has that this app
   * does not yet know about) or UPDATEs an existing row's
   * description/group id(s) to match Authentik.
   *
   * Deliberately one-directional, by design, not an oversight: this sync
   * NEVER deletes or deactivates a local `bch_channels`/`region_channels`
   * row whose corresponding Authentik group is absent from the fetched
   * list. A channel row missing from that list could mean either "this
   * channel's group was genuinely removed in Authentik" or "the fetch
   * only returned a partial/incomplete group list" (a paging bug, an
   * Authentik outage mid-request, or a permissions change on the token
   * this app uses) -- and those two cases are indistinguishable from
   * this side. Auto-deleting on the strength of an absence would risk
   * silently destroying a channel (and, transitively, every BCH service
   * account credential and Region group-membership rule attached to it)
   * because of a transient or partial fetch, which is a far worse
   * failure mode than leaving a stale row for an admin to notice and
   * remove explicitly via `deleteGlobalChannel`/`deactivateGlobalChannel`
   * above. This mirrors the same asymmetry `DeviceSync`/`SubscriptionPoller`
   * document for their own upstream-absence handling (server-conventions
   * steering: "an upstream outage that reads as empty must not wipe a
   * table").
   *
   * @param {number} syncedBy
   * @returns {Promise<{success: true}>}
   */
  async syncExistingChannels(syncedBy) {
    // Queue operation to sync existing channels from Authentik
    await EventPublisher.publishOperation('sync_existing_global_channels', {
      synced_by: syncedBy
    }, syncedBy);

    // Return success - actual sync happens asynchronously
    return { success: true };
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