import { Routes, Route } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { authAPI } from './services/api'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Teams from './pages/Teams'
import TeamDetail from './pages/TeamDetail'
import Users from './pages/Users'
import Requests from './pages/Requests'
import RequestAccess from './pages/RequestAccess'
import Login from './pages/Login'

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (token) {
      authAPI.getProfile()
        .then(response => setUser(response.data.user))
        .catch(() => localStorage.removeItem('token'))
        .finally(() => setLoading(false))
    } else {
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
    <Layout user={user}>
      <Routes>
        <Route path="/" element={<Dashboard user={user} />} />
        <Route path="/dashboard" element={<Dashboard user={user} />} />
        <Route path="/teams" element={<Teams />} />
        <Route path="/teams/:teamId" element={<TeamDetail />} />
        <Route path="/users" element={<Users />} />
        <Route path="/requests" element={<Requests />} />
      </Routes>
    </Layout>
  )
}

export default App