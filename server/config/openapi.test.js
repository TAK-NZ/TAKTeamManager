/**
 * Unit tests for `server/config/openapi.js`'s generator functions:
 * `translatePath` (the Express `:param` -> OpenAPI `{param}` translation)
 * and `buildOpenApiDocument` (the full document assembly, including the
 * `team:read` 404-vs-403 special case and the public/authenticated
 * `security` split).
 *
 * `openapi.completeness.test.js` covers the cross-cutting invariant that
 * every route ends up SOMEWHERE in the generated document; this file
 * covers the SHAPE of what gets generated for individual routes.
 */

const { buildOpenApiDocument, translatePath, PERMISSION_DENIALS_MAPPED_TO_404 } = require('./openapi');
const { routes: registryRoutes } = require('./permissions.registry');
const publicRoutes = require('./publicRoutes');

describe('translatePath', () => {
  it('leaves a path with no parameters unchanged and reports no param names', () => {
    expect(translatePath('/api/teams/joinable')).toEqual({
      openApiPath: '/api/teams/joinable',
      paramNames: []
    });
  });

  it('translates a single :param segment to {param} and reports its name', () => {
    expect(translatePath('/api/teams/:teamId')).toEqual({
      openApiPath: '/api/teams/{teamId}',
      paramNames: ['teamId']
    });
  });

  it('translates multiple :param segments in order', () => {
    expect(translatePath('/api/teams/:teamId/members/:userId')).toEqual({
      openApiPath: '/api/teams/{teamId}/members/{userId}',
      paramNames: ['teamId', 'userId']
    });
  });

  it('translates a :param immediately followed by a literal path segment correctly', () => {
    // A naive regex could over-match into the following segment; this
    // pins that `:clientUid` stops at the next `/`, not at end-of-string.
    expect(translatePath('/api/device-management/me/devices/:clientUid/revoke')).toEqual({
      openApiPath: '/api/device-management/me/devices/{clientUid}/revoke',
      paramNames: ['clientUid']
    });
  });

  it('treats a :name appearing mid-segment as a parameter too, matching Express/path-to-regexp semantics', () => {
    // Express's own router treats `:name` as a named parameter wherever
    // it appears in a path string, not only when it starts a whole
    // segment -- so `translatePath` must match that, not a stricter
    // "only at segment start" rule that would silently mis-translate a
    // route Express itself would treat as parameterized.
    expect(translatePath('/api/weird:literal')).toEqual({
      openApiPath: '/api/weird{literal}',
      paramNames: ['literal']
    });
  });
});

describe('buildOpenApiDocument', () => {
  const doc = buildOpenApiDocument();

  it('produces a well-formed OpenAPI 3.0 document envelope', () => {
    expect(doc.openapi).toBe('3.0.3');
    expect(typeof doc.info.title).toBe('string');
    expect(typeof doc.info.version).toBe('string');
    expect(doc.paths).toBeInstanceOf(Object);
  });

  it('declares exactly the cookieAuth and apiKeyAuth security schemes', () => {
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(['apiKeyAuth', 'cookieAuth']);
    expect(doc.components.securitySchemes.cookieAuth).toEqual(
      expect.objectContaining({ type: 'apiKey', in: 'cookie', name: 'tak_session' })
    );
    expect(doc.components.securitySchemes.apiKeyAuth).toEqual(
      expect.objectContaining({ type: 'apiKey', in: 'header', name: 'X-API-Key' })
    );
  });

  it('generates one paths entry per unique translated path across both registries', () => {
    // Anti-vacuity: confirm this generated a plausible number of paths
    // before asserting anything about individual ones below.
    expect(Object.keys(doc.paths).length).toBeGreaterThan(50);
  });

  describe('an authenticated (Permission_Registry) route', () => {
    const operation = doc.paths['/api/teams/{teamId}'].put;

    it('carries the cookieAuth security requirement', () => {
      expect(operation.security).toEqual([{ cookieAuth: [] }]);
    });

    it('carries x-permission with the exact registry-required identifiers', () => {
      expect(operation['x-permission']).toEqual(registryRoutes['PUT /api/teams/:teamId']);
    });

    it('declares a required path parameter for each :param segment', () => {
      expect(operation.parameters).toEqual([
        { name: 'teamId', in: 'path', required: true, schema: { type: 'string' } }
      ]);
    });

    it('responds 200/403 (not 404) since team:update is not in PERMISSION_DENIALS_MAPPED_TO_404', () => {
      expect(Object.keys(operation.responses).sort()).toEqual(['200', '403']);
    });
  });

  describe('the team:read special case (404, not 403, mirroring authorize.js)', () => {
    it('is exercised by at least one real registry route, so this test is not vacuous', () => {
      const teamReadRouteKeys = Object.entries(registryRoutes)
        .filter(([, perms]) => perms.includes('team:read'))
        .map(([key]) => key);
      expect(teamReadRouteKeys.length).toBeGreaterThan(0);
    });

    it('responds 200/404 (not 403) for GET /api/teams/{teamId}, which requires team:read', () => {
      expect(registryRoutes['GET /api/teams/:teamId']).toEqual(['team:read']);
      const operation = doc.paths['/api/teams/{teamId}'].get;
      expect(Object.keys(operation.responses).sort()).toEqual(['200', '404']);
      expect(operation.responses['403']).toBeUndefined();
    });

    it('keeps PERMISSION_DENIALS_MAPPED_TO_404 limited to exactly team:read', () => {
      // Pinned so a future addition to the real authorize.js set is a
      // conscious update to BOTH copies, not a silent drift between them.
      expect(Array.from(PERMISSION_DENIALS_MAPPED_TO_404)).toEqual(['team:read']);
    });
  });

  describe('a multi-permission route', () => {
    it('carries every required identifier, and 404 wins if ANY required identifier maps to it', () => {
      // GET /api/teams/:teamId/hierarchy also requires only team:read
      // today; assert the general rule holds by checking a route with
      // more than one required identifier if one exists, else fall back
      // to confirming the single-identifier case explicitly covers the
      // "any" semantics.
      const multiPermRoute = Object.entries(registryRoutes).find(([, perms]) => perms.length > 1);
      if (multiPermRoute) {
        const [routeKey, perms] = multiPermRoute;
        const [method, expressPath] = routeKey.split(' ');
        const { openApiPath } = translatePath(expressPath);
        const operation = doc.paths[openApiPath][method.toLowerCase()];
        expect(operation['x-permission']).toEqual(perms);
        const expectMapsTo404 = perms.some((p) => PERMISSION_DENIALS_MAPPED_TO_404.has(p));
        expect(Object.keys(operation.responses)).toContain(expectMapsTo404 ? '404' : '403');
      } else {
        // No multi-permission route exists today -- confirm the
        // single-identifier team:read case still maps to 404 as the
        // "any" semantics degenerate correctly for a set of size 1.
        const operation = doc.paths['/api/teams/{teamId}'].get;
        expect(Object.keys(operation.responses)).toContain('404');
      }
    });
  });

  describe('a public (Public_Route_Registry) route', () => {
    it('carries no security requirement and no x-permission', () => {
      const publicEntry = publicRoutes.find((r) => r.path === '/api/teams/joinable');
      expect(publicEntry).toBeDefined();
      const operation = doc.paths['/api/teams/joinable'][publicEntry.method.toLowerCase()];
      expect(operation.security).toBeUndefined();
      expect(operation['x-permission']).toBeUndefined();
    });

    it('responds with a bare 200, no 403 or 404', () => {
      const operation = doc.paths['/api/teams/joinable'].get;
      expect(Object.keys(operation.responses)).toEqual(['200']);
    });

    it('declares no parameters for a public route with no :param segments', () => {
      const operation = doc.paths['/api/teams/joinable'].get;
      expect(operation.parameters).toBeUndefined();
    });
  });

  it('returns a fresh object on every call rather than a shared mutable singleton', () => {
    const first = buildOpenApiDocument();
    const second = buildOpenApiDocument();
    expect(first).not.toBe(second);
    expect(first.paths).not.toBe(second.paths);
    first.paths['/mutated-by-test'] = {};
    expect(second.paths['/mutated-by-test']).toBeUndefined();
  });
});
