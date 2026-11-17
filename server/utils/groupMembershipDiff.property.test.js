// Feature: skip-noop-owned-group-patch, Property 1: a PATCH is skipped exactly when the member sets are provably equal
//
// **Validates: the owned-group reconcile skips the full-replace PATCH only when
// Authentik's current member set equals the set about to be written. It must
// never skip when a member would be added or removed, and a representation
// difference (number vs string pk, order, duplicates) is not a difference.**
//
// Independent re-derivation: the expectation is computed from the generated
// integers with plain sorted-unique comparison, NEVER by calling the subject or
// by sharing its normalisation. Pks are drawn from a small range so that equal
// sets, supersets, subsets and single-member differences all occur often.
const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const { sameMemberSet } = require('./groupMembershipDiff');

// A small pk range makes collisions (and therefore equal sets) common.
const pkInt = fc.integer({ min: 0, max: 6 });

// One member as Authentik or our DB might hand it over: number, numeric string,
// or a padded numeric string.
const asRepresentation = (n, mode) => {
  if (mode === 0) return n;
  if (mode === 1) return String(n);
  return ` ${n} `;
};

const members = fc.array(fc.tuple(pkInt, fc.integer({ min: 0, max: 2 })), { maxLength: 8 });

const sortedUnique = (tuples) => [...new Set(tuples.map(([n]) => n))].sort((a, b) => a - b);

describe('sameMemberSet is true exactly when the integer member sets are equal', () => {
  test.prop([members, members], { numRuns: 1000 })(
    'agrees with an independently derived set comparison, whatever the representation',
    (a, b) => {
      const expected = JSON.stringify(sortedUnique(a)) === JSON.stringify(sortedUnique(b));
      const actual = sameMemberSet(
        a.map(([n, m]) => asRepresentation(n, m)),
        b.map(([n, m]) => asRepresentation(n, m))
      );
      expect({ actual, a: sortedUnique(a), b: sortedUnique(b) }).toEqual({
        actual: expected,
        a: sortedUnique(a),
        b: sortedUnique(b)
      });
    }
  );

  // Boundary concentration: a set and the SAME set with one member added or
  // removed. These are the cases a wrong comparison (length-only, subset-only)
  // would get wrong, so they are generated directly, not left to chance.
  test.prop([members, pkInt, fc.boolean()], { numRuns: 1000 })(
    'a set versus itself with one member added or removed',
    (base, extra, remove) => {
      const baseSet = sortedUnique(base);
      const withExtra = baseSet.includes(extra) ? baseSet : [...baseSet, extra];
      const changed = remove && baseSet.length > 0 ? baseSet.slice(1) : withExtra;
      const expectedEqual = JSON.stringify([...changed].sort((x, y) => x - y)) === JSON.stringify(baseSet);
      expect(sameMemberSet(baseSet, changed)).toBe(expectedEqual);
      // Anti-vacuity: the generator really did produce differing sets in some runs;
      // when it did, the verdict must be false.
      if (!expectedEqual) expect(sameMemberSet(baseSet, changed)).toBe(false);
    }
  );
});
