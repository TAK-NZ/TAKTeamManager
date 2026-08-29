import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve, sep } from 'node:path'

// Validates: Requirements 2.12, 2.1, 2.2
//
// Feature: date-tooltips-and-folder-contrast, task 7.1 -- the STRUCTURAL drift
// guard that keeps the Date_Tooltip in ONE place.
//
// Criterion 2.12 does not ask for a safety net around a behaviour described
// elsewhere; it makes this test the behaviour. `FormattedDate` is to be the only
// non-test client module that renders a Date_Format_Helpers return value into
// the document (Criterion 2.1), so that a new date render site acquires the
// tooltip by using the component rather than by opting in (Criterion 2.2).
// Nothing about that survives contact with a future edit unless a test says so:
// a page that calls `formatDateTime()` into a `<td>` renders a perfectly
// correct date with no tooltip, and no behavioural test anywhere would notice.
// This is the mechanical equivalent of device-management Criterion 16.6's
// one-shared-row-component rule.
//
// BEFORE this spec, six non-test modules imported the two helpers:
// `OrgInterestRequests.jsx`, `Admin.jsx`, `AuditLogs.jsx`, `Requests.jsx`,
// `Users.jsx` and `DeviceListRow.jsx` -- the six adopting files of tasks
// 6.1-6.6. AFTER it, exactly one does: `components/FormattedDate.jsx`. That
// six-to-one move is what this file pins in place.
//
// Follows the conventions of `server/services/__tests__/martiEndpointContract.test.js`,
// this repo's other static-analysis guard: read the source tree with `fs`, keep
// the extractor a pure function of source text so the matching rule itself can
// be tested, and guard against the extractor silently returning nothing (a walk
// that found no files would pass every assertion below while proving nothing).
//
// DECISIONS, recorded because they define what this guard does and does not
// catch:
//
// 1. NON-TEST MODULES ONLY. Criterion 2.12 scopes the rule to non-test client
//    modules, and test files legitimately import the helpers to compute the
//    exact string they then expect -- `Dashboard.test.jsx`,
//    `UserDevicesModal.test.jsx` and `Requests.test.jsx` all do, and
//    `FormattedDate.property.test.jsx` rests on it entirely. Including tests
//    would make the prohibition unassertable.
//
// 2. THE TWO HELPERS BY NAME, NOT THE MODULE PATH. `utils/dateFormat.js`
//    exports more than the two renderers, and importing the rest is not a
//    violation of anything: `App.jsx` imports `setDisplayTimezone` to install
//    the zone before the first date renders, and `DeviceListRow.jsx` imports
//    `hasRenderableDate` to make a LAYOUT decision it cannot make with a
//    renderer (design.md Decision 7 -- it is why task 4.1 exported the
//    predicate separately). Neither renders a helper's return value into the
//    document. A guard written against the module path would flag both forever,
//    and this is exactly how the glossary defines Date_Format_Helpers: the two
//    functions, not the file.
//
// 3. A NAMESPACE IMPORT COUNTS. `import * as dateFormat from '../utils/dateFormat'`
//    reaches `dateFormat.formatDate` without ever naming it in a specifier, so
//    a named-specifier check alone would wave it through. So would a dynamic
//    `import()` or a `require()` of the module. All three are treated as
//    reaching the helpers.
//
// 4. IMPORTS, NOT MENTIONS. Comments are stripped before matching and import
//    statements are matched only at the start of a line, so prose that names an
//    import does not read as one. Two independent defences on purpose: this
//    file's whole value is that it fails when it should, and either mechanism
//    alone has a failure mode the other covers.
//
// 5. RELATIVE SPECIFIERS ARE RESOLVED, not string-matched. `'../utils/dateFormat'`
//    from `components/` and `'./utils/dateFormat'` from `src/` are the same
//    module and both must count; a `utils/dateFormat` living somewhere else
//    entirely must not.

const HERE = dirname(fileURLToPath(import.meta.url))

/** `client/src` -- the tree Criterion 2.12 scopes the rule to. */
const SRC_ROOT = resolve(HERE, '..')

/** The module under guard, extensionless, as an absolute path. */
const DATE_FORMAT_MODULE = join(SRC_ROOT, 'utils', 'dateFormat')

/**
 * The Date_Format_Helpers, by name (decision 2). `hasRenderableDate`,
 * `zonedDayNumber`, `setDisplayTimezone`, `getDisplayTimezone` and
 * `DEFAULT_DISPLAY_TIMEZONE` are deliberately NOT here.
 */
const DATE_FORMAT_HELPERS = ['formatDate', 'formatDateTime']

/**
 * The explicitly enumerated allow-list Criterion 2.12 requires, as paths
 * relative to `client/src` with `/` separators. Exactly one entry, and adding a
 * second is meant to be a deliberate, reviewed act -- which is the entire point
 * of the criterion.
 */
const ALLOWED_HELPER_CONSUMERS = ['components/FormattedDate.jsx']

/** Extensions a module may resolve through, longest first. */
const MODULE_EXTENSIONS = ['.jsx', '.js']

/**
 * The two acceptable resolutions for a violation, quoted in the failure so the
 * next person does not have to find this file to learn what to do.
 */
const RESOLUTIONS = [
  'Either: (a) route the date through the `FormattedDate` component, which',
  '    renders the identical string and carries the Date_Tooltip (Criteria 2.1,',
  '    2.2, 2.3); or (b) amend ALLOWED_HELPER_CONSUMERS in this file',
  '    deliberately, recording why that module renders a date without the',
  '    tooltip. A silent third option is what Criterion 2.12 exists to remove.'
].join('\n')

/** `a/b/c.jsx` -- a path relative to `client/src`, separator-normalised. */
function srcRelative(absolutePath) {
  return relative(SRC_ROOT, absolutePath).split(sep).join('/')
}

/** Whether a file name is a test file (decision 1). */
function isTestFile(fileName) {
  return /\.(test|property\.test)\.(js|jsx)$/.test(fileName)
}

/**
 * Every non-test `.js`/`.jsx` file under `client/src`, recursively.
 *
 * `*.test.js`, `*.test.jsx` and `*.property.test.js*` are excluded per decision
 * 1 -- which also excludes THIS file, so the guard does not scan itself.
 */
function listNonTestModules(directory = SRC_ROOT) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      files.push(...listNonTestModules(absolutePath))
      continue
    }
    if (!entry.isFile()) continue
    if (!/\.(js|jsx)$/.test(entry.name)) continue
    if (isTestFile(entry.name)) continue
    files.push(absolutePath)
  }
  return files
}

/**
 * `source` with line and block comments replaced by equivalent whitespace, so
 * offsets and line numbers survive (decision 4).
 *
 * String and template literals are tracked so a `//` or `/*` inside one is not
 * mistaken for a comment. Regex literals are NOT tracked: a regex containing a
 * lone quote character could desynchronise this scanner, which is precisely why
 * matching is ALSO anchored to the start of a line, and why the anti-vacuity
 * block below asserts the extractor still sees the real imports this codebase
 * contains. A stripper that quietly ate a real import statement would fail
 * there rather than pass here.
 */
function stripComments(source) {
  let output = ''
  let index = 0
  const length = source.length

  while (index < length) {
    const character = source[index]
    const next = source[index + 1]

    if (character === '/' && next === '/') {
      while (index < length && source[index] !== '\n') {
        output += ' '
        index += 1
      }
      continue
    }

    if (character === '/' && next === '*') {
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        output += source[index] === '\n' ? '\n' : ' '
        index += 1
      }
      output += '  '
      index += 2
      continue
    }

    if (character === '\'' || character === '"' || character === '`') {
      const quote = character
      output += character
      index += 1
      while (index < length) {
        const current = source[index]
        if (current === '\\') {
          output += current + (source[index + 1] ?? '')
          index += 2
          continue
        }
        output += current
        index += 1
        if (current === quote) break
        // An unterminated single/double-quoted literal cannot span a line.
        if (current === '\n' && quote !== '`') break
      }
      continue
    }

    output += character
    index += 1
  }

  return output
}

/**
 * A static `import ... from '<specifier>'` declaration at the start of a line.
 *
 * The clause between `import` and `from` may span lines (`FormattedDate.jsx`'s
 * own import does) but may not contain a quote or a semicolon -- which is what
 * stops a side-effect `import './x.css'` from swallowing the NEXT statement's
 * `from` clause and mis-attributing its specifiers.
 */
const STATIC_IMPORT = /^import\s+([^'"`;]*?)from\s*(['"])([^'"]+)\2/gm

/** A dynamic `import('<specifier>')` or `require('<specifier>')` anywhere (decision 3). */
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*(['"])([^'"]+)\1\s*\)/g

/** The 1-based line `offset` falls on. */
function lineAt(source, offset) {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n') line += 1
  }
  return line
}

/**
 * The names an import clause binds FROM the module, as written on the module's
 * side of any `as` rename -- so `import { formatDate as fd }` still reports
 * `formatDate`.
 *
 * @returns {{names: string[], namespace: boolean}}
 */
function parseImportClause(clause) {
  const namespace = /\*\s*as\s+[A-Za-z_$][\w$]*/.test(clause)
  const names = []
  const braces = clause.match(/\{([^}]*)\}/)
  if (braces) {
    for (const entry of braces[1].split(',')) {
      const name = entry.trim().split(/\s+as\s+/)[0].trim()
      if (name) names.push(name)
    }
  }
  return { names, namespace }
}

/**
 * Whether a relative specifier written in `fromFile` resolves to
 * `utils/dateFormat` (decision 5). A bare specifier -- a package -- never does.
 */
function resolvesToDateFormat(specifier, fromFile) {
  if (!specifier.startsWith('.')) return false
  let resolved = resolve(dirname(fromFile), specifier)
  for (const extension of MODULE_EXTENSIONS) {
    if (resolved.endsWith(extension)) {
      resolved = resolved.slice(0, -extension.length)
      break
    }
  }
  return resolved === DATE_FORMAT_MODULE
}

/**
 * Every import of `utils/dateFormat` in one module's source, as
 * `{ file, line, kind, names, namespace }` records.
 *
 * A pure function of `(source, absolutePath)` on purpose: the matching rule is
 * the thing this guard rests on, so it is exercised directly against synthetic
 * sources in the last describe block below, the way
 * `martiEndpointContract.test.js` exercises its path matcher.
 */
function extractDateFormatImports(source, absolutePath) {
  const code = stripComments(source)
  const file = srcRelative(absolutePath)
  const records = []

  for (const match of code.matchAll(STATIC_IMPORT)) {
    if (!resolvesToDateFormat(match[3], absolutePath)) continue
    const { names, namespace } = parseImportClause(match[1])
    records.push({
      file,
      line: lineAt(code, match.index),
      kind: namespace ? 'namespace' : 'named',
      names,
      namespace
    })
  }

  for (const match of code.matchAll(DYNAMIC_IMPORT)) {
    if (!resolvesToDateFormat(match[2], absolutePath)) continue
    records.push({
      file,
      line: lineAt(code, match.index),
      kind: 'dynamic',
      names: [],
      // A dynamic import hands over the whole module namespace, so it reaches
      // the helpers by the same route `import *` does.
      namespace: true
    })
  }

  return records
}

/** Whether a record reaches either Date_Format_Helper (decisions 2 and 3). */
function reachesHelpers(record) {
  return record.namespace || record.names.some((name) => DATE_FORMAT_HELPERS.includes(name))
}

const scannedModules = listNonTestModules()
const dateFormatImports = scannedModules.flatMap((absolutePath) =>
  extractDateFormatImports(readFileSync(absolutePath, 'utf8'), absolutePath)
)
const helperImports = dateFormatImports.filter(reachesHelpers)
const helperConsumers = [...new Set(helperImports.map(({ file }) => file))].sort()

describe('date-format consumer guard: extraction sanity', () => {
  // Every assertion in the next block is a statement about a set derived from
  // the source tree. If the derivation broke -- a moved directory, a comment
  // stripper that ate a statement, a regex that stopped matching the shape the
  // code is written in -- that set goes empty and the guard passes while
  // measuring nothing. These cases fail instead.
  it('walked client/src and found only non-test modules', () => {
    expect(scannedModules.length).toBeGreaterThanOrEqual(30)
    expect(scannedModules).toContain(join(SRC_ROOT, 'components', 'FormattedDate.jsx'))
    expect(scannedModules).toContain(join(SRC_ROOT, 'utils', 'dateFormat.js'))
    expect(scannedModules.some((file) => isTestFile(file))).toBe(false)
  })

  it('found the allow-listed module importing the helpers', () => {
    // The anti-vacuity check task 7.1 names: the scan must SEE the one
    // legitimate consumer, importing both helpers, through a multi-line import
    // clause. A walker that found nothing would satisfy the set equality below
    // with an empty set.
    const formattedDate = helperImports.filter(
      ({ file }) => file === 'components/FormattedDate.jsx'
    )
    expect(formattedDate).toHaveLength(1)
    expect(formattedDate[0].names).toEqual(expect.arrayContaining(DATE_FORMAT_HELPERS))
  })

  it('found the non-helper imports too, which are not violations', () => {
    // Decision 2's positive control: a real, non-test, non-helper import
    // written in a different shape from the allow-listed FormattedDate.jsx
    // import above, so an extractor that only handled multi-line clauses
    // would fail here.
    //
    // Bugfix (device-management-mobile-usability follow-up: "Currently
    // Connected" drops the Last_Seen timestamp when connected): this used
    // to also assert on `components/DeviceListRow.jsx`'s own
    // `hasRenderableDate` import, which existed ONLY to decide whether to
    // render a connected Device's timestamp beside its "Connected" label.
    // Since a connected Device no longer shows that timestamp at all, that
    // import became dead code and was removed -- `DeviceListRow.jsx` no
    // longer imports from `dateFormat.js` at all, so it is gone from this
    // assertion too, rather than kept as a stale fixture.
    const byFile = new Map(dateFormatImports.map((record) => [record.file, record]))

    expect(byFile.get('App.jsx')?.names).toEqual(['setDisplayTimezone', 'setDisplayLocale'])
    expect(reachesHelpers(byFile.get('App.jsx'))).toBe(false)
  })
})

describe('date-format consumer guard: FormattedDate is the only consumer (Criterion 2.12)', () => {
  it('reports every module importing formatDate/formatDateTime, with its line', () => {
    const offenders = helperImports
      .filter(({ file }) => !ALLOWED_HELPER_CONSUMERS.includes(file))
      .map(({ file, line, kind, names }) =>
        `${file}:${line} imports ${kind === 'named' ? names.join(', ') : `the whole module (${kind})`}`
      )

    expect(
      offenders,
      [
        'A non-test client module reaches the Date_Format_Helpers directly, so it',
        'renders a date with no Date_Tooltip (Criteria 2.1, 2.12):',
        ...offenders.map((offender) => `  - ${offender}`),
        '',
        RESOLUTIONS
      ].join('\n')
    ).toEqual([])
  })

  it('the set of non-test consumers equals the enumerated allow-list', () => {
    // The criterion is an EQUALITY, not a subset: an allow-list entry that no
    // longer imports the helpers is drift in the other direction and should be
    // removed from the list.
    expect(helperConsumers).toEqual([...ALLOWED_HELPER_CONSUMERS].sort())
  })
})

describe('date-format consumer guard: the matching rule itself', () => {
  // Guards the extractor the way `martiEndpointContract.test.js` guards its
  // path matcher. A guard whose detection rule is untested is a guard that
  // might not be able to fail.
  const asModule = (relativePath, source) =>
    extractDateFormatImports(source, join(SRC_ROOT, ...relativePath.split('/')))

  const helperImportsIn = (relativePath, source) =>
    asModule(relativePath, source).filter(reachesHelpers)

  it('catches a plain named helper import', () => {
    const found = helperImportsIn(
      'pages/Somewhere.jsx',
      "import { formatDateTime } from '../utils/dateFormat'\n"
    )
    expect(found).toHaveLength(1)
    expect(found[0].names).toEqual(['formatDateTime'])
  })

  it('catches a renamed helper import by the name it binds from the module', () => {
    expect(
      helperImportsIn(
        'pages/Somewhere.jsx',
        "import { formatDate as isoDate } from '../utils/dateFormat'\n"
      )
    ).toHaveLength(1)
  })

  it('catches a multi-line clause, an explicit extension and a default alongside', () => {
    expect(
      helperImportsIn(
        'components/Somewhere.jsx',
        'import Thing, {\n  hasRenderableDate,\n  formatDate,\n} from \'../utils/dateFormat.js\'\n'
      )
    ).toHaveLength(1)
    expect(
      helperImportsIn('App.jsx', "import { formatDate } from './utils/dateFormat.jsx'\n")
    ).toHaveLength(1)
  })

  it('catches a namespace import, which names no specifier at all (decision 3)', () => {
    const found = helperImportsIn(
      'pages/Somewhere.jsx',
      "import * as dateFormat from '../utils/dateFormat'\n"
    )
    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('namespace')
  })

  it('catches a dynamic import and a require of the module (decision 3)', () => {
    expect(
      helperImportsIn(
        'pages/Somewhere.jsx',
        "const later = async () => (await import('../utils/dateFormat')).formatDate(x)\n"
      )
    ).toHaveLength(1)
    expect(
      helperImportsIn('pages/Somewhere.jsx', "const m = require('../utils/dateFormat')\n")
    ).toHaveLength(1)
  })

  it('does not flag the module\'s other exports (decision 2)', () => {
    expect(
      helperImportsIn(
        'App.jsx',
        "import { setDisplayTimezone, getDisplayTimezone, DEFAULT_DISPLAY_TIMEZONE } from './utils/dateFormat'\n"
      )
    ).toEqual([])
    expect(
      helperImportsIn(
        'components/Somewhere.jsx',
        "import { hasRenderableDate, zonedDayNumber } from '../utils/dateFormat'\n"
      )
    ).toEqual([])
  })

  it('does not flag a mention in a comment (decision 4)', () => {
    const source = [
      '/**',
      " * Historically this module called `import { formatDate } from '../utils/dateFormat'`",
      ' * directly; it now renders through `FormattedDate` instead.',
      ' */',
      "// import { formatDateTime } from '../utils/dateFormat'",
      "import FormattedDate from './FormattedDate'",
      ''
    ].join('\n')
    expect(asModule('components/Somewhere.jsx', source)).toEqual([])
  })

  it('does not flag a same-named module somewhere else, or a package (decision 5)', () => {
    expect(
      helperImportsIn('pages/Somewhere.jsx', "import { formatDate } from './dateFormat'\n")
    ).toEqual([])
    expect(
      helperImportsIn('pages/Somewhere.jsx', "import { formatDate } from 'date-fns'\n")
    ).toEqual([])
    expect(
      helperImportsIn('pages/Somewhere.jsx', "import { formatDate } from '../utils/expiryWarning'\n")
    ).toEqual([])
  })

  it('does not let a side-effect import swallow the next statement\'s specifiers', () => {
    // The regex hazard the clause character class exists for: a lazy match from
    // the first `import` to the second statement's `from` would report
    // `formatDate` as an import of `utils/dateFormat` from a file that imports
    // neither.
    const source = [
      "import './index.css'",
      "import { formatDate } from '../utils/expiryWarning'",
      ''
    ].join('\n')
    expect(asModule('pages/Somewhere.jsx', source)).toEqual([])
  })

  it('reports the line the offending import sits on', () => {
    const source = [
      "import { useState } from 'react'",
      '',
      "import { formatDate } from '../utils/dateFormat'",
      ''
    ].join('\n')
    expect(helperImportsIn('pages/Somewhere.jsx', source)[0].line).toBe(3)
  })
})
