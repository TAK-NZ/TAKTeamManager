import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import MultipleCertificateWarning, {
  buildMultipleCertificateWarningText,
} from './MultipleCertificateWarning.jsx'

// takserver-enrollment Requirements 13.1, 13.3, 13.4, 13.5, 13.7
//
// Sanity coverage for task 11.1. The property test (task 11.4, Property 12's
// render arm) and the fuller example-test pass (task 11.5) extend this file
// later; what is asserted here is the basic contract: the threshold is
// strict, the count renders as text, and nothing renders at or below one.
//
// This project has no `@testing-library/react`, so the component is mounted
// with `react-dom/client`'s `createRoot` plus React 18's own `act`.
globalThis.React = React

describe('buildMultipleCertificateWarningText (Criteria 13.1, 13.4, 13.5)', () => {
  it('returns null for a count of exactly one', () => {
    expect(buildMultipleCertificateWarningText(1)).toBeNull()
  })

  it('returns null for a count of zero', () => {
    expect(buildMultipleCertificateWarningText(0)).toBeNull()
  })

  it('returns text carrying the count as a number for a count greater than one', () => {
    expect(buildMultipleCertificateWarningText(2)).toContain('2')
    expect(buildMultipleCertificateWarningText(5)).toContain('5')
  })

  it.each([
    ['a negative number', -1],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['null', null],
    ['undefined', undefined],
    ['a non-integer', 2.5],
    ['a string', '2'],
    ['an object', {}],
  ])('returns null rather than throwing for %s', (_label, value) => {
    expect(() => buildMultipleCertificateWarningText(value)).not.toThrow()
    expect(buildMultipleCertificateWarningText(value)).toBeNull()
  })
})

describe('MultipleCertificateWarning (mounted)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
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
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mount = async (props) => {
    root = createRoot(container)
    await act(async () => {
      root.render(<MultipleCertificateWarning {...props} />)
    })
  }

  it('renders nothing at a count of one', async () => {
    await mount({ count: 1 })
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing at a count of zero', async () => {
    await mount({ count: 0 })
    expect(container.innerHTML).toBe('')
  })

  it('renders the count as text at a count greater than one (Criteria 13.1, 13.3, 13.4)', async () => {
    await mount({ count: 3 })
    expect(container.textContent).toContain('3')
  })

  it.each([2, 5])(
    'renders at a count of %i, with the count present as text in the accessibility tree (Criteria 13.1, 13.3, 13.4, 13.5)',
    async (count) => {
      await mount({ count })
      // `textContent` is exactly what an accessibility tree announces for
      // this element -- there is no aria-hidden wrapper around the count,
      // only around the decorative icon (Criterion 13.3).
      expect(container.textContent).toContain(String(count))
      expect(container.innerHTML).not.toBe('')
    }
  )

  it.each([0, 1])(
    'renders nothing at all at a count of %i (Criteria 13.1, 13.5)',
    async (count) => {
      await mount({ count })
      expect(container.innerHTML).toBe('')
    }
  )

  it('does not use role="alert" -- it is information, not an error (Criterion 13.7)', async () => {
    await mount({ count: 2 })
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('renders no button and no disabled attribute of its own, so it cannot gate any enrollment action (Criterion 13.7)', async () => {
    await mount({ count: 5 })
    // This component structurally has nothing to disable: no <button>, no
    // <fieldset>, and no `disabled` attribute anywhere in its own markup. A
    // caller rendering an enrollment action beside it (e.g. TeamDeviceList's
    // "Enroll" button, task 11.2) is therefore never at risk of a gate this
    // component introduced.
    expect(container.querySelector('button')).toBeNull()
    expect(container.innerHTML).not.toContain('disabled')
  })
})
