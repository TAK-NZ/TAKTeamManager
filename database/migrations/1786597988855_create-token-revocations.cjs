/**
 * Creates the `token_revocations` table used to invalidate JWTs on logout
 * (Requirement 3.3). `authenticateToken` checks this table by `jti` after
 * verifying a token's signature; `POST /api/auth/logout` inserts a row
 * here when a valid `jti` was present on the token being logged out.
 *
 * An index on `expires_at` is included even though no purge job exists
 * yet, since the future daily purge job (tracked separately) will query
 * this table with `WHERE expires_at < NOW()`, and the index is cheap to
 * add now versus adding it as a separate migration later.
 *
 * Unlike the baseline migration, this (and every migration from this
 * point forward) uses node-pg-migrate's schema-builder API rather than
 * raw SQL, per the baseline migration's own guidance.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.createTable('token_revocations', {
    jti: {
      type: 'uuid',
      notNull: true,
      primaryKey: true,
    },
    expires_at: {
      type: 'timestamp',
      notNull: true,
    },
  });

  pgm.createIndex('token_revocations', 'expires_at');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropTable('token_revocations');
};

module.exports = {
  shorthands,
  up,
  down,
};
