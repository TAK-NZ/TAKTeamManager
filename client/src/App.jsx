import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { authAPI, configAPI } from './services/api'
import { isPublicOnlyPath } from './utils/publicPaths'
import { setDisplayTimezone } from './utils/dateFormat'
import { setExpiryWarningDays } from './utils/expiryWarning'
import { ThemeProvider } from './contexts/ThemeContext'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Teams from './pages/Teams'
import TeamDetail from './pages/TeamDetail'
import Users from './pages/Users'
import Requests from './pages/Requests'
import RequestAccess from './pages/RequestAccess'
import GlobalChannels from './pages/GlobalChannels'
import Login from './pages/Login'
import Admin from './pages/Admin'
import AuditLogs from './pages/AuditLogs'

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

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
    // timezone (Requirements 18.7, 18.11) and the certificate-expiry
    // warning threshold (Requirement 21.7). Both are Presentation_Config
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
    authAPI.getProfile()
      .then((response) => {
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

        if (autoLogin === 'true') {
          authAPI.login()
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
              authAPI.login()
              return
            }
            setLoading(false)
          })
          .catch(() => setLoading(false))
      })
  }, [])

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
          <Route path="/users" element={<Users />} />
          <Route path="/requests" element={<Requests user={user} />} />
          <Route path="/global-channels" element={<GlobalChannels user={user} />} />
          <Route path="/admin" element={<Admin user={user} />} />
          <Route path="/audit-logs" element={<AuditLogs user={user} />} />
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