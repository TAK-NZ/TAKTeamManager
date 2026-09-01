/**
 * exportableSettingsKeys.js
 *
 * Requirement 32.5/32.6, task 54.5/54.6.
 *
 * Single allow-list of `system_config`/`site_config` `config_key` values
 * that may be included in a settings export (`GET /api/settings/export`,
 * task 54.5) or accepted by a settings import (`POST /api/settings/import`,
 * task 54.6). Both handlers import this exact module rather than each
 * maintaining their own copy, so Requirement 32.6's "validate against the
 * same allow-listed set defined for export" is structural (one array, two
 * consumers) rather than duplicated logic that could drift apart.
 *
 * Shape: an object with `systemConfigKeys` (array) and `siteConfigKeys`
 * (array) sub-arrays, plus an `includesEmailTemplates` boolean flag. Two
 * separate key arrays are used, rather than one flat array, because the
 * export/import handlers query two different tables (`system_config` and
 * `site_config`) and a `config_key` string alone doesn't indicate which
 * table it belongs to -- keeping them apart avoids an ambiguous or
 * accidentally-cross-table lookup. `email_templates` rows are exported
 * wholesale (every row, not key-filtered) per design.md's "since template
 * rows have no secret-shaped columns" reasoning, so
 * `includesEmailTemplates` is a flag rather than a third key array: there
 * is no `config_key`-shaped identifier to allow-list for that table, and
 * import validation for `email_templates` is a presence/shape check
 * (does this top-level key exist and is it an array of rows with a known
 * shape), not a per-key allow-list membership check.
 *
 * --- What is excluded, and why (Requirement 32.5's "secrets excluded") ---
 *
 * `tak_server_p12_passphrase` is EXCLUDED: it is the literal secret
 * material protecting the TAK Server mutual-TLS client certificate,
 * directly analogous to the `JWT_SECRET`/`DB_PASSWORD`/Authentik admin
 * token secrets Requirement 32.5 names explicitly. Unlike a color name or
 * a display name, this value grants a capability (decrypting/using the
 * client cert) if disclosed.
 *
 * This repository does not store raw private-key or certificate FILE
 * CONTENT in `system_config` -- only path references to files on disk
 * (see `server/routes/settings.js`'s task-54.3 header comment: "this repo
 * does not persist actual key/cert file bytes in `system_config`, only
 * path references"). There is therefore no `tak_server_*_content`-shaped
 * key to exclude here; the only secret-shaped `system_config` row in the
 * TAK Server credential set is the passphrase itself.
 *
 * `tak_server_p12_path`, `tak_server_cert_path`, `tak_server_key_path`,
 * `tak_server_ca_path`, and `tak_server_url` are INCLUDED. Each is a
 * filesystem path or a URL, not secret content -- knowing that a key file
 * lives at `/certs/api.key` does not let an attacker read that file's
 * contents, any more than knowing a database host/port would let them
 * authenticate to it without the password. This mirrors Requirement 26.1's
 * own treatment of `TAK_API_P12_PATH`/`TAK_API_CERT_PATH`/`TAK_API_KEY_PATH`
 * as configuration alongside the credential secrets, not as secrets
 * themselves. Restoring these path values via a future import (task 54.6)
 * is also operationally necessary: without them, importing an exported
 * archive onto a fresh instance would silently lose the operator's
 * configured cert/key file locations even though the passphrase (and any
 * key file *content*, which this repo never stores here) would still need
 * to be re-entered separately. A minor information-disclosure argument
 * exists for excluding paths too (revealing on-disk layout to anyone who
 * obtains the exported archive) -- this design accepts that minor risk
 * given the archive is Global_Manager-only to produce, and the operational
 * cost of losing path configuration on every export/import round trip.
 *
 * The `organization_display_name`/`organization_logo_path` branding keys
 * (task 54.2's seeded rows) are INCLUDED: neither is secret-shaped, and
 * both are exactly the kind of "branding settings" content Requirement
 * 32.5 names as what the export SHOULD contain.
 *
 * `tak_color_*`/`tak_role_*` keys are NOT here: the database-backed
 * color/role mapping surface was removed entirely (these
 * deployments source `TAK_COLOR_*`/`TAK_ROLE_*` from a deploy-time env
 * file, not an in-app-editable database row), so there is no longer any
 * `system_config` row of that shape to export or restore.
 */

const systemConfigKeys = [
  // TAK Server integration settings (task 54.3). `tak_server_p12_passphrase`
  // is deliberately NOT in this list -- see header comment.
  'tak_server_url',
  'tak_server_p12_path',
  'tak_server_cert_path',
  'tak_server_key_path',
  'tak_server_ca_path'
];

const siteConfigKeys = [
  // Existing baseline request-access page content
  // (`1786596755665_baseline-schema.cjs`'s seed rows).
  'request_access_title',
  'request_access_subtitle',
  'request_access_footer',

  // Branding fields (task 54.2 seed migration
  // `1786800000000_seed-branding-site-config.cjs`).
  'organization_display_name',
  'organization_logo_path'
];

module.exports = {
  systemConfigKeys,
  siteConfigKeys,
  // `email_templates` rows are exported/imported wholesale (every row),
  // not filtered by an allow-listed key, since no column on that table is
  // secret-shaped. This flag documents that inclusion explicitly rather
  // than leaving it implicit.
  includesEmailTemplates: true
};
