/**
 * OpenAPI_Document generator.
 *
 * `buildOpenApiDocument()` produces a mechanically-derived OpenAPI 3.0
 * skeleton from the two existing route registries -- `routes` in
 * `server/config/permissions.registry.js` and the array in
 * `server/config/publicRoutes.js` -- rather than a hand-authored spec
 * maintained as a second copy. Those two registries are already the
 * single source of truth for "does this route exist, and who may call
 * it"; this module's only job is to reshape that existing data into
 * OpenAPI's `paths` object, plus a fixed `components.securitySchemes`
 * block.
 *
 * What this generates, per route:
 *   - The path, with Express `:param` segments translated to OpenAPI's
 *     `{param}` syntax, and a matching `parameters` entry for each.
 *   - `security`: `[{cookieAuth: []}]` for a Permission_Registry entry
 *     (`authenticateToken` required), omitted entirely for a
 *     Public_Route_Registry entry (no authentication required).
 *   - `x-permission`: the permission identifier(s) required, taken
 *     verbatim from the registry, for a Permission_Registry entry only.
 *     This is the traceable pointer back to `authorize.js`'s row-scoped
 *     resolvers that makes the generated document more useful than a
 *     bare route list -- it tells a reader not just that a route exists,
 *     but which rule in `authorize.js` decides who may call it.
 *   - `responses`: a minimal `200`/`403` pair for a registry entry (plus
 *     `404` instead of `403` for `team:read`, mirroring `authorize.js`'s
 *     own `PERMISSION_DENIALS_MAPPED_TO_404` special case exactly -- see
 *     that module's own comment for why a `team:read` denial responds 404
 *     rather than 403), or a bare `200` for a public entry.
 *
 * What this deliberately does NOT generate: request/response body
 * schemas. Those are hand-authored, incrementally, directly above each
 * route handler (a `swagger-jsdoc`-style comment block is the natural
 * convention, though none exist yet) and merged over this skeleton by a
 * future revision of this module. Every route is present in the
 * generated `paths` object regardless -- with or without a hand-authored
 * body schema -- which is what the parity guard
 * (`server/config/openapi.completeness.test.js`) checks: every route
 * this app can reach has an entry HERE, not that every entry has a full
 * schema.
 *
 * This module is pure and synchronous: no I/O, no `req`, callable at
 * module load time or from a route handler alike.
 */

const { routes: registryRoutes } = require('./permissions.registry');
const publicRoutes = require('./publicRoutes');

/**
 * Permission identifiers whose registry-entry denial responds 404 rather
 * than the generic 403, mirrored from `server/middleware/authorize.js`'s
 * `PERMISSION_DENIALS_MAPPED_TO_404`. Kept as an independent literal
 * rather than importing that Set directly: `authorize.js` is a heavy
 * module (it pulls in `Team`, `User`, the DB pool, `TeamVisibilityService`,
 * `DeviceManagementService`) that this pure config generator should not
 * need to load just to read one small, stable constant. If
 * `authorize.js`'s set of 404-mapped identifiers ever grows,
 * `openapi.test.js` asserting against this same literal will need
 * updating alongside it -- a small, visible coupling rather than a
 * runtime one.
 */
const PERMISSION_DENIALS_MAPPED_TO_404 = new Set(['team:read']);

/**
 * Translates an Express-style route path (`/api/teams/:teamId`) into its
 * OpenAPI equivalent (`/api/teams/{teamId}`), returning both the
 * translated path and the ordered list of path parameter names found.
 *
 * @param {string} expressPath
 * @returns {{ openApiPath: string, paramNames: string[] }}
 */
function translatePath(expressPath) {
  const paramNames = [];
  const openApiPath = expressPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name) => {
    paramNames.push(name);
    return `{${name}}`;
  });
  return { openApiPath, paramNames };
}

/**
 * Builds the OpenAPI `parameters` array for a route's path parameters.
 * Every path parameter is required and typed as a plain string -- the
 * registry carries no richer type information (e.g. `:teamId`/`:userId`
 * are UUIDs in practice, but nothing in `permissions.registry.js` or
 * `publicRoutes.js` records that), so `string` is the honest minimum
 * rather than a guessed-at format.
 *
 * @param {string[]} paramNames
 * @returns {Array<object>}
 */
function buildParameters(paramNames) {
  return paramNames.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' }
  }));
}

/**
 * Builds the `responses` object for a registry-gated (authenticated)
 * route, given its required permission identifiers.
 *
 * @param {string[]} requiredPermissions
 * @returns {object}
 */
function buildAuthenticatedResponses(requiredPermissions) {
  const mapsToNotFound = requiredPermissions.some((p) => PERMISSION_DENIALS_MAPPED_TO_404.has(p));

  const responses = {
    200: { description: 'OK' }
  };

  if (mapsToNotFound) {
    // Mirrors authorize.js: a denial on a permission in
    // PERMISSION_DENIALS_MAPPED_TO_404 (currently only 'team:read')
    // responds 404, never 403, so the caller cannot distinguish "this
    // resource doesn't exist" from "it exists but you can't see it".
    responses[404] = { description: 'Not found (denial deliberately indistinguishable from absence)' };
  } else {
    responses[403] = { description: 'Forbidden' };
  }

  return responses;
}

/**
 * Builds a single OpenAPI Operation object for one `${METHOD} ${path}`
 * registry entry.
 *
 * @param {string[]|undefined} requiredPermissions - present for a
 *   Permission_Registry entry, undefined for a Public_Route_Registry entry.
 * @param {Array<object>} parameters
 * @returns {object}
 */
function buildOperation(requiredPermissions, parameters) {
  const operation = {};

  if (parameters.length > 0) {
    operation.parameters = parameters;
  }

  if (requiredPermissions) {
    operation.security = [{ cookieAuth: [] }];
    operation['x-permission'] = requiredPermissions;
    operation.responses = buildAuthenticatedResponses(requiredPermissions);
  } else {
    operation.responses = { 200: { description: 'OK' } };
  }

  return operation;
}

/**
 * Adds one route's Operation object into the accumulating `paths` object,
 * creating the path entry if this is the first method seen for it (a
 * path may have multiple HTTP methods, e.g. GET and PUT on the same
 * `/api/teams/{teamId}`).
 *
 * @param {object} paths - accumulator, mutated in place.
 * @param {string} method - HTTP method, upper or lower case.
 * @param {string} expressPath
 * @param {string[]|undefined} requiredPermissions
 */
function addRoute(paths, method, expressPath, requiredPermissions) {
  const { openApiPath, paramNames } = translatePath(expressPath);
  const parameters = buildParameters(paramNames);
  const operation = buildOperation(requiredPermissions, parameters);

  if (!paths[openApiPath]) {
    paths[openApiPath] = {};
  }
  paths[openApiPath][method.toLowerCase()] = operation;
}

/**
 * The fixed `components.securitySchemes` block. `cookieAuth` describes
 * the ONE authentication mechanism this app actually implements today
 * (see `server/middleware/auth.js`'s own comment: the JWT is read only
 * from the httpOnly `tak_session` cookie, never a header, URL parameter,
 * or `localStorage`). `apiKeyAuth` is a placeholder for a possible future
 * API-key mechanism -- declaring the scheme now costs nothing and avoids
 * having to retrofit every operation's `security` array later if that
 * feature is built; it is NOT currently applied to any operation above,
 * since no such mechanism exists yet.
 *
 * @returns {object}
 */
function buildSecuritySchemes() {
  return {
    cookieAuth: {
      type: 'apiKey',
      in: 'cookie',
      name: 'tak_session',
      description: 'httpOnly session cookie set by the OAuth2 callback (server/routes/auth.js). ' +
        'Never delivered via an Authorization header, URL parameter, or localStorage.'
    },
    apiKeyAuth: {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
      description: 'Reserved for a possible future API-key mechanism. Not yet implemented; ' +
        'no operation in this document currently requires it.'
    }
  };
}

/**
 * Builds the complete generated OpenAPI 3.0 document.
 *
 * Pure and synchronous -- reads only the two static registries, performs
 * no I/O, and returns a fresh plain object on every call (safe for a
 * caller to mutate its own copy without affecting a later call).
 *
 * @returns {object} An OpenAPI 3.0 document.
 */
function buildOpenApiDocument() {
  const { version } = require('../../package.json');

  const paths = {};

  for (const [routeKey, requiredPermissions] of Object.entries(registryRoutes)) {
    const [method, expressPath] = routeKey.split(' ');
    addRoute(paths, method, expressPath, requiredPermissions);
  }

  for (const { method, path: expressPath } of publicRoutes) {
    addRoute(paths, method, expressPath, undefined);
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'TAK Team Manager API',
      version,
      description: 'Generated from server/config/permissions.registry.js and ' +
        'server/config/publicRoutes.js -- the same registries authorize.js ' +
        'consults at request time -- rather than hand-authored separately. ' +
        'The `x-permission` field on an authenticated operation names the ' +
        'permission identifier(s) required; see server/middleware/authorize.js ' +
        'for the row-scoped resolver (if any) that decides who satisfies it. ' +
        'Request/response body schemas are not yet filled in for every ' +
        'operation; every reachable route is present regardless.'
    },
    paths,
    components: {
      securitySchemes: buildSecuritySchemes()
    }
  };
}

module.exports = {
  buildOpenApiDocument,
  translatePath,
  PERMISSION_DENIALS_MAPPED_TO_404
};
