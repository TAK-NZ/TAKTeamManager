/**
 * Audit_Coverage completeness guard.
 *
 * Every data-mutating web route (POST/PUT/PATCH/DELETE) must leave an audit
 * trail. Audit writes live at the call sites (route handlers, or the
 * services/shared cores they delegate to), which means a new mutating route
 * can silently forget to log — exactly how `POST /api/users` (create) went
 * unaudited until now. This guard makes the invariant mechanical: it walks the
 * SAME mounted route inventory `permissions.registry.completeness.test.js`
 * walks (via `routeInventory.js`), filters to mutating methods, and asserts
 * that every one is accounted for in the reviewed `auditCoverage` registry —
 * either with an `action` (it logs) or an explicit `{ exempt, reason }`.
 *
 * A new mutating route with no `auditCoverage` entry FAILS here in CI, naming
 * the offending route and the two acceptable resolutions. A stale entry (for a
 * route that no longer exists) also fails, so the registry can't rot.
 *
 * This is a pure structural guard: it asserts on the route inventory and the
 * registry object, dispatching no requests and touching no database.
 */

const { auditCoverage } = require('./auditCoverage');
const { buildTestApp, collectRouteKeys } = require('./routeInventory');

const MUTATING_METHOD = /^(POST|PUT|PATCH|DELETE) /;

function collectMutatingRouteKeys() {
  const app = buildTestApp();
  const out = [];
  collectRouteKeys(app._router.stack, '', out);
  return Array.from(new Set(out)).filter((key) => MUTATING_METHOD.test(key));
}

describe('Audit_Coverage completeness (every mutating route is logged or explicitly exempt)', () => {
  it('walks a healthy number of mutating routes (anti-vacuity)', () => {
    const mutating = collectMutatingRouteKeys();
    // server/index.js mounts dozens of POST/PUT/PATCH/DELETE routes across the
    // route files; a near-zero count would mean the walker silently found
    // nothing (an Express-internals shape change) rather than a real result.
    expect(mutating.length).toBeGreaterThan(50);
  });

  it('has an auditCoverage entry for every mounted mutating route', () => {
    const mutating = collectMutatingRouteKeys();
    const missing = mutating.filter((key) => !Object.prototype.hasOwnProperty.call(auditCoverage, key));

    if (missing.length > 0) {
      throw new Error(
        'The following data-mutating route(s) have NO entry in ' +
        'server/config/auditCoverage.js, so it is unknown (and unenforced) ' +
        'whether they write an audit_logs row:\n' +
        missing.map((k) => `  - ${k}`).join('\n') +
        '\n\nResolve each by either:\n' +
        '  (a) calling writeAuditLog(...) in the handler (or its delegated ' +
        'service) and adding `{ action: \'noun.verb\' }` here, or\n' +
        '  (b) if it genuinely mutates no authenticated persistent state (a ' +
        'preview/compute, a session teardown) or is a public/unauthenticated ' +
        'endpoint with no acting user, adding `{ exempt: true, reason: \'...\' }`.'
      );
    }
  });

  it('has no stale auditCoverage entries (every entry maps to a mounted mutating route)', () => {
    const mutating = new Set(collectMutatingRouteKeys());
    const stale = Object.keys(auditCoverage).filter((key) => !mutating.has(key));

    if (stale.length > 0) {
      throw new Error(
        'The following auditCoverage.js entries do NOT correspond to any ' +
        'mounted mutating route (the route was removed or renamed; remove the ' +
        'stale entry):\n' +
        stale.map((k) => `  - ${k}`).join('\n')
      );
    }
  });

  it('every entry is well-formed: exactly one of an `action` string or `{ exempt, reason }`', () => {
    for (const [key, entry] of Object.entries(auditCoverage)) {
      const hasAction = typeof entry.action === 'string' && entry.action.length > 0;
      const isExempt = entry.exempt === true;
      // Exactly one disposition.
      expect(hasAction !== isExempt).toBe(true);
      if (isExempt) {
        expect(typeof entry.reason === 'string' && entry.reason.length > 0).toBe(true);
      }
      if (hasAction) {
        // Action strings follow the established 'noun.verb' vocabulary.
        expect(entry.action).toMatch(/^[a-z_]+\.[a-z_]+$/);
      }
      // Cheap guard against a typo'd key shape.
      expect(key).toMatch(MUTATING_METHOD);
    }
  });
});
