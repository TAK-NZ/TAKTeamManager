import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { 
  HomeIcon, 
  UserGroupIcon, 
  UsersIcon, 
  ClipboardDocumentListIcon,
  SignalIcon,
  DocumentMagnifyingGlassIcon,
  Bars3Icon,
  XMarkIcon,
  CogIcon,
  SunIcon,
  MoonIcon
} from '@heroicons/react/24/outline'
import { authAPI, requestsAPI } from '../services/api'
import { useTheme } from '../contexts/ThemeContext'

const getNavigation = (user) => {
  const baseNavigation = [
    { name: 'Dashboard', href: '/dashboard', icon: HomeIcon },
    { name: 'Orgs & Teams', href: '/teams', icon: UserGroupIcon },
  ]
  
  if (user?.isAdmin || user?.is_global_manager) {
    baseNavigation.push({ name: 'Users', href: '/users', icon: UsersIcon })
  }
  
  if (user?.isAdmin || user?.isTeamAdmin) {
    baseNavigation.push({ name: 'Requests', href: '/requests', icon: ClipboardDocumentListIcon })
  }
  
  if (user?.is_global_manager) {
    baseNavigation.push({ name: 'Global Channels', href: '/global-channels', icon: SignalIcon })
    baseNavigation.push({ name: 'Audit Log', href: '/audit-logs', icon: DocumentMagnifyingGlassIcon })
  }
  
  if (user?.isAdmin) {
    baseNavigation.push({ name: 'Admin', href: '/admin', icon: CogIcon })
  }
  
  return baseNavigation
}

// A nav item is "active" for its own path AND any sub-path beneath it
// (e.g. /teams/123, /teams/123/anything), not just an exact match -- so
// selecting a specific Org/Team from the Teams list (which navigates to
// /teams/:teamId) keeps the "Orgs & Teams" item highlighted instead of
// losing its active state the moment the path is no longer exactly
// "/teams". Guards against a false-positive prefix match (e.g. a
// hypothetical "/teams-archive" matching "/teams") by requiring the
// character right after the prefix to be "/".
function isNavItemActive(pathname, href) {
  return pathname === href || pathname.startsWith(`${href}/`)
}

// Derives the human-readable app permission role label for the top bar,
// mirroring the exact precedence already used by getNavigation() above:
// is_global_manager > isAdmin (team admin) > plain member. There is no
// single boolean/enum already carrying this label anywhere in `user`, so
// it's computed here from the same two flags every other permission
// check in this file already relies on.
function getUserRoleLabel(user) {
  if (user?.is_global_manager) {
    return 'Global Admin'
  }
  if (user?.isTeamAdmin) {
    return 'Team Admin'
  }
  return 'Member'
}

export default function Layout({ children, user }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const location = useLocation()
  const navigation = getNavigation(user)
  const { theme, toggleTheme } = useTheme()

  const [pendingRequestCount, setPendingRequestCount] = useState(0)

  useEffect(() => {
    if (!user?.isAdmin && !user?.is_global_manager) return

    const fetchPendingCount = async () => {
      try {
        const response = await requestsAPI.getPending()
        setPendingRequestCount(response.data.requests?.length || 0)
      } catch (e) {
        // Silent fail — badge just won't show
      }
    }

    fetchPendingCount()
    const intervalId = setInterval(fetchPendingCount, 60000) // refresh every 60s

    const handleVisibilityChange = () => {
      if (!document.hidden) fetchPendingCount()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      clearInterval(intervalId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [user])

  const handleLogout = async () => {
    // The local tak_session cookie is always cleared server-side by
    // authAPI.logout() regardless of outcome (see server/routes/auth.js).
    // WHERE the server has AUTHENTIK_LOGOUT_URL configured, it returns
    // that URL as `redirectUrl` in the response body; navigating there
    // (instead of to the local /login page) also ends the user's
    // Authentik SSO session, not just the local App session -- otherwise
    // the next SSO login would silently re-authenticate without
    // prompting, since Authentik itself would still consider the user
    // logged in.
    let redirectUrl = '/login'
    try {
      const response = await authAPI.logout()
      if (response?.data?.redirectUrl) {
        redirectUrl = response.data.redirectUrl
      }
    } finally {
      localStorage.removeItem('token')
      window.location.href = redirectUrl
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Mobile sidebar */}
      <div className={`fixed inset-0 z-50 lg:hidden ${sidebarOpen ? '' : 'hidden'}`}>
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75" onClick={() => setSidebarOpen(false)} />
        <div className="fixed inset-y-0 left-0 flex w-64 flex-col bg-white dark:bg-gray-800">
          <div className="flex h-16 items-center justify-between py-4">
            <img 
              src="/assets/tak-nz-brand-wide.svg" 
              alt="TAK.NZ" 
              className="h-10 w-auto"
            />
            <button onClick={() => setSidebarOpen(false)}>
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>
          <nav className="flex-1 space-y-1 px-2 py-4">
            {navigation.map((item) => (
              <Link
                key={item.name}
                to={item.href}
                className={`group flex items-center px-2 py-2 text-sm font-medium rounded-md ${
                  isNavItemActive(location.pathname, item.href)
                    ? 'bg-primary-100 dark:bg-primary-900 text-primary-700 dark:text-primary-300'
                    : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100'
                }`}
                onClick={() => setSidebarOpen(false)}
              >
                <span className="relative mr-3">
                  <item.icon className="h-6 w-6" />
                  {item.name === 'Requests' && pendingRequestCount > 0 && (
                    <span className="absolute -top-1 -right-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-600 px-0.5 text-[10px] font-bold text-white">
                      {pendingRequestCount > 99 ? '99+' : pendingRequestCount}
                    </span>
                  )}
                </span>
                {item.name}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      {/* Desktop sidebar */}
      <div className="hidden lg:fixed lg:inset-y-0 lg:flex lg:w-64 lg:flex-col">
        <div className="flex flex-col flex-grow bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700">
          <div className="flex h-16 items-center py-4">
            <img 
              src="/assets/tak-nz-brand-wide.svg" 
              alt="TAK.NZ" 
              className="h-10 w-auto"
            />
          </div>
          <nav className="flex-1 space-y-1 px-2 py-4">
            {navigation.map((item) => (
              <Link
                key={item.name}
                to={item.href}
                className={`group flex items-center px-2 py-2 text-sm font-medium rounded-md ${
                  isNavItemActive(location.pathname, item.href)
                    ? 'bg-primary-100 dark:bg-primary-900 text-primary-700 dark:text-primary-300'
                    : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100'
                }`}
              >
                <span className="relative mr-3">
                  <item.icon className="h-6 w-6" />
                  {item.name === 'Requests' && pendingRequestCount > 0 && (
                    <span className="absolute -top-1 -right-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-600 px-0.5 text-[10px] font-bold text-white">
                      {pendingRequestCount > 99 ? '99+' : pendingRequestCount}
                    </span>
                  )}
                </span>
                {item.name}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      {/* Main content */}
      <div className="lg:pl-64">
        {/* Top bar */}
        <div className="sticky top-0 z-40 flex h-16 bg-white dark:bg-gray-800 shadow">
          <button
            className="px-4 text-gray-500 lg:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <Bars3Icon className="h-6 w-6" />
          </button>
          <div className="flex flex-1 justify-between items-center px-4">
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">TAK Team Manager</h1>
            <div className="flex items-center space-x-4">
              <button
                onClick={toggleTheme}
                className="p-2 text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 dark:hover:text-gray-300 rounded-md"
              >
                {theme === 'dark' ? (
                  <SunIcon className="h-5 w-5" />
                ) : (
                  <MoonIcon className="h-5 w-5" />
                )}
              </button>
              <span className="text-sm text-left leading-tight">
                <span className="block text-gray-700 dark:text-gray-300">
                  {user?.first_name} {user?.last_name}
                </span>
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  {getUserRoleLabel(user)}
                </span>
              </span>
              <button
                onClick={handleLogout}
                className="px-3 py-1 text-sm text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700 hover:border-gray-400 dark:hover:border-gray-500"
              >
                Logout
              </button>
            </div>
          </div>
        </div>

        {/* Page content */}
        <main className="py-6">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}