const pool = require('../config/database');
const DirectoryScopeService = require('./DirectoryScopeService');
const { getLogger } = require('../middleware/requestContext');
const { classifyClientType } = require('../utils/clientType');

/**
 * Thrown when an admin asks for (or tries to act on) the Devices of a user
 * who is not a Managed_User of that admin (device-management Requirements
 * 6.7, 8.6, 9.4). A 403-equivalent client error, not a 500 -- the route
 * layer (task 13.1) maps this to an HTTP 403, and the `device_mgmt:*:managed`
 * row-scoped resolvers (task 12.1) treat it as "denied".
 */
class NotManagedUserError extends Error {
  /**
   * @param {number|string} actingUserId - the admin who made the request.
   * @param {number|string} targetUserId - the user they are not permitted to reach.
   */
  constructor(actingUserId, targetUserId) {
    super(`User ${targetUserId} is not a managed user of user ${actingUserId}`);
    this.name = 'NotManagedUserError';
    this.actingUserId = actingUserId;
    this.targetUserId = targetUserId;
  }
}

/**
 * Thrown by both revoke assertions when the named Device does not belong to
 * the user the revocation is being attempted for (Requirements 7.5, 8.5,
 * 9.3), INCLUDING the case where no `tak_devices` row with that `client_uid`
 * exists at all.
 *
 * Those two cases are deliberately NOT distinguished: reporting "no such
 * device" separately from "not your device" would let any authenticated
 * caller probe which device UIDs exist by reading the status code, and the
 * outcome for the caller is identical either way -- no Revoke_Operation is
 * enqueued. A 403-equivalent client error, not a 500.
 */
class DeviceNotOwnedError extends Error {
  /**
   * @param {string} clientUid - the Device UID that was asked for.
   * @param {number|string} expectedUserId - the user it was required to belong to.
   */
  constructor(clientUid, expectedUserId) {
    super(`Device ${clientUid} does not belong to user ${expectedUserId}`);
    this.name = 'DeviceNotOwnedError';
    this.clientUid = clientUid;
    this.expectedUserId = expectedUserId;
  }
}

/**
 * The Device_Table columns that make up the wire shape. `last_polled_at`,
 * `created_at`, and `updated_at` are deliberately absent: they are internal
 * bookkeeping for the Device_Sync, not part of any response, so they are not
 * even read.
 *
 * `connected` IS read (Criterion 20.8): unlike `clientType`, which `mapDevice`
 * derives from `client_uid` with no column behind it (Criterion 15.2),
 * Connection_Status is stored state and has to be selected to be reported.
 */
const DEVICE_COLUMNS =
  'client_uid, user_id, cert_id, issued_at, expires_at, last_seen_at, revoked, connected';

/**
 * DeviceManagementService (device-management Requirements 5.5, 6.2, 6.6,
 * 6.7, 7.5, 8.5, 8.6, 9.3, 9.4; design.md's
 * `server/services/DeviceManagementService.js` section).
 *
 * The single place where Device_Table reads and the self/managed
 * authorization rules live. The routes (task 13.1) and the
 * `device_mgmt:read:managed`/`device_mgmt:revoke:managed` row-scoped
 * resolvers (task 12.1) both delegate here, so "what may this caller see"
 * and "what may this caller revoke" have ONE definition rather than one per
 * call site.
 *
 * Two deliberate boundaries:
 *
 *   - Device_Mgmt_Enabled is NOT checked here. The flag gates the surfaces
 *     (route mount + in-handler 404, task 13.1) and the background jobs
 *     (task 8.2); this module answers authorization questions and is inert
 *     until something calls it.
 *
 *   - The `snake_case` -> `camelCase` mapping happens HERE, in `mapDevice`,
 *     not in the routes. Every method already returns Devices, so putting
 *     the mapping at the single point where a `tak_devices` row becomes a
 *     domain object means the wire shape
 *     `{ clientUid, certId, issuedAt, expiresAt, lastSeenAt, revoked,
 *     connected, clientType }` has
 *     one definition shared by the self-view, the admin view, and both
 *     revoke assertions -- a route cannot accidentally leak a raw column
 *     name (or `last_polled_at`) by forgetting to map.
 *
 * A database failure propagates as a throw and becomes a 500 at the route's
 * error handler. There is deliberately NO catch that degrades a failed
 * managed-user lookup into "permitted" (Requirement 9.4 must fail closed);
 * the row-scoped resolver contract in `server/middleware/authorize.js`
 * already logs a thrown resolver error and denies.
 */
class DeviceManagementService {
  /**
   * Requirement 5.5 / Property 5: the Devices whose `user_id` is exactly
   * `userId` -- the server-side enforcement of the self-view, so the
   * caller's own id is the only input to the query and no client-supplied
   * filter can widen it.
   *
   * Ordered newest-issued first (with never-issued rows last) and then by
   * `client_uid` so the list is deterministic for a given table content.
   *
   * Criterion 17.8 / 20.8: the `user_id` predicate is the WHOLE filter. No
   * `last_polled_at` freshness check, no `revoked` check, and -- now that the
   * column is selected -- no `connected` check either: visibility has exactly
   * one mechanism, the presence of the row. `connected` is read to be
   * reported, never to decide who is shown.
   *
   * @param {number|string} userId - LOCAL `users.id`, never the Authentik id.
   * @returns {Promise<Array<{clientUid: string, certId: number, issuedAt: Date|null,
   *   expiresAt: Date|null, lastSeenAt: Date|null, revoked: boolean,
   *   connected: boolean}>>}
   */
  static async listOwnDevices(userId) {
    const result = await pool.query(
      `SELECT ${DEVICE_COLUMNS}
         FROM tak_devices
        WHERE user_id = $1
        ORDER BY issued_at DESC NULLS LAST, client_uid ASC`,
      [userId]
    );

    return result.rows.map(DeviceManagementService.mapDevice);
  }

  /**
   * Requirements 6.1, 6.2, 6.6, 6.7: the Devices of `targetUserId`, returned
   * ONLY when that user is a Managed_User of `actingUser`. A non-managed
   * target throws `NotManagedUserError` BEFORE the Device query runs, so a
   * denied request reads no device data at all.
   *
   * @param {{userId: number, is_global_manager?: boolean}} actingUser - `req.user`.
   * @param {number|string} targetUserId - LOCAL `users.id` from the route param.
   * @returns {Promise<Array<object>>} the same Device shape as the self-view.
   * @throws {NotManagedUserError}
   */
  static async listManagedUserDevices(actingUser, targetUserId) {
    await DeviceManagementService.assertManagedUser(actingUser, targetUserId);
    return DeviceManagementService.listOwnDevices(targetUserId);
  }

  /**
   * Requirements 7.5, 9.3 / Property 5: resolves the `clientUid` Device and
   * returns it only when its `user_id` is `userId`. Called by the self-revoke
   * route BEFORE the `REVOKE` confirmation check and therefore before any
   * enqueue, so an unauthorized attempt never reaches `EventPublisher`.
   *
   * A Device with a NULL `user_id` (an Active_Certificate the Device_Sync
   * could not match to a local user) belongs to nobody and so is never
   * revocable through this path.
   *
   * @param {number|string} userId - LOCAL `users.id` of the caller.
   * @param {string} clientUid
   * @returns {Promise<object>} the mapped Device, for the caller to log/inspect.
   * @throws {DeviceNotOwnedError}
   */
  static async assertCanRevokeOwn(userId, clientUid) {
    const device = await DeviceManagementService.findDeviceRow(clientUid);

    if (!device || !DeviceManagementService.sameUserId(device.user_id, userId)) {
      getLogger().warn(
        { clientUid, actorId: userId },
        'Denied a device revocation: the device does not belong to the requesting user'
      );
      throw new DeviceNotOwnedError(clientUid, userId);
    }

    return DeviceManagementService.mapDevice(device);
  }

  /**
   * Requirements 8.5, 8.6, 9.4 / Property 6: BOTH conditions the admin
   * revoke path requires -- `targetUserId` is a Managed_User of `actingUser`
   * AND the `clientUid` Device's `user_id` is `targetUserId`. Checked here,
   * upfront, before the confirmation check and before any Revoke_Operation is
   * enqueued (Requirement 8.5's "blocking an unauthorized revocation attempt
   * upfront").
   *
   * The managed-user leg is evaluated first so a caller with no relationship
   * to the target learns nothing about the Device.
   *
   * @param {{userId: number, is_global_manager?: boolean}} actingUser - `req.user`.
   * @param {number|string} targetUserId
   * @param {string} clientUid
   * @returns {Promise<object>} the mapped Device.
   * @throws {NotManagedUserError|DeviceNotOwnedError}
   */
  static async assertCanRevokeManaged(actingUser, targetUserId, clientUid) {
    await DeviceManagementService.assertManagedUser(actingUser, targetUserId);
    return DeviceManagementService.assertCanRevokeOwn(targetUserId, clientUid);
  }

  /**
   * Requirements 6.2, 6.6, 9.4: is `targetUserId` a Managed_User of
   * `actingUser`?
   *
   * A Global_Manager short-circuits to `true` via
   * `DirectoryScopeService.resolveScope`, which reads the cached
   * `is_global_manager` attribute and returns its frozen `UNSCOPED` sentinel
   * with no query issued -- reused rather than re-checked here so this
   * feature and `user:read:team_admin`/the directory routes cannot disagree
   * about who is one (Requirement 10.4's reasoning in that service). For a
   * non-Global_Manager, `resolveScope` also resolves that caller's
   * Scoped_Organisations and domains, which this check does not use and
   * discards -- an accepted cost (a few indexed reads on an admin-only path)
   * for having exactly one answer to "is this caller unscoped" rather than a
   * second `is_global_manager` read of our own.
   *
   * Otherwise the direct-admin relationship decides it, per the
   * Managed_User glossary entry and design decision 4 ("never `Team.isAdmin`
   * inheritance for the *set*"): the acting user must hold a DIRECT admin row
   * (`role = 'admin' AND inherited_from_team_id IS NULL`) for a Team the
   * target user is a member of. Because `TeamMembershipService` materialises
   * an `inherited` `team_memberships` row for every ancestor Team when a user
   * joins a Team, a member of a sub-team already has a row for that
   * sub-team's ancestors -- so this single join covers "admin of an ancestor
   * Team manages users further down the branch" without a recursive CTE,
   * while still keeping the ADMIN side strictly direct.
   *
   * @param {{userId: number, is_global_manager?: boolean}} actingUser
   * @param {number|string} targetUserId
   * @returns {Promise<boolean>}
   */
  static async isManagedUser(actingUser, targetUserId) {
    const scope = await DirectoryScopeService.resolveScope(actingUser);
    if (scope && scope.unscoped) {
      return true;
    }

    const actingUserId = actingUser && actingUser.userId;
    if (actingUserId === undefined || actingUserId === null || targetUserId === undefined || targetUserId === null) {
      return false;
    }

    const result = await pool.query(
      `SELECT 1
         FROM team_memberships admin_row
         JOIN team_memberships target_row ON target_row.team_id = admin_row.team_id
        WHERE admin_row.user_id = $1
          AND admin_row.role = 'admin'
          AND admin_row.inherited_from_team_id IS NULL
          AND target_row.user_id = $2
        LIMIT 1`,
      [actingUserId, targetUserId]
    );

    return result.rows.length > 0;
  }

  /**
   * `isManagedUser` in throwing form, so the two admin entry points share one
   * denial path (and one log line) instead of each shaping their own.
   *
   * @param {{userId: number, is_global_manager?: boolean}} actingUser
   * @param {number|string} targetUserId
   * @returns {Promise<void>}
   * @throws {NotManagedUserError}
   */
  static async assertManagedUser(actingUser, targetUserId) {
    const managed = await DeviceManagementService.isManagedUser(actingUser, targetUserId);
    if (managed) {
      return;
    }

    const actingUserId = actingUser && actingUser.userId;

    // Ids only, no email/name (Requirement 9.2), through the request-scoped
    // logger so the line inherits the request's correlation id.
    getLogger().warn(
      { actorId: actingUserId, targetUserId },
      'Denied a device-management request: the target user is not a managed user of the requester'
    );

    throw new NotManagedUserError(actingUserId, targetUserId);
  }

  /**
   * Reads one Device_Table row by its primary key, or `undefined` when there
   * is none. Returns the RAW row (snake_case) because the callers compare
   * `user_id` before deciding whether the caller may see the Device at all;
   * mapping happens only after that check passes.
   *
   * @param {string} clientUid
   * @returns {Promise<object|undefined>}
   */
  static async findDeviceRow(clientUid) {
    const result = await pool.query(
      `SELECT ${DEVICE_COLUMNS} FROM tak_devices WHERE client_uid = $1`,
      [clientUid]
    );
    return result.rows[0];
  }

  /**
   * Compares a `tak_devices.user_id` (an integer, or NULL for an unmatched
   * certificate) against a user id that may have arrived as a route-param
   * STRING. Normalising both sides through `Number` is what stops
   * `5 === '5'` being false and silently denying a legitimate request; a
   * NULL/absent/non-numeric value on either side is never equal.
   *
   * @param {number|null|undefined} deviceUserId
   * @param {number|string|null|undefined} userId
   * @returns {boolean}
   */
  static sameUserId(deviceUserId, userId) {
    if (deviceUserId === null || deviceUserId === undefined || userId === null || userId === undefined) {
      return false;
    }

    const left = Number(deviceUserId);
    const right = Number(userId);

    return Number.isInteger(left) && Number.isInteger(right) && left === right;
  }

  /**
   * The one definition of the Device wire shape (design.md's endpoint
   * responses): `{ clientUid, certId, issuedAt, expiresAt, lastSeenAt,
   * revoked, connected, clientType }`.
   *
   * `lastSeenAt` is passed through as `null` when the Device has never been
   * observed by the Subscription_Poller -- the client renders that as "never
   * seen" (Requirements 5.3, 6.5), so the server does NOT substitute a
   * string or a zero date here. `user_id` is deliberately dropped: the caller
   * already knows whose Devices they asked for.
   *
   * @param {object} row - a `tak_devices` row.
   * @returns {{clientUid: string, certId: number, issuedAt: Date|null,
   *   expiresAt: Date|null, lastSeenAt: Date|null, revoked: boolean,
   *   connected: boolean,
   *   clientType: 'cloudtak'|'android'|'ios'|'windows'|'unknown'}}
   */
  static mapDevice(row) {
    return {
      clientUid: row.client_uid,
      certId: row.cert_id,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      revoked: row.revoked,
      // Requirement 20.8: Connection_Status rides the same single wire-shape
      // definition, so all four device endpoints gain it at once and no
      // surface can see it while another does not.
      //
      // Note the deliberate contrast with `clientType` below, and do NOT
      // "simplify" one into the other: `connected` is STORED and read
      // straight off the row because it is current state observed on TAK
      // Server, with nothing in the row to derive it from (Criterion 20.2),
      // and its one writer is the Subscription_Poller. `clientType` is
      // DERIVED on read from `client_uid` with no column at all (Criterion
      // 15.2). The two look alike on the wire and are opposites underneath.
      connected: row.connected,
      // Requirement 15.1: Client_Type is a pure function of Client_Uid alone,
      // so it is derived HERE on read rather than stored -- no column, no
      // migration, no backfill (Criterion 15.2). A column would go stale the
      // moment the rules changed and would need a backfill to catch up; a
      // client-side regex would drift from this classifier and let the
      // Dashboard card and the user-details modal disagree. Because every
      // method returns through `mapDevice`, all four device endpoints gain
      // the field at once from this single definition.
      clientType: classifyClientType(row.client_uid)
    };
  }
}

module.exports = DeviceManagementService;
module.exports.NotManagedUserError = NotManagedUserError;
module.exports.DeviceNotOwnedError = DeviceNotOwnedError;
