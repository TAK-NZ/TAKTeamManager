const crypto = require('crypto');
const QRCode = require('qrcode');
const pool = require('../config/database');
const Team = require('../models/Team');
const User = require('../models/User');
const TeamMembershipService = require('./TeamMembershipService');
const EventPublisher = require('./EventPublisher');
const authentikService = require('./authentik');
const ManagedIdentifierService = require('./ManagedIdentifierService');
const UserAttributesService = require('./userAttributes');
const CallsignService = require('./CallsignService');
const DirectoryScopeService = require('./DirectoryScopeService');
const { partitionCandidates } = require('../utils/directoryScope');
const { MAX_TEAM_DEPTH } = require('../config/constants');
const { IDENTIFIER_TYPE_MARKERS } = require('../utils/managedIdentifier');
const { isValidCallsignPrefix } = require('../utils/callsignValidation');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const { checkCallsignSuffixUniqueness } = require('./CallsignSuffixUniquenessService');
const logger = require('../config/logger').createLogger('DeviceEnrollmentService');

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
 * Thrown by `generateEnrollmentQrCode` when `deviceUserId` either does
 * not reference an existing `users` row, or references a row whose
 * `is_team_device` flag is not `true`.
 *
 * takserver-enrollment Correction 4 / task 7.2: this is NO LONGER a
 * capability limit on what `#buildEnrollment` may mint for -- the
 * private core has no `is_team_device` guard of any kind and happily
 * accepts a Human_Principal row (Criterion 3.2), which is what makes
 * `generateSelfEnrollment` below possible. What this guard means now is
 * `generateEnrollmentQrCode`'s SCOPING rule: this is a PARAMETERISED
 * route that addresses its subject BY ID, and the only subject kind a
 * caller may address by id through THIS method is a Team_Owned_Device.
 * Widening it to accept a human target would force its authorization
 * rule to become "is the caller an admin of that human's team" -- which
 * directly contradicts Criterion 3.3's "deny every request whose target
 * is any other account": a human's own enrollment must be self-service
 * only, triggered by that human's own session via
 * `generateSelfEnrollment`, never by an admin supplying someone else's
 * id. The two readings produce the same `throw` and completely
 * different designs; do not delete this guard on the strength of
 * Correction 4 alone.
 */
class NotATeamOwnedDeviceError extends Error {
  constructor(message = 'Target user is not a Team_Owned_Device') {
    super(message);
    this.name = 'NotATeamOwnedDeviceError';
  }
}

/**
 * Thrown by `generateSelfEnrollment` when the authenticated session
 * resolves to a `users` row with `is_team_device === true`.
 *
 * takserver-enrollment Requirement 14.5: a Team_Owned_Device has no
 * session and no human owner, so there is no self-service case for it
 * at all -- this is either a session defect (a device row somehow
 * carrying a valid JWT) or an attack, never a legitimate request, which
 * is why it is a distinct, clearly-named refusal rather than a reuse of
 * `NotATeamOwnedDeviceError` above. That class's meaning is narrowed to
 * `generateEnrollmentQrCode`'s BY-ID scoping rule in this same task, and
 * reusing it here would conflate "wrong principal kind for this
 * parameterised route" with "no principal kind is valid for this
 * session at all".
 */
class DeviceSessionCannotSelfEnrollError extends Error {
  constructor(message = 'A Team_Owned_Device session cannot self-enroll') {
    super(message);
    this.name = 'DeviceSessionCannotSelfEnrollError';
  }
}

/**
 * Thrown by `generateEnrollmentQrCode`/`generateSelfEnrollment` when
 * `TAK_SERVER_ENROLLMENT_URL` is not configured -- the enrollment
 * URI/iTAK payload's `host` value has no source without it (Requirement
 * 27 Criterion 6).
 *
 * `TAK_SERVER_ENROLLMENT_URL` is DELIBERATELY a separate variable from
 * `TAK_SERVER_URL`: the latter is the Marti certadmin API's mutual-TLS
 * endpoint (`TakServerService.js`, typically an internal/admin
 * address), which is not necessarily the hostname a CLIENT device
 * should dial for enrollment/streaming (typically a public-facing name
 * on port 8089). Conflating the two would enroll every device against
 * the wrong host wherever the two differ.
 */
class TakServerNotConfiguredError extends Error {
  constructor(message = 'TAK_SERVER_ENROLLMENT_URL must be configured to generate a TAK Server enrollment QR code') {
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
 * takserver-enrollment Requirement 10.3 / Criterion 3.10: the verified
 * TAK Server client certificate lifetime -- confirmed against six live
 * certificates, each satisfying `issued_at + 365 days = expires_at`. Used
 * ONLY to compute `#buildEnrollment`'s `reEnrollmentDate` as an arithmetic
 * estimate at generation time; the new certificate does not exist yet at
 * that moment, so the ALTERNATIVE -- reading a stored `tak_devices.expires_at`
 * -- would be either absent (first enrollment) or belong to the
 * certificate being REPLACED (re-enrollment), which is worse than an
 * estimate because it looks authoritative and is wrong.
 */
const CERTIFICATE_LIFETIME_DAYS = 365;

/**
 * takserver-enrollment Requirement 4.4: TAK Server's client
 * enrollment/streaming TLS port, as it appears in the iTAK_Registration_
 * Payload's `connectionString`. Always correct for this deployment
 * shape and therefore a CODE CONSTANT, never an environment variable or
 * a site-config value -- a configurable port would add a way to render
 * a broken QR code without adding a way to render a working one that
 * `8089` does not already cover.
 */
const ENROLLMENT_PORT = 8089;

/**
 * DeviceEnrollmentService (Requirement 27, `design.md` Section 22):
 * provisions Team_Owned_Device accounts -- device-only, non-human user
 * records (e.g. shared or apparatus equipment) that can never complete
 * an OIDC login, because their Authentik user is created with NO email
 * at all (takserver-enrollment Requirement 5, superseding the shipped
 * synthetic reserved-subdomain address -- Correction 2): a device
 * account cannot log in, cannot read mail, and has no human owner, so an
 * email on it has no function and is pure attack surface.
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
   * with the same channel access as a human team member (takserver-
   * enrollment Requirements 1.3, 5.1, 5.2, 14.1, 14.2, 14.3, 14.4, 14.8,
   * 14.9). Re-phased onto the Claim_Row and the Managed_Identifier
   * (Corrections 1 and 2, superseding the shipped `device-<uuid>`
   * username and its synthetic `.invalid` email -- see design.md
   * "Minting a unique Managed_Identifier (the Claim_Row)").
   *
   * A device account has no email at all: it cannot log in, cannot read
   * mail, and has no human owner (takserver-enrollment Requirement 5).
   *
   * Order of operations:
   *   1. Requirement 3.3 (production-hardening, carried forward):
   *      authorization check FIRST, before any Authentik API call or
   *      database write.
   *   2. Resolve the device's Organisation as
   *      `Team.getAncestorChain(teamId)[0]` -- the chain is ROOT-FIRST,
   *      so index 0 IS the Organisation; never a positional read from
   *      the tail -- to get `organisationId` and `organisationPrefix`
   *      (`callsign_prefix`). A missing/invalid prefix throws
   *      `ManagedIdentifierService.OrganisationPrefixMissingError`
   *      before any Authentik call and before any Claim_Row is written
   *      (Criterion 2.9): no placeholder prefix, team name, or team id
   *      is ever substituted.
   *   3. Phase 0 -- Claim. `ManagedIdentifierService.mintUniqueIdentifier`
   *      runs with a `D`-marker Managed_Identifier, with `claim(candidate)`
   *      being a SINGLE-statement `INSERT INTO users (...) VALUES (...)
   *      RETURNING id`, carrying the candidate username,
   *      `authentik_user_id = NULL`, `is_active = false`,
   *      `is_team_device = true`, `email = NULL`, `device_label =
   *      <label>`. No transaction is opened -- the statement runs
   *      against the shared `pool` and is its own unit of work, so a
   *      rejected candidate costs one local round trip and nothing
   *      external.
   *
   *      The Claim_Row window is exactly one HTTP round trip (through
   *      Phase 1 below) and is invisible to every existing surface:
   *      `GET /api/users` sources its list from Authentik and joins
   *      locally by `authentik_user_id`, so a row with a null one
   *      cannot appear; `GET /api/users/search` and
   *      `GET /api/users/available` filter `is_active = true`; every
   *      team surface joins `team_memberships`, and a Claim_Row has no
   *      membership row yet; and the Authentik_Sync keys on
   *      `authentik_user_id` and would not match it.
   *
   *      The accepted cost: a process death between the claim and its
   *      compensation (below) leaves a Claim_Row behind. It consumes
   *      one Managed_Identifier out of 27.5 billion per Organisation per
   *      marker, which does not matter. For a HUMAN Claim_Row this also
   *      holds `users_email_key` for that address, which is a real wart
   *      (design.md's "The cost, stated rather than hidden") -- but a
   *      DEVICE Claim_Row has `email = NULL`, so `users_email_key` is
   *      never held by it and this specific cost does not apply to
   *      devices. A periodic sweep of abandoned Claim_Rows is a NAMED
   *      FOLLOW-UP, not part of this task. The Device_Email_Null_Invariant
   *      (`email IS NOT NULL OR is_team_device = true`) is NEVER weakened
   *      to `... OR authentik_user_id IS NULL` to work around this --
   *      that would stop the constraint rejecting the exact row it
   *      exists to reject, in the exact circumstance a defect is most
   *      likely.
   *   4. Phase 1 -- Authentik. `authentikService.createUser` with the
   *      CLAIMED username (from Phase 0's result), reached at most once
   *      per creation, with a username already known to be locally
   *      unique. `device_label` maps to Authentik's `name` field, in
   *      place of the first and last name a human carries (Criterion
   *      14.3). The request body carries NO `email` key at all -- not
   *      an `email: undefined` property relying on `JSON.stringify` to
   *      drop it, but a genuinely absent key, since a device has no
   *      email (Criterion 5.1).
   *   5. Phase 2 -- Adopt and attach. One client, one `BEGIN`:
   *      `UPDATE users SET authentik_user_id = $1, is_active = true
   *      WHERE id = $claimId`, then
   *      `TeamMembershipService.addUserToTeam` on that SAME client
   *      (Requirement 17.5's client-threading pattern) so the team
   *      membership insert (and its queued `sync_operations` rows)
   *      commits or rolls back atomically with the adoption -- giving
   *      the device one `team_memberships` row with
   *      `inherited_from_team_id IS NULL` and the same channel access a
   *      human member of that Team receives (Criteria 14.1, 14.2).
   *   6. Compensation. On a Phase 1 OR Phase 2 failure:
   *      `DELETE FROM users WHERE id = $claimId AND
   *      authentik_user_id IS NULL`, run against the shared `pool`,
   *      outside any transaction. The `AND authentik_user_id IS NULL`
   *      predicate is the ENTIRE safety of this statement -- it can
   *      only ever remove a row that never acquired a federated
   *      counterpart, so the product rule "never delete a federated
   *      identity to achieve a local outcome" is not engaged at all.
   *      Where Phase 1 succeeded and Phase 2 failed, the pre-existing
   *      compensating-Authentik-delete pattern (`server/routes/users.js`
   *      plus the queued cleanup handler in `server/workers/
   *      syncWorker.js`) also runs, beside the Claim_Row delete -- the
   *      same `authentik_user_id IS NULL` predicate is what stops the
   *      two compensations both removing the same row.
   *
   * No `callsign_level_selection` is written on the device's Team, and
   * nothing about the inheritance of `color`/`callsign_name_format`
   * from the Organisation changes: a device's Callsign is generated by
   * exactly the same rules as a human's (Criterion 14.9).
   *
   * ## Callsign_Suffix (Name segment), added alongside the above
   *
   * Unlike a human member, a device's `callsign_suffix` is never
   * computed from anything (there is no first/last name to derive it
   * from) -- it is either the caller-supplied `callsignSuffix` or
   * absent entirely (`null`), stored verbatim on the Claim_Row exactly
   * like a human's, so this device's generated Callsign carries the
   * same Name segment a human member's would (Criterion 14.9's "exactly
   * the same rules as a human's" extends to this field too). A
   * non-empty value is checked, BEFORE the Claim_Row is even inserted,
   * against the SAME per-team uniqueness rule every human callsign
   * suffix is checked against (`checkCallsignSuffixUniqueness`) -- so a
   * device's callsign can never collide with another device's or a
   * human member's, and a colliding request never consumes a
   * Managed_Identifier or writes a Claim_Row at all.
   *
   * @param {number|string} teamId
   * @param {string|null} label - human-readable device label (Glossary's
   *   `device_label`), e.g. `"Engine 4 Tablet"`.
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser
   * @param {string|null} [callsignSuffix] - the device's Name segment,
   *   checked for a per-team collision before creation. `null`/empty
   *   skips the check entirely (nothing to compare).
   * @returns {Promise<{deviceUserId: number, authentikUserId: number, username: string, label: string|null, teamId: number|string}>}
   * @throws {module:CallsignSuffixUniquenessService.CallsignSuffixConflictError}
   *   when `callsignSuffix` collides, case-insensitively, with another
   *   member's or device's `callsign_suffix` in this team.
   */
  static async createDevice(teamId, label, actingUser, callsignSuffix = null) {
    await DeviceEnrollmentService.assertAuthorized(teamId, actingUser);

    const actingUserId = actingUser?.userId ?? null;
    const trimmedCallsignSuffix = typeof callsignSuffix === 'string' && callsignSuffix.trim() !== ''
      ? callsignSuffix.trim()
      : null;

    // Resolve the device's Organisation as the ROOT of the Ancestor_Chain
    // (index 0, never a positional tail read) to get the
    // Organisation_Prefix a Managed_Identifier is minted against.
    const ancestorChain = await Team.getAncestorChain(teamId);
    const organisation = ancestorChain[0];
    const organisationPrefix = organisation?.callsign_prefix;

    if (
      typeof organisationPrefix !== 'string' ||
      organisationPrefix.trim().length === 0 ||
      !isValidCallsignPrefix(organisationPrefix)
    ) {
      throw new ManagedIdentifierService.OrganisationPrefixMissingError(organisation?.id);
    }

    // Checked BEFORE Phase 0's Claim_Row insert -- a colliding suffix
    // must never consume a Managed_Identifier or write a row at all,
    // mirroring `UserProvisioningService.resolveNewUserIdentity`'s own
    // "check before mint" ordering for a human member.
    await checkCallsignSuffixUniqueness(teamId, trimmedCallsignSuffix);

    // --- Phase 0: Claim. A single-statement INSERT against the shared
    // pool -- no transaction is opened, so a rejected candidate costs
    // one local round trip and nothing external. authentik_user_id is
    // NULL and is_active is false, which is what makes this Claim_Row
    // invisible to every existing surface until Phase 2 adopts it.
    const { username, claim: claimResult } = await ManagedIdentifierService.mintUniqueIdentifier({
      organisationPrefix,
      organisationId: organisation.id,
      typeMarker: IDENTIFIER_TYPE_MARKERS.DEVICE,
      claim: async (candidate) => pool.query(
        `INSERT INTO users (username, authentik_user_id, is_active, is_team_device, email, device_label, callsign_suffix)
         VALUES ($1, NULL, false, true, NULL, $2, $3)
         RETURNING id`,
        [candidate, label || null, trimmedCallsignSuffix]
      )
    });
    const claimId = claimResult.rows[0].id;

    const displayName = label || username;

    // --- Phase 1: Authentik user creation (no open DB transaction).
    // The claimed username is already known to be locally unique, so
    // this is reached at most once per creation. NO email key at all --
    // built without one rather than assigned `undefined`, since a
    // device account has no email and no function for one to serve.
    // device-management follow-up: created as an Authentik `service_account`
    // user, not `internal` (AuthentikService.createUser's default) -- a
    // device has no email, never interactively logs in, and only ever
    // authenticates via the app-password token `createAppPasswordToken`
    // mints for it later (`generateEnrollmentQrCode`/`generateSelfEnrollment`),
    // which is exactly the shape Authentik's `service_account` type is for.
    // See `AuthentikService.createUser`'s doc comment for the live
    // verification behind this.
    let authentikUser;
    try {
      authentikUser = await authentikService.createUser({
        username,
        name: displayName,
        type: 'service_account'
      });
    } catch (error) {
      await DeviceEnrollmentService.#compensateClaimRow(claimId, { authentikUserId: null, teamId });
      throw error;
    }

    // --- Phase 2: adopt the Claim_Row and attach team membership, one
    // client, one transaction. ---
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'UPDATE users SET authentik_user_id = $1, is_active = true WHERE id = $2',
        [authentikUser.pk, claimId]
      );

      await TeamMembershipService.addUserToTeam(claimId, teamId, 'member', actingUserId, client);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(
        { err: error, authentikUserId: authentikUser.pk, claimId, teamId },
        'Failed to adopt and attach team-owned device locally after Authentik user creation'
      );
      await DeviceEnrollmentService.#compensateClaimRow(claimId, { authentikUserId: authentikUser.pk, teamId });
      throw error;
    } finally {
      client.release();
    }

    logger.info(
      { deviceUserId: claimId, authentikUserId: authentikUser.pk, teamId, actingUserId },
      'Team-owned device created'
    );

    return {
      deviceUserId: claimId,
      authentikUserId: authentikUser.pk,
      username,
      label: label || null,
      callsignSuffix: trimmedCallsignSuffix,
      teamId
    };
  }

  /**
   * Compensation for a Phase 1 (Authentik) or Phase 2 (adopt/attach)
   * failure during `createDevice`. Deletes the Claim_Row with
   * `DELETE FROM users WHERE id = $1 AND authentik_user_id IS NULL` --
   * the `AND` clause is the ENTIRE safety of this statement, since it
   * can only ever remove a row that never acquired a federated
   * counterpart. Runs against the shared `pool`, outside any
   * transaction.
   *
   * WHERE Phase 1 already succeeded (an Authentik user exists) and
   * Phase 2 then failed, this also runs the pre-existing compensating-
   * Authentik-delete pattern used elsewhere in this codebase
   * (`server/routes/users.js`; the queued fallback handled by
   * `server/workers/syncWorker.js`'s `cleanupOrphanedAuthentikUser`):
   * a synchronous delete of the Authentik user first, falling back to
   * an enqueued `cleanup_orphaned_authentik_user` Sync_Operation if the
   * synchronous delete itself fails. The `authentik_user_id IS NULL`
   * predicate on the Claim_Row delete is what stops the two
   * compensations from ever conflicting over the same row: by the time
   * the Authentik user exists, the Claim_Row delete's predicate no
   * longer matches, so exactly one of the two compensations touches any
   * given row.
   *
   * Every compensation attempt and its outcome is logged via the
   * Structured_Logger.
   *
   * @param {number} claimId - the Claim_Row's local `users.id`.
   * @param {{authentikUserId: number|null, teamId: number|string}} context
   */
  static async #compensateClaimRow(claimId, { authentikUserId, teamId }) {
    try {
      const deleteResult = await pool.query(
        'DELETE FROM users WHERE id = $1 AND authentik_user_id IS NULL',
        [claimId]
      );
      logger.info(
        { claimId, teamId, rowsDeleted: deleteResult.rowCount },
        'Team-owned device Claim_Row compensation: deleted'
      );
    } catch (deleteError) {
      logger.error(
        { err: deleteError, claimId, teamId },
        'Team-owned device Claim_Row compensation: DELETE failed'
      );
    }

    if (!authentikUserId) {
      return;
    }

    // Phase 1 succeeded before Phase 2 failed: the Authentik user is now
    // orphaned. Attempt a synchronous delete first; fall back to an
    // enqueued cleanup operation for the Sync_Worker to retry.
    let compensationOutcome;
    try {
      const deleteResponse = await fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }
      });

      if (deleteResponse.ok || deleteResponse.status === 404) {
        compensationOutcome = 'deleted_synchronously';
      } else {
        throw new Error(`Authentik delete responded with status ${deleteResponse.status}`);
      }
    } catch (deleteError) {
      logger.error(
        { err: deleteError, authentikUserId },
        'Synchronous compensating Authentik user delete failed; falling back to a queued cleanup operation'
      );
      try {
        await EventPublisher.publishOperation('cleanup_orphaned_authentik_user', { authentik_user_id: authentikUserId }, null);
        compensationOutcome = 'cleanup_operation_queued';
      } catch (enqueueError) {
        logger.error(
          { err: enqueueError, authentikUserId },
          'Failed to enqueue cleanup_orphaned_authentik_user compensating operation'
        );
        compensationOutcome = 'compensation_failed';
      }
    }

    logger.error(
      { authentikUserId, claimId, teamId, compensationOutcome },
      'Team-owned device: Authentik user created but local adoption failed; orphaned Authentik user compensating action outcome'
    );
  }

  /**
   * takserver-enrollment Requirements 3.11, 5.9, 5.10, 13.6, 14.6, 14.7
   * (task 8.2): lists every Team_Owned_Device directly (`inherited_
   * from_team_id IS NULL`) belonging to `teamId`, for the admin surface
   * that keeps a device reachable despite Criterion 5.8's email-search
   * exclusion.
   *
   * Repeats the SAME authorization check every other public method of
   * this service uses (Criterion 3.11) rather than trusting the route
   * layer: Global_Manager, or `Team.isAdmin(teamId, actingUser.userId)`
   * via `assertAuthorized`.
   *
   * ONE single statement resolves the whole list, independent of its
   * length (Criterion 13.6): a `users` JOIN `team_memberships` (direct
   * membership only) restricted to Team_Owned_Devices, LEFT JOINed
   * against a derived table that pre-aggregates `tak_devices` into a
   * per-`user_id` live (non-revoked) certificate count -- the SAME
   * derived-table shape task 8.6 adds to `GET /api/users`'s
   * `live_certificate_count` projection, so the two surfaces resolve a
   * principal's live certificate count identically.
   *
   * No `email` column is selected at all (Criterion 5.10): a device has
   * none, and a placeholder is forbidden. `teamId` is not re-derived per
   * row -- this method only ever lists ONE team's devices, so the
   * parameter is echoed back onto every returned device object.
   *
   * This is purely additive: it neither reads nor writes any existing
   * human-member-count or human-member-list query (Criterion 14.6) --
   * see `server/models/Team.js` and `server/routes/teams.js`, both
   * untouched by this method.
   *
   * Bugfix (Members/Team Admins/Team Devices tab consistency): also
   * returns `callsignSuffix`, `takRole` and a computed `callsign` for
   * each device -- the same three facts the Members/Team Admins tabs
   * show for a human member (`callsign_suffix`, `tak_role`,
   * `tak_callsign`), so this tab's row shape can mirror theirs
   * ("TAK Callsign & Role"). Unlike a human member, a device's
   * `callsign` is computed HERE rather than read off a stored
   * `user_cache.tak_callsign` column -- a Team_Owned_Device has no
   * `user_cache` row at all (that table mirrors Authentik-authoritative
   * human attributes; a device's `tak_role` lives on `users` directly,
   * defaulted `'Team Member'` by its own column default) -- using
   * `CallsignService.assembleCallsign` directly against ONE
   * `Team.getAncestorChain(teamId)` call shared across every device in
   * the list, exactly mirroring `UserAttributesService.
   * computeCallsignAttributes`'s own assembly rule but batched to avoid
   * an N+1 (one ancestor-chain query per device) that a live re-query
   * would otherwise force -- `teamId` is the SAME team for every device
   * returned here.
   *
   * @param {number|string} teamId
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser
   * @returns {Promise<{devices: Array<{deviceUserId: number, username: string, deviceLabel: string|null, callsignSuffix: string|null, takRole: string, callsign: string|null, teamId: number|string, createdAt: string, accountStatus: 'active'|'suspended'|'orphaned', liveCertificateCount: number, expiresAt: string|null}>}>}
   * @throws {DeviceEnrollmentAuthorizationError}
   */
  static async listTeamDevices(teamId, actingUser) {
    await DeviceEnrollmentService.assertAuthorized(teamId, actingUser);

    // `expiresAt` (added alongside the pre-existing `live_certificate_count`
    // aggregate, same derived-table join, no second query): the SOONEST
    // `expires_at` among this device's own LIVE (non-revoked) certificates
    // -- `MIN(...)`, not the newest -- since the certificate that lapses
    // FIRST is the one an admin needs to act on. `NULL` when the device
    // holds no live certificate at all (a brand-new device that has never
    // been enrolled, or one whose only certificate was revoked), which the
    // client's `classifyExpiry` already treats as "no highlighting" --
    // exactly the right behaviour for a device with nothing to warn about.
    const result = await pool.query(
      `SELECT u.id AS device_user_id,
              u.username AS username,
              u.device_label AS device_label,
              u.callsign_suffix AS callsign_suffix,
              u.tak_role AS tak_role,
              u.created_at AS created_at,
              u.account_status AS account_status,
              COALESCE(certs.live_certificate_count, 0) AS live_certificate_count,
              certs.earliest_expires_at AS expires_at
       FROM users u
       JOIN team_memberships tm ON tm.user_id = u.id AND tm.inherited_from_team_id IS NULL
       LEFT JOIN (
         SELECT user_id, COUNT(*)::int AS live_certificate_count, MIN(expires_at) AS earliest_expires_at
         FROM tak_devices
         WHERE user_id IS NOT NULL AND revoked = false
         GROUP BY user_id
       ) certs ON certs.user_id = u.id
       WHERE tm.team_id = $1 AND u.is_team_device = true`,
      [teamId]
    );

    // One Ancestor_Chain resolution for the whole list -- every device
    // returned here belongs to this SAME team, so the Organisation
    // segment/Team segment/Callsign_Level_Selection are identical for
    // each row; only the Name segment (`callsign_suffix`) varies.
    // Guarded to `[]` for anything non-array (an empty device list needs
    // no chain at all, and a caller's mock that leaves getAncestorChain
    // unconfigured must not throw destructuring `[0]` off `undefined`).
    const rawAncestorChain = result.rows.length > 0 ? await Team.getAncestorChain(teamId) : [];
    const ancestorChain = Array.isArray(rawAncestorChain) ? rawAncestorChain : [];
    const organisation = ancestorChain[0];
    const callsignLevelSelection =
      organisation?.callsign_level_selection == null
        ? Array.from({ length: MAX_TEAM_DEPTH }, (_, i) => i + 1)
        : organisation.callsign_level_selection;
    const teamSegmentPrefixes = ancestorChain
      .filter(
        (t) =>
          t.depth >= 1 &&
          callsignLevelSelection.includes(t.depth) &&
          !!t.callsign_prefix
      )
      .map((t) => t.callsign_prefix);

    const devices = result.rows.map((row) => ({
      deviceUserId: row.device_user_id,
      username: row.username,
      deviceLabel: row.device_label,
      callsignSuffix: row.callsign_suffix,
      takRole: row.tak_role,
      callsign: organisation
        ? CallsignService.assembleCallsign({
            organisationPrefix: organisation.callsign_prefix,
            teamSegmentPrefixes,
            nameSegment: row.callsign_suffix
          })
        : null,
      teamId,
      createdAt: row.created_at,
      accountStatus: row.account_status,
      liveCertificateCount: row.live_certificate_count,
      expiresAt: row.expires_at
    }));

    return { devices };
  }

  /**
   * Org-wide Team_Owned_Device listing (`/devices` page, mirroring
   * `GET /api/users`' own org-wide listing for human members). Unlike
   * `listTeamDevices` above -- which is scoped to exactly one Team named
   * by the caller and authorized via `Team.isAdmin(teamId, ...)` -- this
   * method has no single team in scope: it returns every
   * Team_Owned_Device the ACTING USER may see across their whole
   * Organisation-scoped visibility, the same visibility
   * `DirectoryScopeService`/`GET /api/users` already define for human
   * members. There is no separate "device visibility" rule to invent: a
   * Team_Owned_Device is a `users` row like any other, so the SAME
   * Scoped_Organisations / Allowed_Domains resolution applies, with the
   * Email_Domain leg of `isCandidateVisible` simply never matching (a
   * device has no email -- Device_Email_Null_Invariant) rather than
   * short-circuited around it.
   *
   * A Global_Manager gets every Team_Owned_Device, unfiltered
   * (`DirectoryScopeService.UNSCOPED`), exactly mirroring `GET /api/users`.
   * A non-Global_Manager gets only the rows `isCandidateVisible` admits by
   * `origin_org_id` or Direct_Membership Organisation -- the pagination
   * total, unlike `GET /api/users`' Authentik-sourced count, is computed
   * from the SAME `candidates` CTE via a `COUNT(*) OVER()` window so it is
   * exact rather than an over-count (this listing has no upstream-service
   * pagination quirk to inherit).
   *
   * `can_manage` mirrors `GET /api/users`' own field exactly: Global_Manager
   * manages everything; otherwise Set-membership of the device's own
   * `team_id` against `Team.getManagedTeamIds(actingUser.userId)`, resolved
   * ONCE for the whole page rather than per row.
   *
   * `expiresAt` (added alongside `liveCertificateCount`, same derived-table
   * join, no second query): the soonest `expires_at` among this device's
   * own live certificates, `null` when it holds none. Lets the client
   * highlight an imminent/expired certificate the same way `DeviceListRow`
   * already does for a human's own device list -- see `expiryWarning.js`'s
   * `classifyExpiry`.
   *
   * cert-expiry-notifications Requirement 7.3(b) (task 14.1): `expiringOnly`
   * narrows the result to devices whose live certificate `classifyExpiry`s
   * as imminent or expired on the client -- the SAME threshold the
   * Dashboard renew banner and every device list's highlighting already
   * use (`DEVICE_MGMT_EXPIRY_WARNING_DAYS`). Read directly here (rather
   * than via `SiteConfig.getPublicConfig()`, which resolves the WHOLE
   * public-config row set) with the identical `parseInt(...) > 0 ?
   * ... : default` discipline that file's own resolution already uses,
   * so the two stay in lockstep without adding a cross-module
   * dependency for one scalar. This filter introduces no new
   * authorization rule -- it only adds a WHERE predicate on top of the
   * SAME `canManage`/scoping logic every other caller of this method
   * already gets.
   *
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser
   * @param {{page: number, pageSize: number, search?: string, expiringOnly?: boolean}} pageParams
   * @returns {Promise<{devices: Array<{deviceUserId: number, username: string, deviceLabel: string|null, callsignSuffix: string|null, takRole: string, callsign: string|null, teamId: number|null, teamName: string|null, createdAt: string, accountStatus: 'active'|'suspended'|'orphaned', liveCertificateCount: number, expiresAt: string|null, canManage: boolean}>, pagination: {page: number, pageSize: number, total: number}}>}
   */
  static async listAllDevices(actingUser, { page, pageSize, search, expiringOnly = false } = {}) {
    const offset = (page - 1) * pageSize;
    const searchTerm = typeof search === 'string' ? search.trim() : '';

    const DEFAULT_EXPIRY_WARNING_DAYS = 30;
    const parsedExpiryWarningDays = parseInt(process.env.DEVICE_MGMT_EXPIRY_WARNING_DAYS, 10);
    const expiryWarningDays =
      Number.isFinite(parsedExpiryWarningDays) && parsedExpiryWarningDays > 0
        ? parsedExpiryWarningDays
        : DEFAULT_EXPIRY_WARNING_DAYS;

    const scope = await DirectoryScopeService.resolveScope(actingUser);
    const isUnscoped = scope === DirectoryScopeService.UNSCOPED;

    // Every device's Organisation is resolved via the SAME `team_root` CTE
    // `DirectoryScopeService.TEAM_ROOT_CTE` shares with `GET /api/users`
    // (Requirement-parity: "the root of the Ancestor_Chain has one
    // definition on the server"), joined against the device's OWN direct
    // team membership -- a Team_Owned_Device always carries exactly one
    // (Requirement 14.1), so an INNER JOIN (never LEFT) is correct here and
    // a device with no membership row simply cannot appear, matching
    // `listTeamDevices`'s own `JOIN team_memberships` above.
    //
    // Scope params are supplied even for an unscoped (Global_Manager)
    // caller: `COALESCE(..., false)` renders the disjunct false when
    // `organisationIds` is empty, so passing `[]`/`[]` for an unscoped
    // caller is harmless -- `in_scope` is simply never read on that branch.
    const organisationIds = isUnscoped ? [] : scope.organisationIds;
    const searchPattern = searchTerm ? `%${searchTerm}%` : null;

    const params = [organisationIds, searchPattern];

    const query = `
      WITH RECURSIVE team_root AS (
        ${DirectoryScopeService.TEAM_ROOT_CTE}
      ),
      candidates AS (
        SELECT u.id AS device_user_id,
               u.username AS username,
               u.device_label AS device_label,
               u.callsign_suffix AS callsign_suffix,
               u.tak_role AS tak_role,
               u.created_at AS created_at,
               u.account_status AS account_status,
               u.origin_org_id AS origin_org_id,
               tm.team_id AS team_id,
               CASE
                 WHEN t.parent_team_id IS NOT NULL THEN
                   COALESCE(root.root_callsign_prefix, root.root_name, '') || ' - ' || t.name
                 ELSE t.name
               END AS team_name,
               root.root_id AS direct_membership_org_id,
               COALESCE(certs.live_certificate_count, 0) AS live_certificate_count,
               certs.earliest_expires_at AS expires_at,
               (COALESCE(u.origin_org_id = ANY($1::int[]), false)
                OR COALESCE(root.root_id = ANY($1::int[]), false)) AS in_scope
        FROM users u
        JOIN team_memberships tm ON tm.user_id = u.id AND tm.inherited_from_team_id IS NULL
        JOIN teams t ON tm.team_id = t.id
        LEFT JOIN team_root root ON root.team_id = t.id AND root.parent_team_id IS NULL
        LEFT JOIN (
          SELECT user_id, COUNT(*)::int AS live_certificate_count, MIN(expires_at) AS earliest_expires_at
          FROM tak_devices
          WHERE user_id IS NOT NULL AND revoked = false
          GROUP BY user_id
        ) certs ON certs.user_id = u.id
        WHERE u.is_team_device = true
          AND ($2::text IS NULL OR u.username ILIKE $2 OR u.device_label ILIKE $2)
          -- cert-expiry-notifications Requirement 7.3(b): when expiringOnly
          -- is requested, narrow to a device whose SOONEST live certificate
          -- is already expired or expires within expiryWarningDays -- the
          -- same imminent/expired classification classifyExpiry applies
          -- client-side, computed here in SQL for this one filter rather
          -- than fetching every device to filter client-side.
          AND ($6::boolean = false OR certs.earliest_expires_at IS NOT NULL)
          AND ($6::boolean = false OR certs.earliest_expires_at <= NOW() + ($7::int * INTERVAL '1 day'))
      ),
      counted AS (
        SELECT c.*, COUNT(*) FILTER (WHERE $3::boolean OR c.in_scope) OVER () AS total_count
        FROM candidates c
      )
      SELECT *
      FROM counted
      WHERE $3::boolean OR in_scope
      ORDER BY created_at DESC NULLS LAST, username ASC
      LIMIT $4 OFFSET $5
    `;

    params.push(isUnscoped, pageSize, offset, expiringOnly, expiryWarningDays);

    const result = await pool.query(query, params);

    // Belt-and-braces predicate pass (Requirement-parity with
    // `GET /api/users`): the SAME `scope` object is the sole input to both
    // the SQL parameters and this predicate, so the response can never be
    // wider than what `isCandidateVisible` itself permits. Skipped entirely
    // for a Global_Manager, matching `GET /api/users`' own UNSCOPED branch.
    let rows = result.rows;
    if (!isUnscoped) {
      const toFacts = (row) => ({
        email: null,
        originOrgId: row.origin_org_id ?? null,
        directMembershipOrgId: row.direct_membership_org_id ?? null,
      });
      rows = partitionCandidates(scope, result.rows, toFacts).visible;
    }

    const total = result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;

    // can_manage, resolved ONCE for the whole page -- mirrors
    // `GET /api/users`' identical `Team.getManagedTeamIds` call exactly.
    const managedTeamIds = actingUser && actingUser.is_global_manager
      ? null
      : await Team.getManagedTeamIds(actingUser && actingUser.userId);

    // Ancestor_Chain resolution is per-TEAM (not per-device): several
    // devices on the page may share a team, so each distinct `team_id` is
    // resolved at most once, mirroring `listTeamDevices`'s single-chain
    // reuse but extended across however many distinct teams appear on this
    // page (an org-wide listing spans more than one team, unlike
    // `listTeamDevices`).
    const distinctTeamIds = [...new Set(rows.map((row) => row.team_id).filter((id) => id != null))];
    const chainByTeamId = new Map();
    await Promise.all(
      distinctTeamIds.map(async (teamId) => {
        const rawChain = await Team.getAncestorChain(teamId);
        chainByTeamId.set(teamId, Array.isArray(rawChain) ? rawChain : []);
      })
    );

    const devices = rows.map((row) => {
      const ancestorChain = chainByTeamId.get(row.team_id) || [];
      const organisation = ancestorChain[0];
      const callsignLevelSelection =
        organisation?.callsign_level_selection == null
          ? Array.from({ length: MAX_TEAM_DEPTH }, (_, i) => i + 1)
          : organisation.callsign_level_selection;
      const teamSegmentPrefixes = ancestorChain
        .filter(
          (t) =>
            t.depth >= 1 &&
            callsignLevelSelection.includes(t.depth) &&
            !!t.callsign_prefix
        )
        .map((t) => t.callsign_prefix);

      return {
        deviceUserId: row.device_user_id,
        username: row.username,
        deviceLabel: row.device_label,
        callsignSuffix: row.callsign_suffix,
        takRole: row.tak_role,
        callsign: organisation
          ? CallsignService.assembleCallsign({
              organisationPrefix: organisation.callsign_prefix,
              teamSegmentPrefixes,
              nameSegment: row.callsign_suffix
            })
          : null,
        teamId: row.team_id,
        teamName: row.team_name,
        createdAt: row.created_at,
        accountStatus: row.account_status,
        liveCertificateCount: row.live_certificate_count,
        expiresAt: row.expires_at,
        canManage: managedTeamIds === null ? true : managedTeamIds.has(row.team_id)
      };
    });

    return {
      devices,
      pagination: { page, pageSize, total }
    };
  }

  /**
   * Bugfix ("unable to edit ... a team device"): updates an EXISTING
   * Team_Owned_Device's `device_label` and/or `callsign_suffix` -- the
   * device counterpart of `PATCH /api/teams/:teamId/members/:userId`
   * for a human member. Repeats the SAME authorization rule every other
   * public method of this service uses (Criterion 3.11): resolves the
   * device's direct team membership and calls `assertAuthorized`
   * against it, so a caller must be an admin of that team (or a
   * Global_Manager) to edit it.
   *
   * `callsignSuffix`, when supplied (including an explicit `null`/empty
   * string to clear it), is checked against the SAME per-team
   * uniqueness rule `createDevice` and the member-edit route already
   * use (`checkCallsignSuffixUniqueness`), excluding the device's own
   * row from the comparison so re-submitting its own unchanged suffix
   * never spuriously conflicts with itself. `deviceLabel`, when
   * supplied, is trimmed and stored verbatim (an empty string clears
   * it, matching `createDevice`'s own `label || null` convention).
   *
   * `undefined` for either parameter means "not supplied" and leaves
   * that column untouched, mirroring `Team.update`'s COALESCE
   * convention.
   *
   * Bugfix (Members/Team Admins/Team Devices tab consistency): the
   * returned shape now also carries `takRole` and a recomputed
   * `callsign` -- the SAME two fields `listTeamDevices` added -- so the
   * client's optimistic row-merge after a save (`{...device, ...updated}`
   * in `TeamDeviceList.jsx`) keeps the callsign column showing the
   * device's NEW `callsign_suffix`-derived value immediately, rather than
   * a stale one left over from before the edit until the next full
   * re-fetch.
   *
   * @param {number|string} deviceUserId - the Team_Owned_Device's local
   *   `users.id`.
   * @param {{deviceLabel?: string|null, callsignSuffix?: string|null}} updates
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser
   * @returns {Promise<{deviceUserId: number, username: string, deviceLabel: string|null, callsignSuffix: string|null, takRole: string, callsign: string|null, teamId: number|string}>}
   * @throws {NotATeamOwnedDeviceError} when `deviceUserId` doesn't
   *   reference an existing Team_Owned_Device with a team membership.
   * @throws {DeviceEnrollmentAuthorizationError} per Requirement 27 Criterion 3.
   * @throws {module:CallsignSuffixUniquenessService.CallsignSuffixConflictError}
   */
  static async updateDevice(deviceUserId, { deviceLabel, callsignSuffix } = {}, actingUser) {
    const userResult = await pool.query(
      'SELECT id, username, is_team_device FROM users WHERE id = $1',
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

    await DeviceEnrollmentService.assertAuthorized(teamId, actingUser);

    const updateFields = {};

    if (deviceLabel !== undefined) {
      const trimmedLabel = typeof deviceLabel === 'string' ? deviceLabel.trim() : deviceLabel;
      updateFields.device_label = trimmedLabel || null;
    }

    if (callsignSuffix !== undefined) {
      const trimmedSuffix = typeof callsignSuffix === 'string' && callsignSuffix.trim() !== ''
        ? callsignSuffix.trim()
        : null;

      // Checked BEFORE the write, excluding this device's own row, so a
      // collision never persists and re-submitting its own unchanged
      // value never spuriously conflicts with itself.
      await checkCallsignSuffixUniqueness(teamId, trimmedSuffix, deviceUserId);

      updateFields.callsign_suffix = trimmedSuffix;
    }

    const updatedUser = await User.update(deviceUserId, updateFields);

    logger.info(
      { deviceUserId, teamId, actingUserId: actingUser?.userId ?? null },
      'Team-owned device updated'
    );

    // Same single-device Ancestor_Chain assembly `listTeamDevices` uses
    // for a whole list, applied here to just this one row so the
    // returned `callsign` reflects the just-saved `callsign_suffix`
    // immediately.
    const ancestorChain = await Team.getAncestorChain(teamId);
    const organisation = Array.isArray(ancestorChain) ? ancestorChain[0] : undefined;
    const callsignLevelSelection =
      organisation?.callsign_level_selection == null
        ? Array.from({ length: MAX_TEAM_DEPTH }, (_, i) => i + 1)
        : organisation.callsign_level_selection;
    const teamSegmentPrefixes = (Array.isArray(ancestorChain) ? ancestorChain : [])
      .filter(
        (t) =>
          t.depth >= 1 &&
          callsignLevelSelection.includes(t.depth) &&
          !!t.callsign_prefix
      )
      .map((t) => t.callsign_prefix);

    return {
      deviceUserId,
      username: updatedUser.username,
      deviceLabel: updatedUser.device_label,
      callsignSuffix: updatedUser.callsign_suffix,
      takRole: updatedUser.tak_role,
      callsign: organisation
        ? CallsignService.assembleCallsign({
            organisationPrefix: organisation.callsign_prefix,
            teamSegmentPrefixes,
            nameSegment: updatedUser.callsign_suffix
          })
        : null,
      teamId
    };
  }

  /**
   * Bugfix ("unable to ... delete a team device"): permanently removes
   * an EXISTING Team_Owned_Device -- its `team_memberships`/
   * `channel_memberships` rows, its Authentik user, and its local
   * `users` row. Mirrors `DELETE /api/users/remove-from-team/:userId`'s
   * shape (the existing human-member delete path in
   * `server/routes/users.js`) rather than
   * `TeamMembershipService.removeUserFromTeam` alone, since a
   * Team_Owned_Device has no separate "remove from team but keep the
   * account" concept the way a human member does -- there is no
   * "device with no team" state this application has any use for, and
   * the product's "never delete a federated identity to achieve a
   * local outcome" rule is about a HUMAN's identity; a device account
   * has no human behind it to preserve.
   *
   * Repeats the SAME authorization rule every other public method of
   * this service uses: resolves the device's direct team membership and
   * calls `assertAuthorized` against it.
   *
   * Enqueues `revoke_tak_certificates` for this device's username
   * (mirroring `TeamMembershipService.removeUserFromTeam`'s own
   * "revoke every live certificate when a user leaves every team"
   * step), since a Team_Owned_Device being deleted here always leaves
   * every team.
   *
   * @param {number|string} deviceUserId - the Team_Owned_Device's local
   *   `users.id`.
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser
   * @returns {Promise<{deviceUserId: number, teamId: number|string}>}
   * @throws {NotATeamOwnedDeviceError} when `deviceUserId` doesn't
   *   reference an existing Team_Owned_Device with a team membership.
   * @throws {DeviceEnrollmentAuthorizationError} per Requirement 27 Criterion 3.
   */
  static async deleteDevice(deviceUserId, actingUser) {
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

    await DeviceEnrollmentService.assertAuthorized(teamId, actingUser);

    const actingUserId = actingUser?.userId ?? null;
    const authentikUserId = deviceUser.authentik_user_id;
    const username = deviceUser.username;

    // Mirrors TeamMembershipService.removeUserFromTeam's own effect on
    // team_memberships/channel_memberships, then the same
    // Authentik-user-delete + local-row-delete sequence
    // `DELETE /api/users/remove-from-team/:userId` uses for a human
    // member -- a Team_Owned_Device has no "keep the account, leave the
    // team" state to preserve, so both halves happen together here.
    await TeamMembershipService.removeUserFromTeam(deviceUserId, actingUserId);

    if (authentikUserId) {
      try {
        await fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }
        });
      } catch (deleteError) {
        logger.error(
          { err: deleteError, deviceUserId, authentikUserId },
          'Failed to delete team-owned device from Authentik'
        );
      }
      await pool.query('DELETE FROM user_cache WHERE authentik_id = $1', [String(authentikUserId)]);
    }

    await pool.query('DELETE FROM users WHERE id = $1', [deviceUserId]);

    logger.info(
      { deviceUserId, teamId, actingUserId, username },
      'Team-owned device deleted'
    );

    return { deviceUserId, teamId };
  }

  /**
   * takserver-enrollment Requirement 3 (task 7.2): the self-service
   * public entry point. Its ONLY argument is `actingUser` -- there is NO
   * subject-id parameter of any kind, which is the entire mechanism
   * behind Criterion 3.4's "no caller-supplied subject": with no id to
   * supply, there is no id to tamper with, and the self-only rule cannot
   * be defeated by a parameter (design decision 6 explicitly rejects a
   * single `generateEnrollment(subjectId = actingUser.userId, ...)` for
   * exactly this reason -- see `#buildEnrollment`'s doc comment).
   *
   * Resolves the subject from `actingUser.userId` ALONE (via
   * `User.findById`), never from any request body/query/param the
   * caller might supply (Criterion 3.3, 3.4). If the resolved row has
   * `is_team_device === true`, this is refused with
   * `DeviceSessionCannotSelfEnrollError` rather than served -- a device
   * has no session and no human owner, so a session resolving to one is
   * either a defect or an attack (Criterion 14.5), and this refusal IS
   * the complete self-scoping check (Criterion 3.11): no separate admin
   * check is needed or appropriate, since the method takes no subject
   * other than the caller's own session.
   *
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser
   * @returns {Promise<object>} `#buildEnrollment`'s full return shape.
   * @throws {DeviceSessionCannotSelfEnrollError} when the session
   *   resolves to a Team_Owned_Device row.
   * @throws {TakServerNotConfiguredError}
   */
  static async generateSelfEnrollment(actingUser) {
    const subjectRow = await User.findById(actingUser?.userId);

    if (!subjectRow || subjectRow.is_team_device === true) {
      throw new DeviceSessionCannotSelfEnrollError();
    }

    return DeviceEnrollmentService.#buildEnrollment(subjectRow, {
      actingUserId: actingUser?.userId ?? null,
      principalKind: 'human'
    });
  }

  /**
   * The preview counterpart to `generateSelfEnrollment`: resolves and
   * authorizes the SAME subject (the caller's own session, and nothing
   * else -- Criterion 3.4), then delegates to `#resolvePrincipalPreview`
   * instead of `#buildEnrollment`, so calling this NEVER mints an
   * Enrollment_Token. Intended for the Enrollment_View's initial,
   * automatic render of its "Enrollment Data" section, before the human
   * has clicked "Generate Enrollment Data".
   *
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser
   * @returns {Promise<object>} `#resolvePrincipalPreview`'s return shape.
   * @throws {DeviceSessionCannotSelfEnrollError} when the session
   *   resolves to a Team_Owned_Device row.
   * @throws {TakServerNotConfiguredError}
   */
  static async previewSelfEnrollment(actingUser) {
    const subjectRow = await User.findById(actingUser?.userId);

    if (!subjectRow || subjectRow.is_team_device === true) {
      throw new DeviceSessionCannotSelfEnrollError();
    }

    return DeviceEnrollmentService.#resolvePrincipalPreview(subjectRow, {
      principalKind: 'human'
    });
  }

  /**
   * Requirement 27 Criteria 3, 5-7; takserver-enrollment Requirement 3
   * (task 7.2, re-pointed through `#buildEnrollment`): generates a fresh
   * enrollment payload for an existing Team_Owned_Device, on demand,
   * restricted to that device's team's admin or a Global_Manager.
   * SIGNATURE unchanged from the shipped method.
   *
   * Order of operations, unchanged from the shipped method (already
   * right for the device path):
   *   1. Load the target `users` row and confirm it exists AND has
   *      `is_team_device = true` -- `NotATeamOwnedDeviceError`
   *      otherwise. See that error class's doc comment for its NEW,
   *      NARROWER meaning as of this task: no longer a capability limit
   *      on what may be minted for (`#buildEnrollment` has none), but
   *      THIS route's scoping rule -- the only subject kind addressable
   *      BY ID through this method is a Team_Owned_Device (Criterion
   *      3.3).
   *   2. Resolve which team the device DIRECTLY belongs to (the
   *      `team_memberships` row with `inherited_from_team_id IS NULL`).
   *   3. Repeat the SAME authorization check `createDevice` uses
   *      (`assertAuthorized`), against the resolved team id (defense in
   *      depth, Criterion 3.11).
   *   4. Delegate to `#buildEnrollment` with `principalKind: 'device'`,
   *      so token minting and payload construction are shared with the
   *      self-service path (Criterion 3.1).
   *
   * Return shape: `#buildEnrollment`'s full, corrected object (Criterion
   * 4.1-4.8's payload shape, superseding the shipped `{ host, username,
   * token }` iTAK object per Correction 3), with `teamId` added back in
   * explicitly -- `#buildEnrollment` resolves the principal's team
   * internally but does not return it at the top level, and this
   * method's callers need it and already have it in scope. The richer
   * shape (`reEnrollmentDate`, `atakQrDataUrl`, `itakQrDataUrl`,
   * `takAttributes`, `liveCertificateCount`) is exposed rather than
   * truncated back to the old narrower one, since exposing it is the
   * whole point of routing this method through the shared core.
   *
   * @param {number|string} deviceUserId - the Team_Owned_Device's local
   *   `users.id`.
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser
   * @returns {Promise<object>} `#buildEnrollment`'s return shape, plus
   *   `teamId`.
   * @throws {NotATeamOwnedDeviceError} when `deviceUserId` doesn't
   *   reference an existing Team_Owned_Device.
   * @throws {DeviceEnrollmentAuthorizationError} per Requirement 27
   *   Criterion 3.
   * @throws {TakServerNotConfiguredError} when `TAK_SERVER_ENROLLMENT_URL` is unset.
   */
  static async generateEnrollmentQrCode(deviceUserId, actingUser) {
    const userResult = await pool.query(
      'SELECT id, username, authentik_user_id, is_team_device, tak_role FROM users WHERE id = $1',
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

    // Requirement 27 Criterion 3 / takserver-enrollment Criterion 3.11:
    // authorization check repeated (defense in depth) against the
    // resolved team, matching createDevice's rule.
    await DeviceEnrollmentService.assertAuthorized(teamId, actingUser);

    const enrollment = await DeviceEnrollmentService.#buildEnrollment(deviceUser, {
      actingUserId: actingUser?.userId ?? null,
      principalKind: 'device'
    });

    return { ...enrollment, teamId };
  }

  /**
   * The preview counterpart to `generateEnrollmentQrCode`: same subject
   * resolution and the SAME authorization check (Criterion 3.11), but
   * delegates to `#resolvePrincipalPreview` instead of
   * `#buildEnrollment`, so calling this NEVER mints an
   * Enrollment_Token. Intended for the Enrollment_View's initial,
   * automatic render of its "Enrollment Data" section for a
   * Team_Owned_Device, before an admin has clicked "Generate Enrollment
   * Data".
   *
   * @param {number|string} deviceUserId - the Team_Owned_Device's local
   *   `users.id`.
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser
   * @returns {Promise<object>} `#resolvePrincipalPreview`'s return
   *   shape, plus `teamId`.
   * @throws {NotATeamOwnedDeviceError} when `deviceUserId` doesn't
   *   reference an existing Team_Owned_Device.
   * @throws {DeviceEnrollmentAuthorizationError} per Requirement 27
   *   Criterion 3.
   * @throws {TakServerNotConfiguredError} when `TAK_SERVER_ENROLLMENT_URL` is unset.
   */
  static async previewEnrollmentQrCode(deviceUserId, actingUser) {
    const userResult = await pool.query(
      'SELECT id, username, authentik_user_id, is_team_device, tak_role FROM users WHERE id = $1',
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

    await DeviceEnrollmentService.assertAuthorized(teamId, actingUser);

    const preview = await DeviceEnrollmentService.#resolvePrincipalPreview(deviceUser, {
      principalKind: 'device'
    });

    return { ...preview, teamId };
  }

  /**
   * takserver-enrollment Requirement 4, Correction 3 (task 7.1): builds
   * the iTAK_Registration_Payload iTAK actually parses, superseding the
   * shipped `{ host, username, token }` shape `generateEnrollmentQrCode`
   * still returns above (that shape is corrected by a later task, not
   * this one).
   *
   * Exactly four top-level keys: `passphrase` (the STRING `'false'`,
   * never the boolean -- the Lambda emits the string and iTAK is known
   * to accept it; a JSON boolean is a different, unverified value,
   * Criterion 4.2), `type`, `serverCredentials` (carrying only
   * `connectionString`), and `userCredentials` (carrying `username`,
   * `password` and `registrationId`). There is NO top-level `token` key
   * at any level -- the token value goes ONLY in
   * `userCredentials.password` (Criterion 4.3).
   *
   * `registrationId` is INJECTED with a `crypto.randomUUID()` default
   * (Criterion 4.5), so a test can hold it fixed while varying every
   * other input, and production still gets a fresh uuid per payload.
   *
   * @param {string} host
   * @param {string} username
   * @param {string} tokenKey
   * @param {string} [registrationId]
   * @returns {{passphrase: string, type: string, serverCredentials: {connectionString: string}, userCredentials: {username: string, password: string, registrationId: string}}}
   */
  static buildItakRegistrationPayload(host, username, tokenKey, registrationId = crypto.randomUUID()) {
    return {
      passphrase: 'false',
      type: 'registration',
      serverCredentials: {
        connectionString: `${host}:${ENROLLMENT_PORT}:ssl`
      },
      userCredentials: {
        username,
        password: tokenKey,
        registrationId
      }
    };
  }

  /**
   * takserver-enrollment Requirement 4.7 (task 7.1): a pure extraction
   * of the ATAK deep-link construction `generateEnrollmentQrCode` above
   * already builds inline. Preserves that construction EXACTLY -- this
   * document changes nothing about it, because it already matches the
   * Enrollment_Lambda.
   *
   * @param {string} host
   * @param {string} username
   * @param {string} tokenKey
   * @returns {string}
   */
  static buildAtakEnrollmentUri(host, username, tokenKey) {
    return `tak://com.atakmap.app/enroll?host=${encodeURIComponent(host)}` +
      `&username=${encodeURIComponent(username)}` +
      `&token=${encodeURIComponent(tokenKey)}`;
  }

  /**
   * takserver-enrollment Requirement 11 (task 7.1): renders one QR code
   * server-side to a base64 `data:` URL, one implementation serving
   * both Enrollment_Principals (Criteria 11.1, 11.4).
   *
   * Deliberately `QRCode.toDataURL`, NOT `toBuffer`.
   * `SignupCodeService.generateQrPng` uses `toBuffer` because its
   * consumers are a `res.send` and a `pdfkit` `doc.image` -- a raw PNG
   * buffer suits both. This consumer is an `<img src>` in a React
   * component fed from a JSON response body, where a Buffer cannot
   * travel without a separate base64-encoding step on the way out.
   * `toDataURL` returns the already-encoded `data:image/png;base64,...`
   * string this consumer actually needs.
   *
   * @param {string} text
   * @returns {Promise<string>}
   */
  static async renderQrDataUrl(text) {
    return QRCode.toDataURL(text);
  }

  /**
   * takserver-enrollment Requirement 3 (task 7.1): the private core
   * shared by both public enrollment entry points added in a later
   * task. Performs NO authorization and NO subject/row resolution --
   * `principal` is an ALREADY-RESOLVED `users` row, and the caller is
   * responsible for both authorizing the request and resolving that
   * row. Deliberately has NO `is_team_device` guard of any kind, which
   * is what lets it serve a Human_Principal as well as a
   * Team_Owned_Device (Criteria 3.1, 3.2) -- `#buildEnrollment` itself
   * makes no distinction between the two beyond the `principalKind`
   * label it is handed and echoes back for logging/auditing.
   *
   * Order of operations, and why:
   *   1. Resolve `host = new URL(TAK_SERVER_ENROLLMENT_URL).hostname` FIRST,
   *      before any Authentik call and before any token mint. If
   *      `TAK_SERVER_ENROLLMENT_URL` is unset (or unparseable), throw
   *      `TakServerNotConfiguredError` before anything else has a side
   *      effect -- minting a token first and failing to build a URI
   *      afterwards would leave a live 30-minute credential in
   *      Authentik that nothing will ever use and nothing will ever
   *      clean up.
   *   2. Mint the Enrollment_Token via
   *      `authentikService.createAppPasswordToken`, capped at
   *      `ENROLLMENT_TOKEN_EXPIRATION_MINUTES` (Criteria 3.10, 15.4).
   *   3. Build the ATAK URI and the iTAK payload from the SAME `host`
   *      value, so the two QR codes on one Enrollment_View can never
   *      name different servers (Criterion 4.6).
   *   4. Render both QR data URLs via `renderQrDataUrl`.
   *   5. Resolve `takAttributes` from LOCAL values only (Criterion
   *      10.5): `role` read directly off `principal.tak_role` (no
   *      re-query); `callsign` via
   *      `UserAttributesService.generateCallsign(principal.id, teamId)`,
   *      the same derivation every other surface uses, where `teamId`
   *      is the principal's Direct_Membership team (the same query
   *      `generateEnrollmentQrCode` already uses); `color` from the
   *      resolved Organisation's `teams.color` via
   *      `Team.getAncestorChain(teamId)[0]` (root-first, never a
   *      positional tail read). A principal with NO team membership
   *      yields the explicit string `'None'` for both, following the
   *      Enrollment_Lambda's own `extractAttribute` default (Criterion
   *      15.3) -- `generateCallsign` cannot resolve a Callsign or an
   *      Organisation colour with no team to read either from.
   *   6. `liveCertificateCount` is the ONLY `tak_devices` access this
   *      method makes: a scalar `count(*) ... WHERE user_id = $1 AND
   *      revoked = false`. It projects no timestamp, so this method is
   *      structurally incapable of reading `tak_devices.expires_at`
   *      (Criterion 10.3) -- there is no query in it that could.
   *   7. `reEnrollmentDate` is computed as `now + CERTIFICATE_LIFETIME_
   *      DAYS * 86400000` (exactly 365 * 24 hours in milliseconds, never
   *      a calendar-year `Date` manipulation), independent of any
   *      `tak_devices` row.
   *   8. Log via the Structured_Logger, passing NO enrollment artifact
   *      -- no token, no QR data, no payload -- only non-secret
   *      identifiers, matching the shape `generateEnrollmentQrCode`
   *      already logs (Criterion 11.5).
   *
   * @param {object} principal - an already-resolved `users` row.
   * @param {{actingUserId: number|string|null, principalKind: 'human'|'device'}} options
   * @returns {Promise<{
   *   principalId: number|string,
   *   principalKind: 'human'|'device',
   *   username: string,
   *   host: string,
   *   expiresAt: string,
   *   reEnrollmentDate: string,
   *   atakEnrollmentUri: string,
   *   itakRegistrationPayload: object,
   *   atakQrDataUrl: string,
   *   itakQrDataUrl: string,
   *   takAttributes: {callsign: string, color: string, role: string},
   *   liveCertificateCount: number
   * }>}
   * @throws {TakServerNotConfiguredError}
   */
  // takserver-enrollment design decision 6: this core takes an
  // ALREADY-RESOLVED row and NO subject-id parameter of its own. It is
  // deliberately NOT the single public `generateEnrollment(subjectId =
  // actingUser.userId, actingUser)` that would satisfy every criterion's
  // letter -- that shape puts a DEFAULTED, OVERRIDABLE subject on the one
  // function that mints a live credential, so the self-only rule would
  // rest on every present and future caller remembering never to pass the
  // first argument, and a single added `req.body.userId ?? undefined`
  // would silently convert self-only into self-or-anyone with no test
  // failing. `generateSelfEnrollment` and `generateEnrollmentQrCode`
  // above are the two public entry points: both resolve and authorize
  // their subject ABOVE this line, and converge only here, below the
  // authorization decision -- never above it.
  static async #buildEnrollment(principal, { actingUserId, principalKind }) {
    const preview = await DeviceEnrollmentService.#resolvePrincipalPreview(principal, { principalKind });
    const { host } = preview;

    // Requirement 27 Criterion 7 / Criterion 15.4: token identifier must
    // be unique (Authentik's TokenRequest.identifier pattern is
    // `^[-a-zA-Z0-9_]+$`) -- a fresh uuid per call satisfies both.
    const tokenIdentifier = `device-enrollment-${crypto.randomUUID()}`;
    const token = await authentikService.createAppPasswordToken(principal.authentik_user_id, {
      identifier: tokenIdentifier,
      expiresInMinutes: ENROLLMENT_TOKEN_EXPIRATION_MINUTES
    });

    const atakEnrollmentUri = DeviceEnrollmentService.buildAtakEnrollmentUri(host, principal.username, token.key);
    const itakRegistrationPayload = DeviceEnrollmentService.buildItakRegistrationPayload(host, principal.username, token.key);

    const [atakQrDataUrl, itakQrDataUrl] = await Promise.all([
      DeviceEnrollmentService.renderQrDataUrl(atakEnrollmentUri),
      DeviceEnrollmentService.renderQrDataUrl(JSON.stringify(itakRegistrationPayload))
    ]);

    // Requirement 10.3: exactly 365 * 24 hours in milliseconds, never a
    // calendar-year Date manipulation.
    const reEnrollmentDate = new Date(Date.now() + CERTIFICATE_LIFETIME_DAYS * 86400000).toISOString();

    logger.info(
      { principalId: principal.id, principalKind, actingUserId, expiresAt: token.expires },
      'Enrollment generated'
    );

    // cert-expiry-notifications Requirement 8: the new certificate has
    // just been minted above -- enqueue a Superseding_Revoke for
    // whatever certificate it replaces, fire-and-forget so a failure
    // here can never fail this (already-successful) enrollment
    // response. Passed the PRINCIPAL's own users.id -- see
    // #enqueueSupersedingRevoke's own doc comment for why that id,
    // rather than any TAK-Server-assigned device identifier, is used.
    DeviceEnrollmentService.#enqueueSupersedingRevoke(principal.id, actingUserId).catch((err) =>
      logger.error({ err, principalId: principal.id }, 'Failed to enqueue Superseding_Revoke after enrollment')
    );

    return {
      ...preview,
      expiresAt: token.expires,
      reEnrollmentDate,
      atakEnrollmentUri,
      itakRegistrationPayload,
      atakQrDataUrl,
      itakQrDataUrl
    };
  }

  /**
   * cert-expiry-notifications Requirement 8: enqueues a Revoke_Operation
   * for the certificate a just-completed enrollment mint SUPERSEDES --
   * so a renewal actually retires the certificate it replaces instead of
   * silently leaving it live alongside the new one.
   *
   * Keyed on `userId` (the principal's own `users.id`), NOT on any
   * TAK-Server-assigned per-certificate device identifier: neither
   * `generateSelfEnrollment` nor `generateEnrollmentQrCode` has one in
   * hand at mint time -- TAK Server assigns it only once the physical
   * device actually uses the minted token. `tak_devices.user_id` is
   * read directly (the row `DeviceSync` already keeps current) rather
   * than issuing a fresh TAK Server API call (Requirement 8.6).
   *
   * Three outcomes:
   *   - Zero live rows: an ordinary first enrollment. No enqueue, no log
   *     beyond debug level -- not an error or anomaly (Requirement 8.5).
   *   - Exactly one live row: THAT certificate is unambiguously what
   *     this mint replaces. Enqueues `revoke_tak_certificates` with the
   *     `cert_ids` discriminator (Requirement 8.1, 8.3).
   *   - More than one live row: a Self-Owned_Device principal may
   *     legitimately hold several live devices at once (ATAK, iTAK,
   *     CloudTAK, a second personal device). Which one THIS mint is
   *     meant to replace is genuinely ambiguous, and guessing wrong
   *     would revoke a certificate still in active use -- so this is a
   *     deliberate no-op, logged informationally, never as an error
   *     (Requirement 8.2).
   *
   * The Revoke_Operation itself is subject to the EXISTING
   * `DEVICE_MGMT_REVOKE_ENABLED` arming flag and Revoke_Blast_Radius_Cap
   * exactly as every other caller of `revoke_tak_certificates` already
   * is (Requirement 8.4) -- no new gating logic here.
   *
   * @param {number|string} userId - the principal's own `users.id`.
   * @param {number|null} actingUserId
   * @returns {Promise<void>}
   */
  static async #enqueueSupersedingRevoke(userId, actingUserId) {
    const { rows } = await pool.query(
      'SELECT cert_id FROM tak_devices WHERE user_id = $1 AND revoked = false',
      [userId]
    );

    if (rows.length === 0) {
      logger.debug({ userId }, 'No prior live certificate to supersede; ordinary first enrollment');
      return;
    }

    if (rows.length > 1) {
      logger.info(
        { userId, liveCertificateCount: rows.length },
        'Skipping Superseding_Revoke: principal holds more than one live certificate, which one this mint replaces is ambiguous'
      );
      return;
    }

    const supersededCertId = rows[0].cert_id;
    await EventPublisher.publishOperation(
      'revoke_tak_certificates',
      { cert_ids: [supersededCertId] },
      actingUserId
    );
    logger.info({ userId, supersededCertId }, 'Enqueued Superseding_Revoke for renewed certificate');
  }

  /**
   * takserver-enrollment (client UX correction): resolves everything the
   * Enrollment_View's "Enrollment Data" section needs to render BEFORE a
   * human clicks "Generate Enrollment Data" -- host, username,
   * Callsign/Color/Role, and the live certificate count -- WITHOUT
   * minting an Enrollment_Token. Mints nothing and calls Authentik
   * nowhere: every value here is either the already-resolved local
   * `principal` row, or read from this application's own database
   * (`team_memberships`, `tak_devices`) and local services
   * (`UserAttributesService.generateCallsign`, itself Authentik-free).
   *
   * This split exists because the ORIGINAL, single-phase
   * `#buildEnrollment` used to mint a fresh 30-minute Authentik
   * `app_password` token on every page LOAD, not just on an explicit
   * user action -- so a user who merely browsed through Dashboard ->
   * Enrollment -> Teams -> back to Enrollment minted a new live
   * credential each time, for no reason. The Enrollment_View now calls
   * THIS method automatically on mount (cheap, local, side-effect-free)
   * and defers the actual `#buildEnrollment` token mint to an explicit
   * "Generate Enrollment Data" click.
   *
   * Still throws `TakServerNotConfiguredError` when
   * `TAK_SERVER_ENROLLMENT_URL` is unset/unparseable, exactly as
   * `#buildEnrollment` does -- a caller with a broken TAK Server
   * enrollment host configuration should learn that immediately, before
   * wasting a click on a button that would fail anyway.
   *
   * @param {object} principal - an already-resolved `users` row.
   * @param {{principalKind: 'human'|'device'}} options
   * @returns {Promise<{
   *   principalId: number|string,
   *   principalKind: 'human'|'device',
   *   username: string,
   *   host: string,
   *   takAttributes: {callsign: string, color: string, role: string},
   *   liveCertificateCount: number
   * }>}
   * @throws {TakServerNotConfiguredError}
   */
  static async #resolvePrincipalPreview(principal, { principalKind }) {
    // Deliberately TAK_SERVER_ENROLLMENT_URL, NOT TAK_SERVER_URL: the
    // latter is the Marti certadmin API's mutual-TLS endpoint
    // (TakServerService.js), which is not necessarily the hostname a
    // client device should dial for enrollment/streaming. See
    // TakServerNotConfiguredError's own doc comment for the full
    // reasoning.
    const takServerEnrollmentUrl = process.env.TAK_SERVER_ENROLLMENT_URL;
    if (!takServerEnrollmentUrl) {
      throw new TakServerNotConfiguredError();
    }
    let host;
    try {
      host = new URL(takServerEnrollmentUrl).hostname;
    } catch {
      throw new TakServerNotConfiguredError();
    }

    // Requirement 6.7: the principal's Direct_Membership team.
    const membershipResult = await pool.query(
      'SELECT team_id FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL',
      [principal.id]
    );
    const teamId = membershipResult.rows[0]?.team_id;

    // Criterion 10.5, 15.3: local values only, never read back from
    // Authentik. `role` comes directly off the already-resolved row.
    // `callsign`/`color` need a team to resolve against; with none, the
    // explicit string 'None' is used for both, following the
    // Enrollment_Lambda's own `extractAttribute` default -- there is no
    // Organisation to read a colour from either.
    let callsign = 'None';
    let color = 'None';
    if (teamId !== undefined) {
      const attributes = await UserAttributesService.generateCallsign(principal.id, teamId);
      if (attributes) {
        callsign = attributes.callsign || 'None';
        color = attributes.color || 'None';
      }
    }

    const takAttributes = {
      callsign,
      color,
      role: principal.tak_role || 'None'
    };

    // Requirement 13.2: the ONLY `tak_devices` access in this method --
    // a scalar count projecting no timestamp, so `expires_at`/
    // `issued_at` are structurally unreachable from here.
    const certResult = await pool.query(
      'SELECT count(*) FROM tak_devices WHERE user_id = $1 AND revoked = false',
      [principal.id]
    );
    const liveCertificateCount = parseInt(certResult.rows[0].count, 10);

    return {
      principalId: principal.id,
      principalKind,
      // Client display note: the Enrollment_View's "User"/"Device" row
      // shows THIS field, never an email -- Authentik's email is not the
      // identifier the enrollment token/manual-entry credentials are
      // keyed on, and a Team_Owned_Device has no email at all
      // (Requirement 5) so an email-based row would have nothing to show
      // for one of the two Enrollment_Principal kinds anyway.
      username: principal.username,
      host,
      takAttributes,
      liveCertificateCount
    };
  }
}

module.exports = DeviceEnrollmentService;

module.exports.DeviceEnrollmentAuthorizationError = DeviceEnrollmentAuthorizationError;
module.exports.NotATeamOwnedDeviceError = NotATeamOwnedDeviceError;
module.exports.DeviceSessionCannotSelfEnrollError = DeviceSessionCannotSelfEnrollError;
module.exports.TakServerNotConfiguredError = TakServerNotConfiguredError;
module.exports.ENROLLMENT_TOKEN_EXPIRATION_MINUTES = ENROLLMENT_TOKEN_EXPIRATION_MINUTES;
module.exports.CERTIFICATE_LIFETIME_DAYS = CERTIFICATE_LIFETIME_DAYS;
module.exports.ENROLLMENT_PORT = ENROLLMENT_PORT;
