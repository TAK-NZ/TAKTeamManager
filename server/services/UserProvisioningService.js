/**
 * UserProvisioningService
 *
 * Requirement 17.1: `POST /api/users/create-and-add` must wrap every LOCAL
 * database write for the "create a user and add them to a team" operation
 * inside a single transaction, using one already-acquired `pg` client --
 * while the Authentik user-creation call itself happens strictly BEFORE
 * that transaction opens, since an external HTTP call must never be issued
 * from inside an open DB transaction.
 *
 * This service therefore takes an ALREADY-CREATED Authentik user id
 * (`authentikUserId`) and an ALREADY-BEGUN transactional `client` as
 * inputs; it performs no Authentik API calls itself. Callers are
 * responsible for:
 *   1. Creating the Authentik user (or resolving an existing one) BEFORE
 *      acquiring a client / calling `BEGIN`.
 *   2. Acquiring one `client = await pool.connect()`, calling
 *      `await client.query('BEGIN')`, then calling `createAndAddUser`.
 *   3. Committing on success / rolling back on any thrown error, and
 *      releasing the client in a `finally` block.
 *
 * Any Authentik-side write that would otherwise happen mid-sequence (e.g.
 * adding the new user to a team/parent-team channel's Authentik group) is
 * instead queued as a `sync_operations` row via `EventPublisher`, matching
 * the existing `TeamMembershipService` pattern. This keeps every write
 * performed by this function a plain local database write, so none of them
 * require an Authentik API call while `client`'s transaction is open.
 *
 * The recursive parent-team inheritance logic below is carried over
 * unchanged from the pre-refactor `POST /api/users/create-and-add` handler
 * in `server/routes/users.js`.
 */
const EventPublisher = require('./EventPublisher');
const Team = require('../models/Team');
const CallsignService = require('./CallsignService');
const { checkCallsignSuffixUniqueness } = require('./CallsignSuffixUniquenessService');

/**
 * Requirement 11.6 (task 22.1): thrown by `resolveCallsignSuffixForNewUser`
 * when the target Organisation's `callsign_name_format` is `user_defined`
 * and no non-empty `requestedCallsignSuffix` was supplied -- `user_defined`
 * computes no default at all (Requirement 11.5), so a value MUST be
 * supplied by the caller in this case.
 */
class CallsignSuffixRequiredError extends Error {
  constructor(message = "A callsign suffix is required for this Organisation's user_defined callsign format") {
    super(message);
    this.name = 'CallsignSuffixRequiredError';
  }
}

/**
 * Requirement 13.3/13.4/13.5: resolves the Organisation at the root of
 * `teamId`'s Ancestor_Chain on the caller's transaction client.
 *
 * Not `Team.getAncestorChain`: that reads through the shared `pool`, and this
 * value is written inside the caller's open transaction. Not the existing
 * `parent_teams` CTE in this file either -- that projects parent ids
 * without an ORDER BY, and taking "the last row" from a recursive CTE relies
 * on evaluation order Postgres does not guarantee. This predicate
 * (`parent_team_id IS NULL`) is order-independent and returns exactly one row.
 *
 * @param {import('pg').PoolClient} client - the caller's already-open
 *   transactional client.
 * @param {number} teamId
 * @returns {Promise<number|null>} the root Organisation's team id, or `null`
 *   when the chain cannot be resolved.
 */
async function resolveOrganisationIdForTeam(client, teamId) {
  const result = await client.query(`
    WITH RECURSIVE chain AS (
      SELECT id, parent_team_id FROM teams WHERE id = $1
      UNION ALL
      SELECT t.id, t.parent_team_id FROM teams t JOIN chain c ON t.id = c.parent_team_id
    )
    SELECT id FROM chain WHERE parent_team_id IS NULL
  `, [teamId]);
  return result.rows.length > 0 ? result.rows[0].id : null;
}

class UserProvisioningService {
  /**
   * Upserts the local `users` row for an already-created Authentik user,
   * assigns them to `teamId` (removing any stale inherited membership row
   * for that same team first), walks the team's parent hierarchy to create
   * the corresponding inherited `team_memberships` rows, and assigns the
   * user to the primary channel of every team in that chain (queuing an
   * `add_user_to_group` Sync_Operation for each channel that has an
   * Authentik group).
   *
   * @param {import('pg').PoolClient} client - an already-connected client
   *   with an already-open transaction (`BEGIN` already issued by the
   *   caller).
   * @param {object} params
   * @param {number|string} params.authentikUserId - the `pk` of the
   *   already-created Authentik user.
   * @param {string} params.username
   * @param {string} params.email
   * @param {string} params.firstName
   * @param {string} params.lastName
   * @param {number} params.teamId
   * @param {string|null} [params.callsign_suffix] - the resolved
   *   Requirement 11.6/11.7/11.14-checked `callsign_suffix` value for
   *   this new user (task 22.2's wiring of
   *   `resolveCallsignSuffixForNewUser`'s result into this shared local
   *   write path). Stored on `users.callsign_suffix`.
   * @param {number|null} [params.createdBy] - local user id of the actor
   *   performing this operation, recorded on queued Sync_Operations.
   * @returns {Promise<{localUserId: number, queuedGroups: number}>}
   */
  static async createAndAddUser(client, { authentikUserId, username, email, firstName, lastName, teamId, callsign_suffix = null, createdBy = null }) {
    // Requirement 13.3/13.4/13.5: resolve the target Team's Organisation
    // (the root of its Ancestor_Chain) on the caller's transaction client
    // and record it as the user's provenance.
    const originOrgId = await resolveOrganisationIdForTeam(client, teamId);

    // Upsert local user record. Requirement 13.9: `origin_org_id` is
    // write-once -- `COALESCE(users.origin_org_id, EXCLUDED.origin_org_id)`
    // never overwrites an existing non-null value, so a returning user being
    // re-provisioned into another Organisation is never reclassified.
    await client.query(
      'INSERT INTO users (authentik_user_id, username, email, first_name, last_name, is_active, callsign_suffix, origin_org_id) VALUES ($1, $2, $3, $4, $5, true, $6, $7) ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2, email = $3, first_name = $4, last_name = $5, is_active = true, callsign_suffix = $6, origin_org_id = COALESCE(users.origin_org_id, EXCLUDED.origin_org_id)',
      [authentikUserId, username, email, firstName, lastName, callsign_suffix, originOrgId]
    );

    const localUserResult = await client.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [authentikUserId]
    );
    const localUserId = localUserResult.rows[0].id;

    // Remove any existing inherited membership for this user from this team
    // (mirrors the pre-refactor behavior exactly).
    await client.query(
      'DELETE FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id = $2',
      [localUserId, teamId]
    );

    // Add to the target team directly.
    await client.query(
      'INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3)',
      [teamId, localUserId, 'member']
    );

    let queuedGroups = 0;

    // Walk the target team's parent chain (root-ward) and add one inherited
    // membership row + primary-channel membership per ancestor, exactly as
    // the pre-refactor recursive-CTE logic did.
    const parentTeamsResult = await client.query(`
      WITH RECURSIVE parent_teams AS (
        SELECT parent_team_id FROM teams WHERE id = $1 AND parent_team_id IS NOT NULL
        UNION ALL
        SELECT t.parent_team_id
        FROM teams t
        JOIN parent_teams pt ON t.id = pt.parent_team_id
        WHERE t.parent_team_id IS NOT NULL
      )
      SELECT parent_team_id as team_id FROM parent_teams
    `, [teamId]);

    for (const parentTeam of parentTeamsResult.rows) {
      await client.query(
        'INSERT INTO team_memberships (team_id, user_id, role, inherited_from_team_id) VALUES ($1, $2, $3, $4)',
        [parentTeam.team_id, localUserId, 'inherited', teamId]
      );

      const parentChannelResult = await client.query(
        'SELECT id, authentik_group_id FROM channels WHERE team_id = $1 AND is_primary = true',
        [parentTeam.team_id]
      );

      if (parentChannelResult.rows.length > 0) {
        const parentChannel = parentChannelResult.rows[0];

        await client.query(
          'INSERT INTO channel_memberships (channel_id, user_id, permission) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [parentChannel.id, localUserId, 'read_write']
        );

        if (parentChannel.authentik_group_id) {
          // Requirement 17.5's client-threading pattern extends here too:
          // this function already runs inside the caller's open
          // transaction, so pass that same `client` through so the
          // sync_operations INSERT commits/rolls back atomically with the
          // rest of this function's local writes.
          await EventPublisher.publishOperation('add_user_to_group', {
            target_user_id: localUserId,
            target_group_id: parentChannel.authentik_group_id
          }, createdBy, client);
          queuedGroups++;
        }
      }
    }

    // Assign the user to the target team's own primary channel.
    const channelResult = await client.query(
      'SELECT id, authentik_group_id FROM channels WHERE team_id = $1 AND is_primary = true',
      [teamId]
    );

    if (channelResult.rows.length > 0) {
      const channel = channelResult.rows[0];

      await client.query(
        'INSERT INTO channel_memberships (channel_id, user_id, permission) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [channel.id, localUserId, 'read_write']
      );

      if (channel.authentik_group_id) {
        await EventPublisher.publishOperation('add_user_to_group', {
          target_user_id: localUserId,
          target_group_id: channel.authentik_group_id
        }, createdBy, client);
        queuedGroups++;
      }
    }

    return { localUserId, queuedGroups };
  }

  /**
   * Requirement 11.6, 11.7, 11.14, 11.15 (task 22.1): resolves the
   * effective `callsign_suffix` value to store for a brand-new user, and
   * checks it for a per-Team uniqueness collision before returning it.
   *
   * This function is READ-ONLY with respect to the database: it does not
   * insert or update anything itself (that remains the caller's
   * responsibility, in a later, separate task -- see task 22.2). The
   * `client` parameter is accepted for API-signature consistency with
   * this task's exact specified signature, but is unused in this
   * function's own body: `Team.getAncestorChain`/`Team.getFullMemberList`
   * both use the shared `pool` directly (per their own existing
   * implementations, tasks 2.2/21.1) rather than accepting a `client`
   * parameter, so there is nothing transactional for this read-only
   * function to participate in yet.
   *
   * Resolution order:
   *   1. Resolve the target Organisation's `callsign_name_format` via
   *      `Team.getAncestorChain(teamId)`'s root (depth 0) row.
   *   2. If `callsign_name_format === 'user_defined'`: require a
   *      non-empty `requestedCallsignSuffix` (throws
   *      `CallsignSuffixRequiredError` otherwise, Requirement 11.6).
   *   3. Otherwise: prefer a non-empty `requestedCallsignSuffix` when
   *      supplied; else compute the default via
   *      `CallsignService.computeDefaultCallsignSuffix` (Requirement
   *      11.7).
   *   4. Check the effective value against `Team.getFullMemberList(teamId)`
   *      for a case-insensitive collision (Requirement 11.14) -- no
   *      `excludeUserId` is passed, since this is a brand-new user with
   *      no existing membership row yet. Throws
   *      `CallsignSuffixConflictError` (task 23.1) on a collision
   *      (Requirement 11.15).
   *
   * @param {import('pg').PoolClient} client - unused by this function's
   *   own body (see above); accepted only for signature consistency.
   * @param {object} params
   * @param {string} params.firstName
   * @param {string} params.lastName
   * @param {number} params.teamId
   * @param {string|null|undefined} [params.requestedCallsignSuffix]
   * @returns {Promise<string>} the resolved, uniqueness-checked
   *   `callsign_suffix` value to store for the new user.
   * @throws {CallsignSuffixRequiredError} if `callsign_name_format` is
   *   `user_defined` and no `requestedCallsignSuffix` was supplied.
   * @throws {CallsignSuffixConflictError} on a per-Team uniqueness
   *   collision.
   */
  static async resolveCallsignSuffixForNewUser(client, { firstName, lastName, teamId, requestedCallsignSuffix }) {
    const ancestorChain = await Team.getAncestorChain(teamId);
    const organisation = ancestorChain.find((team) => team.parent_team_id === null) || ancestorChain[0];
    const callsignNameFormat = organisation?.callsign_name_format;

    const trimmedRequested = requestedCallsignSuffix ? requestedCallsignSuffix.trim() : '';

    let effectiveValue;
    if (callsignNameFormat === 'user_defined') {
      if (!trimmedRequested) {
        throw new CallsignSuffixRequiredError();
      }
      effectiveValue = trimmedRequested;
    } else {
      effectiveValue = trimmedRequested || CallsignService.computeDefaultCallsignSuffix(firstName, lastName, callsignNameFormat);
    }

    await checkCallsignSuffixUniqueness(teamId, effectiveValue);

    return effectiveValue;
  }
}

UserProvisioningService.CallsignSuffixRequiredError = CallsignSuffixRequiredError;

module.exports = UserProvisioningService;
