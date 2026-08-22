/**
 * Permission_Registry
 *
 * Single source of truth mapping every mounted route path + HTTP method
 * combination to the permission identifier(s) required to access it, and
 * defining role-based default permission sets.
 *
 * `routes` is now populated with an entry for every genuinely-authenticated
 * route mounted in `server/index.js` (task 12.1). Public/no-auth routes
 * (e.g. `GET /api/teams/joinable`, `GET /health`, the OAuth2 `/api/auth/*`
 * flow routes, and other entries already tracked in
 * `server/config/publicRoutes.js`) are intentionally NOT registered here,
 * since Requirement 33.3 requires the Public_Route_Registry and this
 * Permission_Registry to never overlap.
 *
 * Task 12.2 removed the scattered inline `is_global_manager` /
 * `Team.isAdmin` checks from `teams.js`, `users.js`, and
 * `globalChannels.js`. Task 12.3 mounted the Authorization_Middleware
 * (`server/middleware/authorize.js`) immediately after `authenticateToken`
 * on every authenticated route across the route files, consuming this
 * registry data.
 *
 * Permission identifier naming scheme: `${resource}:${action}[:${scope}]`,
 * e.g. `global_channel:read`, `global_channel:manage`,
 * `global_channel:credentials`, `team:read`, `team:create:root_or_sub`,
 * `team:delete:global`. A `:own` scope suffix denotes "the requesting
 * user's own resource" (e.g. `user:read:own`); a `:global` suffix denotes
 * "global-manager-level scope" as opposed to a team-scoped equivalent.
 *
 * See design.md "Authorization Architecture" for the intended shape and
 * requirements.md Requirement 24 (Centralized Authorization Architecture)
 * for the acceptance criteria this registry supports.
 */

const routes = {
  // Maps `${HTTP_METHOD} ${routePath}` to an array of required permission
  // identifiers. A route path/method combination with no entry here is
  // denied by the Authorization_Middleware by default (Requirement 24.4).

  // --- /api/auth (server/routes/auth.js) ---
  // Every other route in auth.js (`/sso`, `/login`, `/silent`,
  // `/silent-callback`, `/callback`, `POST /logout`) runs without
  // `authenticateToken` and is tracked in publicRoutes.js instead, not here.
  'GET /api/auth/me': ['user:read:own'],

  // --- /api/teams (server/routes/teams.js) ---
  // `GET /api/teams/joinable` runs without `authenticateToken` (public) and
  // is tracked in publicRoutes.js instead, not here.
  'GET /api/teams/my-teams': ['team:read:own'],
  'POST /api/teams': ['team:create:root_or_sub'],
  'PUT /api/teams/:teamId': ['team:update'],
  'GET /api/teams/:teamId': ['team:read'],
  'POST /api/teams/:teamId/members': ['team:members:add'],
  // Requirements 11.4, 13.2, 13.10 (tasks 28.1, 28.2): Member_List
  // name/TAK_Role/callsign_suffix edit route. The 'team:members:edit'
  // row-scoped resolver (server/middleware/authorize.js) permits a
  // Global_Manager, or a Team_Admin of :teamId (inherited via
  // Team.isAdmin, per Requirement 4) AND for whom :teamId is a
  // Visible_Branch (per TeamVisibilityService, Requirement 13.10) --
  // both conditions required for a non-Global_Manager.
  'PATCH /api/teams/:teamId/members/:userId': ['team:members:edit'],
  'GET /api/teams/:teamId/hierarchy': ['team:read'],
  'GET /api/teams/:teamId/sub-teams': ['team:read'],
  // Requirement 5.8-5.11 (task 8.3): thin wrapper route around
  // Team.getSubTeamsForCallsignLevel, reusing the existing 'team:read'
  // identifier -- same scoping as the sibling :teamId/:teamId/hierarchy/
  // :teamId/sub-teams routes above. 'team:read' is now a row-scoped
  // Visible_Branch check (via TeamVisibilityService, see task 14.1's
  // resolver in server/middleware/authorize.js), which this route
  // inherits automatically with no change here.
  'GET /api/teams/:teamId/callsign-level-options': ['team:read'],
  'DELETE /api/teams/:teamId': ['team:delete:global'],

  // --- /api/users (server/routes/users.js) ---
  'GET /api/users': ['user:read'],
  'GET /api/users/me': ['user:read:own'],
  'POST /api/users': ['user:create:team_admin'],
  'POST /api/users/:userId/holding-pen': ['user:holding_pen:team_admin'],
  'POST /api/users/:userId/resend-welcome': ['user:resend_welcome:team_admin'],
  'GET /api/users/search': ['user:read'],
  'GET /api/users/available': ['user:read'],
  'POST /api/users/create-and-add': ['user:create'],
  'POST /api/users/add-to-team': ['user:team:add'],
  'DELETE /api/users/remove-from-team/:userId': ['user:team:remove'],
  // Requirement 2.1 (team-member-transfer): Team_Transfer route. The
  // 'user:team:transfer' row-scoped resolver
  // (server/middleware/authorize.js) permits a Global_Manager, a
  // Team_Admin of the Destination_Team (`req.body.targetTeamId`), or a
  // Team_Admin of the Source_Team (the Transferred_User's
  // Direct_Membership team) -- all via `Team.isAdmin`, so an admin
  // anywhere in either Team's Ancestor_Chain qualifies (Req 2.2, 2.6).
  // Deliberately NOT added to `roleDefaults.authenticated_user` below: a
  // statically-held identifier would satisfy `resolveAccess` outright and
  // bypass the row-scoped resolver entirely, granting every authenticated
  // user the ability to move any member between teams.
  'POST /api/users/:userId/transfer': ['user:team:transfer'],

  // --- /api/channels (server/routes/channels.js) ---
  'GET /api/channels/descriptions': ['channel:read'],
  'POST /api/channels/custom': ['channel:create:custom'],
  'GET /api/channels/team/:teamId': ['channel:read'],

  // --- /api/requests (server/routes/requests.js) ---
  // `POST /api/requests/team-access` runs without `authenticateToken`
  // (public) and is tracked in publicRoutes.js instead, not here.
  'GET /api/requests/pending': ['request:read'],
  'POST /api/requests/:requestId/approve': ['request:approve'],
  'POST /api/requests/:requestId/deny': ['request:deny'],

  // --- /api/channel-requests (server/routes/channelRequests.js) ---
  // Requirement 23 (Channel Creation Approval Workflow): submitting a
  // channel request is restricted to a Global_Manager or an admin (per
  // `Team.isAdmin`) of the target team (Req 23.2-23.3); approving/denying
  // a pending request is restricted to a Global_Manager or an admin of
  // the parent team of the request's `team_id` (Req 23.4). Listing
  // pending requests is available to any authenticated user; the route
  // handler itself scopes the result set (Global_Manager sees every
  // pending request, a team admin sees only their administered team(s)'
  // pending requests), mirroring `GET /api/requests/pending`'s existing
  // shape.
  'POST /api/channel-requests': ['channel_request:create'],
  'GET /api/channel-requests/pending': ['channel_request:read'],
  'POST /api/channel-requests/:requestId/approve': ['channel_request:process'],
  'POST /api/channel-requests/:requestId/deny': ['channel_request:process'],

  // --- /api/config (server/routes/config.js) ---
  // `GET /api/config/public` runs without `authenticateToken` (public) and
  // is tracked in publicRoutes.js instead, not here.
  'GET /api/config/all': ['config:read:all'],
  'GET /api/config/color-mappings': ['config:read:mappings'],
  'PUT /api/config/:key': ['config:update'],

  // --- /api/sync (server/routes/sync.js) ---
  'POST /api/sync/users': ['sync:trigger'],
  'GET /api/sync/status': ['sync:read'],

  // --- /api/operations (server/routes/operations.js) ---
  'GET /api/operations/status': ['operations:read'],
  'GET /api/operations/recent': ['operations:read'],
  'POST /api/operations/retry-failed': ['operations:retry'],

  // --- /api/global-channels (server/routes/globalChannels.js) ---
  // `GET /bch` and `GET /region` are read routes available to any
  // authenticated user; every other route below requires Global_Manager
  // (`requireGlobalManager`) today via an inline check that task 12.2 will
  // remove in favor of the Authorization_Middleware consuming these entries.
  'GET /api/global-channels/bch': ['global_channel:read'],
  'POST /api/global-channels/bch': ['global_channel:manage'],
  'GET /api/global-channels/region': ['global_channel:read'],
  'POST /api/global-channels/region': ['global_channel:manage'],
  // Requirement 4.4 / 24.5: BCH credential-retrieval route, Global_Manager-only.
  'GET /api/global-channels/bch/:channelId/credentials': ['global_channel:credentials'],
  'POST /api/global-channels/assign-all-users': ['global_channel:manage'],
  'PUT /api/global-channels/bch/:channelId': ['global_channel:manage'],
  'PUT /api/global-channels/region/:channelId': ['global_channel:manage'],
  'POST /api/global-channels/sync-existing': ['global_channel:manage'],
  // Requirement 4.4 / 24.5: the channel-deletion route, Global_Manager-only.
  'DELETE /api/global-channels/:channelType/:channelId': ['global_channel:manage'],

  // --- /api/vendor-channels (server/routes/vendorChannels.js) ---
  // Requirement 21: every route below is Global_Manager-only (creating
  // the singleton Vendor_Channel, setting/clearing a target user's
  // `is_vendor` flag, and creating/revoking Vendor_Channel_Grants).
  'POST /api/vendor-channels': ['vendor_channel:manage'],
  'PUT /api/vendor-channels/users/:userId/vendor-flag': ['vendor_channel:manage'],
  'POST /api/vendor-channels/grants': ['vendor_channel:manage'],
  'POST /api/vendor-channels/grants/:grantId/revoke': ['vendor_channel:manage'],

  // --- /api/deployment-channels (server/routes/deploymentChannels.js) ---
  // Requirement 22: creating a Deployment_Channel is Global_Manager-only
  // (every Global_Manager is treated as an authorized
  // Deployment_Coordinator per Req 22.3); listing active
  // Deployment_Channels and the self-service subscribe/unsubscribe
  // endpoints are available to any authenticated user (Req 22.6, 22.7),
  // via the `channel:subscribe:deployment` identifier already present in
  // `roleDefaults.authenticated_user` below.
  'POST /api/deployment-channels': ['deployment_channel:manage'],
  'GET /api/deployment-channels': ['channel:subscribe:deployment'],
  'POST /api/deployment-channels/:channelId/subscribe': ['channel:subscribe:deployment'],
  'POST /api/deployment-channels/:channelId/unsubscribe': ['channel:subscribe:deployment'],

  // --- /api/audit-logs (server/routes/auditLogs.js) ---
  // Requirement 31 Criterion 1/2/4: Global_Manager-only; not exposed to a
  // team admin who is not also a Global_Manager, since audit log entries
  // can span teams the team admin does not administer. The CSV export
  // route (task 53.2) shares the same `audit_log:read` permission
  // identifier as the JSON query route, since both expose the exact same
  // underlying data (filtered `audit_logs` rows) -- exporting isn't a
  // higher-privilege operation than reading, just a different response
  // format, so a separate identifier would add no additional access
  // control value.
  'GET /api/audit-logs': ['audit_log:read'],
  'GET /api/audit-logs/export.csv': ['audit_log:read'],

  // --- /api/communications (server/routes/communications.js) ---
  // Requirement 30.4: Global_Manager-only GET/PUT surface for editing
  // existing email_templates rows' subject_template/body_template
  // columns.
  'GET /api/communications/templates/:key': ['communication:template:read'],
  'PUT /api/communications/templates/:key': ['communication:template:manage'],
  // Requirement 30.5: Global_Manager-only "send test email" endpoint,
  // calling `EmailService.sendEmail` directly against an admin-specified
  // address, independent of any `access_requests` row or broadcast
  // trigger (task 52.3).
  'POST /api/communications/test-email': ['communication:test_email:send'],
  // Requirement 30.1: broadcast-email endpoint, wiring
  // `BroadcastEmailService.send` (task 52.1) to HTTP. Held by BOTH
  // `roleDefaults.global_manager` (wildcard) AND
  // `roleDefaults.authenticated_user` below -- unlike the two entries
  // above, this is intentionally NOT Global_Manager-only at this layer.
  // Mirrors the `mou:sign` precedent: Requirement 30.2/30.3 describe the
  // SERVICE's own fail-closed scoping behavior ("a team admin may send
  // only within teams they administer"), not a route-level gate, so
  // `BroadcastEmailService.send`'s internal authorization check (see that
  // file's doc comment) is the real access control for a
  // non-Global_Manager caller.
  'POST /api/communications/send': ['communication:broadcast:send'],

  // --- /api/mou (server/routes/mou.js) ---
  // Requirement 28 (MOU/Document Management, task 50.5): document
  // creation/editing/current-agreement-designation is Global_Manager-only
  // (Req 28.3), enforced here via `mou:manage` (held only by
  // `roleDefaults.global_manager`'s wildcard) since `MouService
  // .createDocument`/`updateDocument`/`setAsCurrentAgreement` do NOT
  // check authorization themselves. Signature recording
  // (`POST /:documentId/sign` -- the EXACT path relied upon by
  // `server/middleware/requireCurrentAgreement.js`'s `BYPASS_ROUTES`) is
  // available to any authenticated user at this layer via `mou:sign`,
  // since `MouService.recordSignature`'s own `assertSignatureAuthorized`
  // enforces the real authorization rule internally (team admin for
  // team-scoped documents, Global_Manager for any, or self-signing a
  // serverwide document -- Req 28.4). Countersignature is
  // Global_Manager-only at BOTH this layer (`mou:manage`) AND
  // `MouService.recordCountersignature`'s own internal check (defense in
  // depth, Req 28.5). The two GET routes are read-only convenience
  // lookups available to any authenticated user via `mou:read`.
  'POST /api/mou/documents': ['mou:manage'],
  'PUT /api/mou/documents/:documentId': ['mou:manage'],
  'POST /api/mou/documents/:documentId/set-current': ['mou:manage'],
  'POST /api/mou/:documentId/sign': ['mou:sign'],
  'POST /api/mou/signatures/:signatureId/countersign': ['mou:manage'],
  'GET /api/mou/documents/:documentId': ['mou:read'],
  'GET /api/mou/current-agreement': ['mou:read'],

  // --- /api/settings (server/routes/settings.js) ---
  // Requirement 32.2: Global_Manager-only branding (site_config-backed)
  // and TAK color/role mapping (system_config-backed) GET/PUT surface
  // (task 54.2).
  'GET /api/settings/branding': ['settings:manage'],
  'PUT /api/settings/branding': ['settings:manage'],
  'GET /api/settings/tak-mappings': ['settings:manage'],
  'PUT /api/settings/tak-mappings': ['settings:manage'],
  // Requirement 32.3: TAK Server integration credential settings
  // endpoints, Global_Manager-only.
  'GET /api/settings/tak-server': ['settings:tak_server:read'],
  'PUT /api/settings/tak-server': ['settings:tak_server:manage'],
  // Requirement 32.4 (task 54.4): atomic cert/key/logo file upload
  // endpoints. The logo upload shares `settings:manage` with the
  // branding GET/PUT routes above (same underlying organization_logo_path
  // site_config row, just uploading file content instead of a plain
  // string path); the cert/key uploads share `settings:tak_server:manage`
  // with `PUT /api/settings/tak-server` (same underlying
  // tak_server_cert_path/tak_server_key_path system_config rows, same
  // "manage" write operation).
  'POST /api/settings/branding/logo': ['settings:manage'],
  'POST /api/settings/tak-server/cert': ['settings:tak_server:manage'],
  'POST /api/settings/tak-server/key': ['settings:tak_server:manage'],
  // Requirement 32.5: configuration export endpoint, Global_Manager-only
  // (task 54.5). Shares the `settings:manage` identifier with the
  // branding/tak-mappings GET/PUT routes above rather than a dedicated
  // identifier, since it exposes the exact same underlying config rows
  // (filtered through exportableSettingsKeys.js's allow-list) in a
  // different (zip/JSON) format -- mirroring the audit-log export
  // route's reasoning ("exporting isn't a higher-privilege operation than
  // reading, just a different response format") above.
  'GET /api/settings/export': ['settings:manage'],
  // Requirement 32.6: configuration import endpoint, Global_Manager-only
  // (task 54.6). Shares `settings:manage` with the export route above for
  // the same reason -- it writes the exact same allow-listed
  // `system_config`/`site_config`/`email_templates` rows the export route
  // reads, just via a different (JSON body) transport.
  'POST /api/settings/import': ['settings:manage'],

  // --- /api/devices (server/routes/devices.js) ---
  // Requirement 27 (Team-Owned Device Enrollment, task 49.4): both routes
  // below are reachable by ANY authenticated user at this layer via the
  // `device:manage` identifier, which is deliberately placed in BOTH
  // `roleDefaults.global_manager` (automatically, via the wildcard) AND
  // `roleDefaults.authenticated_user` below -- mirroring exactly how
  // `mou:sign` is set up for `POST /api/mou/:documentId/sign`. This is
  // intentional: `DeviceEnrollmentService.assertAuthorized` already
  // performs the REAL team-scoped check (`Team.isAdmin(teamId,
  // actingUser) OR actingUser.is_global_manager`, Requirement 27
  // Criterion 3) internally on every call, so gating this Global_Manager
  // -only here would incorrectly block a team admin who is not a
  // Global_Manager from creating/enrolling devices for their own team.
  'POST /api/devices': ['device:manage'],
  'POST /api/devices/:deviceUserId/qr-code': ['device:manage'],

  // --- /api/bulk-import (server/routes/bulkImport.js) ---
  // Requirement 29 (CSV Bulk Import for Users and Teams, task 51.4).
  // `POST /users`: `BulkImportService.importUsers` (task 51.1) already
  // performs its own per-row authorization internally (`Team.isAdmin(row
  // .teamId, importingUser) OR importingUser.is_global_manager`) -- a
  // failing row is recorded in the results array, the batch continues
  // (Requirement 29.4). `bulk_import:users` is therefore placed in BOTH
  // `roleDefaults.global_manager` (via its wildcard) AND
  // `roleDefaults.authenticated_user` below, mirroring the `mou:sign`
  // precedent (server/routes/mou.js): any authenticated user, including
  // a team admin, can reach this route -- the service's per-row check is
  // the real access control.
  //
  // `POST /teams`: `BulkImportService.importTeams` (task 51.2) is
  // Global_Manager-only for the ENTIRE batch, throwing
  // `BulkImportAuthorizationError` up front when `importingUser
  // .is_global_manager` is not `true` -- creating an arbitrary new team
  // isn't scoped to any single team an admin might administer, mirroring
  // Requirement 4.5's root-team-create restriction. `bulk_import:teams`
  // is therefore a SEPARATE identifier held ONLY by
  // `roleDefaults.global_manager`'s wildcard (defense in depth, mirroring
  // `MouService.recordCountersignature`'s double-gating pattern: gated at
  // BOTH this registry layer AND the service's own internal check),
  // rather than being reachable by any authenticated_user.
  'POST /api/bulk-import/users': ['bulk_import:users'],
  'POST /api/bulk-import/teams': ['bulk_import:teams'],

  // --- /api/signup-codes (server/routes/signupCodes.js) ---
  // Sign-up code management routes for team admins and global managers.
  'POST /api/signup-codes/generate': ['signup_code:manage'],
  'GET /api/signup-codes/:teamId': ['signup_code:read'],
  'DELETE /api/signup-codes/:teamId': ['signup_code:manage'],
  'GET /api/signup-codes/:teamId/qr': ['signup_code:read'],
  'GET /api/signup-codes/:teamId/pdf': ['signup_code:read'],

  // --- /api/orgs (server/routes/orgDomains.js) ---
  // Org domain management routes for org admins and global managers.
  'GET /api/orgs/:orgId/domains': ['org:domains:read'],
  'PUT /api/orgs/:orgId/domains': ['org:domains:manage'],

  // --- /api/admin (server/routes/orgDomains.js) ---
  // Global admin routes for excluded domains and org interest management.
  'GET /api/admin/excluded-domains': ['admin:excluded_domains:manage'],
  'PUT /api/admin/excluded-domains': ['admin:excluded_domains:manage'],
  'GET /api/admin/org-interest': ['admin:org_interest:read'],
  'PATCH /api/admin/org-interest/:id': ['admin:org_interest:manage']
};

// Role-based default permission sets.
const roleDefaults = {
  // Global_Manager holds every permission identifier defined in the
  // registry (Requirement 24.2). The wildcard is treated by `resolveAccess`
  // (and, later, `authorize.js`) as satisfying any required permission
  // identifier.
  global_manager: ['*'],

  // Minimal permission set for a standard authenticated (non-admin) user,
  // covering the non-administrative routes they need day to day. Every
  // identifier below corresponds to a route above that is intentionally
  // reachable by any authenticated user (no admin/global-manager check in
  // the current inline implementation), so the registry stays internally
  // consistent with the routes it describes.
  authenticated_user: [
    'user:read:own',
    'user:read',
    'team:read:own',
    'channel:read',
    'channel:subscribe:deployment',
    'global_channel:read',
    'request:read',
    'channel_request:read',
    'mou:sign',
    'mou:read',
    'communication:broadcast:send',
    'device:manage',
    'bulk_import:users',
    'config:read:mappings'
  ]
};

/**
 * Pure resolver implementing the Permission_Registry's deny-by-default
 * access decision (Requirements 24.3, 24.4).
 *
 * Given a route key (e.g. `"GET /api/teams/:teamId"`), the set of permission
 * identifiers the requesting user holds, and a registry shaped like
 * `{ routes, roleDefaults }`, returns `true` only if:
 *   - the registry has an entry for `routeKey`, AND
 *   - every permission identifier required by that entry is present in
 *     `userPermissions` (a wildcard `'*'` entry in `userPermissions`
 *     satisfies any/every required identifier, matching
 *     `roleDefaults.global_manager`).
 *
 * If `registry.routes[routeKey]` does not exist, this returns `false`
 * (deny-by-default, Requirement 24.4) regardless of `userPermissions`.
 *
 * This function performs no I/O and never throws for the "no entry" case;
 * a missing registry entry is a normal deny, not an error. Computing
 * `userPermissions` for a given request (role defaults plus row-scoped
 * grants) is the responsibility of the caller (the future
 * Authorization_Middleware, `server/middleware/authorize.js`).
 *
 * @param {string} routeKey - `${HTTP_METHOD} ${routePath}`, e.g. `"GET /api/teams/:teamId"`.
 * @param {Iterable<string>} userPermissions - Permission identifiers the user holds (array or Set).
 * @param {{routes: Record<string, string[]>, roleDefaults: Record<string, string[]>}} registry
 * @returns {boolean} `true` if access is permitted, `false` otherwise.
 */
function resolveAccess(routeKey, userPermissions, registry) {
  const requiredPermissions = registry && registry.routes ? registry.routes[routeKey] : undefined;

  // Deny-by-default: no registry entry for this route+method (Req 24.4).
  if (!requiredPermissions) {
    return false;
  }

  const heldPermissions = userPermissions instanceof Set ? userPermissions : new Set(userPermissions || []);

  // A wildcard permission (e.g. from `roleDefaults.global_manager`)
  // satisfies every required identifier.
  if (heldPermissions.has('*')) {
    return true;
  }

  // Permit only if every required identifier is held.
  return requiredPermissions.every((permission) => heldPermissions.has(permission));
}

module.exports = {
  routes,
  roleDefaults,
  resolveAccess
};
