/**
 * Non-destructive `access_requests` shape migration (Requirement 16.3).
 *
 * Background: the original hand-maintained `database/schema.sql` created
 * a "basic" `access_requests` table (columns: `email`, `first_name`,
 * `last_name`, `team_name`, `reason`, `status`, `reviewed_by`,
 * `reviewed_at`, `review_reason`, `created_at` -- matching the now-unused
 * `server/models/AccessRequest.js`), and then immediately ran:
 *
 *   DROP TABLE IF EXISTS access_requests;
 *   CREATE TABLE access_requests (... the "enhanced" request/approval
 *     columns actually used by RequestApprovalService.js: request_type,
 *     requester_email, requester_first_name, requester_last_name,
 *     existing_user_id, target_team_id, current_team_id, requested_role,
 *     requested_first_name, requested_last_name, justification,
 *     email_verified, email_verification_token,
 *     email_verification_expires_at, assigned_to_admin, escalation_level,
 *     escalates_at, processed_by, processed_at, denial_reason ...);
 *
 * every time that script ran. Any environment that already had rows in
 * the basic-shape `access_requests` table before adopting node-pg-migrate
 * would have had them silently discarded by that DROP.
 *
 * The baseline migration (`1786596755665_baseline-schema.cjs`) has been
 * fixed to no longer contain that DROP/CREATE sequence at all -- it now
 * creates `access_requests` directly with the enhanced shape via
 * `CREATE TABLE IF NOT EXISTS`, which is exactly correct for a brand-new
 * database that has never run any version of this schema before.
 *
 * This migration exists for the other case: an environment that had
 * already run the OLD hand-maintained `schema.sql` (basic shape, with
 * real rows) before this migration tool was adopted, and is now running
 * the migration chain for the first time. For that environment,
 * `access_requests` already exists with the basic shape, so the
 * baseline's `CREATE TABLE IF NOT EXISTS` above is a no-op (the table
 * already exists) and the enhanced columns are still missing. This
 * migration adds every enhanced-shape column that isn't already present,
 * using `ADD COLUMN IF NOT EXISTS` throughout, so:
 *
 *   - Fresh database (baseline just created the enhanced shape already):
 *     every `ADD COLUMN IF NOT EXISTS` below is a no-op.
 *   - Legacy database (basic shape, with existing rows): every column
 *     below is added without dropping the table or touching a single
 *     existing row.
 *
 * The `status` column already exists on the basic shape (`VARCHAR(50)
 * DEFAULT 'pending'`) and is reused as-is by the enhanced shape, so it is
 * intentionally not re-added here.
 *
 * `request_type` is backfilled to `'new_account'` for any pre-existing
 * legacy row (the only request type the basic-shape workflow ever
 * represented), so that `RequestApprovalService`'s `NOT NULL`-adjacent
 * `request_type`-driven `switch` logic has a well-defined value for
 * every existing row rather than `NULL`.
 *
 * Uses `pgm.sql('ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...')` rather
 * than node-pg-migrate's `pgm.addColumn` schema-builder API: `addColumn`
 * has no built-in `IF NOT EXISTS` option, and idempotency across both the
 * fresh-database and legacy-database cases described above is the entire
 * point of this migration.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.sql(`
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS request_type VARCHAR(50);
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS requester_email VARCHAR(255);
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS requester_first_name VARCHAR(255);
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS requester_last_name VARCHAR(255);
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS existing_user_id INTEGER REFERENCES users(id);
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS target_team_id INTEGER REFERENCES teams(id);
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS current_team_id INTEGER REFERENCES teams(id);
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS requested_role VARCHAR(50);
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS requested_first_name VARCHAR(255);
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS requested_last_name VARCHAR(255);
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS justification TEXT;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(255);
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMP;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS assigned_to_admin INTEGER REFERENCES users(id);
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS escalation_level INTEGER DEFAULT 0;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS escalates_at TIMESTAMP;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS processed_by INTEGER REFERENCES users(id);
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS processed_at TIMESTAMP;
ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS denial_reason TEXT;

-- Backfill request_type/requester_email for any pre-existing legacy
-- (basic-shape) rows, which predate the request_type/requester_email
-- columns and therefore have them NULL immediately after the ADD COLUMN
-- statements above. The legacy basic-shape workflow only ever
-- represented new-account requests, and stored the requester's address
-- in the basic shape's "email"/"first_name"/"last_name" columns.
--
-- On a brand-new database (baseline already created the enhanced shape
-- directly, per the fix in 1786596755665_baseline-schema.cjs), those
-- legacy "email"/"first_name"/"last_name" columns never existed on
-- access_requests in the first place, so this block guards each
-- reference with an information_schema existence check via a DO block,
-- rather than referencing those columns unconditionally, to stay valid
-- against both the fresh-database and legacy-database cases.
UPDATE access_requests SET request_type = 'new_account' WHERE request_type IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'access_requests' AND column_name = 'email'
  ) THEN
    UPDATE access_requests SET requester_email = email
      WHERE requester_email IS NULL AND email IS NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'access_requests' AND column_name = 'first_name'
  ) THEN
    UPDATE access_requests SET requester_first_name = first_name
      WHERE requester_first_name IS NULL AND first_name IS NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'access_requests' AND column_name = 'last_name'
  ) THEN
    UPDATE access_requests SET requester_last_name = last_name
      WHERE requester_last_name IS NULL AND last_name IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_access_requests_status_new ON access_requests(status);
CREATE INDEX IF NOT EXISTS idx_access_requests_escalates_at ON access_requests(escalates_at) WHERE status = 'pending';
`);
};

/**
 * Down migration intentionally does not drop the added columns: this
 * migration's entire purpose is non-destructive forward migration, so its
 * rollback path is a no-op rather than one that would delete data placed
 * into those columns after `up()` ran. Dropping the (idempotently-added)
 * indexes is safe and reversible.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
DROP INDEX IF EXISTS idx_access_requests_escalates_at;
DROP INDEX IF EXISTS idx_access_requests_status_new;
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
