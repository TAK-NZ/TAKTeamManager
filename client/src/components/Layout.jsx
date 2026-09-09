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
  UserCircleIcon,
  BellIcon
} from '@heroicons/react/24/outline'
import { authAPI, requestsAPI, adminAPI, versionAPI, deviceManagementAPI } from '../services/api'
import { filterDevicesNeedingRenewal } from '../utils/expiryWarning'
import { useDeviceManagementEnabled } from './UserDevicesModal'
import { useTheme } from '../contexts/ThemeContext'

// `deviceMgmtEnabled` is the runtime DEVICE_MGMT_ENABLED probe result (see
// useDeviceManagementEnabled in UserDevicesModal.jsx): true only once the
// self-view probe has confirmed the feature is live, false while the feature
// is off OR before the probe resolves. Nav items whose page can only work
// when device management is on are hidden until it flips true, so a
// deployment with the feature off shows no dead menu items and no broken
// pages. It starts false, so those items are briefly absent on first paint
// and appear once the probe returns 200 -- acceptable for an optional
// affordance, and the same fail-closed stance the device-action buttons on
// the Users/Team pages already take.
const getNavigation = (user, deviceMgmtEnabled) => {
  const baseNavigation = [
    { name: 'Dashboard', href: '/dashboard', icon: HomeIcon },
    // Downloads comes before Enrollment: the workflow only runs in one
    // direction (install the client, then enroll it -- Downloads.jsx's own
    // subtitle says as much), so the first step belongs first in the nav.
    // Carries no permission identifier and no role gate: a user who has not
    // yet been placed in a Team is exactly the user installing a client for
    // the first time (takserver-enrollment Criterion 12.9).
    { name: 'Downloads', href: '/downloads', icon: ArrowDownTrayIcon },
    { name: 'Orgs & Teams', href: '/teams', icon: UserGroupIcon },
  ]

  // Enrollment carries no permission identifier and no role gate -- every
  // signed-in user must see it regardless of team membership, because a user
  // with no team membership at all is exactly the user who needs to
  // self-enroll a device (takserver-enrollment Criterion 15.2); the
  // authorization decision happens on the API call, not on nav visibility.
  // BUT it is gated on the DEVICE_MGMT_ENABLED feature probe: with device
  // management off, /enrollment can only ever show the
  // "TAK_SERVER_ENROLLMENT_URL must be configured" error, so a dead menu item
  // and a broken page are worse than hiding it. Inserted right after Downloads
  // (its natural workflow position: install the client, then enroll it) via
  // splice rather than a push so the ordering is preserved when it IS shown.
  if (deviceMgmtEnabled) {
    const downloadsIndex = baseNavigation.findIndex((item) => item.href === '/downloads')
    baseNavigation.splice(downloadsIndex + 1, 0, { name: 'Enrollment', href: '/enrollment', icon: QrCodeIcon })
  }

  // cert-expiry-notifications Requirement 7.2: renamed from "Requests" to
  // "Tasks" (the page now also lists certificate renewals due for the
  // viewer, not just access requests an admin acts on) and moved OUT of
  // the admin-only gate below -- every authenticated user needs to reach
  // /tasks to see their own renewal section, regardless of admin status.
  // The pending-request BADGE COUNT below keeps its own separate
  // isAdmin/isTeamAdmin gate (Requirement 7.7) -- lifting the nav item's
  // gate does not widen who that count is fetched for. Placed directly
  // after Orgs & Teams (and therefore before the admin-only Users/Devices
  // entries below), rather than after them, since it is unconditional.
  baseNavigation.push({ name: 'Tasks', href: '/tasks', icon: ClipboardDocumentListIcon })

  // Bugfix: this gate used to check only isAdmin/is_global_manager
  // (Global_Manager), leaving a plain Team_Admin -- who IS authorized
  // server-side, see below -- with no way to reach either page from the
  // nav. isTeamAdmin is added here to match.
  if (user?.isAdmin || user?.is_global_manager || user?.isTeamAdmin) {
    baseNavigation.push({ name: 'Users', href: '/users', icon: UsersIcon })
    // The org-wide Team_Owned_Device listing (/devices, GET /api/devices,
    // 'device:read:org') keeps its "Global_Manager, or a Team_Admin of ANY
    // team" ROLE gate (shared with Users), AND is now additionally gated on
    // the DEVICE_MGMT_ENABLED feature probe. Team_Owned_Devices are TAK Server
    // client certificates: the whole page (listing, add-device, per-row QR
    // mint) depends on TAK Server being configured (TAK_SERVER_ENROLLMENT_URL
    // et al.), which is exactly what the feature flag provisions. With the
    // feature off the page can only error, so hide the nav entry -- matching
    // Enrollment above and the device-action buttons on the Users/Team pages,
    // all of which already gate on this same probe.
    if (deviceMgmtEnabled) {
      baseNavigation.push({ name: 'Devices', href: '/devices', icon: DeviceTabletIcon })
    }
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
  // Runtime DEVICE_MGMT_ENABLED probe (self-view route, 200 vs 404). Gates
  // the Enrollment and Devices nav entries so a device-management-off
  // deployment shows neither a dead menu item nor a broken page.
  const deviceMgmtEnabled = useDeviceManagementEnabled()
  const navigation = getNavigation(user, deviceMgmtEnabled)
  const { theme, toggleTheme } = useTheme()

  // The count shown on the "Tasks" nav badge and the mobile notification
  // bell. It is the total of everything the viewer would see as outstanding
  // on /tasks: for an admin, pending access requests (+ Org_Interest for a
  // Global_Manager); for EVERY user, their own certificates needing renewal.
  // One number, one source, so the desktop nav badge, the mobile-drawer nav
  // badge, and the mobile bell can never disagree with each other or with the
  // page.
  const [outstandingTaskCount, setOutstandingTaskCount] = useState(0)
  // The running app version, shown at the bottom of the nav (both the
  // desktop sidebar and the mobile drawer). `null` while unresolved --
  // rendered as nothing rather than a placeholder, so an unreachable
  // GET /api never shows a misleading "v?" or blank version string.
  const [appVersion, setAppVersion] = useState(null)

  useEffect(() => {
    versionAPI.get()
      .then((response) => setAppVersion(response.data?.version || null))
      .catch(() => {
        // Silent fail: the version display is informational only, never
        // worth surfacing an error toast over.
      })
  }, [])

  useEffect(() => {
    // This effect now runs for EVERY user, not just admins: a plain member
    // has no access requests, but they DO have outstanding tasks of their own
    // -- their certificates needing renewal (the "My certificates needing
    // renewal" section on /tasks, visible to everyone). Before this change the
    // badge early-returned for non-admins and so was always blank for a
    // member, hiding a real task from them (and, on mobile, from the new
    // notification bell). Whether the user is an admin now only decides
    // WHICH calls run, not whether the effect runs at all.
    const isManager = Boolean(user?.isAdmin || user?.isTeamAdmin || user?.is_global_manager)

    const fetchOutstandingCount = async () => {
      // Category 1 (admins only): access_requests-backed team
      // access/change/role/name requests (requestsAPI.getPending) and, for a
      // Global_Manager only, pending Org_Interest_Requests. These calls are
      // gated to a manager so a plain member's Layout does not poll an
      // endpoint that can only ever resolve to zero for them (the pre-existing
      // reasoning). Category 2 (EVERY user): their own certificates needing
      // renewal, from deviceManagementAPI.getMyDevices(), filtered by the
      // SAME rule the /tasks page uses (filterDevicesNeedingRenewal), so the
      // badge and the page's list always agree. A 404 there means device
      // management is off -> a truthful zero, matching the page's own
      // silent-404 convention.
      //
      // All fetched with Promise.allSettled, never Promise.all: a 403 on the
      // org-interest call (an admin:manage, non-global caller has no
      // admin:org_interest:read permission) or a 404 on the devices call must
      // not blank out whichever counts DID resolve.
      // Category 2 also includes, for EVERY user, their own devices currently
      // connected under a wrong callsign (callsign-mismatch detection,
      // docs/ARCHITECTURE.md ("Callsign Mismatch Detection" section) Phase 2). Like getMyDevices this is an
      // always-present call whose 404 (device management off) reads as a
      // truthful zero via allSettled, so it never blanks the other counts.
      const promises = [deviceManagementAPI.getMyDevices(), deviceManagementAPI.getMyCallsignStatus()]
      if (isManager) {
        promises.push(requestsAPI.getPending())
      }
      if (user?.is_global_manager) {
        promises.push(adminAPI.getOrgInterest({ status: 'pending' }))
      }

      const [myDevicesResult, callsignStatusResult, accessRequestsResult, orgInterestResult] =
        await Promise.allSettled(promises);

      const ownRenewalCount =
        myDevicesResult.status === 'fulfilled'
          ? filterDevicesNeedingRenewal(myDevicesResult.value?.data?.devices).length
          : 0
      const callsignMismatchCount =
        callsignStatusResult?.status === 'fulfilled'
          ? callsignStatusResult.value?.data?.mismatches?.length || 0
          : 0
      const accessRequestsCount =
        accessRequestsResult?.status === 'fulfilled'
          ? accessRequestsResult.value?.data?.requests?.length || 0
          : 0
      const orgInterestCount =
        orgInterestResult?.status === 'fulfilled'
          ? orgInterestResult.value?.data?.requests?.length || 0
          : 0

      setOutstandingTaskCount(
        ownRenewalCount + callsignMismatchCount + accessRequestsCount + orgInterestCount
      )
    }

    fetchOutstandingCount()
    const intervalId = setInterval(fetchOutstandingCount, 60000) // refresh every 60s

    const handleVisibilityChange = () => {
      if (!document.hidden) fetchOutstandingCount()
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
                  {item.name === 'Tasks' && outstandingTaskCount > 0 && (
                    <span className="absolute -top-1 -right-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-600 px-0.5 text-[10px] font-bold text-white">
                      {outstandingTaskCount > 99 ? '99+' : outstandingTaskCount}
                    </span>
                  )}
                </span>
                {item.name}
              </Link>
            ))}
          </nav>
          {appVersion && (
            <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 text-xs text-center text-gray-400 dark:text-gray-500">
              Version {appVersion}
            </div>
          )}
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
                  {item.name === 'Tasks' && outstandingTaskCount > 0 && (
                    <span className="absolute -top-1 -right-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-600 px-0.5 text-[10px] font-bold text-white">
                      {outstandingTaskCount > 99 ? '99+' : outstandingTaskCount}
                    </span>
                  )}
                </span>
                {item.name}
              </Link>
            ))}
          </nav>
          {appVersion && (
            <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 text-xs text-center text-gray-400 dark:text-gray-500">
              Version {appVersion}
            </div>
          )}
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
            <div className="flex items-center gap-1 ml-auto lg:hidden">
              {/* Notification bell (mobile only): the sidebar is an
                  off-canvas drawer on mobile, so its "Tasks" badge is
                  invisible until the user opens the drawer. This surfaces the
                  SAME outstandingTaskCount in the always-visible top row and
                  links straight to /tasks. Shown for every user -- a plain
                  member's count is their own certificate renewals, an admin's
                  also includes pending requests. The red pill mirrors the nav
                  badge exactly; the state is carried in the aria-label's TEXT
                  (a count), never by the red colour alone. p-2 rounded-lg is a
                  real ~40px tap target, matching this app's other free-standing
                  icon buttons. */}
              <Link
                to="/tasks"
                aria-label={
                  outstandingTaskCount > 0
                    ? `Tasks, ${outstandingTaskCount} outstanding`
                    : 'Tasks'
                }
                className="relative p-2 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <BellIcon className="h-6 w-6" />
                {outstandingTaskCount > 0 && (
                  <span className="absolute top-1 right-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-600 px-0.5 text-[10px] font-bold text-white">
                    {outstandingTaskCount > 99 ? '99+' : outstandingTaskCount}
                  </span>
                )}
              </Link>
              <div className="relative">
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