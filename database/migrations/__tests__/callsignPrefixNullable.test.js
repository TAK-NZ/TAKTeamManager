/**
 * Regression coverage for Criterion 2.8 (takserver-enrollment task 4.3):
 * the mandatory Organisation_Prefix requirement is enforced at the
 * APPLICATION layer (server/routes/teams.js, task 4.1), deliberately
 * NOT as a `NOT NULL` column constraint on `teams.callsign_prefix` -- a
 * column constraint would fail the migration outright on any database
 * already holding an unprefixed Organisation, where the
 * application-layer check instead lets that Organisation block its own
 * next edit. This asserts the negative directly against the schema
 * source, so a future migration that "tidies up" by adding `NOT NULL`
 * to `callsign_prefix` fails this suite rather than silently
 * reintroducing the deployment-breaking failure mode Criterion 2.8
 * exists to avoid.
 *
 * Scoped to every migration file present (currently just the single
 * squashed baseline, `1790200000000_baseline-schema.cjs`), rather than
 * naming that file directly, so this guard keeps working unmodified
 * across a future incremental migration or a further squash -- it is
 * the RULE ("no migration ever adds NOT NULL to this column") that
 * matters, not which specific file the schema currently lives in.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..');

describe('teams.callsign_prefix stays nullable at the schema level (Criterion 2.8)', () => {
  const migrationFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.cjs'));

  it('found at least one migration file to scan (anti-vacuity)', () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  it('the current schema declares callsign_prefix with no NOT NULL', () => {
    let found = false;
    for (const file of migrationFiles) {
      const source = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const match = source.match(/callsign_prefix character varying\(255\)[^,\n]*/i);
      if (match) {
        found = true;
        expect(match[0]).not.toMatch(/NOT NULL/i);
      }
    }
    expect(found).toBe(true);
  });

  it('no migration file adds a NOT NULL (or SET NOT NULL) constraint to teams.callsign_prefix', () => {
    for (const file of migrationFiles) {
      const source = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      // Scoped to statements mentioning callsign_prefix specifically --
      // a bare "NOT NULL" search would false-positive on every other
      // column in the file (e.g. users.email's own NOT NULL).
      expect(source).not.toMatch(/callsign_prefix[^;]*SET NOT NULL/is);
      expect(source).not.toMatch(/callsign_prefix character varying\(255\) NOT NULL/i);
    }
  });
});
