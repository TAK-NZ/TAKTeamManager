/**
 * Account_Status migration (account-lifecycle-management, task 1.1).
 *
 * Adds `users.account_status`, the tri-state lifecycle column this feature
 * introduces: `'active'` (default, the status of every pre-existing row and
 * every newly-created one), `'suspended'` (an admin-initiated, reversible
 * lockout -- Requirement 1), and `'orphaned'` (an automatically-detected,
 * irreversible response to the row's Authentik identity no longer existing
 * -- Requirements 2-4).
 *
 * `NOT NULL DEFAULT 'active'`, unlike the tri-state-NULL columns elsewhere in
 * this schema (`teams.pseudonymous_usernames`, `teams.callsign_level_selection`,
 * `teams.response_channel_access`/`support_channel_access`): those use NULL
 * to mean "this row is a Sub_Team and the question does not apply", a
 * genuinely different fact from any concrete answer. `account_status` has no
 * such "does not apply" case -- every `users` row, human or
 * Team_Owned_Device, is always in exactly one of the three states -- so a
 * concrete default is correct rather than a tri-state NULL, and no backfill
 * is needed: every existing row already satisfies `DEFAULT 'active'`.
 *
 * `account_status` lives on `users`, not `user_cache`: it is a structural
 * fact about the local row's relationship to Authentik (alongside
 * `is_team_device`, `origin_org_id`), not an Authentik-mirrored display
 * attribute. It is kept CONSISTENT with the pre-existing `users.is_active`/
 * `user_cache.is_active` columns by the application (Requirement 1.9: `false`
 * WHILE `account_status` is `'suspended'` or `'orphaned'`, `true` when it is
 * `'active'`), not by a database trigger -- every other cross-column
 * consistency rule in this schema (e.g. `origin_org_id` write-once via
 * `COALESCE`) is likewise enforced in application code, not in SQL.
 *
 * The partial index `WHERE account_status <> 'active'` mirrors the existing
 * `idx_teams_callsign_prefix`-style precedent of indexing only the
 * exceptional rows: the overwhelming majority of `users` rows will always be
 * `'active'`, so indexing that majority buys nothing for the query this
 * column exists to serve -- "list the accounts a Team_Admin needs to look at
 * because they are NOT active".
 *
 * Follows the conventions of the migrations in this directory: raw SQL via
 * `pgm.sql(...)`, plain quotes with no backticks inside the SQL string, and a
 * `down()` that reverses exactly what `up()` did.
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
ALTER TABLE public.users
    ADD COLUMN account_status character varying(20) NOT NULL DEFAULT 'active';

ALTER TABLE public.users
    ADD CONSTRAINT users_account_status_check
    CHECK (account_status IN ('active', 'suspended', 'orphaned'));

COMMENT ON COLUMN public.users.account_status IS 'account-lifecycle-management: one of ''active'' (default), ''suspended'' (admin-initiated, reversible -- Authentik account and its is_active flag still exist, just locked; every live TAK Server certificate revoked), or ''orphaned'' (automatically detected by the Reconciliation_Sweep in authentikSync.js when the row''s authentik_user_id no longer appears in Authentik''s current user list; irreversible -- there is no Authentik identity left to reactivate). Kept consistent with users.is_active/user_cache.is_active by application code, not a trigger: is_active is false for both ''suspended'' and ''orphaned''. An ''orphaned'' row is NEVER deleted -- audit_logs.user_id and sibling foreign keys are non-cascading, so the row and its full history are retained indefinitely; a matching new sign-up instead adopts it via Account_Reclaim (see UserProvisioningService.createAndAddUser''s reclaimedUserId branch).';

CREATE INDEX idx_users_account_status ON public.users (account_status)
    WHERE account_status <> 'active';
`);
};

/**
 * Reverses exactly what `up()` did.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
DROP INDEX IF EXISTS public.idx_users_account_status;

ALTER TABLE public.users
    DROP CONSTRAINT IF EXISTS users_account_status_check;

ALTER TABLE public.users
    DROP COLUMN IF EXISTS account_status;
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
