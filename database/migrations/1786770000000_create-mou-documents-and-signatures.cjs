/**
 * Creates the `mou_documents` and `mou_signatures` tables for the
 * MOU/Document Management with E-Signature and Login-Time User
 * Agreement Gate feature (Requirement 28).
 *
 * ## `mou_documents`
 *
 * An `mou_documents` row represents either a serverwide document
 * (`team_id IS NULL`) or a team-specific document (`team_id` set) that a
 * team or a Global_Manager may be required to sign or countersign --
 * see the MOU_Document glossary entry in `requirements.md`. Per
 * Requirement 28 Criterion 1 and `design.md`'s Data Models table entry
 * for `mou_documents`, the column shape is:
 *   - `title`                       document title
 *   - `body`                        document body content
 *   - `team_id`                     nullable; NULL = serverwide document
 *   - `requires_countersignature`   whether a Global_Manager
 *                                   countersignature is also required
 *   - `version`                     version identifier
 *   - `is_current_agreement`        whether this row is the current
 *                                   mandatory user agreement gating login
 *                                   (Requirement 28 Criteria 6-7)
 *   - `is_active`                   general active flag
 *   - `created_by` / `updated_by`   the creating/last-updating
 *                                   Global_Manager's user id
 *
 * `version` is `INTEGER`, not free text: per `design.md`'s Section 23,
 * `setAsCurrentAgreement` "bumps `version` on a fresh row" when a new
 * agreement supersedes the current one -- i.e. superseding a document
 * creates a brand-new `mou_documents` row with an incremented `version`
 * value, rather than mutating the prior row in place. An incrementing
 * integer models that lineage more directly than an arbitrary string
 * and is defaulted to `1` for the first version of any document.
 *
 * `team_id` uses `ON DELETE CASCADE`, matching the same-shaped
 * `channel_requests.team_id` column added by
 * `1786740000000_create-channel-requests.cjs`: a team-specific document
 * has no continued meaning once its parent team no longer exists.
 * Serverwide documents (`team_id IS NULL`) are entirely unaffected by
 * this constraint.
 *
 * `created_by`/`updated_by` use `ON DELETE SET NULL`, matching the
 * `created_by`/`requested_by` convention already established by
 * `vendor_channels`/`deployment_channels` -- the document record should
 * survive the authoring Global_Manager's account being removed later.
 *
 * `mou_documents` gets the same `updated_at` + `update_updated_at_column()`
 * trigger already used for other admin-managed, update-in-place tables
 * in the baseline schema (`site_config`, `system_config`,
 * `email_templates`), since `updateDocument` (task 50.2) updates a row
 * after creation.
 *
 * ## Singleton "current agreement" index
 *
 * `design.md`'s login-time gate description checks "whether *a*
 * `mou_documents` row has `is_current_agreement = true`" (singular),
 * consistent with Requirement 28 Criteria 6-7 describing one mandatory
 * serverwide user agreement in force at a time. This mirrors the
 * existing "at most one row satisfying a condition" idiom used for
 * `vendor_channels.is_active` in
 * `1786710000000_create-vendor-channels.cjs`: a partial unique index on
 * `is_current_agreement` `WHERE is_current_agreement = true` ensures at
 * most one `mou_documents` row can carry that flag at any time, so
 * `setAsCurrentAgreement` flipping the previous current row's flag to
 * `false` before/while setting the new row's flag to `true` is
 * enforced, not just conventionally followed.
 *
 * ## `mou_signatures`
 *
 * An `mou_signatures` row records that a specific `mou_documents` row
 * has been signed by a signing user or team, optionally countersigned
 * by a Global_Manager -- see the MOU_Signature glossary entry. Per
 * Requirement 28 Criterion 2 and `design.md`'s Data Models table entry
 * for `mou_signatures`, the column shape is:
 *   - `mou_document_id`                the referenced MOU_Document
 *   - `signer_user_id` / `signer_team_id`  the signing user or team
 *                                          (Requirement 28 Criterion 4:
 *                                          a team admin signs on behalf
 *                                          of their team; an individual
 *                                          user signs the login-time
 *                                          serverwide agreement)
 *   - `signed_at`                      when the signature was recorded
 *   - `signature_method`               distinguishes an in-app
 *                                       e-signature from an uploaded
 *                                       scanned copy
 *   - `countersigned_by` / `countersigned_at`  nullable; set only when
 *                                              `requires_countersignature
 *                                              = true` (Requirement 28
 *                                              Criterion 5)
 *
 * `signer_user_id`/`signer_team_id` are both nullable FKs rather than a
 * single polymorphic column: unlike the `channel_id`-style polymorphic
 * references elsewhere in this schema (which point into several
 * *structurally different* channel-like tables with no shared id
 * space), a signature here targets exactly one of two well-known,
 * already-FK-able tables (`users`, `teams`), so a plain hard FK to each
 * -- left NULL when not applicable -- is both simpler and safer than a
 * type-tagged polymorphic id. Application logic (`MouService
 * .recordSignature`, task 50.3) is responsible for setting exactly one
 * of the two per Requirement 28 Criterion 4.
 *
 * `signature_data` is an additional column beyond the Criterion 2
 * minimum, holding either the in-app e-signature payload or a reference
 * to the uploaded scanned copy depending on `signature_method` -- the
 * schema needs *somewhere* to persist "what was actually signed",
 * consistent with Criterion 1/2's "at minimum" phrasing (documents ONLY
 * a required floor, not an exhaustive column list) and Requirement 28's
 * User Story of signature capture, not just signature bookkeeping.
 *
 * `mou_document_id` uses `ON DELETE CASCADE` (a signature has no
 * meaning once its document is gone); `signer_user_id`/`signer_team_id`/
 * `countersigned_by` use `ON DELETE SET NULL`, consistent with this
 * schema's general "preserve the audit row, drop the dangling actor
 * reference" convention already used for `created_by`/`requested_by`
 * elsewhere.
 *
 * ## Supporting indexes
 *
 * The login-time gate (Requirement 28 Criteria 6-7) and the
 * team/Global_Manager signing paths (Criterion 4) both need an
 * efficient "does a signature already exist for this document + this
 * signer" lookup. Two partial unique indexes support that directly and
 * also prevent duplicate signature rows for the same document/signer
 * pair:
 *   - `(mou_document_id, signer_user_id)` WHERE `signer_user_id IS NOT
 *     NULL`
 *   - `(mou_document_id, signer_team_id)` WHERE `signer_team_id IS NOT
 *     NULL`
 *
 * This task is scoped to ONLY the migration adding these tables; the
 * `MouService` methods and `requireCurrentAgreement` middleware that
 * read/write them (tasks 50.2-50.5) are deliberately out of scope here,
 * per `tasks.md`'s dependency-ordering note ("Every new table or column
 * lands as its own migration task ahead of the service/route tasks that
 * depend on it").
 *
 * Uses node-pg-migrate's schema-builder API (`pgm.createTable`,
 * `pgm.createIndex` with a `where` clause, `pgm.sql` for the trigger),
 * matching the convention established by every migration after the
 * baseline (e.g. `1786710000000_create-vendor-channels.cjs`).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

const CURRENT_AGREEMENT_INDEX = 'idx_mou_documents_one_current_agreement';
const SIGNATURE_DOCUMENT_USER_INDEX = 'idx_mou_signatures_document_signer_user';
const SIGNATURE_DOCUMENT_TEAM_INDEX = 'idx_mou_signatures_document_signer_team';
const UPDATED_AT_TRIGGER = 'update_mou_documents_updated_at';

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.createTable('mou_documents', {
    id: 'id',
    title: {
      type: 'varchar(255)',
      notNull: true,
    },
    body: {
      type: 'text',
      notNull: true,
    },
    // Nullable: NULL means "serverwide document" (Requirement 28
    // Criterion 1 / MOU_Document glossary entry).
    team_id: {
      type: 'integer',
      references: 'teams',
      onDelete: 'CASCADE',
    },
    requires_countersignature: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    version: {
      type: 'integer',
      notNull: true,
      default: 1,
    },
    is_current_agreement: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    is_active: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    created_by: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    updated_by: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  // Requirement 28 Criteria 6-7: at most one current mandatory agreement
  // at a time.
  pgm.createIndex('mou_documents', 'is_current_agreement', {
    name: CURRENT_AGREEMENT_INDEX,
    unique: true,
    where: 'is_current_agreement = true',
  });

  // Reuse the baseline schema's existing update_updated_at_column()
  // trigger function, matching site_config/system_config/email_templates.
  pgm.sql(`
    CREATE TRIGGER ${UPDATED_AT_TRIGGER}
    BEFORE UPDATE ON mou_documents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  `);

  pgm.createTable('mou_signatures', {
    id: 'id',
    mou_document_id: {
      type: 'integer',
      notNull: true,
      references: 'mou_documents',
      onDelete: 'CASCADE',
    },
    // Exactly one of signer_user_id/signer_team_id is set per row
    // (Requirement 28 Criterion 4); enforced at the application layer
    // (MouService.recordSignature, task 50.3).
    signer_user_id: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    signer_team_id: {
      type: 'integer',
      references: 'teams',
      onDelete: 'SET NULL',
    },
    signed_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    // 'e_signature' | 'uploaded_scan' -- enforced at the application
    // layer, matching this schema's established convention for
    // enum-like text columns (e.g. access_requests.status,
    // channel_requests.status).
    signature_method: {
      type: 'varchar(20)',
      notNull: true,
    },
    // Holds the in-app e-signature payload or a reference to the
    // uploaded scanned copy, depending on signature_method.
    signature_data: {
      type: 'text',
    },
    countersigned_by: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    countersigned_at: {
      type: 'timestamp',
    },
  });

  // Requirement 28 Criteria 4, 6-7: efficient "does a signature already
  // exist for this document + this signer" lookup, and prevents
  // duplicate signature rows for the same document/signer pair.
  pgm.createIndex('mou_signatures', ['mou_document_id', 'signer_user_id'], {
    name: SIGNATURE_DOCUMENT_USER_INDEX,
    unique: true,
    where: 'signer_user_id IS NOT NULL',
  });
  pgm.createIndex('mou_signatures', ['mou_document_id', 'signer_team_id'], {
    name: SIGNATURE_DOCUMENT_TEAM_INDEX,
    unique: true,
    where: 'signer_team_id IS NOT NULL',
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropIndex('mou_signatures', ['mou_document_id', 'signer_team_id'], {
    name: SIGNATURE_DOCUMENT_TEAM_INDEX,
  });
  pgm.dropIndex('mou_signatures', ['mou_document_id', 'signer_user_id'], {
    name: SIGNATURE_DOCUMENT_USER_INDEX,
  });
  pgm.dropTable('mou_signatures');

  pgm.sql(`DROP TRIGGER IF EXISTS ${UPDATED_AT_TRIGGER} ON mou_documents;`);
  pgm.dropIndex('mou_documents', 'is_current_agreement', {
    name: CURRENT_AGREEMENT_INDEX,
  });
  pgm.dropTable('mou_documents');
};

module.exports = {
  shorthands,
  up,
  down,
};
