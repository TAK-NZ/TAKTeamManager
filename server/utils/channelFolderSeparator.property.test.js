'use strict';
// Property: resolveChannelFolderSeparator is TOTAL, NEVER-EMPTY, and strips
// exactly ONE matched pair of surrounding quotes (preserving inner whitespace),
// while leaving unmatched/internal quotes and non-quoted values untouched.
//
// **Validates: the quoted-EnvironmentFile bug** -- an ECS EnvironmentFile does
// not strip surrounding quotes, so `CHANNEL_FOLDER_SEPARATOR=" - "` reached the
// app as the literal `" - "`, which no longer split channel names built with a
// clean ` - ` and collapsed the Dashboard folder tree into a flat list.
//
// Expectations are RE-DERIVED from the generated input (never by calling the
// function under test): the correctness model is "strip one matched surrounding
// quote pair, else identity; fall back to the default for empty/whitespace".
const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const {
  resolveChannelFolderSeparator,
  stripOneMatchedQuotePair,
  DEFAULT_CHANNEL_FOLDER_SEPARATOR
} = require('./channelFolderSeparator');

const DEFAULT = ' - ';

// Sanity: the exported default is the documented one, so the re-derivation
// below is anchored to the same constant the code uses.
test('the exported default is a space-dash-space', () => {
  expect(DEFAULT_CHANNEL_FOLDER_SEPARATOR).toBe(DEFAULT);
});

// ---------------------------------------------------------------------------
// 1. TOTALITY + NEVER-EMPTY: for ANY value bound to the env var (including
//    hostile/absent types), the resolver returns a non-empty string and never
//    throws. A separator that resolves to '' would split every character.
// ---------------------------------------------------------------------------
test.prop([
  fc.oneof(
    fc.string(),
    fc.constantFrom('', ' ', '  ', '\t', '" - "', "' - '", ' - ', '-', ' / ', '::'),
    fc.constant(undefined),
    fc.constant(null),
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.object()
  )
])('is total and never returns an empty string', (raw) => {
  const env = raw === undefined ? {} : { CHANNEL_FOLDER_SEPARATOR: raw };
  const result = resolveChannelFolderSeparator(env);
  expect(typeof result).toBe('string');
  expect(result.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// 2. QUOTE-WRAPPING: an arbitrary inner value with non-whitespace content,
//    wrapped in a single matched quote pair, resolves to the SAME value the
//    UNWRAPPED string would resolve to. This is the core guarantee: a quoted
//    config value behaves exactly like the unquoted one.
//    Boundary concentration on the inner value includes the exact ` - `,
//    leading/trailing spaces, and other separators.
// ---------------------------------------------------------------------------
test.prop([
  fc.oneof(
    fc.constantFrom(' - ', ' / ', '::', ' -- ', ' > ', '-', ' x ', 'a b'),
    fc.string({ minLength: 1 }).filter((s) => s.trim() !== '' && s[0] !== '"' && s[0] !== "'"),
  ),
  fc.constantFrom('"', "'")
])('a matched surrounding quote pair resolves to the unquoted value', (inner, quote) => {
  const wrapped = `${quote}${inner}${quote}`;
  const fromWrapped = resolveChannelFolderSeparator({ CHANNEL_FOLDER_SEPARATOR: wrapped });
  const fromInner = resolveChannelFolderSeparator({ CHANNEL_FOLDER_SEPARATOR: inner });
  expect(fromWrapped).toBe(fromInner);
});

// ---------------------------------------------------------------------------
// 3. NO SPURIOUS STRIPPING: a value with NO matched surrounding pair is left
//    exactly as-is (subject only to the empty/whitespace default). Covers the
//    -1/0/+1 boundaries around "is a quote pair": unmatched leading quote,
//    unmatched trailing quote, mixed quotes, and internal-only quotes.
// ---------------------------------------------------------------------------
test.prop([
  fc.oneof(
    fc.constantFrom('" - ', ' - "', '\' - "', '" - \'', 'a"b', "a'b", ' - ', ' / ', '::'),
    fc.string({ minLength: 1 }).filter((s) => {
      if (s.trim() === '') return false;
      const matched = s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[0] === s[s.length - 1];
      return !matched;
    })
  )
])('leaves a value with no matched surrounding quote pair unchanged', (raw) => {
  expect(resolveChannelFolderSeparator({ CHANNEL_FOLDER_SEPARATOR: raw })).toBe(raw);
});

// ---------------------------------------------------------------------------
// 4. EMPTY / WHITESPACE-ONLY -> DEFAULT, whether quoted or not. `""`, `"  "`,
//    a bare space, and absent all collapse to the documented default.
// ---------------------------------------------------------------------------
test.prop([
  fc.constantFrom('', ' ', '  ', '\t', '   ', '""', "''", '"  "', "'\t'")
])('empty or whitespace-only (quoted or not) falls back to the default', (raw) => {
  expect(resolveChannelFolderSeparator({ CHANNEL_FOLDER_SEPARATOR: raw })).toBe(DEFAULT);
});

test('absent env var falls back to the default', () => {
  expect(resolveChannelFolderSeparator({})).toBe(DEFAULT);
});

// ---------------------------------------------------------------------------
// Anchored examples -- the exact bug and its neighbours.
// ---------------------------------------------------------------------------
test('the reported bug: `" - "` resolves to a clean ` - `', () => {
  expect(resolveChannelFolderSeparator({ CHANNEL_FOLDER_SEPARATOR: '" - "' })).toBe(' - ');
});

test('inner whitespace is preserved (not trimmed)', () => {
  expect(resolveChannelFolderSeparator({ CHANNEL_FOLDER_SEPARATOR: '" - "' })).toBe(' - ');
  expect(resolveChannelFolderSeparator({ CHANNEL_FOLDER_SEPARATOR: ' - ' })).toBe(' - ');
});

test('only ONE quote pair is stripped', () => {
  expect(resolveChannelFolderSeparator({ CHANNEL_FOLDER_SEPARATOR: '""x""' })).toBe('"x"');
  expect(stripOneMatchedQuotePair('""x""')).toBe('"x"');
});

test('stripOneMatchedQuotePair leaves unmatched/short values alone', () => {
  expect(stripOneMatchedQuotePair('"')).toBe('"');
  expect(stripOneMatchedQuotePair('"a')).toBe('"a');
  expect(stripOneMatchedQuotePair('a"')).toBe('a"');
  expect(stripOneMatchedQuotePair('\'a"')).toBe('\'a"');
});
