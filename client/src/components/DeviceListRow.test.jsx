import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { DeviceExpiryLine } from './DeviceListRow.jsx'
import { setExpiryWarningDays, DEFAULT_EXPIRY_WARNING_DAYS } from '../utils/expiryWarning.js'

// Bugfix (Devices.jsx / TeamDeviceList.jsx had no certificate-expiry
// highlighting at all -- admins managing devices via the org-wide
// /devices page or a single team's Devices tab had no way to see "this
// certificate expires soon" the way the Dashboard "My Devices" card and
// UserDevicesModal already do for a human's own device list).
//
// `DeviceExpiryLine` reuses the SAME classification
// (classifyExpiry/getExpiryWarningDays) `DeviceListRow`'s own Expires
// line already uses, so a device cannot be classified differently
// depending on which page happens to render it.
//
// This project has no `@testing-library/react`, so the component is
// mounted with `react-dom/client`'s `createRoot` plus React 18's own
// `act` -- the pattern this project's other component tests establish.
globalThis.React = React

describe('DeviceExpiryLine', () => {
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
    setExpiryWarningDays(DEFAULT_EXPIRY_WARNING_DAYS)
  })

  const mount = async (props) => {
    root = createRoot(container)
    await act(async () => {
      root.render(<DeviceExpiryLine {...props} />)
    })
  }

  it('renders nothing at all when expiresAt is absent, rather than an "Expires: Unknown" line', async () => {
    await mount({ expiresAt: null })
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing at all when expiresAt is undefined', async () => {
    await mount({})
    expect(container.innerHTML).toBe('')
  })

  it('renders a plain, non-bold Expires line for a certificate far from expiring', async () => {
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    await mount({ expiresAt: farFuture })

    expect(container.textContent).toContain('Expires')
    const line = container.firstChild
    expect(line.className).not.toContain('font-bold')
    expect(line.className).not.toContain('text-red-600')
    expect(container.querySelector('svg')).toBeNull()
  })

  it('renders bold red text and a warning glyph for an imminent expiry', async () => {
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
    await mount({ expiresAt: soon })

    const line = container.firstChild
    expect(line.className).toContain('font-bold')
    expect(line.className).toContain('text-red-600')

    const glyph = container.querySelector('svg')
    expect(glyph).not.toBeNull()
    expect(glyph.getAttribute('aria-hidden')).toBe('true')

    // The state is carried by real, accessible text -- not colour alone.
    const marker = container.querySelector('span.sr-only')
    expect(marker).not.toBeNull()
    expect(marker.textContent).toBe('Expires soon')
  })

  it('renders bold red text and the "Expired" marker for an already-lapsed certificate', async () => {
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    await mount({ expiresAt: past })

    const line = container.firstChild
    expect(line.className).toContain('font-bold')
    expect(line.className).toContain('text-red-600')

    const marker = container.querySelector('span.sr-only')
    expect(marker.textContent).toBe('Expired')
  })

  it('respects an installed Expiry_Warning_Days threshold, matching classifyExpiry exactly', async () => {
    setExpiryWarningDays(5)
    const in10Days = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString()

    await mount({ expiresAt: in10Days })

    // Outside the 5-day warning window, so no highlighting at all.
    const line = container.firstChild
    expect(line.className).not.toContain('text-red-600')
    expect(container.querySelector('svg')).toBeNull()
  })
})
