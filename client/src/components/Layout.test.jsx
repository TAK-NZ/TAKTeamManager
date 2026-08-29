import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import Layout from './Layout.jsx'
import { ThemeProvider } from '../contexts/ThemeContext.jsx'
import { requestsAPI, adminAPI } from '../services/api'

// Bugfix (pending-requests-badge): the nav "Requests" badge used to count
// ONLY access_requests-backed requests (requestsAPI.getPending), leaving a
// Global_Manager with a pending Org_Interest_Request (a wholly separate
// `org_interest_requests` table, surfaced today only via the /requests
// page's own OrgInterestRequests panel) seeing no badge at all -- even
// though that same request was visibly listed on /requests. This file
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
  adminAPI: { getOrgInterest: vi.fn() }
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

describe('Layout "Requests" nav badge (bugfix: pending-requests-badge)', () => {
  let container
  let root
  let matchMediaStubbed = false

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
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
    // The nav item's own text ("Requests") trails the badge's digits in
    // the DOM (the badge span is nested inside the icon's wrapper, which
    // sits before the visible label text), so a link's textContent reads
    // e.g. "3Requests" when a badge is present -- matched on `endsWith`
    // rather than `startsWith` for that reason. Both the mobile and
    // desktop copies of the sidebar render one each; they always agree,
    // so the first match is sufficient.
    const requestsLink = Array.from(container.querySelectorAll('a')).find(
      (a) => a.textContent.trim().endsWith('Requests')
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
