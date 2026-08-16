const crypto = require('crypto');
const pool = require('../config/database');
const Team = require('../models/Team');
const TeamMembershipService = require('./TeamMembershipService');
const authentikService = require('./authentik');
const logger = require('../config/logger').createLogger('DeviceEnrollmentService');

/**
 * Reserved, non-deliverable email subdomain for Team_Owned_Device
 * accounts (Requirement 27 Criterion 2 / Glossary's Team_Owned_Device
 * definition, `design.md` Section 22): every device user's synthetic
 * email is `device-<uuid>@devices.tak.nz.invalid`, so no OIDC login can
 * ever be completed against it. `.invalid` is the IANA-reserved TLD
 * (RFC 2606) specifically intended for addresses that are guaranteed
 * never to resolve/deliver, which is why it -- rather than an
 * organization-owned domain -- is used here.
 */
const DEVICE_EMAIL_DOMAIN = 'devices.tak.nz.invalid';

/**
 * Thrown by `assertAuthorized` (and therefore by every public method of
 * this service that calls it, including `createDevice` here and
 * `generateEnrollmentQrCode` in a later task) when the acting user is
 * neither an admin (per `Team.isAdmin`) of the target team nor a
 * Global_Manager (Requirement 27 Criterion 3). A 400/403-equivalent
 * client error, not a 500 -- callers (route handlers, in a later task)
 * should map this to an HTTP 403 response.
 */
class DeviceEnrollmentAuthorizationError extends Error {
  constructor(message = 'Insufficient authorization to manage this team\'s devices') {
    super(message);
    this.name = 'DeviceEnrollmentAuthorizationError';
  }
}

/**
 * Thrown by `generateEnrollmentQrCode` (Requirement 27 Criterion 3's
 * "generate or regenerate a Team_Owned_Device's enrollment QR code" is
 * covered by `DeviceEnrollmentAuthorizationError` above; this error is
 * distinct and covers the target-record validation the task explicitly
 * calls for) when `deviceUserId` either does not reference an existing
 * `users` row, or references a row whose `is_team_device` flag is not
 * `true`. This method must only ever be usable against an actual
 * Team_Owned_Device, never a human user record -- a 400-equivalent
 * client error, not a 500.
 */
class NotATeamOwnedDeviceError extends Error {
  constructor(message = 'Target user is not a Team_Owned_Device') {
    super(message);
    this.name = 'NotATeamOwnedDeviceError';
  }
}

/**
 * Thrown by `generateEnrollmentQrCode` when `TAK_SERVER_URL` is not
 * configured -- the enrollment URI/iTAK payload's `host` value has no
 * source without it (Requirement 27 Criterion 6).
 */
class TakServerNotConfiguredError extends Error {
  constructor(message = 'TAK_SERVER_URL must be configured to generate a Team_Owned_Device enrollment QR code') {
    super(message);
    this.name = 'TakServerNotConfiguredError';
  }
}

/**
 * Requirement 27 Criterion 7 / `design.md` Section 22: caps every
 * Team_Owned_Device enrollment token's lifetime at 30 minutes from
 * creation, mirroring `enrollment-lambda`'s `TOKEN_EXPIRATION_MINUTES`.
 * Not overridable via environment variable -- the requirement is an
 * explicit upper bound ("no longer than 30 minutes"), not a default.
 */
const ENROLLMENT_TOKEN_EXPIRATION_MINUTES = 30;

/**
 * DeviceEnrollmentService (Requirement 27, `design.md` Section 22):
 * provisions Team_Owned_Device accounts -- device-only, non-human user
 * records (e.g. shared or apparatus equipment) that can never complete
 * an OIDC login, because their Authentik user is created with a
 * synthetic, non-deliverable email under the reserved
 * `devices.tak.nz.invalid` subdomain.
 *
 * Every method on this service shares the same authorization rule
 * (Requirement 27 Criterion 3): the acting user must be an admin (per
 * `Team.isAdmin`) of the target team, or a Global_Manager. That check
 * is centralized in `assertAuthorized` below so it is applied
 * identically by `createDevice` here and by
 * `generateEnrollmentQrCode`/other device-management methods added in
 * later tasks, per `design.md`'s "authorization is ... checked once,
 * reused by every method in this service" note.
 *
 * Task 49.2 implements `createDevice`; task 49.3 adds
 * `generateEnrollmentQrCode` below. The HTTP route layer (task 49.4),
 * `GET /api/users`/dashboard exclusion, and audit logging of QR-code
 * generation (task 49.5) are deliberately out of scope here.
 */
class DeviceEnrollmentService {
  /**
   * Requirement 27 Criterion 3: rejects unless the acting user is an
   * admin (per `Team.isAdmin`) of `teamId`, or a Global_Manager.
   * Global_Manager is checked first (a plain flag check, no database
   * round trip) before falling back to the `Team.isAdmin` lookup,
   * mirroring the check ordering already used by `authorize.js`'s
   * row-scoped resolvers (e.g. `'team:update'`).
   *
   * @param {number|string} teamId
   * @param {{userId?: number, is_global_manager?: boolean}|null|undefined} actingUser
   * @throws {DeviceEnrollmentAuthorizationError}
   */
  static async assertAuthorized(teamId, actingUser) {
    if (actingUser && actingUser.is_global_manager) {
      return;
    }

    const isAdmin = await Team.isAdmin(teamId, actingUser?.userId);
    if (!isAdmin) {
      throw new DeviceEnrollmentAuthorizationError();
    }
  }

  /**
   * Creates a Team_Owned_Device for `teamId` and adds it to that team
   * with the same channel access as a human team member (Requirement 27
   * Criteria 2, 4).
   *
   * Order of operations, following the same "external HTTP call
   * happens strictly BEFORE any DB transaction opens" phasing already
   * established by `UserProvisioningService.createAndAddUser`'s callers
   * (`POST /api/users/create-and-add`):
   *   1. Requirement 27 Criterion 3: authorization check FIRST, before
   *      any Authentik API call or database write.
   *   2. Phase 1 (no open DB transaction): create the Authentik user
   *      via `authentikService.createUser`, with a synthetic,
   *      collision-resistant, non-deliverable email
   *      (`device-<uuid>@devices.tak.nz.invalid`, Requirement 27
   *      Criterion 2). `authentikService.createUser` is the SAME direct
   *      -create path already used for human users elsewhere in this
   *      codebase (`server/routes/users.js`'s `POST /api/users` and
   *      `POST /api/users/create-and-add`), which never triggers
   *      Authentik's invitation/recovery-flow verification email --
   *      per `design.md` Section 22, continuing to use that path (rather
   *      than any invitation-flow endpoint) is what satisfies
   *      Requirement 27 Criterion 4's "explicitly suppresses" wording,
   *      since no verification email is ever dispatched by this path
   *      regardless of the (already non-deliverable) email supplied.
   *   3. Phase 2 (single transaction on one acquired client): upsert the
   *      local `users` row with `is_team_device = true` and
   *      `device_label` set to the given `label`, then call
   *      `TeamMembershipService.addUserToTeam` on that SAME client
   *      (Requirement 17.5's client-threading pattern) so the team
   *      membership insert (and its queued `sync_operations` rows)
   *      commits or rolls back atomically with the `users` row insert.
   *
   * Compensating-action logic for a Phase 2 failure after the Authentik
   * user already exists (Requirement 17.2's pattern, as implemented by
   * `POST /api/users/create-and-add`) is intentionally NOT duplicated
   * here -- it is out of scope for this task and belongs with the route
   * layer added in task 49.4, mirroring how `UserProvisioningService
   * .createAndAddUser` itself also leaves that concern to its caller.
   *
   * @param {number|string} teamId
   * @param {string|null} label - human-readable device label (Glossary's
   *   `device_label`), e.g. `"Engine 4 Tablet"`.
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser
   * @returns {Promise<{deviceUserId: number, authentikUserId: number, username: string, email: string, label: string|null, teamId: number|string}>}
   */
  static async createDevice(teamId, label, actingUser) {
    await DeviceEnrollmentService.assertAuthorized(teamId, actingUser);

    const username = `device-${crypto.randomUUID()}`;
    const email = `${username}@${DEVICE_EMAIL_DOMAIN}`;
    const displayName = label || username;
    const actingUserId = actingUser?.userId ?? null;

    // --- Phase 1: Authentik user creation (no open DB transaction). ---
    const authentikUser = await authentikService.createUser({
      username,
      name: displayName,
      email
    });

    // --- Phase 2: single transaction for every local database write. ---
    const client = await pool.connect();
    let deviceUserId;
    try {
      await client.query('BEGIN');

      const insertResult = await client.query(
        `INSERT INTO users (authentik_user_id, username, email, is_active, is_team_device, device_label)
         VALUES ($1, $2, $3, true, true, $4)
         RETURNING id`,
        [authentikUser.pk, username, email, label || null]
      );
      deviceUserId = insertResult.rows[0].id;

      await TeamMembershipService.addUserToTeam(deviceUserId, teamId, 'member', actingUserId, client);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(
        { err: error, authentikUserId: authentikUser.pk, teamId },
        'Failed to provision team-owned device locally after Authentik user creation'
      );
      throw error;
    } finally {
      client.release();
    }

    logger.info(
      { deviceUserId, authentikUserId: authentikUser.pk, teamId, actingUserId },
      'Team-owned device created'
    );

    return {
      deviceUserId,
      authentikUserId: authentikUser.pk,
      username,
      email,
      label: label || null,
      teamId
    };
  }

  /**
   * Requirement 27 Criteria 3, 5-7 (task 49.3): generates a fresh
   * enrollment QR code payload for an existing Team_Owned_Device, on
   * demand, restricted to that device's team's admin or a
   * Global_Manager.
   *
   * Order of operations:
   *   1. Load the target `users` row and confirm it exists AND has
   *      `is_team_device = true` (this method must never be usable
   *      against a human user record) -- `NotATeamOwnedDeviceError`
   *      otherwise.
   *   2. Resolve which team the device DIRECTLY belongs to (the
   *      `team_memberships` row with `inherited_from_team_id IS NULL`,
   *      per `server/models/Team.js`'s existing convention that a user
   *      has at most one direct membership -- see the partial unique
   *      index added by `1786670000000_partial-unique-team
   *      -memberships.cjs`), since `generateEnrollmentQrCode` is called
   *      with a `deviceUserId`, not a `teamId` directly.
   *   3. Requirement 27 Criterion 3: repeat the SAME authorization check
   *      `createDevice` uses (`assertAuthorized`), against the resolved
   *      team id -- this is a distinct sensitive action from device
   *      creation, so the check is deliberately repeated here rather
   *      than trusted from an earlier call, per `design.md` Section 22's
   *      "authorization check repeated (defense in depth...)" note.
   *   4. Create a short-lived Authentik `app_password` token scoped to
   *      the device's Authentik user, expiring
   *      `ENROLLMENT_TOKEN_EXPIRATION_MINUTES` (30) minutes from now
   *      (Requirement 27 Criterion 7), via
   *      `authentikService.createAppPasswordToken`.
   *   5. Build and return both representations required by Requirement
   *      27 Criterion 6: an ATAK `tak://com.atakmap.app/enroll?...` URI,
   *      and the equivalent iTAK JSON registration payload, using the
   *      same host/username/token values.
   *
   * Per this task's explicit scope, audit logging of the generation
   * event (Requirement 27 Criterion 8) is NOT implemented here -- that
   * is task 49.5's responsibility; the route layer added in task 49.4
   * is expected to log the `audit_logs` row after calling this method,
   * using the `deviceUserId`/`actingUser` this method already received.
   *
   * @param {number|string} deviceUserId - the Team_Owned_Device's local
   *   `users.id`.
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser
   * @returns {Promise<{
   *   deviceUserId: number|string,
   *   teamId: number,
   *   username: string,
   *   host: string,
   *   expiresAt: string,
   *   atakEnrollmentUri: string,
   *   itakEnrollmentPayload: {host: string, username: string, token: string}
   * }>}
   * @throws {NotATeamOwnedDeviceError} when `deviceUserId` doesn't
   *   reference an existing Team_Owned_Device.
   * @throws {DeviceEnrollmentAuthorizationError} per Requirement 27
   *   Criterion 3.
   * @throws {TakServerNotConfiguredError} when `TAK_SERVER_URL` is unset.
   */
  static async generateEnrollmentQrCode(deviceUserId, actingUser) {
    const userResult = await pool.query(
      'SELECT id, username, authentik_user_id, is_team_device FROM users WHERE id = $1',
      [deviceUserId]
    );
    const deviceUser = userResult.rows[0];
    if (!deviceUser || !deviceUser.is_team_device) {
      throw new NotATeamOwnedDeviceError();
    }

    const membershipResult = await pool.query(
      'SELECT team_id FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL',
      [deviceUserId]
    );
    const teamId = membershipResult.rows[0]?.team_id;
    if (teamId === undefined) {
      throw new NotATeamOwnedDeviceError('Team_Owned_Device has no team membership');
    }

    // Requirement 27 Criterion 3: authorization check repeated (defense
    // in depth) against the resolved team, matching createDevice's rule.
    await DeviceEnrollmentService.assertAuthorized(teamId, actingUser);

    const takServerUrl = process.env.TAK_SERVER_URL;
    if (!takServerUrl) {
      throw new TakServerNotConfiguredError();
    }
    const host = new URL(takServerUrl).hostname;

    // Requirement 27 Criterion 7: token identifier must be unique
    // (Authentik's TokenRequest.identifier pattern is
    // `^[-a-zA-Z0-9_]+$`) -- a fresh uuid per call satisfies both
    // uniqueness and that pattern.
    const tokenIdentifier = `device-enrollment-${crypto.randomUUID()}`;
    const token = await authentikService.createAppPasswordToken(deviceUser.authentik_user_id, {
      identifier: tokenIdentifier,
      expiresInMinutes: ENROLLMENT_TOKEN_EXPIRATION_MINUTES
    });

    const atakEnrollmentUri =
      `tak://com.atakmap.app/enroll?host=${encodeURIComponent(host)}` +
      `&username=${encodeURIComponent(deviceUser.username)}` +
      `&token=${encodeURIComponent(token.key)}`;

    const itakEnrollmentPayload = {
      host,
      username: deviceUser.username,
      token: token.key
    };

    logger.info(
      { deviceUserId, teamId, actingUserId: actingUser?.userId ?? null, expiresAt: token.expires },
      'Team-owned device enrollment QR code generated'
    );

    return {
      deviceUserId: deviceUser.id,
      teamId,
      username: deviceUser.username,
      host,
      expiresAt: token.expires,
      atakEnrollmentUri,
      itakEnrollmentPayload
    };
  }
}

module.exports = DeviceEnrollmentService;
module.exports.DeviceEnrollmentAuthorizationError = DeviceEnrollmentAuthorizationError;
module.exports.NotATeamOwnedDeviceError = NotATeamOwnedDeviceError;
module.exports.TakServerNotConfiguredError = TakServerNotConfiguredError;
module.exports.DEVICE_EMAIL_DOMAIN = DEVICE_EMAIL_DOMAIN;
module.exports.ENROLLMENT_TOKEN_EXPIRATION_MINUTES = ENROLLMENT_TOKEN_EXPIRATION_MINUTES;
