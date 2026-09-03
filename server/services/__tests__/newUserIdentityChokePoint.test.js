/**
 * takserver-enrollment task 5.8 -- the structural guard for the Phase-0
 * choke point (`UserProvisioningService.resolveNewUserIdentity`), named for
 * what it guards, following the three existing precedents:
 * `client/src/utils/dateFormatConsumers.test.js`,
 * `server/services/__tests__/martiEndpointContract.test.js`,
 * `server/workers/operationSchemas.test.js`, and the same-spec precedent
 * `server/utils/__tests__/identifierAlphabetSingleDefinition.test.js`.
 *
 * Three SET-EQUALITY assertions, each against a NAMED allow-list -- not a
 * subset check in either direction. **This is deliberate and stated three
 * times below, once per assertion, because it is the whole point of this
 * file**: a new site that creates an Authentik user, computes a default
 * Callsign_Suffix, or writes `users.username` is a genuine regression the
 * moment it exists outside the choke point, and MUST fail this suite --
 * the fix is to route it through `resolveNewUserIdentity` (or the
 * resolver/preview pair, for Assertion 2), not to add the new module to
 * the allow-list. Symmetrically, if a listed site is later legitimately
 * removed, the allow-list must SHRINK to match, or this suite would keep
 * passing while asserting a site that no longer exists -- a subset check
 * (`allow-list contains the found set`) would silently tolerate that
 * removal, which is exactly the failure mode set equality exists to catch.
 *
 * 1. Assertion 1 (Criterion 6.9): the SET of modules under
 *    `server/routes/**` and `server/services/**` containing a call that
 *    creates an Authentik user -- `authentikService.createUser(`, or a
 *    `fetch(...)` call whose arguments carry BOTH a URL string containing
 *    `/api/v3/core/users/` and `method: 'POST'` -- equals exactly:
 *      `routes/users.js`, `services/RequestApprovalService.js`,
 *      `services/BulkImportService.js`, `services/DeviceEnrollmentService.js`.
 *
 * 2. Assertion 2 (Criterion 9.3): the SET of modules calling
 *    `CallsignService.computeDefaultCallsignSuffix(...)` equals exactly:
 *      `services/UserProvisioningService.js`, `routes/requests.js`.
 *
 * 3. Assertion 3 (Criteria 7.1, 7.5): the SET of non-test modules
 *    containing a statement that writes `users.username` equals exactly:
 *      `services/authentikSync.js`, `services/UserProvisioningService.js`,
 *      `routes/users.js`, `services/DeviceEnrollmentService.js`.
 *    `authentikSync.js` is in this list DELIBERATELY (Criterion 7.5): its
 *    `ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2` copies
 *    the Authentik username into the local column, and Authentik is where
 *    the username is fixed -- this is not a "username change" in
 *    Criterion 7.1's sense. `routes/users.js` is in the list for the SAME
 *    reason at a second site: its add-to-team propagation upsert (around
 *    line 1174) writes `username` from a `user_cache` row whose value
 *    already came from Authentik, not from a caller-supplied value.
 *
 * DECISIONS, recorded because they define what this guard does and does
 * not catch (same discipline as identifierAlphabetSingleDefinition.test.js's
 * lettered decision list):
 *
 * A. Every extractor below is a PURE function of source text: it reads
 *    nothing but the string handed to it, performs no I/O, and returns a
 *    plain array of matches. Each is exercised directly against synthetic
 *    sources in the "the matching rule itself" describe blocks, so the
 *    rule -- not just its result on today's tree -- is under test.
 *
 * B. Comments are stripped before any pattern is matched (`stripComments`,
 *    copied in spirit from the sibling guards rather than imported --
 *    each structural guard in this repo is self-contained). This matters
 *    concretely: this very file's own header, and several doc comments in
 *    `UserProvisioningService.js` and `DeviceEnrollmentService.js`, MENTION
 *    `authentikService.createUser(`, `computeDefaultCallsignSuffix(role`
 *    -- forms of these exact strings in prose -- and none of that must
 *    count as a call.
 *
 * C. Assertion 1's `fetch(...)` pattern is matched by finding every
 *    `fetch(` call, then walking forward with a paren-depth counter that
 *    treats string/template literals as opaque spans (so a `)` inside a
 *    URL string, or a `(` inside a `${encodeURIComponent(...)}`
 *    interpolation, cannot desynchronise the depth count), and testing the
 *    captured argument text for BOTH sub-patterns. Requiring both in the
 *    SAME call's argument text -- not merely "both patterns appear
 *    somewhere in the file" -- is what correctly excludes the `DELETE`/
 *    `GET`/`PATCH` calls to the SAME `/api/v3/core/users/...` base path
 *    that every one of these files also makes (compensating deletes,
 *    existing-email lookups, name PATCHes): those calls carry the URL
 *    substring but not `method: 'POST'` in the same call.
 *
 * D. Assertion 2's pattern is the literal call site `.computeDefaultCallsignSuffix(`
 *    -- REQUIRING the preceding `.` -- rather than the bare substring
 *    `computeDefaultCallsignSuffix(`. This is deliberate and is checked by
 *    an explicit negative control below: `CallsignService.js`'s own
 *    method DEFINITION, `static computeDefaultCallsignSuffix(firstName, ...) {`,
 *    contains the bare substring but is preceded by `static `, not by `.`,
 *    so the dot-anchored pattern does not flag the definition site as a
 *    caller of itself. A bare-substring rule would need a second, uglier
 *    exclusion for the defining file; anchoring on `.` gets it for free
 *    because every real call in this codebase is already written as
 *    `CallsignService.computeDefaultCallsignSuffix(...)`.
 *
 * E. Assertion 3's SQL-write detection scans every string/template literal
 *    in a code position (the same literal-collection approach as
 *    Assertion 1's URL detection and as
 *    `identifierAlphabetSingleDefinition.test.js`'s alphabet-literal scan)
 *    for two independent shapes, checked against whitespace-collapsed
 *    literal text so a multi-line template literal (several of the real
 *    call sites use one) matches the same as a single-line string:
 *      (a) `INSERT INTO users (<columns>)` whose column list contains
 *          `username` as one of its comma-separated entries -- this
 *          catches every `INSERT ... ON CONFLICT ... DO UPDATE SET
 *          username = ...` upsert too, because the upsert's `SET` clause
 *          lives in the SAME literal as the column list that already
 *          matches;
 *      (b) `UPDATE users SET <clause>` whose `SET` clause (the text before
 *          any `WHERE`, so a `WHERE username = ...` predicate on some
 *          OTHER column's update is never mistaken for a write) contains
 *          `username =`.
 *    Requiring the exact table name `users` (not `user_cache`, which many
 *    of these same modules ALSO write to) is what a naive substring match
 *    would get wrong: `users` is a strict prefix of `user_cache` in
 *    neither direction textually, but `UPDATE users SET` vs
 *    `UPDATE user_cache SET` differ at the very next character after
 *    `users`, so requiring a non-word boundary there (built into the
 *    regexes below) tells them apart. This is checked by an explicit
 *    negative control (Assertion 3's "does NOT flag a user_cache-only
 *    write" case).
 *
 * F. Scope for all three assertions is `server/routes/**` and
 *    `server/services/**`, non-test `.js` files, recursively, excluding
 *    `node_modules` and `__tests__` directories -- matching the scope the
 *    design document specifies for this guard and the scope
 *    `martiEndpointContract.test.js` / `identifierAlphabetSingleDefinition.test.js`
 *    both use for their own tree walks. `server/workers/syncWorker.js`
 *    (which also POSTs to `/api/v3/core/users/` to create Authentik
 *    SERVICE ACCOUNTS for BCH channels -- an entirely different kind of
 *    principal from a human/device user) is OUTSIDE this scope and is
 *    therefore correctly never a candidate for Assertion 1's allow-list.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_ROOT = path.join(REPO_ROOT, 'server');
const ROUTES_ROOT = path.join(SERVER_ROOT, 'routes');
const SERVICES_ROOT = path.join(SERVER_ROOT, 'services');

// The three named allow-lists (Criteria 6.9, 9.3, 7.1/7.5), as relative
// paths from server/ -- exactly the labels the design document and task
// 5.8 name them by.
const CREATION_ALLOWLIST = [
  'routes/users.js',
  'services/RequestApprovalService.js',
  'services/BulkImportService.js',
  'services/DeviceEnrollmentService.js'
].sort();

const CALLSIGN_DEFAULT_ALLOWLIST = [
  'services/UserProvisioningService.js',
  'routes/requests.js'
].sort();

const USERNAME_WRITE_ALLOWLIST = [
  'services/authentikSync.js',
  'services/UserProvisioningService.js',
  'routes/users.js',
  'services/DeviceEnrollmentService.js'
].sort();

// ---------------------------------------------------------------------------
// Shared helpers: which files count, comment stripping, line numbers.
// ---------------------------------------------------------------------------

/** Whether a file name is a test file, by this repo's naming convention. */
function isTestFileName(name) {
  return /\.(test|property\.test)\.js$/.test(name);
}

/**
 * Every non-test `.js` file under `directory`, recursively.
 *
 * `node_modules` and `__tests__` directories are excluded, matching
 * `martiEndpointContract.test.js`'s `listServerSourceFiles` and
 * `identifierAlphabetSingleDefinition.test.js`'s
 * `listNonTestJsFilesRecursive`.
 */
function listNonTestJsFilesRecursive(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      files.push(...listNonTestJsFilesRecursive(absolutePath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.js')) continue;
    if (isTestFileName(entry.name)) continue;
    files.push(absolutePath);
  }
  return files;
}

/**
 * `source` with line and block comments blanked out (replaced by spaces,
 * newlines preserved), so a pattern that happens to appear inside a
 * comment -- this file's own header among them -- is never mistaken for
 * code. Line/character offsets are preserved so reported line numbers
 * stay accurate. Copied in spirit from
 * `identifierAlphabetSingleDefinition.test.js`'s `stripComments`; each
 * structural guard in this repo keeps its own copy rather than sharing
 * one module, deliberately (see that file's decision A/B).
 */
function stripComments(source) {
  let output = '';
  let index = 0;
  const length = source.length;

  while (index < length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === '/' && next === '/') {
      while (index < length && source[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      continue;
    }

    if (character === '/' && next === '*') {
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        output += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      output += '  ';
      index += 2;
      continue;
    }

    if (character === '\'' || character === '"' || character === '`') {
      const quote = character;
      output += character;
      index += 1;
      while (index < length) {
        const current = source[index];
        if (current === '\\') {
          output += current + (source[index + 1] ?? '');
          index += 2;
          continue;
        }
        output += current;
        index += 1;
        if (current === quote) break;
        if (current === '\n' && quote !== '`') break;
      }
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}

/** 1-based line number of `index` within `text`. */
function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

// ---------------------------------------------------------------------------
// Assertion 1 (Criterion 6.9): Authentik user-creation sites.
// ---------------------------------------------------------------------------

const AUTHENTIK_SERVICE_CREATE_USER_PATTERN = /\bauthentikService\.createUser\s*\(/g;
// Resiliency-hardening: every raw `fetch(...)` call site in
// server/services and server/routes was migrated to
// `fetchWithTimeout(...)` (server/utils/fetchWithTimeout.js), a thin
// wrapper that attaches a bounded AbortSignal so a hung Authentik
// connection can never hang indefinitely. This is a call-site RENAME,
// not a semantic change in what creates a user -- `fetchWithTimeout`
// forwards its arguments to the native `fetch` unchanged (plus a
// `signal`) -- so this pattern matches BOTH spellings. `\bfetch\b`
// followed by an optional `WithTimeout` (rather than two separate
// alternatives) keeps the single `\b...\(` word-boundary anchor shared
// by both forms.
const FETCH_CALL_PATTERN = /\bfetch(?:WithTimeout)?\s*\(/g;
const USERS_COLLECTION_URL_PATTERN = /\/api\/v3\/core\/users\//;
const POST_METHOD_PATTERN = /method\s*:\s*['"]POST['"]/;

/**
 * Finds the index of the `)` matching the `(` at `openIndex`, treating
 * string/template literal spans as opaque (a quote character's contents
 * are skipped verbatim, so a `)` or `(` inside a URL string or a
 * `${encodeURIComponent(...)}` interpolation cannot desynchronise the
 * paren-depth count -- decision C). Returns -1 if the source ends before
 * the call closes, which the caller treats as "no match" rather than
 * throwing, since a malformed/partial synthetic source should fail the
 * assertion that relies on the match, not this scanner.
 */
function findMatchingParenIndex(code, openIndex) {
  let depth = 0;
  let index = openIndex;
  const length = code.length;

  while (index < length) {
    const character = code[index];

    if (character === '\'' || character === '"' || character === '`') {
      const quote = character;
      index += 1;
      while (index < length) {
        const current = code[index];
        if (current === '\\') {
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (character === '(') {
      depth += 1;
      index += 1;
      continue;
    }

    if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
      index += 1;
      continue;
    }

    index += 1;
  }

  return -1;
}

/**
 * Every site in `code` (already comment-stripped) that creates an
 * Authentik user: an `authentikService.createUser(` call, or a `fetch(...)`
 * call whose argument text carries BOTH `/api/v3/core/users/` and
 * `method: 'POST'` (decision C -- both must appear in the SAME call's
 * arguments, not merely somewhere in the file).
 *
 * @param {string} code comment-stripped source text
 * @returns {Array<{ line: number, kind: 'authentikService.createUser'|'fetch-post-users' }>}
 */
function findAuthentikUserCreationSites(code) {
  const sites = [];

  for (const match of code.matchAll(AUTHENTIK_SERVICE_CREATE_USER_PATTERN)) {
    sites.push({ line: lineAt(code, match.index), kind: 'authentikService.createUser' });
  }

  let fetchMatch;
  FETCH_CALL_PATTERN.lastIndex = 0;
  while ((fetchMatch = FETCH_CALL_PATTERN.exec(code)) !== null) {
    const openParenIndex = fetchMatch.index + fetchMatch[0].length - 1;
    const closeParenIndex = findMatchingParenIndex(code, openParenIndex);
    if (closeParenIndex === -1) break;

    const argsText = code.slice(openParenIndex + 1, closeParenIndex);
    if (USERS_COLLECTION_URL_PATTERN.test(argsText) && POST_METHOD_PATTERN.test(argsText)) {
      sites.push({ line: lineAt(code, fetchMatch.index), kind: 'fetch-post-users' });
    }

    FETCH_CALL_PATTERN.lastIndex = closeParenIndex;
  }

  return sites;
}

// ---------------------------------------------------------------------------
// Assertion 2 (Criterion 9.3): computeDefaultCallsignSuffix callers.
// ---------------------------------------------------------------------------

// Anchored on the preceding `.` deliberately (decision D): this is a CALL
// pattern, `<something>.computeDefaultCallsignSuffix(`, and it is what
// excludes CallsignService.js's own method DEFINITION
// (`static computeDefaultCallsignSuffix(...) {`), which contains the bare
// substring but never the dot.
const COMPUTE_DEFAULT_CALLSIGN_SUFFIX_CALL_PATTERN = /\.computeDefaultCallsignSuffix\s*\(/g;

/**
 * Every call-site of `computeDefaultCallsignSuffix` in `code` (already
 * comment-stripped), matched as `.computeDefaultCallsignSuffix(` so the
 * method's own definition (preceded by `static `, not by `.`) is never
 * counted as a caller of itself.
 *
 * @param {string} code comment-stripped source text
 * @returns {Array<{ line: number }>}
 */
function findComputeDefaultCallsignSuffixCallers(code) {
  const callers = [];
  for (const match of code.matchAll(COMPUTE_DEFAULT_CALLSIGN_SUFFIX_CALL_PATTERN)) {
    callers.push({ line: lineAt(code, match.index) });
  }
  return callers;
}

// ---------------------------------------------------------------------------
// Assertion 3 (Criteria 7.1, 7.5): statements that write `users.username`.
// ---------------------------------------------------------------------------

const INSERT_INTO_USERS_PATTERN = /INSERT\s+INTO\s+users\s*\(([^)]*)\)/i;
const UPDATE_USERS_SET_PATTERN = /UPDATE\s+users\s+SET\s+([\s\S]*)/i;

/**
 * Every string/template literal in `source` (comment-stripped), with its
 * starting 1-based line and raw text. A pure function of source text,
 * shared by Assertion 3 below -- deliberately simpler than
 * `martiEndpointContract.test.js`'s collector (it does not need to
 * preserve `${...}` interpolation markers, since none of the SQL patterns
 * matched below ever appear split across an interpolation boundary in
 * this codebase's actual call sites).
 *
 * @param {string} code comment-stripped source text
 * @returns {Array<{ line: number, value: string }>}
 */
function collectLiterals(code) {
  const literals = [];
  const length = code.length;
  let index = 0;
  let line = 1;

  while (index < length) {
    const character = code[index];

    if (character === '\n') {
      line += 1;
      index += 1;
      continue;
    }

    if (character === '\'' || character === '"' || character === '`') {
      const quote = character;
      const startLine = line;
      let value = '';
      index += 1;
      while (index < length) {
        const current = code[index];
        if (current === '\\') {
          value += current + (code[index + 1] ?? '');
          if (code[index + 1] === '\n') line += 1;
          index += 2;
          continue;
        }
        if (current === '\n') {
          line += 1;
          if (quote !== '`') break;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      literals.push({ line: startLine, value });
      continue;
    }

    index += 1;
  }

  return literals;
}

/**
 * Whether `literalValue` (the raw text of one string/template literal)
 * contains a SQL statement that writes the `users.username` column,
 * under either of the two shapes described in decision E:
 *   (a) `INSERT INTO users (<columns>)` whose column list names
 *       `username` -- also catches every `... ON CONFLICT ... DO UPDATE
 *       SET username = ...` upsert, because that `SET` clause lives in
 *       the SAME literal as the matched column list;
 *   (b) `UPDATE users SET <clause>` whose clause (everything before a
 *       `WHERE`, if any) contains `username =`.
 * Matched against whitespace-collapsed text so a multi-line template
 * literal matches identically to a single-line string.
 *
 * @param {string} literalValue
 * @returns {boolean}
 */
function writesUsersUsername(literalValue) {
  const collapsed = literalValue.replace(/\s+/g, ' ').trim();

  const insertMatch = INSERT_INTO_USERS_PATTERN.exec(collapsed);
  if (insertMatch) {
    const columns = insertMatch[1].split(',').map((column) => column.trim().toLowerCase());
    if (columns.includes('username')) return true;
  }

  const updateMatch = UPDATE_USERS_SET_PATTERN.exec(collapsed);
  if (updateMatch) {
    const setClauseOnly = updateMatch[1].split(/\bWHERE\b/i)[0];
    if (/\busername\s*=/i.test(setClauseOnly)) return true;
  }

  return false;
}

/**
 * Every literal in `code` (comment-stripped) containing a statement that
 * writes `users.username`, per `writesUsersUsername`.
 *
 * @param {string} code comment-stripped source text
 * @returns {Array<{ line: number, value: string }>}
 */
function findUsersUsernameWrites(code) {
  return collectLiterals(code).filter(({ value }) => writesUsersUsername(value));
}

// ---------------------------------------------------------------------------
// Run all three scans against the real tree.
// ---------------------------------------------------------------------------

const sourceFiles = [
  ...listNonTestJsFilesRecursive(ROUTES_ROOT),
  ...listNonTestJsFilesRecursive(SERVICES_ROOT)
];

function relativeModuleLabel(absolutePath) {
  return path.relative(SERVER_ROOT, absolutePath).split(path.sep).join('/');
}

const scanned = sourceFiles.map((absolutePath) => {
  const code = stripComments(fs.readFileSync(absolutePath, 'utf8'));
  return {
    absolutePath,
    module: relativeModuleLabel(absolutePath),
    creationSites: findAuthentikUserCreationSites(code),
    callsignDefaultCallers: findComputeDefaultCallsignSuffixCallers(code),
    usernameWrites: findUsersUsernameWrites(code)
  };
});

const creationModules = new Set(
  scanned.filter((entry) => entry.creationSites.length > 0).map((entry) => entry.module)
);
const callsignDefaultModules = new Set(
  scanned.filter((entry) => entry.callsignDefaultCallers.length > 0).map((entry) => entry.module)
);
const usernameWriteModules = new Set(
  scanned.filter((entry) => entry.usernameWrites.length > 0).map((entry) => entry.module)
);

// ---------------------------------------------------------------------------
// Assertion 1 (Criterion 6.9).
// ---------------------------------------------------------------------------

describe('Assertion 1: Authentik user-creation sites equal the four-entry allow-list (Criterion 6.9)', () => {
  it('scanned a plausible number of files and found the four known creation sites (anti-vacuity)', () => {
    // If this collapsed to a tiny number, or none of the four known files
    // showed up, the walk or the extractor broke and the equality
    // assertion below would pass vacuously (an empty found-set can never
    // equal a non-empty allow-list, but a BROKEN scan could just as
    // easily -- and wrongly -- match an unrelated smaller set).
    expect(sourceFiles.length).toBeGreaterThanOrEqual(30);
    for (const expectedModule of CREATION_ALLOWLIST) {
      expect(creationModules.has(expectedModule)).toBe(true);
    }
  });

  it('equals the four-entry allow-list, exactly -- a NEW site fails by design, so does the REMOVAL of one', () => {
    const actual = [...creationModules].sort();
    const missing = CREATION_ALLOWLIST.filter((expectedModule) => !creationModules.has(expectedModule));
    const extra = actual.filter((foundModule) => !CREATION_ALLOWLIST.includes(foundModule));

    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        [
          'The set of modules creating an Authentik user no longer equals',
          "the allow-list (Criterion 6.9). This is a SET EQUALITY check --",
          'a module dropping off is just as much a failure as a new one',
          'appearing, because the allow-list must track exactly what exists.',
          '',
          missing.length > 0
            ? [
                'Missing from the tree (present in the allow-list but no longer detected):',
                ...missing.map((module) => `  - ${module}`),
                'If this site was legitimately removed, shrink the allow-list',
                '(CREATION_ALLOWLIST) in this test to match.'
              ].join('\n')
            : null,
          extra.length > 0
            ? [
                'New sites detected (not in the allow-list):',
                ...extra.map((module) => `  - ${module}`),
                'Route this new creation site through',
                'UserProvisioningService.resolveNewUserIdentity instead of calling',
                "authentikService.createUser (or fetch-ing '/api/v3/core/users/'",
                "with method: 'POST') directly, or add it to CREATION_ALLOWLIST",
                'in this test with a justification if it is a genuinely new',
                'legitimate site.'
              ].join('\n')
            : null
        ].filter(Boolean).join('\n')
      );
    }

    expect(actual).toEqual(CREATION_ALLOWLIST);
  });
});

// ---------------------------------------------------------------------------
// Assertion 2 (Criterion 9.3).
// ---------------------------------------------------------------------------

describe('Assertion 2: computeDefaultCallsignSuffix callers equal the two-entry allow-list (Criterion 9.3)', () => {
  it('scanned the tree and found the two known callers, and confirmed the definition site is not one of them (anti-vacuity + negative control)', () => {
    for (const expectedModule of CALLSIGN_DEFAULT_ALLOWLIST) {
      expect(callsignDefaultModules.has(expectedModule)).toBe(true);
    }

    // Decision D's negative control: CallsignService.js's own method
    // DEFINITION contains the bare substring `computeDefaultCallsignSuffix(`
    // but is never preceded by a `.`, so it must never appear as a caller.
    const callsignServiceSource = fs.readFileSync(
      path.join(SERVICES_ROOT, 'CallsignService.js'),
      'utf8'
    );
    expect(callsignServiceSource).toContain('computeDefaultCallsignSuffix(');
    expect(callsignDefaultModules.has('services/CallsignService.js')).toBe(false);
  });

  it('equals the two-entry allow-list, exactly -- a THIRD computation site fails by design', () => {
    const actual = [...callsignDefaultModules].sort();
    const missing = CALLSIGN_DEFAULT_ALLOWLIST.filter(
      (expectedModule) => !callsignDefaultModules.has(expectedModule)
    );
    const extra = actual.filter((foundModule) => !CALLSIGN_DEFAULT_ALLOWLIST.includes(foundModule));

    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        [
          'The set of modules calling CallsignService.computeDefaultCallsignSuffix',
          'no longer equals the allow-list (Criterion 9.3). SET EQUALITY: a',
          'caller dropping off must shrink the allow-list too, not just be',
          'ignored.',
          '',
          missing.length > 0
            ? [
                'Missing from the tree:',
                ...missing.map((module) => `  - ${module}`),
                'If this caller was legitimately removed, shrink',
                'CALLSIGN_DEFAULT_ALLOWLIST in this test to match.'
              ].join('\n')
            : null,
          extra.length > 0
            ? [
                'New callers detected (not in the allow-list):',
                ...extra.map((module) => `  - ${module}`),
                'A new default-computation site reintroduces the drift',
                'Requirement 9 exists to prevent: route it through',
                'UserProvisioningService.resolveNewUserIdentity instead of',
                'calling CallsignService.computeDefaultCallsignSuffix directly,',
                'or add it to CALLSIGN_DEFAULT_ALLOWLIST in this test with a',
                'justification if it is a genuinely new, read-only preview site.'
              ].join('\n')
            : null
        ].filter(Boolean).join('\n')
      );
    }

    expect(actual).toEqual(CALLSIGN_DEFAULT_ALLOWLIST);
  });
});

// ---------------------------------------------------------------------------
// Assertion 3 (Criteria 7.1, 7.5).
// ---------------------------------------------------------------------------

describe('Assertion 3: users.username writers equal the four-entry allow-list (Criteria 7.1, 7.5)', () => {
  it('scanned the tree and found the four known writers (anti-vacuity)', () => {
    for (const expectedModule of USERNAME_WRITE_ALLOWLIST) {
      expect(usernameWriteModules.has(expectedModule)).toBe(true);
    }
  });

  it('equals the four-entry allow-list, exactly -- a NEW username-writing statement fails by design', () => {
    const actual = [...usernameWriteModules].sort();
    const missing = USERNAME_WRITE_ALLOWLIST.filter(
      (expectedModule) => !usernameWriteModules.has(expectedModule)
    );
    const extra = actual.filter((foundModule) => !USERNAME_WRITE_ALLOWLIST.includes(foundModule));

    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        [
          'The set of modules writing users.username no longer equals the',
          'allow-list (Criteria 7.1, 7.5). SET EQUALITY: a writer dropping',
          'off must shrink the allow-list too.',
          '',
          missing.length > 0
            ? [
                'Missing from the tree:',
                ...missing.map((module) => `  - ${module}`),
                'If this write was legitimately removed, shrink',
                'USERNAME_WRITE_ALLOWLIST in this test to match.'
              ].join('\n')
            : null,
          extra.length > 0
            ? [
                'New username-writing statements detected (not in the',
                'allow-list):',
                ...extra.map((module) => `  - ${module}`),
                'A username is fixed at creation (Criterion 7.1): provide no',
                'route, interface or administrative action that changes an',
                'existing user\'s username. If this write is a legitimate',
                'Authentik-to-local sync of an already-fixed username (the',
                'same reasoning that already covers authentikSync.js and',
                "routes/users.js's add-to-team propagation), add it to",
                'USERNAME_WRITE_ALLOWLIST in this test with that',
                'justification.'
              ].join('\n')
            : null
        ].filter(Boolean).join('\n')
      );
    }

    expect(actual).toEqual(USERNAME_WRITE_ALLOWLIST);
  });
});

// ---------------------------------------------------------------------------
// The matching rules themselves, exercised against synthetic sources -- the
// same discipline `martiEndpointContract.test.js` and
// `identifierAlphabetSingleDefinition.test.js` both apply to their own
// extractors, so the rule (not just its result on today's tree) is under
// test.
// ---------------------------------------------------------------------------

describe('findAuthentikUserCreationSites: the matching rule itself', () => {
  it('matches a bare authentikService.createUser( call', () => {
    const sites = findAuthentikUserCreationSites("const u = await authentikService.createUser({ username });\n");
    expect(sites).toEqual([{ line: 1, kind: 'authentikService.createUser' }]);
  });

  it('matches a fetch(...) call carrying both the users URL and method: POST, in the same call', () => {
    const source = [
      "const r = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/`, {",
      "  method: 'POST',",
      "  headers: { Authorization: `Bearer ${token}` }",
      "});"
    ].join('\n');
    const sites = findAuthentikUserCreationSites(source);
    expect(sites).toEqual([{ line: 1, kind: 'fetch-post-users' }]);
  });

  it('does NOT match a fetch(...) call to the same URL with a different method (negative control)', () => {
    const source = [
      "const r = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${id}/`, {",
      "  method: 'DELETE',",
      "  headers: { Authorization: `Bearer ${token}` }",
      "});"
    ].join('\n');
    expect(findAuthentikUserCreationSites(source)).toEqual([]);
  });

  it('does NOT match a mention inside a comment (negative control)', () => {
    // These extractors are documented to receive already comment-stripped
    // text (see their @param docs); comment-stripping itself is
    // `stripComments`'s job, exercised on the real tree by the describe
    // blocks above. This test therefore strips first, exactly as the real
    // scan does, so it is testing the SAME contract rather than a
    // hypothetical raw-source one.
    const source = stripComments("// see authentikService.createUser( for the create path\nconst x = 1;\n");
    expect(findAuthentikUserCreationSites(source)).toEqual([]);
  });

  it('does not desynchronise on a paren inside a URL-building interpolation', () => {
    const source = [
      "const r = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/?email=${encodeURIComponent(email)}`, {",
      "  method: 'POST'",
      "});"
    ].join('\n');
    expect(findAuthentikUserCreationSites(source)).toEqual([{ line: 1, kind: 'fetch-post-users' }]);
  });
});

describe('findComputeDefaultCallsignSuffixCallers: the matching rule itself', () => {
  it('matches a dot-prefixed call site', () => {
    const callers = findComputeDefaultCallsignSuffixCallers(
      'const s = CallsignService.computeDefaultCallsignSuffix(a, b, c);\n'
    );
    expect(callers).toHaveLength(1);
  });

  it('does NOT match the bare method definition (negative control, decision D)', () => {
    const callers = findComputeDefaultCallsignSuffixCallers(
      'static computeDefaultCallsignSuffix(firstName, lastName, callsignNameFormat) {\n'
    );
    expect(callers).toEqual([]);
  });

  it('does not flag a mention in a comment', () => {
    // Comment-stripped first, matching the documented contract -- see the
    // comment on the equivalent Assertion-1 negative control above.
    const callers = findComputeDefaultCallsignSuffixCallers(
      stripComments('// calls Foo.computeDefaultCallsignSuffix( internally\nconst x = 1;\n')
    );
    expect(callers).toEqual([]);
  });
});

describe('findUsersUsernameWrites: the matching rule itself', () => {
  it('matches an INSERT INTO users(...) column list containing username', () => {
    const writes = findUsersUsernameWrites(
      "await pool.query('INSERT INTO users (authentik_user_id, username, email) VALUES ($1, $2, $3)', []);\n"
    );
    expect(writes).toHaveLength(1);
  });

  it('matches an ON CONFLICT ... DO UPDATE SET username upsert, via the same literal\'s column list', () => {
    const writes = findUsersUsernameWrites(
      "await pool.query('INSERT INTO users (authentik_user_id, username) VALUES ($1, $2) ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2', []);\n"
    );
    expect(writes).toHaveLength(1);
  });

  it('matches a plain UPDATE users SET ... username = ... statement', () => {
    const writes = findUsersUsernameWrites(
      "await client.query('UPDATE users SET authentik_user_id = $1, username = $2 WHERE id = $3', []);\n"
    );
    expect(writes).toHaveLength(1);
  });

  it('does NOT match a WHERE username = ... predicate on an unrelated column update (negative control)', () => {
    const writes = findUsersUsernameWrites(
      "await pool.query('UPDATE users SET tak_role = $1 WHERE username = $2', []);\n"
    );
    expect(writes).toEqual([]);
  });

  it('does NOT match a user_cache-only write, even one that sets its username column (negative control, decision E)', () => {
    const writes = findUsersUsernameWrites(
      "await pool.query('INSERT INTO user_cache (authentik_id, username) VALUES ($1, $2) ON CONFLICT (authentik_id) DO UPDATE SET username = EXCLUDED.username', []);\n"
    );
    expect(writes).toEqual([]);
  });

  it('matches across a multi-line template literal (whitespace-collapsed)', () => {
    const source = [
      "await pool.query(`",
      "  INSERT INTO users (username, authentik_user_id, is_active)",
      "  VALUES ($1, NULL, false)",
      "  RETURNING id`, [candidate]);"
    ].join('\n');
    expect(findUsersUsernameWrites(source)).toHaveLength(1);
  });

  it('does NOT match an unrelated column update on users (negative control)', () => {
    const writes = findUsersUsernameWrites(
      "await client.query('UPDATE users SET callsign_suffix = $1 WHERE id = $2', []);\n"
    );
    expect(writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// "The guard bites" -- each extractor detects a synthetic violation written
// to a real scratch file on disk under the scope this guard scans, and stops
// detecting it once the file is removed. This is the durable, automated
// record that the guard's real-tree wiring (not just the pure functions in
// isolation, exercised above) responds to a new file appearing -- the same
// property `identifierAlphabetSingleDefinition.test.js`'s
// `collectRequireGraph` scratch-directory tests establish for that guard.
//
// This was ALSO verified manually against the real tree while writing this
// guard: a scratch file containing a fake `authentikService.createUser(...)`
// call, a fake `.computeDefaultCallsignSuffix(...)` call, and a fake
// `UPDATE users SET username = ...` statement was added under
// `server/services/`, confirmed to make the corresponding Assertion-1/2/3
// "equals the allow-list" test fail with the scratch file named as an
// unexpected extra module, and then removed, with the suite confirmed
// passing again.
// ---------------------------------------------------------------------------

describe('the guard bites: a scratch file with a real violation is detected via the same file-scan path', () => {
  const scratchDir = path.join(SERVICES_ROOT, '__newUserIdentityChokePointScratch__');
  const scratchFile = path.join(scratchDir, 'scratch.js');

  afterEach(() => {
    if (fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('detects a fresh authentikService.createUser( site written to disk', () => {
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(
      scratchFile,
      "const authentikService = require('../authentik');\nmodule.exports = async () => authentikService.createUser({ username: 'x' });\n"
    );

    const files = listNonTestJsFilesRecursive(SERVICES_ROOT);
    expect(files).toContain(scratchFile);

    const code = stripComments(fs.readFileSync(scratchFile, 'utf8'));
    expect(findAuthentikUserCreationSites(code).length).toBeGreaterThan(0);
  });

  it('detects a fresh .computeDefaultCallsignSuffix( call site written to disk', () => {
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(
      scratchFile,
      "const CallsignService = require('../CallsignService');\nmodule.exports = () => CallsignService.computeDefaultCallsignSuffix('A', 'B', 'full_name');\n"
    );

    const code = stripComments(fs.readFileSync(scratchFile, 'utf8'));
    expect(findComputeDefaultCallsignSuffixCallers(code).length).toBeGreaterThan(0);
  });

  it('detects a fresh users.username-writing statement written to disk', () => {
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(
      scratchFile,
      "const pool = require('../../config/database');\nmodule.exports = () => pool.query('UPDATE users SET username = $1 WHERE id = $2', ['x', 1]);\n"
    );

    const code = stripComments(fs.readFileSync(scratchFile, 'utf8'));
    expect(findUsersUsernameWrites(code).length).toBeGreaterThan(0);
  });

  it('the scratch file is gone once removed, and the real tree scan no longer sees it', () => {
    // No scratch file created in this test; afterEach's cleanup from the
    // previous tests already ran. This documents the "removal shrinks the
    // set too" half of set equality at the file-scan level.
    expect(fs.existsSync(scratchFile)).toBe(false);
    expect(listNonTestJsFilesRecursive(SERVICES_ROOT)).not.toContain(scratchFile);
  });
});
