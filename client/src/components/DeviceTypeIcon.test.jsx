import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import DeviceTypeIcon, {
  CLIENT_TYPES,
  DEVICE_TYPE_LABELS,
  resolveClientType,
  labelForClientType
} from './DeviceTypeIcon.jsx'

// Validates: Requirements 15.5, 15.6, 15.7, 16.3
//
// device-management task 22.6. The Device_Type_Icon is the ONE component both
// device lists use to turn a `clientType` into a glyph, an accessible name and
// a tooltip naming the platform (Requirement 15.6), so what matters here is
// that each of the five Client_Types renders a distinguishable glyph with its
// own label, that an unrecognised value falls back honestly rather than
// throwing (Requirement 15.5), and that the tooltip is reachable by keyboard
// as well as by mouse (Requirement 16.3).
//
// This project has no `@testing-library/react` (absent from
// `client/package.json` and from `client/node_modules`) and no dependency is
// added for this task, so the component is mounted with `react-dom/client`'s
// `createRoot` plus React 18's own `act` under the `jsdom` environment already
// configured in `vite.config.js` -- the approach established by
// `src/components/TransferMemberDialog.test.jsx`. Nothing is mocked: this
// component takes props and renders, with no network or context dependency.

// See the note in RevokeDeviceDialog.test.jsx: vitest compiles this JSX with
// esbuild's classic transform, so the component source (which has no `React`
// import of its own) needs one in scope.
globalThis.React = React

/** Every Client_Type with the platform label Requirement 15.6 requires. */
const TYPES_AND_LABELS = [
  [CLIENT_TYPES.CLOUDTAK, 'CloudTAK'],
  [CLIENT_TYPES.ANDROID, 'Android / ATAK'],
  [CLIENT_TYPES.IOS, 'iOS / iTAK'],
  [CLIENT_TYPES.WINDOWS, 'Windows / WinTAK'],
  [CLIENT_TYPES.UNKNOWN, 'Unknown client type']
]

describe('resolveClientType (Requirement 15.5)', () => {
  it.each(TYPES_AND_LABELS.map(([type]) => type))('passes the known Client_Type %s through', (type) => {
    expect(resolveClientType(type)).toBe(type)
  })

  it.each([
    ['an unrecognised string', 'blackberry'],
    ['a server-side value in the wrong case', 'ANDROID'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 3],
    ['an object', { clientType: 'android' }],
    ['an inherited key', 'toString']
  ])('resolves %s to unknown rather than throwing', (_label, value) => {
    expect(() => resolveClientType(value)).not.toThrow()
    expect(resolveClientType(value)).toBe(CLIENT_TYPES.UNKNOWN)
  })
})

describe('labelForClientType (Requirement 15.6)', () => {
  it.each(TYPES_AND_LABELS)('labels %s as "%s"', (type, label) => {
    expect(labelForClientType(type)).toBe(label)
  })

  it('always returns a non-empty label, including for a missing clientType', () => {
    // A device list must never render an unlabelled graphic, so `unknown`
    // carries its own wording rather than an empty string (Requirement 15.5).
    expect(labelForClientType(undefined)).toBe('Unknown client type')
    expect(DEVICE_TYPE_LABELS[CLIENT_TYPES.UNKNOWN]).not.toBe('')
  })
})

describe('DeviceTypeIcon (mounted)', () => {
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
      root.render(<DeviceTypeIcon {...props} />)
    })
    return container.querySelector('[role="img"]')
  }

  it.each(TYPES_AND_LABELS)(
    'renders %s as a labelled graphic announcing "%s" (Requirement 15.6)',
    async (clientType, label) => {
      const icon = await mount({ clientType })

      // `role="img"` + `aria-label`: a screen reader announces the platform
      // instead of skipping an unlabelled graphic.
      expect(icon).not.toBeNull()
      expect(icon.getAttribute('aria-label')).toBe(label)
      expect(icon.dataset.clientType).toBe(clientType)
      // The glyph is inline SVG committed in the component, with no new client
      // dependency (Requirement 15.7).
      expect(icon.querySelector('svg')).not.toBeNull()
      // The label is also the visible tooltip text, so the mouse user and the
      // screen-reader user are told the same thing in the same words.
      expect(icon.textContent).toContain(label)
    }
  )

  it('renders the Unknown glyph and label for a clientType the client does not know', async () => {
    const icon = await mount({ clientType: 'palmos' })

    expect(icon.getAttribute('aria-label')).toBe('Unknown client type')
    expect(icon.dataset.clientType).toBe(CLIENT_TYPES.UNKNOWN)
    expect(icon.querySelector('svg')).not.toBeNull()
  })

  it('renders the Unknown glyph when clientType is absent entirely', async () => {
    // An older cached response with no `clientType` still renders something
    // truthful rather than losing the row or throwing.
    const icon = await mount({})

    expect(icon.getAttribute('aria-label')).toBe('Unknown client type')
    expect(icon.querySelector('svg')).not.toBeNull()
  })

  it('draws a visually distinct glyph for each of the five Client_Types', async () => {
    // Requirement 15.6 is about telling an ATAK phone from a WinTAK laptop at
    // a glance, which fails if two Client_Types share a glyph. Compared by
    // rendered SVG markup, so two labels over one drawing would fail here.
    const drawings = new Set()

    for (const [clientType] of TYPES_AND_LABELS) {
      const icon = await mount({ clientType })
      drawings.add(icon.querySelector('svg').innerHTML)
      await act(async () => {
        root.unmount()
      })
      root = null
    }

    expect(drawings.size).toBe(TYPES_AND_LABELS.length)
  })

  it('is focusable and discloses its tooltip on focus as well as hover (Requirement 16.3)', async () => {
    const icon = await mount({ clientType: CLIENT_TYPES.ANDROID })

    // `tabIndex={0}`: a keyboard user can reach the icon at all, which is the
    // precondition for the focus-visible tooltip.
    expect(icon.getAttribute('tabindex')).toBe('0')
    icon.focus()
    expect(document.activeElement).toBe(icon)

    // jsdom applies no stylesheet, so the disclosure is asserted through the
    // Tailwind classes that implement it: the tooltip starts hidden and is
    // revealed by hover AND by focus-within, the `relative group` pattern
    // reused from Dashboard.jsx (Requirement 16.4).
    expect(icon.className).toContain('relative')
    expect(icon.className).toContain('group')

    const tooltip = Array.from(icon.querySelectorAll('span')).find((node) =>
      node.textContent.includes('Android / ATAK')
    )
    expect(tooltip.className).toContain('opacity-0')
    expect(tooltip.className).toContain('group-hover:opacity-100')
    expect(tooltip.className).toContain('group-focus-within:opacity-100')
  })

  it('anchors the tooltip so the first column cannot push it off the left of the table', async () => {
    // Type is the first column of the device tables, and those tables scroll
    // (`overflow-x-auto`, which clips both axes), so a tooltip centred on the
    // icon put half its width outside the table where scrolling could not
    // reach it. It now opens rightward from the icon's right edge instead.
    //
    // jsdom applies no stylesheet, so the CLIPPING itself is not observable
    // here -- only the anchoring that avoids it, which is what this asserts.
    const icon = await mount({ clientType: CLIENT_TYPES.ANDROID })
    const tooltip = Array.from(icon.querySelectorAll('span')).find((node) =>
      node.textContent.includes('Android / ATAK')
    )

    expect(tooltip.className).toContain('left-full')
    expect(tooltip.className).not.toContain('-translate-x-1/2')
    expect(tooltip.className).not.toContain('bottom-full')
  })

  it('announces the platform once, not twice, by hiding the SVG from assistive tech', async () => {
    const icon = await mount({ clientType: CLIENT_TYPES.WINDOWS })

    // `role="img"` on the wrapper already makes its subtree presentational,
    // and the glyph carries `aria-hidden` of its own, so the label is the
    // single announcement.
    expect(icon.querySelector('svg').getAttribute('aria-hidden')).toBe('true')
  })

  it('applies a caller-supplied className to the glyph so a denser table can shrink it', async () => {
    const icon = await mount({ clientType: CLIENT_TYPES.IOS, className: 'h-4 w-4' })

    expect(icon.querySelector('svg').getAttribute('class')).toContain('h-4 w-4')
  })
})
