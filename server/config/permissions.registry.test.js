/**
 * Property-based tests for the Permission_Registry's pure resolver,
 * `resolveAccess` (Requirement 24 Criteria 3-4, design.md's Property 12).
 *
 * These tests exercise the REAL exported `resolveAccess` from
 * `./permissions.registry` (imported below), not a simplified stand-in.
 * `server/middleware/authorize.test.js` and
 * `server/middleware/authorize.channelRequest.test.js` each mock
 * `./permissions.registry` with a self-contained reimplementation of
 * `resolveAccess` for their own middleware-focused tests -- that is
 * intentional and appropriate for those files' scope (testing
 * `authorize.js`'s wiring/error-handling around the resolver), but it
 * means the real `resolveAccess` implementation itself was previously
 * untested. This file closes that gap.
 *
 * Implemented with `fast-check` via `@fast-check/jest`'s `test.prop`
 * integration, matching the convention established in
 * `./configValidator.test.js`'s Property 8/9 tests. Each property runs a
 * minimum of 100 iterations (`numRuns: 100` set explicitly for
 * clarity/documentation purposes rather than relying on the implicit
 * default).
 */

const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const { routes, roleDefaults, resolveAccess } = require('./permissions.registry');

// Feature: production-hardening, Property 12: Permission Registry denies by default
describe('Property 12: Permission Registry denies by default (resolveAccess)', () => {
  /**
   * design.md's exact Property 12 statement: "For any route key absent
   * from the Permission_Registry and any user permission set (including a
   * global-manager wildcard set), access resolution denies the request."
   *
   * `knownRouteKeyArb` and `absentRouteKeyArb` are built with disjoint
   * fixed string prefixes (`known-route:` vs. `absent-route:`), so the
   * generated `registry.routes` keys and the generated tested `routeKey`
   * are GUARANTEED never to collide, for any randomized string content --
   * no runtime filtering/rejection is needed to keep the two sets apart.
   */
  const knownRouteKeyArb = fc.string().map((s) => `known-route:${s}`);
  const absentRouteKeyArb = fc.string().map((s) => `absent-route:${s}`);
  const requiredPermissionsArb = fc.array(fc.string(), { maxLength: 5 });

  // A handful of known routes with arbitrary required-permission arrays,
  // built from `knownRouteKeyArb` only -- `absentRouteKeyArb`'s disjoint
  // prefix guarantees the tested routeKey below is never one of these.
  const registryArb = fc
    .array(fc.tuple(knownRouteKeyArb, requiredPermissionsArb), { maxLength: 10 })
    .map((entries) => ({
      routes: Object.fromEntries(entries),
      roleDefaults: { global_manager: ['*'], authenticated_user: [] }
    }));

  // userPermissions covering: empty, arbitrary permission-identifier-shaped
  // strings, and a case that explicitly includes the wildcard '*' (proving
  // even a global-manager-shaped permission set cannot bypass deny-by-
  // default) -- as both a plain array and a Set, since `resolveAccess`
  // documents accepting either.
  const arbitraryPermissionsArrayArb = fc.array(fc.string(), { maxLength: 10 });
  const userPermissionsArb = fc.oneof(
    fc.constant([]),
    arbitraryPermissionsArrayArb,
    arbitraryPermissionsArrayArb.map((perms) => [...perms, '*']),
    fc.constant(['*']),
    arbitraryPermissionsArrayArb.map((perms) => new Set(perms)),
    fc.constant(new Set(['*']))
  );

  test.prop([absentRouteKeyArb, userPermissionsArb, registryArb], { numRuns: 100 })(
    'returns false for any routeKey absent from registry.routes, regardless of userPermissions (incl. wildcard), and never throws',
    (routeKey, userPermissions, registry) => {
      let result;
      expect(() => {
        result = resolveAccess(routeKey, userPermissions, registry);
      }).not.toThrow();
      expect(result).toBe(false);
    }
  );

  it('confirms resolveAccess never throws for a missing registry.routes object entirely', () => {
    expect(() => resolveAccess('GET /anything', ['*'], { roleDefaults: {} })).not.toThrow();
    expect(resolveAccess('GET /anything', ['*'], { roleDefaults: {} })).toBe(false);
  });
});

// Feature: production-hardening, Property 12 (complementary case, Requirement 24.3):
// entry present -> permit only if every required identifier is held
describe('resolveAccess permits a present routeKey only when every required permission is held (Requirement 24.3)', () => {
  const routeKeyArb = fc.string();
  const nonWildcardStringArb = fc.string().filter((s) => s !== '*');
  const requiredPermissionsArb = fc.uniqueArray(nonWildcardStringArb, { minLength: 1, maxLength: 5 });
  const extraPermissionsArb = fc.array(nonWildcardStringArb, { maxLength: 5 });

  function buildRegistry(routeKey, requiredPermissions) {
    return {
      routes: { [routeKey]: requiredPermissions },
      roleDefaults: { global_manager: ['*'], authenticated_user: [] }
    };
  }

  test.prop([routeKeyArb, requiredPermissionsArb, extraPermissionsArb], { numRuns: 100 })(
    'permits when userPermissions holds every required identifier (plus arbitrary extras), and never throws',
    (routeKey, requiredPermissions, extraPermissions) => {
      const registry = buildRegistry(routeKey, requiredPermissions);
      const sufficientPermissions = [...requiredPermissions, ...extraPermissions];

      let result;
      expect(() => {
        result = resolveAccess(routeKey, sufficientPermissions, registry);
      }).not.toThrow();
      expect(result).toBe(true);
    }
  );

  test.prop([routeKeyArb, requiredPermissionsArb], { numRuns: 100 })(
    'permits regardless of the required-permissions array when userPermissions holds only the wildcard',
    (routeKey, requiredPermissions) => {
      const registry = buildRegistry(routeKey, requiredPermissions);
      expect(resolveAccess(routeKey, ['*'], registry)).toBe(true);
      expect(resolveAccess(routeKey, new Set(['*']), registry)).toBe(true);
    }
  );

  test.prop([routeKeyArb, requiredPermissionsArb], { numRuns: 100 })(
    'denies when userPermissions is missing at least one required identifier and holds no wildcard',
    (routeKey, requiredPermissions) => {
      const registry = buildRegistry(routeKey, requiredPermissions);
      // `requiredPermissionsArb` is generated via `fc.uniqueArray`, so
      // dropping the first element entirely removes that identifier
      // (no duplicate elsewhere in the array could still satisfy it).
      const missingOneRequiredPermission = requiredPermissions.slice(1);

      let result;
      expect(() => {
        result = resolveAccess(routeKey, missingOneRequiredPermission, registry);
      }).not.toThrow();
      expect(result).toBe(false);
    }
  );

  it('confirms an empty required-permissions array is permitted by an empty userPermissions set (degenerate iff case)', () => {
    const registry = buildRegistry('GET /no-op', []);
    expect(resolveAccess('GET /no-op', [], registry)).toBe(true);
  });
});
/**
 * Registry assertions for the team-member-transfer feature (task 3.6).
 *
 * Requirement 2.1: the Permission_Registry maps
 * `POST /api/users/:userId/transfer` to `user:team:transfer`.
 *
 * The negative assertions matter more than the positive one here. Both
 * `user:team:transfer` (Req 2.2) and `request:approve`/`request:deny`
 * (Req 5.1-5.5) are granted per-request by row-scoped resolvers in
 * `server/middleware/authorize.js`. Placing any of the three in
 * `roleDefaults.authenticated_user` would make `resolveAccess` permit the
 * route outright, so `authorize.js` would never consult the resolver --
 * handing every authenticated user the ability to move any member between
 * teams, or to approve/deny any Access_Request. These tests pin that
 * absence so it cannot be undone by a well-meaning "the Requests page 403s
 * for team admins" fix.
 */
describe('team-member-transfer registry entries (Requirements 2.1, 5.6)', () => {
  const registry = { routes, roleDefaults };
  const TRANSFER_ROUTE_KEY = 'POST /api/users/:userId/transfer';

  it('maps POST /api/users/:userId/transfer to exactly user:team:transfer (Req 2.1)', () => {
    expect(routes[TRANSFER_ROUTE_KEY]).toEqual(['user:team:transfer']);
  });

  it('resolves the transfer route only for a caller holding user:team:transfer or the wildcard', () => {
    expect(resolveAccess(TRANSFER_ROUTE_KEY, ['user:team:transfer'], registry)).toBe(true);
    expect(resolveAccess(TRANSFER_ROUTE_KEY, roleDefaults.global_manager, registry)).toBe(true);
    expect(resolveAccess(TRANSFER_ROUTE_KEY, roleDefaults.authenticated_user, registry)).toBe(false);
    expect(resolveAccess(TRANSFER_ROUTE_KEY, [], registry)).toBe(false);
  });

  it('keeps user:team:transfer out of roleDefaults.authenticated_user', () => {
    expect(roleDefaults.authenticated_user).not.toContain('user:team:transfer');
  });

  it('keeps request:approve and request:deny out of roleDefaults.authenticated_user', () => {
    expect(roleDefaults.authenticated_user).not.toContain('request:approve');
    expect(roleDefaults.authenticated_user).not.toContain('request:deny');
    // `request:read` IS held statically -- a Team_Admin can list pending
    // Access_Requests -- while acting on one stays resolver-gated.
    expect(roleDefaults.authenticated_user).toContain('request:read');
  });

  it('leaves the approve and deny route mappings unchanged', () => {
    expect(routes['POST /api/requests/:requestId/approve']).toEqual(['request:approve']);
    expect(routes['POST /api/requests/:requestId/deny']).toEqual(['request:deny']);
  });

  /**
   * Requirement 5.6: a denied `request:approve`/`request:deny` check must
   * keep responding 403, not 404. `authorize.js`'s
   * `PERMISSION_DENIALS_MAPPED_TO_404` set is the only thing that turns a
   * denial into a 404, and it is reserved for `team:read`'s "respond as
   * though that Team does not exist" rule. It is a module-private const
   * (`authorize.js` exports only the middleware function), so this asserts
   * against the source text of that single declaration rather than an
   * imported value -- requiring `authorize.js` here would pull in the
   * database pool and the whole resolver graph for what is a one-line
   * invariant.
   */
  it('does not add request:approve or request:deny to PERMISSION_DENIALS_MAPPED_TO_404 (Req 5.6)', () => {
    const authorizeSource = fs.readFileSync(
      path.join(__dirname, '..', 'middleware', 'authorize.js'),
      'utf8'
    );

    const declaration = authorizeSource.match(
      /const PERMISSION_DENIALS_MAPPED_TO_404\s*=\s*new Set\(\[([^\]]*)\]\)/
    );

    // Fail loudly rather than vacuously if the declaration is renamed or
    // reshaped -- a silently unmatched regex would assert nothing.
    expect(declaration).not.toBeNull();

    const mappedTo404 = Array.from(declaration[1].matchAll(/['"]([^'"]+)['"]/g), (m) => m[1]);

    expect(mappedTo404).toContain('team:read');
    expect(mappedTo404).not.toContain('request:approve');
    expect(mappedTo404).not.toContain('request:deny');
    expect(mappedTo404).not.toContain('user:team:transfer');
  });
});

/**
 * Registry assertion for the read-only callsign_suffix preview route.
 *
 * The preview reveals whether a given callsign_suffix is already held by
 * someone on the target team, so it is mapped to the SAME 'user:create'
 * identifier as `POST /api/users/create-and-add` -- never a broader one,
 * and never granted statically to every authenticated user.
 */
describe('callsign_suffix preview registry entry', () => {
  const registry = { routes, roleDefaults };
  const PREVIEW_ROUTE_KEY = 'POST /api/users/callsign-suffix-preview';

  it('maps the preview route to exactly user:create, matching create-and-add', () => {
    expect(routes[PREVIEW_ROUTE_KEY]).toEqual(['user:create']);
    expect(routes[PREVIEW_ROUTE_KEY]).toEqual(routes['POST /api/users/create-and-add']);
  });

  it('keeps user:create out of roleDefaults.authenticated_user', () => {
    expect(roleDefaults.authenticated_user).not.toContain('user:create');
    expect(resolveAccess(PREVIEW_ROUTE_KEY, roleDefaults.authenticated_user, registry)).toBe(false);
    expect(resolveAccess(PREVIEW_ROUTE_KEY, ['user:create'], registry)).toBe(true);
    expect(resolveAccess(PREVIEW_ROUTE_KEY, roleDefaults.global_manager, registry)).toBe(true);
  });
});

/**
 * Registry assertions for the three user-directory LISTING routes.
 *
 * `GET /api/users`, `GET /api/users/search` and `GET /api/users/available`
 * were all mapped to a plain `user:read` that ALSO sat in
 * `roleDefaults.authenticated_user`, so `resolveAccess` permitted them
 * outright for every authenticated user -- a plain non-admin team member
 * could enumerate the whole user directory (names, emails) and the full
 * pool of unassigned users, even though all three back admin-only UI. They
 * now require `user:read:team_admin`, granted per-request by the row-scoped
 * resolver in `server/middleware/authorize.js` (Global_Manager, or a
 * Team_Admin of any team).
 *
 * As with `user:team:transfer` above, the negative assertions carry the
 * weight: putting `user:read:team_admin` into
 * `roleDefaults.authenticated_user` would satisfy `resolveAccess` outright,
 * so `authorize.js` would never consult the resolver and the disclosure
 * would silently return. `user:read:own` must stay, though -- `/auth/me`
 * and `GET /api/users/me` depend on it for every authenticated user.
 */
describe('user-directory listing route registry entries', () => {
  const registry = { routes, roleDefaults };
  const LISTING_ROUTE_KEYS = [
    'GET /api/users',
    'GET /api/users/search',
    'GET /api/users/available'
  ];

  it.each(LISTING_ROUTE_KEYS)('maps %s to exactly user:read:team_admin', (routeKey) => {
    expect(routes[routeKey]).toEqual(['user:read:team_admin']);
  });

  it.each(LISTING_ROUTE_KEYS)(
    'resolves %s only for a caller holding user:read:team_admin or the wildcard',
    (routeKey) => {
      expect(resolveAccess(routeKey, ['user:read:team_admin'], registry)).toBe(true);
      expect(resolveAccess(routeKey, roleDefaults.global_manager, registry)).toBe(true);
      expect(resolveAccess(routeKey, roleDefaults.authenticated_user, registry)).toBe(false);
      expect(resolveAccess(routeKey, [], registry)).toBe(false);
      // The retired identifier must not still open the route.
      expect(resolveAccess(routeKey, ['user:read'], registry)).toBe(false);
    }
  );

  it('keeps both user:read and user:read:team_admin out of roleDefaults.authenticated_user', () => {
    expect(roleDefaults.authenticated_user).not.toContain('user:read');
    expect(roleDefaults.authenticated_user).not.toContain('user:read:team_admin');
  });

  it('keeps user:read:own in roleDefaults.authenticated_user for the self-read routes', () => {
    // `/auth/me` and `GET /api/users/me` must keep working for every
    // authenticated user, admin or not.
    expect(roleDefaults.authenticated_user).toContain('user:read:own');
    expect(routes['GET /api/auth/me']).toEqual(['user:read:own']);
    expect(routes['GET /api/users/me']).toEqual(['user:read:own']);
    expect(resolveAccess('GET /api/auth/me', roleDefaults.authenticated_user, registry)).toBe(true);
    expect(resolveAccess('GET /api/users/me', roleDefaults.authenticated_user, registry)).toBe(true);
  });

  it('no longer references the retired user:read identifier anywhere in the registry', () => {
    const allRequired = Object.values(routes).flat();
    expect(allRequired).not.toContain('user:read');
  });
});

/**
 * Registry assertions for the three body-`teamId`-scoped user routes.
 *
 * `POST /api/users/create-and-add`,
 * `POST /api/users/callsign-suffix-preview` (both `user:create`) and
 * `POST /api/users/add-to-team` (`user:team:add`) all had registry entries
 * whose identifiers had NO resolver in `server/middleware/authorize.js`
 * and were NOT in `roleDefaults.authenticated_user` -- so nothing but a
 * Global_Manager's `'*'` wildcard could satisfy them and every Team_Admin
 * was denied 403. The shared `resolveTeamAdminOfBodyTeamId` resolver now
 * grants a Team_Admin of `req.body.teamId`.
 *
 * As with `user:team:transfer` above, the negative assertions carry the
 * weight: adding any of these identifiers to
 * `roleDefaults.authenticated_user` would satisfy `resolveAccess`
 * outright, so `authorize.js` would never consult the resolver and every
 * authenticated user could create users in, and add users to, any team.
 */
describe('body-teamId-scoped user route registry entries', () => {
  const registry = { routes, roleDefaults };
  const BODY_SCOPED_ROUTE_KEYS = {
    'POST /api/users/create-and-add': 'user:create',
    'POST /api/users/callsign-suffix-preview': 'user:create',
    'POST /api/users/add-to-team': 'user:team:add'
  };

  it.each(Object.entries(BODY_SCOPED_ROUTE_KEYS))(
    'still maps %s to exactly [%s]',
    (routeKey, identifier) => {
      expect(routes[routeKey]).toEqual([identifier]);
    }
  );

  it.each(Object.keys(BODY_SCOPED_ROUTE_KEYS))(
    'resolves %s statically for a Global_Manager but not for a plain authenticated user',
    (routeKey) => {
      // false for authenticated_user is the POINT: the row-scoped resolver,
      // not a static grant, is what opens these routes to a Team_Admin.
      expect(resolveAccess(routeKey, roleDefaults.authenticated_user, registry)).toBe(false);
      expect(resolveAccess(routeKey, roleDefaults.global_manager, registry)).toBe(true);
    }
  );

  it('keeps user:create, user:team:add and user:team:remove out of roleDefaults.authenticated_user', () => {
    expect(roleDefaults.authenticated_user).not.toContain('user:create');
    expect(roleDefaults.authenticated_user).not.toContain('user:team:add');
    expect(roleDefaults.authenticated_user).not.toContain('user:team:remove');
  });

  it('leaves the remove-from-team mapping unchanged (still Global_Manager-only)', () => {
    // Deliberately NOT given a resolver: this route deletes the Authentik
    // user plus the local `users`/`user_cache` rows outright, and widening
    // who may destroy an account is a separate, unmade decision.
    expect(routes['DELETE /api/users/remove-from-team/:userId']).toEqual(['user:team:remove']);
    expect(
      resolveAccess('DELETE /api/users/remove-from-team/:userId', roleDefaults.authenticated_user, registry)
    ).toBe(false);
  });
});

/**
 * Registry completeness: every permission identifier a route requires must
 * actually be SATISFIABLE by someone other than a Global_Manager, unless
 * that is a reviewed, deliberate decision.
 *
 * This is the check whose absence let the `user:create` / `user:team:add`
 * bug exist. An identifier can only ever be satisfied three ways:
 *   1. it sits in `roleDefaults.authenticated_user` (static grant), or
 *   2. it has a row-scoped resolver key in `server/middleware/authorize.js`
 *      (per-request grant), or
 *   3. nothing but `roleDefaults.global_manager`'s `'*'` wildcard.
 *
 * Case 3 is legitimate for genuinely Global_Manager-only routes, but it is
 * ALSO exactly what a forgotten resolver looks like -- indistinguishable
 * from the registry alone. So case 3 is allowed here only via the explicit
 * named lists below, which forces any NEW identifier to be a conscious
 * choice rather than a silent 403 for every team admin.
 *
 * `authorize.js` exports only the middleware function, so the resolver
 * keys are extracted from its source text, the same way the
 * `PERMISSION_DENIALS_MAPPED_TO_404` test above reads that module-private
 * const. The extraction is asserted to have actually matched something
 * plausible, so a renamed or reshaped declaration fails loudly instead of
 * producing an empty key list that would make every identifier look
 * unresolved (or, worse, an empty MISSING list that asserts nothing).
 */
describe('registry completeness: every required identifier is satisfiable', () => {
  /**
   * REVIEWED deliberate exception. `user:team:remove`
   * (`DELETE /api/users/remove-from-team/:userId`) has exactly the same
   * missing-resolver shape as the `user:create` / `user:team:add` bug this
   * test was written for, and is left Global_Manager-only ON PURPOSE: that
   * route deletes the Authentik user along with the local
   * `users`/`user_cache` rows outright, so widening who may destroy an
   * account is a separate decision that has not been made.
   */
  // `admin:stats:read` (GET /api/admin/stats) is intentionally
  // Global_Manager-only: it returns deployment-wide aggregate counts
  // (total Team_Owned_Devices, total channels across every team plus the
  // global BCH/region channels) for the /admin dashboard, which is itself
  // a Global_Manager-only page. There is no per-team scoping to resolve --
  // it is an all-tenants view by design -- so it correctly has no resolver
  // and is satisfiable only by the global_manager wildcard, exactly like
  // `audit_log:read`. Reviewed and deliberate.
  // `admin:sync_status:read` (GET /api/admin/sync-status) is likewise a
  // deliberate, reviewed Global_Manager-only view: deployment-wide
  // background-process health (sync_operations queue backlog + sync-worker
  // heartbeat), operator-scoped and all-tenants by design, so it has no
  // resolver and is wildcard-satisfied exactly like admin:stats:read.
  const REVIEWED_GLOBAL_MANAGER_ONLY = ['user:team:remove', 'user:bulk_remove_from_team', 'admin:stats:read', 'admin:sync_status:read'];

  /**
   * UNREVIEWED pre-existing exceptions. Each of these is satisfiable only
   * by `roleDefaults.global_manager`'s wildcard today. Most are documented
   * as intentionally Global_Manager-only in `permissions.registry.js`'s
   * own comments, but none has been audited against this check, so they
   * are listed rather than silently allowed. Anything genuinely
   * Global_Manager-only should be promoted to
   * `REVIEWED_GLOBAL_MANAGER_ONLY` once looked at; anything that a
   * Team_Admin was supposed to reach needs a resolver.
   */
  const UNREVIEWED_GLOBAL_MANAGER_ONLY = [
    'channel:create:custom',
    'config:read:all',
    'config:update',
    'sync:trigger',
    'sync:read',
    'operations:read',
    'operations:retry',
    'global_channel:manage',
    'global_channel:credentials',
    'audit_log:read',
    'communication:template:read',
    'communication:template:manage',
    'communication:test_email:send',
    'settings:manage',
    'settings:tak_server:read',
    'settings:tak_server:manage',
    'bulk_import:teams'
  ];

  const ALLOWED_WILDCARD_ONLY = new Set([
    ...REVIEWED_GLOBAL_MANAGER_ONLY,
    ...UNREVIEWED_GLOBAL_MANAGER_ONLY
  ]);

  /**
   * Extracts the `rowScopedResolvers` object's top-level keys from
   * `authorize.js`'s source text. Keys are matched at exactly the object's
   * two-space indentation, so nothing inside a resolver body or JSDoc
   * comment can be mistaken for a key.
   *
   * @returns {string[]}
   */
  function readRowScopedResolverKeys() {
    const authorizeSource = fs.readFileSync(
      path.join(__dirname, '..', 'middleware', 'authorize.js'),
      'utf8'
    );

    const declaration = authorizeSource.match(/const rowScopedResolvers = \{([\s\S]*?)\n\};/);

    // Fail loudly rather than vacuously if the declaration is renamed or
    // reshaped -- an unmatched regex would yield zero keys and turn this
    // whole suite into noise.
    expect(declaration).not.toBeNull();

    const keys = Array.from(declaration[1].matchAll(/^ {2}'([^']+)':/gm), (m) => m[1]);

    // Sanity-pin the extraction itself: a shape change that still matched
    // the regex but stopped yielding keys would otherwise pass silently.
    expect(keys.length).toBeGreaterThan(10);
    expect(keys).toContain('team:update');
    expect(keys).toContain('team:read');

    return keys;
  }

  it('extracts a plausible resolver key list from authorize.js source', () => {
    const keys = readRowScopedResolverKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has a resolver or a static grant for every identifier any route requires', () => {
    const resolverKeys = new Set(readRowScopedResolverKeys());
    const staticGrants = new Set(roleDefaults.authenticated_user);

    const unsatisfiable = [...new Set(Object.values(routes).flat())].filter(
      (identifier) =>
        !staticGrants.has(identifier) &&
        !resolverKeys.has(identifier) &&
        !ALLOWED_WILDCARD_ONLY.has(identifier)
    );

    expect(unsatisfiable).toEqual([]);
  });

  it('covers the previously-unsatisfiable identifiers with real resolvers, not exceptions', () => {
    const resolverKeys = new Set(readRowScopedResolverKeys());

    expect(resolverKeys.has('user:create')).toBe(true);
    expect(resolverKeys.has('user:team:add')).toBe(true);
    expect(ALLOWED_WILDCARD_ONLY.has('user:create')).toBe(false);
    expect(ALLOWED_WILDCARD_ONLY.has('user:team:add')).toBe(false);

    // The one reviewed exception stays an exception: no resolver.
    expect(resolverKeys.has('user:team:remove')).toBe(false);
    expect(ALLOWED_WILDCARD_ONLY.has('user:team:remove')).toBe(true);
  });

  it('keeps the exception lists free of identifiers no route requires any more', () => {
    // Stops the lists rotting into a permanent allow-list of dead
    // identifiers that quietly weakens the check above.
    const requiredIdentifiers = new Set(Object.values(routes).flat());
    for (const identifier of ALLOWED_WILDCARD_ONLY) {
      expect(requiredIdentifiers.has(identifier)).toBe(true);
    }
  });
});

/**
 * device-management registry entries (device-management Requirements 6.2,
 * 6.6, 6.7, 8.5, 8.6, 9.3, 9.4 -- task 12.2).
 *
 * The four `/api/device-management` routes split deliberately into two
 * pairs, and the split IS the security property under test here:
 *
 *   - The `:own` pair sits in `roleDefaults.authenticated_user`. Their only
 *     subject is the caller's own `req.user.userId`, which no request input
 *     can widen, so a static grant is safe -- and necessary, since every
 *     signed-in user must be able to see and revoke their own Devices
 *     (Requirements 5.1, 7.1).
 *   - The `:managed` pair must stay OUT of `roleDefaults.authenticated_user`,
 *     exactly as `user:team:transfer` does. A statically-held identifier
 *     satisfies `resolveAccess` outright, so `authorize.js` would never
 *     consult the row-scoped resolver -- handing every authenticated user
 *     the ability to read, and revoke, ANY user's Devices. The negative
 *     assertions therefore carry the weight in this suite.
 *
 * The resolvers' own behavior (Global_Manager, managed target, non-managed
 * target, non-owned Device, fail-closed) is covered in
 * `server/middleware/authorize.test.js`, which can drive them through the
 * middleware with mocked collaborators. This file covers the registry side:
 * the mapping and the role defaults that decide WHETHER those resolvers get
 * consulted at all.
 */
describe('device-management registry entries (Requirements 6.2, 8.5, 9.3, 9.4)', () => {
  const registry = { routes, roleDefaults };

  const OWN_ROUTE_IDENTIFIERS = {
    'GET /api/device-management/me/devices': 'device_mgmt:read:own',
    'POST /api/device-management/me/devices/:clientUid/revoke': 'device_mgmt:revoke:own'
  };

  const MANAGED_ROUTE_IDENTIFIERS = {
    'GET /api/device-management/users/:userId/devices': 'device_mgmt:read:managed',
    'POST /api/device-management/users/:userId/devices/:clientUid/revoke':
      'device_mgmt:revoke:managed'
  };

  it('maps each of the four device-management routes to exactly its own identifier', () => {
    for (const [routeKey, identifier] of Object.entries({
      ...OWN_ROUTE_IDENTIFIERS,
      ...MANAGED_ROUTE_IDENTIFIERS
    })) {
      expect(routes[routeKey]).toEqual([identifier]);
    }
  });

  it('keeps the device_mgmt identifiers distinct from the /api/devices enrollment feature', () => {
    // `/api/devices` (Requirement 27, team-owned device ENROLLMENT) is a
    // different feature that happens to share the word "device". Reusing
    // its `device:manage` identifier here would hand every authenticated
    // user -- who holds `device:manage` statically -- the managed-user
    // device-management routes outright.
    const deviceMgmtIdentifiers = Object.values({
      ...OWN_ROUTE_IDENTIFIERS,
      ...MANAGED_ROUTE_IDENTIFIERS
    });
    expect(deviceMgmtIdentifiers).not.toContain('device:manage');
    expect(routes['POST /api/devices']).toEqual(['device:manage']);
  });

  it('keeps device_mgmt:read:own and device_mgmt:revoke:own IN roleDefaults.authenticated_user', () => {
    for (const [routeKey, identifier] of Object.entries(OWN_ROUTE_IDENTIFIERS)) {
      expect(roleDefaults.authenticated_user).toContain(identifier);
      // The point of the static grant: a plain signed-in user reaches the
      // self routes with no resolver involved at all.
      expect(resolveAccess(routeKey, roleDefaults.authenticated_user, registry)).toBe(true);
      expect(resolveAccess(routeKey, roleDefaults.global_manager, registry)).toBe(true);
    }
  });

  it('keeps device_mgmt:read:managed and device_mgmt:revoke:managed OUT of roleDefaults.authenticated_user', () => {
    for (const [routeKey, identifier] of Object.entries(MANAGED_ROUTE_IDENTIFIERS)) {
      expect(roleDefaults.authenticated_user).not.toContain(identifier);
      // `false` here is the POINT: the row-scoped resolver in
      // `authorize.js` is what grants these per request, and it is only
      // ever consulted because `resolveAccess` does NOT permit the route
      // outright.
      expect(resolveAccess(routeKey, roleDefaults.authenticated_user, registry)).toBe(false);
      expect(resolveAccess(routeKey, [], registry)).toBe(false);
      // Still satisfiable by the identifier itself (what the resolver
      // effectively grants) and by a Global_Manager's wildcard.
      expect(resolveAccess(routeKey, [identifier], registry)).toBe(true);
      expect(resolveAccess(routeKey, roleDefaults.global_manager, registry)).toBe(true);
    }
  });

  it('does not let a :own grant satisfy a :managed route, or vice versa', () => {
    // The two pairs must not be interchangeable: holding the self grant
    // (every authenticated user does) must never open the admin route.
    for (const managedRouteKey of Object.keys(MANAGED_ROUTE_IDENTIFIERS)) {
      expect(resolveAccess(managedRouteKey, Object.values(OWN_ROUTE_IDENTIFIERS), registry)).toBe(
        false
      );
    }
    for (const ownRouteKey of Object.keys(OWN_ROUTE_IDENTIFIERS)) {
      expect(
        resolveAccess(ownRouteKey, Object.values(MANAGED_ROUTE_IDENTIFIERS), registry)
      ).toBe(false);
    }
  });

  it('backs both :managed identifiers with a row-scoped resolver in authorize.js', () => {
    // Without a resolver these two would be satisfiable ONLY by a
    // Global_Manager's wildcard -- the exact `user:create`/`user:team:add`
    // shape the completeness suite below was written for -- and every
    // legitimate team admin would get a 403.
    const authorizeSource = fs.readFileSync(
      path.join(__dirname, '..', 'middleware', 'authorize.js'),
      'utf8'
    );
    const declaration = authorizeSource.match(/const rowScopedResolvers = \{([\s\S]*?)\n\};/);
    expect(declaration).not.toBeNull();

    const resolverKeys = Array.from(declaration[1].matchAll(/^ {2}'([^']+)':/gm), (m) => m[1]);
    for (const identifier of Object.values(MANAGED_ROUTE_IDENTIFIERS)) {
      expect(resolverKeys).toContain(identifier);
    }
    // The `:own` pair is a static grant and deliberately has no resolver.
    for (const identifier of Object.values(OWN_ROUTE_IDENTIFIERS)) {
      expect(resolverKeys).not.toContain(identifier);
    }
  });

  it('leaves device-management denials on the generic 403 path, not the team:read 404 path', () => {
    const authorizeSource = fs.readFileSync(
      path.join(__dirname, '..', 'middleware', 'authorize.js'),
      'utf8'
    );
    const declaration = authorizeSource.match(
      /const PERMISSION_DENIALS_MAPPED_TO_404 = new Set\(\[([\s\S]*?)\]\);/
    );
    expect(declaration).not.toBeNull();

    const mappedTo404 = Array.from(declaration[1].matchAll(/'([^']+)'/g), (m) => m[1]);
    for (const identifier of Object.values({
      ...OWN_ROUTE_IDENTIFIERS,
      ...MANAGED_ROUTE_IDENTIFIERS
    })) {
      expect(mappedTo404).not.toContain(identifier);
    }
  });
});
