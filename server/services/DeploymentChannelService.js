const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
const logger = require('../config/logger').createLogger('DeploymentChannelService');

/**
 * Requirement 22 Criteria 1/5/11: a Deployment_Channel's `name` must match
 * either the `Overseas - ` prefix pattern (e.g. `Overseas - Tonga`) or the
 * domestic mission-scoped `[COUNTRY]-[FUNCTION]-[REGION]-[SUFFIX]` pattern
 * (e.g. `AUS-FIRE-STL-2026`), per `design.md`'s Section 18. These mirror
 * the two regexes named in the design document exactly.
 */
const OVERSEAS_NAME_PATTERN = /^Overseas - .+/;
const DOMESTIC_NAME_PATTERN = /^[A-Z]{2,3}-[A-Z]+-[A-Z]+-\d{4}$/;

/**
 * Default `channel_memberships.permission` value used by `subscribe`
 * for a self-service Deployment_Channel subscription, matching that
 * column's own schema default (see the baseline migration's
 * `channel_memberships` table definition) -- requirements.md/design.md
 * do not call out a different permission level for a self-service
 * deployment-channel subscription, so the column's existing default is
 * reused rather than introducing a new value.
 */
const DEFAULT_MEMBERSHIP_PERMISSION = 'read_write';

/**
 * Thrown by `subscribe(channelId, userId)` when the target
 * `deployment_channels` row either does not exist or has `is_active`
 * set to `false` (Requirement 22 Criterion 10). Checked FIRST, before
 * any `channel_memberships` row is inserted or anything is enqueued --
 * a 400-equivalent client error, not a 500.
 */
class DeploymentChannelNotActiveError extends Error {
  constructor(message = 'Deployment channel is no longer active') {
    super(message);
    this.name = 'DeploymentChannelNotActiveError';
  }
}

/**
 * Thrown by `unsubscribe(channelId, userId)` when the target
 * `deployment_channels` row does not exist at all, so there is no
 * `authentik_group_id` to build a `remove_user_from_group` payload
 * from. A 400-equivalent client error, not a 500.
 */
class DeploymentChannelNotFoundError extends Error {
  constructor(channelId) {
    super(`Deployment channel ${channelId} was not found`);
    this.name = 'DeploymentChannelNotFoundError';
  }
}

/**
 * `DeploymentChannelService` follows the same shape as
 * `VendorChannelService`/`GlobalChannelService` (Requirement 22, per
 * `design.md`'s Section 18): a transactional-insert-then-enqueue-
 * `Sync_Operation` create path, plus self-service `subscribe`/
 * `unsubscribe` (this task, 42.2), plus (in a later task, out of scope
 * here) a `deactivateExpired` sweep.
 *
 * `subscribe`/`unsubscribe` insert/delete `channel_memberships` rows
 * directly via a plain `INSERT`/`DELETE`, rather than through
 * `Channel.addMember`'s `ON CONFLICT (user_id, channel_id) DO UPDATE`
 * upsert. See
 * `1786750000000_make-channel-memberships-channel-id-polymorphic.cjs`'s
 * file-level comment for the full reasoning: `channel_memberships`'s
 * `UNIQUE(user_id, channel_id)` constraint was deliberately left in
 * place (needed by `Channel.addMember`'s upsert for the team-scoped
 * case), which means a `channels.id` and a `deployment_channels.id` can
 * collide on the same integer for the same user. Using a direct INSERT
 * here means such a collision surfaces as an unexpected duplicate-key
 * error on `subscribe` -- a visible, propagated failure -- rather than
 * `addMember`'s upsert silently overwriting an unrelated membership's
 * `permission` value.
 */
class DeploymentChannelService {
  /**
   * Creates a Deployment_Channel (either an `Overseas - ` prefixed
   * standing/temporary overseas deployment channel, or a
   * Domestic_Mission_Channel matching the
   * `[COUNTRY]-[FUNCTION]-[REGION]-[SUFFIX]` pattern).
   *
   * Requirement 22.5: rejects (before ever connecting to the database,
   * mirroring `GlobalChannelService.deleteGlobalChannel`'s allow-list
   * check) a `name` that matches neither accepted pattern, naming both
   * accepted formats in the error message.
   *
   * Requirement 22.13: a `name` matching the domestic pattern requires a
   * non-null `deploymentEndDate`; this is checked before any database
   * connection is opened as well, since it's a pure validation of the
   * caller's input independent of any row state.
   *
   * Requirement 22.4/22.11: on successful validation, performs a
   * transactional insert into `deployment_channels` followed by
   * enqueueing a `create_deployment_channel_group` Sync_Operation, then
   * commits -- the same transactional-create-then-enqueue pattern already
   * used by `GlobalChannelService.createRegionChannel`.
   *
   * @param {{name: string, description?: string, deploymentEndDate?: string|Date|null}} channelData
   * @param {number} requestedBy - the requesting Deployment_Coordinator's
   *   user id (every Global_Manager is an authorized Deployment_Coordinator
   *   per Requirement 22.3; the `is_global_manager` authorization check
   *   itself lives at the route layer, per the existing pattern for
   *   `GlobalChannelService`'s create methods).
   * @returns {Promise<{channelId: number}>}
   */
  async createDeploymentChannel(channelData, requestedBy) {
    const { name, description, deploymentEndDate } = channelData || {};

    const nameValue = typeof name === 'string' ? name : '';
    const matchesOverseas = OVERSEAS_NAME_PATTERN.test(nameValue);
    const matchesDomestic = DOMESTIC_NAME_PATTERN.test(nameValue);

    if (!matchesOverseas && !matchesDomestic) {
      throw new Error(
        'Invalid deployment channel name: must match either the "Overseas - " prefix format (e.g. "Overseas - Tonga") ' +
          'or the domestic [COUNTRY]-[FUNCTION]-[REGION]-[SUFFIX] format (e.g. "AUS-FIRE-STL-2026")'
      );
    }

    if (matchesDomestic && !deploymentEndDate) {
      throw new Error(
        'deployment_end_date is required for a Deployment_Channel name matching the domestic ' +
          '[COUNTRY]-[FUNCTION]-[REGION]-[SUFFIX] format'
      );
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        `
        INSERT INTO deployment_channels (
          name, description, deployment_end_date, requested_by
        ) VALUES ($1, $2, $3, $4)
        RETURNING id
      `,
        [nameValue, description || null, deploymentEndDate || null, requestedBy]
      );

      const channelId = result.rows[0].id;

      await EventPublisher.publishOperation(
        'create_deployment_channel_group',
        {
          deployment_channel_id: channelId,
          channel_name: nameValue
        },
        requestedBy
      );

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
   * Self-service subscribe (Requirement 22 Criterion 6): adds the
   * requesting user to a specified active Deployment_Channel. Available
   * to any authenticated user -- Permission_Registry wiring for that is
   * a later task, not this one.
   *
   * Order of operations, all inside one transaction on one acquired
   * client:
   *   1. Requirement 22 Criterion 10: check `is_active` FIRST. Rejects
   *      with `DeploymentChannelNotActiveError` (a 400-equivalent) if
   *      the channel does not exist or `is_active` is `false`, WITHOUT
   *      enqueueing a Sync_Operation or inserting a `channel_memberships`
   *      row.
   *   2. Enqueues `add_user_to_group` for the channel's
   *      `authentik_group_id`.
   *   3. Inserts a `channel_memberships` row directly (see this class's
   *      doc comment above for why a direct `INSERT` is used instead of
   *      `Channel.addMember`'s upsert). If this INSERT hits the
   *      duplicate-key error from the accepted `channels`/
   *      `deployment_channels` id-collision risk documented in
   *      `1786750000000_make-channel-memberships-channel-id-polymorphic.cjs`,
   *      it propagates as-is (via this method's `catch` -> `ROLLBACK` ->
   *      rethrow) rather than being silently swallowed.
   *
   * @param {number} channelId - the target `deployment_channels.id`.
   * @param {number} userId - the subscribing user's id.
   * @returns {Promise<{success: boolean}>}
   */
  async subscribe(channelId, userId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const channelResult = await client.query(
        'SELECT authentik_group_id, is_active FROM deployment_channels WHERE id = $1',
        [channelId]
      );

      const channel = channelResult.rows[0];

      if (!channel || !channel.is_active) {
        throw new DeploymentChannelNotActiveError();
      }

      await EventPublisher.publishOperation(
        'add_user_to_group',
        {
          target_user_id: userId,
          target_group_id: channel.authentik_group_id
        },
        userId,
        client
      );

      // Direct INSERT, not Channel.addMember's upsert -- see this
      // class's doc comment for why. A duplicate-key error here (the
      // accepted channels/deployment_channels id-collision risk)
      // propagates unmodified via the catch block below.
      await client.query(
        `INSERT INTO channel_memberships (user_id, channel_id, permission)
         VALUES ($1, $2, $3)`,
        [userId, channelId, DEFAULT_MEMBERSHIP_PERMISSION]
      );

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
   * Self-service unsubscribe (Requirement 22 Criterion 7): removes the
   * requesting user from a Deployment_Channel. Available to any
   * authenticated user -- Permission_Registry wiring for that is a
   * later task, not this one. Unlike `subscribe`, there is no
   * `is_active` check: an unsubscribe is permitted regardless of the
   * channel's active state (Requirement 22 Criterion 7 makes no mention
   * of an active-state precondition, unlike Criterion 10's explicit
   * `subscribe`-only restriction).
   *
   * Order of operations, all inside one transaction on one acquired
   * client:
   *   1. Look up the channel's `authentik_group_id` (rejecting with
   *      `DeploymentChannelNotFoundError` if the channel doesn't exist
   *      at all -- there would be no group to remove the user from).
   *   2. Enqueues `remove_user_from_group` for that group.
   *   3. Deletes the corresponding `channel_memberships` row directly
   *      (mirroring `subscribe`'s direct-INSERT choice, for the same
   *      polymorphic-`channel_id` reasoning -- a plain `DELETE ... WHERE
   *      user_id = $1 AND channel_id = $2` has no upsert-arbiter
   *      ambiguity the way `Channel.addMember` would, but is kept
   *      direct here for symmetry and consistency with `subscribe`).
   *
   * @param {number} channelId - the target `deployment_channels.id`.
   * @param {number} userId - the unsubscribing user's id.
   * @returns {Promise<{success: boolean}>}
   */
  async unsubscribe(channelId, userId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const channelResult = await client.query(
        'SELECT authentik_group_id FROM deployment_channels WHERE id = $1',
        [channelId]
      );

      const channel = channelResult.rows[0];

      if (!channel) {
        throw new DeploymentChannelNotFoundError(channelId);
      }

      await EventPublisher.publishOperation(
        'remove_user_from_group',
        {
          target_user_id: userId,
          target_group_id: channel.authentik_group_id
        },
        userId,
        client
      );

      await client.query(
        'DELETE FROM channel_memberships WHERE user_id = $1 AND channel_id = $2',
        [userId, channelId]
      );

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
   * Batch-sweeps every active Deployment_Channel whose
   * `deployment_end_date` has passed, deactivating it and cleaning up
   * its `channel_memberships` rows and Authentik group membership
   * (Requirement 22 Criteria 8-9). Takes no parameters -- this is a
   * periodic batch sweep, not a per-channel operation; the periodic
   * invocation itself (an interval timer calling this method) is
   * implemented separately by `ExpiryScheduler` (task 43.1), out of
   * scope here.
   *
   * Requirement 22 Criterion 2: a row with a null `deployment_end_date`
   * (a standing Pacific-partner channel) must never be auto-deactivated.
   * This is satisfied by the bulk `UPDATE`'s `WHERE deployment_end_date
   * <= NOW()` clause alone -- SQL's `NULL <= NOW()` never evaluates to
   * `true`, so a null-`deployment_end_date` row can never match and is
   * never touched, with no additional `IS NOT NULL`/`COALESCE` guard
   * needed (and deliberately none added, to avoid any accidental
   * NULL-handling that could weaken this guarantee).
   *
   * Transaction-boundary decision: mirrors
   * `VendorChannelService.expireGrants()`'s established pattern exactly
   * (see that method's doc comment for the full reasoning) rather than
   * `createDeploymentChannel`/`subscribe`/`unsubscribe`'s single-
   * transaction-per-call shape:
   *   1. Runs the bulk `UPDATE ... RETURNING *` on its own, short-lived
   *      connection and lets it commit immediately -- deactivating every
   *      expired channel is the durable, load-bearing guarantee
   *      (Requirement 22 Criterion 9), and it should not be held hostage
   *      to any later step.
   *   2. THEN loops over the returned rows, best-effort deleting each
   *      channel's `channel_memberships` rows and enqueueing
   *      `remove_all_members_from_group` -- catching and logging any
   *      per-row failure and continuing to the next row, so a single bad
   *      channel's cleanup failure can never undo another channel's
   *      already-committed deactivation.
   *
   * @returns {Promise<{deactivatedCount: number}>}
   */
  async deactivateExpired() {
    const deactivatedResult = await pool.query(
      `UPDATE deployment_channels
       SET is_active = false
       WHERE deployment_end_date <= NOW() AND is_active = true
       RETURNING *`
    );

    const deactivatedChannels = deactivatedResult.rows;

    for (const channel of deactivatedChannels) {
      const { id: channelId, authentik_group_id: authentikGroupId } = channel;

      try {
        await pool.query('DELETE FROM channel_memberships WHERE channel_id = $1', [channelId]);

        // authentik_group_id can still be null if the channel's own
        // create_deployment_channel_group Sync_Operation was never
        // processed (e.g. it permanently failed) -- there is then no
        // Authentik group to remove members from, so the enqueue is
        // skipped rather than sent with a null target_group_id (which
        // would fail operationSchemas.js's required-field validation
        // permanently, for no benefit).
        if (authentikGroupId) {
          await EventPublisher.publishOperation(
            'remove_all_members_from_group',
            {
              channel_id: channelId,
              target_group_id: authentikGroupId
            },
            null
          );
        }

        logger.info({ channelId, authentikGroupId }, 'Deployment channel deactivated');
      } catch (error) {
        // Best-effort: this channel's is_active=false is already
        // committed above, so a failure here (e.g. the
        // channel_memberships delete failing) must not abort processing
        // of the remaining expired channels in this batch.
        logger.error(
          { channelId, authentikGroupId, err: error },
          'Failed to complete membership cleanup/Authentik enqueue for an expired deployment channel'
        );
      }
    }

    return { deactivatedCount: deactivatedChannels.length };
  }
}

module.exports = DeploymentChannelService;
module.exports.DeploymentChannelNotActiveError = DeploymentChannelNotActiveError;
module.exports.DeploymentChannelNotFoundError = DeploymentChannelNotFoundError;
