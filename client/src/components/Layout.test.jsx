import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import Layout from './Layout.jsx'
import { ThemeProvider } from '../contexts/ThemeContext.jsx'
import { requestsAPI, adminAPI, versionAPI, deviceManagementAPI } from '../services/api'
// Extend each suite's clearAllMocks re-setup: probeEnabled must default to
// enabled so pre-existing nav-visibility tests keep seeing Devices. The
// device-mgmt-gating describe block below overrides it per test.
import { setExpiryWarningDays, DEFAULT_EXPIRY_WARNING_DAYS } from '../utils/expiryWarning'

// Bugfix (pending-requests-badge): the nav "Tasks" badge (renamed from
// "Requests" by cert-expiry-notifications Requirement 7.2 -- see the
// dedicated describe block below for that rename's own coverage) used to
// count ONLY access_requests-backed requests (requestsAPI.getPending),
// leaving a Global_Manager with a pending Org_Interest_Request (a wholly
// separate `org_interest_requests` table, surfaced today only via the
// /tasks page's own OrgInterestRequests panel) seeing no badge at all --
// even though that same request was visibly listed on /tasks. This file
// asserts the fix: for a Global_Manager, the badge sums BOTH counts; for
// any other admin (no admin:org_interest:read permission), it reads ONLY
// the access_requests count and never calls adminAPI.getOrgInterest at
// all.
//
// This project has no `@testing-library/react`, so Layout is mounted with
// `react-dom/client`'s `createRoot` plus React 18's own `act`.

vi.mock('../services/api', () => ({
  authAPI: { logout: vi.fn() },
  requestsAPI: { getPending: vi.fn() },
  adminAPI: { getOrgInterest: vi.fn() },
  // The outstanding-task count effect (Layout.jsx) now calls this for EVERY
  // user (a member's own certificate renewals feed the same badge/bell). A
  // bare vi.fn() returns undefined and `undefined` has no `.data`, so a
  // resolvable default is required for every mount, even the plain-user ones
  // that don't otherwise care about devices. Default: no devices -> zero
  // renewals, so it never contributes a badge unless a test says so.
  // getMyDevices feeds the outstanding-task badge; probeEnabled is the
  // DEVICE_MGMT_ENABLED reachability probe that useDeviceManagementEnabled
  // (UserDevicesModal.jsx) runs -- Layout now consults it to gate the
  // Enrollment and Devices nav items. Default it to ENABLED so the existing
  // nav-visibility tests (which predate this gate and assume the feature is
  // on) keep asserting the same thing; the feature-off describe block below
  // overrides it to { enabled: false }.
  deviceManagementAPI: {
    getMyDevices: vi.fn().mockResolvedValue({ data: { devices: [] } }),
    probeEnabled: vi.fn().mockResolvedValue({ enabled: true })
  },
  // The version-display mount effect (Layout.jsx) always calls this; a
  // bare `vi.fn()` with no resolved value returns `undefined`, and
  // `undefined.then` throws, so every test in this file needs a
  // resolvable default even though most don't care about the version.
  versionAPI: { get: vi.fn().mockResolvedValue({ data: { version: '2026.9.0' } }) }
}))

// Vitest compiles this JSX with esbuild's classic transform, and Layout.jsx
// carries no React import of its own.
globalThis.React = React

const GLOBAL_MANAGER = { userId: 1, isAdmin: true, is_global_manager: true }
const TEAM_ADMIN = { userId: 7, isAdmin: true, isTeamAdmin: true, is_global_manager: false }

// Bugfix (mobile-usability follow-up, twice regressed): the top bar's
// desktop-right-alignment depends on the invisible "TAK Team Manager"
// placeholder `<h1>` actually PARTICIPATING in the `justify-between` flex
// row at `lg:` and up. Tailwind's `hidden` sets `display: none` and stays
// in effect at every breakpoint unless a later, more specific responsive
// class overrides `display` itself -- `lg:invisible` alone does NOT do
// that (`invisible` only ever sets `visibility`), so `hidden lg:invisible`
// left the element permanently out of layout, and `justify-between` had
// only one visible child to position, packing it to the START (left)
// instead of the end. jsdom applies no real CSS, so this cannot be caught
// by a rendered-position assertion; it is pinned here as a structural
// class-list check instead, so a future edit that drops `lg:block` again
// fails immediately rather than silently reintroducing this exact defect.
describe('Layout top-bar desktop alignment (bugfix, regressed twice)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {}
      })
    }
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    delete window.matchMedia
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  it('the invisible app-name placeholder carries both a `hidden` (mobile) AND an `lg:block` (desktop) display class, not `hidden` alone', async () => {
    // A plain (non-admin) user, so the pending-count effect's `if
    // (!user?.isAdmin && !user?.is_global_manager) return` bails out
    // immediately -- no fetch mocking needed for this structural check.
    const PLAIN_USER = { userId: 99, isAdmin: false, isTeamAdmin: false, is_global_manager: false }
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/dashboard']}>
          <ThemeProvider>
            <Layout user={PLAIN_USER}>
              <div />
            </Layout>
          </ThemeProvider>
        </MemoryRouter>
      )
    })

    const placeholder = Array.from(container.querySelectorAll('h1')).find(
      (h1) => h1.textContent === 'TAK Team Manager'
    )
    expect(placeholder).toBeTruthy()
    const classes = placeholder.className.split(/\s+/)

    expect(classes).toContain('hidden')
    // The exact regression: `hidden` with no responsive `display` override
    // (a bare `lg:invisible` does not supply one) leaves the element
    // display:none at every breakpoint, including lg: and up.
    expect(classes).toContain('lg:block')
    expect(classes).toContain('lg:invisible')
  })
})

describe('Layout "Tasks" nav badge (bugfix: pending-requests-badge; renamed by cert-expiry-notifications)', () => {
  let container
  let root
  let matchMediaStubbed = false

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    // clearAllMocks wipes the factory default, so re-establish the
    // now-always-called getMyDevices default (no devices -> zero renewals) and
    // a known expiry-warning threshold (module state shared across files).
    deviceManagementAPI.getMyDevices.mockResolvedValue({ data: { devices: [] } })
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: true })
    setExpiryWarningDays(DEFAULT_EXPIRY_WARNING_DAYS)
    container = document.createElement('div')
    document.body.appendChild(container)
    // jsdom implements no `window.matchMedia`; `ThemeProvider` reads it to
    // pick the initial theme when mounting.
    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {}
      })
      matchMediaStubbed = true
    }
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    if (matchMediaStubbed) {
      delete window.matchMedia
      matchMediaStubbed = false
    }
    localStorage.removeItem('theme')
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mount = async (user) => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/dashboard']}>
          <ThemeProvider>
            <Layout user={user}>
              <div />
            </Layout>
          </ThemeProvider>
        </MemoryRouter>
      )
    })
    // Several microtask ticks for the mount effect's async fetchPendingCount
    // (which itself awaits Promise.allSettled over one or two API calls) to
    // resolve and flush its setState before assertions.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const requestsBadgeText = () => {
    // The nav item's own text ("Tasks") trails the badge's digits in
    // the DOM (the badge span is nested inside the icon's wrapper, which
    // sits before the visible label text), so a link's textContent reads
    // e.g. "3Tasks" when a badge is present -- matched on `endsWith`
    // rather than `startsWith` for that reason. Both the mobile and
    // desktop copies of the sidebar render one each; they always agree,
    // so the first match is sufficient.
    const requestsLink = Array.from(container.querySelectorAll('a')).find(
      (a) => a.textContent.trim().endsWith('Tasks')
    )
    const badge = requestsLink?.querySelector('span.bg-red-600')
    return badge ? badge.textContent.trim() : null
  }

  it('sums access_requests and pending Org_Interest_Requests counts for a Global_Manager', async () => {
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [{ id: 1 }, { id: 2 }] } })
    adminAPI.getOrgInterest.mockResolvedValue({ data: { requests: [{ id: 10 }] } })

    await mount(GLOBAL_MANAGER)

    expect(adminAPI.getOrgInterest).toHaveBeenCalledWith({ status: 'pending' })
    expect(requestsBadgeText()).toBe('3')
  })

  it('never calls adminAPI.getOrgInterest for a non-Global_Manager admin, and reads only the access_requests count', async () => {
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [{ id: 1 }] } })

    await mount(TEAM_ADMIN)

    expect(adminAPI.getOrgInterest).not.toHaveBeenCalled()
    expect(requestsBadgeText()).toBe('1')
  })

  it('shows no badge when both counts are zero', async () => {
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [] } })
    adminAPI.getOrgInterest.mockResolvedValue({ data: { requests: [] } })

    await mount(GLOBAL_MANAGER)

    expect(requestsBadgeText()).toBeNull()
  })

  it('falls back to the access_requests count alone when the Org_Interest fetch itself fails (Promise.allSettled, not Promise.all)', async () => {
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [{ id: 1 }, { id: 2 }] } })
    adminAPI.getOrgInterest.mockRejectedValue(new Error('403 Forbidden'))

    await mount(GLOBAL_MANAGER)

    // A rejected org-interest fetch must not blank out the access_requests
    // count the caller DOES have permission for.
    expect(requestsBadgeText()).toBe('2')
  })

  it('falls back to the Org_Interest count alone when the access_requests fetch fails', async () => {
    requestsAPI.getPending.mockRejectedValue(new Error('network error'))
    adminAPI.getOrgInterest.mockResolvedValue({ data: { requests: [{ id: 10 }] } })

    await mount(GLOBAL_MANAGER)

    expect(requestsBadgeText()).toBe('1')
  })
})

/**
 * cert-expiry-notifications Requirements 7.2, 7.7: the /tasks nav item is
 * now visible to every authenticated user, but the badge-count fetch
 * keeps its own, now-corrected gate (isAdmin/isTeamAdmin/is_global_manager,
 * not just the first and last of those three, which were aliases of the
 * same underlying flag).
 */
describe('Layout "Tasks" nav item visibility and badge-fetch gating (cert-expiry-notifications 7.2, 7.7)', () => {
  let container
  let root
  let matchMediaStubbed = false

  const PLAIN_USER = { userId: 99, isAdmin: false, isTeamAdmin: false, is_global_manager: false }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    // clearAllMocks wipes the factory default, so re-establish the
    // now-always-called getMyDevices default (no devices -> zero renewals) and
    // a known expiry-warning threshold (module state shared across files).
    deviceManagementAPI.getMyDevices.mockResolvedValue({ data: { devices: [] } })
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: true })
    setExpiryWarningDays(DEFAULT_EXPIRY_WARNING_DAYS)
    container = document.createElement('div')
    document.body.appendChild(container)
    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {}
      })
      matchMediaStubbed = true
    }
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    if (matchMediaStubbed) {
      delete window.matchMedia
      matchMediaStubbed = false
    }
    localStorage.removeItem('theme')
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mount = async (user) => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/dashboard']}>
          <ThemeProvider>
            <Layout user={user}>
              <div />
            </Layout>
          </ThemeProvider>
        </MemoryRouter>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const tasksNavLink = () =>
    Array.from(container.querySelectorAll('a')).find((a) => a.textContent.trim().endsWith('Tasks'))

  it('renders the Tasks nav item for a plain, non-admin user (Requirement 7.2)', async () => {
    await mount(PLAIN_USER)

    expect(tasksNavLink()).not.toBeUndefined()
    expect(tasksNavLink().getAttribute('href')).toBe('/tasks')
  })

  it('a plain, non-admin user\'s mount issues no requestsAPI.getPending/adminAPI.getOrgInterest call (Requirement 7.7)', async () => {
    await mount(PLAIN_USER)

    expect(requestsAPI.getPending).not.toHaveBeenCalled()
    expect(adminAPI.getOrgInterest).not.toHaveBeenCalled()
  })

  it('a plain Team_Admin (isTeamAdmin only, no isAdmin/is_global_manager) STILL fetches the badge count', async () => {
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [{ id: 1 }] } })

    await mount(TEAM_ADMIN)

    expect(requestsAPI.getPending).toHaveBeenCalledTimes(1)
  })

  it('a Global_Manager still gets both the nav item and the badge fetch', async () => {
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [] } })
    adminAPI.getOrgInterest.mockResolvedValue({ data: { requests: [] } })

    await mount(GLOBAL_MANAGER)

    expect(tasksNavLink()).not.toBeUndefined()
    expect(requestsAPI.getPending).toHaveBeenCalledTimes(1)
  })
})

/**
 * Bugfix: the Users/Devices nav gate used to check only
 * isAdmin/is_global_manager (Global_Manager), so a plain Team_Admin --
 * who IS authorized server-side for both GET /api/users*
 * ('user:read:team_admin') and GET /api/devices ('device:read:org') via
 * a resolver that accepts any direct Team_Admin, not just a
 * Global_Manager -- had no way to reach either page from the nav.
 */
describe('Layout "Users"/"Devices" nav item visibility (bugfix: Team_Admin was missing both)', () => {
  let container
  let root
  let matchMediaStubbed = false

  const PLAIN_USER = { userId: 99, isAdmin: false, isTeamAdmin: false, is_global_manager: false }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [] } })
    adminAPI.getOrgInterest.mockResolvedValue({ data: { requests: [] } })
    deviceManagementAPI.getMyDevices.mockResolvedValue({ data: { devices: [] } })
    // Default: device management ON, so the pre-existing Devices-visible
    // assertions in this block hold. clearAllMocks wiped the factory default.
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {}
      })
      matchMediaStubbed = true
    }
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    if (matchMediaStubbed) {
      delete window.matchMedia
      matchMediaStubbed = false
    }
    localStorage.removeItem('theme')
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mount = async (user) => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/dashboard']}>
          <ThemeProvider>
            <Layout user={user}>
              <div />
            </Layout>
          </ThemeProvider>
        </MemoryRouter>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const navLink = (label) =>
    Array.from(container.querySelectorAll('a')).find((a) => a.textContent.trim().endsWith(label))

  it('shows neither Users nor Devices for a plain, non-admin user', async () => {
    await mount(PLAIN_USER)

    expect(navLink('Users')).toBeUndefined()
    expect(navLink('Devices')).toBeUndefined()
  })

  it('shows both Users and Devices for a plain Team_Admin (isTeamAdmin only, no isAdmin/is_global_manager)', async () => {
    await mount(TEAM_ADMIN)

    expect(navLink('Users')?.getAttribute('href')).toBe('/users')
    expect(navLink('Devices')?.getAttribute('href')).toBe('/devices')
  })

  it('shows both Users and Devices for a Global_Manager', async () => {
    await mount(GLOBAL_MANAGER)

    expect(navLink('Users')?.getAttribute('href')).toBe('/users')
    expect(navLink('Devices')?.getAttribute('href')).toBe('/devices')
  })
})

/**
 * DEVICE_MGMT_ENABLED nav gating: the Enrollment nav item (every signed-in
 * user) and the Devices nav item (admins) are hidden when the device-mgmt
 * reachability probe (deviceManagementAPI.probeEnabled, via
 * useDeviceManagementEnabled) reports the feature OFF -- so a deployment
 * without TAK Server device management shows no dead menu items whose pages
 * can only error. When ON, both appear as before.
 */
describe('Layout Enrollment/Devices nav gating on the DEVICE_MGMT_ENABLED probe', () => {
  let container
  let root
  let matchMediaStubbed = false

  const PLAIN_USER = { userId: 99, isAdmin: false, isTeamAdmin: false, is_global_manager: false }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [] } })
    adminAPI.getOrgInterest.mockResolvedValue({ data: { requests: [] } })
    deviceManagementAPI.getMyDevices.mockResolvedValue({ data: { devices: [] } })
    container = document.createElement('div')
    document.body.appendChild(container)
    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {}
      })
      matchMediaStubbed = true
    }
  })

  afterEach(async () => {
    if (root) {
      await act(async () => { root.unmount() })
      root = null
    }
    container.remove()
    if (matchMediaStubbed) {
      delete window.matchMedia
      matchMediaStubbed = false
    }
    localStorage.removeItem('theme')
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mount = async (user) => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/dashboard']}>
          <ThemeProvider>
            <Layout user={user}>
              <div />
            </Layout>
          </ThemeProvider>
        </MemoryRouter>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const navLink = (label) =>
    Array.from(container.querySelectorAll('a')).find((a) => a.textContent.trim().endsWith(label))

  it('HIDES Enrollment (and Devices) when the probe reports the feature OFF', async () => {
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: false })

    await mount(GLOBAL_MANAGER)

    expect(navLink('Enrollment')).toBeUndefined()
    expect(navLink('Devices')).toBeUndefined()
    // Downloads (ungated) is still there, proving nav rendered fine.
    expect(navLink('Downloads')?.getAttribute('href')).toBe('/downloads')
  })

  it('HIDES Enrollment for a plain user when the feature is OFF', async () => {
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: false })

    await mount(PLAIN_USER)

    expect(navLink('Enrollment')).toBeUndefined()
    // Downloads still present for a plain user.
    expect(navLink('Downloads')?.getAttribute('href')).toBe('/downloads')
  })

  it('SHOWS Enrollment (and, for an admin, Devices) when the probe reports the feature ON', async () => {
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: true })

    await mount(GLOBAL_MANAGER)

    expect(navLink('Enrollment')?.getAttribute('href')).toBe('/enrollment')
    expect(navLink('Devices')?.getAttribute('href')).toBe('/devices')
  })

  it('SHOWS Enrollment for a plain user when the feature is ON', async () => {
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: true })

    await mount(PLAIN_USER)

    expect(navLink('Enrollment')?.getAttribute('href')).toBe('/enrollment')
    // Still no Devices for a non-admin (role gate unchanged).
    expect(navLink('Devices')).toBeUndefined()
  })

  it('fails closed: HIDES Enrollment/Devices when the probe rejects', async () => {
    deviceManagementAPI.probeEnabled.mockRejectedValue(new Error('network'))

    await mount(GLOBAL_MANAGER)

    expect(navLink('Enrollment')).toBeUndefined()
    expect(navLink('Devices')).toBeUndefined()
  })
})

// Version display at the bottom of the left-hand nav, sourced from
// GET /api (server/routes/version.js).
describe('Layout version display', () => {
  let container
  let root
  let matchMediaStubbed = false

  const PLAIN_USER = { userId: 99, isAdmin: false, isTeamAdmin: false, is_global_manager: false }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    // clearAllMocks wipes the factory default, so re-establish the
    // now-always-called getMyDevices default (no devices -> zero renewals) and
    // a known expiry-warning threshold (module state shared across files).
    deviceManagementAPI.getMyDevices.mockResolvedValue({ data: { devices: [] } })
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: true })
    setExpiryWarningDays(DEFAULT_EXPIRY_WARNING_DAYS)
    container = document.createElement('div')
    document.body.appendChild(container)
    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {}
      })
      matchMediaStubbed = true
    }
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    if (matchMediaStubbed) {
      delete window.matchMedia
      matchMediaStubbed = false
    }
    localStorage.removeItem('theme')
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mount = async (user) => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/dashboard']}>
          <ThemeProvider>
            <Layout user={user}>
              <div />
            </Layout>
          </ThemeProvider>
        </MemoryRouter>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('shows the version returned by GET /api, centered, in both the desktop and mobile sidebar copies', async () => {
    versionAPI.get.mockResolvedValue({ data: { version: '2026.9.0' } })

    await mount(PLAIN_USER)

    const versionNodes = Array.from(container.querySelectorAll('div')).filter(
      (div) => div.textContent.trim() === 'Version 2026.9.0'
    )
    // One copy in the mobile drawer, one in the desktop sidebar.
    expect(versionNodes).toHaveLength(2)
    versionNodes.forEach((node) => {
      expect(node.className.split(/\s+/)).toContain('text-center')
    })
  })

  it('renders no version text at all when the version fetch fails', async () => {
    versionAPI.get.mockRejectedValue(new Error('network error'))

    await mount(PLAIN_USER)

    expect(container.textContent).not.toContain('Version 2026.9.0')
    expect(container.textContent).not.toMatch(/Version \d/)
  })
})

/**
 * Mobile notification bell: the sidebar (and its "Tasks" badge) is an
 * off-canvas drawer on a phone, invisible until opened, so the top row
 * carries a bell that surfaces the SAME outstanding-task count and links to
 * /tasks. Shown for EVERY user -- a plain member's count is their own
 * certificate renewals (deviceManagementAPI.getMyDevices, filtered to
 * imminent/expired), an admin's also includes pending requests. jsdom applies
 * no CSS, so the `lg:hidden`/`lg:flex` breakpoint split is not exercised here;
 * these assert presence, target, count, and the accessible name.
 */
describe('Layout mobile notification bell (links to /tasks, count for all users)', () => {
  let container
  let root
  let matchMediaStubbed = false

  const PLAIN_USER = { userId: 99, isAdmin: false, isTeamAdmin: false, is_global_manager: false }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    deviceManagementAPI.getMyDevices.mockResolvedValue({ data: { devices: [] } })
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: true })
    setExpiryWarningDays(DEFAULT_EXPIRY_WARNING_DAYS)
    container = document.createElement('div')
    document.body.appendChild(container)
    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {}
      })
      matchMediaStubbed = true
    }
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    if (matchMediaStubbed) {
      delete window.matchMedia
      matchMediaStubbed = false
    }
    localStorage.removeItem('theme')
    setExpiryWarningDays(DEFAULT_EXPIRY_WARNING_DAYS)
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mount = async (user) => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/dashboard']}>
          <ThemeProvider>
            <Layout user={user}>
              <div />
            </Layout>
          </ThemeProvider>
        </MemoryRouter>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  // The bell is the /tasks link whose accessible name starts with "Tasks"
  // (the nav item's own /tasks link has visible text "Tasks", so match the
  // bell by its aria-label + absence of the "Tasks" text node instead).
  const bellLink = () =>
    Array.from(container.querySelectorAll('a[href="/tasks"]')).find((a) =>
      (a.getAttribute('aria-label') || '').startsWith('Tasks')
    )

  const bellBadgeText = () => {
    const badge = bellLink()?.querySelector('span.bg-red-600')
    return badge ? badge.textContent.trim() : null
  }

  it('renders a bell linking to /tasks for a plain, non-admin user', async () => {
    await mount(PLAIN_USER)

    const bell = bellLink()
    expect(bell).not.toBeUndefined()
    expect(bell.getAttribute('href')).toBe('/tasks')
    // No outstanding tasks -> no badge, and the accessible name is the bare
    // "Tasks" (state carried in text, not colour).
    expect(bell.getAttribute('aria-label')).toBe('Tasks')
    expect(bellBadgeText()).toBeNull()
  })

  it("counts a plain member's OWN certificate renewals (no admin requests involved)", async () => {
    // Two of the member's devices are within the expiry window, one is fine.
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
    const expired = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const fine = new Date(Date.now() + 500 * 24 * 60 * 60 * 1000).toISOString()
    deviceManagementAPI.getMyDevices.mockResolvedValue({
      data: {
        devices: [
          { clientUid: 'a', expiresAt: soon, clientType: 'android' },
          { clientUid: 'b', expiresAt: expired, clientType: 'ios' },
          { clientUid: 'c', expiresAt: fine, clientType: 'windows' }
        ]
      }
    })

    await mount(PLAIN_USER)

    expect(bellBadgeText()).toBe('2')
    expect(bellLink().getAttribute('aria-label')).toBe('Tasks, 2 outstanding')
    // A plain member never triggers the admin request fetches.
    expect(requestsAPI.getPending).not.toHaveBeenCalled()
    expect(adminAPI.getOrgInterest).not.toHaveBeenCalled()
  })

  it("sums an admin's pending requests AND their own renewals into one count", async () => {
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [{ id: 1 }, { id: 2 }] } })
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
    deviceManagementAPI.getMyDevices.mockResolvedValue({
      data: { devices: [{ clientUid: 'a', expiresAt: soon, clientType: 'android' }] }
    })

    await mount(TEAM_ADMIN)

    // 2 requests + 1 own renewal.
    expect(bellBadgeText()).toBe('3')
  })

  it('treats a 404 from getMyDevices (device management off) as zero renewals, not an error', async () => {
    deviceManagementAPI.getMyDevices.mockRejectedValue({ response: { status: 404 } })

    await mount(PLAIN_USER)

    // Bell still renders, just with no badge.
    expect(bellLink()).not.toBeUndefined()
    expect(bellBadgeText()).toBeNull()
  })
})
