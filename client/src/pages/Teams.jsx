import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { PlusIcon, UserGroupIcon, TrashIcon, MagnifyingGlassIcon, ChevronUpIcon, ChevronDownIcon, ChevronRightIcon, EyeSlashIcon, ArrowLeftOnRectangleIcon, PencilIcon, QrCodeIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { teamsAPI, configAPI } from '../services/api'
import api from '../services/api'
import { labelFor } from '../utils/teamLabels'
import TeamFormDialog from '../components/TeamFormDialog'

// Mobile card fallback (bugfix: the /teams table required constant
// horizontal swiping on a phone). Table indentation (`level` multiplied
// into left padding) has no equivalent that reads well once each row is
// its own boxed card --
// there is no shared vertical rail left to imply nesting once cards remove
// the width constraint the padding was working around -- so the card
// surface drops padding-based indentation entirely and names the immediate
// parent as a breadcrumb label instead (`getParentBreadcrumb`). The table
// keeps its existing padding-based indentation for `sm:` and up, but caps
// it at MAX_TABLE_INDENT_LEVELS so a deeply nested org (up to
// MAX_TEAM_DEPTH = 5) can't push a name off the edge of a tablet-width
// table either.
const MAX_TABLE_INDENT_LEVELS = 3

/**
 * The immediate parent's display label for a team's mobile-card breadcrumb
 * ("Parent ›" above the team name) -- the same fallback chain
 * (`callsign_prefix || name || 'Root'`) the table's own
 * `Prefix - Name` link text already uses, just returned as its own value
 * instead of being pre-joined into a string, since a card has room to show
 * the parent as a separate visual element rather than mashing it into the
 * name.
 *
 * Exported for direct unit testing, matching this project's convention of
 * testing extracted pure logic (no @testing-library/react in this project;
 * see this file's own test for the established source-contract style).
 *
 * @param {{level?: number, parent_team_id?: number|string}} team
 * @param {Array<{id: number|string, callsign_prefix?: string, name?: string}>} teams
 * @returns {string|null} null for a root team (`level` 0/falsy) or when no
 *   parent is found in `teams` (e.g. a regular user who only sees their own
 *   team, same "Parent not in the list" case `buildTeamHierarchy` handles).
 */
export function getParentBreadcrumb(team, teams) {
  if (!team || !team.level) {
    return null
  }
  const parent = teams.find((t) => t.id === team.parent_team_id)
  if (!parent) {
    return null
  }
  return parent.callsign_prefix || parent.name || 'Root'
}

/**
 * The status-icon cluster (private / joinable / has-signup-code) shown next
 * to a team's name, shared between the mobile card and the desktop table
 * row so the two surfaces can't drift on which icons a team gets --
 * mirroring `TeamDeviceList.jsx`'s own `DeviceActions` shared-component
 * convention for the same reason.
 */
function TeamStatusIcons({ team }) {
  return (
    <>
      {team.visibility === 'private' && (
        <EyeSlashIcon className="h-4 w-4 text-red-500 flex-shrink-0" title="Private team" />
      )}
      {team.can_join && (
        <ArrowLeftOnRectangleIcon className="h-4 w-4 text-green-500 flex-shrink-0" title="Joinable team" />
      )}
      {team.has_signup_code && (
        <QrCodeIcon className="h-4 w-4 text-purple-500 flex-shrink-0" title="Has sign-up code" />
      )}
    </>
  )
}

/**
 * The view/edit/delete action-icon group, shared between the mobile card
 * and the desktop table row for the same reason `TeamStatusIcons` is.
 *
 * Bugfix (mobile tap targets too small): `variant="card"` (passed only
 * from the `sm:hidden` mobile card block below) wraps each icon in a
 * `p-2 rounded-lg` button box sized to match the header toolbar's own
 * icon-only buttons, giving a real ~36px tap target instead of a bare
 * ~16px icon. See `MemberActions.jsx`'s identical `variant` prop for the
 * fuller rationale -- both components were fixed together for
 * consistency.
 */
function TeamRowActions({ team, isGlobalAdmin, onEdit, onDelete, variant = 'table' }) {
  const hasSubTeams = team.hasChildren && (team.sub_teams_count || 0) > 0
  const isCard = variant === 'card'
  const iconSizeClass = isCard ? 'h-5 w-5' : 'h-4 w-4'
  const boxClass = isCard ? 'p-2 rounded-lg' : ''
  const neutralClass = isCard
    ? 'bg-gray-100 hover:bg-gray-200 text-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-300'
    : 'text-gray-600 hover:text-gray-500 dark:text-gray-400 dark:hover:text-gray-300'
  const primaryClass = isCard
    ? 'bg-gray-100 hover:bg-gray-200 text-primary-600 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-primary-400'
    : 'text-primary-600 hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300'
  const dangerClass = isCard
    ? 'bg-red-50 hover:bg-red-100 text-red-600 dark:bg-red-950/40 dark:hover:bg-red-900/60 dark:text-red-400'
    : 'text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300'
  const dangerDisabledClass = isCard
    ? 'bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-600 cursor-not-allowed'
    : 'text-gray-400 dark:text-gray-600 cursor-not-allowed'

  return (
    <div className="flex items-center justify-end space-x-3">
      <Link
        to={`/teams/${team.id}`}
        className={`${boxClass} ${primaryClass}`}
        title="View team details"
      >
        <MagnifyingGlassIcon className={iconSizeClass} />
      </Link>
      {isGlobalAdmin && (
        <button
          onClick={() => onEdit(team)}
          className={`${boxClass} ${neutralClass}`}
          title="Edit team"
        >
          <PencilIcon className={iconSizeClass} />
        </button>
      )}
      {isGlobalAdmin && !hasSubTeams && (
        <button
          onClick={() => onDelete(team.id)}
          className={`${boxClass} ${dangerClass}`}
          title="Delete team"
        >
          <TrashIcon className={iconSizeClass} />
        </button>
      )}
      {isGlobalAdmin && hasSubTeams && (
        <button
          disabled
          className={`${boxClass} ${dangerDisabledClass}`}
          title="Cannot delete team with sub-teams"
        >
          <TrashIcon className={iconSizeClass} />
        </button>
      )}
    </div>
  )
}

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

  const startEditingTeam = (team) => {
    setEditingTeam(team)
    setShowCreateDialog(true)
  }

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
          // Bugfix: icon-only on every viewport -- was icon + "Create
          // Team" text. `aria-label` carries the name for assistive
          // tech since there is no visible text label to announce it.
          <button 
            onClick={() => {
              setEditingTeam(null)
              setShowCreateDialog(true)
            }}
            className="btn-primary flex items-center justify-center p-2"
            aria-label="Create Team"
            title="Create Team"
          >
            <PlusIcon className="h-5 w-5" aria-hidden="true" />
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
          {/* Search Bar. `flex-wrap` (was a non-wrapping `space-x-4` row)
              so the search input, Expand/Collapse buttons and the team
              count can each drop to their own line on a narrow phone
              instead of forcing this row to scroll horizontally on its
              own, independent of the list/table below. */}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex-1 min-w-[10rem]">
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
            {/* Mobile card fallback below `sm:` -- matches
                `TeamDeviceList.jsx`'s own sm:hidden/hidden sm:block
                pairing, so a phone gets a stacked card list instead of a
                horizontally-scrolling table. Hierarchy is shown as a
                breadcrumb label naming the immediate parent
                (`getParentBreadcrumb`) rather than as indentation -- see
                the comment on `MAX_TABLE_INDENT_LEVELS` above. Every
                column the table hides below `md:` (Prefix, Team Devices,
                Team Admins, Sub-teams) is shown here instead of hidden,
                since a card has no width constraint pushing them off. */}
            <div className="sm:hidden divide-y divide-gray-200 dark:divide-gray-700">
              {paginatedTeams.map((team) => {
                const parentLabel = getParentBreadcrumb(team, teams)
                return (
                  <div key={team.id} className="p-4 space-y-3 text-sm">
                    {parentLabel && (
                      <p className="text-xs text-gray-500 dark:text-gray-400">{parentLabel} ›</p>
                    )}
                    <div className="flex items-start gap-2 min-w-0">
                      {team.hasChildren ? (
                        <button
                          onClick={() => toggleExpanded(team.id)}
                          className="mt-0.5 p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded flex-shrink-0"
                        >
                          {expandedTeams.has(team.id) ? (
                            <ChevronDownIcon className="h-4 w-4 text-gray-500" />
                          ) : (
                            <ChevronRightIcon className="h-4 w-4 text-gray-500" />
                          )}
                        </button>
                      ) : (
                        <div className="w-6 flex-shrink-0" />
                      )}
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <Link
                          to={`/teams/${team.id}`}
                          className="font-medium text-gray-900 dark:text-gray-100 hover:text-primary-600 dark:hover:text-primary-400 break-words"
                        >
                          {team.name}
                        </Link>
                        <TeamStatusIcons team={team} />
                      </div>
                    </div>
                    {team.description && (
                      <p className="text-gray-500 dark:text-gray-400">{team.description}</p>
                    )}
                    {/* Each stat is "Label: value" on ONE line (was label
                        stacked above value on two lines) -- half the
                        vertical space per stat, so the card reads more
                        like a dense summary line than a small table cut
                        into pieces. */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                      <div className="flex items-baseline gap-1">
                        <span className="text-xs text-gray-500 dark:text-gray-400">Members:</span>
                        <Link to={`/teams/${team.id}?tab=members`} className="text-gray-900 dark:text-gray-100 hover:text-primary-600 dark:hover:text-primary-400 hover:underline">
                          {team.member_count || 0}
                        </Link>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-xs text-gray-500 dark:text-gray-400">Team Devices:</span>
                        <Link to={`/teams/${team.id}?tab=devices`} className="text-gray-900 dark:text-gray-100 hover:text-primary-600 dark:hover:text-primary-400 hover:underline">
                          {team.device_count || 0}
                        </Link>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-xs text-gray-500 dark:text-gray-400">Team Admins:</span>
                        <Link to={`/teams/${team.id}?tab=admins`} className="text-gray-900 dark:text-gray-100 hover:text-primary-600 dark:hover:text-primary-400 hover:underline">
                          {team.admin_count || 0}
                        </Link>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-xs text-gray-500 dark:text-gray-400">Sub-teams:</span>
                        <Link to={`/teams/${team.id}?tab=subteams`} className="text-gray-900 dark:text-gray-100 hover:text-primary-600 dark:hover:text-primary-400 hover:underline">
                          {team.sub_teams_count || 0}
                        </Link>
                      </div>
                      {team.callsign_prefix && (
                        <div className="flex items-baseline gap-1">
                          <span className="text-xs text-gray-500 dark:text-gray-400">Prefix:</span>
                          <span className="text-gray-900 dark:text-gray-100">{team.callsign_prefix}</span>
                        </div>
                      )}
                      <div className="flex items-baseline gap-1">
                        <span className="text-xs text-gray-500 dark:text-gray-400">Role:</span>
                        {team.role ? (
                          <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                            team.role === 'admin'
                              ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                              : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
                          }`}>
                            {team.role}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                        )}
                      </div>
                    </div>
                    <TeamRowActions
                      team={team}
                      isGlobalAdmin={isGlobalAdmin}
                      onEdit={startEditingTeam}
                      onDelete={setDeleteTeamId}
                      variant="card"
                    />
                  </div>
                )
              })}
            </div>

            <div className="hidden sm:block overflow-x-auto">
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
                    {/* Prefix and Sub-teams are secondary detail relative to
                        Name/Members/Role/Actions -- hidden below `md` so the
                        table's essential columns fit a phone-width viewport
                        without horizontal scrolling; still available at
                        `md:` and up, and always reachable via the row's own
                        "View team details" action regardless of viewport. */}
                    <th 
                      className="hidden md:table-cell px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
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
                    {/* Team Devices and Team Admins, between Members and
                        Sub-teams -- same secondary-detail treatment as
                        Prefix/Sub-teams (hidden below `md`), since Members
                        is the one count every viewport needs and these two
                        are supporting detail reachable via the row's own
                        "View team details" action regardless of viewport. */}
                    <th 
                      className="hidden md:table-cell px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                      onClick={() => handleSort('device_count')}
                    >
                      <div className="flex items-center space-x-1">
                        <span>Team Devices</span>
                        {getSortIcon('device_count')}
                      </div>
                    </th>
                    <th 
                      className="hidden md:table-cell px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                      onClick={() => handleSort('admin_count')}
                    >
                      <div className="flex items-center space-x-1">
                        <span>Team Admins</span>
                        {getSortIcon('admin_count')}
                      </div>
                    </th>
                    <th 
                      className="hidden md:table-cell px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
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
                      <div className="relative group flex items-center" style={{ paddingLeft: `${Math.min(team.level, MAX_TABLE_INDENT_LEVELS) * 20}px` }}>
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
                          <TeamStatusIcons team={team} />
                        </div>
                        {team.description && (
                          // Sideways-opening (`left-full`/`ml-2`), matching
                          // this codebase's tooltip convention: the table is
                          // wrapped in `overflow-x-auto` (one overflow axis
                          // `auto`, the other implicitly `visible`), which
                          // clips a `bottom-full`/`top-full` tooltip on both
                          // axes -- the same Tooltip_Clipping_Defect
                          // `FormattedDate` tooltips are built to avoid.
                          <div className="absolute left-full top-1/2 transform -translate-y-1/2 ml-2 px-3 py-2 bg-gray-900 text-white text-sm rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10 whitespace-normal w-64">
                            {team.description}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="hidden md:table-cell px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      {team.callsign_prefix || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      <Link to={`/teams/${team.id}?tab=members`} className="hover:text-primary-600 dark:hover:text-primary-400 hover:underline">
                        {team.member_count || 0}
                      </Link>
                    </td>
                    <td className="hidden md:table-cell px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      <Link to={`/teams/${team.id}?tab=devices`} className="hover:text-primary-600 dark:hover:text-primary-400 hover:underline">
                        {team.device_count || 0}
                      </Link>
                    </td>
                    <td className="hidden md:table-cell px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      <Link to={`/teams/${team.id}?tab=admins`} className="hover:text-primary-600 dark:hover:text-primary-400 hover:underline">
                        {team.admin_count || 0}
                      </Link>
                    </td>
                    <td className="hidden md:table-cell px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      <Link to={`/teams/${team.id}?tab=subteams`} className="hover:text-primary-600 dark:hover:text-primary-400 hover:underline">
                        {team.sub_teams_count || 0}
                      </Link>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {team.role ? (
                        <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                          team.role === 'admin' 
                            ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' 
                            : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
                        }`}>
                          {team.role}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <TeamRowActions
                        team={team}
                        isGlobalAdmin={isGlobalAdmin}
                        onEdit={startEditingTeam}
                        onDelete={setDeleteTeamId}
                      />
                    </td>
                  </tr>
                  ))}
                </tbody>
              </table>
            </div>
            
            {/* Pagination. Bugfix: `flex-wrap gap-2` (was a non-wrapping
                `justify-between` row) -- the summary text ("Showing 1 to
                15 of 47 teams") competing against the Previous/Page-N-
                of-M/Next button cluster on one line was tight on a
                narrow phone with no fallback; this drops the button
                cluster to its own line instead of overflowing. */}
            {totalPages > 1 && (
              <div className="px-6 py-3 border-t border-gray-200 dark:border-gray-700">
                <div className="flex flex-wrap items-center justify-between gap-2">
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

      {/* Create/Edit Team Dialog (shared with TeamDetail.jsx). This page's
          dialog is only ever openable by a Global_Manager (see
          `isGlobalAdmin`-gated buttons above), so `isGlobalManager` is
          passed explicitly for clarity even though the prop's own default
          would already cover this call site. */}
      <TeamFormDialog
        mode={editingTeam ? 'edit' : 'create'}
        team={editingTeam}
        teams={teams}
        maxTeamDepth={maxTeamDepth}
        colorMappings={colorMappings}
        isOpen={showCreateDialog}
        onClose={closeTeamFormDialog}
        onSaved={handleTeamSaved}
        isGlobalManager={isGlobalAdmin}
      />

      {/* Delete Confirmation Dialog */}
      {deleteTeamId && (() => {
        const deleteLabel = labelFor(teams.find(t => t.id === deleteTeamId))
        return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-team-title"
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full"
          >
            <div className="p-6">
              <h3 id="delete-team-title" className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
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
                  className="btn-danger disabled:opacity-50"
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
