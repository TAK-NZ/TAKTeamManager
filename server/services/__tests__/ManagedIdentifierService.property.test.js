// Feature: takserver-enrollment, Property 3: The mint retries only on the username constraint, at most five times, and never substitutes an identifier
//
// **Validates: Requirements 1.7, 1.8, 1.9, 2.9**

/**
 * takserver-enrollment task 1.6: the single fast-check property test for
 * design.md's Property 3 (Requirements 1.7, 1.8, 1.9, 2.9).
 *
 * `claim(candidate)` is a fake, scripted function -- never a real database --
 * driven by a GENERATED sequence of up to five per-attempt outcomes, each
 * either a success or a rejection carrying `{ code, constraint }`. The
 * expectation for every run is computed by `deriveExpectation`, which
 * simulates `ManagedIdentifierService.mintUniqueIdentifier`'s documented loop
 * (generate -> claim -> continue iff the rejection is `23505` on EXACTLY
 * `users_username_key`, else propagate; throw after five) purely from that
 * generated sequence and the Organisation_Prefix's validity. Nothing here
 * calls the subject to compute what the subject should do.
 *
 * The rejection sequence is drawn over the CROSS PRODUCT of PostgreSQL error
 * codes (`23505`, `23514`, `23503`, `42P01`) and constraint names
 * (`users_username_key`, `users_email_key`, `undefined`, arbitrary strings
 * including ones CONTAINING `username` such as `users_username_lower_key`),
 * crossed with valid and invalid Organisation_Prefixes. An invalid prefix
 * (`''`, `null`, `undefined`, a non-string, or a string carrying a character
 * outside `[A-Za-z0-9]`) causes `generateManagedIdentifier` to throw a
 * `TypeError` on the very first candidate -- BEFORE `claim` is ever
 * reached -- which is how "the mint is never even reached" is exercised
 * directly against `mintUniqueIdentifier` itself, rather than via the
 * separate `resolveOrganisationPrefix`/`OrganisationPrefixMissingError` pair
 * that a real caller sequences in front of it per design.md.
 *
 * Two generator arms combine for boundary concentration:
 *   - a BOUNDARY arm forcing the leading run of qualifying rejections to be
 *     EXACTLY four or EXACTLY five (the count-equals-five exhaustion boundary
 *     and the count-equals-four one-short-of-it boundary), with an arbitrary
 *     terminal success or non-qualifying rejection following the four-case;
 *   - a FREE arm drawing all five per-attempt outcomes independently and
 *     broadly, so a non-qualifying rejection or a success can land at any
 *     position, including the first.
 *
 * Anti-vacuity counters (checked in the trailing `it()`, after every
 * `test.prop` run has executed) confirm the generated runs actually included
 * a full five-consecutive-qualifying-rejection exhaustion AND a
 * non-qualifying-rejection propagation that did NOT exhaust all five
 * attempts -- the two cases design.md calls out by name.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const ManagedIdentifierService = require('../ManagedIdentifierService');
const {
  MAX_IDENTIFIER_ATTEMPTS,
  USERNAME_UNIQUE_CONSTRAINT,
  ManagedIdentifierExhaustionError
} = require('../ManagedIdentifierService');

// ---------------------------------------------------------------------------
// Rejection-sequence generators
// ---------------------------------------------------------------------------

/** The one qualifying rejection: exact code, exact constraint. */
const QUALIFYING_OUTCOME = Object.freeze({
  type: 'reject',
  code: '23505',
  constraint: USERNAME_UNIQUE_CONSTRAINT
});

const successOutcomeArb = fc.constant({ type: 'success' });

const CODES = ['23505', '23514', '23503', '42P01'];
const NAMED_CONSTRAINTS = ['users_username_key', 'users_email_key'];
const USERNAME_LOOKALIKE_CONSTRAINTS = [
  'users_username_lower_key',
  'users_username_key_v2',
  'legacy_users_username_key'
];

const codeArb = fc.constantFrom(...CODES);

const constraintArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...NAMED_CONSTRAINTS) },
  { weight: 2, arbitrary: fc.constant(undefined) },
  { weight: 2, arbitrary: fc.constantFrom(...USERNAME_LOOKALIKE_CONSTRAINTS) },
  { weight: 2, arbitrary: fc.string({ maxLength: 60 }) }
);

/** Any (code, constraint) pair EXCEPT the one qualifying combination. */
const nonQualifyingOutcomeArb = fc
  .tuple(codeArb, constraintArb)
  .filter(([code, constraint]) => !(code === '23505' && constraint === USERNAME_UNIQUE_CONSTRAINT))
  .map(([code, constraint]) => ({ type: 'reject', code, constraint }));

/** One attempt's outcome, biased toward qualifying so chains of retries are common. */
const freeSlotOutcomeArb = fc.oneof(
  { weight: 5, arbitrary: fc.constant(QUALIFYING_OUTCOME) },
  { weight: 2, arbitrary: successOutcomeArb },
  { weight: 3, arbitrary: nonQualifyingOutcomeArb }
);

/** The FREE arm: five independently drawn outcomes, broad coverage. */
const freeOutcomesArb = fc.array(freeSlotOutcomeArb, {
  minLength: MAX_IDENTIFIER_ATTEMPTS,
  maxLength: MAX_IDENTIFIER_ATTEMPTS
});

/**
 * The BOUNDARY arm: forces the leading run of qualifying rejections to be
 * exactly four or exactly five. When the leading run is five, all five
 * slots are qualifying (full exhaustion, the design's "count equals five"
 * boundary). When it is four, the fifth slot is an arbitrary success or
 * non-qualifying rejection (the "one short of exhaustion" boundary).
 */
const boundaryLeadingCountArb = fc.constantFrom(4, 5);
const boundaryTerminalArb = fc.oneof(
  { weight: 1, arbitrary: successOutcomeArb },
  { weight: 1, arbitrary: nonQualifyingOutcomeArb }
);
const boundaryOutcomesArb = fc
  .tuple(boundaryLeadingCountArb, boundaryTerminalArb)
  .map(([leadingCount, terminal]) => {
    const outcomes = [];
    for (let i = 0; i < MAX_IDENTIFIER_ATTEMPTS; i += 1) {
      outcomes.push(i < leadingCount ? QUALIFYING_OUTCOME : terminal);
    }
    return outcomes;
  });

const outcomesArb = fc.oneof(
  { weight: 1, arbitrary: boundaryOutcomesArb },
  { weight: 1, arbitrary: freeOutcomesArb }
);

// ---------------------------------------------------------------------------
// Organisation_Prefix generators -- valid and invalid, crossed with outcomes
// ---------------------------------------------------------------------------

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const alphanumericCharArb = fc.constantFrom(...ALPHANUMERIC.split(''));

const validPrefixArb = fc
  .array(alphanumericCharArb, { minLength: 1, maxLength: 24 })
  .map((chars) => chars.join(''));

const invalidPrefixArb = fc.constantFrom(
  '',
  null,
  undefined,
  42,
  'AUK-1',
  'has space',
  'semi;colon',
  '   '
);

const prefixCaseArb = fc.oneof(
  { weight: 1, arbitrary: validPrefixArb.map((prefix) => ({ prefix, validPrefix: true })) },
  { weight: 1, arbitrary: invalidPrefixArb.map((prefix) => ({ prefix, validPrefix: false })) }
);

const scenarioArb = fc.record({
  prefixCase: prefixCaseArb,
  typeMarker: fc.constantFrom('D', 'U'),
  organisationId: fc.integer({ min: 1, max: 999999 }),
  outcomes: outcomesArb
});

// ---------------------------------------------------------------------------
// Independent re-derivation: simulate the documented loop over the
// GENERATED outcome sequence alone, never by calling the subject.
// ---------------------------------------------------------------------------

function deriveExpectation(outcomes, validPrefix) {
  if (!validPrefix) {
    return { kind: 'invalidPrefix', attempts: 0 };
  }
  for (let i = 0; i < MAX_IDENTIFIER_ATTEMPTS; i += 1) {
    const outcome = outcomes[i];
    if (outcome.type === 'success') {
      return { kind: 'success', attempts: i + 1 };
    }
    const qualifies = outcome.code === '23505' && outcome.constraint === USERNAME_UNIQUE_CONSTRAINT;
    if (!qualifies) {
      return { kind: 'propagate', attempts: i + 1, code: outcome.code, constraint: outcome.constraint };
    }
    // Qualifying rejection: the loop continues to the next attempt.
  }
  return { kind: 'exhausted', attempts: MAX_IDENTIFIER_ATTEMPTS };
}

/**
 * A scripted `claim(candidate)`: returns/throws per `outcomes[callIndex]`,
 * one entry per call, in order. Records every call's candidate argument so
 * the test can assert the returned identifier equals the candidate from the
 * SUCCESSFUL call specifically.
 */
function createScriptedClaim(outcomes) {
  const calls = [];
  const claim = jest.fn(async (candidate) => {
    const index = calls.length;
    calls.push({ candidate, index });
    const outcome = outcomes[index];
    if (outcome.type === 'success') {
      return { claimedAtIndex: index };
    }
    const error = new Error(`simulated rejection ${outcome.code}/${String(outcome.constraint)}`);
    error.code = outcome.code;
    if (outcome.constraint !== undefined) {
      error.constraint = outcome.constraint;
    }
    throw error;
  });
  return { claim, calls };
}

// ---------------------------------------------------------------------------
// Anti-vacuity tracking, checked after every generated run has executed.
// ---------------------------------------------------------------------------

const seen = {
  invalidPrefix: 0,
  success: 0,
  exhausted: 0,
  propagateNotExhausted: 0,
  fourLeadingThenTerminate: 0
};

// Feature: takserver-enrollment, Property 3: The mint retries only on the username constraint, at most five times, and never substitutes an identifier
describe('Property 3: The mint retries only on the username constraint, at most five times, and never substitutes an identifier', () => {
  test.prop([scenarioArb], { numRuns: 300 })(
    'invokes claim at most five times, retries only on a qualifying rejection, and never substitutes an identifier',
    async (scenario) => {
      const { prefixCase, typeMarker, organisationId, outcomes } = scenario;
      const { prefix, validPrefix } = prefixCase;

      const expectation = deriveExpectation(outcomes, validPrefix);

      if (expectation.kind === 'invalidPrefix') seen.invalidPrefix += 1;
      if (expectation.kind === 'success') seen.success += 1;
      if (expectation.kind === 'exhausted') seen.exhausted += 1;
      if (expectation.kind === 'propagate' && expectation.attempts < MAX_IDENTIFIER_ATTEMPTS) {
        seen.propagateNotExhausted += 1;
      }
      if (expectation.attempts === 4 + 1 && expectation.kind !== 'exhausted') {
        seen.fourLeadingThenTerminate += 1;
      }

      const { claim, calls } = createScriptedClaim(outcomes);

      let outcome;
      try {
        const result = await ManagedIdentifierService.mintUniqueIdentifier({
          organisationPrefix: prefix,
          organisationId,
          typeMarker,
          claim
        });
        outcome = { threw: false, result };
      } catch (error) {
        outcome = { threw: true, error };
      }

      // At most five claim invocations, always -- the bounded-retry ceiling.
      expect(calls.length).toBeLessThanOrEqual(MAX_IDENTIFIER_ATTEMPTS);
      expect(calls.length).toBe(claim.mock.calls.length);
      expect(calls.length).toBe(expectation.attempts);

      // A further attempt occurs IFF the immediately preceding rejection was
      // exactly 23505/users_username_key -- re-derived from the GENERATED
      // sequence, not from the subject: every call before the last one must
      // have been fed a qualifying rejection, or the loop would not have
      // continued to it.
      for (let i = 0; i < calls.length - 1; i += 1) {
        expect(outcomes[i]).toEqual(QUALIFYING_OUTCOME);
      }

      if (expectation.kind === 'invalidPrefix') {
        // Zero claim invocations, no identifier emitted, when the
        // Organisation carries no valid Organisation_Prefix.
        expect(outcome.threw).toBe(true);
        expect(calls.length).toBe(0);
        expect(outcome.error).not.toBeInstanceOf(ManagedIdentifierExhaustionError);
      } else if (expectation.kind === 'exhausted') {
        // ManagedIdentifierExhaustionError when and only when five
        // consecutive qualifying rejections occurred.
        expect(outcome.threw).toBe(true);
        expect(outcome.error).toBeInstanceOf(ManagedIdentifierExhaustionError);
        expect(outcome.error.attempts).toBe(MAX_IDENTIFIER_ATTEMPTS);
        expect(outcome.error.organisationId).toBe(organisationId);
        expect(outcome.error.typeMarker).toBe(typeMarker);
      } else if (expectation.kind === 'success') {
        // An identifier is returned only when a claim succeeded, and it
        // equals the candidate generated for THAT attempt.
        expect(outcome.threw).toBe(false);
        const successCall = calls[calls.length - 1];
        expect(outcome.result.username).toBe(successCall.candidate);
        expect(outcome.result.claim).toEqual({ claimedAtIndex: successCall.index });
      } else {
        // 'propagate': any other rejection propagates UNCHANGED on its
        // first occurrence, with no further attempt after it, and no
        // identifier is substituted.
        expect(outcome.threw).toBe(true);
        expect(outcome.error).not.toBeInstanceOf(ManagedIdentifierExhaustionError);
        expect(outcome.error.code).toBe(expectation.code);
        if (expectation.constraint === undefined) {
          expect(outcome.error.constraint).toBeUndefined();
        } else {
          expect(outcome.error.constraint).toBe(expectation.constraint);
        }
      }
    }
  );

  it('exercised full exhaustion and a non-exhausting non-qualifying propagation (anti-vacuity)', () => {
    // At least one generated run reached the fifth attempt (full exhaustion).
    expect(seen.exhausted).toBeGreaterThan(0);
    // At least one generated run propagated a non-qualifying error without
    // exhausting all five attempts.
    expect(seen.propagateNotExhausted).toBeGreaterThan(0);
    // Sanity: the other two reachable outcomes were exercised too, and the
    // four-leading-then-terminate boundary was actually hit.
    expect(seen.invalidPrefix).toBeGreaterThan(0);
    expect(seen.success).toBeGreaterThan(0);
    expect(seen.fourLeadingThenTerminate).toBeGreaterThan(0);
  });
});
