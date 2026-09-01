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
  // Response/Support channel-tier access flags (region-channel-tiers):
  // Organisation-only, Global_Manager-only, no Team_Admin fallback --
  // mirrors 'team:delete:global' exactly, deliberately NOT 'team:update'.
  // A Team_Admin of an Organisation may edit that Organisation's name/
  // description/etc via 'team:update', but never these two flags: they
  // govern which Authentik region-channel groups an entire Organisation's
  // membership is synced into, a decision reserved for a Global_Manager.
  'PUT /api/teams/:teamId/channel-access': ['team:channel_access:manage'],

  // --- /api/users (server/routes/users.js) ---
  // The three user-directory LISTING routes (`GET /api/users`,
  // `GET /api/users/search`, `GET /api/users/available`) require
  // 'user:read:team_admin': a Global_Manager, or a Team_Admin of ANY team.
  // They previously required a plain 'user:read' that also sat in
  // `roleDefaults.authenticated_user`, which let every authenticated user
  // -- including a plain non-admin team member -- enumerate the whole user
  // directory (names, emails) and the full pool of unassigned users, even
  // though all three routes only back admin-only UI
  // (client/src/pages/Users.jsx, client/src/pages/Admin.jsx, and the Add
  // Member dialog in client/src/pages/TeamDetail.jsx).
  //
  // These are LISTING routes with no target row, so the resolver
  // (server/middleware/authorize.js) checks "administers something", not
  // "administers this" -- see that resolver's own comment. Scoping the
  // CONTENTS of the response by organisation (so a Team_Admin sees only
  // their org's users rather than the whole directory) is a SEPARATE,
  // still-open concern, not addressed by this entry: it needs org
  // provenance on `users`, which does not exist yet.
  //
  // Deliberately NOT added to `roleDefaults.authenticated_user` below, for
  // the same reason as the transfer and callsign-suffix-preview routes: a
  // statically-held identifier satisfies `resolveAccess` outright, so
  // `authorize.js` would never consult the resolver at all and the gate
  // would be bypassed.
  'GET /api/users': ['user:read:team_admin'],
  'GET /api/users/me': ['user:read:own'],
  'POST /api/users': ['user:create:team_admin'],
  'POST /api/users/:userId/resend-welcome': ['user:resend_welcome:team_admin'],
  'GET /api/users/search': ['user:read:team_admin'],
  'GET /api/users/available': ['user:read:team_admin'],
  // The next three entries ('user:create' twice, then 'user:team:add') are
  // resolver-gated: the shared `resolveTeamAdminOfBodyTeamId` resolver in
  // server/middleware/authorize.js permits a Global_Manager OR a Team_Admin
  // (per `Team.isAdmin`, so an admin anywhere in the Ancestor_Chain
  // qualifies) of the `teamId` in the REQUEST BODY. Both identifiers
  // previously had these registry entries but no resolver and no place in
  // `roleDefaults.authenticated_user`, so nothing but a Global_Manager's
  // '*' wildcard could satisfy them and every Team_Admin was denied 403 --
  // visibly, the Add Member dialog's Callsign Suffix field never filled in
  // because the preview 403'd, and "Add Existing User" failed outright.
  //
  // Deliberately still NOT in `roleDefaults.authenticated_user`: a
  // statically-held identifier satisfies `resolveAccess` outright, so
  // `authorize.js` would never consult the resolver and the team-scoped
  // gate would be bypassed entirely.
  'POST /api/users/create-and-add': ['user:create'],
  // Read-only callsign_suffix preview for the create-and-add flow. Shares
  // the SAME 'user:create' identifier as the create route above, on
  // purpose: a successful preview discloses whether someone on the target
  // team already holds a given callsign_suffix, so it must not be reachable
  // any more broadly than the create action it previews -- it is reachable
  // by exactly the admins who can perform the create it previews.
  'POST /api/users/callsign-suffix-preview': ['user:create'],
  // Adding an EXISTING user to a team: same authorization boundary as
  // creating one in it, so it shares the resolver described above.
  'POST /api/users/add-to-team': ['user:team:add'],
  // INTENTIONALLY still Global_Manager-only: 'user:team:remove' has the
  // same missing-resolver shape as the two identifiers above (no resolver,
  // not in roleDefaults, so only the '*' wildcard satisfies it) but this
  // route DELETES the Authentik user along with the local `users` /
  // `user_cache` rows outright. Widening who may destroy an account is a
  // separate decision that has not been made, so no resolver is added
  // here. The registry-completeness test in permissions.registry.test.js
  // carries this identifier in an explicit, named exception list so the
  // gap stays documented rather than hidden.
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

  // account-lifecycle-management Requirement 1 Criteria 1, 6: suspend and
  // unsuspend an account (human or Team_Owned_Device). One identifier
  // covers both actions -- mirroring `device:manage`'s single identifier
  // for create/edit/delete -- since they are the same authorization
  // question ("is this caller an admin of this account's team") asked
  // twice, not two different capabilities. The `user:suspend` row-scoped
  // resolver (server/middleware/authorize.js) permits a Global_Manager, or
  // an admin (per `Team.isAdmin`) of the target account's Direct_Membership
  // team. Deliberately NOT added to `roleDefaults.authenticated_user`
  // below, for the same reason `user:team:transfer` immediately above is
  // not: a statically-held identifier would bypass the row-scoped resolver
  // entirely and let every authenticated user suspend/unsuspend any
  // account.
  'POST /api/users/:userId/suspend': ['user:suspend'],
  'POST /api/users/:userId/unsuspend': ['user:suspend'],

  // --- /api/channels (server/routes/channels.js) ---
  'GET /api/channels/descriptions': ['channel:read'],
  'POST /api/channels/custom': ['channel:create:custom'],
  'GET /api/channels/team/:teamId': ['channel:read'],

  // Bugfix (Channels tab had no delete-channel or manage-members
  // action): 'channel:manage' is a row-scoped identifier -- Global_Manager,
  // OR a Team_Admin (per Team.isAdmin, so an admin of any ancestor also
  // qualifies) of the :channelId route param's OWNING team, resolved via
  // its `channels.team_id` column. NOT in `roleDefaults.authenticated_user`
  // (a statically-held identifier would satisfy `resolveAccess` outright
  // and bypass the row-scoped resolver entirely, matching every other
  // Team_Admin-scoped identifier's own comment in this file). The
  // members-list GET reuses the existing 'channel:read' identifier
  // instead, since it is read-only and 'channel:read' already sits in
  // `roleDefaults.authenticated_user`.
  'GET /api/channels/:channelId/members': ['channel:read'],
  'POST /api/channels/:channelId/members': ['channel:manage'],
  'DELETE /api/channels/:channelId/members/:userId': ['channel:manage'],
  // Bugfix (Channels tab has no edit action, and no way to add/edit a
  // custom channel's Authentik/LDAP description): reuses 'channel:manage'
  // unchanged -- editing a channel's description is the same
  // authorization boundary as deleting it or managing its members, all
  // resolved by the same row-scoped resolver keyed on :channelId.
  'PUT /api/channels/:channelId': ['channel:manage'],
  'DELETE /api/channels/:channelId': ['channel:manage'],

  // --- /api/requests (server/routes/requests.js) ---
  // `POST /api/requests/team-access` runs without `authenticateToken`
  // (public) and is tracked in publicRoutes.js instead, not here.
  'GET /api/requests/pending': ['request:read'],
  'POST /api/requests/:requestId/approve': ['request:approve'],
  'POST /api/requests/:requestId/deny': ['request:deny'],

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
  // region-channel-tiers: seeds the standard Response/Support region
  // channel set, reusing 'global_channel:manage' -- the same permission
  // every other channel-management action here already requires.
  'POST /api/global-channels/seed-regions': ['global_channel:manage'],
  // region-channel-tiers (bugfix): read-only status check backing the
  // client's "hide Seed button once complete" UI -- gated the same as
  // the seed action itself, since it's management-surface status.
  'GET /api/global-channels/region/seed-status': ['global_channel:manage'],
  // Requirement 4.4 / 24.5: the channel-deletion route, Global_Manager-only.
  'DELETE /api/global-channels/:channelType/:channelId': ['global_channel:manage'],

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
  // admin-settings-management list endpoint: returns every email_templates
  // row so the Template_Editor has a single source of truth for the set of
  // template keys. Shares the `communication:template:read` identifier with
  // the `:key` read route below (same underlying data, read-only).
  'GET /api/communications/templates': ['communication:template:read'],
  'GET /api/communications/templates/:key': ['communication:template:read'],
  'PUT /api/communications/templates/:key': ['communication:template:manage'],
  // Requirement 30.5: Global_Manager-only "send test email" endpoint,
  // calling `EmailService.sendEmail` directly against an admin-specified
  // address, independent of any `access_requests` row or broadcast
  // trigger (task 52.3).
  'POST /api/communications/test-email': ['communication:test_email:send'],

  // --- /api/settings (server/routes/settings.js) ---
  // Requirement 32.2: Global_Manager-only branding (site_config-backed)
  // GET/PUT surface (task 54.2). The TAK color/role mapping GET/PUT pair
  // that used to sit here was removed: these
  // deployments source TAK_COLOR_*/TAK_ROLE_* from a deploy-time env
  // file, so an in-app-editable database override was a second,
  // competing source of truth. See `server/routes/config.js`'s
  // `GET /api/config/color-mappings` for the (env-only, read-only)
  // replacement every page now reads.
  'GET /api/settings/branding': ['settings:manage'],
  'PUT /api/settings/branding': ['settings:manage'],
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
  // branding GET/PUT routes above rather than a dedicated
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
  // `roleDefaults.authenticated_user` below. This is
  // intentional: `DeviceEnrollmentService.assertAuthorized` already
  // performs the REAL team-scoped check (`Team.isAdmin(teamId,
  // actingUser) OR actingUser.is_global_manager`, Requirement 27
  // Criterion 3) internally on every call, so gating this Global_Manager
  // -only here would incorrectly block a team admin who is not a
  // Global_Manager from creating/enrolling devices for their own team.
  'POST /api/devices': ['device:manage'],
  'POST /api/devices/:deviceUserId/qr-code': ['device:manage'],
  // Bugfix ("unable to edit ... a team device"): device edit/delete
  // routes. Share `device:manage` with the create route above -- the
  // SAME `DeviceEnrollmentService.assertAuthorized` team-scoped check
  // (Team.isAdmin OR is_global_manager) gates all three internally, so
  // an admin who may create devices for a team may also edit or delete
  // them.
  'PATCH /api/devices/:deviceUserId': ['device:manage'],
  'DELETE /api/devices/:deviceUserId': ['device:manage'],
  // Client UX correction: the preview counterpart of the QR-code route
  // above, resolving the same subject with the same authorization rule
  // (DeviceEnrollmentService.assertAuthorized, internally) but minting no
  // token -- so it shares that route's permission identifier rather than
  // introducing a new one for what is authorization-identical.
  'GET /api/devices/:deviceUserId/preview': ['device:manage'],
  // takserver-enrollment Criteria 3.5, 3.7, 3.11 (task 8.4): team-device
  // LISTING route (`DeviceEnrollmentService.listTeamDevices`), a
  // DIFFERENT surface from the two routes above (which create/enroll a
  // device). Subject comes from the `:teamId` URL parameter, not from
  // `req.user` alone -- exactly the shape `user:team:transfer` and the
  // `device_mgmt:*:managed` pair above already document: a
  // statically-held identifier would satisfy `resolveAccess` outright,
  // so `authorize.js` would never consult a row-scoped resolver, and
  // every authenticated user could enumerate every team's devices.
  // `device:read:team_admin` is therefore deliberately NOT in
  // `roleDefaults.authenticated_user` below (see that list's comment).
  // Its resolver ("Global_Manager OR `Team.isAdmin(:teamId, ...)`") is
  // added in a later task; until then this identifier is satisfiable
  // only via `roleDefaults.global_manager`'s wildcard, which is expected
  // for this task's scope.
  'GET /api/devices/team/:teamId': ['device:read:team_admin'],
  // Org-wide Team_Owned_Device listing backing the `/devices` page
  // (mirrors `GET /api/users`' own 'user:read:team_admin' shape exactly).
  // `device:read:org` is resolver-gated in server/middleware/authorize.js:
  // Global_Manager, or a Team_Admin of ANY team (a listing route has no
  // `:teamId`/`:userId` subject, so the resolver checks "administers
  // something", not "administers this" -- see that resolver's own
  // comment). Deliberately NOT in `roleDefaults.authenticated_user`: a
  // statically-held identifier would satisfy `resolveAccess` outright and
  // let every authenticated user enumerate every Team_Owned_Device.
  // Per-row visibility narrowing (which devices actually appear) is a
  // SEPARATE concern, handled inside `DeviceEnrollmentService
  // .listAllDevices` via `DirectoryScopeService`, not by this identifier.
  'GET /api/devices': ['device:read:org'],

  // --- /api/enrollment (server/routes/enrollment.js) ---
  // takserver-enrollment Criteria 3.4, 3.5 (task 8.4): self-service
  // enrollment of the CALLER'S OWN account. The route carries no route
  // parameters, no body schema and no query schema --
  // `DeviceEnrollmentService.generateSelfEnrollment` takes only
  // `req.user` as its argument -- so the subject is `req.user.userId`
  // alone and no request input can widen it. `enrollment:self` is a NEW
  // identifier rather than a reuse of `device:manage`: `device:manage`
  // means "may create and enroll team-owned devices", and reusing it
  // would make the two capabilities inseparable, so an operator could
  // not grant a member the ability to enroll their own phone without
  // also granting them the ability to create device accounts on their
  // team (Criterion 3.5). It is placed in `roleDefaults.authenticated_user`
  // below as a static grant for the same reason `device_mgmt:read:own`
  // already is (see that identifier's comment above): with a
  // caller-fixed subject there is no row for a resolver to scope and
  // nothing a static grant could give away.
  'POST /api/enrollment/me': ['enrollment:self'],
  // Client UX correction: the preview counterpart of the self-enrollment
  // route above, same subject (req.user alone) and same static grant --
  // it resolves the "Enrollment Data" section without minting a token.
  'GET /api/enrollment/me/preview': ['enrollment:self'],

  // --- /api/device-management (server/routes/deviceManagement.js) ---
  // device-management Requirements 6.2, 6.6, 6.7, 8.5, 8.6, 9.3, 9.4. A
  // DIFFERENT feature from `/api/devices` above (which enrolls
  // team-owned devices via `DeviceEnrollmentService`): these four routes
  // surface a user's TAK Server client certificates ("Devices") and
  // revoke them. Hence the distinct path prefix and the distinct
  // `device_mgmt:*` identifiers -- `device:manage` above is left
  // untouched.
  //
  // The `:own` pair sits in `roleDefaults.authenticated_user` below: any
  // signed-in user may act on their OWN Devices, and the row that scopes
  // the action is the caller's own `req.user.userId`, which no request
  // input can widen -- `DeviceManagementService.listOwnDevices` takes the
  // caller's id as the sole query parameter, and the self-revoke route
  // calls `assertCanRevokeOwn(req.user.userId, :clientUid)` before it
  // enqueues anything. `device_mgmt:revoke:own` is therefore a static
  // grant even though the design describes it as row-scoped: the row
  // check (does THIS Device belong to the caller) is an assertion the
  // route/service performs and reports as a denial, not a question the
  // authorize layer can answer without duplicating the same lookup.
  //
  // The `:managed` pair is deliberately NOT in
  // `roleDefaults.authenticated_user` -- exactly as
  // `user:team:transfer` above is not. A statically-held identifier
  // satisfies `resolveAccess` outright, so `authorize.js` would never
  // consult the row-scoped resolver and every authenticated user could
  // read (and revoke) any user's Devices. Both are granted per-request by
  // the `device_mgmt:read:managed` / `device_mgmt:revoke:managed`
  // resolvers in server/middleware/authorize.js, which permit a
  // Global_Manager, or an admin for whom the target `:userId` is a
  // Managed_User (and, for revoke, whose `:clientUid` Device belongs to
  // that target).
  'GET /api/device-management/me/devices': ['device_mgmt:read:own'],
  'GET /api/device-management/users/:userId/devices': ['device_mgmt:read:managed'],
  'POST /api/device-management/me/devices/:clientUid/revoke': ['device_mgmt:revoke:own'],
  'POST /api/device-management/users/:userId/devices/:clientUid/revoke': ['device_mgmt:revoke:managed'],

  // --- /api/bulk-import (server/routes/bulkImport.js) ---
  // Requirement 29 (CSV Bulk Import for Users and Teams, task 51.4).
  // `POST /users`: `BulkImportService.importUsers` (task 51.1) already
  // performs its own per-row authorization internally (`Team.isAdmin(row
  // .teamId, importingUser) OR importingUser.is_global_manager`) -- a
  // failing row is recorded in the results array, the batch continues
  // (Requirement 29.4). `bulk_import:users` is therefore placed in BOTH
  // `roleDefaults.global_manager` (via its wildcard) AND
  // `roleDefaults.authenticated_user` below: any authenticated user,
  // including a team admin, can reach this route -- the service's
  // per-row check is the real access control.
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
  // The read-only preview step shares its commit
  // counterpart's identifier -- previewing is strictly less privileged
  // than importing, so gating it any tighter would deny a preview to an
  // operator who is authorized to actually import.
  'POST /api/bulk-import/users/preview': ['bulk_import:users'],
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
    // 'user:read:own' stays: `GET /api/auth/me` and `GET /api/users/me`
    // must keep working for every authenticated user. The plain
    // 'user:read' that used to sit here was REMOVED -- it gated the three
    // user-directory listing routes above, which are now
    // 'user:read:team_admin' and resolver-gated (see those entries).
    'user:read:own',
    'team:read:own',
    'channel:read',
    'global_channel:read',
    'request:read',
    'device:manage',
    'bulk_import:users',
    'config:read:mappings',
    // device-management Requirements 5.1, 7.1: the two SELF-scoped
    // device-management identifiers. Their only subject is the caller's
    // own `req.user.userId`, so a static grant here cannot widen what a
    // caller reaches (see the `/api/device-management` route comments
    // above). The `:managed` counterparts are intentionally absent so
    // their row-scoped resolvers are always consulted.
    'device_mgmt:read:own',
    'device_mgmt:revoke:own',
    // takserver-enrollment Criterion 3.5 (task 8.4): self-service
    // enrollment of the caller's OWN account, per
    // `POST /api/enrollment/me` above. Its subject is `req.user.userId`
    // alone -- `DeviceEnrollmentService.generateSelfEnrollment` takes no
    // other parameter -- so there is no row for a resolver to scope and
    // nothing a static grant could give away, the SAME reasoning already
    // recorded above for `device_mgmt:read:own`. A NEW identifier rather
    // than a reuse of `device:manage`: that identifier means "may create
    // and enroll team-owned devices", and reusing it would make the two
    // capabilities inseparable, so an operator could not grant a member
    // the ability to enroll their own phone without also granting them
    // the ability to create device accounts on their team.
    'enrollment:self'
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
