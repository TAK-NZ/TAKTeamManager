import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import FormattedDate, { DATE_PRECISION, TOOLTIP_SIDES } from './FormattedDate.jsx'
import {
  formatDate,
  formatDateTime,
  setDisplayTimezone,
  DEFAULT_DISPLAY_TIMEZONE
} from '../utils/dateFormat.js'

// Feature: date-tooltips-and-folder-contrast, Property 4: A Formatted_Date renders exactly the string the helper renders, and discloses nothing when there is nothing to say
//
// Validates: Requirements 2.3, 2.4, 2.7
//
// *For all* values, *for all* fallback strings — the five Criterion 2.4
// enumerates (`'-'`, `'Never'`, `'Unknown'`, `'never seen'` and `AuditLogs`'
// raw value) plus the empty string — and for BOTH precisions, the text
// `FormattedDate` renders OUTSIDE its tooltip equals the corresponding
// `formatDate`/`formatDateTime` return value character for character; and
// WHERE the value yields no phrase, the rendered output carries no disclosure
// host, no `tabIndex`, no `aria-describedby` and no tooltip element.
//
// ## The model is the Date_Format_Helpers, and that is not circular
//
// Every other property in this spec re-derives its expectation independently
// and is forbidden from calling back into the subject. This one calls the real
// `formatDate`/`formatDateTime` as its model, and it is the one place in this
// spec where that is the RIGHT model rather than a circular one: Criterion 2.3
// DEFINES this component's correctness as agreement with those helpers,
// character for character. A test that re-implemented `yyyy-mm-dd HH:MM` in
// the display timezone would be asserting a second opinion about formatting,
// which is not what the criterion says. The helpers' own correctness is
// established elsewhere (`dateFormat.test.js`,
// `dateFormat.property.test.js`); what is under test here is that wrapping
// them in a disclosure changed nothing about the string.
//
// The suppression half of the property IS re-derived independently. Whether a
// value has a phrase is decided below by `modelHasPhrase` from the by-type
// rules Criterion 1.8 states, never by calling `relativeTime` or
// `zonedDayNumber` — the component's own `hasPhrase`/`PHRASE_PROBE_NOW` split
// is exactly what would be rubber-stamped otherwise.
//
// ## Three outcomes, and outcome 2 has to be reached on purpose
//
// The component has three outcomes and the distinction between the second and
// third IS Criterion 2.7:
//
//   1. not renderable            → the caller's `fallback` as bare text
//   2. renderable, but no phrase → the formatted string as bare text
//   3. renderable with a phrase  → the disclosure
//
// Outcome 2 is easy to miss, because `hasRenderableDate` is strictly MORE
// PERMISSIVE than the classifier: `formatDate` accepts anything
// `new Date(value)` parses, which includes shapes the classifier rejects by
// type on purpose. `true`, `false` and `[2024]` all render a real string and
// have NO phrase. Those shapes are generated deliberately (see
// `renderableNonInstantArbitrary`) and a counter below FAILS the test if no
// run reached outcome 2, so this cannot silently degenerate into a sweep of
// outcomes 1 and 3 only.
//
// ## What is deliberately NOT generated
//
// Symbols, BigInts and objects with a hostile `valueOf`. `zonedDayNumber` and
// `hasRenderableDate` inherit the module-private `toDate`'s behaviour, which
// hands the value to `new Date(...)` — and that THROWS for those three shapes,
// exactly as `formatDate` does today. Criterion 2.13 puts changing the helpers
// out of scope, so those values are out of scope here too; the classifier's
// by-type rejection of them is Property 1's business.
//
// Instants are also kept inside 1900-2300 (plus the epoch and its
// neighbours). Far-future and BCE instants reach year components an
// era-bearing formatter renders non-numerically, where `zonedDayNumber`
// honestly answers `null` for a value the helpers still render — a real
// outcome-2 route, but one whose reachability depends on the engine's ICU data
// rather than on this component.
//
// ## Mounting
//
// There is no `@testing-library/react` in this project and none is added:
// `react-dom/client`'s `createRoot` inside React 18's `act`, the pattern
// `TransferMemberDialog.test.jsx` established and `DeviceTypeIcon.test.jsx`
// documents. `globalThis.React = React` because vitest compiles this JSX with
// esbuild's classic transform and the component source has no `React` import
// of its own.
globalThis.React = React

/**
 * A fixed zone for every run, so the helpers and the component are asked the
 * same question. Restored to the default afterwards — an installed zone is
 * module state, and leaking it would move every other suite's dates.
 */
const TEST_TIMEZONE = 'Pacific/Auckland'

/**
 * Stands for `AuditLogs`' fallback, which is the RAW value itself rather than
 * a literal (Criterion 2.4, last item). Resolved per run in
 * `resolveFallback`, since it depends on the generated value.
 */
const RAW_VALUE_FALLBACK = Symbol('the raw value AuditLogs passes as its own fallback')

/**
 * Criterion 2.4's five fallbacks plus the empty string the helpers default to
 * (Criterion 2.13).
 */
const FALLBACKS = [
  '-', // OrgInterestRequests.jsx
  'Never', // Users.jsx
  'Unknown', // DeviceListRow.jsx Issued and Expires
  'never seen', // DeviceListRow.jsx Last Seen, not-connected branch
  RAW_VALUE_FALLBACK, // AuditLogs.jsx
  '' // the helpers' own default
]

/**
 * `AuditLogs` passes `row.created_at` — a string off the wire — so the raw
 * fallback resolves to the value only when it IS a string. Anything else
 * resolves to the empty string rather than being handed to React as a child,
 * which is a rendering question this spec neither introduces nor repairs.
 *
 * @param {*} fallback one entry of `FALLBACKS`.
 * @param {*} value the generated value.
 * @returns {string}
 */
function resolveFallback(fallback, value) {
  if (fallback !== RAW_VALUE_FALLBACK) {
    return fallback
  }
  return typeof value === 'string' ? value : ''
}

/**
 * Whether the Date_Format_Helpers render this value rather than the caller's
 * fallback — the model for outcome 1, computed from `new Date` directly rather
 * than through `hasRenderableDate`.
 *
 * @param {*} value
 * @returns {boolean}
 */
function modelRenderable(value) {
  if (value == null) {
    return false
  }
  return !Number.isNaN(new Date(value).getTime())
}

/**
 * Whether the value is one of the three shapes Criterion 1.8 accepts as an
 * instant: a finite number, a `Date` whose time is not `NaN`, or a non-blank
 * string `new Date(...)` parses. Written out by TYPE here rather than obtained
 * from `relativeTime`, so the suppression assertion is a second opinion and
 * not an echo.
 *
 * @param {*} value
 * @returns {boolean}
 */
function modelIsInstant(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (value instanceof Date) {
    return !Number.isNaN(value.getTime())
  }
  if (typeof value === 'string') {
    return value.trim() !== '' && !Number.isNaN(new Date(value).getTime())
  }
  return false
}

/**
 * Whether the component discloses for this value at this precision — outcome
 * 3 — and therefore whether Criterion 2.7 suppresses the disclosure.
 *
 * Renderability is the FIRST gate and it is not implied by being an instant by
 * type: a finite number is an instant to the classifier but `8.64e15 + 1` is
 * outside the range `Date` represents, so the helpers render the fallback for
 * it and the value never reaches the classifier at all. Outcome 1 therefore
 * wins over outcome 3 whenever the two disagree.
 *
 * Past that gate, a date-only value is reduced to a calendar day before it
 * reaches the classifier, so any value with a calendar day has a phrase — the
 * distance between two day ordinals is always a usable number. A
 * date-and-time value goes to the classifier as-is, so it must be an instant
 * by type. That asymmetry is why `true` renders `1970-01-01` WITH a disclosure
 * at date precision and WITHOUT one at date-time precision.
 *
 * @param {*} value
 * @param {'date'|'datetime'} precision
 * @returns {boolean}
 */
function modelHasPhrase(value, precision) {
  if (!modelRenderable(value)) {
    return false
  }
  return precision === DATE_PRECISION.DATE || modelIsInstant(value)
}

/** Instants inside a range whose zoned year components are plain digits. */
const MIN_INSTANT_MS = Date.UTC(1900, 0, 1)
const MAX_INSTANT_MS = Date.UTC(2300, 0, 1)

/** Values the helpers render AND the classifier accepts — outcome 3. */
const instantArbitrary = fc.oneof(
  fc.integer({ min: MIN_INSTANT_MS, max: MAX_INSTANT_MS }),
  fc
    .integer({ min: MIN_INSTANT_MS, max: MAX_INSTANT_MS })
    .map((ms) => new Date(ms).toISOString()),
  fc.integer({ min: MIN_INSTANT_MS, max: MAX_INSTANT_MS }).map((ms) => new Date(ms)),
  fc.constantFrom(0, 1, -1, 86_400_000, Date.parse('2026-03-12T00:58:04.508Z'))
)

/**
 * Values the helpers RENDER but the classifier rejects by type — outcome 2,
 * the one the `hasRenderableDate`/classifier gap creates. `new Date(true)` is
 * one millisecond past the epoch and `new Date([2024])` is a real year, so
 * both produce a string with nothing to say about it.
 */
const renderableNonInstantArbitrary = fc.constantFrom(
  true,
  false,
  [2024],
  ['2024-03-01T05:06:07.000Z']
)

/** Values the helpers do not render at all — outcome 1, the fallback branch. */
const nonRenderableArbitrary = fc.oneof(
  fc.constantFrom(null, undefined, '', '   ', 'not-a-date', '2024-13-45', 'NaN'),
  fc.constantFrom(NaN, Infinity, -Infinity, 8.64e15 + 1),
  fc.constant(new Date('nope')),
  fc.constant({}),
  fc.constant([])
)

const valueArbitrary = fc.oneof(
  { arbitrary: instantArbitrary, weight: 4 },
  { arbitrary: renderableNonInstantArbitrary, weight: 3 },
  { arbitrary: nonRenderableArbitrary, weight: 3 }
)

const scenarioArbitrary = fc.record({
  value: valueArbitrary,
  fallback: fc.constantFrom(...FALLBACKS),
  precision: fc.constantFrom(DATE_PRECISION.DATE, DATE_PRECISION.DATE_TIME),
  side: fc.constantFrom(TOOLTIP_SIDES.RIGHT, TOOLTIP_SIDES.LEFT)
})

/**
 * The text the component renders OUTSIDE its tooltip. The tooltip is only in
 * the DOM while disclosed and nothing here discloses, so this is belt and
 * braces — a tooltip that regressed to the always-mounted, opacity-toggled
 * shape both existing tooltips use would be stripped here AND caught by the
 * explicit absence assertion below, rather than silently corrupting the
 * character-for-character comparison.
 *
 * @param {HTMLElement} container
 * @returns {string}
 */
function textOutsideTooltip(container) {
  const clone = container.cloneNode(true)
  for (const node of clone.querySelectorAll('.pointer-events-none, [class*="absolute"]')) {
    node.remove()
  }
  return clone.textContent
}

describe('Property 4: a Formatted_Date renders the helper\'s string and discloses nothing when there is nothing to say', () => {
  let container

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    setDisplayTimezone(TEST_TIMEZONE)
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    setDisplayTimezone(DEFAULT_DISPLAY_TIMEZONE)
  })

  it('renders exactly the Date_Format_Helpers string, and suppresses the whole disclosure for a value with no phrase', async () => {
    // Anti-vacuity. All THREE outcomes must actually be reached: a sweep that
    // only ever hit the fallback branch and the disclosure would pass every
    // assertion below while never exercising Criterion 2.7's second half --
    // the renderable value with nothing to say, which is the outcome the
    // `hasRenderableDate`/classifier gap creates and the easiest to lose.
    let fallbackOnly = 0
    let stringWithoutDisclosure = 0
    let disclosureHost = 0

    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async ({ value, fallback, precision, side }) => {
        const resolvedFallback = resolveFallback(fallback, value)

        // THE MODEL: the real helpers, because Criterion 2.3 defines this
        // component's correctness as agreement with them.
        const expected =
          precision === DATE_PRECISION.DATE
            ? formatDate(value, resolvedFallback)
            : formatDateTime(value, resolvedFallback)

        const root = createRoot(container)
        try {
          await act(async () => {
            root.render(
              <FormattedDate
                value={value}
                fallback={resolvedFallback}
                precision={precision}
                side={side}
              />
            )
          })

          // Criteria 2.3, 2.4: character for character, whether the string is
          // a formatted date or the caller's own fallback.
          expect(textOutsideTooltip(container)).toBe(expected)

          // At rest there is never a tooltip in the document, so an
          // `aria-describedby` can never dangle (Criterion 3.7).
          expect(container.querySelector('[aria-describedby]')).toBeNull()

          if (!modelHasPhrase(value, precision)) {
            // Criterion 2.7: NO disclosure host, NO tabIndex, NO
            // aria-describedby, NO tooltip -- rather than a tooltip carrying
            // an empty phrase or the zone alone. Outcomes 1 and 2 render bare
            // text with no wrapper at all, which is the strongest reading of
            // Criterion 2.3: the DOM is element for element what the position
            // rendered before this component existed.
            expect(container.querySelectorAll('*').length).toBe(0)
            expect(container.querySelector('[tabindex]')).toBeNull()

            if (modelRenderable(value)) {
              stringWithoutDisclosure += 1
            } else {
              fallbackOnly += 1
            }
          } else {
            // The other side of the same criterion: a value with something to
            // say DOES get a focusable host, so the suppression above is a
            // decision about the value rather than a component that never
            // discloses.
            const host = container.querySelector('[tabindex="0"]')
            expect(host).not.toBeNull()
            expect(host.textContent).toBe(expected)
            disclosureHost += 1
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

    expect(fallbackOnly).toBeGreaterThan(0)
    expect(stringWithoutDisclosure).toBeGreaterThan(0)
    expect(disclosureHost).toBeGreaterThan(0)
  })
})
