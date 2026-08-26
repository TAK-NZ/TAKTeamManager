// Feature: takserver-enrollment, Property 9: Authentik email normalisation is total and never yields an empty string
//
// **Validates: Requirements 5.5**

/**
 * takserver-enrollment task 3.2: the single fast-check property test for
 * design.md's Property 9 (Requirement 5.5).
 *
 * design.md's exact Property 9 statement: "For any input -- including `''`,
 * whitespace-only strings of arbitrary length and composition, `null`,
 * `undefined`, `NaN`, numbers, booleans, `Symbol`s, `BigInt`s, arrays, plain
 * objects, objects whose `valueOf` and `toString` throw, and arbitrary
 * non-empty strings -- `normaliseAuthentikEmail` SHALL return either `null`
 * or a non-empty string carrying no leading or trailing whitespace; SHALL
 * never return `''`; SHALL never throw; and SHALL be a pure function of its
 * argument alone."
 *
 * The property is split across several `test.prop` blocks, each targeting one
 * clause of that sentence, because a single arbitrary wide enough for all of
 * them would exercise none often enough to matter:
 *
 *   1. TOTALITY AND SHAPE -- the widest input space (`fc.anything()`-style
 *      coverage assembled explicitly below, since a bare `fc.anything()`
 *      under-samples the whitespace and hostile-object shapes this property
 *      cares about): never throws, and the return is either `null` or a
 *      non-empty, untrimmed-boundary-free string.
 *   2. INDEPENDENT RE-DERIVATION -- every input compared against
 *      `expectedNormalise` below, an oracle written from Criterion 5.5's text
 *      using `typeof` and `String.prototype.trim` directly, never by calling
 *      `normaliseAuthentikEmail` and comparing it to itself. Agreement with
 *      this oracle is evidence the function implements the rule, not merely
 *      that it is deterministic.
 *   3. PURITY -- the same argument yields the same result across repeated
 *      calls, interleaved with unrelated calls to the same function, and an
 *      object or array argument is left structurally unchanged by the call.
 *   4. BOUNDARY CONCENTRATION -- the exact line between "trims to empty" and
 *      "trims to non-empty": a single space vs. a space plus one visible
 *      character, an empty string vs. a single character, and the
 *      non-breaking-space / BOM analogues of both. A generator drawing
 *      uniformly over long strings would essentially never land exactly on
 *      this line.
 *
 * A pair of module-scoped flags (`sawNullResult` / `sawNonNullResult`) is set
 * from inside the first `test.prop` block and asserted in a final `it()` that
 * runs after it in file order, so the whole property cannot pass vacuously by
 * only ever exercising one side of the null / non-null split.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const { normaliseAuthentikEmail } = require('./authentikEmail');

// ---------------------------------------------------------------------------
// Oracle -- Criterion 5.5's text restated with `typeof` and `.trim()`,
// independent of the module under test.
// ---------------------------------------------------------------------------

/**
 * Re-derives the expected result directly from Criterion 5.5: `null` for
 * `null`, `undefined`, any non-string, `''` and any whitespace-only string;
 * otherwise the trimmed string. Uses the language's own `.trim()` rather
 * than the subject's internal logic, so agreement is evidence rather than a
 * restatement of the implementation.
 *
 * @param {*} value
 * @returns {string|null}
 */
function expectedNormalise(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Whitespace characters JavaScript's `.trim()` strips: plain ASCII space,
 * tab, newline, carriage return, vertical tab, form feed, the non-breaking
 * space, and a handful of other Unicode space/line-terminator characters
 * (`\u2028` line separator, `\u2029` paragraph separator, `\u3000`
 * ideographic space, `\u2003` em space, `\u2009` thin space, `\uFEFF`
 * zero-width no-break space/BOM, which `.trim()` treats as whitespace too).
 */
const WHITESPACE_CHARS = [
  ' ',
  '\t',
  '\n',
  '\r',
  '\v',
  '\f',
  '\u00A0',
  '\u2028',
  '\u2029',
  '\u3000',
  '\u2003',
  '\u2009',
  '\uFEFF'
];

const whitespaceCharArb = fc.constantFrom(...WHITESPACE_CHARS);

/** A whitespace-only string of arbitrary length and composition, including `''`. */
const whitespaceOnlyStringArb = fc
  .array(whitespaceCharArb, { minLength: 0, maxLength: 40 })
  .map((chars) => chars.join(''));

/** An arbitrary non-empty "real" string, padded on both sides with whitespace. */
const paddedNonEmptyStringArb = fc
  .tuple(whitespaceOnlyStringArb, fc.string({ minLength: 1 }), whitespaceOnlyStringArb)
  .map(([lead, core, trail]) => lead + core + trail);

/** Three hostile objects, each throwing from a different combination of the two coercion hooks. */
const HOSTILE_OBJECTS = [
  {
    valueOf() {
      throw new Error('hostile valueOf');
    },
    toString() {
      return 'safe-tostring';
    }
  },
  {
    valueOf() {
      return 42;
    },
    toString() {
      throw new Error('hostile toString');
    }
  },
  {
    valueOf() {
      throw new Error('hostile valueOf');
    },
    toString() {
      throw new Error('hostile toString');
    }
  }
];
const hostileObjectArb = fc.constantFrom(...HOSTILE_OBJECTS);

/** Non-string primitives and exotic values named explicitly in the property statement. */
const nonStringPrimitiveArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(NaN),
  fc.constant(Infinity),
  fc.constant(-Infinity),
  fc.constant(0),
  fc.constant(-0),
  fc.double(),
  fc.integer(),
  fc.boolean(),
  fc.constant(Symbol('probe')),
  fc.bigInt()
);

/** Non-string object/array shapes, including a null-prototype object. */
const nonStringObjectArb = fc.oneof(
  fc.array(fc.anything()),
  fc.object(),
  fc.constant(Object.create(null)),
  hostileObjectArb
);

/** The full totality space the property statement enumerates. */
const totalityArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant('') },
  { weight: 4, arbitrary: whitespaceOnlyStringArb },
  { weight: 3, arbitrary: nonStringPrimitiveArb },
  { weight: 3, arbitrary: nonStringObjectArb },
  { weight: 4, arbitrary: fc.string() },
  { weight: 4, arbitrary: paddedNonEmptyStringArb }
);

/**
 * The exact boundary between "trims to empty" and "trims to non-empty":
 * nothing, one whitespace character, one visible character, and a visible
 * character with whitespace on one or both sides -- crossed with plain ASCII
 * space and its non-breaking-space / BOM analogues, since those are the
 * shapes a naive `/\s/`-based check (rather than `.trim()`) gets wrong.
 */
const boundaryArb = fc.constantFrom(
  '',
  ' ',
  '\t',
  '\n',
  '\u00A0',
  '\uFEFF',
  '  ',
  'a',
  ' a',
  'a ',
  ' a ',
  '\u00A0a',
  'a\u00A0',
  '\uFEFFa',
  'a\uFEFF',
  '\u00A0\u00A0a\u00A0\u00A0'
);

// ---------------------------------------------------------------------------
// Anti-vacuity flags, asserted in the trailing `it()` below.
// ---------------------------------------------------------------------------

let sawNullResult = false;
let sawNonNullResult = false;

// Feature: takserver-enrollment, Property 9: Authentik email normalisation is total and never yields an empty string
describe('Property 9: Authentik email normalisation is total and never yields an empty string', () => {
  test.prop([totalityArb], { numRuns: 300 })(
    'never throws, and returns either null or a non-empty string with no leading or trailing whitespace, for any input',
    (value) => {
      let result;
      expect(() => {
        result = normaliseAuthentikEmail(value);
      }).not.toThrow();

      if (result === null) {
        sawNullResult = true;
      } else {
        // NEVER '', and never carrying whitespace at either edge -- a value
        // that trimmed to '' must have been reported as null instead.
        expect(typeof result).toBe('string');
        expect(result).not.toBe('');
        expect(result.trim()).toBe(result);
        sawNonNullResult = true;
      }
    }
  );

  test.prop([totalityArb], { numRuns: 300 })(
    'agrees with the independently re-derived trim/empty rule from Criterion 5.5, for any input',
    (value) => {
      expect(normaliseAuthentikEmail(value)).toBe(expectedNormalise(value));
    }
  );

  test.prop([fc.oneof(totalityArb, boundaryArb)], { numRuns: 300 })(
    'is a pure function of its argument alone: repeated and interleaved calls agree, and the argument is left unchanged',
    (value) => {
      const before = normaliseAuthentikEmail(value);

      // Unrelated calls, with unrelated inputs, in between -- so a result
      // cached or derived from any shared mutable state would be caught by
      // the second call below disagreeing with the first.
      normaliseAuthentikEmail('unrelated-probe@example.com');
      normaliseAuthentikEmail(null);
      normaliseAuthentikEmail(42);

      expect(normaliseAuthentikEmail(value)).toBe(before);

      // An array or plain object argument is not mutated by the call: since
      // the function is total over non-strings, `typeof value !== 'string'`
      // objects/arrays are captured structurally before the call (skipping
      // the hostile objects, whose own accessors throw on coercion and
      // cannot be structurally cloned) and compared after.
      if (Array.isArray(value)) {
        const snapshot = [...value];
        normaliseAuthentikEmail(value);
        expect(value).toEqual(snapshot);
      } else if (
        value !== null &&
        typeof value === 'object' &&
        typeof value.valueOf === 'function' &&
        typeof value.toString === 'function' &&
        !HOSTILE_OBJECTS.includes(value)
      ) {
        const snapshotKeys = Object.keys(value);
        normaliseAuthentikEmail(value);
        expect(Object.keys(value)).toEqual(snapshotKeys);
      }
    }
  );

  test.prop([boundaryArb], {
    numRuns: 200,
    examples: [[''], [' '], [' a'], ['a '], ['\u00A0'], ['\u00A0a'], ['\uFEFF'], ['\uFEFFa']]
  })(
    'draws the null/non-null line exactly at "trims to empty" vs "trims to non-empty"',
    (value) => {
      const result = normaliseAuthentikEmail(value);
      const trimmed = value.trim();

      if (trimmed === '') {
        expect(result).toBeNull();
      } else {
        expect(result).toBe(trimmed);
        expect(result).not.toBe('');
      }
    }
  );

  it('exercised at least one input landing on each side of the null / non-null split (anti-vacuity)', () => {
    expect(sawNullResult).toBe(true);
    expect(sawNonNullResult).toBe(true);
  });
});
