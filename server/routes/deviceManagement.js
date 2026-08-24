const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const { isDeviceMgmtEnabled, isDeviceMgmtRevokeEnabled } = require('../config/deviceMgmt');
const EventPublisher = require('../services/EventPublisher');
const DeviceManagementService = require('../services/DeviceManagementService');

const router = express.Router();

/**
 * server/routes/deviceManagement.js  (device-management task 13.1)
 *
 * Express routes for Device_Management, mounted at `/api/device-management`
 * (server/index.js). A thin HTTP wrapper around
 * `DeviceManagementService` (task 11.1): it validates input, resolves the
 * acting user from `req.user` (`authenticateToken` resolves
 * `req.user.userId` to the LOCAL `users.id` -- see
 * `server/middleware/auth.js`), delegates every authorization question and
 * every Device_Table read to the service, and maps the service's named
 * error classes to HTTP statuses via the same
 * `ERROR_STATUS_BY_NAME`/`handleServiceError` pattern already used by
 * `server/routes/devices.js`/`server/routes/mou.js`. No business logic and
 * no SQL against `tak_devices` lives here.
 *
 * This is a DIFFERENT feature from `server/routes/devices.js`
 * (`/api/devices`, `DeviceEnrollmentService`, `device:manage`), which
 * enrolls team-owned device *accounts*. These four routes surface a user's
 * existing TAK Server client certificates and revoke them, hence the
 * distinct `/api/device-management` prefix and `device_mgmt:*` identifiers
 * (design decision 3).
 *
 * ## Two-layer enablement gate (Requirements 1.8, 1.9)
 *
 * `server/index.js` mounts this router ONLY when `isDeviceMgmtEnabled()`,
 * and every handler below ALSO re-checks the flag as its first action,
 * returning 404 when off. The duplication is deliberate defense in depth:
 * the mount is decided once at boot, while the in-handler check reads
 * `process.env` at call time, so the routes stay inert even if the router
 * is mounted by some other composition (a test harness, a future
 * always-mount refactor) while the feature is off. When off, NOTHING past
 * the flag check runs -- no Device_Table read and, on the revoke paths, no
 * Revoke_Operation enqueue (Requirement 1.9).
 *
 * The 404 body deliberately matches `server/index.js`'s catch-all
 * (`{ error: 'Route not found' }`), and 404 is used rather than 403 so a
 * disabled feature is indistinguishable from one that does not exist
 * (design.md, "Route inertness").
 *
 * ## Client reachability probe (task 15.1)
 *
 * The client decides whether to render the device surfaces by calling
 * `GET /api/device-management/me/devices` and treating a 404 as "feature
 * absent", rather than by calling a dedicated
 * `GET /api/device-management/enabled` endpoint. The design allowed either;
 * the 404-from-the-self-view route was chosen because the self-view is a
 * call the surfaces need to make anyway, so the probe costs no extra
 * endpoint, no extra Permission_Registry entry, and no extra permission
 * identifier -- and it cannot drift out of sync with the routes it is
 * probing for. Consequently the 404 above is part of this feature's client
 * contract, not merely a defensive default.
 *
 * ## Authorization
 *
 * Reachability is gated by the Permission_Registry entries added in task
 * 12.1, and the row-level rules are then re-asserted here through the
 * service:
 *
 *   - `GET /me/devices`, `POST /me/devices/:clientUid/revoke` --
 *     `device_mgmt:read:own` / `device_mgmt:revoke:own`, both in
 *     `roleDefaults.authenticated_user`. The row that scopes the action is
 *     `req.user.userId`, which no request input can widen: the self-view
 *     passes only the caller's own id to `listOwnDevices`, and the
 *     self-revoke calls `assertCanRevokeOwn(req.user.userId, :clientUid)`
 *     BEFORE anything else (Requirements 5.5, 7.5, 9.3).
 *   - `GET /users/:userId/devices`,
 *     `POST /users/:userId/devices/:clientUid/revoke` --
 *     `device_mgmt:read:managed` / `device_mgmt:revoke:managed`, which are
 *     deliberately NOT in `roleDefaults`, so `authorize.js` always consults
 *     their row-scoped resolvers. Those resolvers call the SAME
 *     `DeviceManagementService.isManagedUser`/`findDeviceRow` helpers this
 *     file's handlers reach through `listManagedUserDevices`/
 *     `assertCanRevokeManaged`, so the two layers cannot disagree
 *     (Requirements 6.6, 6.7, 8.5, 8.6, 9.4). The handler-level assertion
 *     is what produces the client-facing 403 message and, on the revoke
 *     path, what guarantees the denial happens before any enqueue even if
 *     this router were ever mounted without `authorize`.
 *
 * ## The separate revocation arming gate (Requirements 12.9, 12.10)
 *
 * `Revoke_Enabled` (`DEVICE_MGMT_REVOKE_ENABLED`, see
 * `server/config/deviceMgmt.js`) is an INDEPENDENT flag that arms the
 * destructive capability. The two revoke routes below require BOTH flags;
 * the two read routes above require `isDeviceMgmtEnabled()` alone and are
 * deliberately untouched by it, because enabling device management in
 * order to LOOK at a device list must not also arm certificate revocation
 * (Requirement 12.9).
 *
 * When disarmed, the revoke routes answer **403** with a body that names
 * the disabled capability
 * (`{ error: 'Device revocation is disabled', capability: 'DEVICE_MGMT_REVOKE_ENABLED' }`).
 * A 404 is deliberately NOT reused: 404 already means Device_Mgmt_Enabled
 * is off (Requirement 1.8), so reusing it would make "the feature is
 * absent" and "revocation is disarmed" indistinguishable to the caller and
 * in the logs (Requirement 12.10).
 *
 * ## Revocation ordering (Requirements 7.3, 7.5, 8.3, 8.5, 12.10)
 *
 * Both revoke handlers run their steps in exactly this order:
 *
 *   1. re-check Device_Mgmt_Enabled -- 404 otherwise (above);
 *   2. assert authorization (ownership, plus Managed_User on the admin
 *      path) -- so an unauthorized attempt is blocked "upfront";
 *   3. assert Revoke_Enabled -- 403 + the named capability otherwise;
 *   4. assert `confirmation === 'REVOKE'` (strict equality, no trimming,
 *      no case folding) -- 400 otherwise;
 *   5. enqueue one device-scoped `revoke_tak_certificates` operation,
 *      `{ client_uid, target_user_id }` (task 19.4).
 *
 * **Why the arming gate sits AFTER authorization** (task 24.2's ordering
 * decision): the 403 naming `DEVICE_MGMT_REVOKE_ENABLED` discloses a
 * deployment-configuration fact -- that this server is running with
 * revocation disarmed. Placing the check before the authorization assert
 * would hand that fact to ANY authenticated caller who can name a route,
 * including one with no claim on the Device, so an unauthorized probe of a
 * disarmed system would learn strictly more than the same probe against an
 * armed one. With the check after the assert, an unauthorized caller gets
 * the identical `DeviceNotOwnedError`/`NotManagedUserError` 403 whether or
 * not the capability is armed -- the response is invariant in the flag --
 * and only a caller who has already proven they may revoke this Device
 * learns why the revoke will not happen. The cost is that an authorized
 * caller's row lookup runs while disarmed, which is harmless: that lookup
 * is the same read they are entitled to make through
 * `GET /me/devices`/`GET /users/:userId/devices`, it is gated on
 * Device_Mgmt_Enabled alone by design, and it mutates nothing.
 *
 * **Why it sits BEFORE the confirmation check.** The confirmation word is
 * an interlock against an accidental destructive action, not an
 * authorization control; when the capability is disarmed there is no
 * destructive action for it to guard. Answering 400 "type REVOKE exactly"
 * on a server that could not revoke anything anyway would misdescribe the
 * failure and invite a retry that can only fail again. The interlock keeps
 * its position relative to the authorization assert and the enqueue, and
 * its behaviour on an armed server is unchanged (`' REVOKE '` and
 * `'revoke'` still take the 400 path) -- only the disarmed server, where no
 * confirmation value can lead to an enqueue, answers 403 first.
 *
 * The enqueue is therefore reachable ONLY after all three gates pass, which
 * is what Property 7 ("enqueued iff the confirmation is exactly `REVOKE`"),
 * Requirement 12.10's "SHALL NOT enqueue a Revoke_Operation from either
 * revoke route" and Requirement 8.5's "before any Revoke_Operation is
 * enqueued" assert.
 * The response is 202, not 200: `revoke_tak_certificates` is a durable
 * Sync_Operation processed later by the Sync_Worker (which is also where
 * the Device_Table `revoked` flag is flipped once TAK Server confirms the
 * revocation, task 9.1), so the request has been accepted, not completed.
 */

/**
 * Maps a `DeviceManagementService` named error to an HTTP status code.
 * Both classes are deliberate, expected authorization rejections
 * documented on the service methods that throw them -- neither represents
 * an internal failure, so each maps to 403 rather than a generic 500.
 *
 * `DeviceNotOwnedError` covers BOTH "no such device" and "not your
 * device" (see its doc comment in `DeviceManagementService.js`): it is
 * deliberately NOT split into a 404, because a distinguishable
 * "device not found" would let any authenticated caller enumerate which
 * device UIDs exist.
 */
const ERROR_STATUS_BY_NAME = {
  NotManagedUserError: 403,
  DeviceNotOwnedError: 403
};

/**
 * Sends the appropriate response for a service error: 403 + the error's
 * own message for either recognized class above, or a generic 500 (logged,
 * no internal detail leaked) for anything else -- notably a database
 * failure, which must NOT degrade into a permissive response.
 *
 * @param {import('express').Response} res
 * @param {Error} error
 * @param {string} logMessage
 */
function handleServiceError(res, error, logMessage) {
  const status = ERROR_STATUS_BY_NAME[error.name];
  if (status) {
    return res.status(status).json({ error: error.message });
  }

  getLogger().error({ err: error }, logMessage);
  return res.status(500).json({ error: logMessage });
}

/**
 * The shared Requirement 1.8/1.9 gate. Returns true (and has already sent
 * the 404) when Device_Mgmt_Enabled is false, so each handler can bail out
 * with a single `if` before touching the database or the queue.
 *
 * @param {import('express').Response} res
 * @returns {boolean} true when the request was answered with a 404.
 */
function respondNotFoundWhenDisabled(res) {
  if (isDeviceMgmtEnabled()) {
    return false;
  }

  res.status(404).json({ error: 'Route not found' });
  return true;
}

/**
 * The Requirement 12.9/12.10 arming gate, used by the two revoke handlers
 * ONLY -- the read handlers stay on `respondNotFoundWhenDisabled` alone.
 * Returns true (and has already sent the 403) when Revoke_Enabled is false,
 * so the handler can bail out before `enqueueRevocation` is ever reached.
 *
 * The status is 403 and the body names the capability, so "revocation is
 * disarmed" is distinguishable from the 404 that means Device_Mgmt_Enabled
 * is off (Requirement 12.10). The body deliberately does NOT reuse the
 * `{ error }`-only shape: `capability` is what lets an operator (and the
 * client) tell this rejection from the authorization 403s above without
 * string-matching a human-readable message.
 *
 * @param {import('express').Response} res
 * @returns {boolean} true when the request was answered with a 403.
 */
function respondForbiddenWhenRevokeDisarmed(res) {
  if (isDeviceMgmtRevokeEnabled()) {
    return false;
  }

  res.status(403).json({
    error: 'Device revocation is disabled',
    capability: 'DEVICE_MGMT_REVOKE_ENABLED'
  });
  return true;
}

/**
 * Runs the express-validator result check, sending the standard
 * `{ errors: [...] }` 400 used by every other route file in this
 * repository.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean} true when the request was answered with a 400.
 */
function respondBadRequestOnValidationErrors(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    return false;
  }

  res.status(400).json({ errors: errors.array() });
  return true;
}

/**
 * The shared tail of both revoke handlers: everything after authorization
 * and confirmation have passed. Enqueues exactly one
 * `revoke_tak_certificates` Sync_Operation with the DEVICE-SCOPED payload,
 * logs the (id-only) outcome, and responds 202.
 *
 * The payload is `{ client_uid, target_user_id }` (task 19.4, Requirements
 * 7.4, 8.4, 12.1). It is deliberately NOT the user-scoped
 * `{ tak_usernames: [...] }` shape the three pre-existing call sites
 * (`TakCertificateRevocationService.revokeUserTakCertificates`,
 * `TeamMembershipService.removeUserFromTeam`'s no-teams-left branch,
 * `Team.delete`'s bulk enqueue) send: that shape makes the Sync_Worker
 * match every certificate whose `creatorDn` matches the username, i.e.
 * every certificate the user holds across ALL of their Devices (60
 * certificates on a single uid in the live data), which is exactly the
 * over-revocation Requirements 7.4/8.4 forbid for a per-Device Revoke
 * action. With the device-scoped shape the handler resolves the target
 * certificates from the `client_uid` at execution time, so a certificate
 * issued between enqueue and execution is still covered and a certificate
 * belonging to another Device never is. Both shapes validate against the
 * operation schema (task 19.2), which requires exactly one of the two
 * discriminators -- the device-scoped one is an ADDITION to the contract,
 * not a replacement.
 *
 * Because there is no username to resolve any more, this no longer reads
 * `users` at all: the `client_uid` is already the key the handler matches
 * on, and the owning user id is already known from the authorized route.
 *
 * `target_user_id` carries the OWNING user (the caller on the self route,
 * the `:userId` target on the admin route), not the acting user; the acting
 * user is recorded separately as the Sync_Operation's `created_by` third
 * argument, which is what makes the queue row attributable to the admin who
 * requested it. It is now sent (rather than omitted, as it was while this
 * path enqueued the user-scoped shape) because `client_uid` already
 * expresses the SCOPE of the revocation on its own, so the id is pure
 * traceability -- `EventPublisher` copies it into
 * `sync_operations.target_user_id`, letting the queue's user-scoped views
 * attribute a device revocation to its owner without that value being what
 * decides which certificates are revoked.
 *
 * The admin route's owner id arrives as a route-param STRING while the
 * schema declares `target_user_id: 'number'`, so it is coerced here. The
 * coercion cannot leak a `NaN`: `param('userId').isInt()` has already run on
 * the admin path and `req.user.userId` is the numeric local `users.id` on
 * the self path, and in the event the value is somehow not an integer the
 * field is omitted rather than sent as `NaN` -- it is optional in the
 * schema, whereas `NaN` would be persisted as JSON `null` and then fail
 * validation in the worker.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ownerUserId: number|string, clientUid: string}} target
 * @returns {Promise<import('express').Response>}
 */
async function enqueueRevocation(req, res, { ownerUserId, clientUid }) {
  const targetUserId = Number(ownerUserId);
  const payload = { client_uid: clientUid };

  if (Number.isInteger(targetUserId)) {
    payload.target_user_id = targetUserId;
  }

  await EventPublisher.publishOperation(
    'revoke_tak_certificates',
    payload,
    req.user && req.user.userId
  );

  // Ids and the device UID only -- no email, no name, no certificate
  // material (Requirement 9.2).
  getLogger().info(
    { clientUid, targetUserId: ownerUserId, actorId: req.user && req.user.userId },
    'Enqueued revoke_tak_certificates operation for a device revocation'
  );

  return res.status(202).json({ enqueued: true });
}

// Requirements 5.1, 5.2, 5.3, 5.5: the caller's OWN Devices. The only
// input is `req.user.userId`, so there is no request-supplied filter that
// could widen the result set. `lastSeenAt` is passed through as null for a
// Device the Subscription_Poller has never observed -- the client renders
// that as "never seen" (Requirement 5.3), so no substitution happens here.
//
// This is also the route the client's reachability probe calls (task 15.1):
// its 404-when-disabled response is what tells the client not to render the
// device surfaces at all.
router.get('/me/devices', authenticateToken, authorize, async (req, res) => {
  if (respondNotFoundWhenDisabled(res)) {
    return;
  }

  try {
    const devices = await DeviceManagementService.listOwnDevices(req.user.userId);
    res.json({ devices });
  } catch (error) {
    handleServiceError(res, error, 'Failed to list your devices');
  }
});

// Requirements 6.1, 6.3, 6.4, 6.5, 6.6, 6.7: a Managed_User's Devices.
// `listManagedUserDevices` asserts the Managed_User relationship BEFORE it
// reads any Device row, so a denied request (403 via `NotManagedUserError`)
// never reads device data. Same response shape as the self-view above, so
// the client's one device-list component serves both surfaces.
router.get('/users/:userId/devices', authenticateToken, authorize, [
  param('userId').isInt().withMessage('userId must be an integer')
], async (req, res) => {
  if (respondNotFoundWhenDisabled(res)) {
    return;
  }
  if (respondBadRequestOnValidationErrors(req, res)) {
    return;
  }

  try {
    const devices = await DeviceManagementService.listManagedUserDevices(req.user, req.params.userId);
    res.json({ devices });
  } catch (error) {
    handleServiceError(res, error, 'Failed to list the devices of the requested user');
  }
});

// Requirements 7.1, 7.3, 7.4, 7.5, 12.9, 12.10: self-service revocation.
// Ownership is asserted first (403 when the Device is not the caller's,
// including when no such Device exists), then Revoke_Enabled (403 naming the
// capability), then the confirmation word, then the enqueue -- so no
// Revoke_Operation can be enqueued by an unauthorized caller, on a disarmed
// server, or by an unconfirmed request (Property 7).
//
// `confirmation` is compared with strict equality to the literal `REVOKE`
// and is NOT trimmed, lower-cased, or otherwise normalized: `' REVOKE '`
// and `'revoke'` are rejected, matching the client dialog's own
// enable-on-exact-match rule (task 15.2). The comparison lives in the
// handler rather than in an express-validator `.equals('REVOKE')` chain so
// that the ordering above is explicit in the code, and so a missing or
// non-string body value takes the same 400 path as a wrong one.
router.post('/me/devices/:clientUid/revoke', authenticateToken, authorize, [
  param('clientUid').isString().notEmpty().withMessage('clientUid is required'),
  body('confirmation').exists().withMessage('confirmation is required')
], async (req, res) => {
  if (respondNotFoundWhenDisabled(res)) {
    return;
  }
  if (respondBadRequestOnValidationErrors(req, res)) {
    return;
  }

  const { clientUid } = req.params;

  try {
    await DeviceManagementService.assertCanRevokeOwn(req.user.userId, clientUid);

    // Requirements 12.9, 12.10: after the ownership assert (so a caller with
    // no claim on this Device cannot learn the arming state), before the
    // confirmation interlock and therefore before any enqueue. See the
    // "Revocation ordering" note at the top of this file.
    if (respondForbiddenWhenRevokeDisarmed(res)) {
      return undefined;
    }

    if (req.body.confirmation !== 'REVOKE') {
      return res.status(400).json({ error: 'Type REVOKE exactly to confirm this revocation' });
    }

    return await enqueueRevocation(req, res, { ownerUserId: req.user.userId, clientUid });
  } catch (error) {
    return handleServiceError(res, error, 'Failed to revoke your device');
  }
});

// Requirements 8.1, 8.3, 8.4, 8.5, 8.6, 12.9, 12.10: admin revocation of a
// Managed_User's Device. `assertCanRevokeManaged` checks BOTH legs -- the
// target is a Managed_User of the acting admin AND the Device belongs to that
// target -- upfront, before the arming gate, before the confirmation check
// and therefore before any enqueue (Requirement 8.5's "blocking an
// unauthorized revocation attempt upfront"). The operation's `target_user_id` is the TARGET user, not the
// acting admin; `req.user.userId` is recorded only as the Sync_Operation's
// `created_by`, which is what makes the queue row attributable to the admin
// who requested it.
router.post('/users/:userId/devices/:clientUid/revoke', authenticateToken, authorize, [
  param('userId').isInt().withMessage('userId must be an integer'),
  param('clientUid').isString().notEmpty().withMessage('clientUid is required'),
  body('confirmation').exists().withMessage('confirmation is required')
], async (req, res) => {
  if (respondNotFoundWhenDisabled(res)) {
    return;
  }
  if (respondBadRequestOnValidationErrors(req, res)) {
    return;
  }

  const { userId, clientUid } = req.params;

  try {
    await DeviceManagementService.assertCanRevokeManaged(req.user, userId, clientUid);

    // Requirements 12.9, 12.10: after BOTH legs of the authorization assert
    // (Managed_User + ownership), before the confirmation interlock and
    // therefore before any enqueue.
    if (respondForbiddenWhenRevokeDisarmed(res)) {
      return undefined;
    }

    if (req.body.confirmation !== 'REVOKE') {
      return res.status(400).json({ error: 'Type REVOKE exactly to confirm this revocation' });
    }

    return await enqueueRevocation(req, res, { ownerUserId: userId, clientUid });
  } catch (error) {
    return handleServiceError(res, error, 'Failed to revoke the requested device');
  }
});

module.exports = router;
