import { Routes, Route } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { authAPI } from './services/api'
import { ThemeProvider } from './contexts/ThemeContext'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Teams from './pages/Teams'
import TeamDetail from './pages/TeamDetail'
import Users from './pages/Users'
import Requests from './pages/Requests'
import RequestAccess from './pages/RequestAccess'
import Login from './pages/Login'
import Admin from './pages/Admin'

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Handle OAuth callback token
    const urlParams = new URLSearchParams(window.location.search)
    const tokenFromUrl = urlParams.get('token')
    
    if (tokenFromUrl) {
      console.log('Setting token from URL:', tokenFromUrl.substring(0, 50))
      localStorage.setItem('token', tokenFromUrl)
      // Remove token from URL
      window.history.replaceState({}, document.title, window.location.pathname)
    }
    
    const token = localStorage.getItem('token')
    if (token) {
      authAPI.getProfile()
        .then(response => setUser(response.data.user))
        .catch(() => {
          localStorage.removeItem('token')
          setUser(null)
        })
        .finally(() => setLoading(false))
    } else {
      // Auto-login if coming from Authentik or auto_login parameter
      const referrer = document.referrer
      const autoLogin = urlParams.get('auto_login')
      
      if ((referrer && referrer.includes('account.test.tak.nz')) || autoLogin === 'true') {
        // User came from Authentik, automatically start OAuth flow
        authAPI.login()
        return
      }
      
      setLoading(false)
    }
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
          <Route path="/teams/:teamId" element={<TeamDetail />} />
          <Route path="/users" element={<Users />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/admin" element={<Admin user={user} />} />
        </Routes>
      </Layout>
    </ThemeProvider>
  )
}

export default App