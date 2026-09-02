/**
 * OpenAPI_Document completeness test -- the fifth structural guard in this
 * codebase (alongside `client/src/utils/dateFormatConsumers.test.js`,
 * `server/services/__tests__/martiEndpointContract.test.js`,
 * `server/workers/operationSchemas.test.js`, and
 * `client/src/pages/channelTreeContrast.test.jsx`).
 *
 * `buildOpenApiDocument()` (`./openapi.js`) is DERIVED from
 * `permissions.registry.js` and `publicRoutes.js`, not hand-maintained
 * separately -- but "derived from the registries" is only actually true
 * if every route those registries know about really does end up in the
 * generated document. Without this test, a bug in `openapi.js`'s own
 * translation logic (e.g. a route silently dropped, or a key normalized
 * incorrectly) would go unnoticed, and the generated document would
 * quietly drift from what the app actually serves -- exactly the "docs
 * that lie" failure mode a derived-not-authored spec was supposed to
 * avoid.
 *
 * This mirrors `permissions.registry.completeness.test.js`'s own check
 * (every MOUNTED route has a registry-or-public entry) one level further:
 * every registry-or-public entry must also appear as a `paths` key in the
 * generated OpenAPI document. Three independent views of the same route
 * set -- the live mounted router stack, the two registries, and the
 * generated document -- are cross-checked against each other so a gap in
 * any one of the three surfaces here.
 */

const { routes: registryRoutes } = require('./permissions.registry');
const publicRoutes = require('./publicRoutes');
const { buildTestApp, collectRouteKeys } = require('./routeInventory');
const { buildOpenApiDocument, translatePath } = require('./openapi');

/**
 * Converts a `${METHOD} ${expressPath}` route key into the
 * `${method} ${openApiPath}` shape `buildOpenApiDocument()`'s `paths`
 * object would key it under (lowercase method, Express `:param` segments
 * translated to OpenAPI `{param}` syntax) -- reusing `openapi.js`'s own
 * `translatePath` rather than a second, potentially-diverging regex.
 *
 * @param {string} routeKey
 * @returns {string}
 */
function toOpenApiKey(routeKey) {
  const [method, expressPath] = routeKey.split(' ');
  const { openApiPath } = translatePath(expressPath);
  return `${method.toLowerCase()} ${openApiPath}`;
}

/**
 * Flattens a generated OpenAPI document's `paths` object back into the
 * same `${method} ${openApiPath}` key shape `toOpenApiKey` produces, one
 * entry per (path, HTTP method) pair actually present.
 *
 * @param {object} paths
 * @returns {Set<string>}
 */
function flattenDocumentKeys(paths) {
  const keys = new Set();
  for (const [openApiPath, operations] of Object.entries(paths)) {
    for (const method of Object.keys(operations)) {
      keys.add(`${method} ${openApiPath}`);
    }
  }
  return keys;
}

describe('OpenAPI_Document completeness (generated spec must not drop a route)', () => {
  it('anti-vacuity: the registry and public-route lists are non-trivial to begin with', () => {
    // Guards against this whole suite passing vacuously if a prior change
    // accidentally emptied both source registries.
    expect(Object.keys(registryRoutes).length).toBeGreaterThan(50);
    expect(publicRoutes.length).toBeGreaterThan(5);
  });

  it('includes every Permission_Registry entry in the generated document', () => {
    const doc = buildOpenApiDocument();
    const documentKeys = flattenDocumentKeys(doc.paths);

    const missing = Object.keys(registryRoutes)
      .map(toOpenApiKey)
      .filter((key) => !documentKeys.has(key));

    if (missing.length > 0) {
      throw new Error(
        'The following permissions.registry.js route(s) are missing from ' +
        'buildOpenApiDocument()\'s generated paths -- the OpenAPI document ' +
        'no longer matches the registry it is derived from:\n' +
        missing.map((k) => `  - ${k}`).join('\n')
      );
    }
  });

  it('includes every Public_Route_Registry entry in the generated document', () => {
    const doc = buildOpenApiDocument();
    const documentKeys = flattenDocumentKeys(doc.paths);

    const missing = publicRoutes
      .map((r) => `${r.method} ${r.path}`)
      .map(toOpenApiKey)
      .filter((key) => !documentKeys.has(key));

    if (missing.length > 0) {
      throw new Error(
        'The following publicRoutes.js route(s) are missing from ' +
        'buildOpenApiDocument()\'s generated paths:\n' +
        missing.map((k) => `  - ${k}`).join('\n')
      );
    }
  });

  it('includes every route actually mounted in server/index.js (via the live router stack)', () => {
    // A third, independent view: walk the real mounted app (the same
    // walker permissions.registry.completeness.test.js uses) rather than
    // relying solely on the two static registry files, so a route that
    // is mounted but slipped through BOTH registries (which would already
    // fail permissions.registry.completeness.test.js) would also be
    // caught here rather than this test passing on registry data alone.
    const app = buildTestApp();
    const collected = [];
    collectRouteKeys(app._router.stack, '', collected);

    expect(collected.length).toBeGreaterThan(50);

    const doc = buildOpenApiDocument();
    const documentKeys = flattenDocumentKeys(doc.paths);

    const missing = Array.from(new Set(collected))
      .map(toOpenApiKey)
      .filter((key) => !documentKeys.has(key));

    if (missing.length > 0) {
      throw new Error(
        'The following route(s) mounted in server/index.js are missing ' +
        'from buildOpenApiDocument()\'s generated paths:\n' +
        missing.map((k) => `  - ${k}`).join('\n')
      );
    }
  });

  it('confirms the GET /api/openapi.json route itself is documented (dogfooding)', () => {
    const doc = buildOpenApiDocument();
    expect(doc.paths['/api/openapi.json']).toBeDefined();
    expect(doc.paths['/api/openapi.json'].get).toBeDefined();
    expect(doc.paths['/api/openapi.json'].get['x-permission']).toEqual(['docs:openapi:read']);
  });
});
