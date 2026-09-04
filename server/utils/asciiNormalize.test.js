'use strict';

const { stripDiacritics, toAsciiIdentifier } = require('./asciiNormalize');

describe('stripDiacritics', () => {
  it('reduces Māori macrons to their base ASCII letter', () => {
    expect(stripDiacritics('Ngā Tai ki te Puku')).toBe('Nga Tai ki te Puku');
    expect(stripDiacritics('Kōkako')).toBe('Kokako');
    expect(stripDiacritics('Whakatāne')).toBe('Whakatane');
  });

  it('reduces other Latin diacritics to their base letter', () => {
    expect(stripDiacritics('José')).toBe('Jose');
    expect(stripDiacritics('Zoë')).toBe('Zoe');
    expect(stripDiacritics('Muñoz')).toBe('Munoz');
    expect(stripDiacritics('naïve café')).toBe('naive cafe');
  });

  it('leaves plain ASCII (letters, digits, spaces, punctuation) untouched', () => {
    expect(stripDiacritics('Teams - FENZ - Bay of Plenty')).toBe('Teams - FENZ - Bay of Plenty');
    expect(stripDiacritics('Kaikohe (RFF)')).toBe('Kaikohe (RFF)');
    expect(stripDiacritics('A_READ.1-2')).toBe('A_READ.1-2');
  });

  it('returns an empty string for null/undefined rather than throwing', () => {
    expect(stripDiacritics(null)).toBe('');
    expect(stripDiacritics(undefined)).toBe('');
  });
});

describe('toAsciiIdentifier', () => {
  it('normalizes the reported bug case: a macron team name in a group-name path', () => {
    // The exact case from the bug report.
    expect(toAsciiIdentifier('Teams - FENZ - Ngā Tai ki te Puku'))
      .toBe('Teams - FENZ - Nga Tai ki te Puku');
  });

  it('preserves the spaces, hyphens, and folder separators a group name uses', () => {
    expect(toAsciiIdentifier('Teams - FENZ - Bay of Plenty'))
      .toBe('Teams - FENZ - Bay of Plenty');
    expect(toAsciiIdentifier('Kaikohe (RFF)')).toBe('Kaikohe (RFF)');
  });

  it('drops a non-ASCII glyph that has no ASCII base letter, collapsing the gap', () => {
    // A CJK glyph / emoji has no diacritic base -- it is removed entirely,
    // and the surrounding spacing collapses to a single space.
    expect(toAsciiIdentifier('Team 東京 Ops')).toBe('Team Ops');
    expect(toAsciiIdentifier('Team 🚒 Fire')).toBe('Team Fire');
  });

  it('trims leading/trailing whitespace left by a removed glyph', () => {
    expect(toAsciiIdentifier('  Ngā  ')).toBe('Nga');
    expect(toAsciiIdentifier('東 Alpha')).toBe('Alpha');
  });

  it('returns an empty string for null/undefined', () => {
    expect(toAsciiIdentifier(null)).toBe('');
    expect(toAsciiIdentifier(undefined)).toBe('');
  });

  it('always returns an ASCII-only string (no code point above 0x7e)', () => {
    for (const input of ['Ngā Tai', 'José', '東京', '🚒', 'Zoë café']) {
      const out = toAsciiIdentifier(input);
      expect([...out].every((ch) => ch.codePointAt(0) <= 0x7f)).toBe(true);
    }
  });
});
