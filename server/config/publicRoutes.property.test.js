/**
 * Property test for the Public_Route_Registry / Permission_Registry
 * mutual-exclusion invariant (Requirement 33.3, task 55.3, design.md's
 * Property 13).
 *
 * design.md's exact Property 13 statement: "For every `{method, path}`
 * entry in the Public_Route_Registry, no identical entry exists as a key
 * in the Permission_Registry."
 *
 * design.md's own "Thoughts"/"Classification" notes on Property 13 (see
 * "33.3 Public/Permission registry mutual exclusion" in design.md)
 * describe this as an invariant over two static, fixed data structures
 * rather than a classic "for all randomly generated inputs" property --
 * the domain being quantified over (every entry actually present in the
 * real `publicRoutes` array) is finite and fixed, not something there's
 * any value in generating arbitrary/synthetic inputs for. Per that
 * guidance, this is implemented as a `test.prop` over
 * `fc.constantFrom(...publicRoutes)`, i.e. an exhaustive per-entry check
 * across the REAL registry data (still expressed as a universal
 * statement -- "for every entry" -- and still run through
 * `@fast-check/jest`'s `test.prop`, matching this repo's established
 * property-test convention, e.g. `./permissions.registry.test.js`'s
 * Property 12 tests), rather than a property fuzzed over randomly
 * generated `{method, path}` shapes that would almost certainly never
 * coincide with either registry's real, hand-authored keys.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const publicRoutes = require('./publicRoutes');
const { routes: registryRoutes } = require('./permissions.registry');

// Feature: production-hardening, Property 13: Public and Permission registries never overlap
describe('Property 13: Public and Permission registries never overlap', () => {
  it('confirms the real publicRoutes array is non-empty, so this property is not vacuously true', () => {
    expect(publicRoutes.length).toBeGreaterThan(0);
  });

  test.prop([fc.constantFrom(...publicRoutes)], { numRuns: publicRoutes.length })(
    'has no permissions.registry.js key matching a real publicRoutes.js entry',
    (entry) => {
      const key = `${entry.method} ${entry.path}`;
      expect(registryRoutes[key]).toBeUndefined();
    }
  );

  it('confirms no permissions.registry.js key exactly matches any real publicRoutes.js entry (converse direction)', () => {
    const publicKeys = new Set(publicRoutes.map((r) => `${r.method} ${r.path}`));
    const overlapping = Object.keys(registryRoutes).filter((key) => publicKeys.has(key));

    expect(overlapping).toEqual([]);
  });
});
