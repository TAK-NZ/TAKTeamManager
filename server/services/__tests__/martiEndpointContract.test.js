/**
 * Feature: device-management, Requirement 14.4 (task 23.4) -- the STRUCTURAL
 * guard that stops `/Marti/clients` coming back.
 *
 * `/Marti/clients` does not exist on TAK Server: it answers 404 and is absent
 * from `tak-server-openapispec.json` entirely. The original implementation
 * called it from `getConnectedSubscriptions()`, and because a
 * graceful-404-as-empty branch sat in front of that call, the endpoint's
 * non-existence read as "no clients observed" -- `last_seen_at` stayed null
 * indefinitely and nothing was ever logged as wrong (Requirement 14.5). Task
 * 21.1 DELETED the method rather than repointing it, precisely so no caller
 * could keep the old semantics by accident.
 *
 * A behavioural test can only prove that the code paths it drives do not call a
 * bad endpoint (that is what `SubscriptionPoller.test.js`'s "request surface"
 * describe block does for the poller). This test is the repo-wide version: it
 * reads the `server/` source tree and checks the Marti paths it REQUESTS
 * against the OpenAPI document, so a stray call added anywhere -- in a path no
 * test happens to exercise -- fails here.
 *
 * Follows the conventions of `server/workers/operationSchemas.test.js`, the
 * other static-analysis test in this repo: read source with `fs`/`path`, and
 * guard the extractor against silently returning nothing (an extraction that
 * finds zero paths would make every assertion below pass while proving
 * nothing).
 *
 * DECISIONS made here, recorded because they define what this test does and
 * does not catch:
 *
 * 1. SCOPE: the whole `server/` tree is scanned, not just
 *    `server/services/TakServerService.js`. Today every Marti request funnels
 *    through that one file, but scanning the tree also catches a future stray
 *    `this.client.get('/Marti/...')` added in a worker, route or service, and
 *    it produces no false positives (verified: outside test files, only
 *    `TakServerService.js` contains a `/Marti` string literal). `scripts/`,
 *    `database/` and `client/` are excluded: no Marti request is issued from
 *    any of them, and the only Marti mention there is a prose comment in the
 *    `tak_devices` migration.
 *
 * 2. TEST FILES ARE EXCLUDED. A test may legitimately name `/Marti/clients` --
 *    in a comment, or in a negative assertion, as `SubscriptionPoller.test.js`
 *    now does -- so including tests would make the prohibition unassertable.
 *
 * 3. REQUESTS, NOT MENTIONS. Paths are extracted from string/template literals
 *    in CODE positions only; comments are skipped. This matters in both
 *    directions: `TakServerService.getClientEndpoints()`'s doc comment
 *    deliberately explains why `/Marti/clients` was deleted, and that
 *    explanation must not read as a call (asserted below as an explicit
 *    negative control), while a path appearing only in a comment must not count
 *    as a path the code requests either.
 *
 * 4. TEMPLATE LITERALS are normalised, not prefix-matched. The revoke path is
 *    built as `` `/Marti/api/certadmin/cert/revoke/${idsParam}` ``, whose
 *    OpenAPI counterpart is the parameterised `/Marti/api/certadmin/cert/revoke/{ids}`.
 *    Each `${...}` interpolation collapses to a single placeholder segment, and
 *    matching is done segment-by-segment with a placeholder matching any
 *    `{name}` segment. Prefix matching was rejected: `/Marti/api/certadmin/cert`
 *    is a prefix of `/Marti/api/certadmin/cert/delete/{ids}`, so a prefix rule
 *    would let a typo'd or undocumented sub-path pass by matching some longer
 *    documented sibling.
 *
 * 5. The OpenAPI document is PARSED, not string-matched, so a path that appears
 *    only inside a description or an example cannot count as documented -- only
 *    a key of the top-level `paths` object does.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_ROOT = path.join(REPO_ROOT, 'server');
const OPENAPI_SPEC_PATH = path.join(REPO_ROOT, 'docs', 'refs', 'tak-server-openapispec.json');

// The endpoint Requirement 14.4 names explicitly.
const UNDOCUMENTED_ENDPOINT = '/Marti/clients';

// Stands in for one `${...}` interpolation in a template literal. Chosen to be
// something that cannot occur in a real URL path segment.
const PLACEHOLDER_SEGMENT = '${}';

// The Marti paths this feature is known to request, as normalised code paths.
// Used ONLY as the extractor's anti-vacuity check (decision 5 above): it
// asserts the scan still sees the code, and is deliberately a subset -- a newly
// added Marti request does not have to be listed here, it just has to be
// documented in the OpenAPI spec.
const KNOWN_REQUESTED_PATHS = [
  '/Marti/api/certadmin/cert',
  '/Marti/api/certadmin/cert/active',
  '/Marti/api/certadmin/cert/revoked',
  `/Marti/api/certadmin/cert/revoke/${PLACEHOLDER_SEGMENT}`,
  '/Marti/api/clientEndPoints',
  // Requirement 13 freshening follow-up: SubscriptionPoller's supplementary
  // Last_Seen freshness signal for currently-live connections. Documented as
  // OpenAPI `getAllSubscriptions` -> `ApiResponseSetSubscriptionInfo`.
  '/Marti/api/subscriptions/all'
];

/**
 * Every non-test `.js` file under `server/`, recursively.
 *
 * `__tests__` directories and `*.test.js` files are excluded per decision 2.
 */
function listServerSourceFiles(directory = SERVER_ROOT) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      files.push(...listServerSourceFiles(absolutePath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.js')) continue;
    if (entry.name.endsWith('.test.js')) continue;
    files.push(absolutePath);
  }
  return files;
}

// Characters after which a `/` opens a regular expression rather than being a
// division operator, plus the keywords that have the same effect. Needed only
// so that a regex literal containing a quote character cannot desynchronise the
// string-literal scanner below.
const REGEX_PRECEDING_PUNCTUATION = new Set(
  ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']
);
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await'
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
 * Collects every string, and template, literal that appears in a CODE position,
 * with the 1-based line it starts on.
 *
 * A small hand-written scanner is used rather than a regex over the raw text
 * because the distinction this test rests on -- code versus comment -- is not
 * expressible as one: `TakServerService.js` names `/Marti/clients` in a doc
 * comment on purpose, and a regex over raw text would read that as a call.
 * A full parser would work too, but the repo has no AST dependency and this
 * needs to answer exactly one question about the source.
 *
 * Comments are skipped, `\`-escapes inside literals are honoured, regex
 * literals are skipped so a quote inside one cannot be mistaken for the start
 * of a string, and a template literal's `${...}` interpolations are recorded
 * verbatim in the returned value (normalisation happens later, in
 * `normalizeCodePath`).
 */
function collectCodeStringLiterals(source) {
  const literals = [];
  const length = source.length;
  let index = 0;
  let line = 1;

  while (index < length) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (character === '\n') {
      line += 1;
      index += 1;
      continue;
    }

    // Line comment.
    if (character === '/' && nextCharacter === '/') {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }

    // Block comment (including JSDoc).
    if (character === '/' && nextCharacter === '*') {
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line += 1;
        index += 1;
      }
      index += 2;
      continue;
    }

    if (character === '\'' || character === '"' || character === '`') {
      const quote = character;
      const startLine = line;
      let value = '';
      // Nesting depth of `${ ... }` inside a template literal. While > 0 the
      // scanner is inside an interpolation, where the closing backtick does not
      // terminate the literal.
      let interpolationDepth = 0;
      index += 1;
      while (index < length) {
        const current = source[index];
        if (current === '\\') {
          value += current + (source[index + 1] ?? '');
          if (source[index + 1] === '\n') line += 1;
          index += 2;
          continue;
        }
        if (current === '\n') {
          line += 1;
          // An unterminated single/double-quoted literal cannot span a line;
          // bail out rather than swallowing the rest of the file.
          if (quote !== '`') break;
        }
        if (quote === '`' && current === '$' && source[index + 1] === '{') {
          interpolationDepth += 1;
          value += '${';
          index += 2;
          continue;
        }
        if (interpolationDepth > 0 && current === '}') {
          interpolationDepth -= 1;
          value += '}';
          index += 1;
          continue;
        }
        if (current === quote && interpolationDepth === 0) {
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      literals.push({ value, line: startLine });
      continue;
    }

    if (character === '/' && regexLiteralStartsAt(source, index)) {
      index += 1;
      let inCharacterClass = false;
      while (index < length) {
        const current = source[index];
        if (current === '\\') {
          index += 2;
          continue;
        }
        if (current === '\n') break;
        if (current === '[') inCharacterClass = true;
        else if (current === ']') inCharacterClass = false;
        else if (current === '/' && !inCharacterClass) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    index += 1;
  }

  return literals;
}

/**
 * The Marti request paths a single source file contains, as
 * `{ file, line, literal, requestPath }` records.
 *
 * A literal counts when it contains `/Marti`, and the path taken from it starts
 * at that `/Marti` -- so an absolute-URL form (`https://host/Marti/...`) is
 * caught as well as the relative form this codebase actually uses. Any query
 * string is dropped: `?secAgo=...` is not part of an OpenAPI path key, and this
 * codebase passes query parameters through axios' `params` anyway.
 */
function extractMartiRequests(absolutePath) {
  const source = fs.readFileSync(absolutePath, 'utf8');
  const relativePath = path.relative(REPO_ROOT, absolutePath);

  return collectCodeStringLiterals(source)
    .filter(({ value }) => value.includes('/Marti'))
    .map(({ value, line }) => ({
      file: relativePath,
      line,
      literal: value,
      requestPath: normalizeCodePath(value.slice(value.indexOf('/Marti')))
    }));
}

/** Collapses each `${...}` interpolation to one placeholder segment. */
function normalizeCodePath(rawPath) {
  return rawPath
    .replace(/\$\{[^}]*\}/g, PLACEHOLDER_SEGMENT)
    .split('?')[0]
    .trim();
}

/**
 * The documented path a code path corresponds to, or null.
 *
 * Segment-by-segment (decision 4): equal segments match, and a placeholder
 * segment matches any `{name}` segment of a parameterised documented path.
 */
function findDocumentedPath(requestPath, documentedPaths) {
  const requestSegments = requestPath.split('/');
  return documentedPaths.find((documentedPath) => {
    const documentedSegments = documentedPath.split('/');
    if (documentedSegments.length !== requestSegments.length) return false;
    return documentedSegments.every((documentedSegment, position) => {
      const requestSegment = requestSegments[position];
      if (requestSegment === PLACEHOLDER_SEGMENT) return /^\{.+\}$/.test(documentedSegment);
      return documentedSegment === requestSegment;
    });
  }) ?? null;
}

const sourceFiles = listServerSourceFiles();
const martiRequests = sourceFiles.flatMap((absolutePath) => extractMartiRequests(absolutePath));
const requestedPaths = [...new Set(martiRequests.map(({ requestPath }) => requestPath))].sort();

const openApiDocument = JSON.parse(fs.readFileSync(OPENAPI_SPEC_PATH, 'utf8'));
const documentedPaths = Object.keys(openApiDocument.paths ?? {});

describe('Marti endpoint contract: extraction sanity', () => {
  // Everything below is a statement about a set derived from the source tree.
  // If the derivation broke -- a moved directory, a scanner that stopped
  // matching the code's shape -- those sets go empty and every assertion passes
  // while proving nothing. These cases fail instead. Same purpose as
  // `operationSchemas.test.js`'s `extractHandledOperationTypes` sanity check.
  it('scanned a plausible number of non-test server source files', () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(50);
    expect(sourceFiles).toContain(
      path.join(SERVER_ROOT, 'services', 'TakServerService.js')
    );
    expect(sourceFiles.some((file) => file.endsWith('.test.js'))).toBe(false);
    expect(sourceFiles.some((file) => file.includes(`${path.sep}__tests__${path.sep}`))).toBe(false);
  });

  it('found at least the Marti paths this feature is known to request', () => {
    expect(requestedPaths).toEqual(expect.arrayContaining(KNOWN_REQUESTED_PATHS));
  });

  it('read the OpenAPI document as a document, and found its Marti paths', () => {
    expect(openApiDocument.openapi).toEqual(expect.any(String));
    expect(documentedPaths.length).toBeGreaterThan(100);
    // Control for the negative assertion in the next describe block: the
    // parsed `paths` object really does carry Marti keys, so a missing
    // `/Marti/clients` means absent-from-the-spec and not empty-path-set.
    expect(documentedPaths).toContain('/Marti/api/clientEndPoints');
    expect(documentedPaths).toContain('/Marti/api/certadmin/cert/revoke/{ids}');
  });
});

describe('Marti endpoint contract: /Marti/clients is never requested (Requirement 14.4)', () => {
  it('is absent from tak-server-openapispec.json, which is why it may not be called', () => {
    expect(documentedPaths).not.toContain(UNDOCUMENTED_ENDPOINT);
    expect(
      documentedPaths.some((documentedPath) => documentedPath.startsWith(`${UNDOCUMENTED_ENDPOINT}/`))
    ).toBe(false);
  });

  it('appears in no string literal of any server source file', () => {
    // Reported as file + line + the offending literal, so a failure names the
    // call site instead of just asserting that one exists somewhere.
    const offenders = martiRequests
      .filter(({ literal }) => literal.includes(UNDOCUMENTED_ENDPOINT))
      .map(({ file, line, literal }) => `${file}:${line} ${literal}`);

    expect(offenders).toEqual([]);
  });

  it('is still explained in a comment, and that explanation does not read as a call', () => {
    // Negative control for decision 3. `TakServerService.getClientEndpoints()`
    // documents why `/Marti/clients` was deleted rather than repointed, so the
    // raw text of that file DOES contain the string. If comment-skipping ever
    // broke, this file would start failing the previous case -- and if the
    // extractor instead stopped seeing the file at all, this case fails.
    const takServerServicePath = path.join(SERVER_ROOT, 'services', 'TakServerService.js');
    const rawSource = fs.readFileSync(takServerServicePath, 'utf8');

    expect(rawSource).toContain(UNDOCUMENTED_ENDPOINT);
    expect(
      collectCodeStringLiterals(rawSource).some(({ value }) => value.includes(UNDOCUMENTED_ENDPOINT))
    ).toBe(false);
  });
});

describe('Marti endpoint contract: every requested path is documented (Requirement 14.4)', () => {
  it.each(requestedPaths)('%s is a path in tak-server-openapispec.json', (requestPath) => {
    expect(findDocumentedPath(requestPath, documentedPaths)).not.toBeNull();
  });

  it('reports every undocumented path at once, with its call site', () => {
    // The `it.each` above fails per path; this one fails with the whole list,
    // which is the more useful failure when a base path changes.
    const undocumented = martiRequests
      .filter(({ requestPath }) => findDocumentedPath(requestPath, documentedPaths) === null)
      .map(({ file, line, requestPath }) => `${file}:${line} ${requestPath}`);

    expect(undocumented).toEqual([]);
  });

  it('does not accept a path merely because a documented path extends it', () => {
    // Guards the matching rule itself (decision 4). `/Marti/api/certadmin/cert`
    // is documented and is a prefix of several documented sub-paths, so a
    // prefix-based rule would wave through this typo; segment-wise equality
    // does not.
    expect(findDocumentedPath('/Marti/api/certadmin/certs', documentedPaths)).toBeNull();
    expect(findDocumentedPath('/Marti/api/certadmin/cert/actives', documentedPaths)).toBeNull();
    expect(findDocumentedPath(UNDOCUMENTED_ENDPOINT, documentedPaths)).toBeNull();

    // ...while the two shapes the code actually uses do match, the second
    // through the placeholder rule.
    expect(findDocumentedPath('/Marti/api/certadmin/cert/active', documentedPaths))
      .toBe('/Marti/api/certadmin/cert/active');
    expect(findDocumentedPath(`/Marti/api/certadmin/cert/revoke/${PLACEHOLDER_SEGMENT}`, documentedPaths))
      .toBe('/Marti/api/certadmin/cert/revoke/{ids}');
  });
});
