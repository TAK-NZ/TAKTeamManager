import { useState, useEffect } from 'react'
import React from 'react'
import { useParams, Link } from 'react-router-dom'
import { PlusIcon, UsersIcon, UserPlusIcon, ShieldCheckIcon, BuildingOfficeIcon, FolderPlusIcon, HashtagIcon, XMarkIcon, MagnifyingGlassIcon, ChevronUpIcon, ChevronDownIcon, TrashIcon, PencilIcon, CheckIcon } from '@heroicons/react/24/outline'
import { teamsAPI, channelsAPI, usersAPI } from '../services/api'

export default function TeamDetail({ refreshUser }) {
  const { teamId } = useParams()
  const [team, setTeam] = useState(null)
  const [members, setMembers] = useState([])
  const [admins, setAdmins] = useState([])
  const [channels, setChannels] = useState([])
  const [subTeams, setSubTeams] = useState([])
  const [parentTeam, setParentTeam] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeTab, setActiveTab] = useState('members')
  const [searchTerms, setSearchTerms] = useState({
    members: '',
    admins: '',
    channels: '',
    subteams: ''
  })
  const [sortFields, setSortFields] = useState({
    members: 'first_name',
    admins: 'first_name',
    channels: 'display_name',
    subteams: 'name'
  })
  const [sortDirections, setSortDirections] = useState({
    members: 'asc',
    admins: 'asc',
    channels: 'asc',
    subteams: 'asc'
  })
  const [currentPages, setCurrentPages] = useState({
    members: 1,
    admins: 1,
    channels: 1,
    subteams: 1
  })
  const itemsPerPage = 15
  const [showSubTeamDialog, setShowSubTeamDialog] = useState(false)
  const [subTeamFormData, setSubTeamFormData] = useState({
    name: '',
    description: '',
    callsignPrefix: '',
    visibility: 'public',
    canJoin: false
  })
  const [creatingSubTeam, setCreatingSubTeam] = useState(false)
  const [deleteSubTeamId, setDeleteSubTeamId] = useState(null)
  const [deletingSubTeam, setDeletingSubTeam] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [editFormData, setEditFormData] = useState({
    name: '',
    description: '',
    callsignPrefix: '',
    visibility: 'public',
    canJoin: false,
    parentTeamId: null,
    callsignSubteamDepth: 1,
    callsignNameFormat: 'full_name'
  })
  const [allTeams, setAllTeams] = useState([])
  const [updating, setUpdating] = useState(false)
  const [showChannelDialog, setShowChannelDialog] = useState(false)
  const [channelFormData, setChannelFormData] = useState({
    customSuffix: '',
    memberPermissions: []
  })
  const [creatingChannel, setCreatingChannel] = useState(false)
  const [showAddMemberDialog, setShowAddMemberDialog] = useState(false)
  const [addMemberTab, setAddMemberTab] = useState('existing')
  const [availableUsers, setAvailableUsers] = useState([])
  const [userSearch, setUserSearch] = useState('')
  const [selectedUserId, setSelectedUserId] = useState('')
  const [newUserForm, setNewUserForm] = useState({
    email: '',
    firstName: '',
    lastName: ''
  })
  const [addingMember, setAddingMember] = useState(false)
  const [removeUserId, setRemoveUserId] = useState(null)
  const [removeUserRole, setRemoveUserRole] = useState('')
  const [removingUser, setRemovingUser] = useState(false)

  const handleCreateSubTeam = async (e) => {
    e.preventDefault()
    setCreatingSubTeam(true)
    try {
      const subTeamData = {
        ...subTeamFormData,
        color: team.color, // Inherit parent's color
        parentTeamId: team.id
      }
      
      const response = await teamsAPI.create(subTeamData)
      
      // Add new sub-team to the list
      setSubTeams([...subTeams, response.data.team])
      
      // Reset form and close dialog
      setSubTeamFormData({
        name: '',
        description: '',
        callsignPrefix: '',
        visibility: 'public',
        canJoin: false
      })
      setShowSubTeamDialog(false)
    } catch (error) {
      console.error('Failed to create sub-team:', error)
      alert('Failed to create sub-team: ' + (error.response?.data?.error || error.message))
    } finally {
      setCreatingSubTeam(false)
    }
  }

  const handleDeleteSubTeam = async () => {
    if (!deleteSubTeamId) return
    
    setDeletingSubTeam(true)
    try {
      await teamsAPI.delete(deleteSubTeamId)
      setSubTeams(subTeams.filter(team => team.id !== deleteSubTeamId))
      setDeleteSubTeamId(null)
    } catch (error) {
      console.error('Failed to delete sub-team:', error)
      alert('Failed to delete sub-team: ' + (error.response?.data?.error || error.message))
    } finally {
      setDeletingSubTeam(false)
    }
  }

  const handleCreateChannel = async (e) => {
    e.preventDefault()
    setCreatingChannel(true)
    try {
      const response = await channelsAPI.createCustom(
        team.id, 
        channelFormData.customSuffix, 
        channelFormData.memberPermissions
      )
      
      setChannels([...channels, response.data.channel])
      setChannelFormData({ customSuffix: '', memberPermissions: [] })
      setShowChannelDialog(false)
    } catch (error) {
      console.error('Failed to create channel:', error)
      alert('Failed to create channel: ' + (error.response?.data?.error || error.message))
    } finally {
      setCreatingChannel(false)
    }
  }

  const toggleMemberPermission = (memberId, permission) => {
    const existing = channelFormData.memberPermissions.find(mp => mp.userId === memberId)
    let newPermissions
    
    if (existing) {
      if (existing.permission === permission) {
        // Remove if same permission clicked
        newPermissions = channelFormData.memberPermissions.filter(mp => mp.userId !== memberId)
      } else {
        // Update permission
        newPermissions = channelFormData.memberPermissions.map(mp => 
          mp.userId === memberId ? { ...mp, permission } : mp
        )
      }
    } else {
      // Add new permission
      newPermissions = [...channelFormData.memberPermissions, { userId: memberId, permission }]
    }
    
    setChannelFormData({ ...channelFormData, memberPermissions: newPermissions })
  }

  const getMemberPermission = (memberId) => {
    return channelFormData.memberPermissions.find(mp => mp.userId === memberId)?.permission
  }

  const fetchAvailableUsers = async (search = '') => {
    try {
      const response = await usersAPI.getAvailable(search)
      setAvailableUsers(response.data.users)
    } catch (error) {
      console.error('Failed to fetch available users:', error)
    }
  }

  const handleAddExistingUser = async () => {
    if (!selectedUserId) return
    
    setAddingMember(true)
    try {
      await usersAPI.addToTeam(selectedUserId, team.id)
      
      // Refresh team data
      const teamResponse = await teamsAPI.getById(team.id)
      const allMembers = teamResponse.data.members || []
      setMembers(allMembers.filter(m => m.role === 'member'))
      setAdmins(allMembers.filter(m => m.role === 'admin'))
      
      // Notify Dashboard to refresh
      window.dispatchEvent(new CustomEvent('userAssignmentChanged'))
      
      setShowAddMemberDialog(false)
      setSelectedUserId('')
      setUserSearch('')
    } catch (error) {
      console.error('Failed to add user:', error)
      alert('Failed to add user: ' + (error.response?.data?.error || error.message))
    } finally {
      setAddingMember(false)
    }
  }

  const handleCreateNewUser = async (e) => {
    e.preventDefault()
    setAddingMember(true)
    try {
      await usersAPI.createAndAdd(
        newUserForm.email,
        newUserForm.firstName,
        newUserForm.lastName,
        team.id
      )
      
      // Refresh team data
      const teamResponse = await teamsAPI.getById(team.id)
      const allMembers = teamResponse.data.members || []
      setMembers(allMembers.filter(m => m.role === 'member'))
      setAdmins(allMembers.filter(m => m.role === 'admin'))
      
      // Notify Dashboard to refresh
      window.dispatchEvent(new CustomEvent('userAssignmentChanged'))
      
      setShowAddMemberDialog(false)
      setNewUserForm({ email: '', firstName: '', lastName: '' })
    } catch (error) {
      console.error('Failed to create user:', error)
      alert('Failed to create user: ' + (error.response?.data?.error || error.message))
    } finally {
      setAddingMember(false)
    }
  }

  // Fetch available users when dialog opens
  React.useEffect(() => {
    if (showAddMemberDialog && addMemberTab === 'existing') {
      fetchAvailableUsers(userSearch)
    }
  }, [showAddMemberDialog, addMemberTab, userSearch])

  const handleRemoveUser = (userId, role) => {
    setRemoveUserId(userId)
    setRemoveUserRole(role)
  }

  const confirmRemoveUser = async () => {
    if (!removeUserId) return
    
    setRemovingUser(true)
    try {
      await usersAPI.removeFromTeam(removeUserId, team.id)
      
      // Refresh team data
      const teamResponse = await teamsAPI.getById(team.id)
      const allMembers = teamResponse.data.members || []
      setMembers(allMembers.filter(m => m.role === 'member'))
      setAdmins(allMembers.filter(m => m.role === 'admin'))
      
      // Refresh channels to update member counts
      const channelsResponse = await channelsAPI.getByTeam(team.id)
      setChannels(channelsResponse.data.channels || [])
      
      // Notify Dashboard to refresh
      window.dispatchEvent(new CustomEvent('userAssignmentChanged'))
      
      setRemoveUserId(null)
      setRemoveUserRole('')
    } catch (error) {
      console.error('Failed to remove user:', error)
      alert('Failed to remove user: ' + (error.response?.data?.error || error.message))
    } finally {
      setRemovingUser(false)
    }
  }

  // Map color names to CSS colors (same as Dashboard)
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

  useEffect(() => {
    let isCancelled = false
    
    const fetchTeamData = async () => {
      if (isCancelled) return
      
      try {
        const teamResponse = await teamsAPI.getById(teamId)
        
        if (isCancelled) return
        
        const teamData = teamResponse.data.team
        const allMembers = teamResponse.data.members || []
        
        setTeam(teamData)
        setMembers(allMembers.filter(m => m.role === 'member'))
        setAdmins(allMembers.filter(m => m.role === 'admin'))
        // Channels will be fetched separately with member counts
        
        // Fetch parent team if exists, otherwise clear it
        if (teamData.parent_team_id && !isCancelled) {
          try {
            const parentResponse = await teamsAPI.getById(teamData.parent_team_id)
            if (!isCancelled) {
              setParentTeam(parentResponse.data.team)
            }
          } catch (err) {
            console.error('Failed to fetch parent team:', err)
            if (!isCancelled) {
              setParentTeam(null)
            }
          }
        } else {
          setParentTeam(null)
        }
        
        // Fetch sub-teams and all teams for parent selection
        if (!isCancelled) {
          try {
            const [subTeamsResponse, allTeamsResponse] = await Promise.all([
              teamsAPI.getSubTeams(teamId),
              teamsAPI.getMyTeams()
            ])
            if (!isCancelled) {
              setSubTeams(subTeamsResponse.data.subTeams || [])
              setAllTeams(allTeamsResponse.data.teams || [])
            }
          } catch (err) {
            console.error('Failed to fetch teams:', err)
            if (!isCancelled) {
              setSubTeams([])
              setAllTeams([])
            }
          }
        }
        

        
        // Fetch channels with member counts
        try {
          const channelsResponse = await channelsAPI.getByTeam(teamId);
          setChannels(channelsResponse.data.channels || []);
        } catch (channelError) {
          console.error('Error fetching channels with counts:', channelError);
          setChannels([]);
        }
      } catch (error) {
        console.error('Failed to fetch team data:', error)
        if (!isCancelled) {
          setError(error.message)
        }
      }
      
      if (!isCancelled) {
        setLoading(false)
      }
    }

    fetchTeamData()
    
    return () => {
      isCancelled = true
    }
  }, [teamId])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="card text-center py-12">
        <h3 className="text-lg font-medium text-gray-900 mb-2">Error loading team</h3>
        <p className="text-gray-500">{error}</p>
      </div>
    )
  }



  if (!team && !loading) {
    return (
      <div className="card text-center py-12">
        <h3 className="text-lg font-medium text-gray-900 mb-2">Team not found</h3>
        <p className="text-gray-500">The team you're looking for doesn't exist or you don't have access.</p>
      </div>
    )
  }

  // Generic filter and sort function
  const filterAndSort = (items, searchTerm, sortField, sortDirection) => {
    let filtered = items
    
    if (searchTerm) {
      filtered = items.filter(item => {
        const searchableText = Object.values(item).join(' ').toLowerCase()
        return searchableText.includes(searchTerm.toLowerCase())
      })
    }
    
    return filtered.sort((a, b) => {
      let aValue = a[sortField] || ''
      let bValue = b[sortField] || ''
      
      if (typeof aValue === 'string') {
        aValue = aValue.toLowerCase()
        bValue = bValue.toLowerCase()
      }
      
      if (sortDirection === 'asc') {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0
      } else {
        return aValue > bValue ? -1 : aValue < bValue ? 1 : 0
      }
    })
  }

  // Process data for each tab
  const processedData = {
    members: filterAndSort(members, searchTerms.members, sortFields.members, sortDirections.members),
    admins: filterAndSort(admins, searchTerms.admins, sortFields.admins, sortDirections.admins),
    channels: filterAndSort(channels, searchTerms.channels, sortFields.channels, sortDirections.channels),
    subteams: filterAndSort(subTeams, searchTerms.subteams, sortFields.subteams, sortDirections.subteams)
  }

  // Pagination for current tab
  const currentData = processedData[activeTab]
  const totalPages = Math.ceil(currentData.length / itemsPerPage)
  const startIndex = (currentPages[activeTab] - 1) * itemsPerPage
  const paginatedData = currentData.slice(startIndex, startIndex + itemsPerPage)

  const handleSort = (field) => {
    const currentSortField = sortFields[activeTab]
    const currentSortDirection = sortDirections[activeTab]
    
    setSortFields({
      ...sortFields,
      [activeTab]: field
    })
    
    setSortDirections({
      ...sortDirections,
      [activeTab]: currentSortField === field && currentSortDirection === 'asc' ? 'desc' : 'asc'
    })
    
    setCurrentPages({
      ...currentPages,
      [activeTab]: 1
    })
  }

  const getSortIcon = (field) => {
    if (sortFields[activeTab] !== field) return null
    return sortDirections[activeTab] === 'asc' ? 
      <ChevronUpIcon className="h-4 w-4" /> : 
      <ChevronDownIcon className="h-4 w-4" />
  }

  const handleSearch = (value) => {
    setSearchTerms({
      ...searchTerms,
      [activeTab]: value
    })
    setCurrentPages({
      ...currentPages,
      [activeTab]: 1
    })
  }

  const handlePageChange = (page) => {
    setCurrentPages({
      ...currentPages,
      [activeTab]: page
    })
  }

  return (
    <div className="space-y-6">
      {/* Team Header */}
      <div className="card">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="flex-1">
            <div className="flex items-center space-x-2 mb-2">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {team.parent_team_id ? `${parentTeam?.callsign_prefix || parentTeam?.name || 'Root'} - ${team.name}` : team.name}
              </h1>
              {team.color && (
                <div 
                  className="w-4 h-4 rounded border border-gray-300" 
                  style={{ backgroundColor: getColorValue(team.color) }}
                  title={team.color}
                ></div>
              )}
            </div>
            {team.parent_team_id && (
              <div className="mb-3">
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  <span className="font-medium">Team Name:</span> {team.name}
                </div>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  <span className="font-medium">Display Name:</span> {parentTeam?.callsign_prefix || parentTeam?.name || 'Root'} - {team.name}
                </div>
              </div>
            )}
            <p className="text-gray-600 dark:text-gray-400 mb-3">{team.description || 'No description provided'}</p>
            <div className="space-y-2">
              <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                <BuildingOfficeIcon className="h-4 w-4 mr-1" />
                <span>Parent Team: </span>
                {parentTeam ? (
                  <Link 
                    to={`/teams/${parentTeam.id}`}
                    className="ml-1 text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300"
                  >
                    {parentTeam.name}
                  </Link>
                ) : (
                  <Link 
                    to="/teams"
                    className="ml-1 text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300"
                  >
                    Root
                  </Link>
                )}
              </div>
              
              <div className="flex items-center flex-wrap gap-x-4 gap-y-2 text-sm text-gray-500 dark:text-gray-400">
                <div className="flex items-center">
                  <span>Visibility: </span>
                  <span className={`ml-1 px-2 py-1 text-xs font-medium rounded-full ${
                    team.visibility === 'public' 
                      ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                      : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
                  }`}>
                    {team.visibility === 'public' ? 'Public' : 'Private'}
                  </span>
                </div>
                
                <div className="flex items-center">
                  <span>Join Requests: </span>
                  <span className={`ml-1 px-2 py-1 text-xs font-medium rounded-full ${
                    team.can_join 
                      ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                      : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
                  }`}>
                    {team.can_join ? 'Allowed' : 'Disabled'}
                  </span>
                </div>
                
                {!team.parent_team_id && (
                  <div className="flex items-center">
                    <span>Callsign: </span>
                    <span className="ml-1 px-2 py-1 text-xs font-medium rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
                      Depth {team.callsign_subteam_depth || 1}
                    </span>
                    <span className="ml-1 px-2 py-1 text-xs font-medium rounded-full bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200">
                      {team.callsign_name_format === 'first_initial_last' ? 'J Doe' : 
                       team.callsign_name_format === 'first_last_initial' ? 'John D' : 'John Doe'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-2 lg:items-end">
            <div className="flex flex-wrap gap-2">
              <button 
                onClick={() => {
                  setEditFormData({
                    name: team.name,
                    description: team.description || '',
                    callsignPrefix: team.callsign_prefix || '',
                    visibility: team.visibility || 'private',
                    canJoin: team.can_join || false,
                    parentTeamId: team.parent_team_id || null,
                    callsignSubteamDepth: team.callsign_subteam_depth || 1,
                    callsignNameFormat: team.callsign_name_format || 'full_name'
                  })
                  setShowEditDialog(true)
                }}
                className="btn-secondary flex items-center"
              >
                <PencilIcon className="h-4 w-4 mr-2" />
                Edit Team
              </button>
              <button 
                onClick={() => setShowAddMemberDialog(true)}
                className="btn-secondary flex items-center"
              >
                <UserPlusIcon className="h-4 w-4 mr-2" />
                Add Member
              </button>
              <button className="btn-secondary flex items-center">
                <ShieldCheckIcon className="h-4 w-4 mr-2" />
                Add Admin
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <button 
                onClick={() => setShowSubTeamDialog(true)}
                className="btn-secondary flex items-center"
              >
                <FolderPlusIcon className="h-4 w-4 mr-2" />
                Add Sub-team
              </button>
              <button 
                onClick={() => setShowChannelDialog(true)}
                disabled={channels.length >= 3}
                className={`btn-primary flex items-center ${channels.length >= 3 ? 'opacity-50 cursor-not-allowed' : ''}`}
                title={channels.length >= 3 ? 'Maximum 3 channels allowed' : 'Create custom channel'}
              >
                <HashtagIcon className="h-4 w-4 mr-2" />
                Create Channel ({channels.length}/3)
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Tabbed Interface */}
      <div className="card">
        {/* Tab Navigation */}
        <div className="border-b border-gray-200 dark:border-gray-700">
          <nav className="-mb-px flex space-x-8">
            {[
              { id: 'members', label: 'Members', icon: UsersIcon, count: members.length },
              { id: 'admins', label: 'Team Admins', icon: ShieldCheckIcon, count: admins.length },
              { id: 'channels', label: 'Channels', icon: HashtagIcon, count: channels.length },
              { id: 'subteams', label: 'Sub-teams', icon: BuildingOfficeIcon, count: subTeams.length }
            ].map((tab) => {
              const Icon = tab.icon
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center py-4 px-1 border-b-2 font-medium text-sm ${
                    activeTab === tab.id
                      ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                  }`}
                >
                  <Icon className="h-5 w-5 mr-2" />
                  {tab.label} ({tab.count})
                </button>
              )
            })}
          </nav>
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {/* Search Bar */}
          <div className="mb-4 flex items-center space-x-4">
            <div className="flex-1">
              <input
                type="text"
                placeholder={`Search ${activeTab}...`}
                value={searchTerms[activeTab]}
                onChange={(e) => handleSearch(e.target.value)}
                className="input w-full max-w-md"
              />
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {currentData.length} {activeTab}
            </div>
          </div>

          {/* Content based on active tab */}
          {activeTab === 'members' && (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th onClick={() => handleSort('first_name')} className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">
                      <div className="flex items-center space-x-1">
                        <span>Name</span>
                        {getSortIcon('first_name')}
                      </div>
                    </th>
                    <th onClick={() => handleSort('email')} className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">
                      <div className="flex items-center space-x-1">
                        <span>Email</span>
                        {getSortIcon('email')}
                      </div>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Role
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
                  {paginatedData.map((member) => (
                    <tr key={member.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-gray-100">
                        {member.first_name} {member.last_name}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                        {member.email}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="px-2 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-800 dark:bg-gray-600 dark:text-gray-200">
                          Member
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button
                          onClick={() => handleRemoveUser(member.id, 'member')}
                          className="text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300"
                          title="Remove from team"
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'admins' && (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th onClick={() => handleSort('first_name')} className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">
                      <div className="flex items-center space-x-1">
                        <span>Name</span>
                        {getSortIcon('first_name')}
                      </div>
                    </th>
                    <th onClick={() => handleSort('email')} className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">
                      <div className="flex items-center space-x-1">
                        <span>Email</span>
                        {getSortIcon('email')}
                      </div>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Role
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
                  {paginatedData.map((admin) => (
                    <tr key={admin.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-gray-100">
                        {admin.first_name} {admin.last_name}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                        {admin.email}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="px-2 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                          Admin
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button
                          onClick={() => handleRemoveUser(admin.id, 'admin')}
                          className="text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300"
                          title="Remove from team"
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'channels' && (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th onClick={() => handleSort('display_name')} className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">
                      <div className="flex items-center space-x-1">
                        <span>Channel Name</span>
                        {getSortIcon('display_name')}
                      </div>
                    </th>
                    <th onClick={() => handleSort('channel_type')} className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">
                      <div className="flex items-center space-x-1">
                        <span>Type</span>
                        {getSortIcon('channel_type')}
                      </div>
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Members
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
                  {paginatedData.map((channel) => (
                    <tr key={channel.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-gray-100">
                        {channel.display_name}
                        {channel.custom_suffix && (
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            Suffix: {channel.custom_suffix}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                          channel.channel_type === 'primary' 
                            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                            : 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                        }`}>
                          {channel.channel_type === 'primary' ? 'Primary' : 'Custom'}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                        {channel.member_count || 0} members
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {channel.authentik_group_id && (
                          <span className="px-2 py-1 text-xs font-medium rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
                            Synced
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'subteams' && (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th onClick={() => handleSort('name')} className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">
                      <div className="flex items-center space-x-1">
                        <span>Team Name</span>
                        {getSortIcon('name')}
                      </div>
                    </th>
                    <th onClick={() => handleSort('callsign_prefix')} className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">
                      <div className="flex items-center space-x-1">
                        <span>Prefix</span>
                        {getSortIcon('callsign_prefix')}
                      </div>
                    </th>
                    <th onClick={() => handleSort('member_count')} className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">
                      <div className="flex items-center space-x-1">
                        <span>Members</span>
                        {getSortIcon('member_count')}
                      </div>
                    </th>
                    <th onClick={() => handleSort('sub_teams_count')} className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">
                      <div className="flex items-center space-x-1">
                        <span>Sub-teams</span>
                        {getSortIcon('sub_teams_count')}
                      </div>
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
                  {paginatedData.map((subTeam) => (
                    <tr key={subTeam.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="relative group">
                          <Link
                            to={`/teams/${subTeam.id}`}
                            className="text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-primary-600 dark:hover:text-primary-400 cursor-pointer"
                          >
                            {subTeam.name}
                          </Link>
                          {subTeam.description && (
                            <div className="absolute bottom-full left-0 mb-2 px-3 py-2 bg-gray-900 text-white text-sm rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10 whitespace-normal w-64">
                              {subTeam.description}
                              <div className="absolute top-full left-4 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900"></div>
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                        {subTeam.callsign_prefix || '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                        {subTeam.member_count || 0}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                        {subTeam.sub_teams_count || 0}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center justify-end space-x-3">
                          <Link
                            to={`/teams/${subTeam.id}`}
                            className="text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300"
                            title="View team details"
                          >
                            <MagnifyingGlassIcon className="h-4 w-4" />
                          </Link>
                          {(subTeam.sub_teams_count || 0) === 0 && (
                            <button
                              onClick={() => setDeleteSubTeamId(subTeam.id)}
                              className="text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300"
                              title="Delete sub-team"
                            >
                              <TrashIcon className="h-4 w-4" />
                            </button>
                          )}
                          {(subTeam.sub_teams_count || 0) > 0 && (
                            <button
                              disabled
                              className="text-gray-400 dark:text-gray-600 cursor-not-allowed"
                              title="Cannot delete team with sub-teams"
                            >
                              <TrashIcon className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Empty State */}
          {paginatedData.length === 0 && (
            <div className="text-center py-8">
              <p className="text-gray-500 dark:text-gray-400">
                {searchTerms[activeTab] ? `No ${activeTab} found matching your search.` : `No ${activeTab} yet.`}
              </p>
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-6 flex items-center justify-between">
              <div className="text-sm text-gray-500 dark:text-gray-400">
                Showing {startIndex + 1} to {Math.min(startIndex + itemsPerPage, currentData.length)} of {currentData.length} {activeTab}
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => handlePageChange(Math.max(1, currentPages[activeTab] - 1))}
                  disabled={currentPages[activeTab] === 1}
                  className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  Page {currentPages[activeTab]} of {totalPages}
                </span>
                <button
                  onClick={() => handlePageChange(Math.min(totalPages, currentPages[activeTab] + 1))}
                  disabled={currentPages[activeTab] === totalPages}
                  className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create Sub-Team Dialog */}
      {showSubTeamDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Create Sub-Team</h3>
              <button
                onClick={() => setShowSubTeamDialog(false)}
                className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            
            <form onSubmit={handleCreateSubTeam} className="p-6">
              <div className="space-y-6">
                {/* Parent Team Info */}
                <div className="bg-gray-50 dark:bg-gray-700 p-4 rounded-lg">
                  <div className="flex items-center space-x-2 mb-2">
                    <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Parent Team:</h4>
                    <div className="relative group">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 cursor-help">
                        {team.name}
                      </span>
                      {team.description && (
                        <div className="absolute bottom-full left-0 mb-2 px-3 py-2 bg-gray-900 text-white text-sm rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10 whitespace-normal w-64">
                          {team.description}
                          <div className="absolute top-full left-4 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900"></div>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-xs text-gray-500 dark:text-gray-400">Inherited TAK Color:</span>
                    {team.color && (
                      <div className="flex items-center space-x-1">
                        <div 
                          className="w-3 h-3 rounded border border-gray-300" 
                          style={{ backgroundColor: getColorValue(team.color) }}
                        ></div>
                        <span className="text-xs text-gray-600 dark:text-gray-400">{team.color}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Sub-Team Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={subTeamFormData.name}
                    onChange={(e) => setSubTeamFormData({...subTeamFormData, name: e.target.value})}
                    className="input w-full"
                    placeholder="Enter sub-team name"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Description
                  </label>
                  <textarea
                    value={subTeamFormData.description}
                    onChange={(e) => setSubTeamFormData({...subTeamFormData, description: e.target.value})}
                    className="input w-full"
                    rows={3}
                    placeholder="Enter sub-team description and purpose"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Prefix
                  </label>
                  <input
                    type="text"
                    value={subTeamFormData.callsignPrefix}
                    onChange={(e) => setSubTeamFormData({...subTeamFormData, callsignPrefix: e.target.value})}
                    className="input w-full"
                    placeholder="STL, AKL, etc."
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Used to build callsigns. Example: FENZ-STL-John Smith
                  </p>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Visibility
                  </label>
                  <select
                    value={subTeamFormData.visibility}
                    onChange={(e) => setSubTeamFormData({...subTeamFormData, visibility: e.target.value})}
                    className="input w-full"
                    disabled={team.visibility === 'private'}
                  >
                    <option value="private">Private - Only visible to members</option>
                    {team.visibility !== 'private' && (
                      <option value="public">Public - Visible to all users</option>
                    )}
                  </select>
                  {team.visibility === 'private' && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      Sub-teams of private teams must also be private.
                    </p>
                  )}
                </div>
                
                <div className="space-y-3">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Sub-Team Settings
                  </label>
                  <div className="flex items-start">
                    <input
                      type="checkbox"
                      id="subTeamCanJoin"
                      checked={subTeamFormData.canJoin}
                      onChange={(e) => setSubTeamFormData({...subTeamFormData, canJoin: e.target.checked})}
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded mt-1"
                    />
                    <div className="ml-3">
                      <label htmlFor="subTeamCanJoin" className="text-sm text-gray-700 dark:text-gray-300 font-medium">
                        Allow join requests
                      </label>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Users can request to join this sub-team through the public interface.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              
              <div className="flex justify-end space-x-3 pt-6 mt-6 border-t border-gray-200 dark:border-gray-700">
                <button
                  type="button"
                  onClick={() => setShowSubTeamDialog(false)}
                  className="btn-secondary px-6 py-2"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingSubTeam}
                  className="btn-primary px-6 py-2"
                >
                  {creatingSubTeam ? 'Creating Sub-Team...' : 'Create Sub-Team'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Sub-Team Confirmation Dialog */}
      {deleteSubTeamId && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full">
            <div className="p-6">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                Delete Sub-Team
              </h3>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Are you sure you want to delete this sub-team? This action cannot be undone.
              </p>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setDeleteSubTeamId(null)}
                  className="btn-secondary"
                  disabled={deletingSubTeam}
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteSubTeam}
                  disabled={deletingSubTeam}
                  className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
                >
                  {deletingSubTeam ? 'Deleting...' : 'Delete Sub-Team'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Member Dialog */}
      {showAddMemberDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Add Member to Team</h3>
              <button
                onClick={() => {
                  setShowAddMemberDialog(false)
                  setAddMemberTab('existing')
                  setSelectedUserId('')
                  setUserSearch('')
                  setNewUserForm({ email: '', firstName: '', lastName: '' })
                }}
                className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            
            {/* Tab Navigation */}
            <div className="border-b border-gray-200 dark:border-gray-700">
              <nav className="-mb-px flex">
                <button
                  onClick={() => setAddMemberTab('existing')}
                  className={`py-4 px-6 border-b-2 font-medium text-sm ${
                    addMemberTab === 'existing'
                      ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                  }`}
                >
                  Add Existing User
                </button>
                <button
                  onClick={() => setAddMemberTab('new')}
                  className={`py-4 px-6 border-b-2 font-medium text-sm ${
                    addMemberTab === 'new'
                      ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                  }`}
                >
                  Create New User
                </button>
              </nav>
            </div>
            
            <div className="p-6">
              {addMemberTab === 'existing' && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Search Users
                    </label>
                    <input
                      type="text"
                      value={userSearch}
                      onChange={(e) => setUserSearch(e.target.value)}
                      className="input w-full"
                      placeholder="Search by name, email, or username..."
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Available Users
                    </label>
                    <div className="max-h-64 overflow-y-auto border border-gray-200 dark:border-gray-600 rounded-lg">
                      {availableUsers.length === 0 ? (
                        <div className="p-4 text-center text-gray-500 dark:text-gray-400">
                          {userSearch ? 'No users found matching your search.' : 'No available users (all users are already in teams).'}
                        </div>
                      ) : (
                        <div className="space-y-1 p-2">
                          {availableUsers.map((user) => (
                            <label key={user.id} className="flex items-center p-3 hover:bg-gray-50 dark:hover:bg-gray-700 rounded cursor-pointer">
                              <input
                                type="radio"
                                name="selectedUser"
                                value={user.id}
                                checked={selectedUserId === user.id}
                                onChange={(e) => setSelectedUserId(e.target.value)}
                                className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                              />
                              <div className="ml-3">
                                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                                  {user.first_name} {user.last_name}
                                </div>
                                <div className="text-xs text-gray-500 dark:text-gray-400">
                                  {user.email}
                                </div>
                              </div>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex justify-end space-x-3 pt-4">
                    <button
                      type="button"
                      onClick={() => setShowAddMemberDialog(false)}
                      className="btn-secondary px-6 py-2"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAddExistingUser}
                      disabled={!selectedUserId || addingMember}
                      className="btn-primary px-6 py-2"
                    >
                      {addingMember ? 'Adding...' : 'Add User'}
                    </button>
                  </div>
                </div>
              )}
              
              {addMemberTab === 'new' && (
                <form onSubmit={handleCreateNewUser} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Email Address *
                    </label>
                    <input
                      type="email"
                      required
                      value={newUserForm.email}
                      onChange={(e) => setNewUserForm({...newUserForm, email: e.target.value})}
                      className="input w-full"
                      placeholder="user@example.com"
                    />
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        First Name *
                      </label>
                      <input
                        type="text"
                        required
                        value={newUserForm.firstName}
                        onChange={(e) => setNewUserForm({...newUserForm, firstName: e.target.value})}
                        className="input w-full"
                        placeholder="John"
                      />
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        Last Name *
                      </label>
                      <input
                        type="text"
                        required
                        value={newUserForm.lastName}
                        onChange={(e) => setNewUserForm({...newUserForm, lastName: e.target.value})}
                        className="input w-full"
                        placeholder="Doe"
                      />
                    </div>
                  </div>
                  
                  <div className="bg-blue-50 dark:bg-blue-900 p-4 rounded-lg">
                    <p className="text-sm text-blue-800 dark:text-blue-200">
                      <strong>Note:</strong> The user will be created in the Account Management System and automatically added to this team. 
                      They will need to set their password on first login.
                    </p>
                  </div>
                  
                  <div className="flex justify-end space-x-3 pt-4">
                    <button
                      type="button"
                      onClick={() => setShowAddMemberDialog(false)}
                      className="btn-secondary px-6 py-2"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!newUserForm.email || !newUserForm.firstName || !newUserForm.lastName || addingMember}
                      className="btn-primary px-6 py-2"
                    >
                      {addingMember ? 'Creating...' : 'Create & Add User'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create Channel Dialog */}
      {showChannelDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Create Custom Channel</h3>
              <button
                onClick={() => setShowChannelDialog(false)}
                className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            
            <form onSubmit={handleCreateChannel} className="p-6">
              <div className="space-y-6">
                <div className="bg-gray-50 dark:bg-gray-700 p-4 rounded-lg">
                  <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Channel Name Preview:</h4>
                  <p className="text-sm text-gray-900 dark:text-gray-100">
                    {team.parent_team_id 
                      ? `Teams / ${parentTeam?.callsign_prefix || parentTeam?.name || 'Root'} / ${team.name}`
                      : `Teams / ${team.callsign_prefix || team.name}`
                    }
                    {channelFormData.customSuffix && ` - ${channelFormData.customSuffix}`}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Channel Suffix *
                  </label>
                  <input
                    type="text"
                    required
                    value={channelFormData.customSuffix}
                    onChange={(e) => setChannelFormData({...channelFormData, customSuffix: e.target.value})}
                    className="input w-full"
                    placeholder="Example Text"
                    maxLength={100}
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    This will be added after " - " to create the full channel name
                  </p>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">
                    Select Members and Permissions
                  </label>
                  <div className="space-y-2 max-h-64 overflow-y-auto border border-gray-200 dark:border-gray-600 rounded-lg p-3">
                    {members.map((member) => {
                      const currentPermission = getMemberPermission(member.id)
                      return (
                        <div key={member.id} className="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-gray-700 rounded">
                          <div className="flex-1">
                            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                              {member.first_name} {member.last_name}
                            </span>
                            <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                              {member.email}
                            </span>
                          </div>
                          <div className="flex space-x-2">
                            {['read', 'write', 'read_write'].map((permission) => (
                              <button
                                key={permission}
                                type="button"
                                onClick={() => toggleMemberPermission(member.id, permission)}
                                className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                                  currentPermission === permission
                                    ? 'bg-primary-100 text-primary-800 border-primary-300 dark:bg-primary-900 dark:text-primary-200'
                                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50 dark:bg-gray-600 dark:text-gray-300 dark:border-gray-500 dark:hover:bg-gray-500'
                                }`}
                              >
                                {currentPermission === permission && <CheckIcon className="h-3 w-3 inline mr-1" />}
                                {permission === 'read_write' ? 'Read/Write' : permission.charAt(0).toUpperCase() + permission.slice(1)}
                              </button>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    Select members and their permissions. Members without permissions will not be added to the channel.
                  </p>
                </div>
              </div>
              
              <div className="flex justify-end space-x-3 pt-6 mt-6 border-t border-gray-200 dark:border-gray-700">
                <button
                  type="button"
                  onClick={() => setShowChannelDialog(false)}
                  className="btn-secondary px-6 py-2"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingChannel || !channelFormData.customSuffix || channelFormData.memberPermissions.length === 0}
                  className="btn-primary px-6 py-2"
                >
                  {creatingChannel ? 'Creating Channel...' : 'Create Channel'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Remove User Confirmation Dialog */}
      {removeUserId && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full">
            <div className="p-6">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                Remove {removeUserRole === 'admin' ? 'Admin' : 'Member'}
              </h3>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Are you sure you want to remove this {removeUserRole} from the team? 
                They will be removed from all team channels and lose access to team resources.
              </p>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => {
                    setRemoveUserId(null)
                    setRemoveUserRole('')
                  }}
                  className="btn-secondary"
                  disabled={removingUser}
                >
                  Cancel
                </button>
                <button
                  onClick={confirmRemoveUser}
                  disabled={removingUser}
                  className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
                >
                  {removingUser ? 'Removing...' : 'Remove User'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Team Dialog */}
      {showEditDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Edit Team</h3>
              <button
                onClick={() => setShowEditDialog(false)}
                className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            
            <form onSubmit={async (e) => {
              e.preventDefault()
              setUpdating(true)
              try {
                await teamsAPI.update(team.id, editFormData)
                const updatedTeam = {...team, ...editFormData, parent_team_id: editFormData.parentTeamId}
                setTeam(updatedTeam)
                
                // Update parent team if changed
                if (editFormData.parentTeamId !== team.parent_team_id) {
                  if (editFormData.parentTeamId) {
                    const newParent = allTeams.find(t => t.id === editFormData.parentTeamId)
                    setParentTeam(newParent || null)
                  } else {
                    setParentTeam(null)
                  }
                }
                
                setShowEditDialog(false)
              } catch (error) {
                console.error('Failed to update team:', error)
                alert('Failed to update team: ' + (error.response?.data?.error || error.message))
              } finally {
                setUpdating(false)
              }
            }} className="p-6">
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Team Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={editFormData.name}
                    onChange={(e) => setEditFormData({...editFormData, name: e.target.value})}
                    className="input w-full"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Description
                  </label>
                  <textarea
                    value={editFormData.description}
                    onChange={(e) => setEditFormData({...editFormData, description: e.target.value})}
                    className="input w-full"
                    rows={3}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Prefix
                  </label>
                  <input
                    type="text"
                    value={editFormData.callsignPrefix}
                    onChange={(e) => setEditFormData({...editFormData, callsignPrefix: e.target.value})}
                    className="input w-full"
                    placeholder="FENZ, STL, etc."
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Used to build callsigns. Example: FENZ-STL-John Smith
                  </p>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Parent Team
                  </label>
                  <select
                    value={editFormData.parentTeamId || ''}
                    onChange={(e) => setEditFormData({...editFormData, parentTeamId: e.target.value ? parseInt(e.target.value) : null})}
                    className="input w-full"
                  >
                    <option value="">No parent (Top-level team)</option>
                    {allTeams.filter(t => t.id !== team.id).map(parentTeam => (
                      <option key={parentTeam.id} value={parentTeam.id}>
                        {parentTeam.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Select a parent team to make this a sub-team, or leave empty for a top-level team.
                  </p>
                </div>
                
                {!editFormData.parentTeamId && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        Callsign Sub-team Depth
                      </label>
                      <select
                        value={editFormData.callsignSubteamDepth}
                        onChange={(e) => setEditFormData({...editFormData, callsignSubteamDepth: parseInt(e.target.value)})}
                        className="input w-full"
                      >
                        <option value={0}>0 - Root prefix only</option>
                        <option value={1}>1 - Include 1 sub-team</option>
                        <option value={2}>2 - Include 2 sub-teams</option>
                        <option value={3}>3 - Include 3 sub-teams</option>
                        <option value={4}>4 - Include 4 sub-teams</option>
                        <option value={5}>5 - Include all sub-teams</option>
                      </select>
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        Callsign Name Format
                      </label>
                      <select
                        value={editFormData.callsignNameFormat}
                        onChange={(e) => setEditFormData({...editFormData, callsignNameFormat: e.target.value})}
                        className="input w-full"
                      >
                        <option value="full_name">Full Name</option>
                        <option value="first_initial_last">First Initial + Last Name</option>
                        <option value="first_last_initial">First Name + Last Initial</option>
                      </select>
                    </div>
                  </>
                )}
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Visibility
                  </label>
                  <select
                    value={editFormData.visibility}
                    onChange={(e) => setEditFormData({...editFormData, visibility: e.target.value})}
                    className="input w-full"
                  >
                    <option value="private">Private</option>
                    <option value="public">Public</option>
                  </select>
                </div>
                
                <div className="flex items-start">
                  <input
                    type="checkbox"
                    id="editCanJoin"
                    checked={editFormData.canJoin}
                    onChange={(e) => setEditFormData({...editFormData, canJoin: e.target.checked})}
                    className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded mt-1"
                  />
                  <div className="ml-3">
                    <label htmlFor="editCanJoin" className="text-sm text-gray-700 dark:text-gray-300 font-medium">
                      Allow join requests
                    </label>
                  </div>
                </div>
              </div>
              
              <div className="flex justify-end space-x-3 pt-6 mt-6 border-t border-gray-200 dark:border-gray-700">
                <button
                  type="button"
                  onClick={() => setShowEditDialog(false)}
                  className="btn-secondary px-6 py-2"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={updating}
                  className="btn-primary px-6 py-2"
                >
                  {updating ? 'Updating...' : 'Update Team'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}