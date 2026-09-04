import reactHooks from 'eslint-plugin-react-hooks'

// Flat ESLint config (ESLint 10.x) scoped to the React client's `.jsx`
// sources.
//
// Deliberately narrow in scope: this exists specifically to close the gap
// documented in the repo's own tech steering ("the Vitest suite is the only
// gate on client code") for exactly the bug class that motivated it -- a
// hooks-order violation (a hook called after a conditional early `return`)
// that crashed TeamDetail.jsx on every page load and went undetected by the
// existing test suite, lint, and manual testing alike. `react-hooks/rules-of-
// hooks` is a static analysis that catches that pattern unconditionally, with
// no test needed (confirmed against the unfixed TeamDetail.jsx during this
// config's introduction: this exact rule flagged it).
//
// `eslint-plugin-react-hooks` 7.x's own `recommended`/`recommended-latest`
// presets bundle a much larger rule set aimed at the React Compiler
// (`purity`, `immutability`, `set-state-in-render`, `static-components`,
// etc.) -- these are far more opinionated static-purity checks that this
// pre-compiler codebase was not written against, so only the two rules that
// predate and are independent of the compiler effort are selected
// explicitly here, rather than adopting the preset wholesale. Widening to
// the full preset is a separate, deliberate decision for later, not a
// byproduct of adding hooks-order coverage now.
//
// `react-hooks/exhaustive-deps` is kept at 'warn' (its own default
// severity): a missing dependency is very often an intentional choice in
// this codebase (e.g. FormattedDate.jsx's documented "read the clock inside
// the disclosure handler, no interval/useEffect" pattern), and erroring on
// it would force a wave of unrelated `// eslint-disable` comments rather
// than catching real bugs. `rules-of-hooks` is kept at 'error': there is no
// legitimate reason to call a hook conditionally.
//
// Scoped to `**/*.jsx` only -- confirmed no `.js` file in `client/src`
// calls a hook (hooks are a JSX-component concern in this codebase; pure
// logic lives in `client/src/utils/*.js` with no React import, per this
// repo's structure convention).
//
// This is NOT a general-purpose JS/React style lint pass (no `no-unused-
// vars`, no import-order, no a11y plugin, etc.) -- broadening this config's
// scope is a separate, deliberate decision, not a byproduct of adding hooks
// coverage.
export default [
  {
    ignores: ['node_modules/**', 'dist/**'],
  },
  {
    files: ['**/*.jsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
]
