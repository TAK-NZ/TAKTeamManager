'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Structural guard: no value in `.env.example` may be wrapped in surrounding
 * quotes.
 *
 * WHY THIS EXISTS. The production deployment loads its environment from an ECS
 * `EnvironmentFile` in S3 (`tak-team-manager-config.env`), which is
 * hand-derived from this `.env.example` template. Unlike a shell sourcing a
 * `.env`, ECS `EnvironmentFile` does NOT strip surrounding quotes from a
 * `KEY="value"` line — it delivers the quotes verbatim into `process.env`.
 * That has bitten this app repeatedly:
 *   - `CHANNEL_FOLDER_SEPARATOR=" - "` → the literal `" - "` flattened the
 *     Dashboard folder tree.
 *   - `EMAIL_FROM="Name <addr>"` → nodemailer mangled the From header into
 *     `<"Name addr"@host>`.
 *
 * The app now defensively strips one matched surrounding quote pair for those
 * specific vars, but the durable fix is to never quote values in the first
 * place. `.env.example` is the committed template operators copy, so keeping IT
 * quote-free is the enforceable guard against the whole class (the S3 file
 * itself is gitignored — it carries secrets — so it cannot be scanned here).
 *
 * A value that genuinely must contain a leading/trailing quote is not
 * expressible in this template without tripping this guard; there is no such
 * value today, and if one is ever needed it should be documented explicitly
 * rather than silently quoted. Values may contain quotes INTERNALLY (e.g. a
 * JSON snippet) — only a fully quote-WRAPPED value is rejected.
 */
describe('.env.example has no quote-wrapped values (ECS EnvironmentFile keeps quotes)', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
  const lines = source.split('\n');

  // A KEY=VALUE assignment line (not a comment, not blank). Captures key + value.
  const ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=(.*)$/;

  /** Value is wrapped in a matched pair of surrounding single or double quotes. */
  function isQuoteWrapped(value) {
    if (value.length < 2) return false;
    const first = value[0];
    const last = value[value.length - 1];
    return (first === '"' || first === "'") && first === last;
  }

  it('parses a healthy number of assignment lines (anti-vacuity)', () => {
    const assignments = lines.filter((l) => ASSIGNMENT.test(l));
    // The template has ~130 documented variables; assert we actually parsed a
    // substantial set, so a regex/format drift can't make this suite pass
    // while measuring nothing.
    expect(assignments.length).toBeGreaterThan(100);
  });

  it('has no value wrapped in surrounding quotes', () => {
    const offenders = [];
    lines.forEach((line, i) => {
      const m = ASSIGNMENT.exec(line);
      if (!m) return;
      const [, key, value] = m;
      if (isQuoteWrapped(value)) {
        offenders.push(`line ${i + 1}: ${key}=${value}`);
      }
    });

    expect(offenders).toEqual([]);
    // If this fails: an ECS EnvironmentFile does NOT strip these quotes, so the
    // quoted value reaches the app verbatim (see this file's header). Remove the
    // surrounding quotes from the offending line(s) in .env.example — a value
    // with spaces does not need quoting in an EnvironmentFile.
  });
});
