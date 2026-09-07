import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import App from './App.jsx'
import { authAPI, configAPI, requestsAPI, versionAPI } from './services/api'
import {
  getDisplayTimezone,
  setDisplayTimezone,
  DEFAULT_DISPLAY_TIMEZONE
} from './utils/dateFormat'
import {
  getExpiryWarningDays,
  setExpiryWarningDays,
  DEFAULT_EXPIRY_WARNING_DAYS
} from './utils/expiryWarning'

// Validates: Requirements 18.7, 18.11 (and Requirement 21.7's install point)
//
// `App.jsx` is the app-wide install point for the Presentation_Config values
// that are module state rather than React state -- the Display_Timezone and
// the Expiry_Warning_Days threshold. Two claims are asserted here and
// deliberately nothing else about the tree:
//
//   1. a RESOLVED public config installs the configured zone (18.7), and
//   2. a REJECTED one still renders the interface, with the documented
//      defaults left in force (18.7, 18.11).
//
// The install is fire-and-forget by design: the startup `loading` gate is NOT
// chained onto the public-config promise, because a slow or unreachable
// config must not hold the interface back (18.11). So these tests await the
// microtask queue after render rather than asserting synchronously -- an
// assertion made immediately after `act(render)` would be racing the very
// promise chain the requirement says not to wait on.
//
// This project has no `@testing-library/react` (absent from
// `client/package.json` and from `client/node_modules`) and no dependency is
// added here, so `App` is mounted with `react-dom/client`'s `createRoot` plus
// React 18's own `act` under the `jsdom` environment already configured in
// `vite.config.js` -- the pattern established by
// `src/components/TransferMemberDialog.test.jsx` and `src/pages/Requests.test.jsx`.
//
// NOTE, found while writing these tests and deliberately NOT asserted here.
// The never-settles case is asserted for a SIGNED-IN session only. On the
// no-session path the gate's `setLoading(false)` hangs off the same
// public-config promise (it is the branch that reads `authentik_origin` to
// decide on auto-login), so a `/api/config/public` that never settles leaves
// an anonymous visitor on the spinner. That coupling predates the timezone
// install -- the branch always consumed a public-config response, it just
// used to issue its own -- and a REJECTED config still renders, which is the
// realistic failure and is asserted below. Tightening it would be a change to
// `App.jsx`'s auth flow rather than to this feature's install point, so it is
// recorded here rather than fixed under a test task.
//
// `authAPI.getProfile` is left REJECTING throughout. That is not a shortcut:
// it keeps the mounted tree down to the `Login` route instead of the whole
// authenticated router (every page, every fetch), while still exercising the
// exact code path under test -- the mount effect runs identically either way,
// and the auth-rejection branch is also where the SHARED public-config
// promise is consumed, which is what makes the one-request assertion
// meaningful.

vi.mock('./services/api', () => ({
  authAPI: { getProfile: vi.fn(), login: vi.fn(), logout: vi.fn() },
  configAPI: { getPublic: vi.fn() },
  // `Login.jsx` and the rest of the router's module graph import these. A
  // named import of a missing export from a mocked ES module is a load-time
  // failure, so every one any imported module names is present.
  teamsAPI: {},
  // Layout.jsx reads the pending-request count for its nav badge on mount.
  requestsAPI: { getPending: vi.fn() },
  // Layout.jsx also fetches the running version for its nav footer on mount.
  versionAPI: { get: vi.fn().mockResolvedValue({ data: { version: '2026.9.0' } }) },
  usersAPI: {},
  channelsAPI: {},
  syncAPI: {},
  bulkImportAPI: {},
  communicationsAPI: {},
  settingsAPI: {},
  globalChannelsAPI: {},
  auditLogsAPI: {},
  signupAPI: {},
  signupCodesAPI: {},
  orgDomainsAPI: {},
  adminAPI: { getOrgInterest: vi.fn().mockResolvedValue({ data: { requests: [] } }) },
  // Layout.jsx's outstanding-task-count effect calls this for EVERY user
  // (own certificate renewals feed the nav badge), so it needs a resolvable
  // default here or the mount effect rejects unhandled. No devices -> zero.
  deviceManagementAPI: { getMyDevices: vi.fn().mockResolvedValue({ data: { devices: [] } }) },
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null
}))

// See the note in RevokeDeviceDialog.test.jsx: vitest compiles this JSX with
// esbuild's classic transform, so the component sources (which have no
// `React` import of their own) need one in scope.
globalThis.React = React

describe('App startup installs the presentation config (Requirements 18.7, 18.11)', () => {
  let container
  let root
  let matchMediaStubbed = false

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    // jsdom implements no `window.matchMedia`; `Login` renders inside
    // `ThemeProvider`, which reads it to pick the initial theme.
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
    // No session: the mount lands on the Login route. See the header note.
    authAPI.getProfile.mockRejectedValue(new Error('no session'))
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [] } })
    // A couple of tests below override authAPI.getProfile to resolve
    // (mounting Layout.jsx instead of Login), which calls this too.
    versionAPI.get.mockResolvedValue({ data: { version: '2026.9.0' } })
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
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    // Both installs are module state shared across this file's tests.
    setDisplayTimezone(DEFAULT_DISPLAY_TIMEZONE)
    setExpiryWarningDays(DEFAULT_EXPIRY_WARNING_DAYS)
  })

  const mountApp = async (path = '/') => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      )
    })
    // The install is deliberately not gated on (Requirement 18.11), so let
    // the fire-and-forget promise chain settle before asserting.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('installs the configured display timezone from a resolved public config', async () => {
    configAPI.getPublic.mockResolvedValue({
      data: { display_timezone: 'America/Los_Angeles', authentik_origin: 'https://auth.example.test' }
    })

    // Start from the default, so the assertion below is about the install
    // having happened rather than about a value that was already in place.
    setDisplayTimezone(DEFAULT_DISPLAY_TIMEZONE)
    expect(getDisplayTimezone()).toBe(DEFAULT_DISPLAY_TIMEZONE)

    await mountApp()

    expect(getDisplayTimezone()).toBe('America/Los_Angeles')
  })

  it('installs the sibling expiry-warning threshold from the same response', async () => {
    // Requirement 21.7's value is installed here, beside the zone, rather
    // than from the Dashboard's own public-config read -- so a client that
    // lands directly on /users and never mounts the Dashboard still
    // classifies against the operator's threshold.
    configAPI.getPublic.mockResolvedValue({
      data: { display_timezone: 'Pacific/Chatham', device_expiry_warning_days: 45 }
    })

    await mountApp()

    expect(getDisplayTimezone()).toBe('Pacific/Chatham')
    expect(getExpiryWarningDays()).toBe(45)
  })

  it('leaves the Pacific/Auckland default in force when the response omits the key', async () => {
    configAPI.getPublic.mockResolvedValue({ data: {} })

    await mountApp()

    expect(getDisplayTimezone()).toBe(DEFAULT_DISPLAY_TIMEZONE)
    expect(getExpiryWarningDays()).toBe(DEFAULT_EXPIRY_WARNING_DAYS)
  })

  it('still renders the interface when the public config is rejected', async () => {
    configAPI.getPublic.mockRejectedValue(new Error('config unreachable'))

    await mountApp()

    // Requirement 18.11: the startup gate is not chained onto the config
    // fetch, so the interface is past the spinner and rendered.
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(container.textContent).toContain('TAK Team Manager')
    expect(container.querySelector('button')).not.toBeNull()

    // Requirement 18.7: a client that never received the config behaves
    // exactly like one that received the defaults.
    expect(getDisplayTimezone()).toBe(DEFAULT_DISPLAY_TIMEZONE)
    expect(getExpiryWarningDays()).toBe(DEFAULT_EXPIRY_WARNING_DAYS)
  })

  it('renders a signed-in session even while the public config never settles', async () => {
    // Requirement 18.11 at its strongest: the startup gate is resolved by the
    // session check alone, so a config fetch that never settles at all does
    // not hold the interface back -- the interface renders with the
    // Criterion 18.7 default in force.
    //
    // Mounted at /audit-logs with a non-Global_Manager, which renders the
    // page's own not-authorized guard and issues no fetch of its own
    // (`AuditLogs.jsx` guards every effect on `is_global_manager`). That
    // keeps the assertion about the gate rather than about a page's data.
    authAPI.getProfile.mockResolvedValue({
      data: { user: { id: 7, email: 'ada@example.com', is_global_manager: false } }
    })
    configAPI.getPublic.mockReturnValue(new Promise(() => {}))

    await mountApp('/audit-logs')

    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(container.textContent).toContain('Access Denied')
    expect(getDisplayTimezone()).toBe(DEFAULT_DISPLAY_TIMEZONE)
    expect(getExpiryWarningDays()).toBe(DEFAULT_EXPIRY_WARNING_DAYS)
  })

  it('fetches the public config exactly once per mount', async () => {
    // The auth-rejection branch reads `authentik_origin` from the SAME
    // in-flight promise the install started, rather than issuing a second
    // request.
    configAPI.getPublic.mockResolvedValue({
      data: { display_timezone: 'Asia/Kolkata', authentik_origin: 'https://auth.example.test' }
    })

    await mountApp()

    expect(configAPI.getPublic).toHaveBeenCalledTimes(1)
  })
})

// force_sso_login (server/config/forceSso.js): an unauthenticated visitor
// with no Authentik-origin referrer is sent straight into the OAuth2
// redirect when the public config carries `force_sso_login: true`, rather
// than landing on the Login page and waiting for a manual "Sign in" click.
describe('App startup honours force_sso_login from the public config', () => {
  let container
  let root
  let matchMediaStubbed = false

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
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
    authAPI.getProfile.mockRejectedValue(new Error('no session'))
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
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mountApp = async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('calls authAPI.login() automatically when force_sso_login is true and there is no Authentik referrer', async () => {
    configAPI.getPublic.mockResolvedValue({ data: { force_sso_login: true } })

    await mountApp()

    expect(authAPI.login).toHaveBeenCalledTimes(1)
  })

  it('does not call authAPI.login() when force_sso_login is false, leaving the manual Login page in place', async () => {
    configAPI.getPublic.mockResolvedValue({ data: { force_sso_login: false } })

    await mountApp()

    expect(authAPI.login).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Sign in')
  })

  it('does not call authAPI.login() when force_sso_login is absent from the response', async () => {
    configAPI.getPublic.mockResolvedValue({ data: {} })

    await mountApp()

    expect(authAPI.login).not.toHaveBeenCalled()
  })

  it('defers to the more specific Authentik-referrer auto-login check, without calling login() twice', async () => {
    Object.defineProperty(document, 'referrer', {
      value: 'https://auth.example.test/some/path',
      configurable: true
    })
    configAPI.getPublic.mockResolvedValue({
      data: { authentik_origin: 'https://auth.example.test', force_sso_login: true }
    })

    await mountApp()

    expect(authAPI.login).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'referrer', { value: '', configurable: true })
  })
})

// Loop-guard: an unauthenticated mount that lands carrying an `?error=` in
// the URL (the OAuth2 callback redirects to `${FRONTEND_URL}?error=...` on any
// token-exchange/userinfo failure -- server/routes/auth.js) must NOT auto-fire
// `authAPI.login()`. Re-firing bounces back to Authentik, which returns the
// same error, which lands here again -- an infinite redirect loop, and every
// hop is a request against the per-IP `/api/auth/*` limiter (20/15min), so the
// loop burns the whole budget and every subsequent request from that IP --
// including a fresh incognito window -- gets a 429 for the rest of the window.
// The guard outranks EVERY auto-login trigger (auto_login, Authentik referrer,
// force_sso_login) and renders the Login page instead so the user controls the
// retry timing.
describe('App startup does not auto-login on an ?error= return (429 loop-guard)', () => {
  let container
  let root
  let matchMediaStubbed = false
  let originalSearch

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
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
    authAPI.getProfile.mockRejectedValue(new Error('no session'))
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [] } })
    versionAPI.get.mockResolvedValue({ data: { version: '2026.9.0' } })
    // The guard reads `window.location.search` directly (not React Router's
    // location), so drive it via jsdom's URL. Saved and restored per test so
    // one case's `?error=` does not leak into the next.
    originalSearch = window.location.search
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
    // Reset the URL search back to whatever it was, and clear any referrer a
    // test installed.
    window.history.replaceState({}, '', `${window.location.pathname}${originalSearch}`)
    Object.defineProperty(document, 'referrer', { value: '', configurable: true })
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mountAppWithSearch = async (search) => {
    window.history.replaceState({}, '', `/${search}`)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('does NOT auto-login when ?error= is present even with auto_login=true', async () => {
    configAPI.getPublic.mockResolvedValue({ data: {} })

    await mountAppWithSearch('?error=auth_failed&auto_login=true')

    expect(authAPI.login).not.toHaveBeenCalled()
    // Past the spinner, on the Login page.
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(container.textContent).toContain('Sign in')
  })

  it('does NOT auto-login when ?error= is present even with an Authentik-origin referrer', async () => {
    Object.defineProperty(document, 'referrer', {
      value: 'https://auth.example.test/some/path',
      configurable: true
    })
    configAPI.getPublic.mockResolvedValue({ data: { authentik_origin: 'https://auth.example.test' } })

    await mountAppWithSearch('?error=auth_failed')

    expect(authAPI.login).not.toHaveBeenCalled()
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(container.textContent).toContain('Sign in')
  })

  it('does NOT auto-login when ?error= is present even with force_sso_login: true', async () => {
    configAPI.getPublic.mockResolvedValue({ data: { force_sso_login: true } })

    await mountAppWithSearch('?error=auth_failed')

    expect(authAPI.login).not.toHaveBeenCalled()
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(container.textContent).toContain('Sign in')
  })

  it('still auto-logins on force_sso_login when there is no ?error= (guard is scoped to the error case)', async () => {
    configAPI.getPublic.mockResolvedValue({ data: { force_sso_login: true } })

    await mountAppWithSearch('')

    expect(authAPI.login).toHaveBeenCalledTimes(1)
  })
})

// cert-expiry-notifications Requirement 7.1: /requests stays reachable via a
// redirect to /tasks, rather than becoming a broken link, for any existing
// bookmark. Mounted the same way as the "renders a signed-in session"
// case above (a signed-in, non-Global_Manager session), since the redirect
// itself is unconditional and needs no particular role.
describe('cert-expiry-notifications: /requests redirects to /tasks (Requirement 7.1)', () => {
  let container
  let root
  let matchMediaStubbed = false

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
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
    authAPI.getProfile.mockResolvedValue({
      data: { user: { id: 7, email: 'ada@example.com', is_global_manager: false } }
    })
    configAPI.getPublic.mockResolvedValue({ data: {} })
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [] } })
    // vi.clearAllMocks() above also clears the module-level default this
    // mock was given at definition time -- re-set it here, since Layout.jsx
    // (mounted for this signed-in session) calls it on mount.
    versionAPI.get.mockResolvedValue({ data: { version: '2026.9.0' } })
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
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  it('navigating to /requests renders the Tasks page (via redirect), not a blank/unknown route', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/requests']}>
          <App />
        </MemoryRouter>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // The redirect lands on /tasks, which renders the Requests.jsx page
    // component (unchanged filename) -- observable here as the nav's
    // "Tasks" item being the active one, rather than the catch-all
    // Dashboard redirect a genuinely unknown path would hit.
    const activeLink = Array.from(container.querySelectorAll('a')).find((a) =>
      a.className.includes('bg-primary-100')
    )
    expect(activeLink?.textContent.trim()).toContain('Tasks')
  })
})
