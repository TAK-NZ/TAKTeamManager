/**
 * Public_Route_Registry completeness test, analogous to
 * `./permissions.registry.completeness.test.js` (task 12.4), but proving
 * the INVERSE direction Requirement 33.4 calls for:
 *
 * Requirement 33.4: "an automated test analogous to the
 * Permission_Registry completeness test SHALL assert that a route
 * bypassing `authenticateToken` without a Public_Route_Registry entry
 * fails" -- i.e. the completeness-style check itself must correctly
 * flag/fail a mounted route that has NEITHER a Permission_Registry entry
 * NOR a Public_Route_Registry entry (which is exactly the
 * "authentication bypassed and undocumented" scenario Requirement 33.4
 * describes: `authorize.js` never gets a chance to run in the first place
 * if `authenticateToken` was skipped, so the only real backstop is this
 * exact registry-completeness check flagging the gap).
 *
 * `./permissions.registry.completeness.test.js` already asserts this
 * holds for the REAL, fully-registered app (every real mounted route has
 * an entry in one registry or the other). What that test does NOT prove
 * on its own is that the check would actually CATCH a future regression
 * -- a route added to `server/index.js` with no `authenticateToken` call
 * and no `publicRoutes.js` entry -- rather than silently passing no
 * matter what. This file proves that directly: it builds a throwaway
 * Express app containing ONE synthetic route that is deliberately mounted
 * WITHOUT `authenticateToken` and is NOT present in either registry, runs
 * the exact same `collectRouteKeys` walker + cross-reference logic
 * `permissions.registry.completeness.test.js` uses (imported from that
 * file's `module.exports`, avoiding a second copy of the walker), and
 * asserts the synthetic route is correctly identified as missing from
 * both registries.
 */

const express = require('express');

const { getMountPath, normalizePath, collectRouteKeys } = require('./permissions.registry.completeness.test');
const { routes: registryRoutes } = require('./permissions.registry');
const publicRoutes = require('./publicRoutes');

/**
 * Cross-references a list of collected `${METHOD} ${path}` route keys
 * against both registries, returning the ones present in neither -- the
 * exact same "missing" computation
 * `permissions.registry.completeness.test.js`'s own test performs against
 * the real app, factored out here so it can be reused against a
 * throwaway synthetic app too.
 *
 * @param {string[]} collectedKeys
 * @returns {string[]} Route keys present in neither registry.
 */
function findUnregisteredRoutes(collectedKeys) {
  const registryKeys = new Set(Object.keys(registryRoutes));
  const publicKeys = new Set(publicRoutes.map((r) => `${r.method} ${r.path}`));

  return Array.from(new Set(collectedKeys)).filter(
    (key) => !registryKeys.has(key) && !publicKeys.has(key)
  );
}

describe('Public_Route_Registry completeness check correctly flags an undocumented, authentication-bypassing route (Requirement 33.4)', () => {
  it('flags a synthetic route mounted without authenticateToken and without a Public_Route_Registry entry as missing', () => {
    // A minimal throwaway app with exactly one route, deliberately built
    // with NO `authenticateToken` (or any other auth middleware) in its
    // chain -- mirroring the "route bypassing authenticateToken" scenario
    // Requirement 33.4 describes -- and deliberately absent from both
    // `publicRoutes.js` and `permissions.registry.js`.
    const app = express();
    const router = express.Router();
    router.get('/synthetic-test-route', (req, res) => res.sendStatus(200));
    app.use('/api/synthetic', router);

    const collected = [];
    collectRouteKeys(app._router.stack, '', collected);

    expect(collected).toEqual(['GET /api/synthetic/synthetic-test-route']);

    const missing = findUnregisteredRoutes(collected);

    // The check correctly identifies the synthetic route as missing from
    // BOTH registries -- proving the completeness-checking mechanism
    // itself would catch this exact regression, rather than silently
    // passing no matter what is mounted.
    expect(missing).toEqual(['GET /api/synthetic/synthetic-test-route']);

    // Sanity check confirming the synthetic route key really is absent
    // from both real registries (i.e. this isn't accidentally colliding
    // with a genuinely-registered path).
    expect(registryRoutes['GET /api/synthetic/synthetic-test-route']).toBeUndefined();
    expect(
      publicRoutes.some((r) => `${r.method} ${r.path}` === 'GET /api/synthetic/synthetic-test-route')
    ).toBe(false);
  });

  it('does NOT flag the same synthetic route once it is added to a stand-in Public_Route_Registry (control case)', () => {
    const app = express();
    const router = express.Router();
    router.get('/synthetic-test-route', (req, res) => res.sendStatus(200));
    app.use('/api/synthetic', router);

    const collected = [];
    collectRouteKeys(app._router.stack, '', collected);

    // Cross-reference against a stand-in public-route list that DOES
    // include the synthetic route, proving the check's "missing" result
    // above was specifically due to the registry omission, not some
    // unrelated walker bug.
    const standInPublicKeys = new Set(['GET /api/synthetic/synthetic-test-route']);
    const registryKeys = new Set(Object.keys(registryRoutes));
    const missing = collected.filter(
      (key) => !registryKeys.has(key) && !standInPublicKeys.has(key)
    );

    expect(missing).toEqual([]);
  });

  it('re-confirms getMountPath/normalizePath are the same helpers used by the real completeness check (sanity, no duplicate implementation)', () => {
    expect(typeof getMountPath).toBe('function');
    expect(typeof normalizePath).toBe('function');
    expect(normalizePath('/api/synthetic//synthetic-test-route/')).toBe('/api/synthetic/synthetic-test-route');
  });
});
