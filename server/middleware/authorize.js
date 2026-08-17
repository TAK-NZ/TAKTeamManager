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
  'team:update': async (req) => {
    if (req.user && req.user.is_global_manager) {
      return true;
    }
    return Team.isAdmin(req.params.teamId, req.user && req.user.userId);
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
   * `user:create:team_admin` — satisfied if the requesting user is a
   * Global_Manager OR is an admin (per `Team.isAdmin`) of the `teamId`
   * named in the request body. Mirrors the inline check that used to live
   * in `users.js`'s `POST /` (older create-user route). The original
   * inline check incorrectly compared against `req.user.id` (the
   * Authentik id); this resolver correctly uses `req.user.userId` (the
   * local `users.id` that `team_memberships.user_id` references).
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'user:create:team_admin': async (req) => {
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
   * `user:holding_pen:team_admin` — satisfied if the requesting user is a
   * Global_Manager OR is an admin (per `Team.isAdmin`) of at least one of
   * the target user's (`:userId` route param) current teams. Mirrors the
   * inline loop that used to live in `users.js`'s
   * `POST /:userId/holding-pen`. The original inline check incorrectly
   * compared against `req.user.id` (the Authentik id); this resolver
   * correctly uses `req.user.userId` (the local `users.id`).
   *
   * @param {import('express').Request} req
   * @returns {Promise<boolean>}
   */
  'user:holding_pen:team_admin': async (req) => {
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
  'team:read': async (req) => TeamVisibilityService.isVisibleBranch(req.params.teamId, req.user)
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
