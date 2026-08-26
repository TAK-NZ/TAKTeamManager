// Feature: takserver-enrollment, Property 2: The identifier body is drawn once per character from a uniform bound, never by modulo reduction
//
// **Validates: Requirements 1.10**

/**
 * takserver-enrollment task 1.4: the single fast-check property test for
 * design.md's Property 2 (Criterion 1.10).
 *
 * This property tests the DRAW DISCIPLINE of `generateIdentifierBody`, not
 * the statistical distribution of `crypto.randomInt` -- a chi-squared test
 * of the real random source would measure Node itself and be flaky, and is
 * deliberately NOT attempted here (see design.md's Notes on deliberate PBT
 * omissions).
 *
 * `randomInt` is injected as a plain call-tracking function returning a
 * SCRIPTED sequence of seven indices, one per call, in the closed interval
 * 0..30. The property then asserts three things that together rule out a
 * modulo-over-a-byte implementation, which could never satisfy all three at
 * once:
 *
 *   1. INDEPENDENT RE-DERIVATION -- the produced body equals
 *      `AMBIGUITY_FREE_ALPHABET[index]` for each scripted index, in order,
 *      computed directly from the alphabet constant in the test, never by
 *      calling `generateIdentifierBody` and comparing it to itself.
 *   2. CALL COUNT -- the fake was invoked exactly seven times, matching
 *      `IDENTIFIER_BODY_LENGTH`.
 *   3. CALL SIGNATURE -- every one of those seven calls carried the single
 *      argument 31 (`AMBIGUITY_FREE_ALPHABET_LENGTH`) and no second
 *      argument. A modulo implementation drawing from a wider byte range
 *      would never ask this injected function for a bound of 31 at all, so
 *      this clause is what actually rules that construction out -- more so
 *      than the index-to-character mapping alone, which a sufficiently
 *      contrived implementation could still satisfy by coincidence for any
 *      one scripted sequence.
 *
 * Boundary concentration covers index `0` and index `30` -- the two ends of
 * the range a `% 31` over a byte gets wrong in opposite directions -- both
 * via a weighted generator arm and via pinned `examples` entries, per the
 * "not just via random generation" instruction.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const { generateIdentifierBody, IDENTIFIER_BODY_LENGTH } = require('./managedIdentifier');
const { AMBIGUITY_FREE_ALPHABET, AMBIGUITY_FREE_ALPHABET_LENGTH } = require('./identifierAlphabet');

/**
 * Builds a fake `randomInt` that returns `indices` in order, one per call,
 * and records the full argument list of every call it received -- so the
 * test can assert the returned body's index-to-character mapping AND the
 * draw discipline (call count, call arguments) independently, from the same
 * scripted run.
 *
 * @param {number[]} indices
 * @returns {{ randomInt: (...args: unknown[]) => number, calls: unknown[][] }}
 */
function createScriptedRandomInt(indices) {
  let cursor = 0;
  const calls = [];
  const randomInt = (...args) => {
    calls.push(args);
    const value = indices[cursor];
    cursor += 1;
    return value;
  };
  return { randomInt, calls };
}

const LOWEST_INDEX = 0;
const HIGHEST_INDEX = AMBIGUITY_FREE_ALPHABET_LENGTH - 1; // 30

// A single index concentrated on the two ends of the 0..30 range, plus a
// broad uniform arm -- never uniform-only, since a uniform draw over 0..30
// would essentially never land exactly on either boundary.
const indexArb = fc.oneof(
  { weight: 2, arbitrary: fc.constant(LOWEST_INDEX) },
  { weight: 2, arbitrary: fc.constant(HIGHEST_INDEX) },
  { weight: 4, arbitrary: fc.integer({ min: LOWEST_INDEX, max: HIGHEST_INDEX }) }
);

/** Exactly seven scripted indices per run, matching `IDENTIFIER_BODY_LENGTH`. */
const sevenIndicesArb = fc.array(indexArb, {
  minLength: IDENTIFIER_BODY_LENGTH,
  maxLength: IDENTIFIER_BODY_LENGTH
});

describe('Property 2: The identifier body is drawn once per character from a uniform bound, never by modulo reduction', () => {
  test.prop([sevenIndicesArb], {
    numRuns: 300,
    examples: [
      // Pinned boundary cases, not left to chance under random generation:
      // all-lowest, all-highest, and alternating between the two ends.
      [[LOWEST_INDEX, LOWEST_INDEX, LOWEST_INDEX, LOWEST_INDEX, LOWEST_INDEX, LOWEST_INDEX, LOWEST_INDEX]],
      [[HIGHEST_INDEX, HIGHEST_INDEX, HIGHEST_INDEX, HIGHEST_INDEX, HIGHEST_INDEX, HIGHEST_INDEX, HIGHEST_INDEX]],
      [[LOWEST_INDEX, HIGHEST_INDEX, LOWEST_INDEX, HIGHEST_INDEX, LOWEST_INDEX, HIGHEST_INDEX, LOWEST_INDEX]],
      [[HIGHEST_INDEX, LOWEST_INDEX, HIGHEST_INDEX, LOWEST_INDEX, HIGHEST_INDEX, LOWEST_INDEX, HIGHEST_INDEX]]
    ]
  })(
    'produces the alphabet characters at the scripted indices, in order, by calling randomInt(31) exactly seven times',
    (indices) => {
      const { randomInt, calls } = createScriptedRandomInt(indices);

      const body = generateIdentifierBody(randomInt);

      // Independent re-derivation: the expected body is built directly from
      // the alphabet constant and the scripted indices, never by calling
      // back into generateIdentifierBody or comparing it to itself.
      const expectedBody = indices.map((index) => AMBIGUITY_FREE_ALPHABET[index]).join('');
      expect(body).toBe(expectedBody);
      expect(body).toHaveLength(IDENTIFIER_BODY_LENGTH);

      // Draw discipline, clause 1: exactly seven calls to the injected source.
      expect(calls).toHaveLength(IDENTIFIER_BODY_LENGTH);

      // Draw discipline, clause 2: EACH call carried the single argument 31
      // and no second argument. This is the clause a modulo-over-a-byte
      // implementation cannot satisfy: such an implementation never asks
      // this injected function for a bound of 31 at all, since it would
      // derive its byte range some other way (e.g. `randomBytes`), so it
      // could never produce seven calls each shaped exactly `[31]`.
      calls.forEach((args) => {
        expect(args.length).toBe(1);
        expect(args).toEqual([AMBIGUITY_FREE_ALPHABET_LENGTH]);
      });
    }
  );
});
