import { useState, useEffect, useCallback, useMemo } from 'react'
import { PlusIcon, MagnifyingGlassIcon, XMarkIcon, ChevronUpIcon, ChevronDownIcon, ArrowUpTrayIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { usersAPI, teamsAPI, configAPI } from '../services/api'
import FormattedDate, { DATE_PRECISION, TOOLTIP_SIDES } from '../components/FormattedDate'
import UserDevicesModal, { useDeviceManagementEnabled } from '../components/UserDevicesModal'
import BulkImportUsersDialog from '../components/BulkImportUsersDialog'
import MemberActions from '../components/MemberActions'
import MemberEditRow, {
  getInitialMemberEditForm,
  isValidMemberCallsignSuffix,
  DEFAULT_TAK_ROLE_VALUES
} from '../components/MemberEditRow'
import TransferMemberDialog from '../components/TransferMemberDialog'
import SuspendAccountDialog from '../components/SuspendAccountDialog'
import { describeAccountStatusBadge } from '../utils/accountStatusBadge'
import { isValidNewUserEmail, extractCallsignSuffixServerError } from '../utils/newUserForm'
import { formatNumber } from '../utils/formatNumber'

/**
 * Users-page-action-parity: /users' row actions (Edit, Resend welcome,
 * Transfer, View Devices, Remove) now match /teams' Member_List actions
 * exactly -- same icons, same shared components, same server contract --
 * and the header's "Create User" button, previously dead (no `onClick`
 * at all), now opens a working create dialog.
 *
 * Three structural differences from `TeamDetail.jsx`'s Member_List, all
 * because this page has no single "current team" in scope the way a
 * team-detail page does:
 *
 * - Every row here potentially belongs to a DIFFERENT team, so `team_id`
 *   (added to `GET /api/users`'s response alongside the pre-existing
 *   `team_name` display string) travels on the row itself rather than
 *   coming from a page-level `team` object.
 * - `/users`' listing is deliberately Organisation-wide (`DirectoryScopeService`),
 *   which is a WIDER visibility scope than any single Member_List. Without
 *   a further check, this page would let a Team_Admin act on a user in a
 *   sibling sub-team they don't administer -- something `/teams` never
 *   allows. `GET /api/users` closes that gap with `can_manage` (mirroring
 *   `Team.isAdmin`'s ancestor-inclusive admin check), and `MemberActions`'
 *   `hasTeam` prop is fed `Boolean(team_id) && can_manage` here rather than
 *   just `Boolean(team_id)` -- see that component's own doc comment. This
 *   gates EVERY action (Edit, Resend, Transfer, View Devices, Delete), not
 *   only the three that strictly need a `teamId` value: Resend and View
 *   Devices are already independently team-admin-scoped server-side
 *   (`user:resend_welcome:team_admin`, `isManagedUser`), so disabling them
 *   here is the client reflecting an existing server rule, not inventing a
 *   new one. Visibility (who appears in the list) and management
 *   authority (which visible rows carry live action buttons) are
 *   deliberately answered by two separate mechanisms.
 * - "Create User" has no team pre-selected, so the dialog collects one
 *   (a team the caller administers) before submitting, unlike the Add
 *   Member Dialog's fixed target team.
 */
export default function Users({ user }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [users, setUsers] = useState([])
  // Pagination follow-up: mirrors Devices.jsx's own pagination state
  // shape/effect/footer exactly. GET /api/users' list was previously
  // fetched unbounded-looking but actually server-defaulted to page=1/
  // pageSize=50 -- this made the page silently show only the first 50
  // users with no indication more existed, and no way to reach them.
  // pageSize is 20 here (the CLIENT's own chosen default -- the server's
  // own `paginationParams` default of 50 is unrelated and still applies
  // to any caller that omits pageSize entirely).
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Requirement 6.4 (device-management task 15.4): the row whose "Devices"
  // action was activated, i.e. the user `UserDevicesModal` is open for. Null
  // when the modal is closed -- at most one is ever open. The SAME modal
  // component is attached in the Orgs & Teams view (`TeamDetail.jsx`), so
  // the device list itself is defined once, not per surface.
  const [devicesForUser, setDevicesForUser] = useState(null)
  // The device surfaces exist only WHILE the server-side DEVICE_MGMT_ENABLED
  // flag is on, and that flag is never exposed through /api/config/public
  // (Requirement 1.4), so the affordance is gated on the reachability probe.
  const devicesEnabled = useDeviceManagementEnabled()

  // "Import Users" -- the global CSV bulk-import
  // dialog, with no default target team (each row's own `teamId` column
  // decides), unlike TeamDetail.jsx's team-scoped entry point.
  const [showBulkImportDialog, setShowBulkImportDialog] = useState(false)

  // Users-page-action-parity: the row currently open for inline edit
  // (First Name/Last Name/TAK Role/Callsign Suffix), mirroring
  // `TeamDetail.jsx`'s `editingMemberId`/`memberEditForm`. At most one row
  // is ever being edited.
  const [editingUserId, setEditingUserId] = useState(null)
  const [memberEditForm, setMemberEditForm] = useState(getInitialMemberEditForm(null))
  const [savingMemberEdit, setSavingMemberEdit] = useState(false)
  const [memberEditError, setMemberEditError] = useState(null)
  const [takRoleValues, setTakRoleValues] = useState(DEFAULT_TAK_ROLE_VALUES)

  // The row whose Transfer dialog is open. Null when closed.
  const [transferringUser, setTransferringUser] = useState(null)

  // account-lifecycle-management: the row whose Suspend/Unsuspend
  // confirmation is open, or null when closed. `{ user, mode }` rather
  // than just the row, mirroring `TeamDetail.jsx`'s own
  // `suspendingMember` -- the same `SuspendAccountDialog` serves both
  // directions, and the row's current `account_status` decides which
  // one this action opens.
  const [suspendingUser, setSuspendingUser] = useState(null)

  // The Permanently-Delete-User confirmation dialog's state, mirroring
  // `TeamDetail.jsx`'s `removeUserId`/`removeConfirmInput`/`removingUser`.
  const [removeUserId, setRemoveUserId] = useState(null)
  const [removeConfirmInput, setRemoveConfirmInput] = useState('')
  const [removingUser, setRemovingUser] = useState(false)

  // Bugfix (Resend welcome email was the only action with no
  // confirmation): mirrors `TeamDetail.jsx`'s own
  // `resendingWelcomeTo`/`resendingWelcomeInFlight`. Holds the target
  // row itself (not just an id) since the dialog needs its email.
  const [resendingWelcomeTo, setResendingWelcomeTo] = useState(null)
  const [resendingWelcomeInFlight, setResendingWelcomeInFlight] = useState(false)

  // "Create User" dialog state.
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [createTeams, setCreateTeams] = useState([])
  const [loadingCreateTeams, setLoadingCreateTeams] = useState(false)
  const [createForm, setCreateForm] = useState({ email: '', firstName: '', lastName: '', teamId: '' })
  const [createEmailError, setCreateEmailError] = useState(null)
  const [createError, setCreateError] = useState(null)
  const [creatingUser, setCreatingUser] = useState(false)

  // Sorting by "User" (name) or "Last Login", mirroring TeamDetail.jsx's
  // own sortField/sortDirection + handleSort/getSortIcon convention
  // (clicking the active column's header flips direction; clicking a
  // different column switches to it, ascending). Only these two columns
  // are sortable -- Unit and Status filtering/sorting are a separate,
  // not-yet-implemented piece of work.
  const [sortField, setSortField] = useState('name')
  const [sortDirection, setSortDirection] = useState('asc')

  // Large-directory filters (server-side; see GET /api/users' teamId +
  // lastNameInitial params). Both narrow the query BEFORE pagination/total, so
  // the footer count and page navigation stay correct under a filter.
  //   teamFilter      -- a team id string ('' = all teams).
  //   lastNameFilter  -- a single uppercase letter, '#' (non-alphabetic
  //                      last-name bucket), or '' (all initials).
  const [teamFilter, setTeamFilter] = useState('')
  const [lastNameFilter, setLastNameFilter] = useState('')

  // Teams the caller may filter by, loaded once (Organisation-scoped, same
  // source the Create/Transfer dialogs use). A Global_Manager with no team of
  // their own falls back to every team, exactly as those dialogs do.
  const [filterTeams, setFilterTeams] = useState([])

  // Pagination follow-up: mirrors Devices.jsx's own fetchDevices exactly --
  // a useCallback depending on [pagination.page, pagination.pageSize,
  // searchQuery], echoing the server's returned pagination object back
  // into state (page/pageSize/total), rather than trusting the locally
  // held page/pageSize as still current. `search` narrows server-side via
  // Authentik's own search param (GET /api/users' doc comment), so the
  // client no longer filters `name`/`email`/`username` in memory -- see
  // `sortedUsers` below, which now only sorts, never filters.
  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      const response = await usersAPI.getAll({
        page: pagination.page,
        pageSize: pagination.pageSize,
        search: searchQuery || undefined,
        // Server-side filters; `stripEmptyParams` in usersAPI.getAll drops an
        // empty string, so '' means "no filter" without sending a literal.
        teamId: teamFilter || undefined,
        lastNameInitial: lastNameFilter || undefined
      })
      setUsers(response.data?.users || response.data || [])
      setPagination((prev) => response.data?.pagination || prev)
      setError(null)
    } catch (error) {
      console.error('Failed to fetch users:', error)
      setError(`Failed to load users: ${error.message}`)
    } finally {
      setLoading(false)
    }
  }, [pagination.page, pagination.pageSize, searchQuery, teamFilter, lastNameFilter])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  // Requirement 13.5 (mirrors TeamDetail.jsx): the 8 predefined TAK_Role
  // values, sourced from GET /api/config/public's `takRoleValues` field so
  // this Client never hardcodes a second copy of settings.js's
  // ROLE_KEY_LABELS allow-list.
  useEffect(() => {
    let isCancelled = false
    configAPI.getPublic().then((response) => {
      if (isCancelled) return
      if (Array.isArray(response.data.takRoleValues) && response.data.takRoleValues.length > 0) {
        setTakRoleValues(response.data.takRoleValues)
      }
    }).catch((err) => {
      console.error('Failed to fetch public config:', err)
    })
    return () => {
      isCancelled = true
    }
  }, [])

  // Load the teams the caller may filter by, once. Organisation-scoped (the
  // same source the Create/Transfer dialogs use); a Global_Manager with no
  // team of their own falls back to every team, exactly as those dialogs do.
  // Failure is non-fatal: the Team filter simply stays empty (the list still
  // works, just without that one narrowing control).
  useEffect(() => {
    let isCancelled = false
    ;(async () => {
      try {
        const scopedResponse = await teamsAPI.getMyTeams({ scope: 'organisation' })
        let teams = scopedResponse.data?.teams || []
        if (teams.length === 0 && user?.isAdmin) {
          const allResponse = await teamsAPI.getMyTeams()
          teams = allResponse.data?.teams || []
        }
        if (!isCancelled) setFilterTeams(teams)
      } catch (err) {
        console.error('Failed to fetch teams for the Users filter:', err)
      }
    })()
    return () => {
      isCancelled = true
    }
  }, [user?.isAdmin])

  // Pagination follow-up: search is now server-side (GET /api/users'
  // `search` param, forwarded to Authentik -- see fetchUsers above), so
  // `users` is already the correctly-filtered current page and needs no
  // further client-side filtering. Only sorting remains a client-side
  // concern, exactly like Devices.jsx's own `sortedDevices`.
  //
  // `name` sorts case-insensitively as a string, matching
  // TeamDetail.jsx's own `filterAndSort`. `last_login` sorts as a
  // timestamp: an absent/unparseable value (`Date.parse` -> `NaN`) is
  // treated as the earliest possible time (`-Infinity`) rather than
  // `NaN` itself, since `NaN` compares false against everything and
  // would leave a "Never" row's position undefined relative to its
  // neighbours -- this way "Never" rows sort first ascending, last
  // descending, consistent with them being the oldest activity.
  //
  // Performance-hardening: memoized against [users, sortField,
  // sortDirection] so an unrelated re-render (e.g. opening an edit row,
  // a dialog, or updating takRoleValues) does not re-sort the fetched
  // page from scratch.
  const sortedUsers = useMemo(() => (
    sortField
      ? [...users].sort((a, b) => {
          let aValue
          let bValue
          if (sortField === 'last_login') {
            const aTime = Date.parse(a.last_login)
            const bTime = Date.parse(b.last_login)
            aValue = Number.isNaN(aTime) ? -Infinity : aTime
            bValue = Number.isNaN(bTime) ? -Infinity : bTime
          } else {
            aValue = (a[sortField] || '').toLowerCase()
            bValue = (b[sortField] || '').toLowerCase()
          }

          if (sortDirection === 'asc') {
            return aValue < bValue ? -1 : aValue > bValue ? 1 : 0
          }
          return aValue > bValue ? -1 : aValue < bValue ? 1 : 0
        })
      : users
  ), [users, sortField, sortDirection])

  const handleSort = (field) => {
    setSortDirection(sortField === field && sortDirection === 'asc' ? 'desc' : 'asc')
    setSortField(field)
  }

  const getSortIcon = (field) => {
    if (sortField !== field) return null
    return sortDirection === 'asc' ? (
      <ChevronUpIcon className="h-4 w-4" />
    ) : (
      <ChevronDownIcon className="h-4 w-4" />
    )
  }

  const handleStartEditUser = (targetUser) => {
    setEditingUserId(targetUser.pk)
    setMemberEditForm(getInitialMemberEditForm(targetUser))
    setMemberEditError(null)
  }

  const handleCancelEditUser = () => {
    setEditingUserId(null)
    setMemberEditError(null)
  }

  // Requirements 11.13, 11.16, 13.2, 13.3, 13.4, 13.6, 14.2, 14.3 (mirrors
  // TeamDetail.jsx's `handleSaveMemberEdit`): submits the inline edit
  // form's current values to `PATCH /api/teams/:teamId/members/:userId`,
  // using the ROW's own `team_id` -- this page has no single team in
  // scope, so each row supplies its own. `MemberActions`' `hasTeam` prop
  // keeps this from ever being invoked for a `team_id: null` row.
  const handleSaveMemberEdit = async (targetUser) => {
    if (!isValidMemberCallsignSuffix(memberEditForm.callsignSuffix)) {
      setMemberEditError('Callsign suffix may only contain letters, digits, "-", and "."')
      return
    }

    setSavingMemberEdit(true)
    setMemberEditError(null)
    try {
      const response = await teamsAPI.updateMember(targetUser.team_id, targetUser.local_user_id, {
        firstName: memberEditForm.firstName,
        lastName: memberEditForm.lastName,
        takRole: memberEditForm.takRole,
        callsignSuffix: memberEditForm.callsignSuffix
      })
      const updatedMember = response.data.member
      setUsers((prev) => prev.map((row) => (row.pk === targetUser.pk ? { ...row, ...updatedMember } : row)))
      setEditingUserId(null)
    } catch (error) {
      console.error('Failed to update user:', error)
      setMemberEditError(
        error.response?.data?.error || error.response?.data?.errors?.[0]?.msg || 'Failed to update user'
      )
    } finally {
      setSavingMemberEdit(false)
    }
  }

  // Bugfix (Resend welcome email was the only action with no
  // confirmation): opens the confirmation dialog for a single row,
  // mirroring `TeamDetail.jsx`'s `handleResendWelcomeClick`.
  const handleResendWelcomeClick = (targetUser) => {
    setResendingWelcomeTo(targetUser)
  }

  // Mirrors TeamDetail.jsx's `confirmResendWelcome`. `teamId` is cosmetic
  // server-side (used only to build the email's display text; the actual
  // authorization walks the user's real current teams), so this page's
  // per-row `team_id` (possibly null) is passed through as-is.
  const confirmResendWelcome = async () => {
    if (!resendingWelcomeTo) return

    setResendingWelcomeInFlight(true)
    try {
      await usersAPI.resendWelcome(resendingWelcomeTo.local_user_id, resendingWelcomeTo.team_id)
      toast.success(`Welcome email resent to ${resendingWelcomeTo.email}`)
      setResendingWelcomeTo(null)
    } catch (err) {
      toast.error('Failed to resend welcome email')
    } finally {
      setResendingWelcomeInFlight(false)
    }
  }

  const handleRemoveUser = (targetUser) => {
    setRemoveUserId(targetUser.local_user_id)
    setRemoveConfirmInput('')
  }

  // Mirrors TeamDetail.jsx's `confirmRemoveUser`. `usersAPI.removeFromTeam`
  // validates `teamId` as a required int server-side but does not actually
  // scope the deletion by it (the removal is total, per that route's own
  // documented behaviour) -- the row's own `team_id` is passed through
  // regardless, matching what the resolved `removeTarget` row carries.
  const confirmRemoveUser = async () => {
    if (!removeUserId) return

    const removeTarget = users.find((u) => u.local_user_id === removeUserId)

    setRemovingUser(true)
    try {
      const response = await usersAPI.removeFromTeam(removeUserId, removeTarget?.team_id ?? null)
      setUsers((prev) => prev.filter((u) => u.local_user_id !== removeUserId))
      window.dispatchEvent(new CustomEvent('userAssignmentChanged'))
      // Bugfix (silent Authentik-delete failure): the local account is
      // gone either way, but if Authentik's own account delete failed,
      // that Authentik identity may still exist (cleanup has been
      // queued for retry) -- worth a distinct toast, unlike the
      // certificate-revocation dry-run outcome (a static, deliberate
      // deployment setting, not a per-request failure), which is
      // recorded in the audit log rather than surfaced here every time.
      if (response?.data?.authentikAccountDeleted === false) {
        toast.error('User removed, but their Authentik account could not be deleted immediately. Cleanup has been queued for retry.')
      } else {
        toast.success('User permanently deleted')
      }
      setRemoveUserId(null)
      setRemoveConfirmInput('')
    } catch (error) {
      console.error('Failed to remove user:', error)
      toast.error('Failed to remove user: ' + (error.response?.data?.error || error.message))
    } finally {
      setRemovingUser(false)
    }
  }

  // Requirement 15.5-equivalent (mirrors TeamDetail.jsx's
  // `handleTransferCompleted`): refetches the list after a COMPLETED
  // transfer only -- a 202 (awaiting the other team's approval) leaves
  // the list untouched, per `TransferMemberDialog`'s own `onCompleted`
  // contract.
  const handleTransferCompleted = () => {
    fetchUsers()
  }

  // account-lifecycle-management: opens the Suspend/Unsuspend
  // confirmation for a row, mirroring `TeamDetail.jsx`'s own
  // `handleSuspendClick`. `mode` is derived from the row's OWN
  // `account_status` (falling back to 'active' -- i.e. offer Suspend --
  // for a row that doesn't carry the field yet), never from a
  // caller-supplied value.
  const handleSuspendClick = (targetUser) => {
    setSuspendingUser({
      user: targetUser,
      mode: targetUser.account_status === 'suspended' ? 'unsuspend' : 'suspend'
    })
  }

  const openCreateDialog = async () => {
    setCreateForm({ email: '', firstName: '', lastName: '', teamId: '' })
    setCreateEmailError(null)
    setCreateError(null)
    setShowCreateDialog(true)
    setLoadingCreateTeams(true)
    try {
      // Organisation-scoped list of teams the caller may add a user to,
      // matching TransferMemberDialog's own primary source; a
      // Global_Manager with no team of their own falls back to every
      // team exactly as that dialog does.
      const scopedResponse = await teamsAPI.getMyTeams({ scope: 'organisation' })
      let teams = scopedResponse.data?.teams || []
      if (teams.length === 0 && user?.isAdmin) {
        const allResponse = await teamsAPI.getMyTeams()
        teams = allResponse.data?.teams || []
      }
      setCreateTeams(teams)
    } catch (err) {
      console.error('Failed to fetch teams for Create User dialog:', err)
      setCreateError('Failed to load the list of teams.')
    } finally {
      setLoadingCreateTeams(false)
    }
  }

  const closeCreateDialog = () => {
    setShowCreateDialog(false)
  }

  const handleCreateUser = async (e) => {
    e.preventDefault()

    if (!isValidNewUserEmail(createForm.email)) {
      setCreateEmailError('Please enter a valid email address.')
      return
    }
    setCreateEmailError(null)

    if (!createForm.teamId) {
      setCreateError('Please select a team.')
      return
    }

    setCreatingUser(true)
    setCreateError(null)
    try {
      const response = await usersAPI.createAndAdd(
        createForm.email,
        createForm.firstName,
        createForm.lastName,
        createForm.teamId
      )
      // Bugfix (silent welcome-email failures): mirrors
      // `TeamDetail.jsx`'s own handling -- a single combined toast, not
      // a success toast plus a separate warning, since the account was
      // created either way and layering two toasts for one action would
      // read as contradictory.
      if (response?.data?.welcomeEmailSent === false) {
        toast.error(`User created, but the welcome email to ${createForm.email} could not be sent. You may need to resend it manually.`)
      } else {
        toast.success('User created and added to the selected team')
      }
      setShowCreateDialog(false)
      fetchUsers()
    } catch (error) {
      console.error('Failed to create user:', error)
      const inlineError = extractCallsignSuffixServerError(error)
      setCreateError(inlineError || error.response?.data?.error || error.message || 'Failed to create user')
    } finally {
      setCreatingUser(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Users</h1>
          <p className="text-gray-600 dark:text-gray-400">Manage users and their team assignments.</p>
        </div>
        {/* Mobile tap targets: icon-only below `sm:`, full text restored at
            `sm:` and up -- matching TeamDetail.jsx's "Add Member" button,
            this page's own closest equivalent single header action. */}
        <div className="flex flex-wrap gap-2">
          <button
            className="btn-secondary flex items-center justify-center sm:justify-start p-2 sm:px-4 sm:py-2"
            onClick={() => setShowBulkImportDialog(true)}
            aria-label="Import Users"
            title="Import Users"
          >
            <ArrowUpTrayIcon className="h-5 w-5 sm:h-4 sm:w-4 sm:mr-2" aria-hidden="true" />
            <span className="hidden sm:inline">Import Users</span>
          </button>
          <button
            className="btn-primary flex items-center justify-center sm:justify-start p-2 sm:px-4 sm:py-2"
            onClick={openCreateDialog}
            aria-label="Create User"
            title="Create User"
          >
            <PlusIcon className="h-5 w-5 sm:h-4 sm:w-4 sm:mr-2" aria-hidden="true" />
            <span className="hidden sm:inline">Create User</span>
          </button>
        </div>
      </div>

      {showBulkImportDialog && (
        <BulkImportUsersDialog
          onClose={() => setShowBulkImportDialog(false)}
          onImported={fetchUsers}
        />
      )}

      {/* Search -- now server-side (mirrors Devices.jsx's own search
          input): changing the term resets to page 1, since a filtered
          result set has its own page count, and staying on the
          previously-viewed page could point past the end of it. */}
      <div className="card space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
            <input
              type="text"
              placeholder="Search users by name, email, or username..."
              className="input pl-10"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                setPagination((prev) => ({ ...prev, page: 1 }))
              }}
            />
          </div>
          {/* Team filter (server-side `teamId`). Narrows to a single
              direct-membership team the caller can see. Changing it resets to
              page 1, since a filtered result set has its own page count. */}
          <div className="sm:w-72">
            <label htmlFor="users-team-filter" className="sr-only">Filter by unit</label>
            <select
              id="users-team-filter"
              className="input"
              value={teamFilter}
              onChange={(e) => {
                setTeamFilter(e.target.value)
                setPagination((prev) => ({ ...prev, page: 1 }))
              }}
            >
              <option value="">All units</option>
              {filterTeams.map((t) => (
                // `display_name` is the composed "<Org prefix> - <team name>"
                // (e.g. "FENZ - Ahipara") that GET /teams/my-teams already
                // returns from Team.getOrganisationTeams -- the SAME label the
                // Create-User picker and request-access surfaces use. Fall back
                // to the bare name only if display_name is somehow absent.
                <option key={t.id} value={String(t.id)}>{t.display_name || t.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Alphabet bar (server-side `lastNameInitial`). Filters by LAST NAME
            initial; '#' is the non-alphabetic bucket; "All" clears it. Each
            control carries its active state in TEXT/style, not colour alone
            (accessibility rule), via aria-pressed. Changing it resets to page
            1. Wraps on narrow screens. */}
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by last name initial">
          {['All', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''), '#'].map((label) => {
            const value = label === 'All' ? '' : label
            const isActive = lastNameFilter === value
            return (
              <button
                key={label}
                type="button"
                aria-pressed={isActive}
                onClick={() => {
                  setLastNameFilter(value)
                  setPagination((prev) => ({ ...prev, page: 1 }))
                }}
                className={`min-w-[2rem] px-2 py-1 text-sm rounded-md border ${
                  isActive
                    ? 'bg-primary-600 text-white border-primary-600 font-semibold'
                    : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Users List */}
      <div className="card">
        {loading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
            <p className="text-gray-500 dark:text-gray-400 mt-2">Loading users...</p>
          </div>
        ) : error ? (
          <div className="text-center py-12">
            <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>
          </div>
        ) : sortedUsers.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500 dark:text-gray-400">No users found.</p>
          </div>
        ) : (
          <>
          {/* Bugfix (mobile responsiveness parity with /dashboard,
              /downloads, /enrollment, /teams): a `sm:hidden` stacked card
              list PLUS the existing `hidden sm:block overflow-x-auto`
              table below, mirroring TeamDetail.jsx's Members tab -- same
              shared `MemberActions` component (`variant="card"` here vs.
              the table's default `variant="table"`), same
              `describeAccountStatusBadge` badge, same "wrap MemberEditRow
              in a one-column mini table" treatment for a row mid-edit. */}
          <div className="sm:hidden divide-y divide-gray-200 dark:divide-gray-700">
            {sortedUsers.map((targetUser) => (
              editingUserId === targetUser.pk ? (
                <div key={targetUser.pk} className="overflow-x-auto">
                  <table className="min-w-full">
                    <tbody>
                      <MemberEditRow
                        colSpan={1}
                        form={memberEditForm}
                        setForm={setMemberEditForm}
                        takRoleValues={takRoleValues}
                        saving={savingMemberEdit}
                        error={memberEditError}
                        onSave={() => handleSaveMemberEdit(targetUser)}
                        onCancel={handleCancelEditUser}
                      />
                    </tbody>
                  </table>
                </div>
              ) : (
                <div key={targetUser.pk} className="p-4 space-y-2 text-sm">
                  {/* Avatar removed (see the desktop table's own note): no
                      `avatar` field post-migration; it was decorative. */}
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 dark:text-gray-100 break-words">{targetUser.name}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 break-all">{targetUser.email}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {/* Callsign + the "TAK device certificates: N" count
                        stacked together (the count moved out of the name block
                        above) -- both are TAK-identity facts, grouped. */}
                    <div>
                      <p className="text-gray-500 dark:text-gray-400">
                        Callsign: <span className="text-gray-900 dark:text-gray-100">{targetUser.tak_callsign || 'None'}</span>
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        TAK device certificates: {targetUser.live_certificate_count ?? 0}
                      </p>
                    </div>
                    <p className="text-gray-500 dark:text-gray-400 text-right">
                      Unit: <span className="text-gray-900 dark:text-gray-100">{targetUser.team_name || 'Not assigned'}</span>
                    </p>
                    <p className="text-gray-500 dark:text-gray-400">
                      Last login:{' '}
                      <span className="text-gray-900 dark:text-gray-100">
                        {targetUser.last_login ? (
                          <FormattedDate
                            value={targetUser.last_login}
                            fallback=""
                            precision={DATE_PRECISION.DATE}
                            side={TOOLTIP_SIDES.LEFT}
                          />
                        ) : (
                          'Never'
                        )}
                      </span>
                    </p>
                  </div>
                  {/* Status signal: same "only when there's something to say"
                      rule as the desktop table's inline badge -- nothing for an
                      ordinary active account; a text pill for a non-active one.
                      The whole block is omitted when there is nothing to show,
                      so an active user's card is not padded by an empty row. */}
                  {(targetUser.is_active === false || (targetUser.account_status && targetUser.account_status !== 'active')) && (
                    <div>
                      {targetUser.account_status && targetUser.account_status !== 'active' && describeAccountStatusBadge(targetUser.account_status) ? (
                        <span className={describeAccountStatusBadge(targetUser.account_status).className}>
                          {describeAccountStatusBadge(targetUser.account_status).label}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200">
                          Inactive
                        </span>
                      )}
                    </div>
                  )}
                  {targetUser.local_user_id ? (
                    <MemberActions
                      member={{
                        id: targetUser.local_user_id,
                        first_name: targetUser.first_name,
                        last_name: targetUser.last_name,
                        email: targetUser.email,
                        username: targetUser.username,
                        account_status: targetUser.account_status
                      }}
                      roleLabel="user"
                      devicesEnabled={devicesEnabled}
                      onSuspend={targetUser.account_status !== 'orphaned' ? handleSuspendClick : undefined}
                      accountStatus={targetUser.account_status}
                      hasTeam={Boolean(targetUser.team_id) && targetUser.can_manage === true}
                      disabledReason={
                        targetUser.team_id
                          ? "You don't administer this user's team"
                          : 'This user has no team assignment'
                      }
                      onEdit={() => handleStartEditUser(targetUser)}
                      onResendWelcome={() => handleResendWelcomeClick(targetUser)}
                      onTransfer={() => setTransferringUser(targetUser)}
                      onViewDevices={() => setDevicesForUser(targetUser)}
                      onRemove={() => handleRemoveUser(targetUser)}
                      variant="card"
                    />
                  ) : (
                    <span className="text-xs text-gray-400 dark:text-gray-500">No local account</span>
                  )}
                </div>
              )
            ))}
          </div>

          <div className="hidden sm:block overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-700">
                <tr>
                  <th
                    onClick={() => handleSort('name')}
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600"
                  >
                    <div className="flex items-center space-x-1">
                      <span>User</span>
                      {getSortIcon('name')}
                    </div>
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Callsign
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Unit
                  </th>
                  {/* The dedicated Status column was removed to reclaim width
                      for a large directory. The status signal is now an inline
                      text badge next to the user's name (shown ONLY for a
                      non-active state), carried in TEXT per the accessibility
                      rule -- never a colour-only row highlight. */}
                  <th
                    onClick={() => handleSort('last_login')}
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600"
                  >
                    <div className="flex items-center space-x-1">
                      <span>Last Login</span>
                      {getSortIcon('last_login')}
                    </div>
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {sortedUsers.map((targetUser) => (
                  editingUserId === targetUser.pk ? (
                    <MemberEditRow
                      key={targetUser.pk}
                      colSpan={5}
                      form={memberEditForm}
                      setForm={setMemberEditForm}
                      takRoleValues={takRoleValues}
                      saving={savingMemberEdit}
                      error={memberEditError}
                      onSave={() => handleSaveMemberEdit(targetUser)}
                      onCancel={handleCancelEditUser}
                    />
                  ) : (
                  <tr key={targetUser.pk}>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {/* Avatar removed: GET /api/users no longer sources rows
                          from a live Authentik fetch, so it does not return an
                          `avatar` URL, and the old `<img src={undefined}>`
                          rendered as a broken image. The avatar was purely
                          decorative here, so it is dropped rather than
                          re-plumbed. The name/email/cert block is now the
                          cell's sole content, left-aligned with no avatar
                          gutter. */}
                      <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{targetUser.name}</span>
                            {/* Inline status signal, replacing the removed
                                Status column. Shown ONLY for a non-active state
                                (nothing for an ordinary active account), and
                                always carried in TEXT (the pill label reads
                                "Inactive"/"Suspended"/"Account not found in
                                Authentik"), never colour alone. The
                                suspended/orphaned badge comes from the shared
                                describeAccountStatusBadge helper (returns null
                                for active); the plain "Inactive" pill covers an
                                is_active=false account whose account_status is
                                still 'active' (e.g. deactivated but not
                                suspended). */}
                            {targetUser.account_status !== 'active' && targetUser.account_status && describeAccountStatusBadge(targetUser.account_status) ? (
                              <span className={describeAccountStatusBadge(targetUser.account_status).className}>
                                {describeAccountStatusBadge(targetUser.account_status).label}
                              </span>
                            ) : targetUser.is_active === false ? (
                              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200">
                                Inactive
                              </span>
                            ) : null}
                          </div>
                          <div className="text-sm text-gray-500 dark:text-gray-400">{targetUser.email}</div>
                      </div>
                    </td>
                    {/* Callsign (`tak_callsign`, already returned by GET
                        /api/users from user_cache). A teamless user's value is
                        the literal string 'None' (never blank, never a real
                        colour/callsign) per the domain rules, rendered as-is.
                        The "TAK device certificates: N" count sits UNDER the
                        callsign value here (moved out of the User cell): both
                        are TAK-identity facts about the user, so grouping the
                        cert count with the callsign reads better than mixing it
                        with the name/email. Shown unconditionally, plain (not a
                        warning) -- more than one live cert per user is ordinary;
                        `live_certificate_count` is GET /api/users' own field
                        from the same batched query and is never null. */}
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      <div>{targetUser.tak_callsign || 'None'}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        TAK device certificates: {targetUser.live_certificate_count ?? 0}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {targetUser.team_name || 'Not assigned to a unit'}
                    </td>
                    {/* Status column removed -- the status signal is the inline
                        text badge beside the name (above). */}
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      {/* Date_Render_Position 6 (Criteria 2.1, 2.2, 2.3): the
                          Last Login value renders through the ONE shared
                          FormattedDate, so it acquires the Date_Tooltip with
                          the same behaviour as every other date in the app.
                          `side` is LEFT because this is the second-to-last
                          cell of a horizontally scrolling table (Criterion
                          3.5) -- a tooltip pushed past the container's left
                          edge is clipped AND unreachable, so trailing columns
                          open leftward from `right-full`.

                          THE TERNARY STAYS, and `fallback` is the helper's own
                          `''` rather than `'Never'` (design.md Decision 13).
                          Folding the string into the prop reads better and
                          CHANGES what this page renders: a `last_login` that
                          is present but unparseable takes the truthy branch
                          today and renders the EMPTY STRING, because
                          `formatDate`'s default fallback is `''`. Passing
                          `fallback="Never"` would render `Never` for that
                          value instead. That is arguably the better product
                          decision, which is exactly why it does not belong in
                          a change whose Criterion 2.3 promises the same string
                          character for character and whose Criterion 2.4
                          preserves each caller's fallback rather than
                          relocating it. If anyone wants it, it is a one-line
                          change with its own justification. */}
                      {targetUser.last_login ? (
                        <FormattedDate
                          value={targetUser.last_login}
                          fallback=""
                          precision={DATE_PRECISION.DATE}
                          side={TOOLTIP_SIDES.LEFT}
                        />
                      ) : (
                        'Never'
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      {/* Users-page-action-parity: the SAME Edit/Resend
                          welcome/Transfer/View devices/Delete action group
                          `TeamDetail.jsx`'s Member_List rows use, via the
                          shared `MemberActions` component. `hasTeam` is
                          false for a row with no direct team membership
                          (`team_id: null`) OR one the caller does not
                          administer (`can_manage: false`), disabling EVERY
                          action in the group -- see `MemberActions`' own
                          doc comment for why Resend/View Devices are
                          included alongside Edit/Transfer/Delete. Requires
                          `local_user_id` (the LOCAL `users.id` these actions
                          are keyed on); a row with no local row at all
                          (null) has no per-user resource to act on, so the
                          whole action group is omitted, matching the
                          previous "Devices" button's own gating. */}
                      {targetUser.local_user_id ? (
                        <MemberActions
                          member={{
                            id: targetUser.local_user_id,
                            first_name: targetUser.first_name,
                            last_name: targetUser.last_name,
                            email: targetUser.email,
                            username: targetUser.username,
                            account_status: targetUser.account_status
                          }}
                          roleLabel="user"
                          devicesEnabled={devicesEnabled}
                          // account-lifecycle-management: omitted entirely
                          // (no button rendered, matching
                          // `TeamDetail.jsx`'s own gating) for an
                          // 'orphaned' row -- there is no Authentik
                          // identity left to lock/unlock. `hasTeam` below
                          // already covers whether the button is enabled
                          // vs. disabled; this covers whether it exists
                          // at all.
                          onSuspend={targetUser.account_status !== 'orphaned' ? handleSuspendClick : undefined}
                          accountStatus={targetUser.account_status}
                          // Users-page-action-parity: a row is only
                          // actionable when it has a team AND the caller
                          // administers that team (or an ancestor of it) --
                          // `can_manage`, from GET /api/users, mirrors
                          // Team.isAdmin exactly, so /users can never let a
                          // Team_Admin act on a user outside what /teams'
                          // own Member_List would let them touch, even
                          // though the ORGANISATION-WIDE directory-visibility
                          // scoping (a separate question) shows them the row.
                          hasTeam={Boolean(targetUser.team_id) && targetUser.can_manage === true}
                          disabledReason={
                            targetUser.team_id
                              ? "You don't administer this user's team"
                              : 'This user has no team assignment'
                          }
                          onEdit={() => handleStartEditUser(targetUser)}
                          onResendWelcome={() => handleResendWelcomeClick(targetUser)}
                          onTransfer={() => setTransferringUser(targetUser)}
                          onViewDevices={() => setDevicesForUser(targetUser)}
                          onRemove={() => handleRemoveUser(targetUser)}
                        />
                      ) : (
                        <span className="text-xs text-gray-400 dark:text-gray-500">No local account</span>
                      )}
                    </td>
                  </tr>
                  )
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}

        {/* Pagination follow-up: Previous/Page-N-of-M/Next footer,
            mirroring Devices.jsx's/AuditLogs.jsx's own convention exactly. */}
        {!loading && !error && sortedUsers.length > 0 && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Showing {formatNumber((pagination.page - 1) * pagination.pageSize + 1)} to{' '}
              {formatNumber(Math.min(pagination.page * pagination.pageSize, pagination.total))} of {formatNumber(pagination.total)} users
            </div>
            <div className="flex items-center space-x-2">
              <button
                type="button"
                onClick={() => setPagination((prev) => ({ ...prev, page: prev.page - 1 }))}
                disabled={pagination.page === 1}
                className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Page {pagination.page} of {Math.max(1, Math.ceil(pagination.total / (pagination.pageSize || 1)))}
              </span>
              <button
                type="button"
                onClick={() => setPagination((prev) => ({ ...prev, page: prev.page + 1 }))}
                disabled={pagination.page === Math.max(1, Math.ceil(pagination.total / (pagination.pageSize || 1)))}
                className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Requirements 6.4, 6.5: the shared device modal (also attached in
          TeamDetail.jsx's member lists -- ONE component, two surfaces). */}
      {devicesForUser && (
        <UserDevicesModal
          userId={devicesForUser.local_user_id}
          userName={devicesForUser.name || devicesForUser.username || devicesForUser.email}
          onClose={() => setDevicesForUser(null)}
        />
      )}

      {/* Users-page-action-parity: the shared Transfer dialog.
          `team_id`/`team_name` come from the ROW, since this page has no
          single team of its own -- unlike `TeamDetail.jsx`, which passes
          its one page-level `team`. */}
      {transferringUser && (
        <TransferMemberDialog
          member={{
            id: transferringUser.local_user_id,
            first_name: transferringUser.first_name,
            last_name: transferringUser.last_name,
            email: transferringUser.email
          }}
          team={{ id: transferringUser.team_id, name: transferringUser.team_name }}
          user={user}
          onClose={() => setTransferringUser(null)}
          onCompleted={handleTransferCompleted}
        />
      )}

      {/* account-lifecycle-management: the shared Suspend/Unsuspend
          confirmation dialog, mirroring TeamDetail.jsx's own single-
          shared-instance pattern. */}
      {suspendingUser && (
        <SuspendAccountDialog
          mode={suspendingUser.mode}
          // `suspendingUser.user` is the `member` object MemberActions'
          // onSuspend was called with -- the constructed object this
          // page passes it (`{ id: local_user_id, ... }`), NOT the raw
          // `GET /api/users` row -- so this is `.id`, not
          // `.local_user_id`.
          targetUserId={suspendingUser.user.id}
          targetName={`${suspendingUser.user.first_name || ''} ${suspendingUser.user.last_name || ''}`.trim() || suspendingUser.user.username}
          targetUsername={suspendingUser.user.username}
          onClose={() => setSuspendingUser(null)}
          onCompleted={fetchUsers}
        />
      )}

      {/* Users-page-action-parity: the same Permanently Delete User
          confirmation dialog TeamDetail.jsx uses, type-in-email gated. */}
      {removeUserId && (() => {
        const removeTarget = users.find((u) => u.local_user_id === removeUserId)
        const removeTargetEmail = removeTarget?.email || ''
        return (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-user-title"
              className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full"
            >
              <div className="p-6">
                <h3 id="delete-user-title" className="text-lg font-medium text-red-600 dark:text-red-400 mb-4">
                  Permanently Delete User
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mb-4">
                  Are you sure you want to permanently delete <span className="font-medium text-gray-900 dark:text-gray-100">{removeTarget?.first_name} {removeTarget?.last_name}</span>? This action cannot be undone.
                </p>
                <p className="text-gray-600 dark:text-gray-400 mb-4 text-sm">
                  The user will be removed from all teams and channels, their account will be deleted from the system and from the identity provider.
                </p>
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Type <span className="font-mono font-bold text-gray-900 dark:text-gray-100">{removeTargetEmail}</span> to confirm:
                  </label>
                  <input
                    type="text"
                    className="input w-full"
                    value={removeConfirmInput}
                    onChange={(e) => setRemoveConfirmInput(e.target.value)}
                    placeholder={removeTargetEmail}
                    autoComplete="off"
                  />
                </div>
                <div className="flex justify-end space-x-3">
                  <button
                    onClick={() => {
                      setRemoveUserId(null)
                      setRemoveConfirmInput('')
                    }}
                    className="btn-secondary"
                    disabled={removingUser}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmRemoveUser}
                    disabled={removingUser || removeConfirmInput !== removeTargetEmail}
                    className="btn-danger disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {removingUser ? 'Deleting...' : 'Delete User Permanently'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Bugfix (Resend welcome email was the only action with no
          confirmation): mirrors TeamDetail.jsx's own Resend Welcome
          Email dialog -- plain Cancel/Confirm, btn-primary (not
          btn-danger) since this is not destructive. */}
      {resendingWelcomeTo && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="resend-welcome-title"
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full"
          >
            <div className="p-6">
              <h3 id="resend-welcome-title" className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                Resend Welcome Email
              </h3>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Send a new welcome email to {resendingWelcomeTo.email}?
              </p>
              <div className="flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setResendingWelcomeTo(null)}
                  className="btn-secondary"
                  disabled={resendingWelcomeInFlight}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmResendWelcome}
                  disabled={resendingWelcomeInFlight}
                  className="btn-primary disabled:opacity-50"
                >
                  {resendingWelcomeInFlight ? 'Sending...' : 'Resend Email'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Users-page-action-parity: the Create User dialog. Unlike
          TeamDetail.jsx's Add Member Dialog (which always creates into
          its one fixed team), this page has no team in scope, so the
          dialog collects one itself before submitting. */}
      {showCreateDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-user-title"
            className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-lg sm:h-auto sm:max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 id="create-user-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Create User
              </h3>
              <button
                onClick={closeCreateDialog}
                className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
                aria-label="Close create user dialog"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>

            <form onSubmit={handleCreateUser} className="p-6 space-y-4">
              <div>
                <label htmlFor="create-user-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Email Address *
                </label>
                <input
                  id="create-user-email"
                  type="email"
                  required
                  value={createForm.email}
                  onChange={(e) => {
                    setCreateForm({ ...createForm, email: e.target.value })
                    setCreateEmailError(null)
                  }}
                  onBlur={() => { if (createForm.email && !isValidNewUserEmail(createForm.email)) setCreateEmailError('Please enter a valid email address.') }}
                  aria-invalid={createEmailError ? 'true' : undefined}
                  className="input w-full"
                  placeholder="user@organisation.nz"
                />
                {createEmailError && (
                  <p role="alert" className="text-red-600 text-sm mt-1">{createEmailError}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="create-user-first-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    First Name *
                  </label>
                  <input
                    id="create-user-first-name"
                    type="text"
                    required
                    value={createForm.firstName}
                    onChange={(e) => setCreateForm({ ...createForm, firstName: e.target.value })}
                    className="input w-full"
                    placeholder="Joe"
                  />
                </div>
                <div>
                  <label htmlFor="create-user-last-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Last Name *
                  </label>
                  <input
                    id="create-user-last-name"
                    type="text"
                    required
                    value={createForm.lastName}
                    onChange={(e) => setCreateForm({ ...createForm, lastName: e.target.value })}
                    className="input w-full"
                    placeholder="Bloggs"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="create-user-team" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Team *
                </label>
                <select
                  id="create-user-team"
                  required
                  value={createForm.teamId}
                  onChange={(e) => setCreateForm({ ...createForm, teamId: e.target.value })}
                  disabled={loadingCreateTeams}
                  className="input w-full"
                >
                  <option value="">{loadingCreateTeams ? 'Loading teams...' : 'Select a team'}</option>
                  {createTeams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.display_name || team.name}
                    </option>
                  ))}
                </select>
                {!loadingCreateTeams && createTeams.length === 0 && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    No team is available to add a user to.
                  </p>
                )}
              </div>

              <div className="bg-blue-50 dark:bg-blue-900 p-4 rounded-lg">
                <p className="text-sm text-blue-800 dark:text-blue-200">
                  <strong>Note:</strong> The user will be created in the Account Management System and automatically added to the selected team.
                  They will need to set their password on first login.
                </p>
              </div>

              {createError && (
                <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                  {createError}
                </p>
              )}

              <div className="flex justify-end space-x-3 pt-2 border-t border-gray-200 dark:border-gray-700">
                <button
                  type="button"
                  onClick={closeCreateDialog}
                  disabled={creatingUser}
                  className="btn-secondary px-6 py-2"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!createForm.email || !createForm.firstName || !createForm.lastName || !createForm.teamId || creatingUser}
                  className="btn-primary px-6 py-2"
                >
                  {creatingUser ? 'Creating...' : 'Create & Add User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
