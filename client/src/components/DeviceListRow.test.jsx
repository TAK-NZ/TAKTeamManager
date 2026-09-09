import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import DeviceListRow, {
  DeviceListCard,
  DeviceExpiryLine,
  CallsignMismatchMarker,
  CALLSIGN_MISMATCH_LABEL,
  CONNECTED_LABEL
} from './DeviceListRow.jsx'
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

// Callsign-mismatch detection (docs/ARCHITECTURE.md ("Callsign Mismatch Detection" section)): the amber
// marker shown beside a device connected under a wrong callsign. State carried
// by TEXT/an accessible name (the observed callsign + an sr-only label), never
// colour alone, mirroring the expiry markers' convention.
describe('CallsignMismatchMarker', () => {
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
      root.render(<CallsignMismatchMarker {...props} />)
    })
  }

  it('renders nothing when the device is not flagged', async () => {
    await mount({ callsignMismatch: false, observedCallsign: 'FENZ-WRONG' })
    expect(container.innerHTML).toBe('')
  })

  it('shows the observed callsign as visible text and an sr-only state label when flagged', async () => {
    await mount({ callsignMismatch: true, observedCallsign: 'FENZ-WRONG' })

    // Visible text carries the observed callsign.
    expect(container.textContent).toContain('FENZ-WRONG')
    // The state reaches assistive tech via an sr-only label, not colour alone.
    const srOnly = container.querySelector('span.sr-only')
    expect(srOnly.textContent).toBe(CALLSIGN_MISMATCH_LABEL)
    // Amber, distinct from the expiry markers' red.
    expect(container.querySelector('svg').getAttribute('class')).toContain('text-amber-600')
    expect(container.innerHTML).not.toContain('text-red-600')
  })

  it('discloses the same fact on hover and keyboard focus via a focusable host', async () => {
    await mount({ callsignMismatch: true, observedCallsign: 'FENZ-WRONG' })
    // The tooltip host is focusable (tabIndex 0), so keyboard users reach it.
    const host = container.querySelector('span[tabindex="0"]')
    expect(host).not.toBeNull()
    // The tooltip body repeats the label (plus the observed callsign).
    expect(host.textContent).toContain(CALLSIGN_MISMATCH_LABEL)
    expect(host.textContent).toContain('FENZ-WRONG')
  })
})

// Revoked-guard read-side (enrollment-vs-dashboard discrepancy): a revoked
// Device must NEVER render as "Currently Connected", even if a momentarily-stale
// connected=true reaches the client. This is defense in depth on top of the
// server clearing connected on revoke and the poller refusing to re-mark a
// revoked row connected.
describe('DeviceListRow / DeviceListCard revoked-device connection display', () => {
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

  const REVOKED_CONNECTED = {
    clientUid: 'ANDROID-abc',
    clientType: 'android',
    revoked: true,
    connected: true,
    issuedAt: null,
    expiresAt: null,
    lastSeenAt: null
  }

  const LIVE_CONNECTED = { ...REVOKED_CONNECTED, clientUid: 'ANDROID-live', revoked: false }

  it('does not show "Currently Connected" for a revoked-but-connected device (table row)', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <table>
          <tbody>
            <DeviceListRow device={REVOKED_CONNECTED} onRevoke={() => {}} />
          </tbody>
        </table>
      )
    })
    expect(container.textContent).toContain('Revoked')
    expect(container.textContent).not.toContain(CONNECTED_LABEL)
  })

  it('does not show "Currently Connected" for a revoked-but-connected device (mobile card)', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<DeviceListCard device={REVOKED_CONNECTED} onRevoke={() => {}} />)
    })
    expect(container.textContent).toContain('Revoked')
    expect(container.textContent).not.toContain(CONNECTED_LABEL)
  })

  it('still shows "Currently Connected" for a non-revoked connected device (control)', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<DeviceListCard device={LIVE_CONNECTED} onRevoke={() => {}} />)
    })
    expect(container.textContent).toContain(CONNECTED_LABEL)
  })
})
