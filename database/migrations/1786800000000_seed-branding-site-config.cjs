/**
 * Seeds `site_config` with the two rows the branding settings surface
 * (task 54.2, Requirement 32 Criterion 2) reads and writes:
 * `organization_display_name` and `organization_logo_path`.
 *
 * `site_config`'s baseline schema/seed data (see
 * `1786596755665_baseline-schema.cjs`) only contains
 * `request_access_title`/`request_access_subtitle`/`request_access_footer`
 * -- there is no pre-existing org-name or logo `config_key`. This
 * migration therefore establishes a new, lowercase/underscore-separated
 * `config_key` convention for branding, consistent with every other
 * `site_config`/`system_config` row (matching the convention already
 * documented in `1786790000000_seed-tak-color-role-system-config.cjs`):
 *
 *   - `organization_display_name` — the organization name shown in the
 *     App's UI (e.g. replacing the hardcoded "TAK Team Manager" heading
 *     in `client/src/components/Layout.jsx`); seeded with
 *     `'TAK Team Manager'` as a sensible initial default so the column
 *     is never empty out of the box.
 *   - `organization_logo_path` — a plain reference (path/URL) to the
 *     organization's logo asset; seeded as an empty string, since no
 *     logo has been uploaded yet. Task 54.2 accepts this as a plain
 *     string field only (a logo reference, not a file upload); the
 *     atomic `.tmp-${uuid}` + `fs.rename()` file upload mechanism that
 *     writes an actual file to this path is task 54.4's scope, not this
 *     migration's or task 54.2's.
 *
 * `ON CONFLICT (config_key) DO NOTHING` mirrors the idempotency pattern
 * already used by `1786790000000_seed-tak-color-role-system-config.cjs`,
 * so re-running this migration (or an environment where one of these
 * keys was already created some other way) never clobbers an existing,
 * possibly admin-edited, value.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

const SEED_ROWS = [
  {
    configKey: 'organization_display_name',
    configValue: 'TAK Team Manager',
    description: 'Organization display name shown throughout the App UI (Requirement 32.2)'
  },
  {
    configKey: 'organization_logo_path',
    configValue: '',
    description: 'Reference (path/URL) to the organization logo asset (Requirement 32.2)'
  }
];

/**
 * Escapes a value for safe embedding as a single-quoted SQL string
 * literal (standard SQL literal escaping: double every embedded single
 * quote), matching the helper of the same name in
 * `1786790000000_seed-tak-color-role-system-config.cjs`.
 *
 * @param {string} value
 * @returns {string}
 */
const sqlStringLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  const valuesSql = SEED_ROWS.map(
    ({ configKey, configValue, description }) =>
      `(${sqlStringLiteral(configKey)}, ${sqlStringLiteral(configValue)}, ${sqlStringLiteral(description)})`
  ).join(',\n    ');

  pgm.sql(`
    INSERT INTO site_config (config_key, config_value, description)
    VALUES
    ${valuesSql}
    ON CONFLICT (config_key) DO NOTHING;
  `);
};

/**
 * Removes exactly the rows this migration's `up()` seeds, identified by
 * `config_key`. As with the equivalent `down()` in
 * `1786790000000_seed-tak-color-role-system-config.cjs`, this is a
 * data-only reversal: if an operator has since edited either row via the
 * settings surface, rolling back this migration discards that edit along
 * with the seed row.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  const keysSql = SEED_ROWS.map(({ configKey }) => sqlStringLiteral(configKey)).join(', ');

  pgm.sql(`
    DELETE FROM site_config
    WHERE config_key IN (${keysSql});
  `);
};

module.exports = {
  shorthands,
  up,
  down
};
