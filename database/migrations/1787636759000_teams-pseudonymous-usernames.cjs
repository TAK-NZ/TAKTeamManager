/**
 * Pseudonymous_Username_Policy migration (takserver-enrollment, Requirement 6.1, 6.2).
 *
 * Adds `teams.pseudonymous_usernames`, the Organisation-level policy flag that
 * decides whether a user created under that Organisation receives a
 * Pseudonymous_Username (a Managed_Identifier with Identifier_Type_Marker `U`)
 * instead of an email-derived username.
 *
 * Nullable with NO default -- deliberately not `NOT NULL DEFAULT false`. The
 * tri-state is load-bearing here, in exactly the shape `callsign_level_selection`
 * already has: `NULL` means "this row is a Sub_Team and the question does not
 * apply to it", which is a different fact from `false`, "this is an Organisation
 * and the answer is no". Collapsing them would make a Sub_Team indistinguishable
 * from an Organisation that declined the policy, and the resolver reads the
 * policy from `Team.getAncestorChain(teamId)[0]`, so it must be able to tell
 * that a value found on a non-root row is meaningless rather than authoritative.
 *
 * The application supplies `false` at Organisation creation, so the policy is
 * off unless chosen -- that default is the application's job, not this
 * migration's. This migration supplies no default value at all.
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
ALTER TABLE public.teams
    ADD COLUMN pseudonymous_usernames boolean;

COMMENT ON COLUMN public.teams.pseudonymous_usernames IS 'takserver-enrollment Requirement 6: Organisation-level only, exactly as callsign_level_selection is. NULL on a Sub_Team (parent_team_id IS NOT NULL); false or true on an Organisation. Fixed at Organisation creation -- Requirement 7.2 rejects a change, because switching it would require every members username to change and would invalidate every certificate Common Name in the Organisation.';
`);
};

/**
 * Drops the column `up()` added.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
ALTER TABLE public.teams
    DROP COLUMN IF EXISTS pseudonymous_usernames;
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
