const pool = require('../config/database');
const Team = require('../models/Team');
const logger = require('../config/logger').createLogger('MouService');

/**
 * Thrown by `updateDocument`/`setAsCurrentAgreement` when the given
 * `documentId` does not correspond to any `mou_documents` row. Mirrors
 * the shape of other small, named error classes used elsewhere in this
 * codebase (e.g. `DeploymentChannelService.DeploymentChannelNotFoundError`)
 * so callers (route handlers, task 50.5) can respond with a specific
 * 400/404-equivalent error rather than a generic 500.
 */
class MouDocumentNotFoundError extends Error {
  constructor(documentId) {
    super(`MOU document ${documentId} was not found`);
    this.name = 'MouDocumentNotFoundError';
  }
}

/**
 * The only two `mou_signatures.signature_method` values, per the
 * `1786770000000_create-mou-documents-and-signatures.cjs` migration's
 * own comment ("'e_signature' | 'uploaded_scan' -- enforced at the
 * application layer"). `recordSignature` (below) is that enforcement
 * point.
 */
const VALID_SIGNATURE_METHODS = ['e_signature', 'uploaded_scan'];

/**
 * Thrown by `recordSignature` when the caller supplies both
 * `signerUserId` and `signerTeamId`, or neither -- the migration's
 * "exactly one of signer_user_id/signer_team_id is set per row" comment
 * (Requirement 28 Criterion 4) is enforced here, at the application
 * layer, before any row is inserted. A 400-equivalent client error, not
 * a 500.
 */
class MouSignatureValidationError extends Error {
  constructor(message = 'Exactly one of signerUserId or signerTeamId must be provided') {
    super(message);
    this.name = 'MouSignatureValidationError';
  }
}

/**
 * Thrown by `recordSignature` when `method` is not one of
 * `VALID_SIGNATURE_METHODS`. A 400-equivalent client error, not a 500.
 */
class MouInvalidSignatureMethodError extends Error {
  constructor(method) {
    super(`Invalid signature method '${method}'; expected one of: ${VALID_SIGNATURE_METHODS.join(', ')}`);
    this.name = 'MouInvalidSignatureMethodError';
  }
}

/**
 * Thrown by `recordSignature` when the acting user is neither a
 * Global_Manager, an admin (per `Team.isAdmin`) of a team-scoped
 * document's `team_id`, nor self-signing a serverwide document as
 * themselves (Requirement 28 Criterion 4; see `assertSignatureAuthorized`'s
 * doc comment for the full rule). A 400/403-equivalent client error, not
 * a 500.
 */
class MouSignatureAuthorizationError extends Error {
  constructor(message = 'Insufficient authorization to record this MOU signature') {
    super(message);
    this.name = 'MouSignatureAuthorizationError';
  }
}

/**
 * Thrown by `recordSignature` when a signature for the same
 * `(mou_document_id, signer_user_id)` or `(mou_document_id,
 * signer_team_id)` pair already exists -- translating the migration's
 * partial unique index violation (Postgres error code `23505`) into a
 * clear, specific error rather than letting the raw Postgres error
 * bubble up. A 400-equivalent client error, not a 500.
 */
class MouSignatureAlreadyExistsError extends Error {
  constructor(message = 'A signature already exists for this document and signer') {
    super(message);
    this.name = 'MouSignatureAlreadyExistsError';
  }
}

/**
 * Thrown by `recordCountersignature` when the given `signatureId` does
 * not correspond to any `mou_signatures` row. A 400/404-equivalent
 * client error, not a 500.
 */
class MouSignatureNotFoundError extends Error {
  constructor(signatureId) {
    super(`MOU signature ${signatureId} was not found`);
    this.name = 'MouSignatureNotFoundError';
  }
}

/**
 * Thrown by `recordCountersignature` when the acting user is not a
 * Global_Manager (Requirement 28 Criterion 5: countersigning is
 * Global_Manager-only). A 400/403-equivalent client error, not a 500.
 */
class MouCountersignatureAuthorizationError extends Error {
  constructor(message = 'Only a Global_Manager may record an MOU countersignature') {
    super(message);
    this.name = 'MouCountersignatureAuthorizationError';
  }
}

/**
 * Thrown by `recordCountersignature` when the signature's document has
 * `requires_countersignature = false` -- per this task's own
 * description, a countersignature is "meaningful only when
 * `requires_countersignature=true`" (Requirement 28 Criterion 5). A
 * 400-equivalent client error, not a 500.
 */
class MouCountersignatureNotRequiredError extends Error {
  constructor(message = 'This MOU document does not require a countersignature') {
    super(message);
    this.name = 'MouCountersignatureNotRequiredError';
  }
}

/**
 * Thrown by `recordCountersignature` when the target `mou_signatures`
 * row already has a non-null `countersigned_at`. A 400-equivalent
 * client error, not a 500.
 */
class MouSignatureAlreadyCountersignedError extends Error {
  constructor(message = 'This MOU signature has already been countersigned') {
    super(message);
    this.name = 'MouSignatureAlreadyCountersignedError';
  }
}

/**
 * `MouService` backs the MOU/Document Management feature (Requirement
 * 28). This task (50.2) implements only `createDocument`/
 * `updateDocument`/`setAsCurrentAgreement` -- per `design.md`'s Section
 * 23, all three are Global_Manager-only. As with every sibling service
 * in this codebase (`VendorChannelService`, `DeploymentChannelService`,
 * `ChannelRequestService`, etc.), authorization itself is enforced at
 * the route/Permission_Registry layer (task 50.5, out of scope here) --
 * these methods assume the caller has already been authorized.
 *
 * This task (50.3) adds `recordSignature`/`recordCountersignature`.
 * Unlike `createDocument`/`updateDocument`/`setAsCurrentAgreement`
 * above, these two methods DO check authorization themselves (per this
 * task's own description, mirroring `DeviceEnrollmentService
 * .assertAuthorized`'s established pattern of a service performing its
 * own authorization check) rather than deferring entirely to the
 * route/Permission_Registry layer -- see `assertSignatureAuthorized`'s
 * doc comment below for why `recordSignature`'s rule ("team admin for
 * team-scoped documents, Global_Manager for any") needs to inspect the
 * TARGET document's `team_id` and the requested signer identity, which
 * a route-level static Permission_Registry entry cannot express on its
 * own.
 *
 * The `requireCurrentAgreement` login-time-gate middleware (task 50.4)
 * is deliberately NOT implemented here.
 */
class MouService {
  /**
   * Requirement 28 Criterion 1/3 (task 50.2): creates a new
   * `mou_documents` row.
   *
   * Per `design.md`'s Section 23, `MouService` exposes `createDocument`,
   * `updateDocument`, and `setAsCurrentAgreement` as three DISTINCT
   * operations -- mirroring Requirement 28.3's own wording, which lists
   * "creation, editing, and designation ... as the current mandatory
   * user agreement" as three separate Global_Manager-restricted actions.
   * Nothing in `design.md` or the Requirement 28.3 text suggests
   * `createDocument` can also directly designate its new row as the
   * current agreement -- that is exclusively `setAsCurrentAgreement`'s
   * job. So a newly created document always starts with
   * `is_current_agreement = false`, matching the column's own schema
   * default (see the `1786770000000_create-mou-documents-and-signatures.cjs`
   * migration), and there is no parameter to override that here.
   *
   * `version` likewise always starts at `1` (the column's schema
   * default, and this task's own description) -- see
   * `setAsCurrentAgreement`'s doc comment below for how a document's
   * version advances later when it supersedes a prior current agreement.
   *
   * `is_active` defaults to `true`: a newly created document is usable
   * immediately (e.g. for `recordSignature`, task 50.3) even before it
   * is ever designated the current mandatory agreement.
   *
   * @param {{title: string, body: string, teamId?: number|null, requiresCountersignature?: boolean}} documentData
   * @param {number} createdBy - local `users.id` of the creating
   *   Global_Manager (Requirement 28 Criterion 1).
   * @returns {Promise<object>} the created `mou_documents` row.
   */
  async createDocument(documentData, createdBy) {
    const { title, body, teamId, requiresCountersignature } = documentData || {};

    const result = await pool.query(
      `INSERT INTO mou_documents (
         title, body, team_id, requires_countersignature,
         version, is_current_agreement, is_active,
         created_by, updated_by
       ) VALUES ($1, $2, $3, $4, 1, false, true, $5, $5)
       RETURNING *`,
      [title, body, teamId ?? null, Boolean(requiresCountersignature), createdBy]
    );

    return result.rows[0];
  }

  /**
   * Requirement 28 Criterion 1/3 (task 50.2): updates an existing
   * `mou_documents` row's editable content fields.
   *
   * Only `title`/`body`/`requires_countersignature` are editable here --
   * matching this task's own scope description exactly. `team_id`,
   * `version`, `is_current_agreement`, and `is_active` are all
   * deliberately left untouched by this method: `team_id` is set once
   * at creation (an MOU_Document doesn't change from serverwide to
   * team-scoped or vice versa); `version`/`is_current_agreement` are
   * exclusively managed by `setAsCurrentAgreement` (see that method's
   * doc comment for why mutating a version's content in place, via this
   * method, is intentionally independent of the versioning/supersession
   * mechanism); and `is_active` has no setter in this task's scope
   * either.
   *
   * Each field uses `COALESCE($n, column)` so a caller may supply only
   * the fields it wants changed (e.g. just `{ title }`) without needing
   * to first fetch and re-send the row's other current values --
   * `requiresCountersignature` is normalized to `null` (rather than
   * `false`) when omitted so `COALESCE` preserves the existing value
   * instead of incorrectly clearing the flag to `false`.
   *
   * @param {number} documentId - `mou_documents.id`.
   * @param {{title?: string, body?: string, requiresCountersignature?: boolean}} documentData
   * @param {number} updatedBy - local `users.id` of the updating
   *   Global_Manager (Requirement 28 Criterion 1).
   * @returns {Promise<object>} the updated `mou_documents` row.
   * @throws {MouDocumentNotFoundError} if `documentId` does not exist.
   */
  async updateDocument(documentId, documentData, updatedBy) {
    const { title, body, requiresCountersignature } = documentData || {};

    const result = await pool.query(
      `UPDATE mou_documents
       SET title = COALESCE($1, title),
           body = COALESCE($2, body),
           requires_countersignature = COALESCE($3, requires_countersignature),
           updated_by = $4
       WHERE id = $5
       RETURNING *`,
      [
        title ?? null,
        body ?? null,
        requiresCountersignature === undefined ? null : Boolean(requiresCountersignature),
        updatedBy,
        documentId
      ]
    );

    if (result.rows.length === 0) {
      throw new MouDocumentNotFoundError(documentId);
    }

    return result.rows[0];
  }

  /**
   * Requirement 28 Criterion 1/3, 6-7 (task 50.2): designates an
   * `mou_documents` row as the current mandatory serverwide user
   * agreement.
   *
   * ## Versioning/supersession semantics -- design decision
   *
   * `design.md`'s Section 23 states plainly that "`setAsCurrentAgreement`
   * bumps `version` on a fresh row and flips the previous current row's
   * `is_current_agreement` to false", and goes on to say the resulting
   * new-current row is "a new `mou_documents` row with a new id" --
   * language repeated near-verbatim in the
   * `1786770000000_create-mou-documents-and-signatures.cjs` migration's
   * own extensive comments. That rules out the simpler alternative of
   * merely flipping the boolean flag in place on the row identified by
   * `documentId` whenever an existing current agreement is being
   * superseded: doing so would keep the SAME id and the SAME version
   * number, contradicting both descriptions' explicit "fresh row"/"new
   * id" wording.
   *
   * What `design.md` does NOT spell out precisely is what should happen
   * the FIRST time a current agreement is ever designated (no existing
   * `is_current_agreement = true` row to supersede) -- there is nothing
   * to "supersede" in that case, so this implementation makes the
   * judgment call of NOT fabricating a redundant extra row: it simply
   * flips `is_current_agreement = true` directly on the target row.
   * "Bumping a fresh row" only happens for a genuine supersession (an
   * existing different current row is being replaced), consistent with
   * `design.md`'s own framing of that behavior as "[w]hen a new version
   * supersedes the current agreement".
   *
   * Behavior, all inside one transaction (leaning on the
   * `idx_mou_documents_one_current_agreement` partial unique index for
   * safety against a concurrent activation, via `SELECT ... FOR UPDATE`
   * locks, mirroring `VendorChannelService.createVendorChannel`'s
   * established pattern for the same kind of "at most one active row"
   * singleton invariant):
   *
   *   1. Lock and fetch the target row (`documentId`). Throws
   *      `MouDocumentNotFoundError` if it does not exist.
   *   2. Lock and fetch whatever row (if any) currently has
   *      `is_current_agreement = true`.
   *   3. No current row exists yet: flip `is_current_agreement = true`
   *      directly on the target row. Nothing is superseded, so no
   *      version bump.
   *   4. The current row IS the target row (already current): a no-op
   *      -- returns the row unchanged.
   *   5. The current row is a DIFFERENT row (genuine supersession, Req
   *      28.7): inserts a brand-new row copying the target row's
   *      `title`/`body`/`team_id`/`requires_countersignature`, with
   *      `version` set to the TARGET row's `version + 1` and
   *      `is_current_agreement = true`; then flips the previous current
   *      row's `is_current_agreement` to `false`. The originally
   *      targeted row itself is left unchanged (it was never the row
   *      that becomes current in this branch -- the fresh copy is).
   *
   * Requirement 28.7's re-acceptance requirement falls out of this for
   * free at query time (task 50.4's `requireCurrentAgreement`
   * middleware, out of scope here): a user's `mou_signatures` row
   * referencing the OLD current document's id no longer matches the
   * NEW current document's (different) id, so they are transparently
   * required to re-sign -- no separate "supersession" bookkeeping is
   * needed, exactly as `design.md` describes.
   *
   * @param {number} documentId - `mou_documents.id` to designate (or, in
   *   the supersession case, whose content becomes the new current
   *   version).
   * @param {number} actingUserId - local `users.id` of the acting
   *   Global_Manager (Requirement 28 Criterion 1).
   * @returns {Promise<object>} the `mou_documents` row that now has
   *   `is_current_agreement = true` -- which may be a newly created row
   *   distinct from `documentId` when a supersession occurred.
   * @throws {MouDocumentNotFoundError} if `documentId` does not exist.
   */
  async setAsCurrentAgreement(documentId, actingUserId) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const targetResult = await client.query(
        'SELECT * FROM mou_documents WHERE id = $1 FOR UPDATE',
        [documentId]
      );

      const target = targetResult.rows[0];

      if (!target) {
        throw new MouDocumentNotFoundError(documentId);
      }

      const currentResult = await client.query(
        'SELECT * FROM mou_documents WHERE is_current_agreement = true FOR UPDATE'
      );

      const currentAgreement = currentResult.rows[0];

      let resultRow;

      if (!currentAgreement) {
        // Case 1: no current agreement exists yet -- nothing to
        // supersede, so simply flip the flag on the target row itself.
        const updateResult = await client.query(
          `UPDATE mou_documents
           SET is_current_agreement = true, updated_by = $2
           WHERE id = $1
           RETURNING *`,
          [documentId, actingUserId]
        );
        resultRow = updateResult.rows[0];
      } else if (currentAgreement.id === target.id) {
        // Case 2: the target row is already the current agreement --
        // idempotent no-op.
        resultRow = currentAgreement;
      } else {
        // Case 3: genuine supersession (Req 28.7) -- create a fresh row
        // with a bumped version carrying the target row's content, mark
        // it current, and flip off the previous current row.
        const insertResult = await client.query(
          `INSERT INTO mou_documents (
             title, body, team_id, requires_countersignature, version,
             is_current_agreement, is_active, created_by, updated_by
           ) VALUES ($1, $2, $3, $4, $5, true, true, $6, $6)
           RETURNING *`,
          [
            target.title,
            target.body,
            target.team_id,
            target.requires_countersignature,
            target.version + 1,
            actingUserId
          ]
        );

        await client.query(
          `UPDATE mou_documents
           SET is_current_agreement = false, updated_by = $2
           WHERE id = $1`,
          [currentAgreement.id, actingUserId]
        );

        resultRow = insertResult.rows[0];
      }

      await client.query('COMMIT');
      return resultRow;
    } catch (error) {
      await client.query('ROLLBACK');

      if (!(error instanceof MouDocumentNotFoundError)) {
        logger.error({ err: error, documentId }, 'Error setting current MOU agreement; rolled back');
      }

      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Requirement 28 Criterion 4 (task 50.3): authorizes `recordSignature`.
   *
   * The rule, per `design.md`'s Section 23 ("team admin for team-scoped
   * documents, Global_Manager for any") plus this task's own
   * elaboration for the login-time-gate case (task 50.4 needs every
   * ordinary authenticated user to be able to self-sign the mandatory
   * SERVERWIDE agreement for themselves -- otherwise no non-admin,
   * non-Global_Manager user could ever satisfy that gate):
   *
   *   1. A Global_Manager may sign ANY document, on behalf of a user or
   *      a team.
   *   2. For a TEAM-SCOPED document (`document.team_id IS NOT NULL`):
   *      an admin (per `Team.isAdmin`) of that document's `team_id` may
   *      sign on behalf of their team (`signerTeamId`) or an individual
   *      user (`signerUserId`) -- Requirement 28 Criterion 4's "record
   *      an MOU_Signature on behalf of their team" wording does not
   *      restrict WHICH signer identity a team admin records, only that
   *      they must be an admin of the document's team to record any
   *      signature for it.
   *   3. For a SERVERWIDE document (`document.team_id IS NULL`): only a
   *      Global_Manager may record a `signerTeamId` signature (there is
   *      no "team admin of a null team" to authorize), but ANY
   *      authenticated user may self-sign as themselves
   *      (`signerUserId === actingUser.userId`) -- this is the case the
   *      login-time gate (task 50.4) depends on, since every ordinary
   *      user must be able to accept the mandatory serverwide agreement
   *      for themselves without needing Global_Manager or team-admin
   *      status.
   *
   * A user attempting to sign as a DIFFERENT user
   * (`signerUserId !== actingUser.userId`) on a serverwide document, or
   * any non-Global_Manager attempting a `signerTeamId` signature on a
   * serverwide document, falls through to the final `throw` below.
   *
   * @param {{team_id: number|null}} document - the target `mou_documents` row.
   * @param {{signerUserId?: number, signerTeamId?: number}} signerIds
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser
   * @throws {MouSignatureAuthorizationError}
   */
  static async assertSignatureAuthorized(document, { signerUserId, signerTeamId }, actingUser) {
    if (actingUser && actingUser.is_global_manager) {
      return;
    }

    if (document.team_id != null) {
      const isTeamAdmin = await Team.isAdmin(document.team_id, actingUser?.userId);
      if (isTeamAdmin) {
        return;
      }
    } else if (signerUserId != null && actingUser?.userId === signerUserId) {
      // Serverwide document, self-signing case (task 50.4's login-time
      // gate depends on this: any authenticated user may sign the
      // mandatory serverwide agreement for themselves).
      return;
    }

    throw new MouSignatureAuthorizationError();
  }

  /**
   * Requirement 28 Criteria 2, 4 (task 50.3): records an MOU_Signature.
   *
   * Order of operations:
   *   1. Validate exactly one of `signerUserId`/`signerTeamId` is
   *      provided (the migration's "exactly one ... is set per row"
   *      invariant) -- rejects with `MouSignatureValidationError`
   *      otherwise, before any query runs.
   *   2. Validate `method` is one of `VALID_SIGNATURE_METHODS` --
   *      rejects with `MouInvalidSignatureMethodError` otherwise.
   *   3. Fetch the target document (for its `team_id`, needed for
   *      authorization and not otherwise supplied by the caller) --
   *      rejects with `MouDocumentNotFoundError` if it doesn't exist.
   *   4. Authorize via `assertSignatureAuthorized` (see its doc comment
   *      for the full rule).
   *   5. Insert the `mou_signatures` row. A unique-violation (Postgres
   *      `23505`, from the migration's partial unique indexes on
   *      `(mou_document_id, signer_user_id)`/`(mou_document_id,
   *      signer_team_id)`) is caught and translated into a clear
   *      `MouSignatureAlreadyExistsError` rather than letting the raw
   *      Postgres error bubble up to the caller.
   *
   * No transaction is used here: a single INSERT is already atomic, and
   * there is no second write (enqueue, audit log, etc.) that needs to
   * commit or roll back alongside it -- matching `denyChannelRequest`'s
   * established "no transaction needed since nothing else is written"
   * reasoning for an equivalently single-statement write elsewhere in
   * this codebase. The document fetch in step 3 runs as a separate,
   * unguarded read (not `SELECT ... FOR UPDATE`): the document's
   * `team_id` never changes after creation (per `updateDocument`'s own
   * doc comment above), so there is no race to guard against here, and
   * the unique index remains the authoritative defense against a
   * concurrent duplicate-signature race regardless.
   *
   * @param {number} documentId - `mou_documents.id`.
   * @param {{signerUserId?: number|null, signerTeamId?: number|null}} signerIds -
   *   exactly one of these two must be non-null.
   * @param {string} method - one of `VALID_SIGNATURE_METHODS`
   *   (`'e_signature'`/`'uploaded_scan'`).
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser
   * @param {string|null} [signatureData] - the e-signature payload or a
   *   reference to the uploaded scanned copy, per `method`.
   * @returns {Promise<object>} the created `mou_signatures` row.
   * @throws {MouSignatureValidationError} if neither or both of
   *   `signerUserId`/`signerTeamId` are provided.
   * @throws {MouInvalidSignatureMethodError} if `method` is not valid.
   * @throws {MouDocumentNotFoundError} if `documentId` does not exist.
   * @throws {MouSignatureAuthorizationError} if the acting user is not
   *   authorized to record this signature.
   * @throws {MouSignatureAlreadyExistsError} if a signature for this
   *   document/signer pair already exists.
   */
  async recordSignature(documentId, { signerUserId, signerTeamId } = {}, method, actingUser, signatureData = null) {
    const normalizedSignerUserId = signerUserId ?? null;
    const normalizedSignerTeamId = signerTeamId ?? null;

    const providedCount = [normalizedSignerUserId, normalizedSignerTeamId].filter(
      (value) => value != null
    ).length;

    if (providedCount !== 1) {
      throw new MouSignatureValidationError();
    }

    if (!VALID_SIGNATURE_METHODS.includes(method)) {
      throw new MouInvalidSignatureMethodError(method);
    }

    const documentResult = await pool.query('SELECT * FROM mou_documents WHERE id = $1', [
      documentId
    ]);

    const document = documentResult.rows[0];

    if (!document) {
      throw new MouDocumentNotFoundError(documentId);
    }

    await MouService.assertSignatureAuthorized(
      document,
      { signerUserId: normalizedSignerUserId, signerTeamId: normalizedSignerTeamId },
      actingUser
    );

    try {
      const result = await pool.query(
        `INSERT INTO mou_signatures (
           mou_document_id, signer_user_id, signer_team_id,
           signature_method, signature_data
         ) VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [documentId, normalizedSignerUserId, normalizedSignerTeamId, method, signatureData]
      );

      return result.rows[0];
    } catch (error) {
      if (error.code === '23505') {
        throw new MouSignatureAlreadyExistsError();
      }

      logger.error(
        { err: error, documentId, signerUserId: normalizedSignerUserId, signerTeamId: normalizedSignerTeamId },
        'Error recording MOU signature'
      );
      throw error;
    }
  }

  /**
   * Requirement 28 Criterion 5 (task 50.3): records a Global_Manager
   * countersignature on an existing `mou_signatures` row.
   *
   * Global_Manager-only (Requirement 28 Criterion 5's own wording
   * pairs the countersignature action with "a Global_Manager records a
   * countersignature"); meaningful only when the referenced document's
   * `requires_countersignature = true` -- rejects with
   * `MouCountersignatureNotRequiredError` otherwise, per this task's own
   * description.
   *
   * Order of operations, all inside one transaction (the signature row
   * is locked via `SELECT ... FOR UPDATE` so a concurrent
   * `recordCountersignature` call targeting the same row blocks until
   * this transaction commits or rolls back, rather than both callers
   * reading `countersigned_at IS NULL` as true and racing to both
   * "successfully" countersign -- mirroring `VendorChannelService
   * .revokeGrant`'s established locking pattern for an equivalent
   * "not-yet-finalized row" race):
   *   1. Requirement 28 Criterion 5: reject with
   *      `MouCountersignatureAuthorizationError` if the acting user is
   *      not a Global_Manager -- checked FIRST, before any row lookup.
   *   2. Lock and fetch the target `mou_signatures` row, joined to its
   *      document's `requires_countersignature` flag. Rejects with
   *      `MouSignatureNotFoundError` if it doesn't exist.
   *   3. Reject with `MouCountersignatureNotRequiredError` if the
   *      document's `requires_countersignature` is `false`.
   *   4. Reject with `MouSignatureAlreadyCountersignedError` if
   *      `countersigned_at` is already non-null.
   *   5. Set `countersigned_by`/`countersigned_at` on the row.
   *
   * @param {number} signatureId - `mou_signatures.id`.
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser
   * @returns {Promise<object>} the updated `mou_signatures` row.
   * @throws {MouCountersignatureAuthorizationError} if the acting user
   *   is not a Global_Manager.
   * @throws {MouSignatureNotFoundError} if `signatureId` does not exist.
   * @throws {MouCountersignatureNotRequiredError} if the referenced
   *   document does not require a countersignature.
   * @throws {MouSignatureAlreadyCountersignedError} if the signature is
   *   already countersigned.
   */
  async recordCountersignature(signatureId, actingUser) {
    if (!actingUser || !actingUser.is_global_manager) {
      throw new MouCountersignatureAuthorizationError();
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const signatureResult = await client.query(
        `SELECT s.*, d.requires_countersignature
         FROM mou_signatures s
         JOIN mou_documents d ON d.id = s.mou_document_id
         WHERE s.id = $1
         FOR UPDATE OF s`,
        [signatureId]
      );

      const signature = signatureResult.rows[0];

      if (!signature) {
        throw new MouSignatureNotFoundError(signatureId);
      }

      if (!signature.requires_countersignature) {
        throw new MouCountersignatureNotRequiredError();
      }

      if (signature.countersigned_at) {
        throw new MouSignatureAlreadyCountersignedError();
      }

      const updateResult = await client.query(
        `UPDATE mou_signatures
         SET countersigned_by = $2, countersigned_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [signatureId, actingUser.userId]
      );

      await client.query('COMMIT');

      logger.info(
        { signatureId, actingUserId: actingUser.userId },
        'MOU countersignature recorded'
      );

      return updateResult.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');

      if (
        !(error instanceof MouSignatureNotFoundError) &&
        !(error instanceof MouCountersignatureNotRequiredError) &&
        !(error instanceof MouSignatureAlreadyCountersignedError)
      ) {
        logger.error({ err: error, signatureId }, 'Error recording MOU countersignature; rolled back');
      }

      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = MouService;
module.exports.MouDocumentNotFoundError = MouDocumentNotFoundError;
module.exports.MouSignatureValidationError = MouSignatureValidationError;
module.exports.MouInvalidSignatureMethodError = MouInvalidSignatureMethodError;
module.exports.MouSignatureAuthorizationError = MouSignatureAuthorizationError;
module.exports.MouSignatureAlreadyExistsError = MouSignatureAlreadyExistsError;
module.exports.MouSignatureNotFoundError = MouSignatureNotFoundError;
module.exports.MouCountersignatureAuthorizationError = MouCountersignatureAuthorizationError;
module.exports.MouCountersignatureNotRequiredError = MouCountersignatureNotRequiredError;
module.exports.MouSignatureAlreadyCountersignedError = MouSignatureAlreadyCountersignedError;
module.exports.VALID_SIGNATURE_METHODS = VALID_SIGNATURE_METHODS;
