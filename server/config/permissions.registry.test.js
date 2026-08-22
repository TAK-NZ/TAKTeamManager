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
