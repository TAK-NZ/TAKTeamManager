/**
 * Authorization_Middleware
 *
 * Runs after `authenticateToken` (server/middleware/auth.js) has populated
 * `req.user`. Looks up the current request's route path + HTTP method in the
 * Permission_Registry (server/config/permissions.registry.js) and permits
 * the request only if the requesting user holds every permission
 * identifier required for that route entry.
 *
 * Deny-by-default (Requirement 24.4): if the route path + method combination
 * has no corresponding Permission_Registry entry, the request is rejected
 * with 403 and `next()` is never called, regardless of the requesting
 * user's role.
 *
 * Task 11.1 wired up base role-default permission resolution
 * (`roleDefaults.global_manager` for Global_Manager users,
 * `roleDefaults.authenticated_user` for everyone else). Task 11.2 added
 * row-scoped resolver functions for permissions like `team:update` (e.g.
 * "admin of this team OR global manager") that are not satisfiable from a
 * static role-default permission set alone. Task 11.3 (this revision) adds
 * fail-closed exception handling around resolver failures: any resolver
 * that throws is caught once, centrally, inside
 * `isSatisfiedWithRowScopedChecks`'s loop (rather than duplicated inside
 * every individual resolver), logged via `getLogger()` with
 * `{actorId, resourceId, errorCategory: 'authorization_check_exception',
 * permission, err}`, and treated as "resolver returned false" so the
 * request is denied rather than the exception propagating out of
 * `authorize()`. Task 12.3 mounted this middleware immediately after
 * `authenticateToken` on every authenticated route across the route files
 * (`teams.js`, `users.js`, `globalChannels.js`, `channels.js`,
 * `requests.js`, `config.js`, `sync.js`, `operations.js`, and `auth.js`'s
 * `/me` route) — not as a single `app.use()` call in `server/index.js`,
 * because `req.route` is only populated by Express once a request has
 * matched a specific route handler, not at router-mount time (verified
 * empirically: `req.route` is `undefined` in router-level middleware, but
 * defined inside a matched route's own middleware chain).
 *
 * See design.md "Authorization Architecture" and requirements.md
 * Requirement 24 Criteria 24.3-24.4, and Requirement 4 Criteria 4.1, 4.5,
 * 4.3, 4.6.
 */

const { routes, roleDefaults, resolveAccess } = require('../config/permissions.registry');
const Team = require('../models/Team');
const User = require('../models/User');
const pool = require('../config/database');
const { getLogger } = require('./requestContext');
const TeamVisibilityService = require('../services/TeamVisibilityService');
// device-management task 12.1: the `device_mgmt:*:managed` resolvers below
// delegate their Managed_User and Device-ownership checks here so those
// rules have ONE definition shared with the routes (task 13.1).
const DeviceManagementService = require('../services/DeviceManagementService');

/**
 * Requirement 13.7: "IF a request to the App fails authorization (403) or
 * authentication (401), THEN THE App SHALL log that failure with the
 * requesting IP address, the requested route, and the reason for the
 * failure, to support security monitoring."
 *
 * This is purely additive logging on the two existing 403 branches in
 * `authorize()` below (deny-by-default when no registry entry exists, and
 * permission-denied when one exists but isn't satisfied) -- no
 * authorization logic, response body, or status code changes. `warn`
 * matches the level already used by `server/middleware/auth.js`'s
 * equivalent Requirement 13.7 logging for 401 responses.
 */
function logAuthzFailure(req, reason) {
  getLogger().warn(
    {
      ip: req.ip || (req.socket && req.socket.remoteAddress),
      route: req.originalUrl || getRouteKey(req),
      reason
    },
    'Authorization denied'
  );
}

/**
 * Shared row-scoped resolver backing BOTH `request:approve` and
 * `request:deny` (Requirement 5, team-member-transfer). Both identifiers
 * already have Permission_Registry entries
 * (`POST /api/requests/:requestId/approve` and `.../deny`) but neither is
 * in `roleDefaults.authenticated_user` and neither had a resolver, so
 * every non-Global_Manager acting on a pending request was denied — the
 * Requests page could list rows it could not act on. Adding the
 * identifiers to `roleDefaults` would grant a blanket approve permission
 * to every authenticated user; a resolver keeps Global_Manager access
 * flowing through the `'*'` wildcard and Team_Admin access flowing
 * through this per-request, row-level check.
 *
 * Modelled directly on `channel_request:process` below: load the row named
 * by `:requestId`, pick the team column that gates it, delegate to
 * `Team.isAdmin` (which walks the Ancestor_Chain, so a Team_Admin above
 * the gating Team also qualifies). The only addition is that the gating
 * column depends on `request_type`:
 *
 *   - `team_change`  -> `approval_team_id` (Req 5.2) — the side of the
 *                       transfer the initiator does NOT administer
 *   - `new_account`  -> `target_team_id`   (Req 5.3)
 *   - `role_change`  -> `current_team_id`  (Req 5.4)
 *   - `name_change`  -> `current_team_id`  (Req 5.4)
 *
 * Both approve and deny share one implementation because Requirement 5
 * states one rule for both: whoever may approve a request may also deny
 * it.
 *
 * Denials (zero rows for `:requestId` per Req 5.5, an unrecognised
 * `request_type`, or a `NULL` gating column — e.g. a legacy `team_change`
 * row predating the `approval_team_id` migration) all return `false` and
 * so respond with `authorize()`'s standard 403: `request:approve` and
 * `request:deny` are deliberately NOT added to
 * `PERMISSION_DENIALS_MAPPED_TO_404`, which stays reserved for
 * `'team:read'` (Req 5.6).
 *
 * Uses the module-scope `pool` import. Per this module's contract a throw
 * propagates to `isSatisfiedWithRowScopedChecks`, which logs it and fails
 * closed, so there is deliberately no local try/catch.
 *
 * @param {import('express').Request} req
 * @returns {Promise<boolean>}
 */
async function resolveRequestActionPermission(req) {
  if (req.user && req.user.is_global_manager) {
    return true;
  }

  const result = await pool.query(
    'SELECT request_type, approval_team_id, target_team_id, current_team_id FROM access_requests WHERE id = $1',
    [req.params && req.params.requestId]
  );

  if (result.rows.length === 0) {
    return false;
  }

  const row = result.rows[0];
  let gatingTeamId;
  switch (row.request_type) {
    case 'team_change':
      gatingTeamId = row.approval_team_id;
      break;
    case 'new_account':
      gatingTeamId = row.target_team_id;
      break;
    case 'role_change':
    case 'name_change':
      gatingTeamId = row.current_team_id;
      break;
    default:
      gatingTeamId = null;
  }

  if (gatingTeamId === null || gatingTeamId === undefined) {
    return false;
  }

  // LOCAL users.id, never req.user.id (the Authentik id).
  return Team.isAdmin(gatingTeamId, req.user && req.user.userId);
}

/**
 * Shared row-scoped resolver backing THREE identifiers, all of which ask
 * the identical question — "is the requester a Global_Manager, or a
 * Team_Admin of the `teamId` named in the request body?":
 *
 *   - `user:create:team_admin` — `POST /api/users` (the older create-user
 *     route). This was the original home of the logic.
 *   - `user:create`            — `POST /api/users/create-and-add` AND
 *     `POST /api/users/callsign-suffix-preview`.
 *   - `user:team:add`          — `POST /api/users/add-to-team`. Adding an
 *     EXISTING user to a team is the same authorization boundary as
 *     creating one in it, so it shares this implementation rather than
 *     getting a near-identical copy.
 *
 * `user:create` and `user:team:add` both had Permission_Registry entries
 * but NO resolver and no place in `roleDefaults.authenticated_user`, so
 * nothing except a Global_Manager's `'*'` wildcard could satisfy them:
 * every Team_Admin was denied 403 on all three routes. The user-visible
 * symptom was the Add Member dialog's Callsign Suffix field staying empty
 * (showing only its placeholder) because the preview request 403'd, and
 * "Add Existing User" failing outright.
 *
 * `POST /api/users/callsign-suffix-preview` deliberately INHERITS the
 * `user:create` gate rather than getting a looser identifier of its own: a
 * successful preview discloses whether someone on the target team already
 * holds a given callsign_suffix, so it must be reachable by exactly the
 * admins who can perform the create it previews. That was the original
 * intent recorded in `permissions.registry.js`, and it was silently broken
 * by the missing resolver — the gate was not "too tight", it was
 * unsatisfiable.
 *
 * NOT covered here on purpose: `user:team:remove`
 * (`DELETE /api/users/remove-from-team/:userId`) has the same
 * missing-resolver shape, but that route deletes the Authentik user along
 * with the local `users`/`user_cache` rows outright. Widening who may
 * destroy an account is a separate decision that has not been made, so
 * that identifier is intentionally left resolver-less and therefore
 * Global_Manager-only. See the matching note in
 * `permissions.registry.js`, and the named exception list in
 * `server/config/permissions.registry.test.js`'s registry-completeness
 * test, which documents the gap rather than hiding it.
 *
 * Returns `false` when the body carries no `teamId` — there is no team to
 * scope against, so there is nothing a Team_Admin could be an admin OF.
 * Per this module's contract a throw propagates to
 * `isSatisfiedWithRowScopedChecks`, which logs it and fails closed, so
 * there is deliberately no local try/catch.
 *
 * @param {import('express').Request} req
 * @returns {Promise<boolean>}
 */
async function resolveTeamAdminOfBodyTeamId(req) {
  if (req.user && req.user.is_global_manager) {
    return true;
  }
  const teamId = req.body && req.body.teamId;
  if (!teamId) {
    return false;
  }
  // LOCAL users.id, never req.user.id (the Authentik id): `Team.isAdmin`
  // compares against `team_memberships.user_id`. The inline check this
  // logic replaced got that wrong.
  return Team.isAdmin(teamId, req.user && req.user.userId);
}

/**
 * Row-scoped permission resolver functions.
 *
 * `resolveAccess` (server/config/permissions.registry.js) only checks
 * whether a static permission identifier is present in the user's base
 * permission set (role defaults). Some registry permission identifiers
 * additionally need to be satisfied by a per-request, row-level check —
 * e.g. "is the requesting user an admin of THIS SPECIFIC team" — which
 * `resolveAccess` cannot express because it only sees a Set of held
 * identifiers, not `req`.
 *
 * Each resolver here takes the Express `req` (to read `req.params`,
 * `req.body`, `req.user`) and returns a Promise<boolean>. A resolver may
 * throw (e.g. if `Team.isAdmin`'s underlying query fails); task 11.3 wraps
 * resolver invocation in a try/catch to fail closed on that case, so
 * resolvers here are written to let such errors propagate naturally
 * rather than swallowing them.
 *
 * IMPORTANT: `Team.isAdmin(teamId, userId)` compares `userId` against
 * `team_memberships.user_id`, which is a foreign key to the *local*
 * `users.id` — NOT the Authentik id. Per `server/middleware/auth.js`,
 * `req.user.userId` holds the local `users.id` while `req.user.id` holds
 * the Authentik id. Every resolver below MUST pass `req.user.userId` to
 * `Team.isAdmin`, never `req.user.id`.
 */
const rowScopedResolvers = {
  /**
   * `team:update` — satisfied if the requesting user is a Global_Manager
   * OR is an admin (per `Team.isAdmin`) of the specific team named by the
   * `:teamId` route param.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  /**
   * Bugfix (re-parent authorization gap): `team:update` used to check
   * ONLY the team being edited (`:teamId`, the source side of a
   * re-parent) and never the DESTINATION named by a supplied
   * `parentTeamId`. That let a Team_Admin — admin of `:teamId` or one of
   * its ancestors, per `Team.isAdmin`'s upward walk — move their own team
   * (and therefore its whole subtree) underneath ANY other team in the
   * system, including one they hold no admin relationship to whatsoever,
   * merely by naming its id in the request body. `POST /api/teams`
   * (`team:create:root_or_sub` below) already requires admin rights on
   * the destination for a NEW sub-team; this closes the exact same gap
   * for an EXISTING team being MOVED.
   *
   * `parentTeamId` is present on EVERY edit submission from
   * `TeamFormDialog.jsx` -- it always sends the team's current parent id
   * (or `null` for a root team), never omits the key -- so this resolver
   * cannot treat "key present" as "re-parent requested"; it must compare
   * the submitted value against `:teamId`'s CURRENT stored
   * `parent_team_id` and only apply the extra check on an actual CHANGE.
   * An ordinary field edit that resubmits the unchanged parent is
   * therefore unaffected and costs exactly the one `Team.findById`
   * lookup this comparison needs.
   *
   * Three cases, once an admin of `:teamId` (or one of its ancestors) is
   * confirmed:
   *   - Submitted `parentTeamId` equals the CURRENT stored parent (by
   *     loose `==` so a numeric id and its string form from a route/body
   *     both match, and `null == undefined`): no re-parent is actually
   *     happening. Permitted -- this is the common "just editing a
   *     field" case.
   *   - Submitted `parentTeamId` is a DIFFERENT non-null value: a
   *     re-parent onto that destination. Permitted for a Global_Manager,
   *     or for a Team_Admin who ALSO administers the destination (or one
   *     of ITS ancestors) -- i.e. `Team.isAdmin` must return true for
   *     both sides.
   *   - Submitted `parentTeamId` is `null` while the CURRENT stored
   *     parent is non-null: explicitly DETACHING `:teamId` to become a
   *     new top-level Organisation. Structurally significant -- it mints
   *     a new Organisation root on nothing but the mover's say-so -- so
   *     restricted to a Global_Manager, mirroring
   *     `team:create:root_or_sub`'s own "root creation is
   *     Global_Manager-only" rule.
   *
   * `Team.update` itself performs no depth check on a re-parent
   * (`Team.create`'s `MAX_TEAM_DEPTH` guard is create-time only) --
   * tracked separately; this resolver is authorization only.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'team:update': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }

    const userId = req.user && req.user.userId;
    const isAdminOfTarget = await Team.isAdmin(req.params.teamId, userId);
    if (!isAdminOfTarget) {
      return false;
    }

    const hasParentTeamId = req.body && Object.prototype.hasOwnProperty.call(req.body, 'parentTeamId');
    if (!hasParentTeamId) {
      return true;
    }

    const submittedParentTeamId = req.body.parentTeamId;
    const currentTeam = await Team.findById(req.params.teamId);
    const currentParentTeamId = currentTeam ? currentTeam.parent_team_id : null;

    // Normalized comparison: a route/body id may arrive as a number or
    // as its string form, and a missing parent may arrive as `null` or
    // `undefined` -- both must compare equal to "no parent".
    const normalizedSubmitted = submittedParentTeamId === undefined ? null : submittedParentTeamId;
    const normalizedCurrent = currentParentTeamId === undefined ? null : currentParentTeamId;
    if (String(normalizedSubmitted) === String(normalizedCurrent)) {
      // Resubmission of the unchanged parent -- not a re-parent at all.
      return true;
    }

    if (submittedParentTeamId === null || submittedParentTeamId === undefined) {
      // Detaching to become a new top-level Organisation.
      return false;
    }

    return Team.isAdmin(submittedParentTeamId, userId);
  },

  /**
   * `team:members:add` — satisfied if the requesting user is a
   * Global_Manager OR is an admin (per `Team.isAdmin`) of the specific
   * team named by the `:teamId` route param. Adding a member to a team is
   * the same authorization boundary as updating that team, so this
   * mirrors `team:update` above exactly (BUG-015).
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'team:members:add': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }
    return Team.isAdmin(req.params.teamId, req.user && req.user.userId);
  },

  /**
   * `team:members:edit` — Requirements 4 and 13.10 (task 28.2): satisfied
   * if the requesting user is a Global_Manager OR is an admin (per
   * `Team.isAdmin`, which already walks the Ancestor_Chain per
   * Requirement 4's inherited admin status) of the specific team named by
   * the `:teamId` route param AND that team is a Visible_Branch for the
   * requesting user (per `TeamVisibilityService.isVisibleBranch`,
   * Requirement 13.10). Backs
   * `PATCH /api/teams/:teamId/members/:userId` (the Member_List
   * name/TAK_Role/callsign_suffix edit route, task 28.1).
   *
   * Unlike `team:members:add` above, this resolver ALSO consults
   * `TeamVisibilityService` even for a Team_Admin: a Team_Admin whose
   * administered team is itself hidden behind a private ancestor branch
   * they cannot see must still be denied (Requirement 13.10 layers the
   * Visible_Branch restriction on top of the existing admin-editing
   * boundary described in Requirement 13).
   *
   * A `false` result here is NOT added to
   * `PERMISSION_DENIALS_MAPPED_TO_404` — that mapping is reserved
   * specifically for `'team:read'` denials (Requirement 6.2/6.3); a denied
   * Member_List edit continues to respond with the standard 403.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'team:members:edit': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }
    const isTeamAdmin = await Team.isAdmin(req.params.teamId, req.user && req.user.userId);
    const isVisible = await TeamVisibilityService.isVisibleBranch(req.params.teamId, req.user);
    return isTeamAdmin && isVisible;
  },

  /**
   * `team:create:root_or_sub` — covers both `POST /api/teams` cases:
   *   - Top-level team creation (no `parentTeamId` in the body): permitted
   *     only for a Global_Manager (Requirement 4.5).
   *   - Sub-team creation (`parentTeamId` present in the body): permitted
   *     for a Global_Manager OR an admin of the named parent team
   *     (Requirement 4.1).
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'team:create:root_or_sub': async (req) => {
    if (req.user && req.user.is_global_manager) {
      // Covers both root-team creation and sub-team creation.
      return true;
    }

    const parentTeamId = req.body && req.body.parentTeamId;
    if (!parentTeamId) {
      // Non-global-manager attempting root-team creation: denied.
      return false;
    }

    return Team.isAdmin(parentTeamId, req.user && req.user.userId);
  },

  /**
   * `team:delete:global` — Global_Manager-only, no row-scoped fallback.
   * Matches the existing inline `if (!req.user.isAdmin)` check in
   * `teams.js`'s `DELETE /:teamId` route.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'team:delete:global': async (req) => {
    return Boolean(req.user && req.user.is_global_manager);
  },

  /**
   * `team:channel_access:manage` — Global_Manager-only, no row-scoped
   * fallback. Mirrors `team:delete:global` exactly, deliberately NOT
   * `team:update`'s `Team.isAdmin` fallback: a Team_Admin of an
   * Organisation may edit that Organisation's ordinary fields via
   * `team:update`, but response_channel_access/support_channel_access
   * govern which Authentik region-channel groups the whole
   * Organisation's membership is synced into, which is reserved for a
   * Global_Manager regardless of Team_Admin status.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'team:channel_access:manage': async (req) => {
    return Boolean(req.user && req.user.is_global_manager);
  },

  /**
   * `user:create:team_admin` — `POST /api/users` (the older create-user
   * route). Mirrors the inline check that used to live in `users.js`'s
   * `POST /`; that inline check incorrectly compared against
   * `req.user.id` (the Authentik id), while the shared implementation
   * correctly uses `req.user.userId` (the local `users.id` that
   * `team_memberships.user_id` references).
   *
   * `user:create` — `POST /api/users/create-and-add` and
   * `POST /api/users/callsign-suffix-preview`.
   *
   * `user:team:add` — `POST /api/users/add-to-team`.
   *
   * All three are the same rule (Global_Manager, or `Team.isAdmin` of
   * `req.body.teamId`) and therefore share the single
   * `resolveTeamAdminOfBodyTeamId` implementation defined above this
   * object — see its doc comment for why `user:create`/`user:team:add`
   * previously 403'd for every Team_Admin, why the preview inherits the
   * `user:create` gate, and why `user:team:remove` is deliberately still
   * resolver-less.
   */
  'user:create:team_admin': resolveTeamAdminOfBodyTeamId,
  'user:create': resolveTeamAdminOfBodyTeamId,
  'user:team:add': resolveTeamAdminOfBodyTeamId,

  /**
   * `user:resend_welcome:team_admin` — satisfied if the requesting user is a
   * Global_Manager OR is an admin (per `Team.isAdmin`) of at least one of
   * the target user's (`:userId` route param) current teams.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'user:resend_welcome:team_admin': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }

    const targetUserId = req.params && req.params.userId;
    const userTeams = await User.getTeamMemberships(targetUserId);

    for (const team of userTeams) {
      if (await Team.isAdmin(team.id, req.user && req.user.userId)) {
        return true;
      }
    }

    return false;
  },

  /**
   * `user:read:team_admin` — satisfied if the requesting user is a
   * Global_Manager OR holds at least one DIRECT admin membership, i.e. is
   * a Team_Admin of *some* team. Backs the three user-directory LISTING
   * routes (`GET /api/users`, `GET /api/users/search`,
   * `GET /api/users/available`), which previously required the plain
   * `user:read` identifier — and that identifier lived in
   * `roleDefaults.authenticated_user`, so EVERY authenticated user,
   * including a plain non-admin team member, could enumerate the user
   * directory (names, emails) and the full pool of unassigned users. All
   * three routes back admin-only UI (`client/src/pages/Users.jsx`,
   * `client/src/pages/Admin.jsx`, and the Add Member dialog in
   * `client/src/pages/TeamDetail.jsx`), so the disclosure bought nothing.
   *
   * WHY THIS ONE IS NOT ROW-SCOPED: unlike every other `:team_admin`
   * resolver in this object, there is no target row to scope against —
   * these are listing routes with no `:teamId`/`:userId` subject — so the
   * question answered here is "does this user administer SOMETHING",
   * not "does this user administer THIS". The per-row narrowing of WHICH
   * users appear in the response is deliberately NOT addressed here: it is
   * handled in the route handlers via `server/services/DirectoryScopeService.js`,
   * which resolves the caller's Scoped_Organisations from the same cached
   * `is_global_manager` attribute and the same `role = 'admin' AND
   * inherited_from_team_id IS NULL` condition this resolver uses, then scopes
   * the response by Organisation provenance and Email_Domain. This resolver
   * only closes the "any authenticated user at all" hole; DirectoryScopeService
   * closes the per-row hole.
   *
   * `role = 'admin' AND inherited_from_team_id IS NULL` is the glossary's
   * Team_Admin condition, matching `Team.isAdmin`'s own filter
   * (server/models/Team.js) and `BroadcastEmailService`'s
   * `getAdministeredTeamIds` — an INHERITED admin row never confers admin
   * status. Note the divergence from `server/routes/auth.js`'s `/auth/me`
   * team-admin flag, which uses the looser `role = 'admin'` with no
   * `inherited_from_team_id` filter: the stricter form is used here on
   * purpose (it is the authorization boundary, not a UI hint), and
   * `auth.js` is intentionally left unchanged.
   *
   * The query is issued through the module-scope `pool` import, the way
   * `user:team:transfer` and `channel_request:process` above do, because
   * neither existing helper fits: `Team.isAdmin` answers a per-team
   * question and needs a `teamId`, and `BroadcastEmailService`'s
   * `getAdministeredTeamIds` is module-private (not exported) as well as
   * doing more work than a `LIMIT 1` existence check needs. Per this
   * module's contract a throw propagates to
   * `isSatisfiedWithRowScopedChecks`, which logs it and fails closed, so
   * there is deliberately no local try/catch.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'user:read:team_admin': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }

    const result = await pool.query(
      `SELECT 1 FROM team_memberships
        WHERE user_id = $1 AND role = 'admin' AND inherited_from_team_id IS NULL
        LIMIT 1`,
      // LOCAL users.id, never req.user.id (the Authentik id).
      [req.user && req.user.userId]
    );

    return result.rows.length > 0;
  },

  /**
   * `user:team:transfer` — Requirement 2.2/2.3/2.6 (team-member-transfer):
   * satisfied if the requesting user is a Global_Manager, OR is an admin
   * (per `Team.isAdmin`, so a Team_Admin anywhere in either Team's
   * Ancestor_Chain counts — Req 2.6) of the Destination_Team named by
   * `req.body.targetTeamId`, OR is an admin of the Source_Team named by
   * the `:userId` route param's Direct_Membership.
   *
   * The destination leg is evaluated first because it needs no extra
   * query when it succeeds. Reading `req.body` here has precedent in
   * `channel_request:create` and `team:create:root_or_sub`;
   * `express.json()` runs before route middleware, so the body is
   * populated by the time this runs.
   *
   * A `:userId` naming no `users` row, or naming a user with no
   * Direct_Membership, yields no source-team leg at all — such a request
   * is authorized only via the destination leg or Global_Manager status,
   * and is otherwise denied. Note this resolver grants the *ability to
   * attempt* a transfer; whether the transfer executes immediately or
   * becomes a pending Transfer_Request is a separate Dual_Admin
   * determination made by the route handler (Req 2.4/2.5), and a
   * self-transfer is rejected there with 400 rather than here with 403
   * (Req 1.8).
   *
   * Per this module's contract, a throw propagates to
   * `isSatisfiedWithRowScopedChecks`, which logs it and fails closed — so
   * there is deliberately no local try/catch here.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'user:team:transfer': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }

    // LOCAL users.id, never req.user.id (the Authentik id).
    const actorId = req.user && req.user.userId;

    const targetTeamId = req.body && req.body.targetTeamId;
    if (targetTeamId && await Team.isAdmin(targetTeamId, actorId)) {
      return true;
    }

    const direct = await pool.query(
      'SELECT team_id FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL',
      [req.params && req.params.userId]
    );

    if (direct.rows.length === 0) {
      return false;
    }

    return Team.isAdmin(direct.rows[0].team_id, actorId);
  },

  /**
   * `request:approve` / `request:deny` — Requirement 5
   * (team-member-transfer). Both identifiers share the single
   * `resolveRequestActionPermission` implementation defined above this
   * object: Global_Manager, or a Team_Admin of the Team named by the
   * gating column that this `access_requests` row's `request_type`
   * selects.
   */
  'request:approve': resolveRequestActionPermission,
  'request:deny': resolveRequestActionPermission,

  /**
   * `channel_request:create` — satisfied if the requesting user is a
   * Global_Manager OR is an admin (per `Team.isAdmin`) of the team named
   * by `req.body.teamId`. Task 45.4 (Requirement 23): submitting a
   * channel request is restricted to a team's admin or a Global_Manager;
   * `ChannelRequestService.requestChannel` itself further branches
   * internally on Global_Manager status to decide immediate-vs-pending
   * creation (Req 23.2/23.3), but a caller who is neither must be denied
   * here before ever reaching that service.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'channel_request:create': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }
    const teamId = req.body && req.body.teamId;
    if (!teamId) {
      return false;
    }
    return Team.isAdmin(teamId, req.user && req.user.userId);
  },

  /**
   * `channel_request:process` — satisfied if the requesting user is a
   * Global_Manager OR is an admin (per `Team.isAdmin`) of the parent
   * team of the `:requestId` route param's `channel_requests.team_id`
   * (Req 23.4, reusing the exact sub-team-creation authorization shape
   * from Requirement 4.1). Covers both approve and deny, since both
   * routes share the same authorization rule per Req 23.4.
   *
   * A request id that does not resolve to an existing `channel_requests`
   * row (already processed, or never existed) is treated as denied here
   * rather than throwing -- the service-layer methods
   * (`approveChannelRequest`/`denyChannelRequest`) are the authoritative
   * source for the "already processed" 400 response (Req 23.8); this
   * resolver only needs to know whether this specific requester is
   * authorized to act on whichever team the row (if any) names.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'channel_request:process': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }

    const requestId = req.params && req.params.requestId;
    const result = await pool.query(
      'SELECT team_id FROM channel_requests WHERE id = $1',
      [requestId]
    );

    if (result.rows.length === 0) {
      return false;
    }

    return Team.isAdmin(result.rows[0].team_id, req.user && req.user.userId);
  },

  /**
   * `team:read` — Requirement 6 (Organisation-Scoped and
   * Private-Branch-Cascading Visibility): satisfied only if the `:teamId`
   * route param names a Team that is a Visible_Branch for the requesting
   * user, per `TeamVisibilityService.isVisibleBranch`. Backs
   * `GET /api/teams/:teamId`, `GET /api/teams/:teamId/hierarchy`,
   * `GET /api/teams/:teamId/sub-teams`, and
   * `GET /api/teams/:teamId/callsign-level-options` (task 8.3) — all four
   * routes inherit this row-scoped Visible_Branch check automatically via
   * this single resolver, with no change to those route files themselves.
   *
   * `TeamVisibilityService.isVisibleBranch` already returns `true`
   * unconditionally for a Global_Manager (Requirement 6.4), so this
   * resolver never needs its own `is_global_manager` short-circuit —
   * unlike the resolvers above, which check it explicitly to skip a
   * `Team.isAdmin` call entirely. Note also that `authorize()`'s own
   * `isSatisfiedWithRowScopedChecks` loop already short-circuits on
   * `heldPermissions.has('*')` before ever consulting ANY row-scoped
   * resolver, so a Global_Manager (who holds the wildcard via
   * `roleDefaults.global_manager`) never reaches this resolver in
   * practice either.
   *
   * A `false` result here is mapped to a 404 (never the generic 403) by
   * `authorize()` below, per Requirement 6.2/6.3's "respond as though
   * that Team does not exist" — see `PERMISSION_DENIALS_MAPPED_TO_404`.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'team:read': async (req) => TeamVisibilityService.isVisibleBranch(req.params.teamId, req.user),

  /**
   * `signup_code:manage` — satisfied if the requesting user is a
   * Global_Manager OR is an admin (per `Team.isAdmin`) of the team
   * identified by `:teamId` route param or `req.body.teamId`.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'signup_code:manage': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }
    const teamId = (req.params && req.params.teamId) || (req.body && req.body.teamId);
    if (!teamId) return false;
    return Team.isAdmin(teamId, req.user && req.user.userId);
  },

  /**
   * `signup_code:read` — satisfied if the requesting user is a
   * Global_Manager OR is an admin (per `Team.isAdmin`) of the team
   * identified by `:teamId` route param.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'signup_code:read': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }
    const teamId = req.params && req.params.teamId;
    if (!teamId) return false;
    return Team.isAdmin(teamId, req.user && req.user.userId);
  },

  /**
   * `org:domains:read` — satisfied if the requesting user is a
   * Global_Manager OR is an admin (per `Team.isAdmin`) of the org
   * identified by `:orgId` route param.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'org:domains:read': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }
    const orgId = req.params && req.params.orgId;
    if (!orgId) return false;
    return Team.isAdmin(orgId, req.user && req.user.userId);
  },

  /**
   * `org:domains:manage` — satisfied if the requesting user is a
   * Global_Manager OR is an admin (per `Team.isAdmin`) of the org
   * identified by `:orgId` route param.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'org:domains:manage': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }
    const orgId = req.params && req.params.orgId;
    if (!orgId) return false;
    return Team.isAdmin(orgId, req.user && req.user.userId);
  },

  /**
   * `device_mgmt:read:managed` — device-management Requirements 6.2, 6.6,
   * 6.7, 9.4: satisfied if the requesting user is a Global_Manager OR the
   * `:userId` route param names a Managed_User of the requesting admin.
   * Backs `GET /api/device-management/users/:userId/devices`.
   *
   * Managed_User membership is answered by
   * `DeviceManagementService.isManagedUser` rather than re-implemented
   * here, so this resolver and the service's own
   * `listManagedUserDevices`/`assertCanRevokeManaged` assertions cannot
   * disagree about who an admin manages. Note that is deliberately NOT
   * `Team.isAdmin` (which walks the Ancestor_Chain and counts inherited
   * admin rows): the Managed_User relationship requires a DIRECT admin row
   * (`role = 'admin' AND inherited_from_team_id IS NULL`), the same
   * condition `user:read:team_admin` above and `DirectoryScopeService`
   * use.
   *
   * The Global_Manager short-circuit is kept explicit (rather than left to
   * `isManagedUser`'s own `DirectoryScopeService.resolveScope` unscoped
   * check) to match every resolver above and to skip the lookup entirely.
   *
   * Per this module's contract a throw propagates to
   * `isSatisfiedWithRowScopedChecks`, which logs it and fails closed — so
   * there is deliberately no local try/catch, and a database failure
   * denies rather than permits (Requirement 9.4).
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'device_mgmt:read:managed': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }
    const targetUserId = req.params && req.params.userId;
    if (!targetUserId) {
      return false;
    }
    return DeviceManagementService.isManagedUser(req.user, targetUserId);
  },

  /**
   * `device_mgmt:revoke:managed` — device-management Requirements 8.5,
   * 8.6, 9.4: satisfied if the requesting user is a Global_Manager OR BOTH
   * (a) the `:userId` route param names a Managed_User of the requesting
   * admin AND (b) the `:clientUid` route param names a Device whose
   * `user_id` is that same `:userId`. Backs
   * `POST /api/device-management/users/:userId/devices/:clientUid/revoke`.
   *
   * Both legs are required here, at the authorization layer, because
   * Requirement 8.5 calls for an unauthorized revocation to be blocked
   * "upfront before any Revoke_Operation is enqueued" — this resolver runs
   * before the route handler exists as far as the request is concerned, so
   * neither the `REVOKE` confirmation check nor `EventPublisher` is ever
   * reached on a denial. The route handler repeats the same assertion via
   * `DeviceManagementService.assertCanRevokeManaged` (defense in depth,
   * mirroring `MouService.recordCountersignature`'s double-gating), which
   * is also what turns the two cases into the distinct client-facing
   * errors; this layer only answers permitted/denied.
   *
   * The managed-user leg is evaluated first so a caller with no
   * relationship to the target triggers no Device lookup at all. A
   * `:clientUid` naming no `tak_devices` row is denied identically to one
   * naming another user's Device — see `DeviceNotOwnedError`'s reasoning
   * for why those two cases are never distinguished.
   *
   * Per this module's contract a throw propagates to
   * `isSatisfiedWithRowScopedChecks`, which logs it and fails closed.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'device_mgmt:revoke:managed': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }

    const targetUserId = req.params && req.params.userId;
    const clientUid = req.params && req.params.clientUid;
    if (!targetUserId || !clientUid) {
      return false;
    }

    const managed = await DeviceManagementService.isManagedUser(req.user, targetUserId);
    if (!managed) {
      return false;
    }

    const device = await DeviceManagementService.findDeviceRow(clientUid);
    if (!device) {
      return false;
    }

    return DeviceManagementService.sameUserId(device.user_id, targetUserId);
  },

  /**
   * `device:read:team_admin` — takserver-enrollment Criteria 3.6, 3.7,
   * 3.8: backs `GET /api/devices/team/:teamId` (task 8.3's team device
   * listing). Satisfied if the requesting user is a Global_Manager OR is
   * an admin (per `Team.isAdmin`) of the specific team named by the
   * `:teamId` route param — mirrors `team:update` above exactly, since
   * listing a team's devices is the same authorization boundary as
   * updating that team.
   *
   * `Team.isAdmin` resolves Team_Admin through the Ancestor_Chain, so an
   * Organisation admin qualifies for a device on any Sub_Team beneath it,
   * and an INHERITED admin row (`inherited_from_team_id` NOT NULL) never
   * confers Team_Admin (Criterion 3.6).
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'device:read:team_admin': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }
    return Team.isAdmin(req.params.teamId, req.user && req.user.userId);
  },

  /**
   * `admin:excluded_domains:manage` — Global_Manager-only.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'admin:excluded_domains:manage': async (req) => {
    return Boolean(req.user && req.user.is_global_manager);
  },

  /**
   * `admin:org_interest:read` — Global_Manager-only.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'admin:org_interest:read': async (req) => {
    return Boolean(req.user && req.user.is_global_manager);
  },

  /**
   * `admin:org_interest:manage` — Global_Manager-only.
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'admin:org_interest:manage': async (req) => {
    return Boolean(req.user && req.user.is_global_manager);
  }
};

/**
 * Permission identifiers whose denial must respond 404 ("as though the
 * resource does not exist") instead of `authorize()`'s generic 403
 * `{error: 'Forbidden'}'.
 *
 * Requirement 6.2/6.3: a non-member must not be able to distinguish "this
 * Team doesn't exist" from "this Team exists but you can't see it", so a
 * `'team:read'` denial (whether because no row-scoped resolver was ever
 * consulted at all — i.e. `'team:read'` was neither held nor resolvable —
 * or because `TeamVisibilityService.isVisibleBranch` explicitly returned
 * `false`, or because the resolver threw and was fail-closed-denied) is
 * treated identically here: all three are "you can't see this team" from
 * the client's perspective, so all three map to 404.
 *
 * This is a small, targeted set keyed on the permission identifier, per
 * design.md's "this design changes `authorize.js` for this one permission
 * only" framing — every OTHER permission identifier's denial (including a
 * denial on a route that requires BOTH `'team:read'` and some other
 * permission, when the OTHER permission is the one that actually failed)
 * continues to respond 403 unchanged.
 */
const PERMISSION_DENIALS_MAPPED_TO_404 = new Set(['team:read']);

/**
 * Determines whether every permission identifier required by a registry
 * entry is satisfied for this specific request, extending the static
 * `resolveAccess` check with row-scoped resolvers.
 *
 * A required identifier is satisfied if either:
 *   (a) the base `userPermissions` set already contains it (or the
 *       wildcard `'*'`), matching `resolveAccess`'s existing behavior, OR
 *   (b) a row-scoped resolver exists for that identifier and
 *       `await resolver(req)` returns `true` for this request.
 *
 * The request is authorized only if every required identifier is
 * satisfied by (a) or (b). `resolveAccess` itself stays a synchronous,
 * pure function operating only on a static Set — this async, per-request
 * extension has to live here in `authorize.js` instead.
 *
 * Fail-closed exception handling (Requirement 4 Criteria 4.3, 4.6): a
 * resolver call is allowed to throw (e.g. `Team.isAdmin`'s underlying
 * `pool.query` call fails due to a DB error). That throw is caught here,
 * once, centrally for every resolver invocation in this loop — rather than
 * duplicated inside each individual resolver — logged via `getLogger()`
 * with a structured `{actorId, resourceId, errorCategory:
 * 'authorization_check_exception', permission, err}` object, and treated
 * as "resolver returned false" (i.e. the permission is NOT satisfied) so
 * the loop's overall result is `false` and `authorize()` responds with the
 * normal 403 `{error: 'Forbidden'}` — no internal error details are
 * exposed in the HTTP response, only in the log line.
 *
 * Returns `{ permitted, reason, failedPermission }` rather than a plain
 * boolean so that `authorize()` can log the specific 403 reason exactly
 * once (Requirement 13.7) without either double-logging (once here, once
 * in `authorize()`) or losing the more specific `resolver_exception`
 * reason in favor of a generic `permission_denied` fallback.
 *
 * `failedPermission` names the SPECIFIC required permission identifier
 * that was not satisfied (task 14.1, Requirement 6.2/6.3): a route may
 * require multiple permissions, and `authorize()` needs to know exactly
 * which one failed in order to decide whether this denial should map to a
 * 404 (currently only `'team:read'`, see
 * `PERMISSION_DENIALS_MAPPED_TO_404`) rather than the generic 403. Every
 * denial branch below — "not held and no resolver exists", "resolver
 * returned false", and "resolver threw" — reports `failedPermission`
 * consistently, since all three represent the same "this permission is
 * not satisfied for this request" outcome from `authorize()`'s
 * perspective.
 *
 * @param {string[]} requiredPermissions
 * @param {Set<string>} heldPermissions
 * @param {import('express').Request} req
 * @returns {Promise<{permitted: boolean, reason?: string, failedPermission?: string}>}
 */
async function isSatisfiedWithRowScopedChecks(requiredPermissions, heldPermissions, req) {
  if (heldPermissions.has('*')) {
    return { permitted: true };
  }

  for (const permission of requiredPermissions) {
    if (heldPermissions.has(permission)) {
      continue;
    }

    const resolver = rowScopedResolvers[permission];
    if (!resolver) {
      return { permitted: false, failedPermission: permission };
    }

    let resolverResult;
    try {
      resolverResult = await resolver(req);
    } catch (err) {
      getLogger().error(
        {
          actorId: req.user && (req.user.userId ?? req.user.id),
          resourceId: getBestEffortResourceId(req),
          errorCategory: 'authorization_check_exception',
          permission,
          err
        },
        'Authorization resolver threw; treating permission as denied (fail closed)'
      );
      // Design note (task 14.1): a resolver exception is already
      // fail-closed treated as "permission not satisfied" regardless of
      // which permission it was checking. For `'team:read'` specifically,
      // mapping this case to 404 (the same as any other `'team:read'`
      // denial) rather than 403 is the more consistent choice, since a
      // resolver failure here still means the client cannot distinguish
      // "this Team doesn't exist" from "this Team exists but an error
      // occurred checking your access to it" — both should look like
      // "not found" rather than leaking that the resource exists. This is
      // a deliberate judgement call (design.md does not explicitly address
      // this sub-case); `reason: 'resolver_exception'` is preserved
      // unchanged for logging purposes either way.
      return { permitted: false, reason: 'resolver_exception', failedPermission: permission };
    }

    if (!resolverResult) {
      return { permitted: false, failedPermission: permission };
    }
  }

  return { permitted: true };
}

/**
 * Best-effort resource identifier for a request, used only for logging
 * context when a resolver throws (Requirement 4 Criteria 4.3, 4.6). Not
 * exhaustive — it covers the route params already used by the row-scoped
 * resolvers above (`teamId`, `userId`, `channelId`) so a log line can be
 * correlated back to the specific resource being checked, without needing
 * per-permission-specific extraction logic here.
 *
 * @param {import('express').Request} req
 * @returns {string|undefined}
 */
function getBestEffortResourceId(req) {
  const params = req.params || {};
  return params.teamId || params.userId || params.channelId || params.requestId || undefined;
}

/**
 * Computes the registry lookup key for the current request: the full
 * mounted path (mount prefix + route pattern), not the interpolated URL.
 *
 * Express only exposes `req.route.path` once inside a matched route
 * handler, and that value is relative to the router it was mounted on
 * (e.g. a router mounted at `/api/teams` with a route `/:teamId` reports
 * `req.route.path === '/:teamId'`). Combining `req.baseUrl` with
 * `req.route.path` reconstructs the full path (`/api/teams/:teamId`)
 * matching the full-path keys used throughout `permissions.registry.js`
 * (e.g. `/api/global-channels/bch`).
 *
 * @param {import('express').Request} req
 * @returns {string} `${method} ${fullPath}`, e.g. `"PUT /api/teams/:teamId"`.
 */
function getRouteKey(req) {
  const baseUrl = req.baseUrl || '';
  const routePath = (req.route && req.route.path) || '';

  // Concatenate and normalize any resulting double slashes (e.g. when
  // routePath is '/' for a router mounted directly at baseUrl).
  let fullPath = `${baseUrl}${routePath}`.replace(/\/{2,}/g, '/');

  // Ensure a leading slash and strip a trailing slash (unless the path is
  // just '/'), so keys are stable regardless of how the route was defined.
  if (!fullPath.startsWith('/')) {
    fullPath = `/${fullPath}`;
  }
  if (fullPath.length > 1 && fullPath.endsWith('/')) {
    fullPath = fullPath.slice(0, -1);
  }

  return `${req.method} ${fullPath}`;
}

/**
 * Computes the base permission set for the requesting user.
 *
 * Global_Manager users (identified by `req.user.is_global_manager`, which
 * mirrors Authentik's `TakTeamManager_Admin` group membership per
 * `server/middleware/auth.js`) receive the wildcard `roleDefaults.global_manager`
 * set. Every other authenticated user receives the base
 * `roleDefaults.authenticated_user` set.
 *
 * Row-scoped permission grants (e.g. "admin of team X") are NOT computed
 * here; that is added by task 11.2's per-permission resolver functions.
 *
 * @param {import('express').Request['user']} user
 * @returns {string[]}
 */
function getUserPermissions(user) {
  if (user && user.is_global_manager) {
    return roleDefaults.global_manager;
  }
  return roleDefaults.authenticated_user;
}

/**
 * Express middleware implementing the Authorization_Middleware described
 * above. Must be mounted after `authenticateToken`.
 *
 * First applies the static, synchronous `resolveAccess` check (deny if no
 * registry entry exists, or if the user's base permission set already
 * satisfies every required identifier). If that check does not already
 * permit the request but a registry entry does exist, falls back to
 * `isSatisfiedWithRowScopedChecks`, which additionally permits the request
 * if every required identifier not already held is satisfied by a
 * row-scoped resolver (e.g. `Team.isAdmin` for the request's specific
 * `:teamId`/`parentTeamId`) evaluated against this specific request.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function authorize(req, res, next) {
  const routeKey = getRouteKey(req);
  const userPermissions = getUserPermissions(req.user);

  if (resolveAccess(routeKey, userPermissions, { routes, roleDefaults })) {
    return next();
  }

  const requiredPermissions = routes[routeKey];
  if (!requiredPermissions) {
    // Deny-by-default: no registry entry for this route+method (Req 24.4).
    logAuthzFailure(req, 'no_registry_entry');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const heldPermissions = userPermissions instanceof Set ? userPermissions : new Set(userPermissions || []);
  const { permitted, reason, failedPermission } = await isSatisfiedWithRowScopedChecks(
    requiredPermissions,
    heldPermissions,
    req
  );

  if (!permitted) {
    logAuthzFailure(req, reason || 'permission_denied');

    // Requirement 6.2/6.3 (task 14.1): a `'team:read'` denial responds
    // 404 instead of the generic 403, so a non-member cannot distinguish
    // "this Team doesn't exist" from "this Team exists but you can't see
    // it". This is a targeted branch keyed on the SPECIFIC failing
    // permission identifier, not a general behaviour change to
    // `authorize()` — every other permission's denial (including a
    // denial on a route requiring `'team:read'` alongside some other
    // permission, when that OTHER permission is the one that actually
    // failed) still responds 403 below, unchanged.
    if (failedPermission && PERMISSION_DENIALS_MAPPED_TO_404.has(failedPermission)) {
      return res.status(404).json({ error: 'Team not found' });
    }

    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}

module.exports = authorize;
