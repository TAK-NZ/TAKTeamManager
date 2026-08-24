/**
 * Canonical tagged property test for design.md's Property 1 (task 16.1).
 *
 * design.md's exact Property 1 statement: "For all possible values of
 * `DEVICE_MGMT_ENABLED` (including unset, empty, `'TRUE'`, `' true '`,
 * `'1'`, and arbitrary strings), `isDeviceMgmtEnabled` SHALL return
 * `true` if and only if the value is exactly the string `'true'`."
 *
 * Run directly against the real `isDeviceMgmtEnabled` (no mocks) with
 * `fast-check` via `@fast-check/jest`'s `test.prop`, matching this repo's
 * property-test convention (e.g. `../publicRoutes.property.test.js`).
 *
 * `./deviceMgmt.test.js` (task 1.2) covers the same predicate with unit
 * and property tests; this file is the canonical TAGGED Property 1 test.
 *
 * **Validates: Requirements 1.1, 1.2**
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const { isDeviceMgmtEnabled } = require('../deviceMgmt');

// Sentinel standing in for "the variable is unset". It is not a possible
// string value, so it can never collide with a generated value, and the
// env object is built WITHOUT the key when it is drawn (Requirement 1.2).
const UNSET = Symbol('DEVICE_MGMT_ENABLED unset');

// The value space design.md quantifies over: arbitrary strings, the
// explicitly named near-misses (empty, 'TRUE', ' true ', '1'), the one
// accepted string 'true', and the unset case. The named constants are
// mixed in so the frontier around the single accepted value is exercised
// directly rather than left to random chance.
const flagValue = fc.oneof(
  fc.string(),
  fc.constantFrom(
    'true',
    'false',
    '',
    'TRUE',
    'True',
    'tRuE',
    ' true',
    'true ',
    ' true ',
    '\ttrue',
    'true\n',
    '1',
    '0',
    'yes',
    'no',
    'on',
    'off',
    'enabled',
    'null',
    'undefined'
  ),
  fc.constant(UNSET)
);

// Feature: device-management, Property 1: Enablement flag predicate
describe('Property 1: Enablement flag predicate', () => {
  test.prop([flagValue], { numRuns: 500 })(
    'returns true iff DEVICE_MGMT_ENABLED is exactly the string "true"',
    (value) => {
      // Unrelated keys are always present so a false result can never be
      // an artifact of an otherwise-empty environment object.
      const env = { NODE_ENV: 'test', PORT: '5000' };
      if (value !== UNSET) {
        env.DEVICE_MGMT_ENABLED = value;
      }

      expect(isDeviceMgmtEnabled(env)).toBe(value === 'true');
    }
  );
});
