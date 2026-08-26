// Feature: takserver-enrollment, Property 12: Certificate counts are per-principal, non-revoked, and resolved in a fixed number of queries
//
// **Validates: Requirements 13.1, 13.4, 13.5**

/**
 * takserver-enrollment task 11.4: the RENDER ARM of design.md's Property 12.
 * Task 8.8 implements the QUERY arm
 * (`server/routes/__tests__/users.certificateCount.property.test.js`). Both
 * files carry the IDENTICAL tag above deliberately: Property 12's subject
 * spans two runners -- the server-side batched query that resolves a live
 * certificate count, and the client rendering that feeds -- so it is one
 * property expressed as two files, not two properties.
 *
 * ## What this arm is about
 *
 * Once a `live_certificate_count` reaches the client (however the query arm
 * resolved it), `MultipleCertificateWarning` is the sole thing that decides
 * whether to say anything about it and what to say. This arm never touches
 * `tak_devices` or any query: it holds the count fixed as an already-resolved
 * prop and asserts the RENDERING decision alone -- the component renders if
 * and only if the count is strictly greater than one (Criteria 13.1, 13.5),
 * and the count itself appears in the rendered text as a number (Criterion
 * 13.4), never merely implied by an icon or a colour.
 *
 * ## Independent re-derivation
 *
 * The expectation ("should render", "text contains this exact number") is
 * computed directly from the generated count by the test's own `>` and
 * string-interpolation logic below -- never by calling
 * `buildMultipleCertificateWarningText` or importing anything from the
 * subject module beyond the component and helper under test. A test that
 * asked the helper what it expected would only be asserting determinism.
 *
 * ## Boundary concentration
 *
 * The threshold this property exists to pin sits between exactly 1 and
 * exactly 2 -- `count > 1`, not `count >= 1` and not `count >= 2`. A uniform
 * generator over a wide range would only rarely land on either side of that
 * one-wide gap and could pass an off-by-one implementation (a `>=` written
 * for a `>`) most of the time. The generator below is heavily weighted onto
 * exactly 0, 1 and 2, with a small broad arm so the property is not
 * boundary-only.
 *
 * ## Anti-vacuity
 *
 * Counters below record whether the run actually generated at least one
 * count of exactly 1 (the "just under the threshold" case) and at least one
 * count of 2 or more (the "at or over the threshold" case). Without both,
 * this property could pass while never having exercised the boundary it
 * exists to test.
 *
 * ## Mounting
 *
 * There is no `@testing-library/react` in this project and none is added:
 * `react-dom/client`'s `createRoot` inside React 18's `act`, matching every
 * other mounted client test (see `FormattedDate.property.test.jsx`,
 * `MultipleCertificateWarning.test.jsx`). `globalThis.React = React` because
 * Vitest compiles this JSX with esbuild's classic transform and the
 * component source carries no `React` import of its own.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import MultipleCertificateWarning from './MultipleCertificateWarning.jsx'

globalThis.React = React

/**
 * Boundary-concentrated non-negative integer count: heavily weighted to
 * exactly 0, 1 and 2 -- the threshold sits between the last two -- with a
 * small broad arm so the property is not boundary-only.
 */
const countArbitrary = fc.oneof(
  { weight: 3, arbitrary: fc.constant(0) },
  { weight: 3, arbitrary: fc.constant(1) },
  { weight: 3, arbitrary: fc.constant(2) },
  { weight: 1, arbitrary: fc.integer({ min: 3, max: 200 }) }
)

// Anti-vacuity tracking, checked after every generated run has executed.
const seen = { exactlyOne: false, twoOrMore: false }

describe('Property 12 (render arm): Certificate counts are per-principal, non-revoked, and resolved in a fixed number of queries', () => {
  let container

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  it('renders if and only if the count is strictly greater than one, with the count present as text', async () => {
    await fc.assert(
      fc.asyncProperty(countArbitrary, async (count) => {
        if (count === 1) seen.exactlyOne = true
        if (count >= 2) seen.twoOrMore = true

        // Independently re-derived: never delegates to
        // buildMultipleCertificateWarningText or any subject-owned table.
        const shouldRender = count > 1

        const root = createRoot(container)
        try {
          await act(async () => {
            root.render(<MultipleCertificateWarning count={count} />)
          })

          if (shouldRender) {
            // The count is present in the rendered TEXT as a number, never
            // merely implied by an icon or colour (Criterion 13.4).
            expect(container.textContent).toContain(String(count))
            expect(container.innerHTML).not.toBe('')
          } else {
            // Exactly at or below the threshold: nothing renders at all,
            // not an empty element (Criterion 13.5).
            expect(container.innerHTML).toBe('')
          }
        } finally {
          await act(async () => {
            root.unmount()
          })
        }

        return true
      }),
      { numRuns: 200 }
    )

    expect(seen.exactlyOne).toBe(true)
    expect(seen.twoOrMore).toBe(true)
  })
})
