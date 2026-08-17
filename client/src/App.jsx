import { Routes, Route } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { authAPI, configAPI } from './services/api'
import { isPublicOnlyPath } from './utils/publicPaths'
import { ThemeProvider } from './contexts/ThemeContext'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Teams from './pages/Teams'
import TeamDetail from './pages/TeamDetail'
import Users from './pages/Users'
import Requests from './pages/Requests'
import RequestAccess from './pages/RequestAccess'
import VerifyRequest from './pages/VerifyRequest'
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
    // /request-access and /verify-request must be fully usable by a
    // completely anonymous visitor with no session cookie. Skip the
    // authenticated GET /auth/me check entirely on these paths -- calling
    // it here would 401 for every anonymous visitor, and that 401 (via
    // services/api.js's response interceptor) used to force-navigate to
    // /login, which re-mounts this same effect and 401s again, producing
    // an endless redirect loop instead of ever rendering the public page.
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

        configAPI.getPublic()
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
        <Route path="/verify-request" element={<VerifyRequest />} />
        <Route path="*" element={<Login />} />
      </Routes>
    )
  }

  return (
    <ThemeProvider>
      <Layout user={user}>
        <Routes>
          <Route path="/" element={<Dashboard user={user} refreshUser={refreshUser} />} />
          <Route path="/dashboard" element={<Dashboard user={user} refreshUser={refreshUser} />} />
          <Route path="/teams" element={<Teams user={user} />} />
          <Route path="/teams/:teamId" element={<TeamDetail refreshUser={refreshUser} />} />
          <Route path="/users" element={<Users />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/global-channels" element={<GlobalChannels user={user} />} />
          <Route path="/admin" element={<Admin user={user} />} />
          <Route path="/audit-logs" element={<AuditLogs user={user} />} />
        </Routes>
      </Layout>
    </ThemeProvider>
  )
}

export default App