/**
 * Real-Postgres schema-consistency integration test (Requirement 16.5,
 * task 35.5).
 *
 *   "WHEN the automated test suite runs, THE App SHALL execute a
 *   schema-consistency test that runs `database/init.js` against a fresh
 *   database and fails if any column or table referenced by a query in
 *   `server/` is missing from the resulting schema, ensuring
 *   `database/schema.sql` remains capable of supporting every query
 *   executed by `server/`."
 *
 * `database/init.js` itself just calls `node-pg-migrate`'s `runner()`
 * (see `database/init.js`/`database/migrate-config.js`) and then inserts
 * some seed rows unrelated to schema shape, so this test invokes the same
 * `runner()` entry point `database/init.js` uses, rather than shelling
 * out to `database/init.js` as a whole -- the seed-data inserts it also
 * performs (default teams/config rows) are irrelevant to "does every
 * table/column referenced by server/ exist" and would only add
 * unnecessary coupling to `pool` (the shared app-wide singleton) inside a
 * throwaway-schema test.
 *
 * "Throwaway database": rather than provisioning an entirely separate
 * Postgres *database* (which would need its own connection/teardown
 * dance and isn't supported by a quick `CREATE DATABASE ... ` inside a
 * transaction), this test runs the full migration chain into a dedicated,
 * uniquely-named Postgres *schema* on the same already-reachable test
 * database used by every other `*.integration.test.js` file in this
 * repo (`tak_migration_test_501`) -- `node-pg-migrate`'s `schema` +
 * `createSchema: true` options (confirmed present in
 * `node_modules/node-pg-migrate/dist/legacy/runner.d.ts`) run the entire
 * migration chain with `search_path` pointed at that schema, so every
 * unqualified `CREATE TABLE`/`CREATE FUNCTION`/etc. in
 * `database/migrations/*.cjs` lands there instead of `public` -- this is
 * "fresh"/"throwaway" in the sense the requirement cares about (a schema
 * this test creates from nothing and fully controls), without needing a
 * second database or superuser `CREATE DATABASE` privileges. The schema
 * is dropped (`DROP SCHEMA ... CASCADE`) in `afterAll` regardless of
 * pass/fail, so no residue is left in the shared test database.
 *
 * Connection convention: mirrors
 * `server/workers/syncWorker.integration.test.js` exactly --
 * `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` are read from the
 * environment if already set, otherwise defaulted to the local
 * Docker-based test container (`tak_migration_test_501`, Postgres 15,
 * host port 15433, database `tak_team_manager`, user `postgres`,
 * password `postgres123`).
 *
 * Running the migration chain as a child process, not a direct
 * `require('node-pg-migrate')`: `node-pg-migrate` v9 ships as a pure ESM
 * package (`"type": "module"` in its `package.json`, confirmed via
 * `node_modules/node-pg-migrate/package.json`). Plain Node (the CLI, and
 * `database/init.js` when run directly via `node database/init.js`) can
 * `require()` it thanks to Node's built-in require(esm) interop
 * (available by default on the Node 24 runtime this repo currently
 * runs), but Jest's own CommonJS module transform does not go through
 * that same interop path -- `require('node-pg-migrate')` inside a Jest
 * test file fails with "Cannot use import statement outside a module"
 * (confirmed while developing this test). Rather than fighting Jest's
 * transform pipeline (e.g. custom ESM config that could destabilize
 * every other test file in this repo), this test shells out to a small
 * inline Node script (`node -e`, executed via `child_process.execFileSync`,
 * outside of Jest's module loader entirely) that performs ONLY the
 * migration-running step -- using the exact same `runner()` call
 * `database/init.js` already makes -- against the dedicated throwaway
 * schema; the Jest test itself then only ever does plain `pg` queries
 * against `information_schema`, which needs no special module loading.
 *
 * Identifier-extraction heuristic (documented limitation, per this
 * task's explicit instruction to keep this pragmatic rather than a full
 * SQL parser):
 *
 *   - This is a regex-based scan of every `.js` file under `server/`
 *     (excluding `*.test.js`/`*.integration.test.js` files themselves,
 *     since those contain mock SQL fixtures/expected-call-argument
 *     strings, not real queries the running application executes), not
 *     an AST-aware SQL parser.
 *   - It extracts:
 *       1. Table names following `FROM`, `JOIN`, `UPDATE`, `INTO`
 *          (covering `INSERT INTO`), and `TABLE` (covering
 *          `ALTER TABLE`), each optionally schema-qualified.
 *       2. Column names appearing in a small set of very common,
 *          unambiguous shapes: `<table>.<column>` qualified references
 *          (e.g. `u.first_name`), and the leading identifier list of an
 *          `INSERT INTO <table> (<col>, <col>, ...)` clause.
 *   - Known limitations (intentionally accepted, per the task's
 *     "pragmatic... reasonable regex-based approach" guidance):
 *       - Does not resolve table aliases to their real table name for
 *         the `<alias>.<column>` extraction; a `<column>` name is
 *         cross-referenced against `information_schema.columns` for ANY
 *         table in the schema, not specifically the aliased one. This
 *         means a column that exists on a DIFFERENT table than the one
 *         actually referenced would not be flagged (a false negative),
 *         but a column that has been renamed/removed EVERYWHERE in the
 *         schema (this task's actual concern, e.g. the `takRole`-style
 *         drift Requirement 16.1 already fixed) is still caught.
 *       - Does not parse CTEs' column lists, `RETURNING` clauses,
 *         dynamically-built query strings (e.g. `GlobalChannelService`'s
 *         allow-listed `${table}` interpolation -- already covered by
 *         its own dedicated unit test per task 14.2), or column names
 *         embedded in string template literals split across multiple
 *         `.js` template-literal segments joined at runtime.
 *       - Skips common SQL keywords/reserved words and this file's own
 *         known-noisy matches (e.g. `SELECT COUNT(*) as count`) via a
 *         small stoplist, rather than a real reserved-word table.
 *       - Does not attempt to distinguish a genuine column reference
 *         from a similarly-shaped JS object property access that
 *         happens to appear inside the same template literal as SQL
 *         (e.g. a `${variable}` interpolation) -- interpolated
 *         `${...}` segments are stripped out before extraction so they
 *         are never mistaken for literal identifiers.
 *   Given these limitations, this test is a structural drift detector
 *   (did a table/column referenced by name in `server/` get dropped or
 *   renamed without every reference being updated), not a proof of full
 *   query correctness -- exactly the level of rigor the task and
 *   Requirement 16.5 call for ("fails if any column or table referenced
 *   by a query in server/ is missing from the resulting schema").
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const ORIGINAL_ENV = {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD
};

process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '15433';
process.env.DB_NAME = process.env.DB_NAME || 'tak_team_manager';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres123';

const SCHEMA_NAME = `schema_consistency_test_${Date.now()}`;
// This file lives in database/ (one level up from database/migrations/) so
// that node-pg-migrate's `dir` scan of the real migrations directory never
// picks up this test file itself as a migration to parse.
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// --- Identifier extraction (heuristic, see file-level comment) ---

const SERVER_DIR = path.join(__dirname, '..', 'server');

const SQL_KEYWORD_STOPLIST = new Set([
  'select', 'from', 'where', 'join', 'left', 'right', 'inner', 'outer', 'on',
  'and', 'or', 'not', 'null', 'is', 'as', 'order', 'by', 'group', 'having',
  'limit', 'offset', 'insert', 'into', 'values', 'update', 'set', 'delete',
  'returning', 'distinct', 'count', 'sum', 'avg', 'min', 'max', 'case',
  'when', 'then', 'else', 'end', 'union', 'all', 'exists', 'in', 'between',
  'like', 'ilike', 'asc', 'desc', 'with', 'recursive', 'true', 'false',
  'coalesce', 'now', 'current_timestamp', 'interval', 'cast', 'begin',
  'commit', 'rollback', 'for', 'skip', 'locked', 'update', 'conflict',
  'do', 'nothing', 'table', 'alter', 'add', 'column', 'if', 'default',
  'unique', 'primary', 'key', 'references', 'check', 'constraint',
  'isolation', 'level', 'serializable', 'any', 'array', 'to_char',
  'extract', 'date_trunc', 'random', 'text', 'jsonb', 'concat',
  // "FOR UPDATE OF <table>" is a row-locking clause (used e.g. by
  // MouService's `FOR UPDATE OF s`); the tableRegex below matches
  // "UPDATE" as a keyword trigger and would otherwise misread the
  // following "OF" as the target table name.
  'of'
]);

function readServerJsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      results.push(...readServerJsFiles(fullPath));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.js') &&
      !entry.name.endsWith('.test.js') &&
      !entry.name.endsWith('.integration.test.js')
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Extracts only the actual SQL text passed as the first argument to a
 * `pool.query(...)`/`client.query(...)` call (template literal,
 * single-quoted, or double-quoted string) -- confirmed via the earlier
 * grep survey of every `.query(...)` call site in `server/` to be the
 * exclusive way SQL text enters this codebase (no query-string-building
 * helper functions/concatenation are used).
 *
 * Scoping identifier extraction to just these argument strings (rather
 * than scanning a file's full source, comments included) avoids a
 * SQL-keyword-triggered regex match against ordinary English prose
 * elsewhere in the file -- this codebase's JSDoc header comments are
 * unusually verbose and frequently contain words like "table", "from",
 * "into" or file references like `gracefulShutdown.js` (which a naive
 * `<alias>.<column>` regex misreads as `back.js`) in plain English
 * sentences, none of which are real SQL.
 *
 * Regex-based, not a real JS parser (consistent with this file's
 * documented "pragmatic, not AST-aware" approach): assumes a query's
 * SQL text does not itself contain the same quote character used to
 * open it (true for every call site surveyed) and that dynamically
 * built SQL strings are out of scope here (the one legitimate dynamic
 * case, `GlobalChannelService.deleteGlobalChannel`'s allow-listed
 * `${table}` interpolation, is covered by its own dedicated unit test
 * per task 14.2, not this structural drift check).
 */
function extractQueryStrings(source) {
  const segments = [];
  const queryCallRegex = /\.query\(\s*(`([^`]*)`|'([^']*)'|"([^"]*)")/g;
  let match;
  while ((match = queryCallRegex.exec(source)) !== null) {
    segments.push(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return segments;
}

/**
 * Strips `${...}` template-literal interpolations (so a dynamic
 * interpolated value is never mistaken for a literal SQL identifier) and
 * collapses whitespace/newlines, without needing a real JS parser --
 * every query in `server/` is written as a plain string or a
 * (non-nested-`${}`) template literal, confirmed via the earlier grep
 * survey of `pool.query(...)`/`client.query(...)` call sites across
 * `server/`.
 */
function stripInterpolations(source) {
  return source.replace(/\$\{[^}]*\}/g, '__INTERP__');
}

/**
 * Strips SQL line comments (`-- ...` to end of line) from an extracted
 * query string. Several queries in `server/` contain explanatory SQL
 * comments (e.g. "-- Start from target team and go up to root") whose
 * English prose can itself contain a SQL keyword like "from", which the
 * keyword-triggered regexes below would otherwise misread as a real
 * `FROM <table>` clause.
 */
function stripSqlLineComments(source) {
  return source.replace(/--.*$/gm, '');
}

/**
 * Identifies CTE names (`WITH [RECURSIVE] <name> AS (...)`, and
 * subsequent comma-separated `<name> AS (...)` CTEs in the same `WITH`
 * clause) and the short aliases later given to them in a `FROM`/`JOIN`
 * clause (e.g. `FROM team_hierarchy th`), plus derived-table aliases
 * that declare their own column list inline (e.g. `... WITH ORDINALITY
 * AS u(team_id, pos)`).
 *
 * Several queries in `server/` (the recursive team-hierarchy/ancestry
 * lookups in particular) define a CTE and then select computed,
 * query-local columns off of it (e.g. `rt.path`, `u.pos`) that are never
 * real `information_schema` columns on any real table -- and the CTE
 * name itself (e.g. `team_hierarchy`, `root_team`) is not a real table
 * either. Both would otherwise be flagged as missing/false positives.
 * This is intentionally narrow (only excludes names/aliases that this
 * codebase's CTEs actually use) rather than a general SQL-scope
 * resolver, consistent with this file's documented heuristic approach.
 */
function extractCteNamesAndLocalAliases(text) {
  const cteNames = new Set();
  const cteNameRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s*\(/gi;
  let match;
  while ((match = cteNameRegex.exec(text)) !== null) {
    cteNames.add(match[1].toLowerCase());
  }

  const localAliases = new Set();
  for (const name of cteNames) {
    const aliasRegex = new RegExp(`\\b${name}\\s+([a-zA-Z_][a-zA-Z0-9_]{0,3})\\b`, 'gi');
    let aliasMatch;
    while ((aliasMatch = aliasRegex.exec(text)) !== null) {
      const candidate = aliasMatch[1].toLowerCase();
      if (!SQL_KEYWORD_STOPLIST.has(candidate)) {
        localAliases.add(candidate);
      }
    }
  }

  // Derived-table aliases with an inline column list, e.g.
  // "unnest(rt.path) WITH ORDINALITY AS u(team_id, pos)" -- "u"'s
  // columns are defined right there in the query, not on a real table.
  const derivedAliasRegex = /\bAS\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gi;
  let derivedMatch;
  while ((derivedMatch = derivedAliasRegex.exec(text)) !== null) {
    localAliases.add(derivedMatch[1].toLowerCase());
  }

  return { cteNames, localAliases };
}

function extractIdentifiers(source) {
  const tables = new Set();
  const columns = new Set();

  const cleaned = extractQueryStrings(source)
    .map(stripInterpolations)
    .map(stripSqlLineComments)
    .join('\n');

  const { cteNames, localAliases } = extractCteNamesAndLocalAliases(cleaned);

  // Table names after FROM/JOIN/UPDATE/INTO/TABLE, optionally
  // schema-qualified (schema.table), stopping at a word boundary.
  const tableRegex = /\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\s+(?:IF\s+EXISTS\s+|IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)/gi;
  let match;
  while ((match = tableRegex.exec(cleaned)) !== null) {
    const raw = match[1].split('.').pop().toLowerCase();
    if (!SQL_KEYWORD_STOPLIST.has(raw) && raw !== '__interp__' && !cteNames.has(raw)) {
      tables.add(raw);
    }
  }

  // Qualified column references: <alias>.<column> where <alias> is a
  // short lowercase identifier (typical alias convention used throughout
  // server/, e.g. `u.first_name`, `tm.role`, `ar.status`) -- this
  // intentionally excludes bare unqualified column names, which are far
  // too ambiguous with plain JS identifiers to extract heuristically.
  const columnRegex = /\b([a-z]{1,4})\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  while ((match = columnRegex.exec(cleaned)) !== null) {
    const alias = match[1].toLowerCase();
    const raw = match[2].toLowerCase();
    if (localAliases.has(alias)) continue;
    if (!SQL_KEYWORD_STOPLIST.has(raw) && raw !== '__interp__' && raw !== 'id') {
      columns.add(raw);
    }
  }

  // INSERT INTO <table> (<col1>, <col2>, ...) leading column lists.
  const insertRegex = /INSERT\s+INTO\s+[a-zA-Z_][a-zA-Z0-9_.]*\s*\(([^)]+)\)/gi;
  while ((match = insertRegex.exec(cleaned)) !== null) {
    const colList = match[1];
    for (const rawCol of colList.split(',')) {
      const col = rawCol.trim().toLowerCase();
      if (/^[a-z_][a-z0-9_]*$/.test(col) && !SQL_KEYWORD_STOPLIST.has(col)) {
        columns.add(col);
      }
    }
  }

  return { tables, columns };
}

function collectServerIdentifiers() {
  const allTables = new Set();
  const allColumns = new Set();
  const tableSources = new Map(); // table -> Set of file paths, for readable failure messages
  const columnSources = new Map();

  for (const filePath of readServerJsFiles(SERVER_DIR)) {
    const source = fs.readFileSync(filePath, 'utf8');
    const { tables, columns } = extractIdentifiers(source);
    for (const t of tables) {
      allTables.add(t);
      if (!tableSources.has(t)) tableSources.set(t, new Set());
      tableSources.get(t).add(filePath);
    }
    for (const c of columns) {
      allColumns.add(c);
      if (!columnSources.has(c)) columnSources.set(c, new Set());
      columnSources.get(c).add(filePath);
    }
  }

  return { allTables, allColumns, tableSources, columnSources };
}

describe('Schema-consistency test: migration chain vs. server/ SQL identifiers (Requirement 16.5, task 35.5)', () => {
  let adminPool;

  beforeAll(async () => {
    adminPool = new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    });

    try {
      await adminPool.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `Real Postgres test database is not reachable at ` +
          `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} ` +
          `(user "${process.env.DB_USER}"). This schema-consistency test (task 35.5) ` +
          `requires a real, running Postgres instance to run the full migration chain ` +
          `against a fresh schema. Underlying error: ${error.message}`,
        { cause: error }
      );
    }

    // Run the FULL migration chain into a dedicated, freshly-created
    // schema -- the "throwaway database" for this test -- using the same
    // `database/migrations` directory and `pgmigrations` tracking table
    // name already used by `database/init.js`/`database/migrate-config.js`,
    // just redirected at SCHEMA_NAME instead of `public`. Run out-of-process
    // (see file-level comment on why `node-pg-migrate` can't be
    // `require()`'d directly from inside a Jest test file).
    const migrationScript = `
      const { runner } = require('node-pg-migrate');
      runner({
        databaseUrl: {
          user: ${JSON.stringify(process.env.DB_USER)},
          host: ${JSON.stringify(process.env.DB_HOST)},
          database: ${JSON.stringify(process.env.DB_NAME)},
          password: ${JSON.stringify(process.env.DB_PASSWORD)},
          port: ${JSON.stringify(process.env.DB_PORT)},
          ssl: false
        },
        dir: ${JSON.stringify(MIGRATIONS_DIR)},
        schema: ${JSON.stringify(SCHEMA_NAME)},
        createSchema: true,
        migrationsTable: 'pgmigrations',
        migrationsSchema: ${JSON.stringify(SCHEMA_NAME)},
        createMigrationsSchema: true,
        direction: 'up',
        verbose: false
      }).then(() => process.exit(0)).catch((err) => {
        console.error(err);
        process.exit(1);
      });
    `;

    execFileSync(process.execPath, ['-e', migrationScript], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
  }, 60000);

  afterAll(async () => {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_NAME}" CASCADE`);
    await adminPool.end();

    process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
    process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
    process.env.DB_NAME = ORIGINAL_ENV.DB_NAME;
    process.env.DB_USER = ORIGINAL_ENV.DB_USER;
    process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
  });

  it('contains every table referenced by name in server/ (FROM/JOIN/UPDATE/INSERT INTO/ALTER TABLE)', async () => {
    const { allTables, tableSources } = collectServerIdentifiers();

    const schemaTablesResult = await adminPool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [SCHEMA_NAME]
    );
    const schemaTableNames = new Set(schemaTablesResult.rows.map((r) => r.table_name.toLowerCase()));

    const missingTables = [...allTables].filter((t) => !schemaTableNames.has(t));

    if (missingTables.length > 0) {
      const detail = missingTables
        .map((t) => `  - "${t}" referenced in: ${[...tableSources.get(t)].join(', ')}`)
        .join('\n');
      throw new Error(
        `The following table(s) are referenced in server/ but do not exist in the ` +
          `migrated schema:\n${detail}`
      );
    }

    expect(missingTables).toEqual([]);
  });

  it('contains every qualified column referenced by name in server/ (<alias>.<column>, INSERT INTO column lists) somewhere in the schema', async () => {
    const { allColumns, columnSources } = collectServerIdentifiers();

    const schemaColumnsResult = await adminPool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1`,
      [SCHEMA_NAME]
    );
    const schemaColumnNames = new Set(schemaColumnsResult.rows.map((r) => r.column_name.toLowerCase()));

    const missingColumns = [...allColumns].filter((c) => !schemaColumnNames.has(c));

    if (missingColumns.length > 0) {
      const detail = missingColumns
        .map((c) => `  - "${c}" referenced in: ${[...columnSources.get(c)].join(', ')}`)
        .join('\n');
      throw new Error(
        `The following column(s) are referenced in server/ but do not exist on ANY ` +
          `table in the migrated schema (this heuristic does not resolve aliases to a ` +
          `specific table -- see this file's header comment -- but a column missing from ` +
          `every table, e.g. after a rename, is always caught):\n${detail}`
      );
    }

    expect(missingColumns).toEqual([]);
  });
});
