/**
 * Device_Email_Null_Invariant migration (takserver-enrollment Requirements
 * 5.3, 5.4, 5.7, 5.11).
 *
 * Makes `users.email` and `user_cache.email` nullable, and adds a matching
 * CHECK constraint to BOTH tables pairing that nullability with the only case
 * that licenses it:
 *
 *   email IS NOT NULL OR is_team_device = true
 *
 * BOTH tables change, not just `users`. `user_cache.email` is
 * `character varying(255) NOT NULL` today and the Authentik_Sync writes it
 * for every user, so leaving it NOT NULL would break the sync for exactly
 * the emailless Team_Owned_Device rows this feature creates.
 * `user_cache.is_team_device` is present in the baseline schema as
 * `boolean DEFAULT false NOT NULL`, so the constraint is expressible
 * identically on both tables and no asymmetry has to be designed around.
 *
 * `users_email_key` needs no change: PostgreSQL treats multiple NULLs as
 * non-conflicting under a unique index, so any number of emailless
 * Team_Owned_Devices coexist. `user_cache.email` has no unique index at all,
 * so nothing else follows there.
 *
 * No `UPDATE` appears anywhere in this migration, in either `up()` or
 * `down()`: the live database holds zero Team_Owned_Devices, so there is
 * nothing to backfill and no synthetic reserved-domain address to migrate
 * away from, because none exists.
 *
 * `down()` reverses both schema changes `up()` made: it drops the two CHECK
 * constraints first, then reissues `SET NOT NULL` on both columns to restore
 * the pre-migration column definition.
 *
 * Follows the baseline migration conventions in this directory: raw SQL via
 * `pgm.sql(...)` and plain quotes with no backticks in comment text (a
 * backtick inside a `pgm.sql(...)` template literal breaks the migration
 * loader with a ParseError).
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
    ALTER COLUMN email DROP NOT NULL;

ALTER TABLE public.user_cache
    ALTER COLUMN email DROP NOT NULL;

ALTER TABLE public.users
    ADD CONSTRAINT users_email_required_unless_device
    CHECK (email IS NOT NULL OR is_team_device = true);

ALTER TABLE public.user_cache
    ADD CONSTRAINT user_cache_email_required_unless_device
    CHECK (email IS NOT NULL OR is_team_device = true);

COMMENT ON COLUMN public.users.email IS 'takserver-enrollment Requirement 5.3/5.4: nullable ONLY for a Team_Owned_Device. The Device_Email_Null_Invariant (users_email_required_unless_device) is what licenses the null; a human row with no email has no account-recovery path and is rejected by this constraint. The Authentik_Sync maps Authentiks empty-string email to NULL at exactly one point, normaliseAuthentikEmail.';
`);
};

/**
 * Reverses both schema changes `up()` made: drops the two CHECK constraints
 * first, then restores `SET NOT NULL` on both columns so the schema returns
 * to its pre-migration shape.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
ALTER TABLE public.users
    DROP CONSTRAINT IF EXISTS users_email_required_unless_device;

ALTER TABLE public.user_cache
    DROP CONSTRAINT IF EXISTS user_cache_email_required_unless_device;

ALTER TABLE public.users
    ALTER COLUMN email SET NOT NULL;

ALTER TABLE public.user_cache
    ALTER COLUMN email SET NOT NULL;
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
