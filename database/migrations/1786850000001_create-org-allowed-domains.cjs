/**
 * Creates the `org_allowed_domains` table used to store per-org email
 * domain restrictions (Requirement 7.2). Each row represents one allowed
 * email domain for a given organisation (root-level team). Teams within
 * an org that has domain entries will only be visible during sign-up to
 * users whose verified email matches one of the listed domains.
 *
 * `org_id` references `teams(id)` — the application layer enforces that
 * the referenced team is a root team (parent_team_id IS NULL). The
 * UNIQUE constraint on (org_id, domain) prevents duplicate entries.
 * An index on `org_id` supports the team-filtering query that checks
 * domain eligibility at sign-up time.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.createTable('org_allowed_domains', {
    id: 'id',
    org_id: {
      type: 'integer',
      notNull: true,
      references: 'teams',
      onDelete: 'CASCADE',
    },
    domain: {
      type: 'varchar(255)',
      notNull: true,
    },
  });

  pgm.addConstraint('org_allowed_domains', 'org_allowed_domains_org_id_domain_unique', {
    unique: ['org_id', 'domain'],
  });

  pgm.createIndex('org_allowed_domains', 'org_id');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropTable('org_allowed_domains');
};

module.exports = {
  shorthands,
  up,
  down,
};
