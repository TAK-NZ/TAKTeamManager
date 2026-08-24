import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import FormattedDate, {
  DATE_PRECISION,
  TOOLTIP_SEPARATOR,
  TOOLTIP_SIDES,
  buildTooltipText
} from './FormattedDate.jsx'
import {
  DEFAULT_DISPLAY_TIMEZONE,
  formatDate,
  formatDateTime,
  setDisplayTimezone
} from '../utils/dateFormat'

// Validates: Requirements 2.5, 2.8, 2.10, 2.11, 3.1, 3.2, 3.3, 3.4, 3.5,
// 3.7, 3.10, 3.11
//
// date-tooltips-and-folder-contrast task 5.2. `FormattedDate` is the ONE place
// the Date_Tooltip is implemented (Criterion 2.1), so this file drives the
// three things only a mounted component can demonstrate: that the disclosure
// opens on pointer AND on keyboard (Criterion 3.1) and closes again; that the
// `aria-describedby` association never points at an element that is not in the
// document (Criteria 3.2, 3.7); and that the Sideways_Tooltip_Placement classes
// are the ones actually rendered, on both sides, so the Tooltip_Clipping_Defect
// cannot come back quietly (Criteria 3.4, 3.5, 3.11).
//
// ## How this file drives React without a testing library
//
// There is no `@testing-library/react` in this project and none is added. The
// component is mounted with `react-dom/client`'s `createRoot` inside React
// 18's own `act`, under the `jsdom` environment configured in
// `vite.config.js` -- the pattern `TransferMemberDialog.test.jsx` established
// and `DeviceTypeIcon.test.jsx` documents. `globalThis.React = React` is
// required because vitest compiles this JSX with esbuild's classic transform
// and the component source has no `React` import of its own.
//
// Events are dispatched natively rather than through a helper library:
//
//  - `pointerover` / `pointerout` with `bubbles: true` and a null
//    `relatedTarget` are what React's enter/leave plugin turns into
//    `onPointerEnter` / `onPointerLeave`. `jsdom` 29.1.1 provides
//    `PointerEvent`, so no synthetic substitute is needed.
//  - `focus()` / `blur()` drive `onFocus` / `onBlur`, which React delegates
//    from `focusin` / `focusout` -- both of which `jsdom` fires from those
//    methods. The host needs to be in the document for that, which is why
//    the container is appended to `document.body`.
//
// ## Two pieces of module state this file installs and restores
//
//  1. The display timezone. `UTC` is installed so the tooltip's second fact
//     is a fixed string; `DEFAULT_DISPLAY_TIMEZONE` is restored afterwards,
//     exactly as `dateFormat.test.js` does, or a zone installed here would
//     decide the wall clock a later test asserts.
//  2. The clock. Only `Date` is faked (`toFake: ['Date']`), deliberately
//     leaving `setTimeout` and friends real so React's scheduler is
//     untouched; the clock is then moved with `vi.setSystemTime`. Real
//     timers are restored in `afterEach`.
//
// What is NOT asserted here, and why: `jsdom` applies no CSS, so nothing
// below observes a tooltip being painted, positioned or clipped. These are
// assertions about the DOM and the class names the component declares.

globalThis.React = React

/** 2024-03-05T12:00:00.000Z. Fixed so every phrase below is arithmetic. */
const FIXED_NOW_MS = Date.UTC(2024, 2, 5, 12, 0, 0)

const MS_PER_MINUTE = 60 * 1000
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR

/** Three minutes before `FIXED_NOW_MS`, as the ISO string an API would send. */
const THREE_MINUTES_AGO = new Date(FIXED_NOW_MS - 3 * MS_PER_MINUTE).toISOString()

/** Three days before it, for the date-only precision. */
const THREE_DAYS_AGO = new Date(FIXED_NOW_MS - 3 * MS_PER_DAY).toISOString()

describe('buildTooltipText (Criteria 2.8, 2.10, 2.11)', () => {
  it('renders the phrase first, then the zone, with the explicit separator', () => {
    // The phrase leads because it is what the hover was for; the zone
    // qualifies it. The separator is inside the string rather than in the
    // layout so a reader announcing the tooltip as one string does not run
    // the two facts together.
    expect(buildTooltipText('3 minutes ago', 'Pacific/Auckland')).toBe(
      `3 minutes ago${TOOLTIP_SEPARATOR}Pacific/Auckland`
    )
    expect(TOOLTIP_SEPARATOR).toBe(', ')
  })

  it('renders the phrase ALONE when the resolved zone is the empty string', () => {
    // `getDisplayTimezone()`'s documented outcome when not even `UTC`
    // constructs. A tooltip reading `3 minutes ago, ` would be a rendering
    // defect standing in for a missing one.
    expect(buildTooltipText('3 minutes ago', '')).toBe('3 minutes ago')
    expect(buildTooltipText('3 minutes ago', '   ')).toBe('3 minutes ago')
    expect(buildTooltipText('3 minutes ago', undefined)).toBe('3 minutes ago')
  })

  it('has nothing to say when there is no phrase', () => {
    expect(buildTooltipText('', 'UTC')).toBe('')
    expect(buildTooltipText(null, 'UTC')).toBe('')
  })
})

describe('FormattedDate (mounted)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    // Only `Date` is faked: React's scheduler keeps its real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FIXED_NOW_MS)
    setDisplayTimezone('UTC')
    container = document.createElement('div')
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
    setDisplayTimezone(DEFAULT_DISPLAY_TIMEZONE)
    vi.useRealTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mount = async (props) => {
    root = createRoot(container)
    await act(async () => {
      root.render(<FormattedDate {...props} />)
    })
    return hostOf()
  }

  /** The focusable date node -- the described element, not the wrapper. */
  const hostOf = () => container.querySelector('span[tabindex="0"]')

  /**
   * The element `aria-describedby` names, looked up by id through
   * `getElementById` because React 18's `useId` produces ids (`:r1:`) that
   * are not valid CSS selectors.
   */
  const describedElement = () => {
    const host = hostOf()
    const id = host && host.getAttribute('aria-describedby')
    return id ? document.getElementById(id) : null
  }

  const pointerOver = async (node) => {
    await act(async () => {
      node.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    })
  }

  const pointerOut = async (node) => {
    await act(async () => {
      node.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
    })
  }

  const focus = async (node) => {
    await act(async () => {
      node.focus()
    })
  }

  const blur = async (node) => {
    await act(async () => {
      node.blur()
    })
  }

  const pressKey = async (node, key) => {
    await act(async () => {
      node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  }

  describe('the resting DOM (Criteria 3.7, 3.3, 3.10)', () => {
    it('renders the date with NO tooltip and NO aria-describedby until disclosed', async () => {
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME
      })

      // The tooltip is mounted only while disclosed, so at rest there is no
      // element for `aria-describedby` to point at -- and the attribute is
      // absent with it.
      expect(host).not.toBeNull()
      expect(host.hasAttribute('aria-describedby')).toBe(false)
      expect(describedElement()).toBeNull()
      expect(container.textContent).toBe(formatDateTime(THREE_MINUTES_AGO))
      expect(container.textContent).not.toContain('ago')
    })

    it('puts no role on the date node and no title standing in for the description', async () => {
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME
      })

      // A focusable span with no role announces as text carrying a
      // description, which is what it is. `role="tooltip"` would add nothing
      // `aria-describedby` has not established, and any control role would
      // make a date cell announce as a button.
      expect(host.hasAttribute('role')).toBe(false)
      expect(host.getAttribute('tabindex')).toBe('0')
      expect(container.querySelector('[role]')).toBeNull()

      // `title` is not the mechanism: support for it is inconsistent and it
      // never appears on keyboard focus, which is the whole of Criterion 3.1.
      expect(container.querySelector('[title]')).toBeNull()

      await pointerOver(host)

      expect(describedElement()).not.toBeNull()
      expect(container.querySelector('[role]')).toBeNull()
      expect(container.querySelector('[title]')).toBeNull()
    })
  })

  describe('disclosure and dismissal (Criteria 3.1, 3.2, 3.7)', () => {
    it('discloses on pointerover and dismisses on pointerout', async () => {
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME
      })

      expect(describedElement()).toBeNull()

      await pointerOver(host)
      expect(describedElement()).not.toBeNull()

      await pointerOut(host)
      expect(hostOf().hasAttribute('aria-describedby')).toBe(false)
      expect(describedElement()).toBeNull()
    })

    it('discloses on keyboard focus and dismisses on blur', async () => {
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME
      })

      // Hover-only would leave a keyboard user without the context a mouse
      // user gets, which is what Criterion 3.1 forbids.
      expect(describedElement()).toBeNull()

      await focus(host)
      expect(document.activeElement).toBe(host)
      expect(describedElement()).not.toBeNull()

      await blur(host)
      expect(describedElement()).toBeNull()
    })

    it('keeps the tooltip disclosed when the pointer LEAVES a focused date', async () => {
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME
      })

      await focus(host)
      await pointerOver(host)
      expect(describedElement()).not.toBeNull()

      // `disclosed` is `hovered || focused`: the keyboard is still asking for
      // this tooltip, so a departing pointer must not take it away.
      await pointerOut(host)
      expect(describedElement()).not.toBeNull()

      await blur(host)
      expect(describedElement()).toBeNull()
    })

    it('dismisses on Escape', async () => {
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME
      })

      await focus(host)
      expect(describedElement()).not.toBeNull()

      // An addition beyond the requirements, flagged in the component: it
      // moves this disclosure closer to SC 1.4.13's dismissable clause than
      // the two tooltips it otherwise copies.
      await pressKey(host, 'Escape')
      expect(describedElement()).toBeNull()

      // An unrelated key does not re-open it and does not dismiss a fresh
      // disclosure either.
      await pointerOver(host)
      expect(describedElement()).not.toBeNull()
      await pressKey(host, 'Enter')
      expect(describedElement()).not.toBeNull()
    })

    it('names an element that is actually in the document while disclosed', async () => {
      const host = await mount({
        value: THREE_DAYS_AGO,
        precision: DATE_PRECISION.DATE
      })

      await pointerOver(host)

      const id = host.getAttribute('aria-describedby')
      expect(id).toBeTruthy()
      const tooltip = document.getElementById(id)
      expect(tooltip).not.toBeNull()
      expect(container.contains(tooltip)).toBe(true)
      // A SIBLING of the described node, not an ancestor and not a child:
      // the name is the date and the description is the context, once each.
      expect(tooltip.contains(host)).toBe(false)
      expect(host.contains(tooltip)).toBe(false)
    })
  })

  describe('the tooltip text (Criteria 2.8, 2.10, 2.11)', () => {
    it('carries the phrase, then the separator, then the resolved zone', async () => {
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME
      })

      await pointerOver(host)

      expect(describedElement().textContent).toBe(`3 minutes ago${TOOLTIP_SEPARATOR}UTC`)
    })

    it('anchors a date-only value at midnight in the display zone', async () => {
      const host = await mount({
        value: THREE_DAYS_AGO,
        precision: DATE_PRECISION.DATE
      })

      await pointerOver(host)

      // Both ends anchored, so the distance is a whole number of days.
      expect(describedElement().textContent).toBe(`3 days ago${TOOLTIP_SEPARATOR}UTC`)
    })

    it('puts no ISO instant in the tooltip', async () => {
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME
      })

      await pointerOver(host)
      const text = describedElement().textContent

      // A second, differently-zoned rendering of the same moment beside the
      // first is the confusion the Display_Timezone work exists to remove.
      expect(text).not.toContain(THREE_MINUTES_AGO)
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/)
      expect(text).not.toMatch(/\d{2}:\d{2}/)
      expect(text).not.toContain('Z')
    })
  })

  describe('Sideways_Tooltip_Placement (Criteria 3.4, 3.5, 3.11)', () => {
    it('opens rightward from left-full/ml-2 by default', async () => {
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME
      })

      await pointerOver(host)
      const tooltip = describedElement()

      expect(tooltip.className).toContain('left-full')
      expect(tooltip.className).toContain('ml-2')
      expect(tooltip.className).toContain('top-1/2')
      expect(tooltip.className).toContain('-translate-y-1/2')
      expect(tooltip.className).not.toContain('right-full')
      expect(tooltip.className).not.toContain('mr-2')
      // A tooltip accepting pointer events would swallow a click on the row
      // underneath and would flicker under pointerleave-driven state.
      expect(tooltip.className).toContain('pointer-events-none')
    })

    it('opens leftward from right-full/mr-2 for a trailing column', async () => {
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME,
        side: TOOLTIP_SIDES.LEFT
      })

      await pointerOver(host)
      const tooltip = describedElement()

      expect(tooltip.className).toContain('right-full')
      expect(tooltip.className).toContain('mr-2')
      expect(tooltip.className).toContain('top-1/2')
      expect(tooltip.className).toContain('-translate-y-1/2')
      expect(tooltip.className).not.toContain('left-full')
      expect(tooltip.className).not.toContain('ml-2')
      expect(tooltip.className).toContain('pointer-events-none')
    })

    it.each([
      ['right', TOOLTIP_SIDES.RIGHT],
      ['left', TOOLTIP_SIDES.LEFT]
    ])('never opens upward or downward on the %s side', async (_label, side) => {
      // The Tooltip_Clipping_Defect: both device tables carry
      // `overflow-x-auto`, and a box with one overflow axis `auto` and the
      // other `visible` clips on BOTH axes, so an upward-opening tooltip on
      // the first row was cut off by the wrapper's top edge. This asserts the
      // whole rendered subtree, caret included, so a vertical anchor cannot
      // reappear on either element.
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME,
        side
      })

      await pointerOver(host)

      expect(container.innerHTML).not.toContain('top-full')
      expect(container.innerHTML).not.toContain('bottom-full')
      expect(container.innerHTML).not.toContain('-translate-x-1/2')
    })

    it('points its caret back at the host from the tooltip near edge', async () => {
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME
      })

      await pointerOver(host)
      const caret = describedElement().querySelector('[aria-hidden="true"]')

      expect(caret).not.toBeNull()
      // A right-side tooltip's caret sits on the tooltip's LEFT edge, so the
      // anchors are mirrored relative to the body.
      expect(caret.className).toContain('right-full')
      expect(caret.className).toContain('border-r-gray-900')
    })
  })

  describe('Disclosure_Time_Computation (Criterion 2.5)', () => {
    it('recomputes the phrase on each disclosure rather than at render', async () => {
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME
      })

      await pointerOver(host)
      expect(describedElement().textContent).toBe(`3 minutes ago${TOOLTIP_SEPARATOR}UTC`)
      await pointerOut(host)

      // Two hours pass with no re-render and no timer. A phrase computed when
      // the row rendered -- or an always-mounted CSS-driven tooltip whose
      // content was fixed then -- would still say `3 minutes ago` here.
      vi.setSystemTime(FIXED_NOW_MS + 2 * MS_PER_HOUR)

      await pointerOver(host)
      expect(describedElement().textContent).toBe(`2 hours ago${TOOLTIP_SEPARATOR}UTC`)
    })

    it('recomputes on a keyboard disclosure too, not only a pointer one', async () => {
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME
      })

      await focus(host)
      expect(describedElement().textContent).toBe(`3 minutes ago${TOOLTIP_SEPARATOR}UTC`)
      await blur(host)

      vi.setSystemTime(FIXED_NOW_MS + 3 * MS_PER_DAY)

      await focus(host)
      expect(describedElement().textContent).toBe(`3 days ago${TOOLTIP_SEPARATOR}UTC`)
    })

    it('leaves an open tooltip alone as the clock moves under it', async () => {
      // The other half of Criterion 2.5, and the reason no timer is needed
      // (Criterion 2.6): a tooltip held open DOES go stale for as long as it
      // is open. That is accepted, and it is what "recompute on each
      // subsequent disclosure" buys instead of a ticking interval.
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME
      })

      await pointerOver(host)
      vi.setSystemTime(FIXED_NOW_MS + 2 * MS_PER_HOUR)

      expect(describedElement().textContent).toBe(`3 minutes ago${TOOLTIP_SEPARATOR}UTC`)
    })
  })

  describe('the precision discriminator', () => {
    it('renders the date-only string for DATE', async () => {
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE
      })

      expect(host.textContent).toBe(formatDate(THREE_MINUTES_AGO))
    })

    it.each([
      ['an unrecognised string', 'fortnight'],
      ['an absent value', undefined],
      ['null', null]
    ])('falls back to datetime for %s', async (_label, precision) => {
      // Deliberately the strictly MORE informative rendering: a caller who
      // meant date-only gets a stray ` HH:MM` on screen and finds out, where
      // the opposite default would silently drop a time nobody noticed was
      // gone.
      const host = await mount({ value: THREE_MINUTES_AGO, precision })

      expect(host.textContent).toBe(formatDateTime(THREE_MINUTES_AGO))
      expect(host.textContent).not.toBe(formatDate(THREE_MINUTES_AGO))
    })
  })

  describe('when the resolved zone is the empty string (Criterion 2.10)', () => {
    let realDateTimeFormat

    beforeEach(() => {
      // `getDisplayTimezone()` returns `''` only when not even `UTC`
      // constructs and the browser-local reading fails too -- the one state
      // in which the tooltip has a phrase and no zone. Forced here by making
      // every `Intl.DateTimeFormat` construction throw, then resetting the
      // module's memoised resolution so it walks the whole fallback chain
      // again.
      realDateTimeFormat = Intl.DateTimeFormat
      Intl.DateTimeFormat = function ThrowingDateTimeFormat() {
        throw new RangeError('no zone constructs')
      }
      setDisplayTimezone('UTC')
    })

    afterEach(() => {
      Intl.DateTimeFormat = realDateTimeFormat
      setDisplayTimezone(DEFAULT_DISPLAY_TIMEZONE)
    })

    it('renders the phrase ALONE, with no separator and no empty second fact', async () => {
      const host = await mount({
        value: THREE_MINUTES_AGO,
        precision: DATE_PRECISION.DATE_TIME
      })

      await pointerOver(host)
      const text = describedElement().textContent

      expect(text).toBe('3 minutes ago')
      expect(text).not.toContain(TOOLTIP_SEPARATOR)
      expect(text.endsWith(',')).toBe(false)
    })
  })
})
