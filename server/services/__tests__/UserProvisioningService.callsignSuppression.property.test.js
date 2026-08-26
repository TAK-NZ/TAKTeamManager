// Feature: takserver-enrollment, Property 8: Callsign_Default_Suppression computes no default and demands an explicit value
//
// **Validates: Requirements 9.1, 9.2, 9.4**

/**
 * takserver-enrollment task 5.7: the single fast-check property test for
 * design.md's Property 8 (Requirements 9.1, 9.2, 9.4).
 *
 * `UserProvisioningService.resolveNewUserIdentity` is exercised directly.
 * `Team.getAncestorChain` is mocked to return a generated Ancestor_Chain
 * (root at index 0) carrying a generated `pseudonymous_usernames` policy
 * value, `callsign_prefix`, and `callsign_name_format`.
 * `CallsignSuffixUniquenessService.checkCallsignSuffixUniqueness` is
 * mocked to always resolve (no collision), so this test isolates JUST the
 * suppression/default-computation decision. `../../config/database`'s
 * `query` is mocked for the Claim_Row insert the pseudonymous/mint branch
 * issues, returning a fake row id.
 *
 * The requested Callsign_Suffix is drawn from a generator concentrated on
 * blank forms (`undefined`, `null`, `''`, whitespace of several kinds)
 * plus the blank/one-visible-character boundary plus a broad arbitrary-
 * string arm, per the task's boundary-concentration instruction.
 *
 * The single most important assertion in this file is the spy on
 * `CallsignService.computeDefaultCallsignSuffix`: WHERE the policy is
 * enabled, that function must NEVER be invoked, for ANY input -- not just
 * "the returned value doesn't look name-derived", because an
 * implementation that computes the default and discards it would still
 * put the user's name through the function and would still be wrong the
 * moment something reads the discarded value back. `CallsignService` is
 * NOT module-mocked (a `jest.spyOn` on the real, un-mocked module) so the
 * policy-disabled branch's expectation can be independently re-derived by
 * calling the REAL function directly in this test, per the task's
 * instruction for that branch.
 */

jest.mock('../../models/Team', () => ({
  getAncestorChain: jest.fn()
}));

jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../CallsignSuffixUniquenessService', () => ({
  checkCallsignSuffixUniqueness: jest.fn()
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const Team = require('../../models/Team');
const pool = require('../../config/database');
const { checkCallsignSuffixUniqueness } = require('../CallsignSuffixUniquenessService');
const CallsignService = require('../CallsignService');
const UserProvisioningService = require('../UserProvisioningService');

// ---------------------------------------------------------------------------
// Requested-Callsign_Suffix generator: concentrated on blank forms and on
// the blank / one-visible-character boundary, plus a broad arbitrary arm.
// ---------------------------------------------------------------------------

/** Unambiguous blank forms, drawn broadly across whitespace kinds. */
const blankFormsArb = fc.constantFrom(
  undefined,
  null,
  '',
  ' ',
  '   ',
  '\t',
  '\n',
  '\r',
  '\t\n\r ',
  '\u00A0', // NO-BREAK SPACE
  '\u2003', // EM SPACE
  '\u2028', // LINE SEPARATOR
  '\uFEFF' // BOM / ZERO WIDTH NO-BREAK SPACE -- also whitespace under JS trim()
);

/** The blank <-> one-visible-character boundary, both directions. */
const boundaryArb = fc.constantFrom(
  '',
  ' ',
  'a',
  ' a',
  'a ',
  ' a ',
  '\ta',
  'a\n',
  'ab'
);

/** A broad, uniform arm of arbitrary (mostly non-blank) strings. */
const broadStringArb = fc.string({ maxLength: 40 });

const requestedCallsignSuffixArb = fc.oneof(
  { weight: 4, arbitrary: blankFormsArb },
  { weight: 3, arbitrary: boundaryArb },
  { weight: 3, arbitrary: broadStringArb }
);

// ---------------------------------------------------------------------------
// Ancestor_Chain generator: root at index 0 carries the policy value, the
// Organisation_Prefix and the `callsign_name_format`; zero to three extra
// (non-root) elements extend the chain so both one-element and
// multi-element chains are exercised.
// ---------------------------------------------------------------------------

const CALLSIGN_NAME_FORMATS = [
  'full_name',
  'first_initial_last',
  'first_last_initial',
  'first_initial_dot_last',
  'user_defined'
];

const organisationPrefixArb = fc.constantFrom('AUK', 'WLG', 'CHC', 'TAK1');
const pseudonymousArb = fc.constantFrom(true, false, null);
const extraDepthArb = fc.integer({ min: 0, max: 3 });

function buildAncestorChain({ organisationId, pseudonymous, organisationPrefix, callsignNameFormat, extraDepth }) {
  const root = {
    id: organisationId,
    parent_team_id: null,
    callsign_name_format: callsignNameFormat,
    pseudonymous_usernames: pseudonymous,
    callsign_prefix: organisationPrefix,
    depth: 0
  };
  const chain = [root];
  for (let i = 0; i < extraDepth; i += 1) {
    chain.push({
      id: organisationId * 100 + i + 1,
      parent_team_id: chain[chain.length - 1].id,
      // A Sub_Team never carries `pseudonymous_usernames` (Organisation-only
      // per Criterion 6.2) and inherits `callsign_name_format` from the
      // Organisation -- reflected here rather than re-decided, since only
      // index 0 is ever read by the function under test.
      callsign_name_format: callsignNameFormat,
      pseudonymous_usernames: null,
      depth: i + 1
    });
  }
  return chain;
}

const scenarioArb = fc.record({
  organisationId: fc.integer({ min: 1, max: 999999 }),
  teamId: fc.integer({ min: 1, max: 999999 }),
  pseudonymous: pseudonymousArb,
  organisationPrefix: organisationPrefixArb,
  callsignNameFormat: fc.constantFrom(...CALLSIGN_NAME_FORMATS),
  extraDepth: extraDepthArb,
  requestedCallsignSuffix: requestedCallsignSuffixArb,
  firstName: fc.string({ maxLength: 15 }),
  lastName: fc.string({ maxLength: 15 }),
  claimRowId: fc.integer({ min: 1, max: 999999 })
});

// ---------------------------------------------------------------------------
// Anti-vacuity counters, checked in the trailing it().
// ---------------------------------------------------------------------------

const seen = {
  policyEnabledBlank: 0,
  policyEnabledNonBlank: 0,
  disabledUserDefinedBlank: 0,
  disabledNonUserDefinedBlank: 0
};

describe('Property 8: Callsign_Default_Suppression computes no default and demands an explicit value', () => {
  let computeDefaultSpy;

  beforeAll(() => {
    // A spy that CALLS THROUGH to the real implementation -- CallsignService
    // is never module-mocked, so the policy-disabled branch's expectation
    // can call the same real function directly, and the policy-enabled
    // branch's expectation is a genuine "was this ever invoked" check
    // rather than a value-only inference.
    computeDefaultSpy = jest.spyOn(CallsignService, 'computeDefaultCallsignSuffix');
  });

  afterAll(() => {
    computeDefaultSpy.mockRestore();
  });

  test.prop([scenarioArb], { numRuns: 250 })(
    'never computes a name-derived default when pseudonymous, and matches today\'s resolution otherwise',
    async (scenario) => {
      const {
        organisationId,
        teamId,
        pseudonymous,
        organisationPrefix,
        callsignNameFormat,
        extraDepth,
        requestedCallsignSuffix,
        firstName,
        lastName,
        claimRowId
      } = scenario;

      // Fresh mocks each run -- mockReset (not mockClear) so no queued
      // `...Once` implementation from a prior run's unused branch leaks
      // into this one. The spy itself is only cleared of call history,
      // never reset, so its call-through behaviour survives.
      Team.getAncestorChain.mockReset();
      checkCallsignSuffixUniqueness.mockReset();
      pool.query.mockReset();
      computeDefaultSpy.mockClear();

      const ancestorChain = buildAncestorChain({
        organisationId,
        pseudonymous,
        organisationPrefix,
        callsignNameFormat,
        extraDepth
      });
      Team.getAncestorChain.mockResolvedValue(ancestorChain);
      checkCallsignSuffixUniqueness.mockResolvedValue(undefined);
      pool.query.mockResolvedValue({ rows: [{ id: claimRowId }] });

      // Independent re-derivation of "blank", matching the plain-language
      // definition of Callsign_Default_Suppression's trigger (Criterion
      // 9.2): no value, or a value that is nothing but whitespace once
      // trimmed. `.trim()` is a language builtin, not part of the subject's
      // decision logic, so using it here to classify the INPUT is not
      // "computing the expectation with the function under test".
      const trimmedRequested = requestedCallsignSuffix ? requestedCallsignSuffix.trim() : '';
      const isBlank = trimmedRequested === '';

      const isPolicyEnabled = pseudonymous === true;

      let outcome;
      try {
        const result = await UserProvisioningService.resolveNewUserIdentity(null, {
          firstName,
          lastName,
          email: 'suppression.subject@example.com',
          teamId,
          requestedUsername: 'requested.username',
          requestedCallsignSuffix
        });
        outcome = { threw: false, result };
      } catch (error) {
        outcome = { threw: true, error };
      }

      if (isPolicyEnabled) {
        // THE critical assertion: for ANY input, when pseudonymous, the
        // name-derived default is never even computed, let alone returned.
        expect(computeDefaultSpy).not.toHaveBeenCalled();

        if (isBlank) {
          seen.policyEnabledBlank += 1;
          expect(outcome.threw).toBe(true);
          expect(outcome.error).toBeInstanceOf(UserProvisioningService.CallsignSuffixRequiredError);
          // A request-validation failure never reaches the mint/Claim_Row.
          expect(pool.query).not.toHaveBeenCalled();
          expect(checkCallsignSuffixUniqueness).not.toHaveBeenCalled();
        } else {
          seen.policyEnabledNonBlank += 1;
          expect(outcome.threw).toBe(false);
          expect(outcome.result.callsignSuffix).toBe(trimmedRequested);
          expect(checkCallsignSuffixUniqueness).toHaveBeenCalledWith(teamId, trimmedRequested);
        }
      } else {
        // Policy disabled (`false` or `null`): resolution must match
        // exactly what today's (pre-suppression) logic computes for the
        // same input.
        if (callsignNameFormat === 'user_defined') {
          if (isBlank) {
            seen.disabledUserDefinedBlank += 1;
            expect(outcome.threw).toBe(true);
            expect(outcome.error).toBeInstanceOf(UserProvisioningService.CallsignSuffixRequiredError);
          } else {
            expect(outcome.threw).toBe(false);
            expect(outcome.result.callsignSuffix).toBe(trimmedRequested);
          }
          // `user_defined` computes no default at all, blank or not.
          expect(computeDefaultSpy).not.toHaveBeenCalled();
        } else if (!isBlank) {
          expect(outcome.threw).toBe(false);
          expect(outcome.result.callsignSuffix).toBe(trimmedRequested);
          expect(computeDefaultSpy).not.toHaveBeenCalled();
        } else {
          seen.disabledNonUserDefinedBlank += 1;
          // Independently re-derived by calling the REAL dependency
          // directly, per the task's instruction for this branch.
          const expectedDefault = CallsignService.computeDefaultCallsignSuffix(
            firstName,
            lastName,
            callsignNameFormat
          );
          expect(outcome.threw).toBe(false);
          expect(outcome.result.callsignSuffix).toBe(expectedDefault);
        }
      }
    }
  );

  it('exercised all four suppression/default-computation cases (anti-vacuity)', () => {
    expect(seen.policyEnabledBlank).toBeGreaterThan(0);
    expect(seen.policyEnabledNonBlank).toBeGreaterThan(0);
    expect(seen.disabledUserDefinedBlank).toBeGreaterThan(0);
    expect(seen.disabledNonUserDefinedBlank).toBeGreaterThan(0);
  });
});
