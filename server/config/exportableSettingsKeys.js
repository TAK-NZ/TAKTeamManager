/**
 * exportableSettingsKeys.js
 *
 * Requirement 32.5/32.6, task 54.5/54.6 (originally); trimmed once the app
 * moved to CDK-based deployment.
 *
 * Single allow-list of `site_config` `config_key` values that may be included
 * in a settings export (`GET /api/settings/export`) or accepted by a settings
 * import (`POST /api/settings/import`). Both handlers import this exact module
 * rather than each maintaining their own copy, so "validate against the same
 * allow-listed set defined for export" is structural (one array, two consumers)
 * rather than duplicated logic that could drift apart.
 *
 * --- Why there are no `system_config` keys here anymore (CDK trim) ---
 *
 * The `system_config` `tak_server_*` rows (`tak_server_url`,
 * `tak_server_p12_path`, `tak_server_cert_path`, `tak_server_key_path`,
 * `tak_server_ca_path`) USED to be exportable/importable. They were removed
 * from this allow-list because they are inert under the app's CDK-based
 * deployment: the runtime (`TakServerService`, `DeviceEnrollmentService`) reads
 * TAK Server configuration ONLY from `process.env` (`TAK_SERVER_URL`,
 * `TAK_SERVER_ENROLLMENT_URL`, the admin-cert secret), and the CDK stack injects
 * those env vars from the tak-infra cross-stack exports. The `tak_server_*`
 * `system_config` rows are read by exactly one route,
 * `GET /api/settings/tak-server` (the admin display/edit surface), which itself
 * falls back to env when no row exists. So exporting/importing those rows onto a
 * CDK-deployed instance had no runtime effect (env wins) and actively misled an
 * operator into thinking imported values were authoritative. TAK Server
 * configuration is now owned by CDK/deployment, not by this export/import.
 *
 * The passphrase (`tak_server_p12_passphrase`) was NEVER in this allow-list (it
 * is a secret); its exclusion is now moot for export/import since no
 * `system_config` key is exportable at all, but the `GET /api/settings/tak-server`
 * route's own passphrase-never-returned discipline is unchanged and unrelated.
 *
 * --- What remains exportable/importable ---
 *
 * This export/import now carries only the settings an operator edits AT RUNTIME
 * through the admin UI, which CDK does NOT manage:
 *
 *  - `site_config` rows named in `siteConfigKeys` below: the request-access page
 *    content and the branding fields.
 *  - `email_templates` rows, exported/imported WHOLESALE (every row, not
 *    key-filtered) — no column on that table is secret-shaped, so
 *    `includesEmailTemplates` is a flag rather than a key array; import
 *    validation for templates is a presence/shape check, not a per-key
 *    allow-list membership check.
 *
 * `tak_color_*`/`tak_role_*` keys are NOT here: the database-backed color/role
 * mapping surface was removed entirely (these deployments source
 * `TAK_COLOR_*`/`TAK_ROLE_*` from a deploy-time env file), so there is no
 * `system_config` row of that shape to export or restore.
 */

const siteConfigKeys = [
  // Existing baseline request-access page content (the baseline
  // migration's own seed rows, database/migrations/).
  'request_access_title',
  'request_access_subtitle',
  'request_access_footer',

  // Branding fields (also seeded by the baseline migration).
  'organization_display_name',
  'organization_logo_path'
];

module.exports = {
  siteConfigKeys,
  // `email_templates` rows are exported/imported wholesale (every row),
  // not filtered by an allow-listed key, since no column on that table is
  // secret-shaped. This flag documents that inclusion explicitly rather
  // than leaving it implicit.
  includesEmailTemplates: true
};
