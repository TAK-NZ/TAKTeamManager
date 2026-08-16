/**
 * Documents the new `revoke_tak_certificates` `sync_operations.operation_type`
 * value introduced by the TAK Server Certificate Lifecycle Integration
 * feature (Requirement 26, design.md Section 21).
 *
 * ## Why this migration makes no structural (column/type) change
 *
 * `sync_operations.operation_type` has been a plain `VARCHAR(50) NOT NULL`
 * since the baseline migration (`1786596755665_baseline-schema.cjs`), with
 * NO `CHECK` constraint or database-level enum restricting its values --
 * confirmed by re-reading that baseline file's `CREATE TABLE sync_operations`
 * statement, which only documents the then-known values
 * (`'add_user_to_group', 'remove_user_from_group', 'create_group'`) in a
 * plain SQL comment, exactly the same "enum-like text column, no CHECK
 * constraint, valid values documented in a comment and enforced in
 * application code instead" convention explicitly called out in
 * `1786653600000_add-sync-operations-correlation-failure-category.cjs`'s
 * file-level comment for `failure_category`. Every operation_type value
 * added since the baseline (`bulk_add_user_to_team`,
 * `create_bch_channel_groups`, `cleanup_orphaned_authentik_user`,
 * `remove_team_channel_group`, `create_vendor_channel_group`,
 * `create_deployment_channel_group`, `remove_all_members_from_group`, etc.
 * -- see `server/workers/operationSchemas.js`) was likewise introduced
 * purely by convention: a new `switch` case in
 * `server/workers/syncWorker.js`'s `executeOperation` and a new top-level
 * entry in `operationSchemas.js`, with no accompanying migration, since
 * `VARCHAR(50)` already accepts any new value without a schema change.
 * `revoke_tak_certificates` (23 characters) fits the existing `VARCHAR(50)`
 * bound with no alteration needed.
 *
 * ## Why this migration exists anyway
 *
 * Requirement 26 Criterion 6 explicitly calls out "THE Repository's schema
 * SHALL add a new `sync_operations.operation_type` value (e.g.
 * `revoke_tak_certificates`)", and `tasks.md` tracks this as its own
 * migration task ahead of the service/handler tasks that depend on it
 * (task 48.2, before 48.3-48.5), mirroring this plan's stated convention
 * ("every new table or column lands as its own migration task ahead of
 * the service/route tasks that depend on it"). Rather than a true no-op
 * migration, this file makes one concrete, reversible schema change that
 * satisfies that criterion without inventing a new constraint style for
 * this one column: it updates the column's `COMMENT ON COLUMN` to
 * document `revoke_tak_certificates` alongside the existing example
 * values, so the valid-value documentation lives in the database schema
 * itself (visible via `\d+ sync_operations` / `information_schema`), not
 * only in a `CREATE TABLE` comment from a prior migration that this file
 * does not re-run.
 *
 * A `CHECK` constraint enumerating every `operation_type` was deliberately
 * NOT added here: doing so would break the very next new operation type
 * added by any future feature (each of which lands via the same
 * comment-and-`operationSchemas.js`-only convention used throughout this
 * spec), and would be an inconsistent one-off relative to every other
 * enum-like text column in this schema (`sync_operations.status`,
 * `teams.visibility`, `access_requests.status`,
 * `channel_memberships.permission`, `sync_operations.failure_category`,
 * etc.), none of which use a `CHECK` constraint.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

const NEW_COMMENT = `Operation type discriminator, e.g. 'add_user_to_group', 'remove_user_from_group', 'create_group', 'revoke_tak_certificates' (Requirement 26.6). No CHECK constraint: see server/workers/operationSchemas.js for the authoritative, application-enforced set of valid values.`;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.sql(
    `COMMENT ON COLUMN sync_operations.operation_type IS '${NEW_COMMENT.replace(/'/g, "''")}';`
  );
};

/**
 * Restores the column comment to what the baseline migration documented
 * inline (as a SQL comment rather than a `COMMENT ON COLUMN`, since the
 * baseline never issued one) -- there is no prior `COMMENT ON COLUMN` to
 * roll back to, so this simply clears the comment this migration added.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`COMMENT ON COLUMN sync_operations.operation_type IS NULL;`);
};

module.exports = {
  shorthands,
  up,
  down,
};
