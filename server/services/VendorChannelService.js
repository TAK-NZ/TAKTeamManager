const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
const logger = require('../config/logger').createLogger('VendorChannelService');

/**
 * Thrown by `createVendorChannel` when an active `vendor_channels` row
 * already exists (Requirement 21 Criterion 11 — the Vendor_Channel is a
 * singleton: at most one row may have `is_active = true` at any time).
 *
 * Mirrors the shape of a small, named error class used elsewhere in the
 * codebase (e.g. task 35.6's channel-limit error) so callers (route
 * handlers) can distinguish "an active Vendor_Channel already exists"
 * from any other failure and respond with a clear, specific error
 * message rather than a generic 500.
 */
class VendorChannelAlreadyActiveError extends Error {
  constructor(message = 'An active Vendor_Channel already exists') {
    super(message);
    this.name = 'VendorChannelAlreadyActiveError';
  }
}

/**
 * Thrown by `setVendorFlag(targetUserId, true, ...)` when no
 * `vendor_channels` row with `is_active = true` exists (Requirement 21
 * Criterion 12 — setting a user's `is_vendor` flag to `true` requires an
 * active Vendor_Channel to assign them to; without one there is no `VND`
 * Authentik group to add the user to). Callers (route handlers) should
 * treat this as a 400-equivalent client error, not a 500.
 */
class VendorChannelNotActiveError extends Error {
  constructor(message = 'No active Vendor_Channel exists') {
    super(message);
    this.name = 'VendorChannelNotActiveError';
  }
}

/**
 * Thrown by `setVendorFlag(targetUserId, true, ...)` when an active
 * `vendor_channels` row exists but its `authentik_group_id` is still
 * `NULL`. This happens when the `create_vendor_channel_group`
 * Sync_Operation enqueued by `createVendorChannel` (task 40.1) has not
 * yet been processed by the Sync_Worker -- the row is active, but the
 * corresponding Authentik `VND` group doesn't exist yet (or its id
 * hasn't been written back to the row), so there is no valid
 * `target_group_id` to enqueue an `add_user_to_group` operation with
 * (the `add_user_to_group`/`remove_user_from_group` payload schemas in
 * `operationSchemas.js` require `target_group_id` to be a non-null
 * `string`). Rather than silently enqueueing an operation with a
 * null/invalid group id (which would either fail schema validation
 * permanently or, worse, be coerced into some other value), this design
 * rejects the request outright with a clear, retryable-by-the-caller
 * error message. Callers (route handlers) should treat this as a
 * 400-equivalent client error, not a 500.
 */
class VendorChannelProvisioningPendingError extends Error {
  constructor(message = 'Vendor channel group is still being provisioned, try again shortly') {
    super(message);
    this.name = 'VendorChannelProvisioningPendingError';
  }
}

/**
 * Thrown by `createGrant(vendorUserId, ...)` when the target user's
 * `is_vendor` flag is not `true` (Requirement 21 Criterion 8). Checked
 * FIRST, before any `vendor_channel_grants` row is inserted or anything
 * else is mutated -- a 400-equivalent client error, not a 500.
 */
class TargetUserNotVendorError extends Error {
  constructor(message = 'Target user is not a Vendor_User (is_vendor is not true)') {
    super(message);
    this.name = 'TargetUserNotVendorError';
  }
}

/**
 * Thrown by `createGrant`/`revokeGrant` (via `resolveChannelGroupId`)
 * when the given `channelId` does not correspond to a row in ANY of the
 * four candidate channel-like tables (`bch_channels`, `region_channels`,
 * `deployment_channels`, `vendor_channels`) -- see this file's
 * `resolveChannelGroupId` doc comment for the full reasoning behind
 * checking all four tables. A 400-equivalent client error, not a 500.
 */
class ChannelNotFoundError extends Error {
  constructor(channelId) {
    super(`Channel ${channelId} was not found in any channel-like table`);
    this.name = 'ChannelNotFoundError';
  }
}

/**
 * Thrown by `createGrant`/`revokeGrant` (via `resolveChannelGroupId`)
 * when the resolved channel row exists but its Authentik group id
 * column is still `NULL` -- i.e. the channel's own creation
 * Sync_Operation (`create_bch_channel_groups`/
 * `create_region_channel_group`/`create_deployment_channel_group`/
 * `create_vendor_channel_group`) has not yet been processed by the
 * Sync_Worker, mirroring `VendorChannelProvisioningPendingError`'s
 * reasoning for the `vendor_channels` case specifically. A
 * 400-equivalent, retryable-by-the-caller client error, not a 500.
 */
class ChannelGroupNotProvisionedError extends Error {
  constructor(channelId) {
    super(`Channel ${channelId}'s Authentik group is still being provisioned, try again shortly`);
    this.name = 'ChannelGroupNotProvisionedError';
  }
}

/**
 * Thrown by `revokeGrant(grantId, ...)` when no `vendor_channel_grants`
 * row with that id exists, or when it exists but is already revoked
 * (`revoked_at IS NOT NULL`). Requirement 21 Criterion 5 only speaks of
 * revoking an ACTIVE grant (`revoked_at IS NULL`) before its
 * `expires_at`; both "not found" and "already revoked" are collapsed
 * into this single error (rather than two separate classes) because
 * from the caller's perspective the outcome is identical either way:
 * there is no active grant with that id to revoke, no mutation occurs,
 * and this is a 400-equivalent client error, not a 500.
 */
class VendorChannelGrantNotActiveError extends Error {
  constructor(message = 'No active Vendor_Channel_Grant with that id exists') {
    super(message);
    this.name = 'VendorChannelGrantNotActiveError';
  }
}

/**
 * The four candidate channel-like tables a Vendor_Channel_Grant's
 * `channel_id` may reference, given that column's deliberately
 * polymorphic, no-hard-FK design -- see
 * `1786720000000_create-vendor-channel-grants.cjs`'s file-level "channel_id
 * FK target reasoning" comment for the full explanation. Per that
 * reasoning, a Vendor_User (who by design has no team membership,
 * Requirement 21 Criterion 2) can only realistically be granted access to
 * `bch_channels`, `region_channels`, `deployment_channels`, or
 * `vendor_channels` itself -- never the team-scoped `channels` table.
 *
 * `design.md`'s 4-arg `createGrant(vendorUserId, channelId, grantedBy,
 * expiresAt)` signature carries no `channelType` discriminator, so
 * `resolveChannelGroupId` (below) resolves which table a given
 * `channelId` belongs to, and that table's Authentik group id, by
 * checking each candidate table in turn and returning the first match.
 *
 * Each entry names the table and a SQL expression selecting that
 * table's "the channel's Authentik group" column:
 *   - `bch_channels` has two group-id columns (`read_group_id` /
 *     `write_group_id`, see the baseline schema). Requirement 21
 *     Criteria 4-5 speak of a single "target Channel's Authentik group"
 *     with no read/write distinction, so this resolves to
 *     `write_group_id` (falling back to `read_group_id` if a channel
 *     was only ever provisioned with read access) as the more complete
 *     access level -- a design decision made here since neither
 *     requirements.md nor design.md's Section 17 calls out a
 *     BCH-specific read-vs-write choice for vendor grants.
 *   - `region_channels` has a single `group_id` column.
 *   - `deployment_channels` and `vendor_channels` each have a single
 *     `authentik_group_id` column (named explicitly by Requirements 21
 *     Criterion 10 and 22 Criterion 1).
 *
 * Table names here are fixed literals from this frozen array, never
 * caller-controlled, so interpolating them into a query string carries
 * none of the SQL-injection risk Requirement 5.1-5.3 guards against for
 * genuinely dynamic/caller-supplied identifiers (e.g.
 * `GlobalChannelService.deleteGlobalChannel`'s `channelType` parameter).
 */
const CHANNEL_TABLES = Object.freeze([
  { table: 'bch_channels', groupIdExpr: 'COALESCE(write_group_id, read_group_id)' },
  { table: 'region_channels', groupIdExpr: 'group_id' },
  { table: 'deployment_channels', groupIdExpr: 'authentik_group_id' },
  { table: 'vendor_channels', groupIdExpr: 'authentik_group_id' }
]);

/**
 * Sentinel `users.id`-shaped value written to `vendor_channel_grants
 * .revoked_by` (and `audit_logs.user_id`) by `expireGrants` (below) to
 * mark a grant as revoked BY THE SYSTEM (an automated expiry sweep)
 * rather than by a specific Global_Manager, per design.md Section 17
 * and Requirement 21 Criterion 7 -- distinguishing automated
 * expiry-driven revocation from `revokeGrant`'s manual revocation
 * (which always records a real, positive `users.id`). No real user row
 * can ever have `id = -1` (the `users.id` column is a standard
 * auto-incrementing serial starting at 1), so this value is
 * unambiguous and requires no schema change (no nullable FK, no
 * separate boolean flag) to represent "the system did this".
 */
const SYSTEM_USER_ID = -1;

/**
 * VendorChannelService mirrors GlobalChannelService's shape (design.md
 * Section 17): each write method acquires a client, runs the local
 * database write(s) inside a single BEGIN/COMMIT transaction, and
 * enqueues the corresponding Sync_Operation via
 * `EventPublisher.publishOperation` before committing, following the
 * transactional create-then-enqueue pattern already used by
 * `GlobalChannelService.createBchChannel`/`createRegionChannel`.
 *
 * This task (40.3) adds `createGrant`/`revokeGrant`.
 * `expireGrants` is out of scope here and lands in a later task (40.4).
 */
class VendorChannelService {
  /**
   * Creates the singleton Vendor_Channel row (Requirement 21 Criterion
   * 10) and enqueues a `create_vendor_channel_group` Sync_Operation to
   * create the corresponding Authentik `VND` group.
   *
   * Rejects with a `VendorChannelAlreadyActiveError` if an
   * `is_active = true` row already exists (Requirement 21 Criterion 11).
   * This is checked explicitly, with a `SELECT ... FOR UPDATE` inside the
   * same transaction as the INSERT, so the check-then-insert is atomic
   * with respect to any other concurrent `createVendorChannel` call: the
   * `SELECT ... FOR UPDATE` takes a row lock on any existing active row,
   * serializing concurrent callers, so a second caller's SELECT (after
   * the first commits) will see the newly inserted active row and reject
   * cleanly rather than racing to insert a second one. The database's own
   * partial unique index (`idx_vendor_channels_one_active`, added by the
   * migration behind task 39.2) remains the ultimate, authoritative
   * enforcement mechanism regardless of this pre-check (e.g. it would
   * still reject a concurrent INSERT even if the SELECT-based guard were
   * ever bypassed), so this pre-check exists purely to translate that
   * DB-level rejection into a clear, specific application error instead
   * of a raw unique-violation error bubbling up to the caller.
   *
   * @param {number} createdBy - the Global_Manager user id creating the channel.
   * @returns {Promise<{channelId: number}>}
   */
  async createVendorChannel(createdBy) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Pre-check: reject if an active Vendor_Channel already exists.
      // FOR UPDATE takes a row lock on any existing active row so a
      // concurrent caller blocks here until this transaction commits or
      // rolls back, rather than both callers passing the check and
      // racing on the INSERT (which the DB's partial unique index would
      // still catch, but with a less specific error).
      const existing = await client.query(
        'SELECT id FROM vendor_channels WHERE is_active = true FOR UPDATE'
      );

      if (existing.rows.length > 0) {
        throw new VendorChannelAlreadyActiveError();
      }

      const result = await client.query(
        `INSERT INTO vendor_channels (created_by)
         VALUES ($1)
         RETURNING id`,
        [createdBy]
      );

      const channelId = result.rows[0].id;

      await EventPublisher.publishOperation(
        'create_vendor_channel_group',
        { vendor_channel_id: channelId },
        createdBy,
        client
      );

      await client.query('COMMIT');

      logger.info(
        { channelId, createdBy },
        'Vendor channel created'
      );

      return { channelId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Sets or clears a target user's `is_vendor` flag (Requirement 21
   * Criteria 1-2, 12). Global_Manager-only authorization is enforced at
   * the route/Permission_Registry layer, not inside this method (mirrors
   * `GlobalChannelService.createBchChannel`/`createRegionChannel`, which
   * likewise assume the caller has already been authorized).
   *
   * Setting `isVendor = true`:
   *   1. Requires an active `vendor_channels` row to exist (else rejects
   *      with `VendorChannelNotActiveError`, a 400-equivalent, WITHOUT
   *      mutating `users.is_vendor` or enqueueing anything -- Req 21.12).
   *   2. Requires that active row's `authentik_group_id` to be non-null
   *      (else rejects with `VendorChannelProvisioningPendingError`; see
   *      that class's doc comment for why). This check exists because
   *      `authentik_group_id` is populated asynchronously by the
   *      Sync_Worker processing the `create_vendor_channel_group`
   *      operation enqueued by `createVendorChannel` -- there is a window
   *      where the active row exists but its group id is still `NULL`.
   *   3. Sets `users.is_vendor = true`.
   *   4. Enqueues `add_user_to_group` for the `VND` group ONLY (Req
   *      21.2 -- no team/region/global-channel assignment path is
   *      invoked here, unlike `UserProvisioningService`/
   *      `TeamMembershipService`'s broader assignment logic).
   *
   * Setting `isVendor = false`:
   *   Requirements.md Requirement 21 has no criterion describing what
   *   happens when the flag is cleared, so this design choice is made
   *   for completeness: `users.is_vendor` is set to `false`, and (if the
   *   active Vendor_Channel's `authentik_group_id` is known) a
   *   `remove_user_from_group` operation is enqueued for `VND`, so the
   *   user doesn't retain lingering Authentik group access after no
   *   longer being flagged as a vendor. Unlike the `true` path, a missing
   *   active row or a still-provisioning group id is NOT treated as an
   *   error here -- clearing the flag always succeeds; the group removal
   *   is simply skipped if there is no known group id to remove the user
   *   from (there would then be nothing to clean up in Authentik anyway).
   *
   * @param {number} targetUserId
   * @param {boolean} isVendor
   * @param {number} actingUserId - the Global_Manager performing the change.
   * @returns {Promise<{success: boolean}>}
   */
  async setVendorFlag(targetUserId, isVendor, actingUserId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      if (isVendor) {
        // Requirement 21 Criterion 12: reject (without mutating anything)
        // if no active Vendor_Channel exists.
        const activeChannel = await client.query(
          'SELECT id, authentik_group_id FROM vendor_channels WHERE is_active = true LIMIT 1'
        );

        if (activeChannel.rows.length === 0) {
          throw new VendorChannelNotActiveError();
        }

        const { authentik_group_id: authentikGroupId } = activeChannel.rows[0];

        // The active row exists but the Sync_Worker hasn't yet processed
        // (or hasn't yet finished processing) the create_vendor_channel_group
        // operation -- there is no valid target_group_id to enqueue with.
        if (!authentikGroupId) {
          throw new VendorChannelProvisioningPendingError();
        }

        await client.query('UPDATE users SET is_vendor = true WHERE id = $1', [targetUserId]);

        await EventPublisher.publishOperation(
          'add_user_to_group',
          {
            target_user_id: targetUserId,
            target_group_id: authentikGroupId
          },
          actingUserId,
          client
        );
      } else {
        await client.query('UPDATE users SET is_vendor = false WHERE id = $1', [targetUserId]);

        // Design decision (no explicit requirement covers this): remove
        // the user from the VND Authentik group when clearing the flag,
        // so access doesn't linger. Only enqueue if an active channel's
        // group id is actually known -- if it isn't, there is no group to
        // remove the user from.
        const activeChannel = await client.query(
          'SELECT authentik_group_id FROM vendor_channels WHERE is_active = true LIMIT 1'
        );

        const authentikGroupId = activeChannel.rows[0]?.authentik_group_id;

        if (authentikGroupId) {
          await EventPublisher.publishOperation(
            'remove_user_from_group',
            {
              target_user_id: targetUserId,
              target_group_id: authentikGroupId
            },
            actingUserId,
            client
          );
        }
      }

      await client.query('COMMIT');

      logger.info(
        { targetUserId, isVendor, actingUserId },
        'Vendor flag updated'
      );

      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Resolves a Vendor_Channel_Grant's polymorphic `channel_id` to the
   * table it belongs to and that channel's Authentik group id, by
   * checking each of the four candidate channel-like tables
   * (`CHANNEL_TABLES`, in order: `bch_channels`, `region_channels`,
   * `deployment_channels`, `vendor_channels`) for a row with that id,
   * returning the first match -- see `CHANNEL_TABLES`'s doc comment
   * above for the full reasoning.
   *
   * Rejects with `ChannelNotFoundError` if `channelId` matches no row in
   * any of the four tables, and with `ChannelGroupNotProvisionedError`
   * if a matching row is found but its Authentik group id column is
   * still `NULL` (the channel's own creation Sync_Operation hasn't been
   * processed by the Sync_Worker yet).
   *
   * Accepts an optional `client` so callers that already hold an open
   * transactional client (`createGrant`/`revokeGrant`, both below) can
   * pass it through and have this read run on that same
   * connection/transaction, rather than a second, independent
   * connection from the shared pool; it defaults to the shared `pool`
   * for standalone use.
   *
   * @param {number} channelId
   * @param {import('pg').Pool|import('pg').PoolClient} [client]
   * @returns {Promise<{table: string, groupId: string}>}
   */
  async resolveChannelGroupId(channelId, client = pool) {
    for (const { table, groupIdExpr } of CHANNEL_TABLES) {
      // `table` and `groupIdExpr` are both fixed literals from the
      // frozen CHANNEL_TABLES array above, never caller-controlled, so
      // this interpolation carries none of the dynamic-identifier risk
      // Requirement 5.1-5.3 guards against.
      const result = await client.query(
        `SELECT ${groupIdExpr} AS group_id FROM ${table} WHERE id = $1`,
        [channelId]
      );

      if (result.rows.length > 0) {
        const groupId = result.rows[0].group_id;

        if (!groupId) {
          throw new ChannelGroupNotProvisionedError(channelId);
        }

        return { table, groupId };
      }
    }

    throw new ChannelNotFoundError(channelId);
  }

  /**
   * Creates a Vendor_Channel_Grant recording that a Vendor_User has been
   * granted access to a specific non-team Channel (Requirement 21
   * Criteria 3-4, 8-9). Global_Manager-only authorization is enforced at
   * the route/Permission_Registry layer, not inside this method (mirrors
   * `createVendorChannel`/`setVendorFlag`).
   *
   * Order of operations, all inside one transaction on one acquired
   * client:
   *   1. Requirement 21 Criterion 8: validate the target user's
   *      `is_vendor` flag is `true` FIRST -- rejects with
   *      `TargetUserNotVendorError` (a 400-equivalent) WITHOUT inserting
   *      a `vendor_channel_grants` row or mutating anything else, if it
   *      is not.
   *   2. Resolve `channelId`'s Authentik group id via
   *      `resolveChannelGroupId` (see its doc comment for the polymorphic
   *      `channel_id` resolution strategy).
   *   3. Insert the `vendor_channel_grants` row.
   *   4. Enqueue `add_user_to_group` for the resolved group.
   *   5. Requirement 21 Criterion 9: write an `audit_logs` row
   *      identifying the acting (granting) user, the affected
   *      Vendor_User, the affected Channel, and the action taken.
   *
   * @param {number} vendorUserId - the target Vendor_User's user id.
   * @param {number} channelId - the target Channel's id (polymorphic;
   *   see `resolveChannelGroupId`).
   * @param {number} grantedBy - the granting Global_Manager's user id.
   * @param {string|Date|null} [expiresAt] - optional bound; omitted/null
   *   means "until manually revoked" per Requirement 21 Criterion 3.
   * @returns {Promise<{grantId: number}>}
   */
  async createGrant(vendorUserId, channelId, grantedBy, expiresAt = null) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Requirement 21 Criterion 8: validate is_vendor FIRST, before any
      // mutation (row insert, enqueue, or audit log write).
      const userResult = await client.query('SELECT is_vendor FROM users WHERE id = $1', [
        vendorUserId
      ]);

      if (!userResult.rows[0]?.is_vendor) {
        throw new TargetUserNotVendorError();
      }

      const { groupId: authentikGroupId } = await this.resolveChannelGroupId(channelId, client);

      const grantResult = await client.query(
        `INSERT INTO vendor_channel_grants (user_id, channel_id, granted_by, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [vendorUserId, channelId, grantedBy, expiresAt || null]
      );

      const grantId = grantResult.rows[0].id;

      await EventPublisher.publishOperation(
        'add_user_to_group',
        {
          target_user_id: vendorUserId,
          target_group_id: authentikGroupId
        },
        grantedBy,
        client
      );

      // Requirement 21 Criterion 9: audit_logs row identifying the
      // acting user, the affected Vendor_User, the affected Channel, and
      // the action taken.
      await client.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          grantedBy,
          'vendor_channel_grant_created',
          'vendor_channel_grant',
          grantId,
          JSON.stringify({ vendorUserId, channelId })
        ]
      );

      await client.query('COMMIT');

      logger.info(
        { grantId, vendorUserId, channelId, grantedBy },
        'Vendor channel grant created'
      );

      return { grantId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Revokes an active Vendor_Channel_Grant (Requirement 21 Criteria 5,
   * 9). Global_Manager-only authorization is enforced at the
   * route/Permission_Registry layer, not inside this method.
   *
   * Requirement 21 Criterion 5 only speaks of revoking an ACTIVE grant
   * (`revoked_at IS NULL`) before its `expires_at` -- this method does
   * not additionally check `expires_at` itself, since a grant that has
   * already passed its `expires_at` but hasn't yet been swept up by the
   * automated `expireGrants()` process (task 40.4) is still, in every
   * observable sense, an active/unrevoked grant; there is no harm in a
   * Global_Manager manually revoking it a little early. The
   * `revoked_at IS NULL` check is the operative precondition.
   *
   * The grant lookup uses `SELECT ... FOR UPDATE` so a concurrent
   * `revokeGrant`/`expireGrants` call targeting the same row blocks
   * until this transaction commits or rolls back, rather than both
   * callers reading `revoked_at IS NULL` as true and racing to both
   * "successfully" revoke (and both enqueue a `remove_user_from_group`
   * operation).
   *
   * Rejects with `VendorChannelGrantNotActiveError` (a 400-equivalent,
   * no mutation) if no row with that id exists, or if it exists but is
   * already revoked.
   *
   * @param {number} grantId
   * @param {number} revokedBy - the revoking Global_Manager's user id.
   * @returns {Promise<{success: boolean}>}
   */
  async revokeGrant(grantId, revokedBy) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const grantResult = await client.query(
        `SELECT id, user_id, channel_id FROM vendor_channel_grants
         WHERE id = $1 AND revoked_at IS NULL
         FOR UPDATE`,
        [grantId]
      );

      if (grantResult.rows.length === 0) {
        throw new VendorChannelGrantNotActiveError();
      }

      const { user_id: vendorUserId, channel_id: channelId } = grantResult.rows[0];

      const { groupId: authentikGroupId } = await this.resolveChannelGroupId(channelId, client);

      await client.query(
        `UPDATE vendor_channel_grants
         SET revoked_at = NOW(), revoked_by = $1
         WHERE id = $2`,
        [revokedBy, grantId]
      );

      await EventPublisher.publishOperation(
        'remove_user_from_group',
        {
          target_user_id: vendorUserId,
          target_group_id: authentikGroupId
        },
        revokedBy,
        client
      );

      // Requirement 21 Criterion 9: audit_logs row identifying the
      // acting (revoking) user, the affected Vendor_User, the affected
      // Channel, and the action taken.
      await client.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          revokedBy,
          'vendor_channel_grant_revoked',
          'vendor_channel_grant',
          grantId,
          JSON.stringify({ vendorUserId, channelId })
        ]
      );

      await client.query('COMMIT');

      logger.info(
        { grantId, vendorUserId, channelId, revokedBy },
        'Vendor channel grant revoked'
      );

      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Batch-sweeps every unrevoked Vendor_Channel_Grant whose `expires_at`
   * has passed, marking it revoked-by-the-system and cleaning up its
   * Authentik group membership (Requirement 21 Criteria 6-7, 9). Takes
   * no parameters -- this is a periodic batch sweep, not a per-grant
   * operation; the periodic invocation itself (an interval timer calling
   * this method) is implemented separately by `ExpiryScheduler` (task
   * 43.1), out of scope here.
   *
   * Transaction-boundary decision: UNLIKE `createGrant`/`revokeGrant`
   * (which each run their single grant's DB write + enqueue + audit-log
   * write inside one BEGIN/COMMIT transaction on one client), this
   * method deliberately does NOT wrap the whole sweep in one
   * transaction. It:
   *   1. Runs the bulk `UPDATE ... RETURNING *` on its own, short-lived
   *      connection and lets it commit (via the pool's implicit
   *      auto-commit for a single statement) immediately -- marking
   *      every expired grant revoked is the durable, load-bearing
   *      guarantee (Requirement 21 Criterion 6: an expired grant must
   *      stop being treated as active), and it should not be held
   *      hostage to any later step.
   *   2. THEN loops over the returned rows, best-effort resolving each
   *      grant's channel group id, enqueueing `remove_user_from_group`,
   *      and writing its `audit_logs` row -- catching and logging any
   *      per-row failure (e.g. `resolveChannelGroupId` throwing because
   *      the channel was since deleted) and continuing to the next row,
   *      mirroring `SyncWorker.assignUserToGlobalChannels`'s "continue
   *      with other groups even if one fails" pattern.
   *
   * This is a deliberate departure from `createGrant`/`revokeGrant`'s
   * single-transaction pattern: those methods process exactly ONE grant,
   * where an all-or-nothing transaction is the right shape (a failed
   * enqueue should undo that same grant's row mutation). Here, wrapping
   * the ENTIRE batch in one transaction would mean a single bad grant's
   * `resolveChannelGroupId` failure (e.g. a stale/deleted channel_id on
   * just one of potentially many expired grants) rolls back every OTHER
   * grant's expiry too -- exactly the "one bad grant aborts the whole
   * batch" outcome this design avoids. Committing the bulk UPDATE first,
   * then processing each row's downstream effects independently, ensures
   * a resolution failure for one grant can never undo another grant's
   * already-committed revocation.
   *
   * @returns {Promise<{expiredCount: number}>}
   */
  async expireGrants() {
    const expiredResult = await pool.query(
      `UPDATE vendor_channel_grants
       SET revoked_at = NOW(), revoked_by = $1
       WHERE expires_at <= NOW() AND revoked_at IS NULL
       RETURNING id, user_id, channel_id`,
      [SYSTEM_USER_ID]
    );

    const expiredGrants = expiredResult.rows;

    for (const grant of expiredGrants) {
      const { id: grantId, user_id: vendorUserId, channel_id: channelId } = grant;

      try {
        const { groupId: authentikGroupId } = await this.resolveChannelGroupId(channelId);

        await EventPublisher.publishOperation(
          'remove_user_from_group',
          {
            target_user_id: vendorUserId,
            target_group_id: authentikGroupId
          },
          SYSTEM_USER_ID
        );

        // Requirement 21 Criterion 9: audit_logs row identifying this as
        // an automated expiry-driven revocation (a distinct action from
        // revokeGrant's 'vendor_channel_grant_revoked'), the affected
        // Vendor_User, and the affected Channel.
        await pool.query(
          `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            SYSTEM_USER_ID,
            'vendor_channel_grant_expired',
            'vendor_channel_grant',
            grantId,
            JSON.stringify({ vendorUserId, channelId })
          ]
        );

        logger.info(
          { grantId, vendorUserId, channelId },
          'Vendor channel grant expired'
        );
      } catch (error) {
        // Best-effort: this grant's revoked_at/revoked_by is already
        // committed above, so a failure here (e.g. the channel was
        // since deleted) must not abort processing of the remaining
        // expired grants in this batch.
        logger.error(
          { grantId, vendorUserId, channelId, err: error },
          'Failed to complete Authentik cleanup/audit logging for an expired vendor channel grant'
        );
      }
    }

    return { expiredCount: expiredGrants.length };
  }
}

module.exports = VendorChannelService;
module.exports.SYSTEM_USER_ID = SYSTEM_USER_ID;
module.exports.VendorChannelAlreadyActiveError = VendorChannelAlreadyActiveError;
module.exports.VendorChannelNotActiveError = VendorChannelNotActiveError;
module.exports.VendorChannelProvisioningPendingError = VendorChannelProvisioningPendingError;
module.exports.TargetUserNotVendorError = TargetUserNotVendorError;
module.exports.ChannelNotFoundError = ChannelNotFoundError;
module.exports.ChannelGroupNotProvisionedError = ChannelGroupNotProvisionedError;
module.exports.VendorChannelGrantNotActiveError = VendorChannelGrantNotActiveError;
