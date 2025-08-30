import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { UserGroupIcon, UsersIcon, ClipboardDocumentListIcon, ArrowUpRightIcon, ArrowDownLeftIcon, ArrowsRightLeftIcon, MagnifyingGlassIcon, ChevronLeftIcon, ChevronRightIcon, InformationCircleIcon, FolderIcon, FolderOpenIcon, ChevronRightIcon as ChevronRightSmall, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline'
import { teamsAPI, requestsAPI } from '../services/api'
import axios from 'axios'

export default function Dashboard({ user }) {
  const [stats, setStats] = useState({ requests: 0 })
  const [userTeam, setUserTeam] = useState(null)
  const [userChannels, setUserChannels] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const channelsPerPage = 10
  const [expandedFolders, setExpandedFolders] = useState(new Set())
  const [folderSeparator, setFolderSeparator] = useState(' / ')

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
        const [colorResponse, publicResponse] = await Promise.all([
          axios.get('/api/config/color-mappings', {
            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
          }),
          axios.get('/api/config/public')
        ])
        setColorMappings(colorResponse.data.colorMappings)
        setRoleDescriptions(colorResponse.data.roleDescriptions)
        setFolderSeparator(publicResponse.data.channel_folder_separator || ' / ')
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

  // Build folder tree from channels
  const buildFolderTree = (channels) => {
    const tree = { folders: {}, channels: [] }
    
    channels.forEach(channel => {
      const parts = channel.display_name.split(folderSeparator)
      if (parts.length === 1) {
        tree.channels.push(channel)
      } else {
        let current = tree
        for (let i = 0; i < parts.length - 1; i++) {
          const folderName = parts[i].trim()
          if (!current.folders[folderName]) {
            current.folders[folderName] = { folders: {}, channels: [] }
          }
          current = current.folders[folderName]
        }
        current.channels.push({
          ...channel,
          display_name: parts[parts.length - 1].trim()
        })
      }
    })
    
    return tree
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
    const allPaths = getAllFolderPaths(buildFolderTree(filteredChannels))
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
          {isExpanded && (
            <div className="ml-6 mt-2 space-y-2">
              {renderFolderTree(subtree, folderPath)}
            </div>
          )}
        </div>
      )
    })
    
    // Render channels
    tree.channels.forEach(channel => {
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

  useEffect(() => {
    const fetchChannelData = async () => {
      try {
        // Fetch channel descriptions from API
        const response = await axios.get('/api/channels/descriptions', {
          headers: {
            Authorization: `Bearer ${localStorage.getItem('token')}`
          }
        })
        
        const channelDescriptions = response.data.channels
        
        // Process TAK channels and group by base name
        const takGroups = user.groups?.filter(groupName => {
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
        setStats({ requests: 0 })
      } catch (error) {
        console.error('Failed to fetch channel data:', error)
        setStats({ requests: 0 })
      } finally {
        setLoading(false)
      }
    }

    fetchChannelData()
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
      {(user.takRole || user.takColor || user.takCallsign) && (
        <div className="card">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">TAK Profile</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {user.takCallsign && (
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">My Callsign</dt>
                <dd className="text-sm text-gray-900 dark:text-gray-100">{user.takCallsign}</dd>
              </div>
            )}
            {user.takColor && (
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">My Team</dt>
                <dd className="flex items-center text-sm text-gray-900 dark:text-gray-100">
                  <div 
                    className="w-4 h-4 rounded border border-gray-300 mr-2" 
                    style={{ backgroundColor: getColorValue(user.takColor) }}
                  ></div>
                  {getOrganizationName(user.takColor)}
                </dd>
              </div>
            )}
            {user.takRole && (
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">My Role</dt>
                <dd className="flex items-center text-sm text-gray-900 dark:text-gray-100">
                  {user.takRole}
                  {roleDescriptions[user.takRole] && (
                    <div className="relative group ml-1">
                      <InformationCircleIcon className="h-4 w-4 text-gray-400 cursor-help" />
                      <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                        {roleDescriptions[user.takRole]}
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
              <UserGroupIcon className="h-8 w-8 text-primary-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">My Unit</p>
              <p className="text-lg font-bold text-gray-900 dark:text-gray-100">
                {userTeam ? userTeam.name : 'Not assigned to a unit'}
              </p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <ClipboardDocumentListIcon className="h-8 w-8 text-yellow-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Pending Requests</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.requests}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <UsersIcon className="h-8 w-8 text-green-600" />
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
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {filteredChannels.length} of {userChannels.length} channels
          </span>
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
          
          {filteredChannels.length > 0 && Object.keys(buildFolderTree(filteredChannels).folders).length > 0 && (
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
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            You don't have access to any TAK channels yet.
          </p>
        ) : filteredChannels.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No channels match your search.
          </p>
        ) : (
          <>
            <div className="space-y-3">
              {renderFolderTree(buildFolderTree(filteredChannels))}
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