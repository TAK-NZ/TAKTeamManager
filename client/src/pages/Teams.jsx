import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { PlusIcon, UserGroupIcon, TrashIcon, MagnifyingGlassIcon, ChevronUpIcon, ChevronDownIcon, ChevronRightIcon, EyeSlashIcon, ArrowLeftOnRectangleIcon, PencilIcon, QrCodeIcon, UsersIcon, DevicePhoneMobileIcon, ShieldCheckIcon, BuildingOfficeIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { teamsAPI, configAPI } from '../services/api'
import api from '../services/api'
import { labelFor } from '../utils/teamLabels'
import { startVisibilityPausedRefresh } from '../utils/visibilityPausedRefresh'
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
 * Bugfix (Foreign_Partner Organisation country prefix): a team's
 * DISPLAYED prefix must be its EFFECTIVE prefix -- the Foreign_Partner
 * `country_code` (if any) composed as the leading segment ahead of
 * `callsign_prefix`, e.g. `FJI-FIRE` for a Fiji fire Organisation whose
 * own `callsign_prefix` is just `FIRE` -- not the bare `callsign_prefix`
 * column alone. Mirrors `userAttributes.computeCallsignAttributes`'s own
 * composition rule exactly (`[country_code, callsign_prefix].filter(...)
 * .join('-')`), so this page shows the same prefix that is actually
 * assembled into every member's callsign. A Sub_Team's own `country_code`
 * is always null (Organisation-only, per `Team.create`/`Team.update`),
 * so this degrades to the bare `callsign_prefix` for one automatically --
 * safe to call on any team row, root or not.
 *
 * @param {{callsign_prefix?: string|null, country_code?: string|null}|null|undefined} team
 * @returns {string|null} the effective prefix, or null when the team has
 *   neither a country nor a prefix at all.
 */
export function effectivePrefix(team) {
  if (!team) {
    return null
  }
  const composed = [team.country_code, team.callsign_prefix]
    .filter((segment) => !!segment && String(segment).trim() !== '')
    .join('-')
  return composed || null
}

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
  return rootOrgLabel(team, teams)
}

/**
 * The label used to prefix a Sub_Team's displayed name (e.g. the "LSAR"
 * in "LSAR - Auckland"): the ROOT Organisation's `callsign_prefix` (or
 * its `name` as a fallback), NOT the immediate parent's.
 *
 * This mirrors the server's canonical team-display-name rule (see
 * `SignupFlowService.getAvailableTeams` / `Team.getJoinableTeams`, which
 * resolve the org via the ancestor chain's root, `parent_team_id IS
 * NULL`) so `/teams` matches what `/request-access` shows. Using the
 * IMMEDIATE parent's prefix instead was the bug: a deeply-nested team
 * like LandSAR > Specialist Teams > Cave Search and Rescue > Auckland
 * rendered as "CAVE - Auckland" (the immediate parent Cave's prefix)
 * rather than the correct "LSAR - Auckland" (the root Organisation's).
 *
 * Walks `parent_team_id` up through the already-fetched flat `teams`
 * list to the root. Terminates defensively (returning the deepest
 * ancestor actually found in the list) if an ancestor is missing -- the
 * same "parent not in the list" case `buildTeamHierarchy` and
 * `computeTeamDepth` already tolerate, e.g. a non-admin who only sees
 * part of the tree. A `seen` set guards against a cyclic
 * `parent_team_id` chain, matching `isPseudonymousOrganisation`'s own
 * defensive walk in TeamDetail.jsx.
 *
 * @param {{parent_team_id?: number|string|null}} team - a Sub_Team.
 * @param {Array<{id: number|string, parent_team_id?: number|string|null, callsign_prefix?: string, name?: string}>} teams
 * @returns {string|null} the root Organisation's label, or null if it
 *   cannot be resolved at all.
 */
export function rootOrgLabel(team, teams) {
  if (!team) {
    return null
  }
  const teamsById = new Map((teams || []).map((t) => [t.id, t]))
  const seen = new Set([team.id])
  let current = teamsById.get(team.parent_team_id)
  let root = current
  while (current && current.parent_team_id != null && !seen.has(current.id)) {
    seen.add(current.id)
    const next = teamsById.get(current.parent_team_id)
    if (!next) {
      break
    }
    current = next
    root = current
  }
  if (!root) {
    return null
  }
  return effectivePrefix(root) || root.name || 'Root'
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
        // Bugfix: was a distinct purple accent (text-purple-500), unlike
        // Private/Joinable above which use a semantic red/green. A
        // sign-up code isn't a state that needs its own alert colour, so
        // this now matches the team name link's own text colour
        // (text-gray-900 dark:text-gray-100) instead of standing out.
        <QrCodeIcon className="h-4 w-4 text-gray-900 dark:text-gray-100 flex-shrink-0" title="Has sign-up code" />
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
      {/* Cascade-delete feature: a Global_Manager may now delete a team
          even when it HAS sub-teams -- the whole subtree is removed,
          gated server-side on the subtree being empty of members and
          team devices (the confirmation dialog surfaces that gate's
          refusal inline). The delete button is therefore no longer
          disabled for a team-with-sub-teams; the title just notes the
          cascade so the operator knows what they're about to do. */}
      {isGlobalAdmin && (
        <button
          onClick={() => onDelete(team.id)}
          className={`${boxClass} ${dangerClass}`}
          title={hasSubTeams ? 'Delete team and all its sub-teams' : 'Delete team'}
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
  // Cascade-delete feature: deleting an org/team (including one WITH
  // sub-teams, now permitted for a Global_Manager) is a PERMANENT
  // deletion, so it uses this app's type-to-confirm tier -- the operator
  // must type the target's name exactly before Confirm enables (matching
  // SuspendAccountDialog / "Permanently Delete User" / "Delete Channel").
  // `deleteConfirmInput` holds that typed value; `deleteError` surfaces
  // the server's own refusal (e.g. the 409 empty-subtree gate: "Cannot
  // delete: this team or its sub-teams still have N members …") inline in
  // the dialog rather than only as a toast.
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('')
  const [deleteError, setDeleteError] = useState(null)
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
      // Bugfix (regular user saw "No teams yet"): these three fetches used
      // to be one `Promise.all`, so a rejection in ANY of them cleared the
      // whole page. GET /api/config/color-mappings is Global_Manager-only
      // (permissions.registry.js: 'config:read:mappings') and 403s for a
      // regular member -- which sank the team-list fetch alongside it and
      // rendered the empty state even though the user has teams. Colour
      // mappings and max-depth are purely cosmetic here, so each fetch is
      // now isolated with Promise.allSettled: a forbidden/failed config
      // call no longer blanks the team list.
      const [teamsResult, colorResult, publicConfigResult] = await Promise.allSettled([
        teamsAPI.getAllMyTeams(),
        api.get('/config/color-mappings'),
        configAPI.getPublic()
      ])

      if (teamsResult.status === 'fulfilled') {
        setTeams(teamsResult.value)
      } else {
        console.error('Failed to fetch teams:', teamsResult.reason)
      }
      if (colorResult.status === 'fulfilled') {
        setColorMappings(colorResult.value.data.colorMappings || {})
      }
      if (publicConfigResult.status === 'fulfilled') {
        setMaxTeamDepth(publicConfigResult.value.data.maxTeamDepth ?? null)
      }
      setLoading(false)
    }

    fetchData()
  }, [])

  // Auto-refresh the team list on the shared visibility-paused 60s interval
  // (the same mechanism the Dashboard/Admin cards use), so an open /teams page
  // reflects teams created/renamed/deleted elsewhere without a manual reload.
  // Only the `teams` list is refreshed -- the cosmetic colour mappings and
  // max-depth loaded once above do not change at runtime. Client-side view
  // state (search term, sort, pagination, expanded rows) is NOT re-derived
  // from this fetch, so a background refresh preserves it.
  //
  // Paused while a create/edit or delete dialog is open: those dialogs read
  // from `teams`/`editingTeam`, and refreshing the underlying list out from
  // under an operator mid-edit is exactly the disruption the Dashboard's
  // open-dialog guard avoids. `dialogOpenRef` lets the stable refresh closure
  // see the current open/closed state without re-subscribing the interval.
  const dialogOpenRef = useRef(false)
  dialogOpenRef.current = showCreateDialog || deleteTeamId !== null

  const refreshTeams = useCallback(async () => {
    if (dialogOpenRef.current) {
      return
    }
    try {
      const teams = await teamsAPI.getAllMyTeams()
      setTeams(teams)
    } catch (error) {
      // A failed background refresh leaves the last-good list on screen.
      console.error('Failed to refresh teams:', error)
    }
  }, [])

  useEffect(() => startVisibilityPausedRefresh(refreshTeams), [refreshTeams])

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
      // Bugfix (Foreign_Partner Organisation country prefix): search the
      // EFFECTIVE prefix (e.g. "FJI-FIRE"), not just the bare
      // callsign_prefix column, so typing a country code alone (e.g.
      // "FJI") finds the org too.
      (effectivePrefix(team) && effectivePrefix(team).toLowerCase().includes(searchTerm.toLowerCase()))
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

  // Closes the delete dialog and clears its transient state, so a
  // re-open never starts pre-filled with a stale typed name or a stale
  // error (matching SuspendAccountDialog's Cancel-clears-the-input
  // convention).
  const closeDeleteDialog = () => {
    setDeleteTeamId(null)
    setDeleteConfirmInput('')
    setDeleteError(null)
  }

  // Computes the set of team ids in a team's subtree (the team plus every
  // descendant), from the already-fetched flat `teams` list, so a
  // successful cascade delete removes the WHOLE subtree from local state
  // rather than leaving orphaned descendant rows on screen until the next
  // fetch. Iterative breadth-first walk over parent_team_id.
  const subtreeTeamIds = (rootId) => {
    const ids = new Set([rootId])
    let added = true
    while (added) {
      added = false
      for (const t of teams) {
        if (t.parent_team_id != null && ids.has(t.parent_team_id) && !ids.has(t.id)) {
          ids.add(t.id)
          added = true
        }
      }
    }
    return ids
  }

  const handleDeleteTeam = async () => {
    if (!deleteTeamId) return

    setDeleting(true)
    setDeleteError(null)
    try {
      await teamsAPI.delete(deleteTeamId)
      // Cascade delete removes the team AND all descendants server-side;
      // mirror that locally so the list doesn't show orphaned children.
      const removed = subtreeTeamIds(deleteTeamId)
      setTeams(teams.filter(team => !removed.has(team.id)))
      closeDeleteDialog()
    } catch (error) {
      console.error('Failed to delete team:', error)
      // Surface the server's own message inline in the dialog (e.g. the
      // 409 empty-subtree gate naming member/device counts), keeping the
      // dialog open so the operator can read it and act, rather than
      // dismissing it as a transient toast.
      setDeleteError(error.response?.data?.error || error.message || 'Failed to delete team')
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
                        {/* The Team Devices tab is management-only (the
                            server 403s a non-admin listing a team's devices),
                            and TeamDetail now hides that tab unless the caller
                            can manage the team. So only link the count into
                            `?tab=devices` for a team this caller `can_manage`
                            -- otherwise the link would land on a tab that
                            renders nothing. The other counts stay linked;
                            their tabs are visible to everyone. */}
                        {team.can_manage ? (
                          <Link to={`/teams/${team.id}?tab=devices`} className="text-gray-900 dark:text-gray-100 hover:text-primary-600 dark:hover:text-primary-400 hover:underline">
                            {team.device_count || 0}
                          </Link>
                        ) : (
                          <span className="text-gray-900 dark:text-gray-100">{team.device_count || 0}</span>
                        )}
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
                      {effectivePrefix(team) && (
                        <div className="flex items-baseline gap-1">
                          <span className="text-xs text-gray-500 dark:text-gray-400">Prefix:</span>
                          <span className="text-gray-900 dark:text-gray-100">{effectivePrefix(team)}</span>
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
                    {/* The four count columns (Members, Team Devices,
                        Team Admins, Sub-teams) use an ICON header rather
                        than a text label, so each column is only as wide
                        as an icon + sort chevron -- reclaiming the
                        horizontal space the uppercase words used to take
                        (the table no longer needs to overflow-scroll on a
                        typical desktop). The meaning is NOT carried by
                        the icon alone (accessibility): each header keeps
                        an `aria-label` and a native `title` naming the
                        column, and the icon itself is `aria-hidden`. The
                        icons match TeamDetail.jsx's own tab iconography
                        for these exact concepts (UsersIcon / Device-
                        PhoneMobileIcon / ShieldCheckIcon / Building-
                        OfficeIcon), so the two surfaces can't drift on
                        what "members"/"devices"/"admins"/"sub-teams" look
                        like. `px-3` (was `px-6`) tightens them further.
                        Sort behaviour is unchanged. */}
                    <th
                      className="px-3 py-3 text-left cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                      onClick={() => handleSort('member_count')}
                      aria-label="Members"
                      title="Members"
                    >
                      <div className="flex items-center space-x-1 text-gray-500 dark:text-gray-400">
                        <UsersIcon className="h-4 w-4" aria-hidden="true" />
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
                      className="hidden md:table-cell px-3 py-3 text-left cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                      onClick={() => handleSort('device_count')}
                      aria-label="Team Devices"
                      title="Team Devices"
                    >
                      <div className="flex items-center space-x-1 text-gray-500 dark:text-gray-400">
                        <DevicePhoneMobileIcon className="h-4 w-4" aria-hidden="true" />
                        {getSortIcon('device_count')}
                      </div>
                    </th>
                    <th
                      className="hidden md:table-cell px-3 py-3 text-left cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                      onClick={() => handleSort('admin_count')}
                      aria-label="Team Admins"
                      title="Team Admins"
                    >
                      <div className="flex items-center space-x-1 text-gray-500 dark:text-gray-400">
                        <ShieldCheckIcon className="h-4 w-4" aria-hidden="true" />
                        {getSortIcon('admin_count')}
                      </div>
                    </th>
                    <th
                      className="hidden md:table-cell px-3 py-3 text-left cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                      onClick={() => handleSort('sub_teams_count')}
                      aria-label="Sub-teams"
                      title="Sub-teams"
                    >
                      <div className="flex items-center space-x-1 text-gray-500 dark:text-gray-400">
                        <BuildingOfficeIcon className="h-4 w-4" aria-hidden="true" />
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
                    {/* Name cell: shows ONLY the team's own name -- the
                        parent org/team prefix is deliberately NOT
                        prepended, because the hierarchy is already
                        conveyed by the row's indentation and the expand
                        tree, so `LANDSAR - Local Groups` would be
                        redundant noise. The full parent context is still
                        reachable on hover/focus via the `title`
                        (`Parent > Name`), and via the row's own "View
                        team details" link. `max-w-0 w-full` on the cell +
                        `min-w-0` on the inner flex + `truncate` on the
                        name let the name absorb the width the narrowed
                        count columns freed up and ellipsize when a single
                        name is genuinely too long, rather than forcing the
                        table to overflow-scroll. */}
                    <td className="px-6 py-4 max-w-0 w-full">
                      <div
                        className="relative group flex items-center min-w-0"
                        style={{ paddingLeft: `${Math.min(team.level, MAX_TABLE_INDENT_LEVELS) * 20}px` }}
                      >
                        {team.hasChildren ? (
                          <button
                            onClick={() => toggleExpanded(team.id)}
                            className="mr-2 p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded flex-shrink-0"
                          >
                            {expandedTeams.has(team.id) ? (
                              <ChevronDownIcon className="h-4 w-4 text-gray-500" />
                            ) : (
                              <ChevronRightIcon className="h-4 w-4 text-gray-500" />
                            )}
                          </button>
                        ) : (
                          <div className="w-6 mr-2 flex-shrink-0" />
                        )}
                        <div className="flex items-center space-x-2 min-w-0">
                          <Link
                            to={`/teams/${team.id}`}
                            className="truncate min-w-0 text-sm font-medium text-gray-900 dark:text-gray-100 hover:text-primary-600 dark:hover:text-primary-400 cursor-pointer"
                            title={team.level > 0 ? `${rootOrgLabel(team, teams) || 'Root'} > ${team.name}` : team.name}
                          >
                            {team.name}
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
                      {effectivePrefix(team) || '-'}
                    </td>
                    {/* px-3 (was px-6) to match the narrowed icon headers
                        above, so these count columns are actually narrower
                        rather than just having a narrower header label. */}
                    <td className="px-3 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      <Link to={`/teams/${team.id}?tab=members`} className="hover:text-primary-600 dark:hover:text-primary-400 hover:underline">
                        {team.member_count || 0}
                      </Link>
                    </td>
                    <td className="hidden md:table-cell px-3 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      {/* Only link the device count for a team this caller
                          can manage -- see the mobile card's matching note:
                          the `?tab=devices` tab is hidden from non-managers,
                          so a link would dead-end there. */}
                      {team.can_manage ? (
                        <Link to={`/teams/${team.id}?tab=devices`} className="hover:text-primary-600 dark:hover:text-primary-400 hover:underline">
                          {team.device_count || 0}
                        </Link>
                      ) : (
                        <span>{team.device_count || 0}</span>
                      )}
                    </td>
                    <td className="hidden md:table-cell px-3 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      <Link to={`/teams/${team.id}?tab=admins`} className="hover:text-primary-600 dark:hover:text-primary-400 hover:underline">
                        {team.admin_count || 0}
                      </Link>
                    </td>
                    <td className="hidden md:table-cell px-3 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
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

      {/* Delete Confirmation Dialog.
          Cascade-delete feature: PERMANENT deletion of an org/team is on
          this app's type-to-confirm tier (the operator must type the
          target's name exactly before Confirm enables), matching
          SuspendAccountDialog / "Permanently Delete User" / "Delete
          Channel". This upgrades the previous plain Cancel/Confirm
          dialog, which was a standing exception to the "every permanent
          deletion uses type-to-confirm" convention. When the target has
          sub-teams, the dialog states the whole subtree will be deleted;
          the server's empty-subtree gate (409 naming member/device
          counts) is surfaced inline via `deleteError`. */}
      {deleteTeamId && (() => {
        const deleteTeam = teams.find(t => t.id === deleteTeamId)
        const deleteLabel = labelFor(deleteTeam)
        const targetName = deleteTeam?.name || ''
        const subTeamsCount = deleteTeam?.sub_teams_count || 0
        const hasSubTeams = subTeamsCount > 0
        const confirmDisabled = deleting || deleteConfirmInput !== targetName
        return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-team-title"
            className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-md sm:w-full sm:h-auto sm:max-h-[90vh] overflow-y-auto"
          >
            <div className="p-6 space-y-4">
              <h3 id="delete-team-title" className="text-lg font-medium text-gray-900 dark:text-gray-100">
                Delete {deleteLabel}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Permanently delete <span className="font-medium text-gray-900 dark:text-gray-100">{targetName}</span>?
                This cannot be undone.
              </p>

              {hasSubTeams && (
                <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 p-3">
                  <p className="text-sm text-amber-800 dark:text-amber-300">
                    This will also permanently delete all {subTeamsCount} sub-team{subTeamsCount === 1 ? '' : 's'} beneath it.
                    Deletion is only allowed when no team in this branch has any members or team devices.
                  </p>
                </div>
              )}

              <div>
                <label htmlFor="delete-team-confirm" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Type "<span className="font-mono font-bold text-gray-900 dark:text-gray-100">{targetName}</span>" to confirm:
                </label>
                <input
                  id="delete-team-confirm"
                  type="text"
                  className="input w-full"
                  value={deleteConfirmInput}
                  onChange={(e) => setDeleteConfirmInput(e.target.value)}
                  placeholder={targetName}
                  autoComplete="off"
                  disabled={deleting}
                />
              </div>

              {deleteError && (
                <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                  {deleteError}
                </p>
              )}

              <div className="flex justify-end space-x-3 pt-2 border-t border-gray-200 dark:border-gray-700">
                <button
                  type="button"
                  onClick={closeDeleteDialog}
                  className="btn-secondary"
                  disabled={deleting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDeleteTeam}
                  disabled={confirmDisabled}
                  className="btn-danger disabled:opacity-50 disabled:cursor-not-allowed"
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
