/**
 * Property-based test for the HTML safe subset (Requirement 5 Criteria
 * 5.4, 5.5, 5.6; design.md's Property 10: "HTML sanitization excludes the
 * disallowed subset").
 *
 * This file exercises the REAL `SANITIZE_HTML_OPTIONS` allow-list exported
 * by `./htmlSafeSubset` against the REAL `sanitize-html` package, using
 * the exact call shape used by `server/models/SiteConfig.js`
 * (`sanitizeHtml(value, SANITIZE_HTML_OPTIONS)`) and
 * `server/routes/settings.js`'s `upsertImportedConfigRow`
 * (`sanitizeHtml(row.config_value, SANITIZE_HTML_OPTIONS)`).
 *
 * design.md's Property 10 statement: "For any HTML input string, the
 * sanitized output contains no `<script>`, `<iframe>`, `<object>`, or
 * `<embed>` tags, no event-handler attributes, and no `javascript:`-scheme
 * URLs in `href` or `src` attributes."
 *
 * The disallowed-pattern checks below are independently derived
 * string/regex assertions against the sanitizer's OUTPUT -- they do not
 * reimplement or import any part of `sanitize-html`'s or
 * `htmlSafeSubset.js`'s own logic, so this is a legitimate external
 * oracle rather than a circular check.
 *
 * Implemented with `fast-check` via `@fast-check/jest`'s `test.prop`
 * integration, matching the convention established in
 * `./configValidator.test.js` and `./permissions.registry.test.js`.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const sanitizeHtml = require('sanitize-html');

const { SANITIZE_HTML_OPTIONS } = require('./htmlSafeSubset');

/**
 * Independent oracle: asserts the sanitizer's OUTPUT string contains none
 * of the disallowed patterns called out in Requirement 5.4/design.md's
 * Property 10. Implemented via plain regex/string checks against the
 * RETURNED string only -- never against the input, and never by
 * re-deriving `sanitize-html`'s parsing/allow-list logic.
 */
function assertNoDisallowedPatterns(output) {
  expect(output).not.toMatch(/<script/i);
  expect(output).not.toMatch(/<iframe/i);
  expect(output).not.toMatch(/<object/i);
  expect(output).not.toMatch(/<embed/i);
  expect(output).not.toMatch(/<style/i);
  expect(output).not.toMatch(/javascript:/i);
  // Event-handler attribute pattern: an "on"-prefixed word token
  // immediately followed by '=' (e.g. onerror=, onclick=, onload=).
  expect(output).not.toMatch(/\bon\w+\s*=/i);
}

// Feature: production-hardening, Property 10: HTML sanitization excludes the disallowed subset
describe('Property 10: HTML sanitization excludes the disallowed subset', () => {
  // Fully arbitrary strings, to fuzz for any unexpected escape/bypass
  // that isn't shaped like a known attack template.
  const arbitraryStringArb = fc.string();

  // Strings deliberately constructed by interpolating fc.string() into
  // known dangerous templates, so the generator reliably produces
  // attack-shaped inputs (script tags, event-handler attributes,
  // javascript: URLs, disallowed tags) rather than relying on random
  // noise to rarely stumble into one.
  const scriptTagArb = fc.string().map((s) => `<script>${s}</script>`);
  const imgOnErrorArb = fc.string().map((s) => `<img src=x onerror="${s}">`);
  const aOnClickArb = fc.string().map((s) => `<a href="#" onclick="${s}">click</a>`);
  const javascriptHrefArb = fc.string().map((s) => `<a href="javascript:${s}">link</a>`);
  const javascriptSrcArb = fc.string().map((s) => `<img src="javascript:${s}">`);
  const iframeArb = fc.string().map((s) => `<iframe src="${s}"></iframe>`);
  const objectArb = fc.string().map((s) => `<object data="${s}"></object>`);
  const embedArb = fc.string().map((s) => `<embed src="${s}">`);
  const styleTagArb = fc.string().map((s) => `<style>${s}</style>`);
  const mixedAttackAndAllowedArb = fc
    .string()
    .map((s) => `<p>Hello</p><script>${s}</script><strong>World</strong>`);

  const attackShapedInputArb = fc.oneof(
    scriptTagArb,
    imgOnErrorArb,
    aOnClickArb,
    javascriptHrefArb,
    javascriptSrcArb,
    iframeArb,
    objectArb,
    embedArb,
    styleTagArb,
    mixedAttackAndAllowedArb
  );

  const anyHtmlInputArb = fc.oneof(arbitraryStringArb, attackShapedInputArb);

  test.prop([anyHtmlInputArb], { numRuns: 100 })(
    'sanitize-html(input, SANITIZE_HTML_OPTIONS) never yields a disallowed tag, on* attribute, or javascript: URL, and never throws',
    (input) => {
      let output;
      expect(() => {
        output = sanitizeHtml(input, SANITIZE_HTML_OPTIONS);
      }).not.toThrow();

      assertNoDisallowedPatterns(output);
    }
  );

  // Sanity check (not the main property): confirm the allow-listed tags
  // and attributes documented in htmlSafeSubset.js are NOT stripped, so
  // this test can't trivially "pass" by stripping everything down to an
  // empty string.
  it.each([
    ['<p>Hello world</p>', '<p>Hello world</p>'],
    ['<strong>bold</strong>', '<strong>bold</strong>'],
    ['<em>italic</em>', '<em>italic</em>'],
    ['Line one<br>Line two', 'Line one<br />Line two'],
    ['<ul><li>one</li><li>two</li></ul>', '<ul><li>one</li><li>two</li></ul>'],
    ['<a href="https://example.com">link</a>', '<a href="https://example.com">link</a>']
  ])('preserves allowed content %j unchanged', (input, expected) => {
    expect(sanitizeHtml(input, SANITIZE_HTML_OPTIONS)).toBe(expected);
  });

  // Named attack examples mirroring the generator templates above, kept
  // as explicit human-legible regression cases alongside the randomized
  // run.
  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">link</a>',
    '<iframe src="https://evil.example.com"></iframe>',
    '<object data="evil.swf"></object>',
    '<embed src="evil.swf">',
    '<style>body{background:url(javascript:alert(1))}</style>',
    '<p onclick="alert(1)">click me</p>'
  ])('strips disallowed content from %j', (input) => {
    const output = sanitizeHtml(input, SANITIZE_HTML_OPTIONS);
    assertNoDisallowedPatterns(output);
  });
});
