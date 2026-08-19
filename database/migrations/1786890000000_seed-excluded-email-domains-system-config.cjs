/**
 * Seeds the `excluded_email_domains` key in the `system_config` table
 * as an empty JSON array (Requirement 7.5, 6.4).
 *
 * This key stores the global list of consumer/freemail domains (e.g.
 * gmail.com, yahoo.com) that are blocked from submitting org interest
 * requests. The list starts empty and is managed by global admins via
 * the admin panel (Requirement 6.1, 6.2).
 *
 * Uses `INSERT ... ON CONFLICT (config_key) DO NOTHING` so this
 * migration is idempotent — re-running it (or running against a
 * database where the key was already created some other way) never
 * clobbers an existing, possibly admin-edited, value.
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
    INSERT INTO system_config (config_key, config_value, description)
    VALUES (
      'excluded_email_domains',
      '[]',
      'Global list of consumer/freemail domains blocked from org interest requests (Requirement 6)'
    )
    ON CONFLICT (config_key) DO NOTHING;
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
    DELETE FROM system_config
    WHERE config_key = 'excluded_email_domains';
  `);
};

module.exports = {
  shorthands,
  up,
  down,
};
