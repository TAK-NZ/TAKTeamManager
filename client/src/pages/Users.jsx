import { useState, useEffect } from 'react'
import { PlusIcon, MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { usersAPI, teamsAPI, configAPI } from '../services/api'
import FormattedDate, { DATE_PRECISION, TOOLTIP_SIDES } from '../components/FormattedDate'
import UserDevicesModal, { useDeviceManagementEnabled } from '../components/UserDevicesModal'
import MemberActions from '../components/MemberActions'
import MemberEditRow, {
  getInitialMemberEditForm,
  isValidMemberCallsignSuffix,
  DEFAULT_TAK_ROLE_VALUES
} from '../components/MemberEditRow'
import TransferMemberDialog from '../components/TransferMemberDialog'
import { isValidNewUserEmail, extractCallsignSuffixServerError } from '../utils/newUserForm'

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

  // The Permanently-Delete-User confirmation dialog's state, mirroring
  // `TeamDetail.jsx`'s `removeUserId`/`removeConfirmInput`/`removingUser`.
  const [removeUserId, setRemoveUserId] = useState(null)
  const [removeConfirmInput, setRemoveConfirmInput] = useState('')
  const [removingUser, setRemovingUser] = useState(false)

  // "Create User" dialog state.
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [createTeams, setCreateTeams] = useState([])
  const [loadingCreateTeams, setLoadingCreateTeams] = useState(false)
  const [createForm, setCreateForm] = useState({ email: '', firstName: '', lastName: '', teamId: '' })
  const [createEmailError, setCreateEmailError] = useState(null)
  const [createError, setCreateError] = useState(null)
  const [creatingUser, setCreatingUser] = useState(false)

  const fetchUsers = async () => {
    try {
      const response = await usersAPI.getAll()
      setUsers(response.data.users || response.data || [])
    } catch (error) {
      console.error('Failed to fetch users:', error)
      setError(`Failed to load users: ${error.message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchUsers()
  }, [])

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

  const filteredUsers = users.filter(user =>
    user.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.username?.toLowerCase().includes(searchQuery.toLowerCase())
  )

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

  // Mirrors TeamDetail.jsx's `handleResendWelcome`. `teamId` is cosmetic
  // server-side (used only to build the email's display text; the actual
  // authorization walks the user's real current teams), so this page's
  // per-row `team_id` (possibly null) is passed through as-is.
  const handleResendWelcome = async (targetUser) => {
    try {
      await usersAPI.resendWelcome(targetUser.local_user_id, targetUser.team_id)
      toast.success(`Welcome email resent to ${targetUser.email}`)
    } catch (err) {
      toast.error('Failed to resend welcome email')
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
      await usersAPI.removeFromTeam(removeUserId, removeTarget?.team_id ?? null)
      setUsers((prev) => prev.filter((u) => u.local_user_id !== removeUserId))
      window.dispatchEvent(new CustomEvent('userAssignmentChanged'))
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
      await usersAPI.createAndAdd(
        createForm.email,
        createForm.firstName,
        createForm.lastName,
        createForm.teamId
      )
      toast.success('User created and added to the selected team')
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
        <button className="btn-primary flex items-center" onClick={openCreateDialog}>
          <PlusIcon className="h-5 w-5 mr-2" />
          Create User
        </button>
      </div>

      {/* Search */}
      <div className="card">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search users by name, email, or username..."
            className="input pl-10"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
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
        ) : filteredUsers.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500 dark:text-gray-400">No users found.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-700">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    User
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Unit
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Last Login
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {filteredUsers.map((targetUser) => (
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
                      <div className="flex items-center">
                        <div className="flex-shrink-0 h-10 w-10">
                          <img className="h-10 w-10 rounded-full" src={targetUser.avatar} alt="" />
                        </div>
                        <div className="ml-4">
                          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{targetUser.name}</div>
                          <div className="text-sm text-gray-500 dark:text-gray-400">{targetUser.email}</div>
                          {/* Bugfix: replaces the old MultipleCertificateWarning
                              note ("This account has N active TAK Server
                              certificates."), which only appeared for N > 1 and
                              read as a warning (amber) for what is actually an
                              ordinary state -- more than one live certificate
                              per user (ATAK, CloudTAK, a second device, etc.)
                              is normal, not a defect. Shown UNCONDITIONALLY for
                              every user now, as a plain informational count,
                              matching the same "always show, never gate on a
                              threshold" convention EnrollmentView.jsx's own
                              "Active TAK Server Certificates" field already
                              uses. `live_certificate_count` is GET /api/users'
                              own field, from the SAME batched query this
                              page's fetch already runs (no second request),
                              and the route's own doc comment guarantees it is
                              never null/undefined -- always a real integer,
                              0 or more -- so no fallback is needed here. */}
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            TAK device certificates: {targetUser.live_certificate_count ?? 0}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {targetUser.team_name || 'Not assigned to a unit'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                        targetUser.is_active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                      }`}>
                        {targetUser.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
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
                            email: targetUser.email
                          }}
                          roleLabel="user"
                          devicesEnabled={devicesEnabled}
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
                          onResendWelcome={() => handleResendWelcome(targetUser)}
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
