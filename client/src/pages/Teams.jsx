import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { PlusIcon, UserGroupIcon, XMarkIcon, TrashIcon, MagnifyingGlassIcon, ChevronUpIcon, ChevronDownIcon, ChevronRightIcon, EyeSlashIcon, ArrowRightOnRectangleIcon, PencilIcon } from '@heroicons/react/24/outline'
import { teamsAPI } from '../services/api'
import api from '../services/api'

export default function Teams({ user }) {
  const [teams, setTeams] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    slug: '',
    color: 'Blue',
    visibility: 'public',
    canJoin: false
  })
  const [creating, setCreating] = useState(false)
  const [colorMappings, setColorMappings] = useState({})
  const [deleteTeamId, setDeleteTeamId] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [sortField, setSortField] = useState('name')
  const [sortDirection, setSortDirection] = useState('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const itemsPerPage = 15
  const [expandedTeams, setExpandedTeams] = useState(new Set())
  const [editingTeamId, setEditingTeamId] = useState(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [teamsResponse, configResponse] = await Promise.all([
          teamsAPI.getMyTeams(),
          api.get('/config/color-mappings')
        ])
        setTeams(teamsResponse.data.teams)
        setColorMappings(configResponse.data.colorMappings || {})
      } catch (error) {
        console.error('Failed to fetch data:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  const handleCreateTeam = async (e) => {
    e.preventDefault()
    setCreating(true)
    try {
      if (editingTeamId) {
        const response = await teamsAPI.update(editingTeamId, formData)
        setTeams(teams.map(team => team.id === editingTeamId ? {...team, ...response.data.team} : team))
      } else {
        const response = await teamsAPI.create(formData)
        setTeams([...teams, response.data.team])
      }
      setShowCreateDialog(false)
      setEditingTeamId(null)
      setFormData({
        name: '',
        description: '',
        slug: '',
        color: 'Blue',
        visibility: 'public',
        canJoin: false
      })
    } catch (error) {
      console.error(editingTeamId ? 'Failed to update team:' : 'Failed to create team:', error)
      alert((editingTeamId ? 'Failed to update team: ' : 'Failed to create team: ') + (error.response?.data?.error || error.message))
    } finally {
      setCreating(false)
    }
  }

  const isGlobalAdmin = user?.isAdmin

  // Build hierarchical team structure
  const buildTeamHierarchy = (teams) => {
    const teamMap = new Map()
    const rootTeams = []
    
    teams.forEach(team => {
      teamMap.set(team.id, { ...team, children: [] })
    })
    
    teams.forEach(team => {
      if (team.parent_team_id) {
        const parent = teamMap.get(team.parent_team_id)
        if (parent) {
          parent.children.push(teamMap.get(team.id))
        }
      } else {
        rootTeams.push(teamMap.get(team.id))
      }
    })
    
    return rootTeams
  }

  // Flatten hierarchy for display
  const flattenHierarchy = (teams, level = 0, parentExpanded = true) => {
    let result = []
    
    teams.forEach(team => {
      if (parentExpanded) {
        result.push({ ...team, level, hasChildren: team.children.length > 0 })
        
        if (team.children.length > 0 && expandedTeams.has(team.id)) {
          result = result.concat(flattenHierarchy(team.children, level + 1, true))
        }
      }
    })
    
    return result
  }

  const hierarchicalTeams = buildTeamHierarchy(teams)
  const allFlatTeams = flattenHierarchy(hierarchicalTeams, 0, true)
  
  // Filter teams
  const filteredTeams = searchTerm ? 
    allFlatTeams.filter(team =>
      team.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (team.slug && team.slug.toLowerCase().includes(searchTerm.toLowerCase()))
    ) : flattenHierarchy(hierarchicalTeams)

  // Pagination
  const totalPages = Math.ceil(filteredTeams.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const paginatedTeams = filteredTeams.slice(startIndex, startIndex + itemsPerPage)

  const toggleExpanded = (teamId) => {
    const newExpanded = new Set(expandedTeams)
    if (newExpanded.has(teamId)) {
      newExpanded.delete(teamId)
    } else {
      newExpanded.add(teamId)
    }
    setExpandedTeams(newExpanded)
  }

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('asc')
    }
    setCurrentPage(1)
  }

  const getSortIcon = (field) => {
    if (sortField !== field) return null
    return sortDirection === 'asc' ? 
      <ChevronUpIcon className="h-4 w-4" /> : 
      <ChevronDownIcon className="h-4 w-4" />
  }

  const handleDeleteTeam = async () => {
    if (!deleteTeamId) return
    
    setDeleting(true)
    try {
      await teamsAPI.delete(deleteTeamId)
      setTeams(teams.filter(team => team.id !== deleteTeamId))
      setDeleteTeamId(null)
    } catch (error) {
      console.error('Failed to delete team:', error)
      alert('Failed to delete team: ' + (error.response?.data?.error || error.message))
    } finally {
      setDeleting(false)
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Teams</h1>
          <p className="text-gray-600 dark:text-gray-400">Manage your team memberships and create new teams.</p>
        </div>
        {isGlobalAdmin && (
          <button 
            onClick={() => setShowCreateDialog(true)}
            className="btn-primary flex items-center"
          >
            <PlusIcon className="h-5 w-5 mr-2" />
            Create Team
          </button>
        )}
      </div>

      {teams.length === 0 ? (
        <div className="card text-center py-12">
          <UserGroupIcon className="h-12 w-12 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">No teams yet</h3>
          <p className="text-gray-500 dark:text-gray-400 mb-6">
            You're not a member of any teams. {isGlobalAdmin ? 'Create your first team or' : ''} Request access to an existing one.
          </p>
          {isGlobalAdmin && (
            <button 
              onClick={() => setShowCreateDialog(true)}
              className="btn-primary"
            >
              Create Your First Team
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Search Bar */}
          <div className="flex items-center space-x-4">
            <div className="flex-1">
              <input
                type="text"
                placeholder="Search teams..."
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value)
                  setCurrentPage(1)
                }}
                className="input w-full"
              />
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {searchTerm ? `${filteredTeams.length} of ${teams.length} teams` : `${teams.length} teams`}
            </div>
          </div>

          <div className="card">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th 
                      className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                      onClick={() => handleSort('name')}
                    >
                      <div className="flex items-center space-x-1">
                        <span>Team Name</span>
                        {getSortIcon('name')}
                      </div>
                    </th>
                    <th 
                      className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                      onClick={() => handleSort('slug')}
                    >
                      <div className="flex items-center space-x-1">
                        <span>Slug</span>
                        {getSortIcon('slug')}
                      </div>
                    </th>
                    <th 
                      className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                      onClick={() => handleSort('member_count')}
                    >
                      <div className="flex items-center space-x-1">
                        <span>Members</span>
                        {getSortIcon('member_count')}
                      </div>
                    </th>
                    <th 
                      className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                      onClick={() => handleSort('sub_teams_count')}
                    >
                      <div className="flex items-center space-x-1">
                        <span>Sub-teams</span>
                        {getSortIcon('sub_teams_count')}
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
                  {paginatedTeams.map((team) => (
                  <tr key={team.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="relative group flex items-center" style={{ paddingLeft: `${team.level * 20}px` }}>
                        {team.hasChildren ? (
                          <button
                            onClick={() => toggleExpanded(team.id)}
                            className="mr-2 p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
                          >
                            {expandedTeams.has(team.id) ? (
                              <ChevronDownIcon className="h-4 w-4 text-gray-500" />
                            ) : (
                              <ChevronRightIcon className="h-4 w-4 text-gray-500" />
                            )}
                          </button>
                        ) : (
                          <div className="w-6 mr-2" />
                        )}
                        <div className="flex items-center space-x-2">
                          <Link
                            to={`/teams/${team.id}`}
                            className="text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-primary-600 dark:hover:text-primary-400 cursor-pointer"
                          >
                            {team.name}
                          </Link>
                          {team.visibility === 'private' && (
                            <EyeSlashIcon className="h-4 w-4 text-red-500" title="Private team" />
                          )}
                          {team.can_join && (
                            <ArrowRightOnRectangleIcon className="h-4 w-4 text-green-500" title="Joinable team" />
                          )}
                        </div>
                        {team.description && (
                          <div className="absolute bottom-full left-0 mb-2 px-3 py-2 bg-gray-900 text-white text-sm rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10 whitespace-normal w-64">
                            {team.description}
                            <div className="absolute top-full left-4 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900"></div>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      {team.slug || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      {team.member_count || 0}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      {team.sub_teams_count || 0}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                        team.role === 'admin' 
                          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' 
                          : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
                      }`}>
                        {team.role}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex items-center justify-end space-x-3">
                        <Link
                          to={`/teams/${team.id}`}
                          className="text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300"
                          title="View team details"
                        >
                          <MagnifyingGlassIcon className="h-4 w-4" />
                        </Link>
                        {isGlobalAdmin && (
                          <button
                            onClick={() => {
                              setFormData({
                                name: team.name,
                                description: team.description || '',
                                slug: team.slug || '',
                                color: team.color || 'Blue',
                                visibility: team.visibility || 'private',
                                canJoin: team.can_join || false
                              })
                              setEditingTeamId(team.id)
                              setShowCreateDialog(true)
                            }}
                            className="text-gray-600 hover:text-gray-500 dark:text-gray-400 dark:hover:text-gray-300"
                            title="Edit team"
                          >
                            <PencilIcon className="h-4 w-4" />
                          </button>
                        )}
                        {isGlobalAdmin && (!team.hasChildren || (team.sub_teams_count || 0) === 0) && (
                          <button
                            onClick={() => setDeleteTeamId(team.id)}
                            className="text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300"
                            title="Delete team"
                          >
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        )}
                        {isGlobalAdmin && (team.hasChildren && (team.sub_teams_count || 0) > 0) && (
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
            
            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-6 py-3 border-t border-gray-200 dark:border-gray-700">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    Showing {startIndex + 1} to {Math.min(startIndex + itemsPerPage, filteredTeams.length)} of {filteredTeams.length} teams
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                      disabled={currentPage === 1}
                      className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Previous
                    </button>
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                      disabled={currentPage === totalPages}
                      className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create Team Dialog */}
      {showCreateDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{editingTeamId ? 'Edit Team' : 'Create New Team'}</h3>
              <button
                onClick={() => {
                  setShowCreateDialog(false)
                  setEditingTeamId(null)
                  setFormData({
                    name: '',
                    description: '',
                    slug: '',
                    color: 'Blue',
                    visibility: 'public',
                    canJoin: false
                  })
                }}
                className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            
            <form onSubmit={handleCreateTeam} className="p-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Team Name *
                    </label>
                    <input
                      type="text"
                      required
                      value={formData.name}
                      onChange={(e) => setFormData({...formData, name: e.target.value})}
                      className="input w-full"
                      placeholder="Enter team name"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Team Slug
                    </label>
                    <input
                      type="text"
                      value={formData.slug}
                      onChange={(e) => setFormData({...formData, slug: e.target.value})}
                      className="input w-full"
                      placeholder="team-slug (auto-generated if empty)"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      Used in URLs and identifiers. Leave empty to auto-generate from team name.
                    </p>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      TAK Color
                    </label>
                    <select
                      value={formData.color}
                      onChange={(e) => setFormData({...formData, color: e.target.value})}
                      className="input w-full"
                    >
                      {Object.keys(colorMappings).length > 0 ? (
                        Object.entries(colorMappings).map(([color, organization]) => (
                          <option key={color} value={color}>
                            {organization && organization.trim() !== '' ? organization : color}
                          </option>
                        ))
                      ) : (
                        [
                          { color: 'Yellow', org: 'Hato Hone St John' },
                          { color: 'Cyan', org: 'Health New Zealand (Te Whatu Ora)' },
                          { color: 'Green', org: 'Department of Conservation (DOC)' },
                          { color: 'Red', org: 'Fire and Emergency New Zealand (FENZ)' },
                          { color: 'Purple', org: 'National Emergency Management Agency (NEMA)' },
                          { color: 'Orange', org: 'Land Search and Rescue New Zealand (LandSAR)' },
                          { color: 'Blue', org: 'New Zealand Police' },
                          { color: 'White', org: 'Wellington Free Ambulance' },
                          { color: 'Maroon', org: 'New Zealand Red Cross' },
                          { color: 'Dark Blue', org: 'New Zealand Customs Service' },
                          { color: 'Teal', org: 'Coastguard New Zealand' },
                          { color: 'Brown', org: 'New Zealand Defence Force (NZDF)' }
                        ].map(({ color, org }) => (
                          <option key={color} value={color}>
                            {org}
                          </option>
                        ))
                      )}
                    </select>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      TAK color designation for team members.
                    </p>
                  </div>
                </div>
                
                <div className="space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Description
                    </label>
                    <textarea
                      value={formData.description}
                      onChange={(e) => setFormData({...formData, description: e.target.value})}
                      className="input w-full"
                      rows={4}
                      placeholder="Enter team description and purpose"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Visibility
                    </label>
                    <select
                      value={formData.visibility}
                      onChange={(e) => setFormData({...formData, visibility: e.target.value})}
                      className="input w-full"
                    >
                      <option value="private">Private - Only visible to members</option>
                      <option value="public">Public - Visible to all users</option>
                    </select>
                  </div>
                  
                  <div className="space-y-3">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Team Settings
                    </label>
                    <div className="flex items-start">
                      <input
                        type="checkbox"
                        id="canJoin"
                        checked={formData.canJoin}
                        onChange={(e) => setFormData({...formData, canJoin: e.target.checked})}
                        className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded mt-1"
                      />
                      <div className="ml-3">
                        <label htmlFor="canJoin" className="text-sm text-gray-700 dark:text-gray-300 font-medium">
                          Allow join requests
                        </label>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          Users can request to join this team through the public interface.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              
              <div className="flex justify-end space-x-3 pt-6 mt-6 border-t border-gray-200 dark:border-gray-700">
                <button
                  type="button"
                  onClick={() => setShowCreateDialog(false)}
                  className="btn-secondary px-6 py-2"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="btn-primary px-6 py-2"
                >
                  {creating ? (editingTeamId ? 'Updating Team...' : 'Creating Team...') : (editingTeamId ? 'Update Team' : 'Create Team')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {deleteTeamId && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full">
            <div className="p-6">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                Delete Team
              </h3>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Are you sure you want to delete this team? This action cannot be undone.
              </p>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setDeleteTeamId(null)}
                  className="btn-secondary"
                  disabled={deleting}
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteTeam}
                  disabled={deleting}
                  className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
                >
                  {deleting ? 'Deleting...' : 'Delete Team'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}