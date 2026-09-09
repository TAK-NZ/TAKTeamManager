// Feature: callsign-mismatch-detection, Property 1: append-only acceptance
//
// **Validates: the append-only callsign rule (docs/ARCHITECTURE.md ("Callsign Mismatch Detection" section)
// Phase 1): observed is acceptable iff it equals the assigned callsign, or
// extends it with a non-alphanumeric boundary character; every other divergence
// is a mismatch; an absent assigned callsign never manufactures a violation.**
//
// Independent re-derivation: the expectation is computed from the generated
// inputs and the rule as stated in the design note (equality, or assigned
// followed by a non-[A-Za-z0-9] character), NEVER by calling the subject. The
// subject is `classifyObservedCallsign`; re-implementing its verdict here from
// the criteria — not importing its logic — is what makes this measure the rule
// rather than mere determinism.

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const {
  CALLSIGN_MATCH_RESULTS,
  classifyObservedCallsign
} = require('./callsignMatch');

// A realistic-ish assigned callsign generator: non-empty, with the segment
// separators and characters real callsigns carry, plus a broad arm.
const assignedArb = fc.oneof(
  fc.constantFrom('FENZ-STL-J.Doe', 'NSW-SYD-A.Smith', 'FJI-FIRE-K.Kokako', 'ORG-Name'),
  fc.string({ minLength: 1, maxLength: 20 })
);

// Characters that DO and DO NOT form a valid append boundary, concentrated at
// the boundary of the rule (the single most load-bearing decision).
const boundaryChar = fc.constantFrom(' ', '-', '(', '.', '/', ')', '_', '#', ':');
const alnumChar = fc.constantFrom('a', 'Z', '0', '9', 'm', 'X');

describe('append-only acceptance property', () => {
  test.prop([assignedArb])('exact equality is always ok', (assigned) => {
    expect(classifyObservedCallsign(assigned, assigned)).toBe(CALLSIGN_MATCH_RESULTS.OK);
  });

  test.prop([assignedArb, boundaryChar, fc.string({ maxLength: 12 })])(
    'assigned + non-alphanumeric boundary + anything is appended',
    (assigned, boundary, rest) => {
      const observed = `${assigned}${boundary}${rest}`;
      expect(classifyObservedCallsign(observed, assigned)).toBe(CALLSIGN_MATCH_RESULTS.APPENDED);
    }
  );

  test.prop([assignedArb, alnumChar, fc.string({ maxLength: 12 })])(
    'assigned immediately followed by an alphanumeric char is a mismatch (the boundary rule)',
    (assigned, alnum, rest) => {
      const observed = `${assigned}${alnum}${rest}`;
      expect(classifyObservedCallsign(observed, assigned)).toBe(CALLSIGN_MATCH_RESULTS.MISMATCH);
    }
  );

  test.prop([
    fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.constant(''),
      fc.integer(),
      fc.object()
    ),
    fc.string({ maxLength: 20 })
  ])('an absent assigned callsign is never a violation', (assigned, observed) => {
    expect(classifyObservedCallsign(observed, assigned)).toBe(CALLSIGN_MATCH_RESULTS.OK);
  });

  // The general re-derivation: for any pair of strings, the subject must agree
  // with the rule computed independently from the criteria. Boundary-concentrated
  // by building observed values that frequently share a prefix with assigned.
  test.prop([
    fc.oneof(
      fc.constantFrom('FENZ-STL-J.Doe', 'ORG-Name', 'X'),
      fc.string({ minLength: 1, maxLength: 10 })
    ),
    fc.oneof(
      // shares a prefix often
      fc.constantFrom('', ' ', '-x', '(Tablet)', 'x', 's', '.5'),
      fc.string({ maxLength: 14 })
    )
  ])('agrees with the independently re-derived rule for prefix-and-suffix pairs', (assigned, suffix) => {
    const observed = `${assigned}${suffix}`;
    const expected = deriveVerdict(observed, assigned);
    expect(classifyObservedCallsign(observed, assigned)).toBe(expected);
  });

  test.prop([
    fc.string({ minLength: 1, maxLength: 16 }),
    fc.string({ maxLength: 16 })
  ])('agrees with the independently re-derived rule for arbitrary pairs', (assigned, observed) => {
    const expected = deriveVerdict(observed, assigned);
    const actual = classifyObservedCallsign(observed, assigned);
    expect(actual).toBe(expected);
  });
});

/**
 * The rule, re-implemented from the design note's criteria (NOT from the
 * subject): equality -> ok; assigned present, observed starts with assigned and
 * the next char is non-alphanumeric -> appended; otherwise -> mismatch. Assigned
 * absent -> ok.
 */
function deriveVerdict(observed, assigned) {
  if (typeof assigned !== 'string' || assigned === '') return CALLSIGN_MATCH_RESULTS.OK;
  if (typeof observed !== 'string' || observed === '') return CALLSIGN_MATCH_RESULTS.MISMATCH;
  if (observed === assigned) return CALLSIGN_MATCH_RESULTS.OK;
  if (observed.startsWith(assigned)) {
    const next = observed.charAt(assigned.length);
    if (!/[A-Za-z0-9]/.test(next)) return CALLSIGN_MATCH_RESULTS.APPENDED;
  }
  return CALLSIGN_MATCH_RESULTS.MISMATCH;
}
