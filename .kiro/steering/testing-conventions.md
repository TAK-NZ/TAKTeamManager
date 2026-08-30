---
inclusion: fileMatch
fileMatchPattern: '**/*.test.{js,jsx}'
---

# Testing conventions

## Runners

- `server/` → root `npm test` (Jest, `--forceExit`). Integration tests are excluded by `testPathIgnorePatterns` and run explicitly. Coverage floor 60% statements.
- `client/` → `cd client && npm test` (Vitest). Single file: `npx vitest run src/path/file.test.jsx`.

## Mounting React — there is NO @testing-library/react

Do not add one. Use `react-dom/client`'s `createRoot` inside React 18's `act`:

```jsx
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import Subject from './Subject.jsx'

// Required: Vitest compiles this JSX with esbuild's classic transform and the
// page sources carry no React import of their own.
globalThis.React = React

describe('Subject (mounted)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    // In the document, or `focus()` will not fire focusin/focusout.
    document.body.appendChild(container)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  it('discloses on pointer and on keyboard', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<Subject />)
    })
    const host = container.querySelector('span[tabindex="0"]')

    // Events are dispatched natively, not through a helper library.
    await act(async () => {
      host.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    })
    await act(async () => {
      host.focus()
    })
    await act(async () => {
      host.blur()
    })
    await act(async () => {
      host.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  })
})
```

## Property-based tests

- One property per file, named `<subject>.property.test.js[x]`. `fast-check` client-side, `@fast-check/jest` server-side.
- Header format, exactly:

```js
// Feature: <spec-name>, Property N: <property name from design.md>
//
// **Validates: Requirements 1.1, 1.2, ...**
```

- `numRuns` >= 100. In practice 200–1000.
- **Independent re-derivation.** Compute the expectation from generated inputs and constants transcribed from the ACCEPTANCE CRITERIA — never by calling the subject and never by importing its internal tables. A test that computes its expectation with the function under test asserts only determinism. `client/src/utils/relativeTime.js` deliberately does not export its ladder for this reason.
  - The one legitimate exception: when a criterion DEFINES correctness as agreement with a dependency, calling that dependency is the right model.
- **Boundary concentration.** `fc.oneof` over each boundary at −1/0/+1 in both directions, plus one broad uniform arm. Never uniform-only: a `<` written for `<=` passes cleanly under uniform sampling.
- **Anti-vacuity.** Assert the fixture was actually FOUND before asserting anything about it. A scan that silently matched nothing passes every assertion while measuring nothing.
- Totality generators include `null`, `undefined`, `NaN`, `Infinity`, symbols, bigints, objects with a hostile `valueOf`, and blank/unparseable strings.
- Failure messages carry the measured values, not just a boolean.

## Red-first, where the test IS the deliverable

Some tests exist to prove a defect. Write them against the UNFIXED code and confirm they fail, with the failure being the expected assertion rather than a mocking or mount error. A test that passes before the fix is not measuring the fix.

## Structural guards

Four exist — `client/src/utils/dateFormatConsumers.test.js`, `server/services/__tests__/martiEndpointContract.test.js`, `server/workers/operationSchemas.test.js`, `client/src/pages/channelTreeContrast.test.jsx`. When writing one: keep the extractor a PURE function of source text so the matching rule itself is testable, assert anti-vacuity before asserting the rule, and make the failure message name the offending file and the acceptable resolutions. Verify a new guard actually BITES by temporarily introducing a violation.

- `channelTreeContrast.test.jsx` is the one exception to "pure function of source text": it mounts the real page and locates a row in the RENDERED DOM, because contrast is a function of resolved classes and ancestor backgrounds, not source text. Its extractor still has to be a stable rule, though: locate a row by a durable visual anchor (an icon's class-token signature, or a `<path d="...">` shape read off the real dependency via `renderToStaticMarkup`, per `PlatformLogos.test.jsx`/`storeBadgeFidelity.test.jsx`'s direct-dependency-fidelity convention) — never by incidental markup shape like "chevron is inside a `<button>`". A genuine UX change (e.g. replacing a small dedicated toggle button with a click-anywhere row) can legitimately remove an anchor the extractor relied on; when that happens, update the extractor's locating rule to match the new structure, not the assertions it feeds — the same "tighten the query, don't loosen the assertion" rule below.

## Mock hygiene

- Prefer the real module over a partial mock. A partial `vi.mock` that omits an export throws at render the moment a component starts using it.
- A named import of a missing export from a mocked ES module is a LOAD-TIME failure — stub every export the module under test imports, even unused ones.
- Restore module-level state you install (e.g. `setDisplayTimezone`) in `afterEach`, or it leaks into every later suite.
- Prefer tightening a structural query over loosening a text assertion. If an exact-text assertion suddenly needs loosening, suspect the DOM gained an element it should not have.
