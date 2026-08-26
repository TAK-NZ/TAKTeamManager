import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import Users from './Users.jsx'
import { TOOLTIP_SEPARATOR } from '../components/FormattedDate.jsx'
import { usersAPI, deviceManagementAPI } from '../services/api'
import { setDisplayTimezone, DEFAULT_DISPLAY_TIMEZONE } from '../utils/dateFormat'

// Validates: Requirements 2.3, 2.4, 3.1, 3.5, 3.7, 3.11
//
// date-tooltips-and-folder-contrast task 6.7. Date_Render_Position 6 -- the
// Last Login cell -- is ONE of the two ternary-guarded call sites, and
// design.md Decision 13 turns on what it renders for a value that is present
// but unparseable: the ternary takes its truthy branch, `formatDate`'s own
// default fallback applies, and the cell renders the EMPTY STRING. Folding
// `'Never'` into `FormattedDate`'s `fallback` prop would render `Never` there
// instead, which is arguably the better product decision and is exactly what
// Criterion 2.3 forbids this change from making as a side effect.
//
// This file is NEW, and creating it rather than asserting the ternary against
// the source was a deliberate call: Decision 13's claim is about three
// rendered strings, one of which ('') is invisible in the source and can only
// be established by rendering. `Users.jsx` had no test file at all, so there
// was nothing to extend.
//
// This project has no `@testing-library/react` (absent from
// `client/package.json` and from `client/node_modules`) and none is added, so
// the page is mounted with `react-dom/client`'s `createRoot` plus React 18's
// own `act` -- the pattern `src/components/TransferMemberDialog.test.jsx`
// established and `src/pages/AuditLogs.test.jsx` follows.
//
// `../services/api` is the only mock: the network boundary. The date module
// is REAL, with a fixed zone installed, so the rendered string is a checked
// fact rather than a value a mock invented.

vi.mock('../services/api', () => ({
  usersAPI: { getAll: vi.fn() },
  // `Users.jsx` reaches this only through `useDeviceManagementEnabled`, which
  // gates the Devices action. A named import of a missing export from a
  // mocked ES module is a load-time failure, so the whole surface the modal
  // and its revoke dialog import is present.
  deviceManagementAPI: {
    probeEnabled: vi.fn(),
    getUserDevices: vi.fn(),
    revokeUserDevice: vi.fn(),
    revokeMyDevice: vi.fn()
  }
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}))

// vitest compiles this JSX with esbuild's classic transform, and neither
// `Users.jsx` nor `FormattedDate.jsx` imports `React` itself.
globalThis.React = React

/** The instant device-management Requirement 18.2 measured. */
const REPORTED_INSTANT = '2026-03-12T00:58:04.508Z'

const userRow = (overrides = {}) => ({
  pk: 1,
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  username: 'ada',
  team_name: 'ORG > Alpha',
  is_active: true,
  local_user_id: 7,
  last_login: REPORTED_INSTANT,
  ...overrides
})

describe('Users Last Login cell renders through FormattedDate (task 6.7)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: false })
    setDisplayTimezone('UTC')
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
    // Module state shared with every other test file, so it goes back to the
    // documented default rather than staying on this file's fixed zone.
    setDisplayTimezone(DEFAULT_DISPLAY_TIMEZONE)
  })

  const mountWith = async (users) => {
    usersAPI.getAll.mockResolvedValue({ data: { users } })
    root = createRoot(container)
    await act(async () => {
      root.render(<Users />)
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  /** The Last Login cell -- the fourth of the row's five cells. */
  const lastLoginCell = () => container.querySelectorAll('tbody tr td')[3]
  const hostOf = () => lastLoginCell().querySelector('span[tabindex="0"]')

  const tooltipOf = () => {
    const host = hostOf()
    const id = host && host.getAttribute('aria-describedby')
    return id ? document.getElementById(id) : null
  }

  it('renders the date-only string in the installed zone, unchanged', async () => {
    await mountWith([userRow()])

    // `formatDate`, so the calendar day in the installed zone and no time of
    // day -- exactly what this cell rendered before the adoption.
    expect(lastLoginCell().textContent).toBe('2026-03-12')
    // The raw ISO value the row carries must not reach the page.
    expect(container.textContent).not.toContain(REPORTED_INSTANT)
  })

  it('leaves nothing disclosed at rest and opens LEFTWARD on pointer (Criteria 3.5, 3.7, 3.11)', async () => {
    await mountWith([userRow()])

    const host = hostOf()
    expect(host).not.toBeNull()
    expect(host.className).toContain('cursor-help')
    // Reachable by keyboard, not by hover alone (Criterion 3.1).
    expect(host.getAttribute('tabindex')).toBe('0')
    expect(host.hasAttribute('aria-describedby')).toBe(false)
    expect(tooltipOf()).toBeNull()

    await act(async () => {
      host.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    })

    const tooltip = tooltipOf()
    expect(tooltip).not.toBeNull()
    // Second-to-last cell of a horizontally scrolling table, so it opens
    // leftward -- a tooltip pushed past that container's left edge is clipped
    // AND unreachable.
    expect(tooltip.className).toContain('right-full')
    expect(tooltip.className).toContain('mr-2')
    expect(tooltip.className).toContain('top-1/2')
    expect(tooltip.className).toContain('-translate-y-1/2')
    expect(tooltip.className).not.toContain('left-full')
    expect(container.innerHTML).not.toContain('top-full')
    expect(container.innerHTML).not.toContain('bottom-full')

    // Two facts, the phrase first and the resolved zone second, separated
    // explicitly (Criteria 2.8, 2.10), with no ISO instant (Criterion 2.11).
    const [phrase, ...rest] = tooltip.textContent.split(TOOLTIP_SEPARATOR)
    expect(phrase.length).toBeGreaterThan(0)
    expect(rest.join(TOOLTIP_SEPARATOR)).toBe('UTC')
    expect(tooltip.textContent).not.toContain(REPORTED_INSTANT)

    await act(async () => {
      host.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
    })
    expect(tooltipOf()).toBeNull()
    expect(lastLoginCell().textContent).toBe('2026-03-12')
  })

  // Decision 13, pinned rather than described. The absent case takes the
  // ternary's own false branch and renders `'Never'`; the present-but-
  // unparseable case takes the TRUTHY branch and renders the helper's default
  // `''`. Both carry no disclosure host at all (Criterion 2.7).
  it.each([
    ['an absent last_login (the ternary\'s own branch)', null, 'Never'],
    ['a present-but-unparseable last_login', 'not-a-date', '']
  ])('renders %s as %o with no disclosure host', async (_name, lastLogin, expected) => {
    await mountWith([userRow({ last_login: lastLogin })])

    expect(lastLoginCell().textContent).toBe(expected)
    expect(hostOf()).toBeNull()
    expect(container.querySelector('[aria-describedby]')).toBeNull()
  })
})

// takserver-enrollment Criterion 13.6 (task 11.5): `GET /api/users`'
// `live_certificate_count` field (added by server task 8.6, from the SAME
// batched query this page's own `usersAPI.getAll()` fetch already runs --
// no second request) reaches this view and drives
// `MultipleCertificateWarning` here too, exactly as it does on
// `TeamDeviceList` (Criterion 13.6's other consumer). This is deliberately
// NOT gated on `devicesEnabled`/`deviceManagementAPI.probeEnabled`: per
// design decision 17, the count is already zero -- and therefore already
// inert -- whenever DEVICE_MGMT_ENABLED is off, so no second flag check is
// needed or wanted.
describe('live_certificate_count drives MultipleCertificateWarning in the Users view (takserver-enrollment Criterion 13.6)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: false })
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

  const mountWith = async (users) => {
    usersAPI.getAll.mockResolvedValue({ data: { users } })
    root = createRoot(container)
    await act(async () => {
      root.render(<Users />)
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  it.each([
    [0, false],
    [1, false],
    [2, true]
  ])('renders the warning if and only if live_certificate_count is %i (expected to warn: %s)', async (count, shouldWarn) => {
    await mountWith([userRow({ live_certificate_count: count })])

    if (shouldWarn) {
      expect(container.textContent).toContain(String(count))
      expect(container.querySelector('[role="alert"]')).toBeNull()
    } else {
      // At 0 or 1 the row renders with nothing extra: no certificate count
      // rendered as a standalone warning string anywhere in the row.
      const row = container.querySelector('tbody tr')
      expect(row.textContent).not.toMatch(/active TAK Server certificates?/)
    }
  })

  it('does not throw and renders nothing extra for a user row missing the field entirely', async () => {
    const { live_certificate_count, ...rowWithoutField } = userRow()
    await expect(mountWith([rowWithoutField])).resolves.not.toThrow()
    const row = container.querySelector('tbody tr')
    expect(row.textContent).not.toMatch(/active TAK Server certificates?/)
  })
})
