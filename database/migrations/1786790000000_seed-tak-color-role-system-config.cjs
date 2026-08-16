/**
 * Seeds `system_config` with one row per `TAK_COLOR_*`/`TAK_ROLE_*`
 * environment variable currently hardcoded in
 * `server/routes/config.js`'s `GET /api/config/color-mappings` handler
 * (Requirement 32 Criterion 1, task 54.1).
 *
 * Requirement 32.1 requires that these environment variables be
 * migrated into editable `system_config` rows "preserving each
 * variable's current environment-variable value as its initial default
 * at the time of migration". That current-value read has to happen at
 * migration-*run* time (i.e. `process.env.TAK_COLOR_YELLOW` etc., read
 * inside `up()`), which is something node-pg-migrate's declarative
 * schema-builder API (`pgm.createTable`/`pgm.addColumn`) has no way to
 * express — those methods only emit static DDL with no hook for
 * reading the Node process's environment at the time the migration
 * actually executes. This migration therefore uses `pgm.sql(...)` with
 * a hand-built, escaped `INSERT` statement instead, following the same
 * "drop to raw SQL when the schema-builder API can't express the
 * change" convention already used by
 * `1786653600000_add-sync-operations-correlation-failure-category.cjs`
 * (its `UPDATE ... backfill` statement) and
 * `1786680000000_non-destructive-access-requests.cjs` (its `ADD COLUMN
 * IF NOT EXISTS` statements).
 *
 * `config_key` naming scheme (documented here for task 54.2, which
 * will read these same keys back out of `system_config` to implement
 * the settings surface):
 *
 *   TAK_COLOR_<NAME> environment variable  -> tak_color_<name> config_key
 *   TAK_ROLE_<NAME>  environment variable  -> tak_role_<name>  config_key
 *
 * i.e. simply lower-casing the environment variable name (e.g.
 * `TAK_COLOR_DARK_BLUE` -> `tak_color_dark_blue`,
 * `TAK_ROLE_FORWARD_OBSERVER` -> `tak_role_forward_observer`). This
 * mirrors the existing lowercase, underscore-separated `config_key`
 * convention already used by every other `system_config`/`site_config`
 * row in the baseline schema (e.g. `escalation_hours`,
 * `weekend_escalation`, `request_access_title`).
 *
 * Each row's `config_value` is seeded from `process.env.<VAR> || ''`
 * (an unset/empty environment variable seeds an empty string, matching
 * the `|| ''` fallback already used by the `GET /color-mappings` route
 * this migration is preparing to replace), and `description` records
 * which environment variable the row was migrated from, for operator
 * traceability. `ON CONFLICT (config_key) DO NOTHING` is used so that
 * re-running this migration (or an environment where a key was already
 * created some other way) never clobbers an existing, possibly
 * admin-edited, value — this migration seeds *initial defaults* only,
 * per Requirement 32.1, and is not meant to be a repeatable sync from
 * `.env` to the database.
 *
 * Scope: this task is ONLY the migration/seed script. Reading these
 * keys back out to serve `GET /api/settings/...` or the existing
 * `GET /api/config/color-mappings` route, and any endpoint allowing
 * these rows to be edited, are separate, later tasks (54.2+) per
 * `tasks.md`'s dependency-ordering note.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

// Requirement 32.1's source list: every TAK_COLOR_*/TAK_ROLE_* variable
// currently read directly from process.env by
// `server/routes/config.js`'s `GET /color-mappings` handler.
const SEED_ENV_VARS = [
  // TAK color mappings (14 total)
  'TAK_COLOR_YELLOW',
  'TAK_COLOR_CYAN',
  'TAK_COLOR_GREEN',
  'TAK_COLOR_RED',
  'TAK_COLOR_PURPLE',
  'TAK_COLOR_ORANGE',
  'TAK_COLOR_BLUE',
  'TAK_COLOR_MAGENTA',
  'TAK_COLOR_WHITE',
  'TAK_COLOR_MAROON',
  'TAK_COLOR_DARK_BLUE',
  'TAK_COLOR_TEAL',
  'TAK_COLOR_DARK_GREEN',
  'TAK_COLOR_BROWN',
  // TAK role descriptions (8 total)
  'TAK_ROLE_TEAM_MEMBER',
  'TAK_ROLE_TEAM_LEAD',
  'TAK_ROLE_SNIPER',
  'TAK_ROLE_MEDIC',
  'TAK_ROLE_FORWARD_OBSERVER',
  'TAK_ROLE_RTO',
  'TAK_ROLE_K9',
  'TAK_ROLE_HQ',
];

/**
 * Converts a `TAK_COLOR_*`/`TAK_ROLE_*` environment variable name into
 * its `system_config.config_key` per the naming scheme documented
 * above (e.g. `TAK_COLOR_DARK_BLUE` -> `tak_color_dark_blue`).
 *
 * @param {string} envVarName
 * @returns {string}
 */
const toConfigKey = (envVarName) => envVarName.toLowerCase();

/**
 * Escapes a value for safe embedding as a single-quoted SQL string
 * literal (standard SQL literal escaping: double every embedded single
 * quote). `pgm.sql`'s own `{param}` template substitution is designed
 * for quoting *identifiers* (table/column names), not string literal
 * values, so it is not used here — this migration builds and escapes
 * the literal itself instead.
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
  const valuesSql = SEED_ENV_VARS.map((envVarName) => {
    const configKey = toConfigKey(envVarName);
    // Requirement 32.1: preserve the CURRENT environment-variable value
    // (read here, at migration-run time) as the row's initial default.
    const configValue = process.env[envVarName] || '';
    const description = `Migrated from ${envVarName} environment variable (Requirement 32.1)`;

    return `(${sqlStringLiteral(configKey)}, ${sqlStringLiteral(configValue)}, ${sqlStringLiteral(description)})`;
  }).join(',\n    ');

  pgm.sql(`
    INSERT INTO system_config (config_key, config_value, description)
    VALUES
    ${valuesSql}
    ON CONFLICT (config_key) DO NOTHING;
  `);
};

/**
 * Removes exactly the rows this migration's `up()` seeds, identified by
 * `config_key`. As with the backfill in
 * `1786653600000_add-sync-operations-correlation-failure-category.cjs`,
 * this is a data-only reversal with a known limitation: if an operator
 * has since edited one of these rows via the settings surface (task
 * 54.2+), rolling back this migration discards that edit along with
 * the seed row, since there is no way to distinguish an edited value
 * from the original seed value once persisted. This matches the
 * "normal/expected limitation of reversing a data backfill" already
 * accepted elsewhere in this migration set.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  const configKeys = SEED_ENV_VARS.map(toConfigKey);
  const keysSql = configKeys.map(sqlStringLiteral).join(', ');

  pgm.sql(`
    DELETE FROM system_config
    WHERE config_key IN (${keysSql});
  `);
};

module.exports = {
  shorthands,
  up,
  down,
};
