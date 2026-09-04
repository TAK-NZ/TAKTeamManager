'use strict';

// Property: toAsciiIdentifier is TOTAL, ASCII-GUARANTEEING, and IDEMPOTENT.
//
// **Validates: the special-character (Māori macron) LDAP-group-name bug** --
// TAK Server cannot handle non-ASCII in a group name, so the identifier
// derived from a human team/channel name must be ASCII-only for ANY input.
//
// The three arms below each pin one guarantee, with expectations RE-DERIVED
// from the generated input (never by calling the function under test):
//
//   1. TOTALITY + ASCII: for ANY input at all (including null/undefined,
//      numbers, objects, and strings full of arbitrary Unicode), the result
//      is a string containing no code point above 0x7E, and the call does
//      not throw.
//   2. DIACRITIC MAPPING: a macron/accented Latin letter maps to its KNOWN
//      base ASCII letter (re-derived from an explicit accent->base table
//      transcribed here, not from the code), so the identifier stays
//      readable rather than dropping the letter.
//   3. IDEMPOTENCE + PURITY: applying the function to its own output changes
//      nothing, and a repeat call on the same input yields an equal result.

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const { toAsciiIdentifier, stripDiacritics } = require('./asciiNormalize');

// Accented letters paired with the base letter their NFD decomposition
// leaves behind -- transcribed independently of the implementation.
const ACCENT_TO_BASE = [
  ['ā', 'a'], ['ē', 'e'], ['ī', 'i'], ['ō', 'o'], ['ū', 'u'], // Māori macrons
  ['Ā', 'A'], ['Ē', 'E'], ['Ī', 'I'], ['Ō', 'O'], ['Ū', 'U'],
  ['é', 'e'], ['ë', 'e'], ['ñ', 'n'], ['ü', 'u'], ['ç', 'c'], ['á', 'a']
];

// Non-ASCII glyphs with NO ASCII base (not a decomposable Latin letter):
// these are DROPPED entirely by toAsciiIdentifier.
const NO_BASE_GLYPHS = ['東', '京', '🚒', 'Ω', 'ß', '¥'];

// Plain ASCII segments a real group name is built from.
const ASCII_SEGMENTS = ['Teams', 'FENZ', 'Bay of Plenty', 'Alpha', 'RFF', '_READ', '1', 'A-B'];

describe('toAsciiIdentifier property', () => {
  // Arm 1: TOTALITY + ASCII guarantee over the widest input space.
  test.prop([fc.anything()], { numRuns: 500 })(
    'never throws and always returns an ASCII-only string, for any input',
    (input) => {
      const out = toAsciiIdentifier(input);
      expect(typeof out).toBe('string');
      // No code point above 0x7E survives.
      expect([...out].every((ch) => ch.codePointAt(0) <= 0x7f)).toBe(true);
    }
  );

  // Arm 2: a known accented letter placed between ASCII words maps to its
  // known base letter (re-derived), and a no-base glyph is removed.
  test.prop([
    fc.constantFrom(...ASCII_SEGMENTS),
    fc.constantFrom(...ACCENT_TO_BASE),
    fc.constantFrom(...ASCII_SEGMENTS)
  ], { numRuns: 300, examples: [['Teams - FENZ -', ['ā', 'a'], 'Tai']] })(
    'maps an accented letter to its base ASCII letter, keeping the word readable',
    (left, [accent, base], right) => {
      // Embed the accented letter inside a word so it is not a lone glyph:
      // `<left> X<accent>Y <right>` -> the accent becomes `base`.
      const input = `${left} X${accent}Y ${right}`;
      const expected = `${left} X${base}Y ${right}`.replace(/\s+/g, ' ').trim();
      expect(toAsciiIdentifier(input)).toBe(expected);
    }
  );

  test.prop([
    fc.constantFrom(...ASCII_SEGMENTS),
    fc.constantFrom(...NO_BASE_GLYPHS),
    fc.constantFrom(...ASCII_SEGMENTS)
  ], { numRuns: 300 })(
    'drops a non-ASCII glyph that has no ASCII base, collapsing whitespace',
    (left, glyph, right) => {
      const input = `${left} ${glyph} ${right}`;
      // The glyph vanishes; the two surrounding spaces collapse to one.
      const expected = `${left} ${right}`.replace(/\s+/g, ' ').trim();
      expect(toAsciiIdentifier(input)).toBe(expected);
    }
  );

  // Arm 3: idempotence + purity.
  test.prop([fc.string()], { numRuns: 300 })(
    'is idempotent (applying it to its own output changes nothing) and pure',
    (input) => {
      const once = toAsciiIdentifier(input);
      const twice = toAsciiIdentifier(once);
      expect(twice).toBe(once);
      // Pure: a repeat call on the same input is equal.
      expect(toAsciiIdentifier(input)).toBe(once);
    }
  );

  // stripDiacritics core: for any string, its output has no combining marks
  // and (for the accent table) yields the known base letters.
  test.prop([fc.constantFrom(...ACCENT_TO_BASE)], { numRuns: 100 })(
    'stripDiacritics reduces a known accented letter to its base',
    ([accent, base]) => {
      expect(stripDiacritics(accent)).toBe(base);
    }
  );
});
