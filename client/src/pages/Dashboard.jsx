import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { UsersIcon, UserGroupIcon, RadioIcon, ClipboardDocumentListIcon, ArrowUpRightIcon, ArrowDownLeftIcon, ArrowsRightLeftIcon, MagnifyingGlassIcon, ChevronLeftIcon, ChevronRightIcon, InformationCircleIcon, FolderIcon, FolderOpenIcon, ChevronRightIcon as ChevronRightSmall, ChevronDownIcon, ChevronUpIcon, SignalIcon, IdentificationIcon, DevicePhoneMobileIcon } from '@heroicons/react/24/outline'
// Bugfix (top-level folder icons): the five recognized top-level channel
// folders get a symbol naming what they actually are, rather than the
// generic FolderIcon/FolderOpenIcon every other folder still uses.
// BCH/Response/Support/XtraTools mirror GlobalChannels.jsx's own section
// icons EXACTLY (RadioIcon stays heroicons there too, per that page's own
// "leave as is" -- see the comment on CHANNEL_TABS in GlobalChannels.jsx);
// Teams mirrors Layout.jsx's "Orgs & Teams" nav icon. None of the five has
// an open/closed pair the way FolderIcon/FolderOpenIcon do, so one icon is
// used regardless of expanded state -- matching how GlobalChannels' own
// section headers render these same icons (never swapped on toggle).
import { IconFiretruck, IconBackhoe, IconTool } from '@tabler/icons-react'
import { teamsAPI, requestsAPI, configAPI, usersAPI, channelsAPI, deviceManagementAPI, adminAPI, devicesAPI } from '../services/api'
import { buildFolderTree } from '../utils/channelTree'
import { getTakColorHex } from '../utils/takColors'
import { getCountry } from '../utils/isoCountry'
import RevokeDeviceDialog from '../components/RevokeDeviceDialog'
import DeviceListRow, { DeviceListHeader, DeviceListCard } from '../components/DeviceListRow'
import { EXPIRY_STATES, classifyExpiry, getExpiryWarningDays } from '../utils/expiryWarning'
// The Visibility_Pause_Pattern (device-management Requirements 19.1-19.3):
// both auto-refreshing cards here ("My Channels"/"My Devices") share this one
// mechanism. It was extracted to a shared util so the Admin page's stat cards
// can reuse the identical lifecycle (see visibilityPausedRefresh.js's own doc
// for the 60s "UI-consistency, not data-freshness" rationale).
import { startVisibilityPausedRefresh } from '../utils/visibilityPausedRefresh'

// Bugfix (top-level folder icons): the exact top-level folder names this
// server can produce for a Team/BCH/Region channel's group name, once
// `tak_` and any category/tier prefix are stripped -- 'Teams'
// (`Team.createTeamChannel`), 'BCH'/'XtraTools'
// (`BCH_CHANNEL_CATEGORY_PREFIX`, server/config/constants.js), and
// 'Response'/'Support' (`REGION_CHANNEL_TIER_PREFIX`, same file). A folder
// name not in this map (a plain team/region name with no recognized
// prefix, e.g. a literal Region name before tiering existed, or any other
// ad-hoc top-level group) keeps the existing generic FolderIcon/
// FolderOpenIcon -- this only replaces the symbol for the five names the
// server is actually known to produce at the top level.
const TOP_LEVEL_FOLDER_ICONS = Object.freeze({
  Teams: UserGroupIcon,
  BCH: RadioIcon,
  Response: IconFiretruck,
  Support: IconBackhoe,
  XtraTools: IconTool
})

export default function Dashboard({ user }) {
  // Bugfix (generic-pending-tasks-banner): this banner's count previously
  // covered ONLY the access_requests/Org_Interest queue (`accessRequests`
  // below). It now also folds in Team-Owned Device renewals awaiting an
  // ADMIN's action (`teamDeviceRenewals`) -- the same count the /tasks
  // page's own "Team devices needing renewal" section lists -- so an admin
  // with nothing but expiring team devices still sees a non-zero banner.
  //
  // Deliberately NOT folded in: the viewer's OWN device renewals. Those
  // already get a separate, more specific banner just below ("One or more
  // of your devices has a certificate expiring soon or expired." with a
  // direct /enrollment link) -- folding them in here too would put two
  // banners about the same expiring cert on one page.
  const [stats, setStats] = useState({ accessRequests: 0, teamDeviceRenewals: 0 })
  // Requests.jsx's own gate for whether the viewer administers ANY team
  // (Team_Admin, admin, or Global_Manager) -- reused here verbatim so the
  // team-device-renewal fetch below only fires for a viewer who could act
  // on the result.
  const canManageTeams = Boolean(user?.isAdmin || user?.isTeamAdmin || user?.is_global_manager)
  const [userTeam, setUserTeam] = useState(null)
  const [userChannels, setUserChannels] = useState([])
  const [freshUser, setFreshUser] = useState(user)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const channelsPerPage = 10
  const [expandedFolders, setExpandedFolders] = useState(new Set())
  const [folderSeparator, setFolderSeparator] = useState(' - ')

  // --- My Devices (device-management spec, Requirement 5) ---
  //
  // `DEVICE_MGMT_ENABLED` is deliberately never exposed through
  // /api/config/public (Requirement 1.4), so the card can't ask "is this
  // feature on?" up front. `probeEnabled()` uses the self-view itself as the
  // probe: a 200 means the feature is live AND hands back the device list, so
  // this needs no second request. A 404 means the flag is off and the card
  // stays hidden. Anything else is a real failure, which the probe rethrows.
  const [devicesEnabled, setDevicesEnabled] = useState(false)
  const [devices, setDevices] = useState([])
  const [devicesLoading, setDevicesLoading] = useState(true)
  const [devicesError, setDevicesError] = useState(null)
  const [deviceToRevoke, setDeviceToRevoke] = useState(null)

  // Serves both the first load and every background refresh (Requirement
  // 19.1), which is why it never RAISES `devicesLoading` -- it only ever
  // lowers it in `finally`. A refresh that flipped the spinner back on would
  // make the card flicker once a minute (Requirement 19.5).
  //
  // The 404-vs-failure distinction this relies on is already drawn by
  // `probeEnabled()`: it RESOLVES `{ enabled: false, devices: [] }` for a 404
  // (the flag is off server-side) and RETHROWS everything else (network, 5xx,
  // 401/403). So the two branches below are exactly those two cases, and
  // nothing here has to inspect a status code.
  const fetchDevices = useCallback(async () => {
    try {
      const { enabled, devices: probedDevices } = await deviceManagementAPI.probeEnabled()
      setDevicesEnabled(enabled)
      setDevices(enabled ? probedDevices : [])
      setDevicesError(null)
    } catch (error) {
      // A real failure (5xx, network, 401/403) -- NOT "feature off". The card
      // stays hidden until the probe has succeeded at least once; once it has,
      // a later failure shows inline rather than making the card disappear.
      //
      // Requirements 19.5, 19.6: this branch deliberately touches NEITHER
      // `devices` NOR `devicesEnabled`. No `setDevices([])`, so the last
      // successful list stays rendered and the empty-list message does not
      // appear; no `setDevicesEnabled(false)`, so a transient failure cannot
      // make a card that was showing a list disappear. Only the resolved
      // `enabled: false` above -- i.e. an explicit 404 -- hides it.
      //
      // Requirement 19.4: `deviceToRevoke` is likewise untouched, by this
      // branch and by the success branch. An open RevokeDeviceDialog holds the
      // Device object it was handed and its own input state, so a refresh that
      // replaces `devices` with freshly fetched objects leaves the open dialog
      // and the text typed into it intact. The open Device is deliberately NOT
      // re-resolved against the new list.
      console.error('Failed to fetch devices:', error)
      setDevicesError('Failed to load your devices.')
    } finally {
      setDevicesLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchDevices()
  }, [fetchDevices])

  // Requirements 19.1, 19.2, 19.3: keep the card current on the shared
  // Visibility_Pause_Pattern. Separate from the first-load effect above so
  // mounting still performs exactly one fetch -- `startVisibilityPausedRefresh`
  // only schedules, it does not fetch up front.
  //
  // Requirement 19.8 note: the user-details device modal gets NO equivalent
  // interval. It is a short-lived dialog that already fetches on open and
  // after a revoke, and a background re-render underneath a stacked
  // confirmation dialog is disruption rather than freshness.
  useEffect(() => startVisibilityPausedRefresh(fetchDevices), [fetchDevices])

  const [colorMappings, setColorMappings] = useState({})
  const [roleDescriptions, setRoleDescriptions] = useState({})

  // Fetch color mappings and folder separator from API
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        // Both raw axios.get calls here previously sent
        // `Authorization: Bearer ${localStorage.getItem('token')}` -- but
        // this app has never stored a token in localStorage (auth lives
        // solely in the httpOnly `tak_session` cookie set by the server;
        // see server/middleware/auth.js), so that header was always
        // literally "Bearer null", and neither raw axios call set
        // `withCredentials: true` either, so the real session cookie
        // wasn't sent. Both calls have been failing with 401 the entire
        // time. Using the shared `api`-backed configAPI wrapper (which
        // has `withCredentials: true` and sends no dead Authorization
        // header) fixes both.
        const [colorResponse, publicResponse] = await Promise.all([
          configAPI.getColorMappings(),
          configAPI.getPublic()
        ])
        setColorMappings(colorResponse.data.colorMappings)
        setRoleDescriptions(colorResponse.data.roleDescriptions)
        setFolderSeparator(publicResponse.data.channel_folder_separator || ' - ')
        // NOTE: the Expiry_Warning_Days threshold (Requirement 21.7) is NOT
        // installed here. It is installed once in `App.jsx`, beside the
        // sibling `display_timezone`, so that it is in force before the
        // first device row of ANY surface renders -- including for a client
        // that lands directly on /users and never mounts this page.
        // `folderSeparator` stays page state because the PAGE is its
        // consumer: it calls `buildFolderTree` itself.
      } catch (error) {
        console.error('Failed to fetch config:', error)
      }
    }
    fetchConfig()
  }, [])

  // Map color names to organization names
  const getOrganizationName = (colorName) => {
    return colorMappings[colorName] || colorName
  }

  const toggleFolder = (folderPath) => {
    const newExpanded = new Set(expandedFolders)
    if (newExpanded.has(folderPath)) {
      newExpanded.delete(folderPath)
    } else {
      newExpanded.add(folderPath)
    }
    setExpandedFolders(newExpanded)
  }

  const getAllFolderPaths = (tree, basePath = '') => {
    const paths = []
    Object.keys(tree.folders).forEach(folderName => {
      const folderPath = basePath ? `${basePath}/${folderName}` : folderName
      paths.push(folderPath)
      paths.push(...getAllFolderPaths(tree.folders[folderName], folderPath))
    })
    return paths
  }

  const expandAllFolders = () => {
    const allPaths = getAllFolderPaths(buildFolderTree(filteredChannels, folderSeparator))
    setExpandedFolders(new Set(allPaths))
  }

  const collapseAllFolders = () => {
    setExpandedFolders(new Set())
  }

  const getPathsToChannels = (channels) => {
    const paths = new Set()
    channels.forEach(channel => {
      const parts = channel.display_name.split(folderSeparator)
      if (parts.length > 1) {
        let currentPath = ''
        for (let i = 0; i < parts.length - 1; i++) {
          const folderName = parts[i].trim()
          currentPath = currentPath ? `${currentPath}/${folderName}` : folderName
          paths.add(currentPath)
        }
      }
    })
    return paths
  }

  const renderFolderTree = (tree, path = '') => {
    const items = []
    
    // Render folders
    Object.entries(tree.folders).forEach(([folderName, subtree]) => {
      const folderPath = path ? `${path}/${folderName}` : folderName
      const isExpanded = expandedFolders.has(folderPath)
      const parentChannel = tree.channels.find(c => c.display_name === folderName)
      
      if (parentChannel) {
        // Render as expandable channel. `ml-3 sm:ml-6` (rather than a flat
        // `ml-6`): each nesting level's indentation compounds with its
        // ancestors' (see the children wrapper below), so on a narrow phone
        // a few levels deep can push a row's content out of the visible
        // width entirely. Halving the per-level indent below `sm` keeps
        // the hierarchy visually distinguishable without costing that much
        // horizontal room; `sm:` and up is unchanged.
        // Bugfix (mobile tap target too small, and inconsistent with the
        // plain-folder row below): this row used to require hitting the
        // small `p-1`/`h-4 w-4` chevron button specifically to expand it
        // -- a ~24px target, and the ONLY way to expand this row type
        // (unlike a plain folder, whose entire row is already
        // click-anywhere-to-expand). The whole row is now the toggle
        // target too, via `onClick`/`cursor-pointer` on this outer div,
        // and the chevron is now purely decorative (no onClick/button of
        // its own), matching the plain-folder row's own pattern exactly.
        items.push(
          // Bugfix (mobile horizontal scroll on /dashboard): same fix as
          // the plain-channel row below -- `flex-col sm:flex-row` stacks
          // the permission badges beneath the name/description on mobile
          // instead of forcing both onto one non-wrapping row, and
          // `min-w-0`/`break-words` let a long name/description actually
          // wrap instead of pushing the row (and the whole page) wider
          // than the viewport. `cursor-pointer`/`onClick` stay on this
          // outer div either way -- the whole row is still the toggle
          // target regardless of how its content stacks.
          <div
            key={folderPath}
            className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 bg-gray-100 dark:bg-gray-700 rounded-lg ml-3 sm:ml-6 cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600"
            onClick={() => toggleFolder(folderPath)}
          >
            <div className="flex items-center flex-1 min-w-0">
              <ChevronRightSmall className={`h-4 w-4 text-gray-500 dark:text-gray-300 transition-transform mr-2 flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center">
                  <SignalIcon className="h-4 w-4 text-gray-900 dark:text-gray-100 mr-1.5 flex-shrink-0" />
                  <h3 className="font-medium text-gray-900 dark:text-gray-100 break-words">{parentChannel.display_name}</h3>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-300 break-words">
                  {parentChannel.description}
                </p>
              </div>
            </div>
            <div className="flex items-center flex-wrap gap-2">
              {parentChannel.permissions.includes('read') && (
                <div className="relative group">
                  <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-blue-100 text-blue-800 rounded cursor-help">
                    <ArrowUpRightIcon className="h-3 w-3 mr-1" />
                    Read
                  </span>
                  {/* Sideways (`right-full`, this row's badges sit near the
                      right edge of the card): a `bottom-full` tooltip here
                      would clip against the card's own edges on a narrow
                      viewport, the same Tooltip_Clipping_Defect the
                      Date_Tooltip convention exists to avoid. */}
                  <div className="absolute right-full top-1/2 transform -translate-y-1/2 mr-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                    Receive data only - view others' locations and messages
                  </div>
                </div>
              )}
              {parentChannel.permissions.includes('write') && (
                <div className="relative group">
                  <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded cursor-help">
                    <ArrowDownLeftIcon className="h-3 w-3 mr-1" />
                    Write
                  </span>
                  <div className="absolute right-full top-1/2 transform -translate-y-1/2 mr-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                    Send data only - share your location and messages
                  </div>
                </div>
              )}
              {parentChannel.permissions.includes('readwrite') && (
                <div className="relative group">
                  <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-purple-100 text-purple-800 rounded cursor-help">
                    <ArrowsRightLeftIcon className="h-3 w-3 mr-1" />
                    Read/Write
                  </span>
                  <div className="absolute right-full top-1/2 transform -translate-y-1/2 mr-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                    Full access - send and receive all data
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      } else {
        // Render as regular folder. Bugfix (top-level folder icons): a
        // TOP-LEVEL folder (path === '', i.e. not nested under another
        // folder) whose name is one of the five recognized names gets that
        // name's dedicated symbol instead of the generic Folder/FolderOpen
        // pair -- checked on `path`, not `folderPath`, because a NESTED
        // folder could coincidentally share one of these names (e.g. some
        // team's own sub-team literally named "Support") and must keep the
        // ordinary folder glyph.
        const TopLevelIcon = path === '' ? TOP_LEVEL_FOLDER_ICONS[folderName] : undefined
        items.push(
          <div key={folderPath}>
            <div 
              className="flex items-center p-3 bg-gray-100 dark:bg-gray-700 rounded-lg cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600"
              onClick={() => toggleFolder(folderPath)}
            >
              <div className="flex items-center flex-1">
                {TopLevelIcon ? (
                  <TopLevelIcon className="h-5 w-5 text-gray-900 dark:text-gray-100 mr-2" />
                ) : isExpanded ? (
                  <FolderOpenIcon className="h-5 w-5 text-gray-900 dark:text-gray-100 mr-2" />
                ) : (
                  <FolderIcon className="h-5 w-5 text-gray-900 dark:text-gray-100 mr-2" />
                )}
                <span className="font-medium text-gray-900 dark:text-gray-100">{folderName}</span>
              </div>
              <ChevronRightSmall className={`h-4 w-4 text-gray-500 dark:text-gray-300 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
            </div>
          </div>
        )
      }
      
      if (isExpanded) {
        items.push(
          <div key={`${folderPath}-children`} className="ml-3 sm:ml-6 mt-2 space-y-2">
            {renderFolderTree(subtree, folderPath)}
          </div>
        )
      }
    })
    
    // Render regular channels (excluding those that are parent channels)
    const parentChannelNames = new Set(Object.keys(tree.folders))
    tree.channels.filter(c => !parentChannelNames.has(c.display_name)).forEach(channel => {
      items.push(
        // Bugfix (mobile horizontal scroll on /dashboard): this row used to
        // be a single non-wrapping `flex items-center justify-between` with
        // no `min-w-0`/`break-words` on the name/description and no
        // stacking for the permission badges -- so a channel name plus 1-3
        // badges could together exceed a phone's viewport width and force
        // the whole card (and page) wider than the screen. `flex-col
        // sm:flex-row` stacks the badges below the name/description on
        // mobile instead of squeezing both into one row, matching
        // `GlobalChannels.jsx`'s identical channel row and this same page's
        // own Expandable_Channel_Row fix just below.
        <div key={channel.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 bg-gray-100 dark:bg-gray-700 rounded-lg ml-3 sm:ml-6">
          <div className="flex-1 min-w-0">
            <div className="flex items-center">
              <SignalIcon className="h-4 w-4 text-gray-900 dark:text-gray-100 mr-1.5 flex-shrink-0" />
              <h3 className="font-medium text-gray-900 dark:text-gray-100 break-words">{channel.display_name}</h3>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-300 break-words">
              {channel.description}
            </p>
          </div>
          <div className="flex items-center flex-wrap gap-2">
            {channel.permissions.includes('read') && (
              <div className="relative group">
                <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-blue-100 text-blue-800 rounded cursor-help">
                  <ArrowUpRightIcon className="h-3 w-3 mr-1" />
                  Read
                </span>
                <div className="absolute right-full top-1/2 transform -translate-y-1/2 mr-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                  Receive data only - view others' locations and messages
                </div>
              </div>
            )}
            {channel.permissions.includes('write') && (
              <div className="relative group">
                <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded cursor-help">
                  <ArrowDownLeftIcon className="h-3 w-3 mr-1" />
                  Write
                </span>
                <div className="absolute right-full top-1/2 transform -translate-y-1/2 mr-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                  Send data only - share your location and messages
                </div>
              </div>
            )}
            {channel.permissions.includes('readwrite') && (
              <div className="relative group">
                <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-purple-100 text-purple-800 rounded cursor-help">
                  <ArrowsRightLeftIcon className="h-3 w-3 mr-1" />
                  Read/Write
                </span>
                <div className="absolute right-full top-1/2 transform -translate-y-1/2 mr-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                  Full access - send and receive all data
                </div>
              </div>
            )}
          </div>
        </div>
      )
    })
    
    return items
  }

  // Wrapped in useCallback so the effect below can depend on it (satisfying
  // exhaustive-deps) without being recreated every render. It reads `user`
  // (and `canManageTeams`, itself derived from `user`) to decide which
  // admin-scoped stat fetches to include, so those are its dependencies --
  // which preserves the effect's original re-run-on-`user`-change behaviour.
  const fetchChannelData = useCallback(async () => {
    try {
      // Fetch user's team assignment and channel descriptions in parallel
      // (channel descriptions don't depend on the user response)
      // Same dead-localStorage-token issue as fetchConfig above -- both
      // calls were always sending "Bearer null" and never the real
      // session cookie, so they always 401'd. usersAPI/channelsAPI go
      // through the shared, correctly-configured `api` axios instance.
      const [userResponse, channelDescResponse] = await Promise.all([
        usersAPI.getMe(),
        channelsAPI.getDescriptions()
      ])
      
      setFreshUser(userResponse.data.user)
      
      if (userResponse.data.teams && userResponse.data.teams.length > 0) {
        setUserTeam(userResponse.data.teams[0])
      } else {
        setUserTeam(null)
      }
      
      const channelDescriptions = channelDescResponse.data.channels
      
      // Process TAK channels and group by base name
      const takGroups = userResponse.data.user.groups?.filter(groupName => {
        return groupName.startsWith('tak_')
      }) || []
      
      // Create lookup map for descriptions
      const descriptionMap = new Map()
      channelDescriptions.forEach(channel => {
        descriptionMap.set(channel.name, channel)
      })
      
      // Group channels by base name and determine permissions
      const channelMap = new Map()
      
      takGroups.forEach(groupName => {
        let baseName, permission
        
        if (groupName.endsWith('_READ')) {
          baseName = groupName.slice(0, -5) // Remove '_READ'
          permission = 'read'
        } else if (groupName.endsWith('_WRITE')) {
          baseName = groupName.slice(0, -6) // Remove '_WRITE'
          permission = 'write'
        } else {
          baseName = groupName
          permission = 'readwrite'
        }
        
        if (!channelMap.has(baseName)) {
          const channelInfo = descriptionMap.get(baseName)
          channelMap.set(baseName, {
            id: baseName,
            name: baseName,
            display_name: channelInfo?.display_name || baseName.replace('tak_', '').replace(/_/g, ' / '),
            description: channelInfo?.description || 'TAK Channel',
            permissions: new Set()
          })
        }
        
        channelMap.get(baseName).permissions.add(permission)
      })
      
      const takChannels = Array.from(channelMap.values()).map(channel => ({
        ...channel,
        permissions: Array.from(channel.permissions)
      })).sort((a, b) => a.display_name.localeCompare(b.display_name))
      
      setUserChannels(takChannels)

      // Fetch pending-task counts for admins. THREE independent sources feed
      // this one banner: the access_requests-backed requests (any admin),
      // pending Org_Interest_Requests (Global_Manager only, mirroring
      // Layout.jsx's nav badge), and -- bugfix (generic-pending-tasks-banner)
      // -- Team-Owned Device renewals across every team the viewer
      // administers (canManageTeams only, mirroring /tasks' own
      // fetchTeamDevicesNeedingRenewal). Fetched with Promise.allSettled,
      // not Promise.all: a non-global admin has no admin:org_interest:read
      // permission and gets a 403 on that call, which must not blank out
      // the counts they DO have permission for.
      try {
        const promises = [requestsAPI.getPending()]
        if (user?.is_global_manager) {
          promises.push(adminAPI.getOrgInterest({ status: 'pending' }))
        } else {
          promises.push(Promise.resolve(null))
        }
        if (canManageTeams) {
          promises.push(devicesAPI.getAll({ expiringOnly: true, pageSize: 200 }))
        } else {
          promises.push(Promise.resolve(null))
        }

        const [accessRequestsResult, orgInterestResult, teamDeviceRenewalsResult] = await Promise.allSettled(promises)

        const accessRequestsCount =
          accessRequestsResult.status === 'fulfilled'
            ? accessRequestsResult.value.data.requests?.length || 0
            : 0
        const orgInterestCount =
          orgInterestResult.status === 'fulfilled' && orgInterestResult.value
            ? orgInterestResult.value.data.requests?.length || 0
            : 0
        const teamDeviceRenewalsCount =
          teamDeviceRenewalsResult.status === 'fulfilled' && teamDeviceRenewalsResult.value
            ? teamDeviceRenewalsResult.value.data?.devices?.length || 0
            : 0

        setStats({
          accessRequests: accessRequestsCount + orgInterestCount,
          teamDeviceRenewals: teamDeviceRenewalsCount
        })
      } catch (e) {
        setStats({ accessRequests: 0, teamDeviceRenewals: 0 })
      }
    } catch (error) {
      console.error('Failed to fetch channel data:', error)
      setStats({ accessRequests: 0, teamDeviceRenewals: 0 })
    } finally {
      setLoading(false)
    }
  }, [user, canManageTeams])

  useEffect(() => {
    fetchChannelData()
    
    // Listen for user assignment changes
    const handleUserAssignmentChanged = () => {
      fetchChannelData()
    }
    
    window.addEventListener('userAssignmentChanged', handleUserAssignmentChanged)

    // Auto-refresh every 60 seconds, paused when the tab is hidden. This is
    // the same shared mechanism the device card uses -- see
    // `startVisibilityPausedRefresh` at the top of this file.
    const stopRefresh = startVisibilityPausedRefresh(fetchChannelData)

    return () => {
      window.removeEventListener('userAssignmentChanged', handleUserAssignmentChanged)
      stopRefresh()
    }
    // `fetchChannelData` is the dependency (it is memoized on `user`/
    // `canManageTeams`), so the effect still re-subscribes/re-fetches when
    // the user changes, exactly as the former `[user]` dep array did.
  }, [fetchChannelData])


  // Filter channels based on search query
  const filteredChannels = userChannels.filter(channel => 
    channel.display_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    channel.description.toLowerCase().includes(searchQuery.toLowerCase())
  )

  // Pagination logic
  const totalPages = Math.ceil(filteredChannels.length / channelsPerPage)
  const startIndex = (currentPage - 1) * channelsPerPage
  const paginatedChannels = filteredChannels.slice(startIndex, startIndex + channelsPerPage)

  // Reset to first page when search changes and expand relevant folders
  const handleSearchChange = (e) => {
    const query = e.target.value
    setSearchQuery(query)
    setCurrentPage(1)
    
    if (query.trim()) {
      // Auto-expand folders that contain search results
      const searchResults = userChannels.filter(channel => 
        channel.display_name.toLowerCase().includes(query.toLowerCase()) ||
        channel.description.toLowerCase().includes(query.toLowerCase())
      )
      const pathsToExpand = getPathsToChannels(searchResults)
      setExpandedFolders(new Set([...expandedFolders, ...pathsToExpand]))
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Welcome back, {user.first_name}
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          View your TAK profile, devices and channels.
        </p>
      </div>

      {/* TAK Profile */}
      {(freshUser.takRole || freshUser.takColor || freshUser.takCallsign) && (
        <div className="card">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4 flex items-center">
            <IdentificationIcon className="h-5 w-5 mr-2 text-gray-900 dark:text-gray-100" />
            TAK Profile
          </h2>
          {/* 3-column grid: first row My Callsign / My TAK Role / My
              Organisation's Function, second row My Organisation / My Team
              (third cell empty) -- source order drives grid placement, so
              the JSX below is ordered to match rather than relying on any
              explicit grid-column/row utility. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {freshUser.takCallsign && (
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">My Callsign</dt>
                <dd className="text-sm text-gray-900 dark:text-gray-100">{freshUser.takCallsign}</dd>
              </div>
            )}
            {freshUser.takRole && (
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">My TAK Role</dt>
                <dd className="flex items-center text-sm text-gray-900 dark:text-gray-100">
                  {freshUser.takRole}
                  {roleDescriptions[freshUser.takRole] && (
                    // Bugfix (mobile horizontal scroll on /dashboard): this
                    // tooltip's text is an ADMIN-CONFIGURABLE role
                    // description (TAK_ROLE_* / system_config), which can
                    // run to 100+ characters -- see .env.example's seeded
                    // values. `whitespace-nowrap` with no width bound
                    // rendered that as one unbroken line several hundred
                    // pixels wide. Even hidden at `opacity-0`, an absolutely
                    // positioned element's box still counts toward its
                    // ancestors' scrollable overflow, and nothing between
                    // this tooltip and <body> clips `overflow-x` (`.card`
                    // has no `overflow` rule) -- so on a phone-width
                    // viewport that invisible box extended the PAGE's own
                    // scrollable width well past the right edge, which is
                    // exactly "white space on the right that lets you
                    // scroll" with nothing visibly overflowing. `whitespace-
                    // normal w-64` matches the bounded-width convention
                    // every other multi-word tooltip in the app already
                    // uses (`InfoTooltip.jsx`, `TeamDetail.jsx`,
                    // `Teams.jsx`) -- this was the one holdout still using
                    // the old unbounded pattern.
                    <div className="relative group ml-1">
                      <InformationCircleIcon className="h-4 w-4 text-gray-400 cursor-help" />
                      <div className="absolute left-full top-1/2 transform -translate-y-1/2 ml-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-normal w-64 z-10">
                        {roleDescriptions[freshUser.takRole]}
                      </div>
                    </div>
                  )}
                </dd>
              </div>
            )}
            {freshUser.takColor && (
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">My Organisation's Function</dt>
                <dd className="flex items-center text-sm text-gray-900 dark:text-gray-100">
                  {/* Bugfix (Dashboard/Enrollment callsign-and-color
                      divergence): a user with no team now carries the
                      explicit string 'None' here (never a real color
                      name -- see UserAttributesService.clearTeamAttributes),
                      so no swatch is rendered for it. Rendering one would
                      fall back to getTakColorHex's neutral gray, which is
                      itself a color this deployment could plausibly assign
                      -- state must be carried in text, never a colour swatch
                      that could be mistaken for a real value. */}
                  {freshUser.takColor !== 'None' && (
                    <div
                      className="w-4 h-4 rounded border border-gray-300 mr-2"
                      style={{ backgroundColor: getTakColorHex(freshUser.takColor) }}
                    ></div>
                  )}
                  {getOrganizationName(freshUser.takColor)}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">My Organisation</dt>
              {/* Structural Organisation name (teams.name, root of the
                  Ancestor_Chain -- server/routes/users.js's `rt.name`), not
                  the colour-derived "function" shown above. A teamless
                  user carries the literal string 'None', never blank
                  (see the product rule on the None sentinel). */}
              <dd className="text-sm text-gray-900 dark:text-gray-100">{userTeam?.organisation_name || 'None'}</dd>
            </div>
            {/* My Country: a Foreign_Partner Organisation's ISO 3166-1
                country (server/routes/users.js's `rt.country_code`, alpha-3).
                A domestic (NZ) Organisation carries no country_code, and a
                teamless user has no org at all -- the whole row is omitted
                for both (rather than rendering the 'None' sentinel), since
                a domestic org's country is simply not a meaningful fact to
                show every user. The flag glyph is DECORATIVE (aria-hidden);
                the country name and alpha-3 code carry the state in TEXT,
                so a colour/flag never stands alone (the accessibility
                rule). */}
            {(() => {
              const country = getCountry(userTeam?.organisation_country_code)
              if (!country) {
                return null
              }
              return (
                <div>
                  <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">My Country</dt>
                  <dd className="flex items-center text-sm text-gray-900 dark:text-gray-100">
                    <span className={`fi fi-${country.alpha2} mr-2`} aria-hidden="true"></span>
                    {country.name} ({country.alpha3})
                  </dd>
                </div>
              )
            })()}
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">My Team</dt>
              <dd className="flex items-center text-sm text-gray-900 dark:text-gray-100">
                {userTeam ? userTeam.display_name : 'Not assigned to a unit'}
                {userTeam?.visibility === 'private' && (
                  <div className="relative group ml-1">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="h-4 w-4 text-red-500 cursor-help">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                    </svg>
                    <div className="absolute left-full top-1/2 transform -translate-y-1/2 ml-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                      Private team
                    </div>
                  </div>
                )}
              </dd>
              {!userTeam && (
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  Contact your administrator to be assigned to a unit
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Pending Tasks (bugfix: generic-pending-tasks-banner). The heading
          and count cover access requests + Org_Interest_Requests +
          Team-Owned Device renewals; the description line names only the
          category/categories that are actually non-zero, since a fixed
          A-or-B sentence would misdescribe the case where both are
          present. */}
      {(stats.accessRequests + stats.teamDeviceRenewals) > 0 && (
        <div className="card bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800">
          {/* Below `sm`: the icon + text stay on their own row and the
              button drops underneath, full-width -- the previous single
              `flex items-center` row with `ml-auto` squeezed the button
              into whatever width was left beside the icon and two lines
              of text, which is what "all messed up" on a phone. `sm:`
              and up restores the original single-row layout with the
              button pinned to the right via `sm:ml-auto`. */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-center">
              <ClipboardDocumentListIcon className="h-6 w-6 text-yellow-600 dark:text-yellow-400 flex-shrink-0" />
              <div className="ml-3">
                <h3 className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                  You have {stats.accessRequests + stats.teamDeviceRenewals} pending task
                  {(stats.accessRequests + stats.teamDeviceRenewals) !== 1 ? 's' : ''}
                </h3>
                <p className="text-sm text-yellow-700 dark:text-yellow-300">
                  {stats.accessRequests > 0 && stats.teamDeviceRenewals > 0
                    ? 'Review team access requests and device certificate renewals.'
                    : stats.teamDeviceRenewals > 0
                      ? 'Review team device certificate renewals.'
                      : 'Review team access requests from new users.'}
                </p>
              </div>
            </div>
            <div className="sm:ml-auto">
              {/* cert-expiry-notifications Requirement 7.1: points directly
                  at the renamed /tasks route rather than relying on the
                  /requests redirect for a link this codebase itself owns. */}
              <Link to="/tasks" className="btn-primary block text-center sm:inline-block">
                Review Tasks
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* My Devices (Requirements 5.1, 5.2, 5.3) -- rendered only when the
          reachability probe succeeded, i.e. the feature is enabled server-side. */}
      {devicesEnabled && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 flex items-center">
              <DevicePhoneMobileIcon className="h-5 w-5 mr-2 text-gray-900 dark:text-gray-100" />
              My Devices
            </h2>
            <div className="flex items-center space-x-3">
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {devices.length} device{devices.length !== 1 ? 's' : ''}
              </span>
              <Link to="/enrollment" className="btn-primary text-sm">
                Add Device
              </Link>
            </div>
          </div>

          {devicesError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-4">
              {devicesError}
            </p>
          )}

          {/* cert-expiry-notifications Requirement 6: a page-level renew
              prompt, rendered only when at least one device's live
              certificate classifies as imminent or expired -- the SAME
              classification/threshold DeviceListRow/DeviceListCard already
              use below for their own per-row highlighting, no new threshold
              introduced. Deliberately NOT a per-device-row "Renew" button
              (Requirement 6.2): a self-service enrollment mint is not
              scoped to one existing certificate row, so a per-row button
              would misrepresent what clicking it actually does. The
              call-to-action is the SAME /enrollment link "Add Device"
              already points at -- reusing MultipleCertificateWarning.jsx's
              amber-informational-banner treatment (text-carried state,
              InformationCircleIcon, non-alert). */}
          {devices.some(
            (device) =>
              classifyExpiry(device.expiresAt, getExpiryWarningDays(), Date.now()) !== EXPIRY_STATES.NONE
          ) && (
            <p className="flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-400 mb-4">
              <InformationCircleIcon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span>
                One or more of your devices has a certificate expiring soon or expired.{' '}
                <Link to="/enrollment" className="font-medium underline hover:no-underline">
                  Renew now
                </Link>
                .
              </span>
            </p>
          )}

          {devicesLoading ? (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
              <p className="text-gray-500 dark:text-gray-400 mt-2">Loading devices...</p>
            </div>
          ) : devices.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">
              No devices are enrolled under your name.
            </p>
          ) : (
            <>
              {/* Below `sm`: one stacked card per Device instead of a table
                  row -- five columns inside `overflow-x-auto` just scrolls
                  horizontally on a phone-width viewport, which is the
                  "wider than the phone" clutter this replaces. Same
                  `computeDeviceRowState`/`FormattedDate` classification as
                  the table below, just presented as label/value pairs. */}
              <div className="sm:hidden divide-y divide-gray-200 dark:divide-gray-700">
                {devices.map((device) => (
                  <DeviceListCard
                    key={device.clientUid}
                    device={device}
                    onRevoke={setDeviceToRevoke}
                  />
                ))}
              </div>
              <div className="hidden sm:block overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  {/* Requirements 15.6, 16.1-16.6: header and rows both come from
                      `components/DeviceListRow.jsx`, the single definition this
                      card shares with the user-details modal -- including the
                      Device_Type_Icon, the icon-only Revoke action, the "Revoked"
                      badge, and the "never seen" Last_Seen fallback (Req 5.3). */}
                  <thead className="bg-gray-50 dark:bg-gray-700">
                    <DeviceListHeader />
                  </thead>
                  <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                    {devices.map((device) => (
                      <DeviceListRow
                        key={device.clientUid}
                        device={device}
                        onRevoke={setDeviceToRevoke}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* Requirements 7.2, 7.3: the shared REVOKE type-in confirmation dialog.
          No `userId` prop -- that selects the self-service flow. */}
      {deviceToRevoke && (
        <RevokeDeviceDialog
          device={deviceToRevoke}
          onClose={() => setDeviceToRevoke(null)}
          onRevoked={fetchDevices}
        />
      )}

      {/* My Channels */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 flex items-center">
            <SignalIcon className="h-5 w-5 mr-2 text-gray-900 dark:text-gray-100" />
            My Channels
          </h2>
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {filteredChannels.length} of {userChannels.length} channels
            </span>
          </div>
        </div>
        
        {/* Search and Controls */}
        <div className="mb-4 space-y-3">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
            <input
              type="text"
              placeholder="Search channels by name or description..."
              className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400"
              value={searchQuery}
              onChange={handleSearchChange}
            />
          </div>
          
          {filteredChannels.length > 0 && Object.keys(buildFolderTree(filteredChannels, folderSeparator).folders).length > 0 && (
            // Bugfix (mobile tap target too small): py-2 (was py-1) --
            // text-sm's ~20px line-height plus the old 8px vertical
            // padding gave a ~28px-tall button; py-2 (16px) brings it
            // to a real ~36px tap target.
            <div className="flex items-center space-x-2">
              <button
                onClick={expandAllFolders}
                className="inline-flex items-center px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
              >
                <ChevronDownIcon className="h-4 w-4 mr-1" />
                Expand All
              </button>
              <button
                onClick={collapseAllFolders}
                className="inline-flex items-center px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
              >
                <ChevronUpIcon className="h-4 w-4 mr-1" />
                Collapse All
              </button>
            </div>
          )}
        </div>
        
        {userChannels.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-gray-500 dark:text-gray-400 mb-4">
              You don't have access to any TAK channels yet.
            </p>
            {!userTeam && (
              <p className="text-sm text-gray-400 dark:text-gray-500">
                You need to be assigned to a unit to access channels.
              </p>
            )}
          </div>
        ) : filteredChannels.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No channels match your search.
          </p>
        ) : (
          <>
            <div className="space-y-3">
              {renderFolderTree(buildFolderTree(filteredChannels, folderSeparator))}
            </div>

          </>
        )}
      </div>
    </div>
  )
}