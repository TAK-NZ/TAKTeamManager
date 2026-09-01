import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { 
  HomeIcon, 
  UserGroupIcon, 
  UsersIcon, 
  DeviceTabletIcon,
  ClipboardDocumentListIcon,
  SignalIcon,
  DocumentMagnifyingGlassIcon,
  Bars3Icon,
  XMarkIcon,
  CogIcon,
  SunIcon,
  MoonIcon,
  QrCodeIcon,
  ArrowDownTrayIcon,
  UserCircleIcon
} from '@heroicons/react/24/outline'
import { authAPI, requestsAPI, adminAPI } from '../services/api'
import { useTheme } from '../contexts/ThemeContext'

const getNavigation = (user) => {
  const baseNavigation = [
    { name: 'Dashboard', href: '/dashboard', icon: HomeIcon },
    // Downloads comes before Enrollment: the workflow only runs in one
    // direction (install the client, then enroll it -- Downloads.jsx's own
    // subtitle says as much), so the first step belongs first in the nav.
    // Carries no permission identifier and no role gate: a user who has not
    // yet been placed in a Team is exactly the user installing a client for
    // the first time (takserver-enrollment Criterion 12.9).
    { name: 'Downloads', href: '/downloads', icon: ArrowDownTrayIcon },
    // Enrollment carries no permission identifier and no role gate either,
    // for the same reason as Downloads above: every signed-in user must see
    // it regardless of team membership, because a user with no team
    // membership at all is exactly the user who needs to self-enroll a
    // device (takserver-enrollment Criterion 15.2). The authorization
    // decision happens on the API call, not on nav visibility.
    { name: 'Enrollment', href: '/enrollment', icon: QrCodeIcon },
    { name: 'Orgs & Teams', href: '/teams', icon: UserGroupIcon },
  ]
  
  if (user?.isAdmin || user?.is_global_manager) {
    baseNavigation.push({ name: 'Users', href: '/users', icon: UsersIcon })
    // Placed directly beneath Users, same role gate: the org-wide
    // Team_Owned_Device listing (GET /api/devices, 'device:read:org') is
    // authorized by the SAME "Global_Manager, or a Team_Admin of ANY
    // team" rule 'user:read:team_admin' already uses for Users -- there
    // is no separate feature flag gating this nav entry (unlike the
    // View-Devices action on a /users row, which is gated behind
    // DEVICE_MGMT_ENABLED via useDeviceManagementEnabled -- a different
    // feature: TAK Server certificates, not Team_Owned_Device accounts).
    baseNavigation.push({ name: 'Devices', href: '/devices', icon: DeviceTabletIcon })
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
  // Mobile-only (below `lg`): collapses the theme toggle, name/role and
  // logout button -- three separate controls that otherwise crowd the top
  // bar on a narrow phone -- behind a single avatar-icon trigger. Desktop
  // keeps showing all three inline (see the `lg:flex`/`lg:hidden` pair
  // around the menu below); this state has no effect at `lg:` and up.
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const location = useLocation()
  const navigation = getNavigation(user)
  const { theme, toggleTheme } = useTheme()

  const [pendingRequestCount, setPendingRequestCount] = useState(0)

  useEffect(() => {
    if (!user?.isAdmin && !user?.is_global_manager) return

    const fetchPendingCount = async () => {
      // Two independent request systems feed this one badge: the
      // access_requests-backed team access/change/role/name requests
      // (requestsAPI.getPending, visible to any admin) and, for a
      // Global_Manager only, pending Org_Interest_Requests -- a separate
      // table (`org_interest_requests`) surfaced today only via its own
      // `OrgInterestRequests` panel on /requests. Without this, a
      // Global_Manager could have a pending org interest lead and see no
      // badge and a Dashboard reading "0 pending requests" at all, even
      // though /requests visibly shows it.
      //
      // Fetched with Promise.allSettled, not Promise.all: an admin:manage
      // (non-global) caller has no `admin:org_interest:read` permission
      // and gets a 403 on that call, which must not blank out the
      // access_requests count they DO have permission for.
      const promises = [requestsAPI.getPending()]
      if (user?.is_global_manager) {
        promises.push(adminAPI.getOrgInterest({ status: 'pending' }))
      }

      const [accessRequestsResult, orgInterestResult] = await Promise.allSettled(promises)

      const accessRequestsCount =
        accessRequestsResult.status === 'fulfilled'
          ? accessRequestsResult.value.data.requests?.length || 0
          : 0
      const orgInterestCount =
        orgInterestResult?.status === 'fulfilled'
          ? orgInterestResult.value.data.requests?.length || 0
          : 0

      // Silent fail on either individual call — badge just reflects
      // whichever count(s) succeeded, matching this effect's existing
      // "silent fail, badge won't show" convention rather than
      // introducing a new error surface.
      setPendingRequestCount(accessRequestsCount + orgInterestCount)
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
          <div className="flex h-16 items-center justify-between px-2 py-4">
            <div className="flex items-center gap-x-2">
              <img 
                src="/assets/tak-nz-logo.svg" 
                alt="" 
                className="h-8 w-8 flex-shrink-0"
              />
              <span className="text-lg font-bold text-gray-900 dark:text-gray-100">TAK Team Manager</span>
            </div>
            {/* Bugfix (mobile tap target too small): this button had NO
                classes at all -- not even a hit-box, colour, or hover
                state. p-2 rounded-lg matches every other modal/drawer
                close button in this app. */}
            <button
              onClick={() => setSidebarOpen(false)}
              aria-label="Close menu"
              className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
            >
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
          <div className="flex h-16 items-center gap-x-2 px-2 py-4">
            <img 
              src="/assets/tak-nz-logo.svg" 
              alt="" 
              className="h-8 w-8 flex-shrink-0"
            />
            <span className="text-lg font-bold text-gray-900 dark:text-gray-100">TAK Team Manager</span>
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
          {/* Bugfix (mobile tap target too small): `flex items-center
              justify-center` makes the ~64px-tall hit area explicit
              (was relying on the parent flex row's default stretch
              behaviour, unstated and easy to break by a future layout
              change) -- combined with the existing `px-4`, this gives a
              generous tap target rather than an ambiguous one. */}
          <button
            className="px-4 flex items-center justify-center text-gray-500 lg:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Bars3Icon className="h-6 w-6" />
          </button>
          <div className="flex flex-1 justify-between items-center px-4">
            {/* Desktop sidebar already carries the "TAK Team Manager"
                wordmark next to its logo mark, always visible there, so a
                second visible copy here would be a plain duplicate.
                `hidden` removes it from layout entirely below `lg` (a
                mobile viewport has no width to spare holding an invisible
                placeholder); `lg:block lg:invisible` puts it BACK into
                layout at `lg:` and up (`display: none` from `hidden`
                would otherwise persist there too -- `hidden` only sets
                `display`, and nothing at `lg:` overrode that until this
                fix, which is why the desktop row lost its right-hand
                alignment: with this element truly absent from the flex
                layout, `justify-between` had only one visible child left
                and packed it to the start instead of the end) while
                keeping it invisible so `justify-between` positions the
                sibling controls block at the same right-hand spot it
                always has, without a second visible copy of the
                wordmark. On mobile the sidebar is an off-canvas drawer
                (hidden until the hamburger is tapped), so this stays the
                only app-name branding a mobile user sees by default. */}
            <h1 className="hidden lg:block lg:invisible text-xl font-bold text-gray-900 dark:text-gray-100">TAK Team Manager</h1>
            {/* Desktop (`lg:` and up): theme toggle, name/role and logout
                shown inline, exactly as before. */}
            <div className="hidden lg:flex items-center space-x-4">
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
            {/* Mobile (below `lg`): the same three controls collapse
                behind one avatar-icon trigger, so the top bar carries a
                single tappable element instead of an icon, two lines of
                text and a button all in a row. `ml-auto` rather than
                relying on the row's `justify-between`: below `lg` the `h1`
                above is `hidden` (out of flow, not just `invisible`) and
                the desktop cluster is `hidden` too, leaving this trigger
                as the row's ONLY visible flex child -- `justify-between`
                has nothing left to distribute between, so it settles at
                the start (left) instead of the right. `ml-auto` pins it
                to the right regardless of how many siblings are actually
                in flow. */}
            <div className="relative ml-auto lg:hidden">
              <button
                onClick={() => setUserMenuOpen((open) => !open)}
                aria-expanded={userMenuOpen}
                aria-haspopup="true"
                aria-label="Open user menu"
                className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <UserCircleIcon className="h-8 w-8" />
              </button>
              {userMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-2 w-48 rounded-md bg-white dark:bg-gray-800 shadow-lg ring-1 ring-black ring-opacity-5 z-50 py-1">
                    <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700">
                      <span className="block text-sm text-gray-700 dark:text-gray-300">
                        {user?.first_name} {user?.last_name}
                      </span>
                      <span className="block text-xs text-gray-500 dark:text-gray-400">
                        {getUserRoleLabel(user)}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        toggleTheme()
                        setUserMenuOpen(false)
                      }}
                      className="flex w-full items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      {theme === 'dark' ? (
                        <SunIcon className="h-4 w-4" />
                      ) : (
                        <MoonIcon className="h-4 w-4" />
                      )}
                      {theme === 'dark' ? 'Light mode' : 'Dark mode'}
                    </button>
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="flex w-full items-center px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      Logout
                    </button>
                  </div>
                </>
              )}
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