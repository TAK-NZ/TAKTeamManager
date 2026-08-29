import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import UserDevicesModal, {
  NEVER_SEEN_LABEL,
  interpretDeviceListError
} from './UserDevicesModal.jsx'
import { REVOKE_CONFIRMATION_WORD } from './RevokeDeviceDialog.jsx'
import {
  DEVICE_LIST_COLUMNS,
  CONNECTED_LABEL,
  EXPIRES_SOON_LABEL,
  EXPIRED_LABEL,
  revokeActionLabel
} from './DeviceListRow.jsx'
import { labelForClientType } from './DeviceTypeIcon.jsx'
import { deviceManagementAPI } from '../services/api'
import { formatDateTime } from '../utils/dateFormat'
import { DEFAULT_EXPIRY_WARNING_DAYS, setExpiryWarningDays } from '../utils/expiryWarning'

// Validates: Requirements 6.3, 6.4, 6.5, 8.2, 15.6, 16.2, 16.3, 16.5, 16.7,
// 19.8, 20.9, 20.11, 21.2, 21.3, 21.4, 21.5, 21.8
//
// This project has no `@testing-library/react` (absent from
// `client/package.json` and from `client/node_modules`) and no dependency is
// added for this task, so the modal is mounted with `react-dom/client`'s
// `createRoot` plus React 18's own `act` under the `jsdom` environment
// already configured in `vite.config.js` -- the approach established by
// `src/components/TransferMemberDialog.test.jsx`.
//
// Requirements 6.3 and 6.4 are about ONE component serving both admin
// surfaces. Mounting `Users.jsx` and `TeamDetail.jsx` (a 114 KB page with its
// own large API surface) would test their data loading, not the sharing, so
// the reuse claim is asserted the way `src/pages/TeamDetail.test.jsx` asserts
// its source-level facts: by reading both attach sites and checking each
// imports this single module rather than carrying its own copy of a device
// list.
//
// `../services/api` and `react-hot-toast` are the only mocks: the network
// boundary and the toast sink. The nested `RevokeDeviceDialog` is the real
// component.

vi.mock('../services/api', () => ({
  deviceManagementAPI: {
    getUserDevices: vi.fn(),
    revokeMyDevice: vi.fn(),
    revokeUserDevice: vi.fn(),
    probeEnabled: vi.fn()
  }
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}))

// See the note in TransferMemberDialog.test.jsx: vitest compiles this JSX
// with esbuild's classic transform, so the component sources (which have no
// `React` import of their own) need one in scope.
globalThis.React = React

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The `expires_at` for every fixture below whose test has nothing to do with
 * expiry -- RELATIVE to the clock, deliberately, and not to be "simplified"
 * back to a literal. The twin of this constant in `src/pages/Dashboard.test.jsx`.
 *
 * Requirement 21.1 puts the warning threshold at 30 days, so any hardcoded
 * date eventually falls INSIDE that window: the row then renders an "Expires
 * soon" marker in a cell that several of these tests assert as an exact date
 * string, and they start failing for a reason unrelated to what they test.
 * (The literal this replaced, 2027-01-02, would have begun failing around
 * 2026-12-03.) Two years out is comfortably clear of the threshold whenever
 * the suite runs.
 *
 * Evaluated ONCE, at module load, so every fixture derived from it and every
 * assertion derived from those fixtures sees the same instant for the whole
 * run. The tests that deliberately exercise the expiry states keep their own
 * intentional offsets -- see `IMMINENT_DEVICE` and friends below.
 */
const UNEXPIRING_EXPIRES_AT = new Date(Date.now() + 730 * DAY_MS).toISOString()

const SEEN_DEVICE = {
  clientUid: 'ANDROID-seen0001',
  clientType: 'android',
  issuedAt: '2025-01-02T03:04:05Z',
  expiresAt: UNEXPIRING_EXPIRES_AT,
  lastSeenAt: '2025-06-07T08:09:00Z',
  revoked: false
}

// Requirement 6.5: a device the poller has never observed connected. Every
// other field is present and real -- only `lastSeenAt` is null.
const NEVER_SEEN_DEVICE = {
  clientUid: 'ANDROID-never0002',
  clientType: 'android',
  issuedAt: '2025-03-04T05:06:07Z',
  expiresAt: UNEXPIRING_EXPIRES_AT,
  lastSeenAt: null,
  revoked: false
}

// Requirement 15.6: one device per Client_Type, each with a real Client_Uid
// from the live server, so the modal's Type column is asserted against the
// full value set rather than a single case. `clientType` arrives on the wire
// already derived server-side (Requirement 15.1) -- the client never
// classifies.
const TYPED_DEVICES = [
  { clientUid: 'ckadmin (ETL)', clientType: 'cloudtak' },
  { clientUid: 'ANDROID-63040a40563b5fab', clientType: 'android' },
  { clientUid: 'CE17C84D-9700-4080-BA5A-44AF51809453', clientType: 'ios' },
  { clientUid: 'S-1-5-21-2281966494-490247268-205662872-1002', clientType: 'windows' },
  { clientUid: 'some-random-client-name', clientType: 'unknown' }
].map((device) => ({
  ...device,
  issuedAt: '2025-01-02T03:04:05Z',
  expiresAt: UNEXPIRING_EXPIRES_AT,
  lastSeenAt: null,
  revoked: false
}))

/**
 * The Device_List_Refresh_Interval the DASHBOARD card ticks at (Requirement
 * 19.1). It appears here only so that Requirement 19.8 -- this modal gets NO
 * equivalent interval -- can be asserted by advancing well past several of
 * them.
 */
const REFRESH_INTERVAL_MS = 60000

/**
 * The text a screen reader would announce for an element: its `textContent`
 * with every `aria-hidden` subtree removed, whitespace collapsed. See the twin
 * of this helper in `src/pages/Dashboard.test.jsx` -- Requirements 20.9 and
 * 21.3 are both about a state being carried by TEXT rather than by colour, and
 * the decorative parts of these cells are `aria-hidden`.
 */
const accessibleTextOf = (element) => {
  const clone = element.cloneNode(true)
  clone.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove())
  return clone.textContent.replace(/\s+/g, ' ').trim()
}

/**
 * Column offsets in the shared row (`DEVICE_LIST_COLUMNS`). Issued and
 * Expires now share ONE "Certificate" cell (device-management-cert-table-
 * layout follow-up), stacked as two lines rather than two columns.
 */
const CERT_CELL = DEVICE_LIST_COLUMNS.indexOf('Certificate')
const LAST_SEEN_CELL = DEVICE_LIST_COLUMNS.indexOf('Last Seen')

const KNOWN_LAST_SEEN = '2025-06-07T08:09:00Z'

/**
 * Requirement 20.9: the four combinations of Connection_Status against whether
 * a Last_Seen timestamp is known, with the accessible text each must produce.
 * The same four run against the Dashboard card, because both surfaces render
 * this from the one shared row (Requirements 16.6, 20.9).
 */
const CONNECTED_COMBINATIONS = [
  {
    // Bugfix: a connected Device drops its Last_Seen timestamp entirely --
    // "Currently Connected" alone -- regardless of whether one is known.
    name: 'connected, Last_Seen known',
    device: { connected: true, lastSeenAt: KNOWN_LAST_SEEN },
    expected: CONNECTED_LABEL
  },
  {
    name: 'connected, Last_Seen unknown',
    device: { connected: true, lastSeenAt: null },
    expected: CONNECTED_LABEL
  },
  {
    name: 'not connected, Last_Seen known',
    device: { connected: false, lastSeenAt: KNOWN_LAST_SEEN },
    expected: formatDateTime(KNOWN_LAST_SEEN, '')
  },
  {
    name: 'not connected, Last_Seen unknown',
    device: { connected: false, lastSeenAt: null },
    expected: NEVER_SEEN_LABEL
  }
]

/**
 * Requirements 21.2-21.5: one device per expiry state, offset from `Date.now()`
 * at import time so each state is unambiguous at the installed 30-day
 * threshold without any test manipulating the clock.
 */
const EXPIRY_BASE = {
  clientType: 'android',
  issuedAt: '2025-01-02T03:04:05Z',
  lastSeenAt: null,
  revoked: false,
  connected: false
}
const IMMINENT_DEVICE = {
  ...EXPIRY_BASE,
  clientUid: 'ANDROID-imminent0003',
  expiresAt: new Date(Date.now() + 5 * DAY_MS).toISOString()
}
const EXPIRED_DEVICE = {
  ...EXPIRY_BASE,
  clientUid: 'ANDROID-expired0004',
  expiresAt: new Date(Date.now() - DAY_MS).toISOString()
}
const UNKNOWN_EXPIRY_DEVICE = {
  ...EXPIRY_BASE,
  clientUid: 'ANDROID-noexpiry0005',
  expiresAt: null
}
const FAR_FUTURE_DEVICE = {
  ...EXPIRY_BASE,
  clientUid: 'ANDROID-farfuture0006',
  expiresAt: new Date(Date.now() + 400 * DAY_MS).toISOString()
}

describe('interpretDeviceListError', () => {
  it('states the managed-user rule for a 403 (Reqs 6.6, 6.7)', () => {
    expect(interpretDeviceListError({ response: { status: 403 } })).toBe(
      'You can only view devices for users you directly manage.'
    )
  })

  it('prefers a server-supplied 403 message', () => {
    const error = { response: { status: 403, data: { error: 'Target is not managed by you' } } }
    expect(interpretDeviceListError(error)).toBe('Target is not managed by you')
  })

  it('reads a 404 as the feature being unavailable', () => {
    expect(interpretDeviceListError({ response: { status: 404 } })).toBe('Device management is not available.')
  })

  it('falls back to a generic message for a 5xx or a network failure', () => {
    const generic = 'Failed to load this user\'s devices. Please try again.'
    expect(interpretDeviceListError({ response: { status: 500 } })).toBe(generic)
    expect(interpretDeviceListError(new Error('Network Error'))).toBe(generic)
  })
})

describe('UserDevicesModal (mounted)', () => {
  let container
  let root
  let onClose

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    onClose = vi.fn()
    deviceManagementAPI.getUserDevices.mockResolvedValue({
      data: { devices: [SEEN_DEVICE, NEVER_SEEN_DEVICE] }
    })
    deviceManagementAPI.revokeUserDevice.mockResolvedValue({ data: { enqueued: true } })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mount = async (props = {}) => {
    root = createRoot(container)
    await act(async () => {
      root.render(<UserDevicesModal userId={42} userName="Ada Lovelace" onClose={onClose} {...props} />)
    })
  }

  const text = () => container.textContent
  const rowFor = (clientUid) =>
    Array.from(container.querySelectorAll('tbody tr')).find((tr) => tr.textContent.includes(clientUid))
  const cellsOf = (tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())

  it('fetches the target user\'s devices and lists each one (Reqs 6.3, 6.4)', async () => {
    await mount()

    expect(deviceManagementAPI.getUserDevices).toHaveBeenCalledWith(42)
    expect(text()).toContain('Ada Lovelace')
    expect(rowFor(SEEN_DEVICE.clientUid)).not.toBeUndefined()
    expect(rowFor(NEVER_SEEN_DEVICE.clientUid)).not.toBeUndefined()
  })

  // Requirement 6.5, the named assertion for this task.
  it('renders "never seen" for a null lastSeenAt while every other field still shows', async () => {
    await mount()

    const cells = cellsOf(rowFor(NEVER_SEEN_DEVICE.clientUid))
    // The first cell is the Device_Type_Icon added by task 22.4. The third is
    // the merged Certificate cell, whose `.textContent` runs both stacked
    // lines together -- checked with `toContain`, so this confirms both
    // dates are still present rather than picking either apart.
    const [, uid, certificate, lastSeen] = cells

    expect(uid).toBe(NEVER_SEEN_DEVICE.clientUid)
    expect(certificate).toContain(formatDateTime(NEVER_SEEN_DEVICE.issuedAt, 'Unknown'))
    expect(certificate).toContain(formatDateTime(NEVER_SEEN_DEVICE.expiresAt, 'Unknown'))
    expect(lastSeen).toBe(NEVER_SEEN_LABEL)
    expect(NEVER_SEEN_LABEL).toBe('never seen')

    // The label replaces the Last_Seen value only -- the Certificate cell
    // holds real dates, not the fallback.
    expect(certificate).not.toContain('Unknown')
  })

  it('renders a real timestamp for a device that has been seen (Req 6.5)', async () => {
    await mount()

    const [, , , lastSeen] = cellsOf(rowFor(SEEN_DEVICE.clientUid))
    expect(lastSeen).not.toBe(NEVER_SEEN_LABEL)
    expect(lastSeen).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: \S.*)?$/)
  })

  // ══════════════════════════════════════════════════════════════════════
  // date-tooltips-and-folder-contrast task 6.7 -- Criteria 2.3, 2.4, 2.7,
  // 3.1, 3.5, 3.7, 3.11. The twin of the block in
  // `src/pages/Dashboard.test.jsx`, because the row is ONE component and
  // both surfaces must acquire the disclosure identically (Req 16.6).
  //
  // The TEXT assertions this file already carries -- the `cellsOf` exact
  // strings above and the `accessibleTextOf(...).toBe(...)` comparisons
  // further down -- are reused as they stand rather than loosened. They are
  // the measured evidence behind design.md Decision 4: the tooltip is
  // mounted only WHILE disclosed, so the resting DOM is character for
  // character what it was before the adoption.
  // ══════════════════════════════════════════════════════════════════════
  describe('the three date cells disclose a Date_Tooltip (task 6.7)', () => {
    const cellsFor = (clientUid) => rowFor(clientUid).querySelectorAll('td')
    const hostIn = (cell) => cell.querySelector('span[tabindex="0"]')
    // The Certificate cell holds TWO date hosts now (Issued, then Expires).
    const hostsIn = (cell) => cell.querySelectorAll('span[tabindex="0"]')

    const tooltipFor = (host) => {
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

    it('leaves the whole modal free of tooltips at rest (Criterion 3.7)', async () => {
      await mount()

      expect(container.querySelector('[aria-describedby]')).toBeNull()

      // Two hosts in the Certificate cell (Issued, Expires) and one in Last
      // Seen. The leading Type column's Device_Type_Icon carries a
      // `tabIndex={0}` host of its own, which is not one of these.
      const cells = cellsFor(SEEN_DEVICE.clientUid)
      const certHosts = hostsIn(cells[CERT_CELL])
      expect(certHosts).toHaveLength(2)
      const lastSeenHosts = hostsIn(cells[LAST_SEEN_CELL])
      expect(lastSeenHosts).toHaveLength(1)
      for (const host of [...certHosts, ...lastSeenHosts]) {
        expect(host.className).toContain('cursor-help')
        expect(host.hasAttribute('aria-describedby')).toBe(false)
      }
    })

    it.each([
      ['Issued', () => hostsIn(cellsFor(SEEN_DEVICE.clientUid)[CERT_CELL])[0], 'left-full', 'ml-2'],
      ['Expires', () => hostsIn(cellsFor(SEEN_DEVICE.clientUid)[CERT_CELL])[1], 'left-full', 'ml-2'],
      ['Last Seen', () => hostIn(cellsFor(SEEN_DEVICE.clientUid)[LAST_SEEN_CELL]), 'right-full', 'mr-2']
    ])('opens the %s tooltip from %s', async (_name, hostOf, anchor, gap) => {
      await mount()

      const host = hostOf()
      expect(host).not.toBeNull()

      await pointerOver(host)
      const tooltip = tooltipFor(host)

      expect(tooltip).not.toBeNull()
      expect(tooltip.className).toContain(anchor)
      expect(tooltip.className).toContain(gap)
      expect(tooltip.className).toContain('top-1/2')
      expect(tooltip.className).toContain('-translate-y-1/2')
      // This table sits in the same `overflow-x-auto` wrapper that produced
      // the Tooltip_Clipping_Defect (Criterion 3.4).
      expect(container.innerHTML).not.toContain('top-full')
      expect(container.innerHTML).not.toContain('bottom-full')
    })

    it('restores the resting cell text exactly on dismissal (Criterion 2.3, Decision 4)', async () => {
      await mount()

      const cell = cellsFor(SEEN_DEVICE.clientUid)[LAST_SEEN_CELL]
      const expected = formatDateTime(SEEN_DEVICE.lastSeenAt, '')
      expect(accessibleTextOf(cell)).toBe(expected)

      const host = hostIn(cell)
      await pointerOver(host)
      // While disclosed the tooltip IS announced -- it is not `aria-hidden`,
      // because Criterion 3.2 requires it reachable -- which is exactly why
      // it may not be in the resting DOM.
      expect(accessibleTextOf(cell)).not.toBe(expected)
      expect(accessibleTextOf(cell)).toContain(expected)

      await pointerOut(host)
      expect(tooltipFor(hostIn(cell))).toBeNull()
      expect(accessibleTextOf(cell)).toBe(expected)
    })

    it('gives the "never seen" fallback no host and no tab stop (Criteria 2.4, 2.7)', async () => {
      await mount()

      const cells = cellsFor(NEVER_SEEN_DEVICE.clientUid)
      expect(accessibleTextOf(cells[LAST_SEEN_CELL])).toBe(NEVER_SEEN_LABEL)
      expect(hostIn(cells[LAST_SEEN_CELL])).toBeNull()

      // The Certificate cell beside it DOES have hosts -- so the absence is
      // the value's, not the row's.
      expect(hostsIn(cells[CERT_CELL])).toHaveLength(2)
    })
  })

  it('shows an empty-state instead of a table when the user has no devices', async () => {
    deviceManagementAPI.getUserDevices.mockResolvedValue({ data: { devices: [] } })
    await mount()

    expect(container.querySelector('tbody')).toBeNull()
    expect(text()).toContain('No devices are enrolled under this user')
  })

  it('shows a fetch failure inline rather than an empty device list (Reqs 6.6, 6.7)', async () => {
    deviceManagementAPI.getUserDevices.mockRejectedValue({ response: { status: 403 } })
    await mount()

    expect(container.querySelector('[role="alert"]').textContent).toBe(
      'You can only view devices for users you directly manage.'
    )
    expect(container.querySelector('tbody')).toBeNull()
  })

  // Requirements 8.2, 8.3: the modal reuses the shared REVOKE dialog and
  // passes `userId` through, which is what selects the admin endpoint.
  it('opens the shared REVOKE confirmation dialog, gated on the exact word (Req 8.2)', async () => {
    await mount()

    const revokeButton = rowFor(NEVER_SEEN_DEVICE.clientUid).querySelector('button')
    await act(async () => {
      revokeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const confirmInput = container.querySelector('#revoke-confirmation')
    expect(confirmInput).not.toBeNull()

    const confirmButton = container.querySelector('button[type="submit"]')
    expect(confirmButton.disabled).toBe(true)

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setter.call(confirmInput, REVOKE_CONFIRMATION_WORD)
      confirmInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('button[type="submit"]').disabled).toBe(false)

    await act(async () => {
      container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(deviceManagementAPI.revokeUserDevice).toHaveBeenCalledWith(
      42,
      NEVER_SEEN_DEVICE.clientUid,
      REVOKE_CONFIRMATION_WORD
    )
    expect(deviceManagementAPI.revokeMyDevice).not.toHaveBeenCalled()
    // The list is refreshed after the revocation is queued.
    expect(deviceManagementAPI.getUserDevices).toHaveBeenCalledTimes(2)
  })

  it('disables the Revoke action for an already-revoked device', async () => {
    deviceManagementAPI.getUserDevices.mockResolvedValue({
      data: { devices: [{ ...SEEN_DEVICE, revoked: true }] }
    })
    await mount()

    expect(rowFor(SEEN_DEVICE.clientUid).querySelector('button').disabled).toBe(true)
    expect(text()).toContain('Revoked')
  })

  // ════════════════════════════════════════════════════════════════════════
  // device-management task 22.6 / Requirements 15.6, 16.2, 16.3, 16.5, 16.7:
  // the icon-only Revoke control and the Device_Type_Icon, in the modal. The
  // same assertions run against the Dashboard card in
  // `src/pages/Dashboard.test.jsx`, because Requirement 16.6 requires the two
  // surfaces to behave identically.
  // ════════════════════════════════════════════════════════════════════════
  describe('icon-only Revoke control (Reqs 16.2, 16.3, 16.5, 16.7)', () => {
    const revokeButtonFor = (clientUid) => rowFor(clientUid).querySelector('button')

    it('gives the icon-only control an accessible name that names the device (Req 16.2)', async () => {
      await mount()

      const button = revokeButtonFor(SEEN_DEVICE.clientUid)
      // Icon-only, so the name comes from `aria-label` -- and it carries the
      // UID, so a screen-reader user reading a list of buttons can tell one
      // row's Revoke from another's.
      expect(button.textContent.trim()).toBe('')
      expect(button.getAttribute('aria-label')).toBe(`Revoke device ${SEEN_DEVICE.clientUid}`)
      expect(button.getAttribute('aria-label')).toBe(revokeActionLabel(SEEN_DEVICE.clientUid))

      // Two rows, two distinct names.
      expect(revokeButtonFor(NEVER_SEEN_DEVICE.clientUid).getAttribute('aria-label')).toBe(
        `Revoke device ${NEVER_SEEN_DEVICE.clientUid}`
      )
    })

    it('discloses the enabled control\'s tooltip on focus as well as on hover (Req 16.3)', async () => {
      await mount()

      const button = revokeButtonFor(SEEN_DEVICE.clientUid)
      // A keyboard user has to be able to reach the control before a
      // focus-visible tooltip means anything.
      button.focus()
      expect(document.activeElement).toBe(button)

      // jsdom applies no stylesheet, so the disclosure is asserted through the
      // Tailwind classes that implement it: the `relative group` pattern
      // reused from Dashboard.jsx (Req 16.4), revealed by hover AND by
      // focus-within (Req 16.3).
      const wrapper = button.parentElement
      expect(wrapper.className).toContain('relative')
      expect(wrapper.className).toContain('group')

      const tooltip = wrapper.querySelector('span[aria-hidden="true"]')
      expect(tooltip.textContent.trim()).toBe('Revoke device')
      expect(tooltip.className).toContain('opacity-0')
      expect(tooltip.className).toContain('group-hover:opacity-100')
      expect(tooltip.className).toContain('group-focus-within:opacity-100')
    })

    it('announces a revoked device\'s control as unavailable, in text and not by color (Reqs 16.5, 16.7)', async () => {
      deviceManagementAPI.getUserDevices.mockResolvedValue({
        data: { devices: [{ ...SEEN_DEVICE, revoked: true }] }
      })
      await mount()

      const row = rowFor(SEEN_DEVICE.clientUid)
      const button = row.querySelector('button')

      // `disabled` is what assistive tech announces, and it is not focusable,
      // which is exactly why the state is ALSO carried by the "Revoked" text
      // badge beside the UID rather than by the dimmed color alone.
      expect(button.disabled).toBe(true)
      button.focus()
      expect(document.activeElement).not.toBe(button)
      expect(row.textContent).toContain('Revoked')

      // The name still identifies the device, so the announcement is
      // "Revoke device X, unavailable" rather than "button, unavailable".
      expect(button.getAttribute('aria-label')).toBe(revokeActionLabel(SEEN_DEVICE.clientUid))
    })

    it('keeps the revoked control rendered rather than removing it', async () => {
      deviceManagementAPI.getUserDevices.mockResolvedValue({
        data: { devices: [{ ...SEEN_DEVICE, revoked: true }] }
      })
      await mount()

      // Dropping the control would change the row's shape between states and
      // leave a keyboard user wondering where the action went.
      expect(rowFor(SEEN_DEVICE.clientUid).querySelector('button')).not.toBeNull()
    })
  })

  describe('Device_Type_Icon in the modal (Reqs 15.6, 16.6)', () => {
    it('renders a labelled type icon in the leading cell of every row', async () => {
      deviceManagementAPI.getUserDevices.mockResolvedValue({ data: { devices: TYPED_DEVICES } })
      await mount()

      for (const device of TYPED_DEVICES) {
        const typeCell = rowFor(device.clientUid).querySelector('td')
        const icon = typeCell.querySelector('[role="img"]')

        expect(icon).not.toBeNull()
        expect(icon.getAttribute('aria-label')).toBe(labelForClientType(device.clientType))
        expect(icon.dataset.clientType).toBe(device.clientType)
        expect(icon.querySelector('svg')).not.toBeNull()
      }
    })

    it('leads the table with the Type column, in the shared column order', async () => {
      await mount()

      const headers = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent.trim())
      expect(headers).toEqual([...DEVICE_LIST_COLUMNS])
    })

    it('renders the Unknown label for a device whose clientType the client does not know', async () => {
      deviceManagementAPI.getUserDevices.mockResolvedValue({
        data: { devices: [{ ...SEEN_DEVICE, clientType: 'blackberry' }] }
      })
      await mount()

      const icon = rowFor(SEEN_DEVICE.clientUid).querySelector('[role="img"]')
      expect(icon.getAttribute('aria-label')).toBe('Unknown client type')
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  // device-management tasks 28.6 / 29.4, Requirements 20.9, 20.11, 21.2-21.5:
  // the Connected_Label and the two expiry markers, in the MODAL. The same
  // assertions run against the Dashboard card in `src/pages/Dashboard.test.jsx`,
  // which also compares the two surfaces' rows directly against each other
  // (Requirements 16.6, 21.8) -- both surfaces render this from one component,
  // and these blocks are what would catch that ceasing to be true.
  // ════════════════════════════════════════════════════════════════════════
  describe('Connected_Label and expiry markers in the modal (Reqs 20.9, 20.11, 21.2-21.5)', () => {
    beforeEach(() => {
      // Nothing installs a threshold on this surface, which Requirement 21.7
      // says means 30. Installed explicitly so the fixtures above are placed
      // against a stated threshold rather than whatever ran before.
      setExpiryWarningDays(DEFAULT_EXPIRY_WARNING_DAYS)
    })

    const mountWith = async (devices) => {
      deviceManagementAPI.getUserDevices.mockResolvedValue({ data: { devices } })
      await mount()
    }
    const cellsFor = (clientUid) => rowFor(clientUid).querySelectorAll('td')
    // The Expires line is the Certificate cell's second child div.
    const expiresLineFor = (clientUid) => cellsFor(clientUid)[CERT_CELL].children[1]

    it('renders the four connected x last-seen-known combinations (Req 20.9)', async () => {
      const devices = CONNECTED_COMBINATIONS.map((combination, index) => ({
        clientUid: `ANDROID-combo000${index}`,
        clientType: 'android',
        issuedAt: '2025-01-02T03:04:05Z',
        expiresAt: UNEXPIRING_EXPIRES_AT,
        revoked: false,
        ...combination.device
      }))
      await mountWith(devices)

      CONNECTED_COMBINATIONS.forEach((combination, index) => {
        const cell = cellsFor(devices[index].clientUid)[LAST_SEEN_CELL]
        // The label -- and the timestamp beside it where one is known -- is in
        // the ACCESSIBLE text, so the state is not carried by the green dot.
        expect(accessibleTextOf(cell)).toBe(combination.expected)
      })
    })

    it('carries the connected state in text, with the colour as decoration only (Req 20.9)', async () => {
      const device = { ...SEEN_DEVICE, clientUid: 'ANDROID-connected0009', connected: true }
      await mountWith([device])

      const cell = cellsFor(device.clientUid)[LAST_SEEN_CELL]
      const label = Array.from(cell.querySelectorAll('span')).find((span) =>
        span.textContent.includes(CONNECTED_LABEL)
      )

      expect(label).not.toBeUndefined()
      expect(label.getAttribute('aria-hidden')).toBeNull()
      expect(label.className).toContain('text-green-700')

      const dot = cell.querySelector('[aria-hidden="true"]')
      expect(dot).not.toBeNull()
      expect(dot.textContent).toBe('')
      expect(accessibleTextOf(cell)).toContain(CONNECTED_LABEL)
    })

    // Requirement 20.11: a row re-inserted by the Device_Sync after its
    // Stale_Device_Row deletion takes the `connected` column DEFAULT until the
    // poller re-derives it, so the wire shape may carry `false` -- or no
    // `connected` key at all. Both render as not connected.
    it('renders a re-inserted row at the connected default (Req 20.11)', async () => {
      const reinserted = { ...SEEN_DEVICE, clientUid: 'ANDROID-reinserted0010', connected: false }
      const missingField = { ...SEEN_DEVICE, clientUid: 'ANDROID-nofield0011' }
      delete missingField.connected
      await mountWith([reinserted, missingField])

      const expected = formatDateTime(SEEN_DEVICE.lastSeenAt, '')
      for (const device of [reinserted, missingField]) {
        const cell = cellsFor(device.clientUid)[LAST_SEEN_CELL]
        expect(accessibleTextOf(cell)).toBe(expected)
        expect(accessibleTextOf(cell)).not.toContain(CONNECTED_LABEL)
      }
    })

    it('renders an Imminent_Expiry bold, red, and marked "Expires soon" (Reqs 21.2, 21.3)', async () => {
      await mountWith([IMMINENT_DEVICE])

      const expiresLine = expiresLineFor(IMMINENT_DEVICE.clientUid)
      expect(expiresLine.className).toContain('font-bold')
      expect(expiresLine.className).toContain('text-red-600')

      // The marker is a warning glyph (`aria-hidden`) paired with a real,
      // visually-hidden `sr-only` span carrying the state as text -- see the
      // note on the twin assertion in `src/pages/Dashboard.test.jsx`.
      const marker = expiresLine.querySelector('span.sr-only')
      expect(marker.textContent).toBe(EXPIRES_SOON_LABEL)
      const glyph = expiresLine.querySelector('svg')
      expect(glyph).not.toBeNull()
      expect(glyph.getAttribute('aria-hidden')).toBe('true')

      // The marker qualifies the date, it does not replace it.
      const cell = cellsFor(IMMINENT_DEVICE.clientUid)[CERT_CELL]
      const text = accessibleTextOf(cell)
      expect(text).toContain(formatDateTime(IMMINENT_DEVICE.expiresAt, 'Unknown'))
      expect(text).toContain(EXPIRES_SOON_LABEL)
      expect(text).not.toContain('Unknown')
    })

    it('renders an already-expired certificate with the "Expired" marker instead (Req 21.5)', async () => {
      await mountWith([EXPIRED_DEVICE])

      const expiresLine = expiresLineFor(EXPIRED_DEVICE.clientUid)
      expect(expiresLine.className).toContain('font-bold')
      expect(expiresLine.className).toContain('text-red-600')

      const cell = cellsFor(EXPIRED_DEVICE.clientUid)[CERT_CELL]
      const text = accessibleTextOf(cell)
      expect(text).toContain(formatDateTime(EXPIRED_DEVICE.expiresAt, 'Unknown'))
      expect(text).toContain(EXPIRED_LABEL)
      expect(text).not.toContain(EXPIRES_SOON_LABEL)
      expect(expiresLine.querySelector('span.sr-only').textContent).toBe(EXPIRED_LABEL)
    })

    it('leaves a null expiresAt and a far-future expiry unhighlighted and unmarked (Req 21.4)', async () => {
      await mountWith([UNKNOWN_EXPIRY_DEVICE, FAR_FUTURE_DEVICE])

      const nullLine = expiresLineFor(UNKNOWN_EXPIRY_DEVICE.clientUid)
      expect(accessibleTextOf(nullLine)).toBe('Expires Unknown')
      // No MARKER span -- named by its classes, for the reason noted above.
      expect(nullLine.querySelector('span.sr-only')).toBeNull()
      expect(nullLine.className).not.toContain('font-bold')
      expect(nullLine.className).not.toContain('text-red-600')

      const farLine = expiresLineFor(FAR_FUTURE_DEVICE.clientUid)
      expect(accessibleTextOf(farLine)).toBe(`Expires ${formatDateTime(FAR_FUTURE_DEVICE.expiresAt, 'Unknown')}`)
      expect(farLine.querySelector('span.sr-only')).toBeNull()
      expect(farLine.className).not.toContain('font-bold')
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  // device-management task 27.2 / Requirement 19.8: this modal is deliberately
  // NOT auto-refreshed. It fetches on open and after a revoke, and a
  // background re-render underneath a stacked confirmation dialog is
  // disruption rather than freshness -- so the assertion is an ABSENCE, which
  // only fake timers can establish.
  // ════════════════════════════════════════════════════════════════════════
  describe('is not auto-refreshed (Req 19.8)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('fetches exactly once across several refresh intervals', async () => {
      await mount()
      expect(deviceManagementAPI.getUserDevices).toHaveBeenCalledTimes(1)

      // Well past several Dashboard refresh intervals.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 5)
      })
      expect(deviceManagementAPI.getUserDevices).toHaveBeenCalledTimes(1)

      // There is no interval to pause, so no `visibilitychange` handling
      // either: a tab hidden and shown again does not re-fetch under the open
      // dialog.
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 5)
      })
      expect(deviceManagementAPI.getUserDevices).toHaveBeenCalledTimes(1)

      // The rows are still there -- "no refresh" is not "no list".
      expect(rowFor(SEEN_DEVICE.clientUid)).not.toBeUndefined()
    })
  })
})

// Requirements 6.3, 6.4: ONE component, two surfaces. Asserted against the
// sources of both attach sites, the same way src/pages/TeamDetail.test.jsx
// asserts its source-level facts.
describe('UserDevicesModal is the single component reused by both admin views (Reqs 6.3, 6.4)', () => {
  const pagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'pages')
  const readPage = (name) => readFileSync(join(pagesDir, name), 'utf8')

  const ATTACH_SITES = ['Users.jsx', 'TeamDetail.jsx']

  it.each(ATTACH_SITES)('%s imports the shared modal from components/UserDevicesModal', (page) => {
    const source = readPage(page)
    expect(source).toMatch(/import\s+UserDevicesModal[^\n]*from\s+'\.\.\/components\/UserDevicesModal'/)
    expect(source).toContain('useDeviceManagementEnabled')
  })

  it.each(ATTACH_SITES)('%s renders <UserDevicesModal> rather than its own device list', (page) => {
    const source = readPage(page)
    expect(source).toContain('<UserDevicesModal')
    // The "never seen" rendering and the device table live in the shared
    // component only -- a copy in a page would mean two implementations to
    // keep in step.
    expect(source).not.toContain(NEVER_SEEN_LABEL)
    expect(source).not.toContain('getUserDevices')
  })

  it('is imported by exactly the two documented views (Teams.jsx has no member rows)', () => {
    // Task 15.4 documents that Teams.jsx is not an attach site: it lists
    // teams, not members, so there is no user to open a device list for.
    expect(readPage('Teams.jsx')).not.toContain('UserDevicesModal')
  })
})
