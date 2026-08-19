import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { UserGroupIcon, UsersIcon, ClipboardDocumentListIcon, ArrowUpRightIcon, ArrowDownLeftIcon, ArrowsRightLeftIcon, MagnifyingGlassIcon, ChevronLeftIcon, ChevronRightIcon, InformationCircleIcon, FolderIcon, FolderOpenIcon, ChevronRightIcon as ChevronRightSmall, ChevronDownIcon, ChevronUpIcon, SignalIcon } from '@heroicons/react/24/outline'
import { teamsAPI, requestsAPI, configAPI, usersAPI, channelsAPI } from '../services/api'
import { buildFolderTree } from '../utils/channelTree'

export default function Dashboard({ user }) {
  const [stats, setStats] = useState({ requests: 0 })
  const [userTeam, setUserTeam] = useState(null)
  const [userChannels, setUserChannels] = useState([])
  const [freshUser, setFreshUser] = useState(user)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const channelsPerPage = 10
  const [expandedFolders, setExpandedFolders] = useState(new Set())
  const [folderSeparator, setFolderSeparator] = useState(' - ')

  // Map color names to CSS colors
  const getColorValue = (colorName) => {
    const colorMap = {
      'Red': '#ef4444',
      'Blue': '#3b82f6', 
      'Green': '#22c55e',
      'Yellow': '#eab308',
      'Purple': '#a855f7',
      'Orange': '#f97316',
      'Pink': '#ec4899',
      'Cyan': '#06b6d4',
      'Gray': '#6b7280',
      'Black': '#1f2937',
      'White': '#f9fafb',
      'Magenta': '#ec4899',
      'Maroon': '#7f1d1d',
      'Dark Blue': '#1e3a8a',
      'Teal': '#14b8a6',
      'Dark Green': '#166534',
      'Brown': '#92400e'
    }
    return colorMap[colorName] || '#6b7280'
  }

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
        // Render as expandable channel
        items.push(
          <div key={folderPath} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg ml-6">
            <div className="flex items-center flex-1">
              <button
                onClick={() => toggleFolder(folderPath)}
                className="mr-2 p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
              >
                <ChevronRightSmall className={`h-4 w-4 text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
              </button>
              <div className="flex-1">
                <h3 className="font-medium text-gray-900 dark:text-gray-100">{parentChannel.display_name}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {parentChannel.description}
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              {parentChannel.permissions.includes('read') && (
                <div className="relative group">
                  <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-blue-100 text-blue-800 rounded cursor-help">
                    <ArrowUpRightIcon className="h-3 w-3 mr-1" />
                    Read
                  </span>
                  <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                    Receive data only - view others' locations and messages
                    <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
                  </div>
                </div>
              )}
              {parentChannel.permissions.includes('write') && (
                <div className="relative group">
                  <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded cursor-help">
                    <ArrowDownLeftIcon className="h-3 w-3 mr-1" />
                    Write
                  </span>
                  <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                    Send data only - share your location and messages
                    <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
                  </div>
                </div>
              )}
              {parentChannel.permissions.includes('readwrite') && (
                <div className="relative group">
                  <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-purple-100 text-purple-800 rounded cursor-help">
                    <ArrowsRightLeftIcon className="h-3 w-3 mr-1" />
                    Read/Write
                  </span>
                  <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                    Full access - send and receive all data
                    <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      } else {
        // Render as regular folder
        items.push(
          <div key={folderPath}>
            <div 
              className="flex items-center p-3 bg-gray-100 dark:bg-gray-600 rounded-lg cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-500"
              onClick={() => toggleFolder(folderPath)}
            >
              <div className="flex items-center flex-1">
                {isExpanded ? (
                  <FolderOpenIcon className="h-5 w-5 text-blue-600 mr-2" />
                ) : (
                  <FolderIcon className="h-5 w-5 text-blue-600 mr-2" />
                )}
                <span className="font-medium text-gray-900 dark:text-gray-100">{folderName}</span>
              </div>
              <ChevronRightSmall className={`h-4 w-4 text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
            </div>
          </div>
        )
      }
      
      if (isExpanded) {
        items.push(
          <div key={`${folderPath}-children`} className="ml-6 mt-2 space-y-2">
            {renderFolderTree(subtree, folderPath)}
          </div>
        )
      }
    })
    
    // Render regular channels (excluding those that are parent channels)
    const parentChannelNames = new Set(Object.keys(tree.folders))
    tree.channels.filter(c => !parentChannelNames.has(c.display_name)).forEach(channel => {
      items.push(
        <div key={channel.id} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg ml-6">
          <div className="flex-1">
            <h3 className="font-medium text-gray-900 dark:text-gray-100">{channel.display_name}</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {channel.description}
            </p>
          </div>
          <div className="flex items-center space-x-2">
            {channel.permissions.includes('read') && (
              <div className="relative group">
                <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-blue-100 text-blue-800 rounded cursor-help">
                  <ArrowUpRightIcon className="h-3 w-3 mr-1" />
                  Read
                </span>
                <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                  Receive data only - view others' locations and messages
                  <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
                </div>
              </div>
            )}
            {channel.permissions.includes('write') && (
              <div className="relative group">
                <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded cursor-help">
                  <ArrowDownLeftIcon className="h-3 w-3 mr-1" />
                  Write
                </span>
                <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                  Send data only - share your location and messages
                  <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
                </div>
              </div>
            )}
            {channel.permissions.includes('readwrite') && (
              <div className="relative group">
                <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-purple-100 text-purple-800 rounded cursor-help">
                  <ArrowsRightLeftIcon className="h-3 w-3 mr-1" />
                  Read/Write
                </span>
                <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                  Full access - send and receive all data
                  <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
                </div>
              </div>
            )}
          </div>
        </div>
      )
    })
    
    return items
  }

  const fetchChannelData = async () => {
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

      // Fetch pending request count for admins
      try {
        const pendingResponse = await requestsAPI.getPending()
        setStats({ requests: pendingResponse.data.requests?.length || 0 })
      } catch (e) {
        setStats({ requests: 0 })
      }
    } catch (error) {
      console.error('Failed to fetch channel data:', error)
      setStats({ requests: 0 })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchChannelData()
    
    // Listen for user assignment changes
    const handleUserAssignmentChanged = () => {
      fetchChannelData()
    }
    
    window.addEventListener('userAssignmentChanged', handleUserAssignmentChanged)

    // Auto-refresh every 60 seconds, paused when tab is hidden
    const REFRESH_INTERVAL_MS = 60000
    let intervalId = setInterval(fetchChannelData, REFRESH_INTERVAL_MS)

    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearInterval(intervalId)
        intervalId = null
      } else {
        // Tab became visible again — refresh immediately, then restart timer
        fetchChannelData()
        intervalId = setInterval(fetchChannelData, REFRESH_INTERVAL_MS)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('userAssignmentChanged', handleUserAssignmentChanged)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (intervalId) clearInterval(intervalId)
    }
  }, [user])


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
          Welcome back, {user.first_name}!
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          View your TAK team assignment and channel access.
        </p>
      </div>

      {/* TAK Profile */}
      {(freshUser.takRole || freshUser.takColor || freshUser.takCallsign) && (
        <div className="card">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">TAK Profile</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {freshUser.takCallsign && (
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">My Callsign</dt>
                <dd className="text-sm text-gray-900 dark:text-gray-100">{freshUser.takCallsign}</dd>
              </div>
            )}
            {freshUser.takColor && (
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">My Organisation</dt>
                <dd className="flex items-center text-sm text-gray-900 dark:text-gray-100">
                  <div 
                    className="w-4 h-4 rounded border border-gray-300 mr-2" 
                    style={{ backgroundColor: getColorValue(freshUser.takColor) }}
                  ></div>
                  {getOrganizationName(freshUser.takColor)}
                </dd>
              </div>
            )}
            {freshUser.takRole && (
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">My TAK Role</dt>
                <dd className="flex items-center text-sm text-gray-900 dark:text-gray-100">
                  {freshUser.takRole}
                  {roleDescriptions[freshUser.takRole] && (
                    <div className="relative group ml-1">
                      <InformationCircleIcon className="h-4 w-4 text-gray-400 cursor-help" />
                      <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                        {roleDescriptions[freshUser.takRole]}
                        <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
                      </div>
                    </div>
                  )}
                </dd>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <UserGroupIcon className="h-8 w-8 text-gray-500 dark:text-gray-400" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">My Team</p>
              <div className="flex items-center space-x-2">
                <p className="text-lg font-bold text-gray-900 dark:text-gray-100">
                  {userTeam ? userTeam.display_name : 'Not assigned to a unit'}
                </p>
                {userTeam?.visibility === 'private' && (
                  <div className="relative group">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="h-4 w-4 text-red-500 cursor-help">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                    </svg>
                    <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                      Private team
                      <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
                    </div>
                  </div>
                )}
              </div>
              {!userTeam && (
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  Contact your administrator to be assigned to a unit
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <ClipboardDocumentListIcon className="h-8 w-8 text-gray-500 dark:text-gray-400" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Pending Requests</p>
              {stats.requests > 0 ? <Link to="/requests" className="text-2xl font-bold text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300">{stats.requests}</Link> : <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.requests}</p>}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <SignalIcon className="h-8 w-8 text-gray-500 dark:text-gray-400" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Channels</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {filteredChannels.length}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* My Channels */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">My Channels</h2>
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
            <div className="flex items-center space-x-2">
              <button
                onClick={expandAllFolders}
                className="inline-flex items-center px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
              >
                <ChevronDownIcon className="h-4 w-4 mr-1" />
                Expand All
              </button>
              <button
                onClick={collapseAllFolders}
                className="inline-flex items-center px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
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

      {/* Quick Actions */}
      {stats.requests > 0 && (
        <div className="card bg-yellow-50 border-yellow-200">
          <div className="flex items-center">
            <ClipboardDocumentListIcon className="h-6 w-6 text-yellow-600" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-yellow-800">
                You have {stats.requests} pending request{stats.requests !== 1 ? 's' : ''}
              </h3>
              <p className="text-sm text-yellow-700">
                Review team access requests from new users.
              </p>
            </div>
            <div className="ml-auto">
              <Link to="/requests" className="btn-primary">
                Review Requests
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}