import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import InfoTooltip from './InfoTooltip.jsx'

// This project has no `@testing-library/react`, so the component is
// mounted with `react-dom/client`'s `createRoot` plus React 18's own
// `act`, matching the pattern `FormattedDate.test.jsx`/
// `DeviceTypeIcon.test.jsx` already establish for this codebase's
// sideways-tooltip convention.
globalThis.React = React

describe('InfoTooltip (mounted)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    // In the document, or focus()/blur() will not fire focusin/focusout.
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
      root.render(<InfoTooltip text="Explains the field." {...props} />)
    })
  }

  it('renders an info icon with an accessible name, focusable via tabIndex', async () => {
    await mount()
    const icon = container.querySelector('[role="img"]')
    expect(icon).not.toBeNull()
    expect(icon.getAttribute('aria-label')).toBe('More information')
    expect(icon.getAttribute('tabindex')).toBe('0')
  })

  it('renders the explanation text unconditionally in the DOM (not only while disclosed)', async () => {
    await mount()
    expect(container.textContent).toContain('Explains the field.')
  })

  it('opens rightward by default: left-full/ml-2 anchor classes, never top-full/bottom-full', async () => {
    await mount()
    const tooltipBody = container.querySelector('[id]')
    expect(tooltipBody).not.toBeNull()
    expect(tooltipBody.className).toContain('left-full')
    expect(tooltipBody.className).toContain('ml-2')
    expect(tooltipBody.className).not.toContain('top-full')
    expect(tooltipBody.className).not.toContain('bottom-full')
  })

  it('opens leftward when side="left": right-full/mr-2 anchor classes', async () => {
    await mount({ side: 'left' })
    const tooltipBody = container.querySelector('[id]')
    expect(tooltipBody.className).toContain('right-full')
    expect(tooltipBody.className).toContain('mr-2')
    expect(tooltipBody.className).not.toContain('left-full')
  })

  it('keeps the tooltip body non-interactive (pointer-events-none)', async () => {
    await mount()
    const tooltipBody = container.querySelector('[id]')
    expect(tooltipBody.className).toContain('pointer-events-none')
  })

  it('associates aria-describedby with the tooltip id only while the icon is focused, and clears it on blur', async () => {
    await mount()
    const icon = container.querySelector('[role="img"]')
    const tooltipBody = container.querySelector('[id]')
    const tooltipId = tooltipBody.getAttribute('id')

    expect(icon.getAttribute('aria-describedby')).toBeNull()

    await act(async () => {
      icon.focus()
    })
    expect(icon.getAttribute('aria-describedby')).toBe(tooltipId)
    // The id it points at is always mounted -- never dangling.
    expect(document.getElementById(tooltipId)).not.toBeNull()

    await act(async () => {
      icon.blur()
    })
    expect(icon.getAttribute('aria-describedby')).toBeNull()
  })

  it('accepts a custom accessible label', async () => {
    await mount({ label: 'About Callsign Structure' })
    const icon = container.querySelector('[role="img"]')
    expect(icon.getAttribute('aria-label')).toBe('About Callsign Structure')
  })

  it('renders a JSX node passed as text, not only a plain string', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<InfoTooltip text={<>Plain part <strong>bold part</strong></>} />)
    })
    expect(container.textContent).toContain('Plain part bold part')
    expect(container.querySelector('strong')).not.toBeNull()
  })

  it('never uses a native title attribute as the disclosure mechanism', async () => {
    await mount()
    expect(container.querySelector('[title]')).toBeNull()
  })

  // Bugfix (mobile tap target too small): the disclosure host (the
  // element carrying tabIndex/role/aria-*) is now the OUTER span, sized
  // up via `-m-2 p-2` to a ~32px hit/focus box, not the bare h-4 w-4
  // (16px) icon itself. The icon inside is purely decorative
  // (aria-hidden) since the host already carries the accessible name.
  it('enlarges the hit/focus box via -m-2 p-2 on the disclosure host, rather than sizing the bare icon', async () => {
    await mount()
    const host = container.querySelector('[role="img"]')
    expect(host.className).toContain('-m-2')
    expect(host.className).toContain('p-2')

    const icon = host.querySelector('svg')
    expect(icon).not.toBeNull()
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(icon.getAttribute('class')).toContain('h-4 w-4')
  })
})
