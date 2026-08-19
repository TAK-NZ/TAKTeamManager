/**
 * Adds `access_requests.signup_code_used` (`varchar(8)`, nullable) to
 * record which sign-up code (if any) was used when a user submitted
 * their team access request through the new two-step sign-up flow
 * (Requirement 7.4).
 *
 * Nullable because the column is only populated when a sign-up code was
 * provided during the flow. Not a foreign key to `signup_codes.code`
 * because codes can be revoked or regenerated after the request is made
 * — the stored value is a historical record of what code was active at
 * the time of request submission.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.addColumn('access_requests', {
    signup_code_used: {
      type: 'varchar(8)',
      notNull: false,
    },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropColumn('access_requests', 'signup_code_used');
};

module.exports = {
  shorthands,
  up,
  down,
};
