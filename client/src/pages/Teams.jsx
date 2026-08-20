import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { PlusIcon, UserGroupIcon, TrashIcon, MagnifyingGlassIcon, ChevronUpIcon, ChevronDownIcon, ChevronRightIcon, EyeSlashIcon, ArrowLeftOnRectangleIcon, PencilIcon, QrCodeIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { teamsAPI, configAPI } from '../services/api'
import api from '../services/api'
import { labelFor } from '../utils/teamLabels'
import TeamFormDialog from '../components/TeamFormDialog'

export default function Teams({ user }) {
  const [teams, setTeams] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  // Bugfix: Create/Edit Team is now a single shared dialog
  // (`TeamFormDialog`) also used by TeamDetail.jsx -- this page's job is
  // just to track which team (if any) is being edited and hand it to
  // that dialog as the `team` prop. `null` means "creating a new team".
  const [editingTeam, setEditingTeam] = useState(null)
  const [colorMappings, setColorMappings] = useState({})
  const [deleteTeamId, setDeleteTeamId] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [sortField, setSortField] = useState('name')
  const [sortDirection, setSortDirection] = useState('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const itemsPerPage = 15
  const [expandedTeams, setExpandedTeams] = useState(new Set())
  // Requirement 2.4/2.5 (task 32.2): the system-wide Max_Team_Depth
  // constant, sourced from GET /api/config/public so it's never
  // hardcoded on the Client. Used to disable/grey any Parent-Team
  // dropdown option that's already at the deepest permitted level.
  const [maxTeamDepth, setMaxTeamDepth] = useState(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [teamsResponse, configResponse, publicConfigResponse] = await Promise.all([
          teamsAPI.getMyTeams(),
          api.get('/config/color-mappings'),
          configAPI.getPublic()
        ])
        setTeams(teamsResponse.data.teams)
        setColorMappings(configResponse.data.colorMappings || {})
        setMaxTeamDepth(publicConfigResponse.data.maxTeamDepth ?? null)
      } catch (error) {
        console.error('Failed to fetch data:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  const closeTeamFormDialog = () => {
    setShowCreateDialog(false)
    setEditingTeam(null)
  }

  // Applies TeamFormDialog's `onSaved` response to this page's own
  // `teams` list: updates the existing row in place when editing, or
  // appends the newly created team when creating.
  const handleTeamSaved = (updatedTeam) => {
    if (editingTeam) {
      setTeams(teams.map(team => team.id === updatedTeam.id ? {...team, ...updatedTeam} : team))
    } else {
      setTeams([...teams, updatedTeam])
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
        } else {
          // Parent not in the list (e.g. regular user only sees their own teams)
          rootTeams.push(teamMap.get(team.id))
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
      (team.callsign_prefix && team.callsign_prefix.toLowerCase().includes(searchTerm.toLowerCase()))
    ) : flattenHierarchy(hierarchicalTeams)

  // Pagination
  const totalPages = Math.ceil(filteredTeams.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const paginatedTeams = filteredTeams.slice(startIndex, startIndex + itemsPerPage)

  const expandAllTeams = () => {
    const allParentIds = new Set(teams.filter(t => teams.some(c => c.parent_team_id === t.id)).map(t => t.id))
    setExpandedTeams(allParentIds)
  }

  const collapseAllTeams = () => {
    setExpandedTeams(new Set())
  }

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
      toast.error('Failed to delete team: ' + (error.response?.data?.error || error.message))
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
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Orgs & Teams</h1>
          <p className="text-gray-600 dark:text-gray-400">Manage your team memberships and create new teams.</p>
        </div>
        {isGlobalAdmin && (
          <button 
            onClick={() => {
              setEditingTeam(null)
              setShowCreateDialog(true)
            }}
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
              onClick={() => {
                setEditingTeam(null)
                setShowCreateDialog(true)
              }}
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
            <div className="flex items-center space-x-2">
              <button
                onClick={expandAllTeams}
                className="inline-flex items-center px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
              >
                <ChevronDownIcon className="h-4 w-4 mr-1" />
                Expand All
              </button>
              <button
                onClick={collapseAllTeams}
                className="inline-flex items-center px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
              >
                <ChevronUpIcon className="h-4 w-4 mr-1" />
                Collapse All
              </button>
            </div>
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
                      onClick={() => handleSort('callsign_prefix')}
                    >
                      <div className="flex items-center space-x-1">
                        <span>Prefix</span>
                        {getSortIcon('callsign_prefix')}
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
                            {team.level > 0 ? `${teams.find(t => t.id === team.parent_team_id)?.callsign_prefix || teams.find(t => t.id === team.parent_team_id)?.name || 'Root'} - ${team.name}` : team.name}
                          </Link>
                          {team.visibility === 'private' && (
                            <EyeSlashIcon className="h-4 w-4 text-red-500" title="Private team" />
                          )}
                          {team.can_join && (
                            <ArrowLeftOnRectangleIcon className="h-4 w-4 text-green-500" title="Joinable team" />
                          )}
                          {team.has_signup_code && (
                            <QrCodeIcon className="h-4 w-4 text-purple-500" title="Has sign-up code" />
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
                      {team.callsign_prefix || '-'}
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
                              setEditingTeam(team)
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

      {/* Create/Edit Team Dialog (shared with TeamDetail.jsx) */}
      <TeamFormDialog
        mode={editingTeam ? 'edit' : 'create'}
        team={editingTeam}
        teams={teams}
        maxTeamDepth={maxTeamDepth}
        colorMappings={colorMappings}
        isOpen={showCreateDialog}
        onClose={closeTeamFormDialog}
        onSaved={handleTeamSaved}
      />

      {/* Delete Confirmation Dialog */}
      {deleteTeamId && (() => {
        const deleteLabel = labelFor(teams.find(t => t.id === deleteTeamId))
        return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full">
            <div className="p-6">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                Delete {deleteLabel}
              </h3>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Are you sure you want to delete this {deleteLabel.toLowerCase()}? This action cannot be undone.
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
                  {deleting ? 'Deleting...' : `Delete ${deleteLabel}`}
                </button>
              </div>
            </div>
          </div>
        </div>
        )
      })()}
    </div>
  )
}