/**
 * Static-content tests for the two takserver-enrollment schema migrations
 * (task 2.3):
 *
 *   - database/migrations/1787600000000_email-nullable-device-invariant.cjs (task 2.1)
 *   - database/migrations/1787636759000_teams-pseudonymous-usernames.cjs (task 2.2)
 *
 * These assert against the SQL TEXT each migration hands to `pgm.sql(...)`,
 * by requiring the two `.cjs` modules directly and invoking their `up`/
 * `down` functions against a mock `pgm` whose `sql(...)` method records
 * every string it is called with. No database connection is opened here.
 *
 * Applying the migration chain to a real Postgres instance (up, then down,
 * then up again, against the port-15433 migration test database) is task
 * 2.4's job -- a separate checkpoint task run explicitly via
 * `docker compose exec -T app npm run migrate:up` / `:down`. This file is
 * part of `npm test` and touches no database at all.
 *
 * Requirements: takserver-enrollment 2.8, 5.3, 5.4, 5.11, 6.1.
 */

const fs = require('fs');
const path = require('path');

const EMAIL_MIGRATION_PATH = path.join(
  __dirname,
  '..',
  '1787600000000_email-nullable-device-invariant.cjs'
);
const PSEUDONYMOUS_MIGRATION_PATH = path.join(
  __dirname,
  '..',
  '1787636759000_teams-pseudonymous-usernames.cjs'
);

/**
 * Creates a mock `pgm` whose `sql(...)` calls are all recorded, runs
 * `fn(pgm)` against it, and returns the concatenation of every string
 * passed to `pgm.sql`, in call order. Both migrations issue exactly one
 * `pgm.sql(...)` call per direction, so this is "everything `up()` (or
 * `down()`) hands the migration runner" for either file.
 */
function collectSql(fn) {
  const calls = [];
  const pgm = {
    sql: (text) => {
      calls.push(text);
    }
  };
  fn(pgm);
  return calls.join('\n');
}

/**
 * Strips `/* ... *\/` block comments and `// ...` line comments from a
 * source string. Used below so that backticks appearing deliberately
 * inside this file's own JSDoc prose (e.g. the literal `pgm.sql(\`...\`)`
 * shown for documentation) are not mistaken for backticks inside an
 * actual template literal.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Structural guard for "no backtick appears inside any pgm.sql template
 * literal" (design.md, task 2's own trap note). A naive
 * `pgm\.sql\(`([\s\S]*?)`\)` regex is unfalsifiable here: it is
 * non-greedy, so an interior stray backtick would just make the match end
 * early, and the captured body would then, by construction, never
 * contain the backtick that broke it -- the assertion would pass while
 * measuring nothing.
 *
 * Instead this strips comments (so the JSDoc header's own documentation
 * backticks, e.g. "`pgm.sql(\`...\`)`", cannot confound the count), then
 * counts every remaining backtick and every occurrence of the literal
 * opening sequence `pgm.sql(\``, and asserts the two counts are related
 * by exactly 2:1 (one opening backtick, one closing backtick, per call).
 * A stray backtick anywhere inside a template literal's SQL text -- which
 * is the failure this guards against -- changes the total backtick count
 * without changing the number of `pgm.sql(\`` occurrences, so the 2:1
 * ratio breaks and the assertion fails. (A stray backtick would in fact
 * usually break the file's syntax outright, which `require()` below would
 * surface first as a SyntaxError -- this is the belt to that braces.)
 */
function assertNoBacktickInsideAnyPgmSqlLiteral(migrationSource) {
  const codeOnly = stripComments(migrationSource);
  const backtickCount = (codeOnly.match(/`/g) || []).length;
  const pgmSqlCallCount = (codeOnly.match(/pgm\.sql\(`/g) || []).length;

  // Anti-vacuity: both migrations are known to issue at least one
  // pgm.sql(`...`) call each; a count of zero would mean the regex above
  // stopped matching this file's convention, not that the file is clean.
  expect(pgmSqlCallCount).toBeGreaterThan(0);
  expect(backtickCount).toBe(pgmSqlCallCount * 2);
}

describe('email-nullable-device-invariant migration (takserver-enrollment task 2.1)', () => {
  const migration = require(EMAIL_MIGRATION_PATH);
  const migrationSource = fs.readFileSync(EMAIL_MIGRATION_PATH, 'utf8');

  let upSql;
  let downSql;

  beforeAll(() => {
    upSql = collectSql(migration.up);
    downSql = collectSql(migration.down);
  });

  describe('up() (Requirements 5.3, 5.4)', () => {
    it('drops NOT NULL on both users.email and user_cache.email', () => {
      expect(upSql).toMatch(/ALTER TABLE public\.users\s+ALTER COLUMN email DROP NOT NULL/i);
      expect(upSql).toMatch(/ALTER TABLE public\.user_cache\s+ALTER COLUMN email DROP NOT NULL/i);
    });

    it('adds users_email_required_unless_device on public.users with the exact constraint expression', () => {
      const match = upSql.match(
        /ALTER TABLE public\.users\s+ADD CONSTRAINT users_email_required_unless_device\s+CHECK \(([^)]+)\)/i
      );
      expect(match).not.toBeNull();
      expect(match[1].trim()).toBe('email IS NOT NULL OR is_team_device = true');
    });

    it('adds user_cache_email_required_unless_device on public.user_cache with the exact constraint expression', () => {
      const match = upSql.match(
        /ALTER TABLE public\.user_cache\s+ADD CONSTRAINT user_cache_email_required_unless_device\s+CHECK \(([^)]+)\)/i
      );
      expect(match).not.toBeNull();
      expect(match[1].trim()).toBe('email IS NOT NULL OR is_team_device = true');
    });
  });

  describe('up() has no backfill and no stale-address migration path (Requirements 5.11, 2.8)', () => {
    it('issues no UPDATE statement', () => {
      expect(upSql).not.toMatch(/\bUPDATE\b/i);
    });

    it('issues no SET NOT NULL', () => {
      // down() legitimately restores SET NOT NULL to reverse the column
      // change -- that is checked separately below and is expected to
      // pass. This assertion is scoped to upSql alone.
      expect(upSql).not.toMatch(/SET NOT NULL/i);
    });

    it('contains no "invalid" string anywhere', () => {
      expect(upSql.toLowerCase()).not.toContain('invalid');
    });
  });

  describe('down() reverses everything up() did', () => {
    it('drops both CHECK constraints', () => {
      expect(downSql).toMatch(/DROP CONSTRAINT IF EXISTS users_email_required_unless_device/i);
      expect(downSql).toMatch(/DROP CONSTRAINT IF EXISTS user_cache_email_required_unless_device/i);
    });

    it('restores SET NOT NULL on both users.email and user_cache.email', () => {
      expect(downSql).toMatch(/ALTER TABLE public\.users\s+ALTER COLUMN email SET NOT NULL/i);
      expect(downSql).toMatch(/ALTER TABLE public\.user_cache\s+ALTER COLUMN email SET NOT NULL/i);
    });

    it('drops the CHECK constraints before restoring NOT NULL', () => {
      // Ordering matters: restoring NOT NULL while a CHECK constraint
      // referencing the column is still in force is harmless here, but
      // the migration's own ordering states the constraints go first, and
      // this pins that ordering rather than just each statement's
      // presence.
      const dropUsersIdx = downSql.search(
        /DROP CONSTRAINT IF EXISTS users_email_required_unless_device/i
      );
      const dropCacheIdx = downSql.search(
        /DROP CONSTRAINT IF EXISTS user_cache_email_required_unless_device/i
      );
      const setUsersIdx = downSql.search(
        /ALTER TABLE public\.users\s+ALTER COLUMN email SET NOT NULL/i
      );
      const setCacheIdx = downSql.search(
        /ALTER TABLE public\.user_cache\s+ALTER COLUMN email SET NOT NULL/i
      );

      expect(dropUsersIdx).toBeGreaterThanOrEqual(0);
      expect(dropCacheIdx).toBeGreaterThanOrEqual(0);
      expect(setUsersIdx).toBeGreaterThan(dropUsersIdx);
      expect(setCacheIdx).toBeGreaterThan(dropCacheIdx);
    });
  });

  it('contains no backtick inside its pgm.sql template literal', () => {
    assertNoBacktickInsideAnyPgmSqlLiteral(migrationSource);
  });
});

/**
 * Regression coverage for Criterion 2.8 (task 4.3): the mandatory
 * Organisation_Prefix requirement is enforced at the APPLICATION layer
 * (server/routes/teams.js, task 4.1), deliberately NOT as a `NOT NULL`
 * column constraint on `teams.callsign_prefix` -- a column constraint
 * would fail the migration outright on any database already holding an
 * unprefixed Organisation, where the application-layer check instead
 * lets that Organisation block its own next edit. This asserts the
 * negative directly against the schema source, so a future migration
 * that "tidies up" by adding `NOT NULL` to `callsign_prefix` fails this
 * suite rather than silently reintroducing the deployment-breaking
 * failure mode Criterion 2.8 exists to avoid.
 */
describe('teams.callsign_prefix stays nullable at the schema level (Criterion 2.8)', () => {
  const baselineSource = fs.readFileSync(
    path.join(__dirname, '..', '1786596755665_baseline-schema.cjs'),
    'utf8'
  );

  it('the baseline schema declares callsign_prefix with no NOT NULL', () => {
    const match = baselineSource.match(/callsign_prefix character varying\(255\)[^,\n]*/i);
    expect(match).not.toBeNull();
    expect(match[0]).not.toMatch(/NOT NULL/i);
  });

  it('no migration file adds a NOT NULL (or SET NOT NULL) constraint to teams.callsign_prefix', () => {
    const migrationsDir = path.join(__dirname, '..');
    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.cjs'));

    // Anti-vacuity: confirm the scan actually found migration files to
    // check, rather than passing because readdirSync matched nothing.
    expect(migrationFiles.length).toBeGreaterThan(0);

    for (const file of migrationFiles) {
      const source = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      // Scoped to statements mentioning callsign_prefix specifically --
      // a bare "NOT NULL" search would false-positive on every other
      // column in the file (e.g. users.email's own NOT NULL).
      expect(source).not.toMatch(/callsign_prefix[^;]*SET NOT NULL/is);
      expect(source).not.toMatch(/callsign_prefix character varying\(255\) NOT NULL/i);
    }
  });
});

describe('teams-pseudonymous-usernames migration (takserver-enrollment task 2.2)', () => {
  const migration = require(PSEUDONYMOUS_MIGRATION_PATH);
  const migrationSource = fs.readFileSync(PSEUDONYMOUS_MIGRATION_PATH, 'utf8');

  let upSql;
  let downSql;

  beforeAll(() => {
    upSql = collectSql(migration.up);
    downSql = collectSql(migration.down);
  });

  describe('up() (Requirement 6.1)', () => {
    it('adds pseudonymous_usernames as a boolean column', () => {
      expect(upSql).toMatch(
        /ALTER TABLE public\.teams\s+ADD COLUMN pseudonymous_usernames boolean/i
      );
    });

    it('does NOT mark the column NOT NULL', () => {
      // A test that only checks the type would incorrectly pass a
      // `NOT NULL DEFAULT false` column and silently lose the tri-state
      // (NULL = Sub_Team, the question does not apply). Scope the
      // assertion to the whole column-definition statement, from
      // ADD COLUMN up to its terminating semicolon.
      const match = upSql.match(/ADD COLUMN pseudonymous_usernames boolean[^;]*;/i);
      expect(match).not.toBeNull();
      expect(match[0]).not.toMatch(/NOT NULL/i);
    });

    it('does NOT supply a column DEFAULT', () => {
      const match = upSql.match(/ADD COLUMN pseudonymous_usernames boolean[^;]*;/i);
      expect(match).not.toBeNull();
      expect(match[0]).not.toMatch(/DEFAULT/i);
    });
  });

  describe('down() reverses everything up() did', () => {
    it('drops the pseudonymous_usernames column', () => {
      expect(downSql).toMatch(
        /ALTER TABLE public\.teams\s+DROP COLUMN IF EXISTS pseudonymous_usernames/i
      );
    });
  });

  it('contains no backtick inside its pgm.sql template literal', () => {
    assertNoBacktickInsideAnyPgmSqlLiteral(migrationSource);
  });
});
