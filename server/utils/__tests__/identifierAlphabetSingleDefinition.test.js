/**
 * takserver-enrollment task 1.7 -- the structural guard for three facts about
 * the Identifier_Alphabet and the pure Managed_Identifier generator, named
 * for what it guards, following the three existing precedents:
 * `client/src/utils/dateFormatConsumers.test.js`,
 * `server/services/__tests__/martiEndpointContract.test.js`,
 * `server/workers/operationSchemas.test.js`.
 *
 * 1. SINGLE ALPHABET DEFINITION (Criterion 1.4). The 31-character literal
 *    `ABCDEFGHJKMNPQRSTUVWXYZ23456789` appears in exactly one non-test
 *    module under `server/`: `server/utils/identifierAlphabet.js`.
 *    `server/services/SignupCodeService.test.js` carries its OWN
 *    independent copy of the literal -- by design, per task 1.1's
 *    completion notes -- and is excluded because it is a test file, not
 *    because it is special-cased.
 *
 * 2. BARE REQUIRE GRAPH (Criterion 1.5). `server/utils/managedIdentifier.js`
 *    loads with no database and no framework in its require graph: its
 *    `require(...)` calls are resolved TRANSITIVELY across the local
 *    module tree, and the resulting set of resolved local files contains
 *    nothing from `server/config/`, and the resulting set of external
 *    (non-relative) specifiers contains none of `express`, `pg`, `axios`,
 *    `pdfkit`, `qrcode`.
 *
 * 3. NO SECOND ORGANISATION_PREFIX REGEX (Criterion 2.5). No second
 *    Organisation_Prefix-shaped regex -- a pattern equivalent to
 *    `[A-Za-z0-9]*`, `[A-Za-z0-9]+`, or (per the foreign-partner-prefix
 *    extension) the current canonical multi-segment shape
 *    `[A-Za-z0-9]+(-[A-Za-z0-9]+)*` used for prefix validation -- exists
 *    in any non-test file under `server/utils/` besides
 *    `callsignValidation.js`.
 *
 * DECISIONS, recorded because they define what this guard does and does
 * not catch:
 *
 * A. Assertion 1 scans STRING AND TEMPLATE LITERAL VALUES only, in code
 *    positions (comments skipped), following `martiEndpointContract.test.js`'s
 *    `.includes('/Marti')` shape: a literal's raw text is searched for the
 *    alphabet substring. `managedIdentifier.js`'s own
 *    `MANAGED_IDENTIFIER_PATTERN` template literal is NOT a false positive
 *    here, because its source text is
 *    `` `^[A-Za-z0-9]+${escapeForCharClass(...)}...[${AMBIGUITY_FREE_ALPHABET}]{...}$` ``
 *    -- an *interpolation* of the imported constant, never the 31-character
 *    literal spelled out a second time. Scanning SOURCE TEXT rather than
 *    evaluated template results is what keeps that distinction meaningful.
 *
 * B. Assertion 2 is a REGEX-based scan of `require(['"]...['"])` calls,
 *    walking local (`.`-prefixed) specifiers to their resolved file and
 *    recursing, and recording every non-relative specifier encountered
 *    anywhere in that local closure as "external". This is one of the two
 *    viable approaches the task names (the other being a fresh
 *    `require.cache` walk); the regex-based static scan was chosen because
 *    it needs no runtime module load and cannot have a side effect of its
 *    own, and because the codebase's own `require(...)` call shape is
 *    simple and uniform enough for a static scan to resolve exactly.
 *
 * C. Assertion 3 is a heuristic, and the task calling for it says so
 *    explicitly: regex EQUIVALENCE is not decidable in general. What is
 *    implemented is narrower and stated precisely so its limitation is
 *    legible: it scans server/utils/*.js (direct children only, non-test)
 *    for a REGEX LITERAL (`/.../`, not a string or template literal used
 *    with `new RegExp(...)`) whose pattern text, after stripping the `/`
 *    delimiters and any flags, is EXACTLY `^[A-Za-z0-9]*$` or
 *    `^[A-Za-z0-9]+$`. Two consequences of that choice, both deliberate:
 *      - `callsignValidation.js`'s `CALLSIGN_PREFIX_PATTERN =
 *        /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/` (updated by the
 *        foreign-partner-prefix extension to allow internal `-` segment
 *        separators) matches, because it IS a regex literal whose whole
 *        pattern is exactly that text.
 *      - `managedIdentifier.js`'s `MANAGED_IDENTIFIER_PATTERN` does NOT
 *        match, even though its SOURCE TEXT contains the substring
 *        `[A-Za-z0-9]+`: it is built with `new RegExp(` over a TEMPLATE
 *        LITERAL, not a `/.../` regex literal, and even under a
 *        substring-only reading its full pattern continues past the
 *        quantifier (a separator, a marker class, a body class, then `$`)
 *        rather than anchoring `$` immediately after `[A-Za-z0-9]+` --
 *        i.e. it is not equivalent to a prefix-only validator, it is the
 *        shape predicate for a WHOLE Managed_Identifier, one segment of
 *        which happens to look like a prefix pattern. A future second
 *        prefix validator written as `new RegExp('^[A-Za-z0-9]*$')` or as
 *        a hand-built string comparison would NOT be caught by this
 *        heuristic -- that gap is inherent to matching on regex-literal
 *        syntax rather than semantic equivalence, and is exactly the
 *        limitation the task asks to be documented rather than solved.
 *
 * Each extractor below is a PURE function of source text, exercised
 * directly against synthetic sources in the last three describe blocks,
 * the way `martiEndpointContract.test.js` and `dateFormatConsumers.test.js`
 * both exercise their own matching rules -- so the rule itself, not just
 * its result on the current tree, is under test.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_ROOT = path.join(REPO_ROOT, 'server');
const UTILS_ROOT = path.join(SERVER_ROOT, 'utils');
const CONFIG_ROOT = path.join(SERVER_ROOT, 'config');

const IDENTIFIER_ALPHABET_FILE = path.join(UTILS_ROOT, 'identifierAlphabet.js');
const MANAGED_IDENTIFIER_FILE = path.join(UTILS_ROOT, 'managedIdentifier.js');
const CALLSIGN_VALIDATION_FILE = path.join(UTILS_ROOT, 'callsignValidation.js');

const ALPHABET_LITERAL = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const FORBIDDEN_EXTERNAL_MODULES = ['express', 'pg', 'axios', 'pdfkit', 'qrcode'];

// The Organisation_Prefix-shaped regex patterns (Criterion 2.5), as the
// exact pattern text a matching regex LITERAL's body must equal (decision C).
// The third entry is the current canonical pattern, added by the
// foreign-partner-prefix extension; the first two remain listed so a REVERT
// to either historical shape is still caught as a duplicate rather than
// silently passing because the heuristic only knows the newest shape.
const PREFIX_SHAPED_PATTERNS = [
  '^[A-Za-z0-9]*$',
  '^[A-Za-z0-9]+$',
  '^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$'
];

// ---------------------------------------------------------------------------
// Shared helpers: which files count, and how comments are stripped.
// ---------------------------------------------------------------------------

/** Whether a file name is a test file, by this repo's naming convention. */
function isTestFileName(name) {
  return /\.(test|property\.test)\.js$/.test(name);
}

/**
 * Every non-test `.js` file under `directory`, recursively.
 *
 * `node_modules` and `__tests__` directories are excluded, matching
 * `martiEndpointContract.test.js`'s `listServerSourceFiles`.
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

/** The non-test `.js` files directly inside `directory` (no recursion). */
function listNonTestJsFilesDirect(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !isTestFileName(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

/**
 * `source` with line and block comments blanked out (replaced by spaces,
 * newlines preserved), so `//` or `/*` inside a string/template/regex
 * literal is not mistaken for a comment and offsets are undisturbed.
 *
 * A hand-written scanner, not a regex over raw text, for the same reason
 * `martiEndpointContract.test.js` and `dateFormatConsumers.test.js` both use
 * one: the code/comment distinction this guard rests on is not expressible
 * as a single regex once string, template and regex literals are allowed to
 * contain `/` and quote characters of their own.
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

// ---------------------------------------------------------------------------
// Assertion 1: the single alphabet definition (Criterion 1.4).
// ---------------------------------------------------------------------------

/**
 * Every string/template literal in `source` that contains `ALPHABET_LITERAL`
 * as a substring, in a code position (comments excluded). Pure function of
 * source text (decision A).
 *
 * Deliberately simpler than `martiEndpointContract.test.js`'s literal
 * collector: it does not need to track template-interpolation depth for its
 * own sake, only to stop at an UNESCAPED closing quote, because what is
 * searched for is the literal 31-character run appearing verbatim -- an
 * interpolation like `${AMBIGUITY_FREE_ALPHABET}` never contains that run in
 * SOURCE TEXT, so no special interpolation handling is needed to avoid a
 * false positive (see decision A above).
 *
 * @param {string} source
 * @returns {Array<{ line: number, literal: string }>}
 */
function findAlphabetLiteralOccurrences(source) {
  const code = stripComments(source);
  const occurrences = [];
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
      if (value.includes(ALPHABET_LITERAL)) {
        occurrences.push({ line: startLine, literal: value });
      }
      continue;
    }

    index += 1;
  }

  return occurrences;
}

// ---------------------------------------------------------------------------
// Assertion 2: the bare require graph (Criterion 1.5).
// ---------------------------------------------------------------------------

const REQUIRE_CALL_PATTERN = /\brequire\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/g;

/**
 * Every specifier passed to a `require(...)` call in `source`, in a code
 * position (comments excluded). Pure function of source text.
 *
 * @param {string} source
 * @returns {string[]}
 */
function extractRequireSpecifiers(source) {
  const code = stripComments(source);
  const specifiers = [];
  for (const match of code.matchAll(REQUIRE_CALL_PATTERN)) {
    specifiers.push(match[2]);
  }
  return specifiers;
}

/**
 * Resolves a relative `require(...)` specifier from `fromFile` to an
 * absolute file path, trying the specifier as given, then with `.js`
 * appended, then as a directory's `index.js`. Returns `null` if none
 * exists, so a broken specifier fails loudly at the assertion site rather
 * than silently resolving to a made-up path.
 *
 * @param {string} specifier a `.`-prefixed require specifier
 * @param {string} fromFile absolute path of the file containing the require
 * @returns {string|null}
 */
function resolveLocalRequire(specifier, fromFile) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

/**
 * Walks the TRANSITIVE require graph of `entryFile`, following only local
 * (`.`-prefixed) specifiers, and returns the full set of visited local files
 * (entry file included) plus the full set of non-relative ("external")
 * specifiers encountered anywhere in that local closure.
 *
 * Pure function of the file tree rooted at `entryFile` -- no module is
 * actually `require()`-d, so this cannot itself pull in a database
 * connection or a framework the way loading `managedIdentifier.js` for real
 * and inspecting `require.cache` would risk if a forbidden import were ever
 * added (decision B).
 *
 * @param {string} entryFile absolute path
 * @returns {{ localFiles: Set<string>, externalModules: Set<string> }}
 */
function collectRequireGraph(entryFile) {
  const localFiles = new Set();
  const externalModules = new Set();
  const queue = [entryFile];

  while (queue.length > 0) {
    const file = queue.pop();
    if (localFiles.has(file)) continue;
    localFiles.add(file);

    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of extractRequireSpecifiers(source)) {
      if (specifier.startsWith('.')) {
        const resolved = resolveLocalRequire(specifier, file);
        if (resolved && !localFiles.has(resolved)) {
          queue.push(resolved);
        }
      } else {
        externalModules.add(specifier);
      }
    }
  }

  return { localFiles, externalModules };
}

// ---------------------------------------------------------------------------
// Assertion 3: no second Organisation_Prefix regex (Criterion 2.5).
// ---------------------------------------------------------------------------

/**
 * Whether a `/` at `index` in `source` opens a regex literal rather than
 * being a division operator, by inspecting the nearest preceding
 * non-whitespace token. Deliberately conservative: this file's own scanned
 * inputs are declaration-position regex literals (`const X = /.../`), which
 * this always classifies correctly, and the false-negative direction (a
 * regex literal misread as division) only causes this scanner to miss a
 * match -- which is safe for a guard whose job is to flag EXTRA prefix
 * regexes, not to prove their absence by exhaustive parsing.
 */
const REGEX_PRECEDING_PUNCTUATION = new Set(
  ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']
);
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case'
]);

function regexLiteralStartsAt(source, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  const previous = source[cursor];
  if (REGEX_PRECEDING_PUNCTUATION.has(previous)) return true;
  if (!/[A-Za-z_$]/.test(previous)) return false;
  let wordStart = cursor;
  while (wordStart >= 0 && /[A-Za-z0-9_$]/.test(source[wordStart])) wordStart -= 1;
  return REGEX_PRECEDING_KEYWORDS.has(source.slice(wordStart + 1, cursor + 1));
}

/**
 * Every regex literal in `source` whose pattern text (delimiters and flags
 * stripped) EXACTLY equals one of `PREFIX_SHAPED_PATTERNS` (decision C).
 * Pure function of source text.
 *
 * @param {string} source
 * @returns {Array<{ line: number, pattern: string }>}
 */
function findPrefixShapedRegexLiterals(source) {
  const code = stripComments(source);
  const matches = [];
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

    // Skip string/template literals so a quote inside one cannot desync the
    // regex-literal scan below (mirrors martiEndpointContract's approach).
    if (character === '\'' || character === '"' || character === '`') {
      const quote = character;
      index += 1;
      while (index < length) {
        const current = code[index];
        if (current === '\\') {
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
        index += 1;
      }
      continue;
    }

    if (character === '/' && regexLiteralStartsAt(code, index)) {
      const startLine = line;
      const patternStart = index + 1;
      index += 1;
      let inCharacterClass = false;
      while (index < length) {
        const current = code[index];
        if (current === '\\') {
          index += 2;
          continue;
        }
        if (current === '\n') break;
        if (current === '[') inCharacterClass = true;
        else if (current === ']') inCharacterClass = false;
        else if (current === '/' && !inCharacterClass) break;
        index += 1;
      }
      const pattern = code.slice(patternStart, index);
      if (PREFIX_SHAPED_PATTERNS.includes(pattern)) {
        matches.push({ line: startLine, pattern });
      }
      // Skip the closing `/` and any flags.
      index += 1;
      while (index < length && /[a-z]/i.test(code[index])) index += 1;
      continue;
    }

    index += 1;
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Assertion 1: run against the real tree.
// ---------------------------------------------------------------------------

describe('Identifier_Alphabet single definition (Criterion 1.4)', () => {
  const sourceFiles = listNonTestJsFilesRecursive(SERVER_ROOT);

  const occurrencesByFile = sourceFiles
    .map((absolutePath) => ({
      absolutePath,
      occurrences: findAlphabetLiteralOccurrences(fs.readFileSync(absolutePath, 'utf8'))
    }))
    .filter(({ occurrences }) => occurrences.length > 0);

  it('scanned a plausible number of non-test server source files', () => {
    // Anti-vacuity for the file walk itself: if this collapsed to a tiny
    // number, the walk broke (a moved directory, a filter that ate
    // everything) and every assertion below would pass while scanning
    // nothing.
    expect(sourceFiles.length).toBeGreaterThanOrEqual(50);
    expect(sourceFiles).toContain(IDENTIFIER_ALPHABET_FILE);
    expect(sourceFiles.some((file) => isTestFileName(path.basename(file)))).toBe(false);
  });

  it('found the alphabet literal in identifierAlphabet.js (anti-vacuity)', () => {
    // The scan must actually SEE the one expected occurrence before the
    // next assertion can meaningfully claim there are no others -- a scan
    // that silently matched nothing everywhere would pass vacuously.
    const identifierAlphabetEntry = occurrencesByFile.find(
      ({ absolutePath }) => absolutePath === IDENTIFIER_ALPHABET_FILE
    );
    expect(identifierAlphabetEntry).toBeDefined();
    expect(identifierAlphabetEntry.occurrences.length).toBeGreaterThanOrEqual(1);
  });

  it('appears in no other non-test module under server/', () => {
    const offenders = occurrencesByFile
      .filter(({ absolutePath }) => absolutePath !== IDENTIFIER_ALPHABET_FILE)
      .flatMap(({ absolutePath, occurrences }) =>
        occurrences.map(({ line }) => `${path.relative(REPO_ROOT, absolutePath)}:${line}`)
      );

    if (offenders.length > 0) {
      throw new Error(
        [
          'The 31-character Identifier_Alphabet literal appears outside',
          'server/utils/identifierAlphabet.js (Criterion 1.4):',
          ...offenders.map((offender) => `  - ${offender}`),
          '',
          'Move the constant to server/utils/identifierAlphabet.js and import it',
          'from there, or explain why this is a legitimate second, independent',
          'copy (the only accepted precedent is a *test* file asserting against',
          'its own independently-written literal, e.g. SignupCodeService.test.js,',
          'which this guard does not scan).'
        ].join('\n')
      );
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Assertion 2: run against the real tree.
// ---------------------------------------------------------------------------

describe("managedIdentifier.js's bare require graph (Criterion 1.5)", () => {
  const { localFiles, externalModules } = collectRequireGraph(MANAGED_IDENTIFIER_FILE);

  it('resolved a non-empty local closure including its two known dependencies (anti-vacuity)', () => {
    // Without this, an assertion that the closure contains nothing forbidden
    // could pass because the walk resolved nothing at all -- e.g. a broken
    // specifier regex, or a require() call shape this scanner stopped
    // matching.
    expect(localFiles.has(MANAGED_IDENTIFIER_FILE)).toBe(true);
    expect(localFiles.has(IDENTIFIER_ALPHABET_FILE)).toBe(true);
    expect(localFiles.has(CALLSIGN_VALIDATION_FILE)).toBe(true);
    expect(localFiles.size).toBeGreaterThanOrEqual(3);
  });

  it('contains nothing from server/config/ in the resolved local files', () => {
    const offenders = [...localFiles].filter((file) => file.startsWith(`${CONFIG_ROOT}${path.sep}`));

    const offenderPaths = offenders.map((file) => path.relative(REPO_ROOT, file));
    if (offenderPaths.length > 0) {
      throw new Error(
        [
          "managedIdentifier.js's require graph reaches server/config/ (Criterion 1.5),",
          'which pulls a database connection or other framework bootstrap into a',
          'module a property test must be able to load bare:',
          ...offenderPaths.map((file) => `  - ${file}`),
          '',
          'Remove the dependency on server/config/ from the offending module in the',
          'require chain, or explain why managedIdentifier.js no longer needs a bare',
          'require graph.'
        ].join('\n')
      );
    }
    expect(offenderPaths).toEqual([]);
  });

  it('requires none of express/pg/axios/pdfkit/qrcode, transitively', () => {
    const offenders = FORBIDDEN_EXTERNAL_MODULES.filter((moduleName) => externalModules.has(moduleName));

    if (offenders.length > 0) {
      throw new Error(
        [
          "managedIdentifier.js's require graph transitively requires a forbidden",
          `framework/database module (Criterion 1.5): ${offenders.join(', ')}.`,
          '',
          'Remove the dependency from the offending module in the require chain, or',
          'explain why managedIdentifier.js no longer needs a bare require graph.'
        ].join('\n')
      );
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Assertion 3: run against the real tree.
// ---------------------------------------------------------------------------

describe('No second Organisation_Prefix regex beside callsignValidation.js (Criterion 2.5)', () => {
  const utilsFiles = listNonTestJsFilesDirect(UTILS_ROOT);

  const matchesByFile = utilsFiles
    .map((absolutePath) => ({
      absolutePath,
      matches: findPrefixShapedRegexLiterals(fs.readFileSync(absolutePath, 'utf8'))
    }))
    .filter(({ matches }) => matches.length > 0);

  it('scanned server/utils/*.js directly and found callsignValidation.js and managedIdentifier.js', () => {
    expect(utilsFiles.length).toBeGreaterThanOrEqual(5);
    expect(utilsFiles).toContain(CALLSIGN_VALIDATION_FILE);
    expect(utilsFiles).toContain(MANAGED_IDENTIFIER_FILE);
  });

  it('found a prefix-shaped regex literal in callsignValidation.js (anti-vacuity)', () => {
    const callsignValidationEntry = matchesByFile.find(
      ({ absolutePath }) => absolutePath === CALLSIGN_VALIDATION_FILE
    );
    expect(callsignValidationEntry).toBeDefined();
    expect(callsignValidationEntry.matches.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag managedIdentifier.js\'s whole-identifier shape predicate (negative control)', () => {
    // managedIdentifier.js's source text contains the substring
    // `[A-Za-z0-9]+`, but as part of a longer `new RegExp(\`...\`)` template
    // that also matches the separator, the marker and the body -- not a
    // standalone prefix-only regex LITERAL. This is the case decision C
    // exists to get right in both directions: the guard must fire on
    // callsignValidation.js's pattern and stay silent on this one.
    const managedIdentifierSource = fs.readFileSync(MANAGED_IDENTIFIER_FILE, 'utf8');
    expect(managedIdentifierSource).toContain('[A-Za-z0-9]+');
    const managedIdentifierEntry = matchesByFile.find(
      ({ absolutePath }) => absolutePath === MANAGED_IDENTIFIER_FILE
    );
    expect(managedIdentifierEntry).toBeUndefined();
  });

  it('appears in no other non-test module under server/utils/', () => {
    const offenders = matchesByFile
      .filter(({ absolutePath }) => absolutePath !== CALLSIGN_VALIDATION_FILE)
      .flatMap(({ absolutePath, matches }) =>
        matches.map(({ line, pattern }) => `${path.relative(REPO_ROOT, absolutePath)}:${line} /${pattern}/`)
      );

    if (offenders.length > 0) {
      throw new Error(
        [
          'A second Organisation_Prefix-shaped regex exists beside',
          'server/utils/callsignValidation.js (Criterion 2.5). This heuristic',
          'cannot decide regex EQUIVALENCE in general -- it only catches a',
          'regex LITERAL whose pattern is exactly `^[A-Za-z0-9]*$` or',
          '`^[A-Za-z0-9]+$` -- so a positive here is a real duplicate:',
          ...offenders.map((offender) => `  - ${offender}`),
          '',
          'Reuse isValidCallsignPrefix from callsignValidation.js instead of a',
          'second prefix regex, or explain why a second regex is legitimate.'
        ].join('\n')
      );
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The matching rules themselves, exercised against synthetic sources -- the
// same discipline martiEndpointContract.test.js and dateFormatConsumers.test.js
// both apply to their own extractors, so the rule (not just its result on
// today's tree) is under test, and so a future edit to any extractor above
// has a test that would fail if the rule stopped detecting what it exists to
// detect. This is also the durable record of "the guard bites": each case
// below reproduces, as a synthetic source, the shape of violation that was
// manually introduced and reverted while writing this guard against the real
// tree (a second alphabet literal in a scratch file, a `require('pg')` added
// to managedIdentifier.js, and a second `/^[A-Za-z0-9]*$/` regex literal in a
// scratch utils file), each of which was confirmed to fail this guard's real
// assertions above before being reverted.
// ---------------------------------------------------------------------------

describe('findAlphabetLiteralOccurrences: the matching rule itself', () => {
  it('finds the literal inside a plain string assignment', () => {
    const found = findAlphabetLiteralOccurrences("const X = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';\n");
    expect(found).toHaveLength(1);
  });

  it('finds the literal inside a template literal, verbatim', () => {
    const found = findAlphabetLiteralOccurrences('const X = `ABCDEFGHJKMNPQRSTUVWXYZ23456789`;\n');
    expect(found).toHaveLength(1);
  });

  it('does not flag an interpolation that merely NAMES the constant', () => {
    const found = findAlphabetLiteralOccurrences(
      'const PATTERN = `^[A-Za-z0-9]+${SEP}[${MARKERS}][${AMBIGUITY_FREE_ALPHABET}]{7}$`;\n'
    );
    expect(found).toEqual([]);
  });

  it('does not flag a mention in a comment', () => {
    const found = findAlphabetLiteralOccurrences(
      "// the alphabet is 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'\nconst x = 1;\n"
    );
    expect(found).toEqual([]);
  });

  it('reports the line the offending literal sits on', () => {
    const source = ["const a = 1;", "const b = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';", ''].join('\n');
    expect(findAlphabetLiteralOccurrences(source)[0].line).toBe(2);
  });
});

describe('collectRequireGraph: the matching rule itself', () => {
  const scratchDir = path.join(UTILS_ROOT, '__identifierAlphabetSingleDefinitionScratch__');

  afterEach(() => {
    if (fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('walks a local chain and records a bare external module', () => {
    fs.mkdirSync(scratchDir, { recursive: true });
    const entry = path.join(scratchDir, 'entry.js');
    const dep = path.join(scratchDir, 'dep.js');
    fs.writeFileSync(entry, "const crypto = require('crypto');\nconst dep = require('./dep');\nmodule.exports = { crypto, dep };\n");
    fs.writeFileSync(dep, "module.exports = { ok: true };\n");

    const { localFiles, externalModules } = collectRequireGraph(entry);

    expect(localFiles.has(entry)).toBe(true);
    expect(localFiles.has(dep)).toBe(true);
    expect(externalModules.has('crypto')).toBe(true);
  });

  it('detects a forbidden module reached transitively through a local dependency', () => {
    // Reproduces, in a scratch file, the exact violation manually introduced
    // against server/utils/managedIdentifier.js while writing this guard
    // (a `require('pg')` added at the top of the file), which was confirmed
    // to fail the real "requires none of express/pg/axios/pdfkit/qrcode"
    // assertion above before being reverted.
    fs.mkdirSync(scratchDir, { recursive: true });
    const entry = path.join(scratchDir, 'entry.js');
    const dep = path.join(scratchDir, 'dep.js');
    fs.writeFileSync(entry, "const dep = require('./dep');\nmodule.exports = { dep };\n");
    fs.writeFileSync(dep, "const pg = require('pg');\nmodule.exports = { pg };\n");

    const { externalModules } = collectRequireGraph(entry);

    expect(externalModules.has('pg')).toBe(true);
  });

  it('does not follow a bare (non-relative) specifier into node_modules', () => {
    fs.mkdirSync(scratchDir, { recursive: true });
    const entry = path.join(scratchDir, 'entry.js');
    fs.writeFileSync(entry, "const express = require('express');\n");

    const { localFiles, externalModules } = collectRequireGraph(entry);

    expect(localFiles.size).toBe(1);
    expect(externalModules.has('express')).toBe(true);
  });
});

describe('findPrefixShapedRegexLiterals: the matching rule itself', () => {
  it('matches a standalone anchored `[A-Za-z0-9]*` regex literal', () => {
    const found = findPrefixShapedRegexLiterals('const X = /^[A-Za-z0-9]*$/;\n');
    expect(found).toHaveLength(1);
    expect(found[0].pattern).toBe('^[A-Za-z0-9]*$');
  });

  it('matches a standalone anchored `[A-Za-z0-9]+` regex literal', () => {
    const found = findPrefixShapedRegexLiterals('const X = /^[A-Za-z0-9]+$/;\n');
    expect(found).toHaveLength(1);
  });

  it('does not match a pattern with extra characters in the class', () => {
    // callsignValidation.js's OWN suffix pattern -- a real, adjacent,
    // deliberately-different regex that must not be flagged as a duplicate
    // of the prefix pattern.
    const found = findPrefixShapedRegexLiterals('const X = /^[A-Za-z0-9.-]*$/;\n');
    expect(found).toEqual([]);
  });

  it('does not match a template literal built via new RegExp(...), even containing the substring', () => {
    // Reproduces managedIdentifier.js's real MANAGED_IDENTIFIER_PATTERN
    // shape: a template literal handed to `new RegExp(...)`, never a
    // `/.../` regex literal, so it is out of scope for this heuristic by
    // construction (decision C).
    const found = findPrefixShapedRegexLiterals(
      'const X = new RegExp(`^[A-Za-z0-9]+${SEP}[DU][ABC]{7}$`);\n'
    );
    expect(found).toEqual([]);
  });

  it('does not match a mention in a comment', () => {
    const found = findPrefixShapedRegexLiterals('// matches /^[A-Za-z0-9]*$/ style patterns\nconst x = 1;\n');
    expect(found).toEqual([]);
  });

  it('detects a second standalone prefix regex added to a scratch utils file', () => {
    // Reproduces the exact violation manually introduced against a scratch
    // file under server/utils/ while writing this guard (a second
    // `const SECOND_PREFIX_PATTERN = /^[A-Za-z0-9]*$/;`), confirmed to fail
    // the real "appears in no other non-test module" assertion above before
    // the scratch file was deleted.
    const found = findPrefixShapedRegexLiterals(
      "const SECOND_PREFIX_PATTERN = /^[A-Za-z0-9]*$/;\nmodule.exports = { SECOND_PREFIX_PATTERN };\n"
    );
    expect(found).toHaveLength(1);
  });

  it('reports the line the offending regex literal sits on', () => {
    const source = ['const a = 1;', 'const X = /^[A-Za-z0-9]*$/;', ''].join('\n');
    expect(findPrefixShapedRegexLiterals(source)[0].line).toBe(2);
  });
});
