import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import Dashboard from './Dashboard.jsx'
import { REVOKE_CONFIRMATION_WORD, REVOKE_WARNING_STATEMENT } from '../components/RevokeDeviceDialog.jsx'
import UserDevicesModal from '../components/UserDevicesModal.jsx'
import {
  DEVICE_LIST_COLUMNS,
  CONNECTED_LABEL,
  NEVER_SEEN_LABEL,
  EXPIRES_SOON_LABEL,
  EXPIRED_LABEL,
  revokeActionLabel
} from '../components/DeviceListRow.jsx'
import { labelForClientType } from '../components/DeviceTypeIcon.jsx'
import { usersAPI, channelsAPI, requestsAPI, configAPI, deviceManagementAPI } from '../services/api'
import { formatDate, formatDateTime } from '../utils/dateFormat'
import { DEFAULT_EXPIRY_WARNING_DAYS, setExpiryWarningDays } from '../utils/expiryWarning'

// Validates: Requirements 5.1, 5.2, 5.3, 7.2, 15.6, 16.2, 16.3, 16.5, 16.6,
// 16.7, 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 20.9, 20.11, 21.2, 21.3, 21.4,
// 21.5, 21.8
//
// The "My Devices" card is rendered only when `probeEnabled()` reports the
// feature is on (Requirement 5.1, and Requirement 1.4's rule that
// DEVICE_MGMT_ENABLED is never published through /api/config/public), lists
// UID / issued / expires / Last_Seen per device (5.2), and renders a null
// `lastSeenAt` as "never seen" in place of that value ONLY (5.3). Those are
// render-level facts, so this file mounts the real page.
//
// This project has no `@testing-library/react` (absent from
// `client/package.json` and from `client/node_modules`) and no dependency is
// added for this task, so the page is mounted with `react-dom/client`'s
// `createRoot` plus React 18's own `act` under the `jsdom` environment
// already configured in `vite.config.js` -- the approach established by
// `src/components/TransferMemberDialog.test.jsx` and `src/pages/Requests.test.jsx`.
//
// `../services/api` and `react-hot-toast` are the only mocks: the network
// boundary and the toast sink. The nested `RevokeDeviceDialog` is the real
// component.

vi.mock('../services/api', () => ({
  usersAPI: { getMe: vi.fn() },
  channelsAPI: { getDescriptions: vi.fn() },
  requestsAPI: { getPending: vi.fn() },
  configAPI: { getColorMappings: vi.fn(), getPublic: vi.fn() },
  // Dashboard.jsx imports teamsAPI but does not call it here; a named import
  // of a missing export from a mocked ES module is a load-time failure, so it
  // is present.
  teamsAPI: {},
  deviceManagementAPI: {
    probeEnabled: vi.fn(),
    revokeMyDevice: vi.fn(),
    revokeUserDevice: vi.fn(),
    // Used only by the cross-surface comparison at the bottom of this file,
    // which mounts the admin modal beside the Dashboard card.
    getUserDevices: vi.fn()
  }
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}))

// See the note in TransferMemberDialog.test.jsx: vitest compiles this JSX
// with esbuild's classic transform, so the component sources (which have no
// `React` import of their own) need one in scope.
globalThis.React = React

const USER = { id: 7, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' }

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The `expires_at` for every fixture below whose test has nothing to do with
 * expiry -- RELATIVE to the clock, deliberately, and not to be "simplified"
 * back to a literal.
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

// Requirement 5.3: a device no poll has ever observed connected. Every other
// field is present and real -- only `lastSeenAt` is null.
const NEVER_SEEN_DEVICE = {
  clientUid: 'ANDROID-never0002',
  clientType: 'android',
  issuedAt: '2025-03-04T05:06:07Z',
  expiresAt: UNEXPIRING_EXPIRES_AT,
  lastSeenAt: null,
  revoked: false
}

// Requirement 15.6: one device per Client_Type, each with a real Client_Uid
// observed on the live server. `clientType` arrives already derived
// server-side (Requirement 15.1); the client never classifies.
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
 * The Device_List_Refresh_Interval (Requirement 19.1). `Dashboard.jsx` keeps
 * this as a module constant rather than exporting it, so it is restated here;
 * 60000 ms is the figure the criterion names, so the test is pinned to the
 * requirement rather than to the implementation's spelling of it.
 */
const REFRESH_INTERVAL_MS = 60000

/**
 * The text a screen reader would announce for an element: its `textContent`
 * with every `aria-hidden` subtree removed, whitespace collapsed.
 *
 * Requirements 20.9 and 21.3 both turn on a state being carried by TEXT rather
 * than by colour, and the decorative parts of those cells (the connected dot,
 * the Revoke glyph and its tooltip) are `aria-hidden`. Asserting on raw
 * `textContent` would pass an implementation that hid the label from assistive
 * technology, and asserting on class names alone would pass one that conveyed
 * the state by colour only -- so the assertions below read the accessible text.
 */
const accessibleTextOf = (element) => {
  const clone = element.cloneNode(true)
  clone.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove())
  return clone.textContent.replace(/\s+/g, ' ').trim()
}

/** Column offsets in the shared row (`DEVICE_LIST_COLUMNS`). */
const EXPIRES_CELL = DEVICE_LIST_COLUMNS.indexOf('Expires')
const LAST_SEEN_CELL = DEVICE_LIST_COLUMNS.indexOf('Last Seen')

const KNOWN_LAST_SEEN = '2025-06-07T08:09:00Z'

/**
 * Requirement 20.9: the FOUR combinations of Connection_Status against whether
 * a Last_Seen timestamp is known, with the accessible text each must produce.
 *
 * The connected-and-known case is the one the criterion is really about --
 * adopting the label must cost no information, so the timestamp stays beside
 * it. The connected-and-unknown case must NOT fall back to "never seen", which
 * would read as the self-contradiction "Connected never seen".
 */
const CONNECTED_COMBINATIONS = [
  {
    name: 'connected, Last_Seen known',
    device: { connected: true, lastSeenAt: KNOWN_LAST_SEEN },
    expected: `${CONNECTED_LABEL} ${formatDateTime(KNOWN_LAST_SEEN, '')}`
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
 * Requirements 21.2-21.5: one device per expiry state, plus the two cases that
 * must stay unhighlighted.
 *
 * The offsets are computed from `Date.now()` at import time and are five days
 * / one day / 400 days from it, so the classification is unambiguous at the
 * installed 30-day threshold no matter when the suite runs, and no test has to
 * manipulate the clock to reach a state.
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

describe('Dashboard "My Devices" card', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)

    usersAPI.getMe.mockResolvedValue({ data: { user: { ...USER, groups: [] }, teams: [] } })
    channelsAPI.getDescriptions.mockResolvedValue({ data: { channels: [] } })
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [] } })
    configAPI.getColorMappings.mockResolvedValue({ data: { colorMappings: {}, roleDescriptions: {} } })
    configAPI.getPublic.mockResolvedValue({ data: {} })
    deviceManagementAPI.probeEnabled.mockResolvedValue({
      enabled: true,
      devices: [SEEN_DEVICE, NEVER_SEEN_DEVICE]
    })
    deviceManagementAPI.revokeMyDevice.mockResolvedValue({ data: { enqueued: true } })
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

  const mount = async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Dashboard user={USER} />
        </MemoryRouter>
      )
    })
  }

  // The card is one of several `.card` blocks on the page, so every device
  // assertion is scoped to the block headed "My Devices".
  const devicesCard = () =>
    Array.from(container.querySelectorAll('.card')).find(
      (card) => card.querySelector('h2')?.textContent === 'My Devices'
    )
  const rowFor = (clientUid) =>
    Array.from(devicesCard().querySelectorAll('tbody tr')).find((tr) => tr.textContent.includes(clientUid))
  const cellsOf = (tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())

  it('renders the card and lists the caller\'s own devices when the probe reports enabled (Reqs 5.1, 5.2)', async () => {
    await mount()

    expect(deviceManagementAPI.probeEnabled).toHaveBeenCalledTimes(1)

    const card = devicesCard()
    expect(card).not.toBeUndefined()

    const headers = Array.from(card.querySelectorAll('th')).map((th) => th.textContent.trim())
    // Task 22.4 added the leading Device_Type_Icon column (Requirement 15.6).
    expect(headers).toEqual(['Type', 'Device UID', 'Issued', 'Expires', 'Last Seen', 'Actions'])

    expect(rowFor(SEEN_DEVICE.clientUid)).not.toBeUndefined()
    expect(rowFor(NEVER_SEEN_DEVICE.clientUid)).not.toBeUndefined()
  })

  // Requirement 5.3, the named assertion for this task.
  it('renders "never seen" for a null lastSeenAt while every other field still shows', async () => {
    await mount()

    // The first cell is the Device_Type_Icon added by task 22.4.
    const [, uid, issued, expires, lastSeen] = cellsOf(rowFor(NEVER_SEEN_DEVICE.clientUid))

    expect(uid).toBe(NEVER_SEEN_DEVICE.clientUid)
    expect(issued).toBe(formatDate(NEVER_SEEN_DEVICE.issuedAt, 'Unknown'))
    expect(expires).toBe(formatDate(NEVER_SEEN_DEVICE.expiresAt, 'Unknown'))
    expect(lastSeen).toBe('never seen')

    // The label replaces the Last_Seen value only -- the issued and expires
    // cells hold real dates, not the fallback.
    expect(issued).not.toBe('Unknown')
    expect(expires).not.toBe('Unknown')
  })

  it('renders a real timestamp for a device that has been seen (Req 5.2)', async () => {
    await mount()

    const [, , , , lastSeen] = cellsOf(rowFor(SEEN_DEVICE.clientUid))
    expect(lastSeen).not.toBe('never seen')
    expect(lastSeen).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  // ══════════════════════════════════════════════════════════════════════
  // date-tooltips-and-folder-contrast task 6.7 -- Criteria 2.3, 2.4, 2.7,
  // 3.1, 3.5, 3.7, 3.11.
  //
  // The row's three Date_Render_Positions now render through the ONE shared
  // `FormattedDate`, so each acquires a disclosure. The TEXT assertions this
  // file already carries -- the `cellsOf` exact strings above and the
  // `accessibleTextOf(...).toBe(...)` comparisons further down -- are
  // deliberately reused as they stand rather than loosened: they are the
  // measured evidence behind design.md Decision 4 (the tooltip is mounted
  // only WHILE disclosed, so the resting DOM is character for character what
  // it was), and if they ever need loosening then the tooltip is in the DOM
  // when it should not be.
  // ══════════════════════════════════════════════════════════════════════
  describe('the three date cells disclose a Date_Tooltip (task 6.7)', () => {
    const ISSUED_CELL = DEVICE_LIST_COLUMNS.indexOf('Issued')

    const cellsFor = (clientUid) => rowFor(clientUid).querySelectorAll('td')
    const hostIn = (cell) => cell.querySelector('span[tabindex="0"]')

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

    it('leaves the whole card free of tooltips at rest (Criterion 3.7)', async () => {
      await mount()

      const card = devicesCard()
      expect(card.querySelector('[aria-describedby]')).toBeNull()

      // One host per date cell -- Issued, Expires, Last Seen -- each focusable
      // rather than hover-only (Criterion 3.1). Counted PER CELL rather than
      // per row: the leading Type column's Device_Type_Icon carries a
      // `tabIndex={0}` host of its own, which is not one of these.
      const cells = cellsFor(SEEN_DEVICE.clientUid)
      for (const index of [ISSUED_CELL, EXPIRES_CELL, LAST_SEEN_CELL]) {
        const hosts = cells[index].querySelectorAll('span[tabindex="0"]')
        expect(hosts).toHaveLength(1)
        expect(hosts[0].className).toContain('cursor-help')
        expect(hosts[0].hasAttribute('aria-describedby')).toBe(false)
      }
    })

    // Criterion 3.5, applied mechanically: the two leading date columns open
    // rightward, the trailing Last Seen column opens leftward, because a
    // tooltip pushed past a scroll container's left edge is clipped AND
    // unreachable while one past its right edge is merely clipped.
    it.each([
      ['Issued', () => ISSUED_CELL, 'left-full', 'ml-2'],
      ['Expires', () => EXPIRES_CELL, 'left-full', 'ml-2'],
      ['Last Seen', () => LAST_SEEN_CELL, 'right-full', 'mr-2']
    ])('opens the %s tooltip from %s', async (_name, cellIndex, anchor, gap) => {
      await mount()

      const cell = cellsFor(SEEN_DEVICE.clientUid)[cellIndex()]
      const host = hostIn(cell)
      expect(host).not.toBeNull()

      await pointerOver(host)
      const tooltip = tooltipFor(host)

      expect(tooltip).not.toBeNull()
      expect(tooltip.className).toContain(anchor)
      expect(tooltip.className).toContain(gap)
      expect(tooltip.className).toContain('top-1/2')
      expect(tooltip.className).toContain('-translate-y-1/2')
      // The Tooltip_Clipping_Defect was an upward-opening tooltip inside
      // this very `overflow-x-auto` wrapper (Criterion 3.4).
      expect(devicesCard().innerHTML).not.toContain('top-full')
      expect(devicesCard().innerHTML).not.toContain('bottom-full')
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

      const cell = cellsFor(NEVER_SEEN_DEVICE.clientUid)[LAST_SEEN_CELL]
      expect(accessibleTextOf(cell)).toBe(NEVER_SEEN_LABEL)
      expect(hostIn(cell)).toBeNull()

      // The two cells beside it DO have one -- so the absence is the value's,
      // not the row's.
      expect(hostIn(cellsFor(NEVER_SEEN_DEVICE.clientUid)[ISSUED_CELL])).not.toBeNull()
      expect(hostIn(cellsFor(NEVER_SEEN_DEVICE.clientUid)[EXPIRES_CELL])).not.toBeNull()
    })
  })

  it('hides the card entirely when the probe reports the feature is off (Req 1.8)', async () => {
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: false, devices: [] })
    await mount()

    expect(devicesCard()).toBeUndefined()
    expect(container.textContent).not.toContain('My Devices')
  })

  it('hides the card when the probe fails outright, rather than showing an empty list', async () => {
    deviceManagementAPI.probeEnabled.mockRejectedValue(new Error('Network Error'))
    await mount()

    expect(devicesCard()).toBeUndefined()
  })

  it('shows an empty-state instead of a table when the user has no devices', async () => {
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: true, devices: [] })
    await mount()

    const card = devicesCard()
    expect(card).not.toBeUndefined()
    expect(card.querySelector('tbody')).toBeNull()
    expect(card.textContent).toContain('No devices are enrolled under your name.')
  })

  // Requirements 7.2, 7.3: Revoke opens the shared REVOKE type-in dialog with
  // no `userId`, which is what selects the self-service endpoint.
  it('opens the shared REVOKE confirmation dialog, gated on the exact word (Req 7.2)', async () => {
    await mount()

    const revokeButton = rowFor(SEEN_DEVICE.clientUid).querySelector('button')
    await act(async () => {
      revokeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain(REVOKE_WARNING_STATEMENT)

    const confirmInput = container.querySelector('#revoke-confirmation')
    expect(confirmInput).not.toBeNull()

    const confirmButton = container.querySelector('button[type="submit"]')
    expect(confirmButton.disabled).toBe(true)

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setter.call(confirmInput, 'revoke')
      confirmInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('button[type="submit"]').disabled).toBe(true)

    await act(async () => {
      setter.call(confirmInput, REVOKE_CONFIRMATION_WORD)
      confirmInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('button[type="submit"]').disabled).toBe(false)

    await act(async () => {
      container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(deviceManagementAPI.revokeMyDevice).toHaveBeenCalledWith(
      SEEN_DEVICE.clientUid,
      REVOKE_CONFIRMATION_WORD
    )
    expect(deviceManagementAPI.revokeUserDevice).not.toHaveBeenCalled()
    // The card refreshes its list after the revocation is queued.
    expect(deviceManagementAPI.probeEnabled).toHaveBeenCalledTimes(2)
  })

  it('disables the Revoke action for an already-revoked device', async () => {
    deviceManagementAPI.probeEnabled.mockResolvedValue({
      enabled: true,
      devices: [{ ...SEEN_DEVICE, revoked: true }]
    })
    await mount()

    expect(rowFor(SEEN_DEVICE.clientUid).querySelector('button').disabled).toBe(true)
    expect(devicesCard().textContent).toContain('Revoked')
  })

  // ════════════════════════════════════════════════════════════════════════
  // device-management task 22.6 / Requirements 15.6, 16.2, 16.3, 16.5, 16.7:
  // the icon-only Revoke control and the Device_Type_Icon, in the card. The
  // same assertions run against the admin modal in
  // `src/components/UserDevicesModal.test.jsx`, because Requirement 16.6
  // requires the two surfaces to behave identically.
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

      expect(revokeButtonFor(NEVER_SEEN_DEVICE.clientUid).getAttribute('aria-label')).toBe(
        `Revoke device ${NEVER_SEEN_DEVICE.clientUid}`
      )
    })

    it('discloses the enabled control\'s tooltip on focus as well as on hover (Req 16.3)', async () => {
      await mount()

      const button = revokeButtonFor(SEEN_DEVICE.clientUid)
      button.focus()
      expect(document.activeElement).toBe(button)

      // jsdom applies no stylesheet, so the disclosure is asserted through the
      // Tailwind classes that implement it: the `relative group` pattern
      // already in this page (Req 16.4), revealed by hover AND focus-within.
      const wrapper = button.parentElement
      expect(wrapper.className).toContain('relative')
      expect(wrapper.className).toContain('group')

      const tooltip = wrapper.querySelector('span[aria-hidden="true"]')
      expect(tooltip.textContent.trim()).toBe('Revoke device')
      expect(tooltip.className).toContain('opacity-0')
      expect(tooltip.className).toContain('group-hover:opacity-100')
      expect(tooltip.className).toContain('group-focus-within:opacity-100')

      // Actions is the last column, so the tooltip opens leftward and stays on
      // its own row, inside the scrolling wrapper's box on every side. jsdom
      // applies no stylesheet, so this asserts the anchoring, not the absence
      // of clipping, which is only observable in a browser.
      expect(tooltip.className).toContain('right-full')
      expect(tooltip.className).not.toContain('bottom-full')
    })

    it('announces a revoked device\'s control as unavailable, in text and not by color (Reqs 16.5, 16.7)', async () => {
      deviceManagementAPI.probeEnabled.mockResolvedValue({
        enabled: true,
        devices: [{ ...SEEN_DEVICE, revoked: true }]
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

      expect(button.getAttribute('aria-label')).toBe(revokeActionLabel(SEEN_DEVICE.clientUid))
    })
  })

  describe('Device_Type_Icon in the card (Reqs 15.6, 16.6)', () => {
    it('renders a labelled type icon in the leading cell of every row', async () => {
      deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: true, devices: TYPED_DEVICES })
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

    it('renders the Unknown label for a device whose clientType the client does not know', async () => {
      deviceManagementAPI.probeEnabled.mockResolvedValue({
        enabled: true,
        devices: [{ ...SEEN_DEVICE, clientType: 'blackberry' }]
      })
      await mount()

      const icon = rowFor(SEEN_DEVICE.clientUid).querySelector('[role="img"]')
      expect(icon.getAttribute('aria-label')).toBe('Unknown client type')
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// Requirement 16.6: Criteria 16.1-16.5 apply IDENTICALLY in the Dashboard "My
// Devices" card and in the user-details modal, because both render the same
// list from the same `DeviceListRow`.
//
// Asserted structurally rather than by inspecting imports: both surfaces are
// mounted with the SAME device data, and their column captions, their type
// icons' accessible names, and their Revoke controls' accessible names and
// disabled states are compared to each other. A copy of the row JSX in one
// surface that drifted from the other -- a renamed column, a dropped
// `aria-label`, a tooltip that stopped appearing on focus -- fails here, which
// asserting "both files import DeviceListRow" would not.
//
// This is the one place in the suite that mounts both surfaces, which is why
// it lives here rather than in either component's own file.
// ══════════════════════════════════════════════════════════════════════════
describe('the Dashboard card and the admin modal render the same row markup (Reqs 16.6, 20.9, 21.8)', () => {
  // Requirements 20.9 and 21.8 extend this comparison rather than duplicating
  // its harness: the set now also carries a connected device, a connected
  // device with no Last_Seen, an Imminent_Expiry, an already-expired
  // certificate and a null `expiresAt`, so every state marker the shared row
  // can draw is part of the compared shape -- which is what makes "identically
  // in both surfaces" an assertion rather than an assumption.
  const DEVICES = [
    ...TYPED_DEVICES,
    { ...SEEN_DEVICE, revoked: true },
    {
      ...TYPED_DEVICES[1],
      clientUid: 'ANDROID-connected0007',
      connected: true,
      lastSeenAt: KNOWN_LAST_SEEN
    },
    {
      ...TYPED_DEVICES[1],
      clientUid: 'ANDROID-connectednoseen0008',
      connected: true,
      lastSeenAt: null
    },
    IMMINENT_DEVICE,
    EXPIRED_DEVICE,
    UNKNOWN_EXPIRY_DEVICE
  ]

  const indexOf = (clientUid) => DEVICES.findIndex((device) => device.clientUid === clientUid)

  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)

    usersAPI.getMe.mockResolvedValue({ data: { user: { ...USER, groups: [] }, teams: [] } })
    channelsAPI.getDescriptions.mockResolvedValue({ data: { channels: [] } })
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [] } })
    configAPI.getColorMappings.mockResolvedValue({ data: { colorMappings: {}, roleDescriptions: {} } })
    configAPI.getPublic.mockResolvedValue({ data: {} })
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: true, devices: DEVICES })
    deviceManagementAPI.getUserDevices.mockResolvedValue({ data: { devices: DEVICES } })
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

  /** Mounts one surface and returns the element holding its device table. */
  const mountSurface = async (surface) => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        surface === 'card' ? (
          <MemoryRouter>
            <Dashboard user={USER} />
          </MemoryRouter>
        ) : (
          <UserDevicesModal userId={42} userName="Ada Lovelace" onClose={vi.fn()} />
        )
      )
    })

    return surface === 'card'
      ? Array.from(container.querySelectorAll('.card')).find(
          (card) => card.querySelector('h2')?.textContent === 'My Devices'
        )
      : container
  }

  /**
   * The row-level facts Criteria 16.1-16.5, 15.6, 20.9 and 21.8 are about, per
   * surface.
   *
   * The expiry styling is captured as two booleans rather than as the cell's
   * class list because the ONE documented difference between the surfaces is
   * cell padding (`compact`), so comparing raw class names would report that
   * intended difference as drift and hide any real one.
   */
  const describeSurface = (scope) => ({
    columns: Array.from(scope.querySelectorAll('thead th')).map((th) => th.textContent.trim()),
    rows: Array.from(scope.querySelectorAll('tbody tr')).map((tr) => {
      const button = tr.querySelector('button')
      const wrapper = button.parentElement
      const cells = tr.querySelectorAll('td')
      const expiryCell = cells[EXPIRES_CELL]
      return {
        typeLabel: tr.querySelector('[role="img"]').getAttribute('aria-label'),
        revokeLabel: button.getAttribute('aria-label'),
        revokeDisabled: button.disabled,
        tooltip: wrapper.querySelector('span[aria-hidden="true"]').textContent.trim(),
        tooltipOnFocus: wrapper
          .querySelector('span[aria-hidden="true"]')
          .className.includes('group-focus-within:opacity-100'),
        // Requirement 20.9 / 21.3: what assistive technology would announce,
        // with the decorative dot and glyph removed.
        lastSeen: accessibleTextOf(cells[LAST_SEEN_CELL]),
        expiry: accessibleTextOf(expiryCell),
        expiryBold: expiryCell.className.includes('font-bold'),
        expiryRed: expiryCell.className.includes('text-red-600')
      }
    })
  })

  it('produces the same column set and the same accessible names for the same devices', async () => {
    const card = describeSurface(await mountSurface('card'))
    await act(async () => {
      root.unmount()
    })
    root = null
    const modal = describeSurface(await mountSurface('modal'))

    // Both surfaces were handed the same devices, so anything that differs is
    // drift between two renderings of one list.
    expect(card.columns).toEqual([...DEVICE_LIST_COLUMNS])
    expect(modal.columns).toEqual(card.columns)
    expect(modal.rows).toEqual(card.rows)

    // And the compared shape is not vacuously empty: it covers every device,
    // includes the revoked one, and every row carries a real name.
    expect(card.rows).toHaveLength(DEVICES.length)
    expect(card.rows.filter((row) => row.revokeDisabled)).toHaveLength(1)
    card.rows.forEach((row, index) => {
      expect(row.revokeLabel).toBe(revokeActionLabel(DEVICES[index].clientUid))
      expect(row.typeLabel).toBe(labelForClientType(DEVICES[index].clientType))
      expect(row.tooltipOnFocus).toBe(true)
    })

    // Requirements 20.9, 21.8: nor is it vacuous for the state markers. Each
    // is located by its own device rather than by counting rows, so the
    // assertion does not depend on how far away the other fixtures' expiry
    // dates happen to be from today.
    const connectedRow = card.rows[indexOf('ANDROID-connected0007')]
    expect(connectedRow.lastSeen).toBe(`${CONNECTED_LABEL} ${formatDateTime(KNOWN_LAST_SEEN, '')}`)
    expect(card.rows[indexOf('ANDROID-connectednoseen0008')].lastSeen).toBe(CONNECTED_LABEL)

    // (`expiry` is the cell's accessible text. These are `toContain` because
    // what they check is non-vacuity -- the date is retained AND the marker is
    // present -- as two independent facts; the cross-surface comparison itself
    // is the `toEqual` above. The exact full cell text is pinned by the
    // per-surface blocks.)
    const imminentRow = card.rows[indexOf(IMMINENT_DEVICE.clientUid)]
    expect(imminentRow.expiry).toContain(formatDate(IMMINENT_DEVICE.expiresAt, 'Unknown'))
    expect(imminentRow.expiry).toContain(EXPIRES_SOON_LABEL)
    expect(imminentRow.expiryBold && imminentRow.expiryRed).toBe(true)

    const expiredRow = card.rows[indexOf(EXPIRED_DEVICE.clientUid)]
    expect(expiredRow.expiry).toContain(formatDate(EXPIRED_DEVICE.expiresAt, 'Unknown'))
    expect(expiredRow.expiry).toContain(EXPIRED_LABEL)
    expect(expiredRow.expiry).not.toContain(EXPIRES_SOON_LABEL)
    expect(expiredRow.expiryBold && expiredRow.expiryRed).toBe(true)

    const unknownExpiryRow = card.rows[indexOf(UNKNOWN_EXPIRY_DEVICE.clientUid)]
    expect(unknownExpiryRow.expiry).toBe('Unknown')
    expect(unknownExpiryRow.expiryBold || unknownExpiryRow.expiryRed).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// device-management task 27.2 / Requirement 19: the "My Devices" card keeps
// itself current on the Visibility_Pause_Pattern.
//
// Fake timers, in their own top-level describe with their own harness, so the
// blocks above keep running on real timers: introducing `vi.useFakeTimers()`
// into the shared setup would change the timing of every existing test in this
// file for no benefit.
//
// ONE CONSEQUENCE OF THE SHARED HELPER WORTH KNOWING WHILE READING THIS BLOCK:
// `startVisibilityPausedRefresh` is used TWICE on this page -- once for the
// channel card and once for the device card (Requirement 19.2 requires exactly
// that, rather than a second differently-behaved mechanism) -- so every timer
// tick fires `fetchChannelData` as well as `fetchDevices`. `usersAPI.getMe`,
// `channelsAPI.getDescriptions` and `requestsAPI.getPending` are mocked
// resolved in `beforeEach`, so those extra fetches resolve harmlessly; each
// tick is wrapped in `act` so their state updates are flushed inside it. The
// first test asserts the two cards tick together, which is the observable form
// of "one mechanism, used twice".
// ══════════════════════════════════════════════════════════════════════════
describe('Dashboard "My Devices" card auto-refresh (Reqs 19.1-19.6)', () => {
  let container
  let root
  let consoleErrorSpy
  let tabHidden

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // `document.hidden` is a getter on Document.prototype in jsdom and there is
    // no API to set it, so the tab's visibility is faked with an own property
    // and removed again in `afterEach`.
    tabHidden = false
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => tabHidden
    })

    vi.useFakeTimers()

    container = document.createElement('div')
    document.body.appendChild(container)

    usersAPI.getMe.mockResolvedValue({ data: { user: { ...USER, groups: [] }, teams: [] } })
    channelsAPI.getDescriptions.mockResolvedValue({ data: { channels: [] } })
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [] } })
    configAPI.getColorMappings.mockResolvedValue({ data: { colorMappings: {}, roleDescriptions: {} } })
    configAPI.getPublic.mockResolvedValue({ data: {} })
    // A fresh array of fresh objects per call, so a refresh really does replace
    // the rendered list with different object identities -- which is the thing
    // Requirement 19.4's open dialog has to survive.
    deviceManagementAPI.probeEnabled.mockImplementation(async () => ({
      enabled: true,
      devices: [{ ...SEEN_DEVICE }, { ...NEVER_SEEN_DEVICE }]
    }))
    deviceManagementAPI.revokeMyDevice.mockResolvedValue({ data: { enqueued: true } })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    vi.useRealTimers()
    delete document.hidden
    container.remove()

    // Every tick in this block drives React state updates from a timer
    // callback, which is exactly where an unwrapped update warning would come
    // from. `console.error` is silenced (the page logs a failed fetch on
    // purpose), so the warnings are inspected here rather than being lost.
    const actWarnings = consoleErrorSpy.mock.calls.filter(
      ([first]) => typeof first === 'string' && first.includes('not wrapped in act')
    )
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    expect(actWarnings).toEqual([])
  })

  const mount = async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Dashboard user={USER} />
        </MemoryRouter>
      )
    })
  }

  /** Advances the clock by whole refresh intervals, flushing what they start. */
  const tick = async (intervals = 1) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * intervals)
    })
  }

  const fireVisibilityChange = async (hidden) => {
    tabHidden = hidden
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }

  const devicesCard = () =>
    Array.from(container.querySelectorAll('.card')).find(
      (card) => card.querySelector('h2')?.textContent === 'My Devices'
    )
  const rowFor = (clientUid) =>
    Array.from(devicesCard()?.querySelectorAll('tbody tr') ?? []).find((tr) =>
      tr.textContent.includes(clientUid)
    )
  const rowTexts = () =>
    Array.from(devicesCard()?.querySelectorAll('tbody tr') ?? []).map((tr) =>
      accessibleTextOf(tr)
    )
  const deviceFetchCount = () => deviceManagementAPI.probeEnabled.mock.calls.length

  it('re-fetches the device list on every interval tick while the tab is visible (Req 19.1)', async () => {
    await mount()

    // Mounting fetches once; the interval only schedules.
    expect(deviceFetchCount()).toBe(1)

    await tick()
    expect(deviceFetchCount()).toBe(2)

    await tick()
    expect(deviceFetchCount()).toBe(3)

    // n ticks, n fetches -- including several in one advance.
    await tick(3)
    expect(deviceFetchCount()).toBe(6)

    // Requirement 19.2: ONE mechanism, used twice. The channel card's fetch
    // ticked exactly as often, which a second hand-rolled device timer on a
    // different cadence would not have done.
    expect(usersAPI.getMe).toHaveBeenCalledTimes(6)

    // No page reload was involved: the same card is still rendering the list.
    expect(rowFor(SEEN_DEVICE.clientUid)).not.toBeUndefined()
    // And a background refresh never raises the spinner (Req 19.5).
    expect(devicesCard().querySelector('.animate-spin')).toBeNull()
  })

  it('stops fetching while the tab is hidden, then fetches immediately when it becomes visible again (Req 19.2)', async () => {
    await mount()
    await tick()
    expect(deviceFetchCount()).toBe(2)

    await fireVisibilityChange(true)
    const whileHidden = deviceFetchCount()

    // The interval is CLEARED, not merely ignored: several intervals pass with
    // no fetch at all.
    await tick(5)
    expect(deviceFetchCount()).toBe(whileHidden)

    // Becoming visible again refreshes IMMEDIATELY, without waiting out an
    // interval -- otherwise a tab returned to after an hour shows stale rows
    // for a further minute.
    await fireVisibilityChange(false)
    expect(deviceFetchCount()).toBe(whileHidden + 1)

    // ...and the interval is restarted rather than left cleared.
    await tick()
    expect(deviceFetchCount()).toBe(whileHidden + 2)
    await tick()
    expect(deviceFetchCount()).toBe(whileHidden + 3)
  })

  it('clears the interval and removes the visibilitychange listener on unmount (Req 19.3)', async () => {
    const removeEventListener = vi.spyOn(document, 'removeEventListener')
    await mount()
    await tick()
    const beforeUnmount = deviceFetchCount()
    expect(beforeUnmount).toBe(2)

    await act(async () => {
      root.unmount()
    })
    root = null

    // No timer survives the component: several intervals pass with no fetch.
    await tick(5)
    expect(deviceFetchCount()).toBe(beforeUnmount)

    // Nor does the listener: a visibilitychange after unmount would otherwise
    // call `refresh` on an unmounted tree.
    await fireVisibilityChange(false)
    expect(deviceFetchCount()).toBe(beforeUnmount)
    expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  })

  it('leaves an open revoke dialog, its target and its typed text intact across a refresh (Req 19.4)', async () => {
    await mount()

    await act(async () => {
      rowFor(SEEN_DEVICE.clientUid)
        .querySelector('button')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const partial = REVOKE_CONFIRMATION_WORD.slice(0, 3)
    await act(async () => {
      const input = container.querySelector('#revoke-confirmation')
      setter.call(input, partial)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('#revoke-confirmation').value).toBe(partial)

    // Two refreshes resolve underneath the open dialog, each replacing the
    // rendered list with freshly built device objects.
    await tick(2)
    expect(deviceFetchCount()).toBe(3)

    // Still open, still targeting the same Device, still holding what was
    // typed, and still gated on the full word.
    const input = container.querySelector('#revoke-confirmation')
    expect(input).not.toBeNull()
    expect(input.value).toBe(partial)
    expect(container.textContent).toContain(REVOKE_WARNING_STATEMENT)
    expect(container.querySelector('[role="dialog"], .fixed')).not.toBeNull()
    expect(container.querySelector('button[type="submit"]').disabled).toBe(true)

    // The dialog names the Device it targets, so "the Device it targets" is
    // asserted from the rendered dialog rather than from internal state.
    const dialogText = container.querySelector('form').closest('div.fixed').textContent
    expect(dialogText).toContain(SEEN_DEVICE.clientUid)
    expect(dialogText).not.toContain(NEVER_SEEN_DEVICE.clientUid)

    // Completing the confirmation still revokes the originally targeted Device.
    await act(async () => {
      setter.call(input, REVOKE_CONFIRMATION_WORD)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(deviceManagementAPI.revokeMyDevice).toHaveBeenCalledWith(
      SEEN_DEVICE.clientUid,
      REVOKE_CONFIRMATION_WORD
    )
  })

  it('keeps the last successful list rendered when a refresh fails (Req 19.5)', async () => {
    await mount()

    const before = rowTexts()
    expect(before).toHaveLength(2)

    deviceManagementAPI.probeEnabled.mockRejectedValue(new Error('Network Error'))
    await tick(2)
    expect(deviceFetchCount()).toBe(3)

    const card = devicesCard()
    expect(card).not.toBeUndefined()

    // Exactly the rows that were there before: not cleared, not reordered, not
    // replaced by the empty-list message, and not back behind the spinner.
    expect(rowTexts()).toEqual(before)
    expect(card.querySelector('.animate-spin')).toBeNull()
    expect(card.textContent).not.toContain('No devices are enrolled under your name.')

    // Requirement 19.5 permits the failure to be surfaced inline ALONGSIDE the
    // retained list, which is what the card does.
    expect(card.querySelector('[role="alert"]').textContent).toContain('Failed to load your devices.')
  })

  it('hides the card for a 404 from the probe but not for a 500 (Reqs 19.5, 19.6)', async () => {
    await mount()
    expect(devicesCard()).not.toBeUndefined()

    // A 5xx is REJECTED by `probeEnabled` (it only swallows a 404), and a
    // rejection must not make a card that was showing a list disappear.
    const serverError = Object.assign(new Error('Request failed with status code 500'), {
      response: { status: 500 }
    })
    deviceManagementAPI.probeEnabled.mockRejectedValue(serverError)
    await tick(3)

    expect(devicesCard()).not.toBeUndefined()
    expect(rowFor(SEEN_DEVICE.clientUid)).not.toBeUndefined()

    // A 404 is the ONE case `probeEnabled` resolves as disabled -- the feature
    // genuinely turned off server-side -- and that does hide the card.
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: false, devices: [] })
    await tick()

    expect(devicesCard()).toBeUndefined()
    expect(container.textContent).not.toContain('My Devices')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// device-management tasks 28.6 / 29.4, Requirements 20.9, 20.11, 21.2-21.5:
// the Connected_Label and the two expiry markers, in the Dashboard card. The
// same assertions run against the user-details modal in
// `src/components/UserDevicesModal.test.jsx`, and the two surfaces are
// compared directly to each other in the cross-surface block above (Req 21.8).
// ══════════════════════════════════════════════════════════════════════════
describe('Connected_Label and expiry markers in the card (Reqs 20.9, 20.11, 21.2-21.5)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)

    usersAPI.getMe.mockResolvedValue({ data: { user: { ...USER, groups: [] }, teams: [] } })
    channelsAPI.getDescriptions.mockResolvedValue({ data: { channels: [] } })
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [] } })
    configAPI.getColorMappings.mockResolvedValue({ data: { colorMappings: {}, roleDescriptions: {} } })
    // No `device_expiry_warning_days` on the public config, which Requirement
    // 21.7 says means 30 client-side. Installed explicitly as well, so the
    // threshold these fixtures are placed against is stated rather than
    // inherited from whatever ran before.
    configAPI.getPublic.mockResolvedValue({ data: {} })
    setExpiryWarningDays(DEFAULT_EXPIRY_WARNING_DAYS)
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

  const mountWith = async (devices) => {
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: true, devices })
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Dashboard user={USER} />
        </MemoryRouter>
      )
    })
  }

  const devicesCard = () =>
    Array.from(container.querySelectorAll('.card')).find(
      (card) => card.querySelector('h2')?.textContent === 'My Devices'
    )
  const cellsFor = (clientUid) =>
    Array.from(devicesCard().querySelectorAll('tbody tr'))
      .find((tr) => tr.textContent.includes(clientUid))
      .querySelectorAll('td')

  // Requirement 20.9: all four combinations, in one mount, so a rule that
  // happens to work for one of them cannot pass by accident.
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
    const device = {
      ...SEEN_DEVICE,
      clientUid: 'ANDROID-connected0009',
      connected: true
    }
    await mountWith([device])

    const cell = cellsFor(device.clientUid)[LAST_SEEN_CELL]
    const label = Array.from(cell.querySelectorAll('span')).find((span) =>
      span.textContent.includes(CONNECTED_LABEL)
    )

    expect(label).not.toBeUndefined()
    expect(label.getAttribute('aria-hidden')).toBeNull()
    expect(label.className).toContain('text-green-700')
    // The dot is decoration and announces nothing.
    const dot = cell.querySelector('[aria-hidden="true"]')
    expect(dot).not.toBeNull()
    expect(dot.textContent).toBe('')
    // Removing the colour would leave the state fully readable.
    expect(accessibleTextOf(cell)).toContain(CONNECTED_LABEL)
  })

  // Requirement 20.11: a Device_Table row that was deleted as stale and later
  // re-inserted by the Device_Sync takes the `connected` column DEFAULT until
  // the poller re-derives it, so the wire shape the card renders may carry
  // `false` -- or, for any response written before the column existed, no
  // `connected` key at all. Both must render as not connected.
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

  // Requirements 21.2, 21.3: bold AND red AND a text marker. Colour and weight
  // reach nobody using a screen reader, so the marker is what carries it.
  it('renders an Imminent_Expiry bold, red, and marked "Expires soon" (Reqs 21.2, 21.3)', async () => {
    await mountWith([IMMINENT_DEVICE])

    const cell = cellsFor(IMMINENT_DEVICE.clientUid)[EXPIRES_CELL]
    expect(cell.className).toContain('font-bold')
    expect(cell.className).toContain('text-red-600')

    // The marker is named by its OWN classes rather than taken as the cell's
    // first span: since date-tooltips-and-folder-contrast task 6.1 the date
    // beside it renders through `FormattedDate`, whose disclosure wrapper is
    // also a span and comes first in document order. The cell's accessible
    // TEXT is unchanged either way -- that is the assertion at the end of this
    // test, and it is untouched.
    const marker = cell.querySelector('span.font-semibold')
    // Trimmed: the marker's own text begins with the space that separates it
    // from the date, so trimming leaves exactly the label.
    expect(marker.textContent.trim()).toBe(EXPIRES_SOON_LABEL)
    expect(marker.getAttribute('aria-hidden')).toBeNull()
    expect(marker.className).toContain('text-xs')
    expect(marker.className).toContain('font-semibold')

    // The date itself is still shown -- the marker qualifies it, it does not
    // replace it.
    //
    // Pinned as ONE exact string: the marker carries a leading space inside
    // the string, like the Connected_Label's timestamp, so the cell's
    // accessible text is the date and the marker separated by a real space
    // rather than run together. Asserting the whole cell also pins that
    // nothing else crept into it.
    const text = accessibleTextOf(cell)
    expect(text).toBe(`${formatDate(IMMINENT_DEVICE.expiresAt, 'Unknown')} ${EXPIRES_SOON_LABEL}`)
    expect(text).not.toContain('Unknown')
  })

  // Requirement 21.5: the same bold-red treatment, a DIFFERENT marker. "Expires
  // soon" would be a false statement about a date that has already passed.
  it('renders an already-expired certificate with the "Expired" marker instead (Req 21.5)', async () => {
    await mountWith([EXPIRED_DEVICE])

    const cell = cellsFor(EXPIRED_DEVICE.clientUid)[EXPIRES_CELL]
    expect(cell.className).toContain('font-bold')
    expect(cell.className).toContain('text-red-600')

    const text = accessibleTextOf(cell)
    expect(text).toContain(formatDate(EXPIRED_DEVICE.expiresAt, 'Unknown'))
    expect(text).toContain(EXPIRED_LABEL)
    expect(text).not.toContain(EXPIRES_SOON_LABEL)
    expect(EXPIRED_LABEL).not.toBe(EXPIRES_SOON_LABEL)
    expect(cell.querySelector('span.font-semibold').textContent.trim()).toBe(EXPIRED_LABEL)
  })

  // Requirement 21.4: a null `expires_at` leaves the cell exactly as it was --
  // no marker, no styling, the existing 'Unknown' fallback.
  it('leaves a null expiresAt and a far-future expiry unhighlighted and unmarked (Req 21.4)', async () => {
    await mountWith([UNKNOWN_EXPIRY_DEVICE, FAR_FUTURE_DEVICE])

    const nullCell = cellsFor(UNKNOWN_EXPIRY_DEVICE.clientUid)[EXPIRES_CELL]
    expect(accessibleTextOf(nullCell)).toBe('Unknown')
    // No MARKER span -- named by its classes, for the reason noted on the
    // Imminent_Expiry test above.
    expect(nullCell.querySelector('span.font-semibold')).toBeNull()
    expect(nullCell.className).not.toContain('font-bold')
    expect(nullCell.className).not.toContain('text-red-600')
    expect(nullCell.className).toContain('text-gray-500')

    const farCell = cellsFor(FAR_FUTURE_DEVICE.clientUid)[EXPIRES_CELL]
    expect(accessibleTextOf(farCell)).toBe(formatDate(FAR_FUTURE_DEVICE.expiresAt, 'Unknown'))
    expect(farCell.querySelector('span.font-semibold')).toBeNull()
    expect(farCell.className).not.toContain('font-bold')
  })
})
