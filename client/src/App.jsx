import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { authAPI, configAPI } from './services/api'
import { isPublicOnlyPath } from './utils/publicPaths'
import { recordAutoLoginAttemptAndCheckLoop, clearAutoLoginAttempts } from './utils/autoLoginGuard'
import { consumeReturnPath } from './utils/returnPath'
import { setDisplayTimezone, setDisplayLocale } from './utils/dateFormat'
import { setExpiryWarningDays } from './utils/expiryWarning'
import { ThemeProvider } from './contexts/ThemeContext'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Teams from './pages/Teams'
import TeamDetail from './pages/TeamDetail'
import Users from './pages/Users'
import Devices from './pages/Devices'
import Requests from './pages/Requests'
import RequestAccess from './pages/RequestAccess'
import GlobalChannels from './pages/GlobalChannels'
import Login from './pages/Login'
import Admin from './pages/Admin'
import AuditLogs from './pages/AuditLogs'
import EnrollmentView from './pages/EnrollmentView'
import DeviceMgmtGate from './components/DeviceMgmtGate'
import Downloads from './pages/Downloads'

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  const refreshUser = async () => {
    try {
      const response = await authAPI.getProfile()
      setUser(response.data.user)
    } catch (error) {
      console.error('Failed to refresh user:', error)
    }
  }

  useEffect(() => {
    // Install the operator-configured presentation values -- the display
    // timezone and display locale (Requirements 18.7, 18.11; the locale is
    // consulted only for the short timezone abbreviation `formatDateTime`
    // appends) and the certificate-expiry warning threshold (Requirement
    // 21.7). All are Presentation_Config
    // keys on the same public-config response, both are installed as module
    // state that no React render depends on, and both have to be in force
    // before the first row of any surface renders, so they are installed
    // together here rather than each from whichever page happened to read
    // the config first. (The threshold previously rode along with
    // `Dashboard.jsx`'s own public-config read, which meant a client
    // landing directly on `/users` -- never mounting the Dashboard --
    // classified expiry at the 30-day default.)
    //
    // This fetch is issued FIRST and unconditionally -- ahead of the
    // public-only early return and ahead of the session check -- for two
    // reasons:
    //
    //  * It has to run regardless of session state. The OTHER
    //    `configAPI.getPublic()` call in this effect sits inside the
    //    `authAPI.getProfile()` REJECTION branch (the unauthenticated
    //    auto-login path, where it reads `authentik_origin`), so a user
    //    with a valid session never reaches it. It cannot serve as an
    //    app-wide install point. The promise is shared with that branch
    //    below so the unauthenticated path still issues just one request.
    //  * `setDisplayTimezone` and `setExpiryWarningDays` mutate module
    //    variables in `utils/dateFormat.js` and `utils/expiryWarning.js`.
    //    React does not re-render anything because of that, so both values
    //    have to be in place BEFORE the first date or device row renders
    //    rather than corrected afterwards. Firing here puts the request in
    //    flight in the same tick as the `GET /auth/me` the startup gate
    //    below already waits on, so it resolves inside that gate -- while
    //    the only thing on screen is the spinner -- and the first date the
    //    interface renders is already in the configured zone.
    //
    // The gate is deliberately NOT chained onto this promise: a slow or
    // unreachable public config must not hold the interface back. A
    // failure is swallowed, and each installer's own handling of an
    // unusable value leaves the documented default in force
    // (`Pacific/Auckland`, 30 days), so a client that never received the
    // config behaves exactly like one that received the defaults
    // (Requirements 18.7, 21.7).
    const publicConfig = configAPI.getPublic()
    publicConfig
      .then((response) => {
        setDisplayTimezone(response.data?.display_timezone)
        setDisplayLocale(response.data?.display_locale)
        setExpiryWarningDays(response.data?.device_expiry_warning_days)
      })
      .catch(() => {
        // Unreachable config: the Pacific/Auckland and 30-day defaults stand.
      })

    // /request-access must be fully usable by a completely anonymous
    // visitor with no session cookie. Skip the authenticated GET /auth/me
    // check entirely on this path -- calling it here would 401 for every
    // anonymous visitor, and that 401 (via services/api.js's response
    // interceptor) used to force-navigate to /login, which re-mounts this
    // same effect and 401s again, producing an endless redirect loop
    // instead of ever rendering the public page.
    if (isPublicOnlyPath(window.location.pathname)) {
      setLoading(false)
      return
    }

    // Session state now lives exclusively in an httpOnly `tak_session` cookie
    // set by the server (see server/routes/auth.js getSessionCookieOptions()).
    // The client never receives a `?token=` URL param or stores a token in
    // localStorage, so we check for an existing session directly instead of
    // gating on that dead condition. The cookie is sent automatically by the
    // axios instance's `withCredentials: true`.
    // Fire an auto-login redirect, but only if we are not already caught in
    // a redirect loop. `recordAutoLoginAttemptAndCheckLoop` counts recent
    // auto-login attempts in sessionStorage; once too many fire in too short
    // a window (the signature of a loop where no session cookie ever sticks),
    // it returns true and we render the manual Login page instead of firing
    // yet another redirect. This is the loop breaker for the variant that
    // carries no `?error=` -- e.g. FORCE_SSO_LOGIN re-firing on every
    // unauthenticated load when the round-trip never establishes a session.
    const autoLoginOrBreakLoop = () => {
      if (recordAutoLoginAttemptAndCheckLoop()) {
        setLoading(false)
        return
      }
      authAPI.login()
    }

    authAPI.getProfile()
      .then((response) => {
        // A session was established -- reset the loop counter so a later,
        // unrelated logout->login does not start part-way to the threshold.
        clearAutoLoginAttempts()
        // Post-login return path: if the user was sent to login from a deep
        // link (e.g. the Downloads QR opens /downloads, which auto-logins),
        // the server callback landed them on its fixed /dashboard. Send them
        // on to where they were actually headed. consumeReturnPath reads and
        // clears the stored path and returns null when there's nothing to do
        // (or the stored value isn't a safe in-app destination), so a normal
        // login stays on /dashboard. `replace` keeps the intermediate
        // /dashboard out of history so Back doesn't bounce there.
        const returnPath = consumeReturnPath()
        if (returnPath) {
          navigate(returnPath, { replace: true })
        }
        setUser(response.data.user)
        setLoading(false)
      })
      .catch(() => {
        // No existing session. Fall back to auto-login if coming from
        // Authentik or via the auto_login parameter. The Authentik origin is
        // read from the server-provided public config (sourced from
        // AUTHENTIK_URL) instead of a hardcoded hostname.
        const urlParams = new URLSearchParams(window.location.search)
        const referrer = document.referrer
        const autoLogin = urlParams.get('auto_login')

        // Loop-guard: if we've landed back here carrying an `?error=` (the
        // OAuth2 callback redirects to `${FRONTEND_URL}?error=...` on any
        // token-exchange/userinfo failure -- see server/routes/auth.js), we
        // must NOT auto-fire another `authAPI.login()`. Doing so bounces
        // straight back to Authentik, which returns the same error, which
        // lands here again -- an infinite redirect loop. Every hop is a
        // request against the per-IP `/api/auth/*` limiter (20 / 15 min,
        // server/middleware/rateLimiters.js), so the loop silently burns the
        // whole budget in seconds and every subsequent request from that IP
        // -- including a fresh browser/incognito window, since the limiter is
        // keyed on IP, not cookies -- gets a 429 for the rest of the window.
        // Instead, stop and render the Login page, which can surface the
        // error and offer a manual "Sign in" the user controls the timing of.
        // This applies regardless of auto_login / referrer / force_sso_login:
        // an error return outranks every auto-login trigger.
        if (urlParams.get('error')) {
          setLoading(false)
          return
        }

        if (autoLogin === 'true') {
          autoLoginOrBreakLoop()
          return
        }

        // The same in-flight request the timezone install above started --
        // reused rather than re-issued so the mount makes one
        // `GET /config/public` call, not two.
        publicConfig
          .then((response) => {
            const authentikOrigin = response.data?.authentik_origin
            if (referrer && authentikOrigin && referrer.startsWith(authentikOrigin)) {
              // User came from Authentik, automatically start OAuth flow
              autoLoginOrBreakLoop()
              return
            }
            // FORCE_SSO_LOGIN (server/config/forceSso.js): skip the manual
            // "Sign in" click entirely and start the OAuth2 redirect right
            // away. Checked only once the Authentik-referrer branch above
            // has already had its chance -- both ultimately call the same
            // `authAPI.login()`, so the order between them makes no
            // behavioural difference, but keeping the more specific
            // referrer-based reason first matches its existing precedence
            // over the blanket flag.
            if (response.data?.force_sso_login) {
              autoLoginOrBreakLoop()
              return
            }
            setLoading(false)
          })
          .catch(() => setLoading(false))
      })
    // `navigate` (from useNavigate) is stable across renders, so listing it
    // does not cause this mount-only effect to re-run; it satisfies
    // exhaustive-deps for the post-login return-path navigation above.
  }, [navigate])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    )
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/request-access" element={<RequestAccess />} />
        <Route path="*" element={<Login />} />
      </Routes>
    )
  }

  return (
    <ThemeProvider>
      <Layout user={user}>
        <Routes>
          <Route path="/" element={<Dashboard user={user} />} />
          <Route path="/dashboard" element={<Dashboard user={user} />} />
          <Route path="/teams" element={<Teams user={user} />} />
          <Route path="/teams/:teamId" element={<TeamDetail user={user} refreshUser={refreshUser} />} />
          <Route path="/users" element={<Users user={user} />} />
          {/* /devices and /enrollment are gated on the DEVICE_MGMT_ENABLED
              probe: both surfaces depend on TAK Server being configured, so a
              device-management-off deployment renders a clean "not available"
              panel instead of the raw TAK_SERVER_ENROLLMENT_URL error. The nav
              already hides these entries when off (Layout.jsx), but a direct
              URL -- a bookmark, or the Downloads QR that lands on /downloads
              then here -- must be handled at the route too. */}
          <Route path="/devices" element={<DeviceMgmtGate><Devices user={user} /></DeviceMgmtGate>} />
          {/* cert-expiry-notifications Requirement 7.1: renamed from
              /requests to /tasks (the page now also lists certificate
              renewals, not just access requests). /requests stays
              reachable as a redirect rather than a broken link for any
              existing bookmark/link. */}
          <Route path="/tasks" element={<Requests user={user} />} />
          <Route path="/requests" element={<Navigate to="/tasks" replace />} />
          <Route path="/global-channels" element={<GlobalChannels user={user} />} />
          <Route path="/admin" element={<Admin user={user} />} />
          <Route path="/audit-logs" element={<AuditLogs user={user} />} />
          <Route path="/enrollment" element={<DeviceMgmtGate><EnrollmentView /></DeviceMgmtGate>} />
          <Route path="/downloads" element={<Downloads />} />
          {/* Catch-all: an unknown path would otherwise render the Layout
              with no page content at all (an empty shell with just the
              nav). Redirect to the Dashboard instead. `replace` keeps the
              bad URL out of history, so Back doesn't return to it. */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Layout>
    </ThemeProvider>
  )
}

export default App