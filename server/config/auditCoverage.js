/**
 * Audit_Coverage_Registry
 *
 * A reviewed map of EVERY data-mutating web route to its audit disposition:
 * either the `audit_logs` action string it writes, or an explicit exemption
 * with a reason. `auditCoverage.completeness.test.js` walks the real mounted
 * route inventory (via `routeInventory.js`) and asserts that every mutating
 * route (POST/PUT/PATCH/DELETE) has an entry here, and that no entry here is
 * stale. A new mutating route added with no entry FAILS that test in CI, so
 * "every permutable change is logged" is a mechanically-enforced invariant
 * rather than a convention each new route can silently forget — the same
 * technique `permissions.registry.js` + its completeness test already use for
 * authorization coverage.
 *
 * This registry does NOT write anything itself; it is the reviewed source of
 * truth the guard checks against. The actual writes happen at the call sites
 * (route handlers, or the services/shared cores they delegate to) via
 * `writeAuditLog` (`server/utils/auditLog.js`) or a pre-existing inline
 * `INSERT INTO audit_logs`.
 *
 * Entry shapes (keyed by the `${METHOD} ${path}` route key `getRouteKey`
 * produces, identical to `permissions.registry.js`'s keys):
 *
 *   { action: 'noun.verb' }
 *       The route writes (or delegates a write of) an audit_logs row with this
 *       action. For a route audited PER AFFECTED ROW (the bulk user ops),
 *       `perRow: true` documents that it emits one row per entry, not one per
 *       request — matching the single-item action it mirrors.
 *
 *   { exempt: true, reason: '...' }
 *       The route is deliberately NOT audited, for the stated reason. The only
 *       sanctioned reasons are: it mutates no authenticated persistent state
 *       (a preview/compute, a test-email send, a session logout), or it is a
 *       PUBLIC (unauthenticated) endpoint with no acting user to record as the
 *       FK `audit_logs.user_id` — its outcome is captured in its own table and
 *       becomes auditable when an admin later actions it (e.g. request.approve).
 *
 * Adding a mutating route? Add its key here with an `action` (and call
 * `writeAuditLog` in the handler) — or, only if it genuinely fits one of the
 * exemption reasons above, an `{ exempt, reason }`.
 */

const auditCoverage = {
  // ---- teams.js ----
  'POST /api/teams': { action: 'team.create' },
  'PUT /api/teams/:teamId': { action: 'team.update' },
  'PUT /api/teams/:teamId/channel-access': { action: 'team.update_channel_access' },
  'POST /api/teams/:teamId/members': { action: 'team.member_add' },
  'PATCH /api/teams/:teamId/members/:userId': { action: 'team.member_edit' },
  'DELETE /api/teams/:teamId': { action: 'team.delete' },

  // ---- users.js ----
  'POST /api/users': { action: 'user.create' },
  'POST /api/users/create-and-add': { action: 'user.create' },
  'POST /api/users/add-to-team': { action: 'user.add_to_team' },
  'DELETE /api/users/remove-from-team/:userId': { action: 'user.remove_from_team' },
  'POST /api/users/:userId/transfer': { action: 'user.team_transfer' },
  'POST /api/users/:userId/suspend': { action: 'user.suspend' },
  'POST /api/users/:userId/unsuspend': { action: 'user.unsuspend' },
  'POST /api/users/:userId/resend-welcome': { action: 'user.resend_welcome' },
  // Bulk user ops: one audit row PER AFFECTED USER (not per request), via
  // delegation to the same service/shared-core the single-item route uses.
  'POST /api/users/bulk-suspend': { action: 'user.suspend', perRow: true },
  'POST /api/users/bulk-unsuspend': { action: 'user.unsuspend', perRow: true },
  'POST /api/users/bulk-resend-welcome': { action: 'user.resend_welcome', perRow: true },
  'POST /api/users/bulk-transfer': { action: 'user.team_transfer', perRow: true },
  'POST /api/users/bulk-remove-from-team': { action: 'user.remove_from_team', perRow: true },
  'POST /api/users/callsign-suffix-preview': {
    exempt: true,
    reason: 'Preview/compute only — resolves a suggested callsign suffix, persists nothing.'
  },

  // ---- channels.js ----
  'POST /api/channels/custom': { action: 'channel.create' },
  'PUT /api/channels/:channelId': { action: 'channel.update' },
  'DELETE /api/channels/:channelId': { action: 'channel.delete' },
  'POST /api/channels/:channelId/members': { action: 'channel.member_add' },
  'DELETE /api/channels/:channelId/members/:userId': { action: 'channel.member_remove' },

  // ---- globalChannels.js ----
  'POST /api/global-channels/bch': { action: 'global_channel.create_bch' },
  'POST /api/global-channels/region': { action: 'global_channel.create_region' },
  'PUT /api/global-channels/bch/:channelId': { action: 'global_channel.update_bch' },
  'PUT /api/global-channels/region/:channelId': { action: 'global_channel.update_region' },
  'DELETE /api/global-channels/:channelType/:channelId': { action: 'global_channel.delete' },
  'POST /api/global-channels/bch/:channelId/provision-service-account': { action: 'global_channel.provision_service_account' },
  'POST /api/global-channels/bch/:channelId/rotate-password': { action: 'global_channel.rotate_service_account_password' },
  'DELETE /api/global-channels/bch/:channelId/service-account': { action: 'global_channel.delete_service_account' },
  'POST /api/global-channels/assign-all-users': { action: 'global_channel.assign_all_users' },
  'POST /api/global-channels/seed-regions': { action: 'global_channel.seed_regions' },
  'POST /api/global-channels/sync-existing': { action: 'global_channel.sync_existing' },

  // ---- requests.js ----
  'POST /api/requests/:requestId/approve': { action: 'request.approve' },
  'POST /api/requests/:requestId/deny': { action: 'request.deny' },

  // ---- orgDomains.js ----
  'PUT /api/orgs/:orgId/domains': { action: 'org_domains.update' },
  'PUT /api/admin/excluded-domains': { action: 'excluded_domains.update' },
  'PATCH /api/admin/org-interest/:id': { action: 'org_interest.update_status' },

  // ---- signupCodes.js ----
  'POST /api/signup-codes/generate': { action: 'signup_code.generate' },
  'DELETE /api/signup-codes/:teamId': { action: 'signup_code.revoke' },

  // ---- config.js ----
  'PUT /api/config/:key': { action: 'config.update' },

  // ---- settings.js ----
  'PUT /api/settings/branding': { action: 'settings.update_branding' },
  'PUT /api/settings/tak-server': { action: 'settings.update_tak_server' },
  'POST /api/settings/branding/logo': { action: 'settings.upload_logo' },
  'POST /api/settings/tak-server/cert': { action: 'settings.upload_cert' },
  'POST /api/settings/tak-server/key': { action: 'settings.upload_key' },
  'POST /api/settings/import': { action: 'settings.import' },

  // ---- communications.js ----
  'PUT /api/communications/templates/:key': { action: 'email_template.update' },
  'POST /api/communications/test-email': {
    exempt: true,
    reason: 'Sends a one-off test email; mutates no persistent application state.'
  },

  // ---- sync.js / operations.js ----
  'POST /api/sync/users': { action: 'sync.trigger_manual' },
  'POST /api/operations/retry-failed': { action: 'operations.retry_failed' },

  // ---- devices.js ----
  'POST /api/devices': { action: 'device.create' },
  'PATCH /api/devices/:deviceUserId': { action: 'device.update' },
  'DELETE /api/devices/:deviceUserId': { action: 'device.delete' },
  'POST /api/devices/bulk-delete': { action: 'device.delete', perRow: true },
  'POST /api/devices/:deviceUserId/qr-code': { action: 'device.enrollment_generated' },

  // ---- deviceManagement.js ----
  'POST /api/device-management/me/devices/:clientUid/revoke': { action: 'device.revoke_requested' },
  'POST /api/device-management/users/:userId/devices/:clientUid/revoke': { action: 'device.revoke_requested' },

  // ---- enrollment.js ----
  'POST /api/enrollment/me': { action: 'enrollment.generated' },

  // ---- bulkImport.js ----
  // Bulk import writes ONE summary row per import operation (bulk_import.users
  // / bulk_import.teams). This is the one place a per-operation summary row is
  // the right granularity — the per-row detail lives in the import result, and
  // thousands of per-user rows would be pure noise (the operator's explicit
  // preference). The individual account CREATES it performs are the general
  // user-create action elsewhere; the aggregate row records the batch itself.
  'POST /api/bulk-import/users': { action: 'bulk_import.users' },
  'POST /api/bulk-import/teams': { action: 'bulk_import.teams' },
  'POST /api/bulk-import/users/preview': {
    exempt: true,
    reason: 'Preview/dry-run of a CSV; validates and echoes rows, writes nothing.'
  },

  // ---- auth.js ----
  'POST /api/auth/logout': {
    exempt: true,
    reason: 'Ends the caller\'s own session (clears the tak_session cookie); a session teardown, not a data mutation.'
  },

  // ---- signup.js (PUBLIC, unauthenticated) ----
  // No authenticated actor exists to record as audit_logs.user_id (its FK to
  // users.id), so these are not audited here. Each writes to its OWN table
  // (access_requests / org_interest_requests) and becomes auditable the moment
  // an admin actions it: request.approve / request.deny / org_interest.update_status.
  // POST /api/requests/initiate additionally returns a fixed body for every
  // outcome (an anti-enumeration oracle) — an audit side effect must not
  // perturb that.
  'POST /api/requests/initiate': {
    exempt: true,
    reason: 'Public/unauthenticated signup funnel; no acting user for the FK. Captured in access_requests and audited on admin approve/deny.'
  },
  'POST /api/requests/team-access': {
    exempt: true,
    reason: 'Public/unauthenticated signup submission; no acting user for the FK. Captured in access_requests and audited on admin approve/deny.'
  },
  'POST /api/org-interest': {
    exempt: true,
    reason: 'Public/unauthenticated org-interest submission; no acting user for the FK. Captured in org_interest_requests and audited on admin action.'
  }
};

module.exports = { auditCoverage };
