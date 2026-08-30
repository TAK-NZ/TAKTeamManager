import { useState, useEffect } from 'react'
import React from 'react'
import { useParams, Link } from 'react-router-dom'
import { PlusIcon, UsersIcon, UserPlusIcon, ShieldCheckIcon, BuildingOfficeIcon, FolderPlusIcon, SignalIcon, XMarkIcon, MagnifyingGlassIcon, ChevronUpIcon, ChevronDownIcon, TrashIcon, PencilIcon, CheckIcon, ArrowLeftOnRectangleIcon, ArrowPathIcon, DevicePhoneMobileIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { teamsAPI, channelsAPI, usersAPI, configAPI, devicesAPI } from '../services/api'
import api from '../services/api'
import { labelFor } from '../utils/teamLabels'
import { computeTeamDepth } from '../utils/teamDepth'
import { getTakColorHex } from '../utils/takColors'
import TeamFormDialog from '../components/TeamFormDialog'
import SignupCodeManager from '../components/SignupCodeManager'
import TransferMemberDialog from '../components/TransferMemberDialog'
import UserDevicesModal, { useDeviceManagementEnabled } from '../components/UserDevicesModal'
import TeamDeviceList, { deviceDisplayName } from '../components/TeamDeviceList'
import AddTeamDeviceDialog from '../components/AddTeamDeviceDialog'
import MoreOptionsMenu from '../components/MoreOptionsMenu'
import { tabAria } from '../components/Tabs'
import MemberEditRow, {
  getInitialMemberEditForm,
  isValidMemberCallsignSuffix,
  DEFAULT_TAK_ROLE_VALUES,
  CALLSIGN_SUFFIX_PATTERN
} from '../components/MemberEditRow'
import MemberActions from '../components/MemberActions'
import EnrollmentView from './EnrollmentView'
import {
  newUserFormReducer,
  initialNewUserFormState,
  isRecomputeDisabled,
  selectSuffixBusy,
  buildCreateAndAddSuffixArgument
} from '../utils/callsignSuffixPreview'
import { describeEmptyAvailableUsers } from '../utils/directoryScopeMessage'
import { isValidNewUserEmail, extractCallsignSuffixServerError } from '../utils/newUserForm'

// Requirement 5's two new `callsign_name_format` values need example
// strings alongside the three existing ones, matching the "J Doe"/"John D"
// pattern already used for `first_initial_last`/`first_last_initial`.
// `first_initial_dot_last` -> "J.Doe" (Requirement 8.6), `user_defined` ->
// "Custom" (Requirement 11.5, since that format computes no default at
// all -- there is no single example name to show).
const CALLSIGN_NAME_FORMAT_EXAMPLES = {
  full_name: 'John Doe',
  first_initial_last: 'J Doe',
  first_last_initial: 'John D',
  first_initial_dot_last: 'J.Doe',
  user_defined: 'Custom'
}

export function formatCallsignNameFormatExample(callsignNameFormat) {
  return CALLSIGN_NAME_FORMAT_EXAMPLES[callsignNameFormat] || CALLSIGN_NAME_FORMAT_EXAMPLES.full_name
}

// Requirement 5.7-5.11 (task 33.1): a compact "Levels: 1, 2, 4" summary
// read from the Organisation's `callsign_level_selection`, replacing the
// old single-depth "Depth N" badge (which assumed only a contiguous
// prefix of levels could ever be selected).
// The team header's summary row (Visibility, Callsign Structure, Join
// Requests, Join Limited). `TEAM_SUMMARY_BADGE_CLASS` is the neutral
// (gray) style, used for a value with no positive/negative state of its
// own (Callsign Structure) and for the "off"/"none" half of a state pair
// that isn't itself a warning (Join Requests Disabled, Join Limited
// None). `TEAM_SUMMARY_BADGE_POSITIVE_CLASS`/`_NEGATIVE_CLASS` carry an
// actual state in colour ALONGSIDE text (never colour alone -- each
// badge's own text already says "Public"/"Private",
// "Allowed"/"Disabled", "By Email Domain"/"None"): green for the
// affirmative/open state (Public, Allowed, By Email Domain), red only
// for Visibility's Private state specifically (a team hidden from the
// public directory is the one state here worth flagging, unlike a
// disabled join request or an unrestricted join, which are both
// unremarkable defaults).
const TEAM_SUMMARY_BADGE_CLASS = 'px-2 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
const TEAM_SUMMARY_BADGE_POSITIVE_CLASS = 'px-2 py-1 text-xs font-medium rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
const TEAM_SUMMARY_BADGE_NEGATIVE_CLASS = 'px-2 py-1 text-xs font-medium rounded-full bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'

export function formatCallsignLevels(callsignLevelSelection) {
  if (!Array.isArray(callsignLevelSelection) || callsignLevelSelection.length === 0) {
    return 'All'
  }
  return callsignLevelSelection.slice().sort((a, b) => a - b).join(', ')
}

// Requirement 2.4/2.5: `computeTeamDepth` now lives in
// `../utils/teamDepth.js` (shared with Teams.jsx's Parent-Team dropdown,
// task 32.2), re-exported here so this file's own JSX and existing tests
// keep working unchanged.
export { computeTeamDepth }

// Users-page-action-parity: the Member_List edit row's own pattern/regex,
// pre-fill helper, validator and TAK_Role fallback list now live in
// `components/MemberEditRow.jsx` (shared with `Users.jsx`) and are
// imported above; re-exported here under their ORIGINAL names so this
// file's own `TeamDetail.test.jsx` (and any other existing importer of
// `./TeamDetail.jsx`) keeps working unchanged.
export { getInitialMemberEditForm, isValidMemberCallsignSuffix }

// Requirement 3.10 (task 33.3): mirrors server/utils/callsignValidation.js's
// `isValidCallsignPrefix` character class (letters and digits only, no `-`
// -- stricter than `callsign_suffix` above, per Requirement 3.8) as an
// HTML `pattern`, applied to the Create Sub-Team Dialog's own "Prefix"
// input (`subTeamFormData.callsignPrefix`), the same treatment task 32.6
// applies to the equivalent input in Teams.jsx.
const CALLSIGN_PREFIX_PATTERN = '[A-Za-z0-9]*'
const CALLSIGN_PREFIX_REGEX = /^[A-Za-z0-9]*$/

// Pure validation helper for the Create Sub-Team Dialog's `callsignPrefix`
// input, mirroring `isValidMemberCallsignSuffix` below's convention -- an
// empty value is valid (the field is optional).
export function isValidSubTeamCallsignPrefix(value) {
  if (!value) {
    return true
  }
  return CALLSIGN_PREFIX_REGEX.test(value)
}

// takserver-enrollment Requirement 6.7/9.7 (task 5.5): resolves whether
// the CURRENT team's own Ancestor_Chain root (its Organisation) has the
// Pseudonymous_Username_Policy enabled, for the Create New User form.
//
// Mirrors the server's own rule -- `Team.getAncestorChain(teamId)[0]`,
// the chain is root-first, NEVER a positional read from the tail -- but
// resolves it client-side from the already-fetched `allTeams` list
// (the same list `computeTeamDepth` already walks for the "Add
// Sub-team" disable state) rather than adding a new network call: this
// page already fetches every Team in the caller's own Organisation via
// `teamsAPI.getMyTeams()` (`Team.getOrganisationTeams` server-side for a
// non-Global_Manager team admin), and every returned row carries
// `pseudonymous_usernames` (Requirement 6.2's `SELECT t.*`/`SELECT
// oh.*`), so no new fetch is needed to answer this question.
//
// An Organisation's own row carries its authoritative value directly.
// A Sub_Team's own `pseudonymous_usernames` is always NULL (Requirement
// 6.2) -- reading it directly would be the exact positional-tail-read
// mistake the server-side rule forbids -- so this walks `parent_team_id`
// up through `allTeams` to the root and reads ITS value instead.
// Terminates defensively if an ancestor is missing from `allTeams` (e.g.
// a private ancestor not returned to this admin, or a Global_Manager's
// paginated all-teams list not reaching back far enough), returning
// `false` rather than looping forever or guessing -- the same
// termination rule `computeTeamDepth` already uses for the identical
// "walk parent_team_id through an already-fetched list" shape.
export function isPseudonymousOrganisation(team, allTeams) {
  if (!team) {
    return false
  }
  if (!team.parent_team_id) {
    return Boolean(team.pseudonymous_usernames)
  }
  const teamsById = new Map((allTeams || []).map((t) => [t.id, t]))
  const seen = new Set([team.id])
  let current = teamsById.get(team.parent_team_id)
  while (current) {
    if (!current.parent_team_id) {
      return Boolean(current.pseudonymous_usernames)
    }
    if (seen.has(current.id)) {
      break
    }
    seen.add(current.id)
    current = teamsById.get(current.parent_team_id)
  }
  return false
}

// Users-page-action-parity: `isValidNewUserEmail` and
// `extractCallsignSuffixServerError` now live in `utils/newUserForm.js`
// (shared with `Users.jsx`'s Create User dialog) and are imported above;
// re-exported here under their ORIGINAL names so this file's own
// `TeamDetail.test.jsx` keeps working unchanged.
export { isValidNewUserEmail, extractCallsignSuffixServerError }

// Users-page-action-parity: `MemberEditRow` and `MemberActions` (the
// Edit/Resend welcome/Transfer/View devices/Delete action-icon group,
// shared between the Members and Team Admins tabs) now live in
// `components/MemberEditRow.jsx`/`components/MemberActions.jsx`
// (imported above), shared with `Users.jsx`.

export default function TeamDetail({ user, refreshUser }) {
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
  const [allTeams, setAllTeams] = useState([])
  // Bugfix: Edit Team is now the same shared `TeamFormDialog` component
  // Teams.jsx uses (previously this page had its own stale, drifted copy
  // of this dialog -- missing Callsign_Level_Selection toggles, two of
  // the five callsign_name_format options, and still exposing the
  // removed "Callsign Sub-team Depth" field). This page only tracks
  // whether the dialog is open; the team being edited is always `team`
  // itself, since TeamDetail.jsx only ever edits its own team.
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [colorMappings, setColorMappings] = useState({})
  const [folderSeparator, setFolderSeparator] = useState(' - ')
  // Requirement 2.4/2.5 (task 33.1): the system-wide Max_Team_Depth
  // constant, sourced from GET /api/config/public so it's never
  // hardcoded a second time on the Client.
  const [maxTeamDepth, setMaxTeamDepth] = useState(null)
  const [showChannelDialog, setShowChannelDialog] = useState(false)
  const [channelFormData, setChannelFormData] = useState({
    customSuffix: '',
    memberPermissions: []
  })
  const [creatingChannel, setCreatingChannel] = useState(false)
  // Header toolbar's "Add Team Device" action -- opens
  // `AddTeamDeviceDialog`, which creates a brand-new Team_Owned_Device
  // (distinct from the Team Devices tab's "Enroll" action on an
  // ALREADY-EXISTING one).
  const [showAddDeviceDialog, setShowAddDeviceDialog] = useState(false)
  // Bumped after a successful AddTeamDeviceDialog creation and used as
  // `TeamDeviceList`'s `key`, forcing a remount (and therefore a fresh
  // `GET /api/devices/team/:teamId` fetch) so the newly created device
  // appears in the Team Devices tab without a full page reload.
  // `TeamDeviceList` itself exposes no imperative refresh method.
  const [deviceListVersion, setDeviceListVersion] = useState(0)
  // Bugfix: the Team Devices tab is the only tab with no count badge --
  // `TeamDeviceList` owns its own fetch entirely (this page never sees
  // the device list itself), so its count has to be reported UP via a
  // callback rather than read off a local array the way
  // members.length/admins.length/etc. are. `null` until the first
  // fetch resolves, matching every OTHER tab's own null-until-loaded
  // state (`members`/`admins`/`channels`/`subTeams` all start as `[]`,
  // giving a `0` badge before their own fetch resolves too -- the one
  // difference here is `TeamDeviceList` doesn't even mount until this
  // tab is selected, so `null` avoids a misleading "0 devices" flash
  // before the tab has ever been opened).
  const [deviceCount, setDeviceCount] = useState(null)
  const [showAddMemberDialog, setShowAddMemberDialog] = useState(false)
  const [addMemberTab, setAddMemberTab] = useState('new')
  // Bugfix: the "Add Admin" button reuses this same Add Member Dialog
  // rather than a separate dialog -- this tracks which role the dialog's
  // "existing user"/"create new user" flows should add the selected/new
  // user with. Set to 'admin' by the "Add Admin" button and 'member' by
  // the "Add Member" button, both just before opening the dialog.
  const [addMemberRole, setAddMemberRole] = useState('member')
  const [availableUsers, setAvailableUsers] = useState([])
  // Requirements 9.5-9.8: the Directory_Scope the server attached to the
  // /available response (null for a Global_Manager, and null on the "Add Admin"
  // path which populates availableUsers from current members). Drives which
  // explanation the empty available-users list carries.
  const [availableUsersScope, setAvailableUsersScope] = useState(null)
  const [userSearch, setUserSearch] = useState('')
  const [selectedUserId, setSelectedUserId] = useState('')
  // Add Member Dialog / "Create New User" tab: the entire form (email, names,
  // suffix) plus its advisory Callsign_Suffix preview state, collapsed into one
  // `useReducer` so there is a single answer to "what is in the Suffix_Field and
  // may I overwrite it". The old two-valued `newUserCallsignEdited` flag becomes
  // the reducer's three-state `origin` (NONE/AUTO/TYPED), which is the whole fix
  // for Defect 1: an Auto_Filled value is never echoed back as `callsignSuffix`,
  // so the server recomputes rather than preferring the stale value the Client
  // itself wrote (member-visibility-and-callsign-recompute, tasks 3.1-3.4).
  const [newUserFormState, dispatchNewUserForm] = React.useReducer(
    newUserFormReducer,
    undefined,
    initialNewUserFormState
  )
  // `addingMember` stays its own `useState`: it is shared with the
  // "Add Existing User" tab's submit path (`handleAddExistingUser`).
  const [addingMember, setAddingMember] = useState(false)
  // Inline validation alert for the Create New User form's Email Address
  // input, kept separate from the reducer's `error` field (which is
  // dedicated to the Callsign Suffix). Cleared on edit and on
  // reset/close so a stale alert never persists across opens.
  const [newUserEmailError, setNewUserEmailError] = useState(null)
  const [removeUserId, setRemoveUserId] = useState(null)
  const [removeUserRole, setRemoveUserRole] = useState('')
  const [removeConfirmInput, setRemoveConfirmInput] = useState('')
  const [removingUser, setRemovingUser] = useState(false)
  // Requirements 11.13, 13.1, 13.2, 13.3, 13.5 (task 33.2): per-row inline
  // Member_List edit state. `editingMemberId` tracks which member/admin row
  // (by user id) currently has its inline edit form open -- at most one row
  // across BOTH the Members and Team Admins tabs, since a user can only be
  // editing one row at a time. `memberEditForm` holds that row's current
  // form values; `savingMemberEdit`/`memberEditError` track the in-flight
  // PATCH request and any surfaced failure (Requirement 14.2).
  const [editingMemberId, setEditingMemberId] = useState(null)
  const [memberEditForm, setMemberEditForm] = useState({ firstName: '', lastName: '', takRole: 'Team Member', callsignSuffix: '' })
  const [savingMemberEdit, setSavingMemberEdit] = useState(false)
  const [memberEditError, setMemberEditError] = useState(null)
  // Requirement 13.5: the 8 predefined TAK_Role values, sourced from
  // GET /api/config/public's `takRoleValues` field so this Client never
  // hardcodes a second copy of settings.js's ROLE_KEY_LABELS allow-list.
  const [takRoleValues, setTakRoleValues] = useState(DEFAULT_TAK_ROLE_VALUES)
  // Requirement 15.1 (task 13.3): the Member_List row whose transfer action
  // was activated, i.e. the member `TransferMemberDialog` is open for. Null
  // when the dialog is closed. Shared between the Members and Team Admins
  // tabs, since at most one transfer dialog is ever open.
  const [transferringMember, setTransferringMember] = useState(null)
  // Requirement 6.3 (device-management task 15.4): the Member_List row whose
  // devices action was activated, i.e. the member `UserDevicesModal` is open
  // for. Null when the modal is closed. Shared between the Members and Team
  // Admins tabs, since at most one device modal is ever open. This is the
  // SAME component `Users.jsx` attaches (Requirement 6.4), so the device list
  // is defined once and reused by both surfaces.
  const [devicesForMember, setDevicesForMember] = useState(null)
  // The device surfaces exist only WHILE the server-side DEVICE_MGMT_ENABLED
  // flag is on, and that flag is never exposed through /api/config/public
  // (Requirement 1.4), so the affordance is gated on the reachability probe.
  const devicesEnabled = useDeviceManagementEnabled()
  // takserver-enrollment Criteria 14.6, 14.7 (task 11.3): the Team_Owned_Device
  // whose Enrollment_View modal is open, or null when closed. `TeamDeviceList`
  // (task 11.2) only lists devices and calls `onEnroll(device)` -- it renders
  // no Enrollment_View itself -- so this page is the caller that decides how
  // to open one: a modal wrapping `<EnrollmentView fetchEnrollment={...}>`
  // with a `fetchEnrollment` bound to THIS device's own
  // `POST /api/devices/:deviceUserId/qr-code`, rather than the self-service
  // `POST /api/enrollment/me` route `EnrollmentView`'s default fetches.
  const [enrollingDevice, setEnrollingDevice] = useState(null)

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
      toast.error('Failed to create sub-team: ' + (error.response?.data?.error || error.message))
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
      toast.error('Failed to delete sub-team: ' + (error.response?.data?.error || error.message))
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
      toast.error('Failed to create channel: ' + (error.response?.data?.error || error.message))
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
      setAvailableUsersScope(response.data.scope ?? null)
    } catch (error) {
      console.error('Failed to fetch available users:', error)
    }
  }

  const handleAddExistingUser = async () => {
    if (!selectedUserId) return
    
    setAddingMember(true)
    try {
      // Bugfix (Add Admin button): usersAPI.addToTeam (POST
      // /users/add-to-team) always adds the user with role 'member' --
      // it has no role parameter at all (server/routes/users.js). When
      // adding as an admin, use teamsAPI.addMember (POST
      // /teams/:teamId/members) instead, which does accept role:
      // 'admin'|'member' (server/routes/teams.js). The plain-member path
      // keeps using usersAPI.addToTeam unchanged, to avoid altering its
      // existing behavior (e.g. the "already a member of another team"
      // check and channel/group assignment it performs).
      if (addMemberRole === 'admin') {
        await teamsAPI.addMember(team.id, { userId: selectedUserId, role: 'admin' })
      } else {
        await usersAPI.addToTeam(selectedUserId, team.id)
      }
      
      // Refresh team data
      const teamResponse = await teamsAPI.getById(team.id)
      const allMembers = teamResponse.data.members || []
      setMembers(allMembers.filter(m => m.role === 'member' || m.role === 'inherited' || m.role === 'admin'))
      setAdmins(allMembers.filter(m => m.role === 'admin'))
      
      // Notify Dashboard to refresh
      window.dispatchEvent(new CustomEvent('userAssignmentChanged'))
      
      setShowAddMemberDialog(false)
      setSelectedUserId('')
      setUserSearch('')
      setAddMemberRole('member')
    } catch (error) {
      console.error('Failed to add user:', error)
      toast.error('Failed to add user: ' + (error.response?.data?.error || error.message))
    } finally {
      setAddingMember(false)
    }
  }

  // The single request-issuing effect (task 3.2). Keyed on the reducer's
  // `pendingRequest` identity: the reducer sets a fresh object whenever a
  // Suffix_Preview should fly, so this re-runs, issues the request, and
  // dispatches `previewSettled` on resolve / `previewFailed` on reject. No
  // cleanup, no `cancelled` flag, no AbortController -- every settled request
  // must dispatch so `inFlight` decrements, and the reducer decides whether to
  // apply the response (Requirement 7.1, 7.3, 7.5).
  React.useEffect(() => {
    const pending = newUserFormState.pendingRequest
    if (!pending) return
    usersAPI.previewCallsignSuffix(pending.body)
      .then((response) => dispatchNewUserForm({ type: 'previewSettled', seq: pending.seq, response: response?.data }))
      .catch((error) => {
        // Requirement 7.3: recorded through the console, never surfaced.
        console.error('Failed to preview callsign suffix:', error)
        dispatchNewUserForm({ type: 'previewFailed', seq: pending.seq })
      })
  }, [newUserFormState.pendingRequest])

  const handleCreateNewUser = async (e) => {
    e.preventDefault()

    // Inline email-format validation, surfaced against the Email Address
    // field rather than relying on native validation alone.
    if (!isValidNewUserEmail(newUserFormState.email)) {
      setNewUserEmailError('Please enter a valid email address.')
      return
    }
    setNewUserEmailError(null)

    // Same point-of-entry character-class check the Member_List edit row
    // applies, surfaced inline against the field rather than as a toast.
    if (!isValidMemberCallsignSuffix(newUserFormState.suffix)) {
      dispatchNewUserForm({ type: 'submitRejected', message: 'Callsign suffix may only contain letters, digits, "-", and "."' })
      return
    }

    setAddingMember(true)
    try {
      // Creates the user as a member (with upward membership propagation).
      // When addMemberRole === 'admin', also grants admin role on this team.
      // The suffix argument comes from the shared body builder so a preview and
      // a submit for one form cannot disagree; `undefined` is dropped by
      // JSON.stringify, so an Auto_Filled or empty value is never echoed
      // (Requirement 5.3, 7.7).
      const response = await usersAPI.createAndAdd(
        newUserFormState.email,
        newUserFormState.firstName,
        newUserFormState.lastName,
        team.id,
        addMemberRole === 'admin' ? 'admin' : undefined,
        buildCreateAndAddSuffixArgument(newUserFormState)
      )
      
      // Refresh team data
      const teamResponse = await teamsAPI.getById(team.id)
      const allMembers = teamResponse.data.members || []
      setMembers(allMembers.filter(m => m.role === 'member' || m.role === 'inherited' || m.role === 'admin'))
      setAdmins(allMembers.filter(m => m.role === 'admin'))
      
      // Notify Dashboard to refresh
      window.dispatchEvent(new CustomEvent('userAssignmentChanged'))

      // Report the Callsign_Suffix the server actually assigned (the admin's
      // own value, or the Organisation's computed default they never typed).
      const assignedSuffix = response?.data?.user?.callsign_suffix
      toast.success(
        assignedSuffix
          ? `User created with callsign suffix ${assignedSuffix}`
          : 'User created and added to this team'
      )

      setShowAddMemberDialog(false)
      dispatchNewUserForm({ type: 'reset' })
      setNewUserEmailError(null)
      setAddMemberRole('member')
    } catch (error) {
      console.error('Failed to create user:', error)
      // A 400 carrying the server's own message is either the
      // `user_defined`-format "suffix required" rejection or a per-team
      // collision -- both belong against the Callsign Suffix field, with the
      // dialog left open to correct, rather than in a generic toast.
      const inlineError = extractCallsignSuffixServerError(error)
      if (inlineError) {
        dispatchNewUserForm({ type: 'submitRejected', message: inlineError })
      } else {
        toast.error('Failed to create user: ' + (error.response?.data?.error || error.message))
      }
    } finally {
      setAddingMember(false)
    }
  }

  // Fetch available users when dialog opens
  React.useEffect(() => {
    if (showAddMemberDialog && addMemberTab === 'existing') {
      if (addMemberRole === 'admin') {
        // For promoting to admin: show existing team members (not already admin)
        // that match the search term, rather than only unassigned users.
        const candidates = members.filter(m => {
          const isAlreadyAdmin = admins.some(a => a.id === m.id)
          if (isAlreadyAdmin) return false
          if (!userSearch) return true
          const searchLower = userSearch.toLowerCase()
          return (
            (m.first_name && m.first_name.toLowerCase().includes(searchLower)) ||
            (m.last_name && m.last_name.toLowerCase().includes(searchLower)) ||
            (m.email && m.email.toLowerCase().includes(searchLower))
          )
        }).map(m => ({
          id: m.id,
          email: m.email,
          first_name: m.first_name,
          last_name: m.last_name
        }))
        setAvailableUsers(candidates)
        // The "Add Admin" path draws from current members, not the scoped
        // /available route, so it has no Directory_Scope: leave it null so the
        // empty-list explanation falls to the unscoped statement (Req 9.8).
        setAvailableUsersScope(null)
      } else {
        fetchAvailableUsers(userSearch)
      }
    }
  }, [showAddMemberDialog, addMemberTab, userSearch, addMemberRole, members, admins])

  const handleRemoveUser = (userId, role) => {
    setRemoveUserId(userId)
    setRemoveUserRole(role)
    setRemoveConfirmInput('')
  }

  // Requirements 11.13, 13.1, 13.2, 13.5 (task 33.2): opens the inline
  // edit form for a single Member_List row, seeded from that row's
  // current values via `getInitialMemberEditForm`.

  // Resend the welcome/approval email to a team member
  const handleResendWelcome = async (member) => {
    try {
      await usersAPI.resendWelcome(member.id, team.id)
      toast.success(`Welcome email resent to ${member.email}`)
    } catch (err) {
      toast.error('Failed to resend welcome email')
    }
  }

  const handleStartEditMember = (member) => {
    setEditingMemberId(member.id)
    setMemberEditForm(getInitialMemberEditForm(member))
    setMemberEditError(null)
  }

  const handleCancelEditMember = () => {
    setEditingMemberId(null)
    setMemberEditError(null)
  }

  // Requirement 14.3: updates BOTH `members` and `admins` local state from
  // teamsAPI.updateMember's own response (`response.data.member`), rather
  // than optimistically applying the submitted form values -- so a value
  // rejected/altered server-side is never shown as if it had been saved.
  const applyUpdatedMemberToLocalState = (userId, updatedMember) => {
    const mergeRow = (row) => (row.id === userId ? { ...row, ...updatedMember } : row)
    setMembers((prev) => prev.map(mergeRow))
    setAdmins((prev) => prev.map(mergeRow))
  }

  // Requirements 11.13, 11.16, 13.2, 13.3, 13.4, 13.6, 14.2, 14.3 (task
  // 33.2): submits the inline edit form's current values to
  // `PATCH /api/teams/:teamId/members/:userId`. Email is never included
  // (Requirement 13.3 -- there is no input control for it in this form at
  // all). On success, reflects the actual server response in local state
  // (never optimistic-only) and closes the form; on failure (e.g. a 400
  // `callsign_suffix` conflict per Requirement 11.16, or any other 4xx/5xx),
  // surfaces the server's error message inline and keeps the form open so
  // the admin can correct and retry (Requirement 14.2).
  const handleSaveMemberEdit = async (userId) => {
    if (!isValidMemberCallsignSuffix(memberEditForm.callsignSuffix)) {
      setMemberEditError('Callsign suffix may only contain letters, digits, "-", and "."')
      return
    }

    setSavingMemberEdit(true)
    setMemberEditError(null)
    try {
      const response = await teamsAPI.updateMember(team.id, userId, {
        firstName: memberEditForm.firstName,
        lastName: memberEditForm.lastName,
        takRole: memberEditForm.takRole,
        callsignSuffix: memberEditForm.callsignSuffix
      })
      applyUpdatedMemberToLocalState(userId, response.data.member)
      setEditingMemberId(null)
    } catch (error) {
      console.error('Failed to update team member:', error)
      setMemberEditError(
        error.response?.data?.error || error.response?.data?.errors?.[0]?.msg || 'Failed to update member'
      )
    } finally {
      setSavingMemberEdit(false)
    }
  }

  const confirmRemoveUser = async () => {
    if (!removeUserId) return
    
    setRemovingUser(true)
    try {
      await usersAPI.removeFromTeam(removeUserId, team.id)
      
      // Refresh team data
      const teamResponse = await teamsAPI.getById(team.id)
      const allMembers = teamResponse.data.members || []
      setMembers(allMembers.filter(m => m.role === 'member' || m.role === 'inherited' || m.role === 'admin'))
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
      toast.error('Failed to remove user: ' + (error.response?.data?.error || error.message))
    } finally {
      setRemovingUser(false)
    }
  }

  // Requirement 15.5 (task 13.3): a completed transfer moved the member out
  // of this team and revoked the Channel memberships they held here, so the
  // Member_List and the channel member counts are both refetched -- the same
  // refresh `confirmRemoveUser` performs, for the same reasons. Only invoked
  // for a `completed` transfer; a 202 (awaiting the other team's approval)
  // never reaches this handler, leaving the list untouched per
  // Requirement 15.6.
  const handleTransferCompleted = async () => {
    try {
      const teamResponse = await teamsAPI.getById(team.id)
      const allMembers = teamResponse.data.members || []
      setMembers(allMembers.filter(m => m.role === 'member' || m.role === 'inherited' || m.role === 'admin'))
      setAdmins(allMembers.filter(m => m.role === 'admin'))

      const channelsResponse = await channelsAPI.getByTeam(team.id)
      setChannels(channelsResponse.data.channels || [])

      // Notify Dashboard to refresh
      window.dispatchEvent(new CustomEvent('userAssignmentChanged'))
    } catch (error) {
      console.error('Failed to refresh team data after transfer:', error)
    }
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
        setMembers(allMembers.filter(m => m.role === 'member' || m.role === 'inherited' || m.role === 'admin'))
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
        
        // Fetch sub-teams, all teams, color mappings, and the configured
        // channel folder separator (used to build the custom-channel name
        // preview below, matching the real separator
        // Channel.createCustomChannel uses server-side -- see
        // CHANNEL_FOLDER_SEPARATOR).
        if (!isCancelled) {
          try {
            const [subTeamsResponse, allTeamsResponse, configResponse, publicConfigResponse] = await Promise.all([
              teamsAPI.getSubTeams(teamId),
              teamsAPI.getMyTeams(),
              api.get('/config/color-mappings'),
              configAPI.getPublic()
            ])
            if (!isCancelled) {
              setSubTeams(subTeamsResponse.data.subTeams || [])
              setAllTeams(allTeamsResponse.data.teams || [])
              setColorMappings(configResponse.data.colorMappings || {})
              setFolderSeparator(publicConfigResponse.data.channel_folder_separator || ' - ')
              setMaxTeamDepth(publicConfigResponse.data.maxTeamDepth ?? null)
              if (Array.isArray(publicConfigResponse.data.takRoleValues) && publicConfigResponse.data.takRoleValues.length > 0) {
                setTakRoleValues(publicConfigResponse.data.takRoleValues)
              }
            }
          } catch (err) {
            console.error('Failed to fetch teams:', err)
            if (!isCancelled) {
              setSubTeams([])
              setAllTeams([])
              setColorMappings({})
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

  // Bugfix: the Team Devices tab's count badge never appeared, because
  // `TeamDeviceList` (the only thing that knows the count, via its own
  // `onCountChange`) does not MOUNT until the devices tab is actually
  // selected -- `activeTab` defaults to 'members' -- while every other
  // tab's count is read directly off state (`members.length` etc.) that's
  // already fetched on page load regardless of which tab is showing.
  // This effect closes that gap with its OWN independent fetch, run
  // whenever this page loads (or `teamId` changes) and again whenever
  // `deviceListVersion` bumps (a device was just created via
  // AddTeamDeviceDialog), exactly mirroring `TeamDeviceList`'s own fetch
  // but decoupled from that component's mount state. While the devices
  // tab IS open, `TeamDeviceList`'s `onCountChange` (passed to it below)
  // keeps `deviceCount` live-updated for actions that happen entirely
  // inside that component (edit/delete/transfer), which this effect has
  // no visibility into.
  useEffect(() => {
    if (!devicesEnabled || !teamId) {
      return
    }
    let isCancelled = false
    devicesAPI.getTeamDevices(teamId)
      .then((response) => {
        if (!isCancelled) {
          setDeviceCount(response.data?.devices?.length ?? 0)
        }
      })
      .catch((err) => {
        console.error('Failed to fetch team device count:', err)
      })
    return () => {
      isCancelled = true
    }
  }, [devicesEnabled, teamId, deviceListVersion])

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
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">Error loading team</h3>
        <p className="text-gray-500 dark:text-gray-400">{error}</p>
      </div>
    )
  }



  if (!team && !loading) {
    return (
      <div className="card text-center py-12">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">Team not found</h3>
        <p className="text-gray-500 dark:text-gray-400">The team you're looking for doesn't exist or you don't have access.</p>
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

  // Pagination for current tab. The Team Devices tab is not one of the
  // four keys above (it owns its own list/fetch entirely, via
  // `TeamDeviceList` -- see that tab's own render branch), so it falls
  // back to an empty array here rather than `processedData['devices']`
  // being `undefined` and every `.length`/`.slice()` call below throwing.
  const currentData = processedData[activeTab] || []
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

  // Determine if current user can manage this team (global admin or team admin)
  const isGlobalAdmin = user?.isAdmin
  const isTeamAdmin = admins.some(a => String(a.id) === String(user?.userId))
  const canManageTeam = isGlobalAdmin || isTeamAdmin

  // Requirement 1.1/1.2: "Organisation" for a root team, "Team" otherwise.
  const teamLabel = labelFor(team)
  // Requirement 2.4/2.5: this team's own Team_Depth, compared against
  // maxTeamDepth to disable "Add Sub-team" at the deepest permitted level.
  const teamDepth = computeTeamDepth(team, allTeams)
  const atMaxTeamDepth = maxTeamDepth != null && teamDepth >= maxTeamDepth
  // takserver-enrollment Requirement 6.7/9.7 (task 5.5): whether this
  // team's own Organisation (via its Ancestor_Chain root) has the
  // Pseudonymous_Username_Policy enabled -- drives the Create New User
  // tab's Callsign Suffix "required" state/explanation and hides the
  // Username field entirely (there is none to hide today; see the note
  // at the Callsign Suffix field below).
  const pseudonymousTarget = isPseudonymousOrganisation(team, allTeams)

  return (
    <div className="space-y-6">
      {/* Team Header */}
      <div className="card">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="flex-1">
            {/* Bugfix: `flex-wrap` + `break-words` on the title itself
                (was a non-wrapping row with no break behaviour at all)
                -- `team.name` can be a concatenated
                "{parentPrefix} - {teamName}" string with no length
                cap, and neither the row nor the `h1` had any wrap/break
                behaviour to fall back on at narrow widths. */}
            <div className="flex items-center flex-wrap gap-2 mb-2">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 break-words">
                {team.parent_team_id ? `${parentTeam?.callsign_prefix || parentTeam?.name || 'Organisation'} - ${team.name}` : team.name}
              </h1>
              {team.color && (
                <div 
                  className="w-4 h-4 rounded border border-gray-300 flex-shrink-0" 
                  style={{ backgroundColor: getTakColorHex(team.color) }}
                  title={team.color}
                ></div>
              )}
              {team.can_join && (
                <ArrowLeftOnRectangleIcon className="h-4 w-4 text-green-500 flex-shrink-0" title="Joinable team" />
              )}
            </div>
            {team.parent_team_id && (
              <div className="mb-3">
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  <span className="font-medium">{teamLabel} Name:</span> {team.name}
                </div>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  <span className="font-medium">Display Name:</span> {parentTeam?.callsign_prefix || parentTeam?.name || 'Organisation'} - {team.name}
                </div>
              </div>
            )}
            <p className="text-gray-600 dark:text-gray-400 mb-3">{team.description || 'No description provided'}</p>
            <div className="space-y-2">
              <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
                <BuildingOfficeIcon className="h-4 w-4 mr-1" />
                <span>Parent {parentTeam ? labelFor(parentTeam) : 'Organisation'}: </span>
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
                    None
                  </Link>
                )}
              </div>
            </div>
          </div>
          {canManageTeam && (
          <div className="flex flex-col gap-2 lg:items-end">
            {/* Only the two most-used actions stay directly visible --
                Add Member and Add Team Device -- with every other action
                (Edit, Add Admin, Add Sub-team, Create Channel) moved
                behind the "More options" dropdown below, each still
                carrying its own icon so the items stay visually
                distinguishable from one another once they are no longer
                spread across separate labelled buttons. Add Team Device
                is gated on `devicesEnabled` exactly like the Team
                Devices tab it creates devices for -- both surfaces exist
                only while DEVICE_MGMT_ENABLED is on. */}
            {/* Bugfix: icon-only BELOW `sm:` only (was icon-only on
                EVERY viewport, including desktop -- a regression: the
                mobile fix should never have dropped the text label at
                `sm:` and up). Below `sm:`, Add Member/Add Team
                Device/More options are icon-only so all three fit on
                one row on a narrow phone instead of wrapping onto
                two/three lines; at `sm:` and up, the label text returns
                exactly as it always has. Each button's name stays on
                `aria-label`/`title` at every width (harmless once the
                text is visible too) so it's always announced correctly
                regardless of viewport. `flex-wrap` stays as a
                defensive fallback for the `sm:`-and-up, text-visible
                case. */}
            <div className="flex flex-wrap gap-2">
              <button 
                onClick={() => { dispatchNewUserForm({ type: 'reset' }); setNewUserEmailError(null); setAddMemberRole('member'); setAddMemberTab('new'); setShowAddMemberDialog(true) }}
                className="btn-primary flex items-center justify-center sm:justify-start p-2 sm:px-4 sm:py-2"
                aria-label="Add Member"
                title="Add Member"
              >
                <UserPlusIcon className="h-5 w-5 sm:h-4 sm:w-4 sm:mr-2" aria-hidden="true" />
                <span className="hidden sm:inline">Add Member</span>
              </button>
              {devicesEnabled && (
                <button
                  onClick={() => setShowAddDeviceDialog(true)}
                  className="btn-primary flex items-center justify-center sm:justify-start p-2 sm:px-4 sm:py-2"
                  aria-label="Add Team Device"
                  title="Add Team Device"
                >
                  <DevicePhoneMobileIcon className="h-5 w-5 sm:h-4 sm:w-4 sm:mr-2" aria-hidden="true" />
                  <span className="hidden sm:inline">Add Team Device</span>
                </button>
              )}
              <MoreOptionsMenu
                iconOnly="below-sm"
                // Bugfix: this toolbar is left-aligned below `lg:` and
                // only becomes right-aligned AT `lg:` (`lg:items-end` on
                // its containing column, above). The panel's default
                // anchor (`right-0`, opening leftward) pushed it off the
                // left edge of the screen on a phone, where the trigger
                // sits near the LEFT edge instead. Opening rightward
                // below `lg:` and switching to leftward only where the
                // toolbar itself does keeps the panel on-screen at every
                // width.
                panelClassName="left-0 lg:left-auto lg:right-0"
                items={[
                  {
                    key: 'edit',
                    label: `Edit ${teamLabel}`,
                    icon: PencilIcon,
                    onClick: () => setShowEditDialog(true)
                  },
                  {
                    key: 'add-admin',
                    label: 'Add Admin',
                    icon: ShieldCheckIcon,
                    onClick: () => { dispatchNewUserForm({ type: 'reset' }); setNewUserEmailError(null); setAddMemberRole('admin'); setAddMemberTab('existing'); setShowAddMemberDialog(true) }
                  },
                  {
                    key: 'add-sub-team',
                    label: 'Add Sub-team',
                    icon: FolderPlusIcon,
                    onClick: () => setShowSubTeamDialog(true),
                    disabled: atMaxTeamDepth,
                    title: atMaxTeamDepth ? `Maximum team depth (${maxTeamDepth}) reached` : undefined
                  },
                  {
                    key: 'create-channel',
                    label: `Create Channel (${channels.length}/3)`,
                    icon: SignalIcon,
                    onClick: () => setShowChannelDialog(true),
                    disabled: channels.length >= 3,
                    title: channels.length >= 3 ? 'Maximum 3 channels allowed' : 'Create custom channel'
                  }
                ]}
              />
            </div>
          </div>
          )}
        </div>

        {/* Divider + summary row span the FULL card width (both grid
            columns above), rather than living inside the left column
            alone -- placed as a sibling of the 2-column grid rather than
            inside it. Colour now carries actual state, alongside the
            text that already states it (never colour alone): green for
            an affirmative/open state (Public, Allowed, By Email Domain),
            red for Visibility's Private state specifically -- a team
            hidden from the public directory is the one state here worth
            flagging. "Join Limited" is shown only while Join Requests is
            Allowed; a disabled join request already means no one can
            join by any means, so a domain restriction underneath it has
            nothing left to qualify. */}
        <hr className="border-gray-200 dark:border-gray-700 my-3" />

        <div className="flex items-center flex-wrap gap-x-4 gap-y-2 text-sm text-gray-500 dark:text-gray-400">
          <div className="flex items-center">
            <span>Visibility: </span>
            <span className={`ml-1 ${team.visibility === 'public' ? TEAM_SUMMARY_BADGE_POSITIVE_CLASS : TEAM_SUMMARY_BADGE_NEGATIVE_CLASS}`}>
              {team.visibility === 'public' ? 'Public' : 'Private'}
            </span>
          </div>

          {!team.parent_team_id && (
            <div className="flex items-center">
              <span>Callsign Structure: </span>
              <span
                className={`ml-1 ${TEAM_SUMMARY_BADGE_CLASS}`}
                title="Team-Depth positions included in generated callsigns for this Organisation, and the name format applied to each member"
              >
                Levels: {formatCallsignLevels(team.callsign_level_selection)} &middot; {formatCallsignNameFormatExample(team.callsign_name_format)}
              </span>
            </div>
          )}

          <div className="flex items-center">
            <span>Join Requests: </span>
            <span className={`ml-1 ${team.can_join ? TEAM_SUMMARY_BADGE_POSITIVE_CLASS : TEAM_SUMMARY_BADGE_CLASS}`}>
              {team.can_join ? 'Allowed' : 'Disabled'}
            </span>
          </div>

          {/* Organisation-only, matching where Allowed Email Domains
              editing itself now lives (the Edit Organisation modal --
              see TeamFormDialog.jsx). `team.allowed_domains` is `null`
              for a Sub_Team (nothing to summarise) and an array,
              possibly empty, for an Organisation
              (server/routes/teams.js's GET /:teamId). Shown only while
              Join Requests is Allowed (`team.can_join`) -- a domain
              restriction is meaningless once join requests are disabled
              outright. State is carried in TEXT ("None"/"By Email
              Domain"), never colour alone; the domain LIST itself is
              disclosed only on hover/focus, via the same sideways
              relative-group tooltip pattern `DeviceTypeIcon.jsx` uses --
              never a native `title` attribute, which is not reliably
              disclosed on keyboard focus. */}
          {!team.parent_team_id && team.can_join && Array.isArray(team.allowed_domains) && (
            <div className="flex items-center">
              <span>Join Limited: </span>
              {team.allowed_domains.length > 0 ? (
                <span className="relative group ml-1" tabIndex={0}>
                  <span className={`${TEAM_SUMMARY_BADGE_POSITIVE_CLASS} cursor-help`}>
                    By Email Domain
                  </span>
                  <span className="absolute left-full top-1/2 transform -translate-y-1/2 ml-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                    {team.allowed_domains.join(', ')}
                  </span>
                </span>
              ) : (
                <span className={`ml-1 ${TEAM_SUMMARY_BADGE_CLASS}`}>
                  None
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Sign-up Code Manager (only for teams with can_join) */}
      {team.can_join && (
        <SignupCodeManager
          teamId={team.id}
          teamName={team.display_name || team.name}
          isAdmin={canManageTeam}
        />
      )}

      {/* Tabbed Interface */}
      <div className="card">
        {/* Tab Navigation. Bugfix: icon-only BELOW `sm:` only (was
            icon-only on EVERY viewport, including desktop -- the same
            regression the header action buttons had: a mobile fix must
            not remove the text label at `sm:` and up). Below `sm:`, each
            tab is icon + count only, so 5 tabs fit a narrow phone
            without needing `overflow-x-auto` at all -- that scrollbar
            is gone now that the icon-only width is small enough to fit.
            At `sm:` and up, the ORIGINAL "Label (count)" text returns in
            full, unabridged; `aria-label`/`title` stay set at every
            width (harmless once the text is visible too) so the
            accessible name is always correct regardless of viewport. */}
        <div className="border-b border-gray-200 dark:border-gray-700">
          <nav className="-mb-px flex space-x-3 sm:space-x-6" role="tablist">
            {[
              { id: 'members', label: 'Members', icon: UsersIcon, count: members.length },
              // Team Devices sits between Members and Team Admins,
              // gated on `devicesEnabled` exactly like the Add Team
              // Device header button and the per-member "View member
              // devices" affordance -- all three surfaces exist only
              // while DEVICE_MGMT_ENABLED is on. Bugfix: this tab's
              // count now MATCHES the other tabs' -- it used to
              // hardcode `count: null` (icon alone, no badge) because
              // this tab's list is NOT one of this page's own
              // `members`/`admins`/`channels`/`subTeams` arrays;
              // `TeamDeviceList` below owns its own fetch and list state
              // entirely. Rather than duplicating that fetch here, this
              // reads `deviceCount` (state above), kept in sync via
              // `TeamDeviceList`'s own `onCountChange` callback. `null`
              // (rendered as the icon alone, no badge, same as before)
              // only until that first fetch resolves.
              ...(devicesEnabled ? [{ id: 'devices', label: 'Team Devices', icon: DevicePhoneMobileIcon, count: deviceCount }] : []),
              { id: 'admins', label: 'Team Admins', icon: ShieldCheckIcon, count: admins.length },
              // SignalIcon, matching the icon Dashboard.jsx already uses
              // for its own "Total Channels" stat tile -- the closest
              // existing app-wide convention for "channels" as a
              // concept, rather than this tab's previous HashtagIcon,
              // which no other page uses for channels at all.
              { id: 'channels', label: 'Channels', icon: SignalIcon, count: channels.length },
              { id: 'subteams', label: 'Sub-teams', icon: BuildingOfficeIcon, count: subTeams.length }
            ].map((tab) => {
              const Icon = tab.icon
              const accessibleName = tab.count === null ? tab.label : `${tab.label} (${tab.count})`
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  aria-label={accessibleName}
                  title={accessibleName}
                  {...tabAria(activeTab, tab.id)}
                  className={`flex items-center py-4 px-1 border-b-2 font-medium text-sm flex-shrink-0 ${
                    activeTab === tab.id
                      ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                  }`}
                >
                  <Icon className="h-5 w-5 sm:mr-2" aria-hidden="true" />
                  <span className="hidden sm:inline">
                    {tab.count === null ? tab.label : `${tab.label} (${tab.count})`}
                  </span>
                  {tab.count !== null && (
                    <span className="ml-1.5 sm:hidden">{tab.count}</span>
                  )}
                </button>
              )
            })}
          </nav>
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {/* Search Bar. Omitted for the Team Devices tab: that tab
              renders `TeamDeviceList` directly, which is a self-contained
              divided list with its own fetch/loading/error state, not
              one of this page's own filterAndSort-backed arrays -- there
              is nothing here for this search box to filter. */}
          {activeTab !== 'devices' && (
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
          )}

          {/* Team Devices tab: renders the same `TeamDeviceList` this
              page used to show as a separate card BENEATH the tabbed
              interface -- now one of the tabs instead. Its own doc
              comment's "not a fifth tab inside it" framing predates this
              change; this section is the update to that decision. Still
              fetches from `GET /api/devices/team/:teamId`, a route
              entirely separate from the human member list and the human
              member-count query this page renders elsewhere, so this
              tab cannot reintroduce a Team_Owned_Device into either
              (`production-hardening` Criterion 27.9). */}
          {activeTab === 'devices' && devicesEnabled && (
            <TeamDeviceList key={deviceListVersion} teamId={team.id} onEnroll={setEnrollingDevice} user={user} onCountChange={setDeviceCount} />
          )}

          {/* Content based on active tab. Bugfix: Members now renders as
              a `sm:hidden` stacked card list PLUS the existing
              `hidden sm:block overflow-x-auto` table, matching the
              pairing `TeamDeviceList.jsx`/`Teams.jsx` already use, so a
              phone gets cards instead of a horizontally-scrolling
              table. The inline edit form (`MemberEditRow`) has no card
              equivalent -- editing a member is not something this
              surface needs to support with a distinct mobile layout, so
              a row being edited simply keeps rendering the (desktop-
              shaped) `MemberEditRow` regardless of viewport; it is rare
              enough, and self-contained enough, not to warrant a second
              layout. */}
          {activeTab === 'members' && (
            <>
              <div className="sm:hidden divide-y divide-gray-200 dark:divide-gray-700">
                {paginatedData.map((member) => (
                  editingMemberId === member.id ? (
                    <div key={member.id} className="overflow-x-auto">
                      <table className="min-w-full">
                        <tbody>
                          <MemberEditRow
                            colSpan={1}
                            form={memberEditForm}
                            setForm={setMemberEditForm}
                            takRoleValues={takRoleValues}
                            saving={savingMemberEdit}
                            error={memberEditError}
                            onSave={() => handleSaveMemberEdit(member.id)}
                            onCancel={handleCancelEditMember}
                          />
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div key={member.id} className="p-4 space-y-2 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium text-gray-900 dark:text-gray-100 break-words">
                          {member.first_name} {member.last_name}
                        </p>
                        {member.inherited_from_team_name ? (
                          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-blue-100 text-blue-800 dark:bg-blue-600 dark:text-blue-200 flex-shrink-0">
                            Member of <Link to={`/teams/${member.inherited_from_team_id}`} className="underline hover:no-underline">{member.inherited_from_team_name}</Link>
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-800 dark:bg-gray-600 dark:text-gray-200 flex-shrink-0">
                            Member
                          </span>
                        )}
                      </div>
                      <p className="text-gray-500 dark:text-gray-400 break-words">{member.email}</p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200">
                          {member.tak_role || 'Team Member'}
                        </span>
                        {member.tak_callsign && (
                          <span className="text-xs text-gray-500 dark:text-gray-400">{member.tak_callsign}</span>
                        )}
                      </div>
                      {canManageTeam && (
                        <MemberActions
                          member={member}
                          roleLabel="member"
                          devicesEnabled={devicesEnabled}
                          onEdit={handleStartEditMember}
                          onResendWelcome={handleResendWelcome}
                          onTransfer={setTransferringMember}
                          onViewDevices={setDevicesForMember}
                          onRemove={handleRemoveUser}
                          variant="card"
                        />
                      )}
                    </div>
                  )
                ))}
              </div>

              <div className="hidden sm:block overflow-x-auto">
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
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      TAK Role
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Callsign
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
                  {paginatedData.map((member) => (
                    editingMemberId === member.id ? (
                      <MemberEditRow
                        key={member.id}
                        colSpan={6}
                        form={memberEditForm}
                        setForm={setMemberEditForm}
                        takRoleValues={takRoleValues}
                        saving={savingMemberEdit}
                        error={memberEditError}
                        onSave={() => handleSaveMemberEdit(member.id)}
                        onCancel={handleCancelEditMember}
                      />
                    ) : (
                      <tr key={member.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-gray-100">
                          {member.first_name} {member.last_name}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                          {member.email}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {member.inherited_from_team_name ? (
                            <span className="px-2 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-800 dark:bg-blue-600 dark:text-blue-200">
                              Member of <Link to={`/teams/${member.inherited_from_team_id}`} className="underline hover:no-underline">{member.inherited_from_team_name}</Link>
                            </span>
                          ) : (
                            <span className="px-2 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-800 dark:bg-gray-600 dark:text-gray-200">
                              Member
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className="px-2 py-1 text-xs font-medium rounded-full bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200">
                            {member.tak_role || 'Team Member'}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                          {member.tak_callsign || '-'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          {canManageTeam && (
                            <MemberActions
                              member={member}
                              roleLabel="member"
                              devicesEnabled={devicesEnabled}
                              onEdit={handleStartEditMember}
                              onResendWelcome={handleResendWelcome}
                              onTransfer={setTransferringMember}
                              onViewDevices={setDevicesForMember}
                              onRemove={handleRemoveUser}
                            />
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

          {/* Bugfix: same sm:hidden card / hidden sm:block table pairing
              as Members above, sharing the same MemberActions
              component. */}
          {activeTab === 'admins' && (
            <>
              <div className="sm:hidden divide-y divide-gray-200 dark:divide-gray-700">
                {paginatedData.map((admin) => (
                  editingMemberId === admin.id ? (
                    <div key={admin.id} className="overflow-x-auto">
                      <table className="min-w-full">
                        <tbody>
                          <MemberEditRow
                            colSpan={1}
                            form={memberEditForm}
                            setForm={setMemberEditForm}
                            takRoleValues={takRoleValues}
                            saving={savingMemberEdit}
                            error={memberEditError}
                            onSave={() => handleSaveMemberEdit(admin.id)}
                            onCancel={handleCancelEditMember}
                          />
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div key={admin.id} className="p-4 space-y-2 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium text-gray-900 dark:text-gray-100 break-words">
                          {admin.first_name} {admin.last_name}
                        </p>
                        {admin.inherited_from_team_name ? (
                          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-purple-100 text-purple-800 dark:bg-purple-600 dark:text-purple-200 flex-shrink-0">
                            Admin of <Link to={`/teams/${admin.inherited_from_team_id}`} className="underline hover:no-underline">{admin.inherited_from_team_name}</Link>
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 flex-shrink-0">
                            Admin
                          </span>
                        )}
                      </div>
                      <p className="text-gray-500 dark:text-gray-400 break-words">{admin.email}</p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200">
                          {admin.tak_role || 'Team Member'}
                        </span>
                        {admin.tak_callsign && (
                          <span className="text-xs text-gray-500 dark:text-gray-400">{admin.tak_callsign}</span>
                        )}
                      </div>
                      {canManageTeam && (
                        <MemberActions
                          member={admin}
                          roleLabel="admin"
                          devicesEnabled={devicesEnabled}
                          onEdit={handleStartEditMember}
                          onResendWelcome={handleResendWelcome}
                          onTransfer={setTransferringMember}
                          onViewDevices={setDevicesForMember}
                          onRemove={handleRemoveUser}
                          variant="card"
                        />
                      )}
                    </div>
                  )
                ))}
              </div>

              <div className="hidden sm:block overflow-x-auto">
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
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      TAK Role
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Callsign
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
                  {paginatedData.map((admin) => (
                    editingMemberId === admin.id ? (
                      <MemberEditRow
                        key={admin.id}
                        colSpan={6}
                        form={memberEditForm}
                        setForm={setMemberEditForm}
                        takRoleValues={takRoleValues}
                        saving={savingMemberEdit}
                        error={memberEditError}
                        onSave={() => handleSaveMemberEdit(admin.id)}
                        onCancel={handleCancelEditMember}
                      />
                    ) : (
                      <tr key={admin.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-gray-100">
                          {admin.first_name} {admin.last_name}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                          {admin.email}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          {admin.inherited_from_team_name ? (
                            <span className="px-2 py-1 text-xs font-medium rounded-full bg-purple-100 text-purple-800 dark:bg-purple-600 dark:text-purple-200">
                              Admin of <Link to={`/teams/${admin.inherited_from_team_id}`} className="underline hover:no-underline">{admin.inherited_from_team_name}</Link>
                            </span>
                          ) : (
                            <span className="px-2 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                              Admin
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className="px-2 py-1 text-xs font-medium rounded-full bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200">
                            {admin.tak_role || 'Team Member'}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                          {admin.tak_callsign || '-'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          {canManageTeam && (
                            <MemberActions
                              member={admin}
                              roleLabel="admin"
                              devicesEnabled={devicesEnabled}
                              onEdit={handleStartEditMember}
                              onResendWelcome={handleResendWelcome}
                              onTransfer={setTransferringMember}
                              onViewDevices={setDevicesForMember}
                              onRemove={handleRemoveUser}
                            />
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

          {/* Bugfix: same sm:hidden card / hidden sm:block table
              pairing as Members/Team Admins above. This tab is
              read-only (no per-row actions), so its card is just the
              same three facts as the table row. */}
          {activeTab === 'channels' && (
            <>
              <div className="sm:hidden divide-y divide-gray-200 dark:divide-gray-700">
                {paginatedData.map((channel) => (
                  <div key={channel.id} className="p-4 space-y-2 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900 dark:text-gray-100 break-words">
                          {channel.display_name}
                        </p>
                        {channel.custom_suffix && (
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            Suffix: {channel.custom_suffix}
                          </p>
                        )}
                      </div>
                      {channel.authentik_group_id && (
                        <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 flex-shrink-0">
                          Synced
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                        channel.channel_type === 'primary'
                          ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                          : 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                      }`}>
                        {channel.channel_type === 'primary' ? 'Primary' : 'Custom'}
                      </span>
                      <span className="text-gray-500 dark:text-gray-400">{channel.member_count || 0} members</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden sm:block overflow-x-auto">
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
            </>
          )}

          {/* Bugfix: same sm:hidden card / hidden sm:block table
              pairing as the tabs above -- mirrors the same shape
              Teams.jsx's own overview table already got. Description is
              inline text on the card (no hover-only tooltip -- useless
              on a touchscreen), matching Teams.jsx's own card
              treatment. */}
          {activeTab === 'subteams' && (
            <>
              <div className="sm:hidden divide-y divide-gray-200 dark:divide-gray-700">
                {paginatedData.map((subTeam) => (
                  <div key={subTeam.id} className="p-4 space-y-2 text-sm">
                    <Link
                      to={`/teams/${subTeam.id}`}
                      className="font-medium text-gray-900 dark:text-gray-100 hover:text-primary-600 dark:hover:text-primary-400 break-words"
                    >
                      {subTeam.name}
                    </Link>
                    {subTeam.description && (
                      <p className="text-gray-500 dark:text-gray-400">{subTeam.description}</p>
                    )}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                      <div className="flex items-baseline gap-1">
                        <span className="text-xs text-gray-500 dark:text-gray-400">Members:</span>
                        <span className="text-gray-900 dark:text-gray-100">{subTeam.member_count || 0}</span>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-xs text-gray-500 dark:text-gray-400">Sub-teams:</span>
                        <span className="text-gray-900 dark:text-gray-100">{subTeam.sub_teams_count || 0}</span>
                      </div>
                      {subTeam.callsign_prefix && (
                        <div className="flex items-baseline gap-1">
                          <span className="text-xs text-gray-500 dark:text-gray-400">Prefix:</span>
                          <span className="text-gray-900 dark:text-gray-100">{subTeam.callsign_prefix}</span>
                        </div>
                      )}
                    </div>
                    {/* Bugfix (mobile tap targets too small): button-box
                        style matching MemberActions/DeviceActions/
                        TeamRowActions' own `variant="card"` treatment --
                        this pair of actions was never extracted into a
                        shared component (only 2 icons), so the same
                        p-2/rounded-lg/h-5 w-5 shapes are applied inline
                        here instead. */}
                    <div className="flex items-center justify-end space-x-3">
                      <Link
                        to={`/teams/${subTeam.id}`}
                        className="p-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-primary-600 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-primary-400"
                        title="View team details"
                      >
                        <MagnifyingGlassIcon className="h-5 w-5" />
                      </Link>
                      {(subTeam.sub_teams_count || 0) === 0 && (
                        <button
                          onClick={() => setDeleteSubTeamId(subTeam.id)}
                          className="p-2 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 dark:bg-red-950/40 dark:hover:bg-red-900/60 dark:text-red-400"
                          title="Delete sub-team"
                        >
                          <TrashIcon className="h-5 w-5" />
                        </button>
                      )}
                      {(subTeam.sub_teams_count || 0) > 0 && (
                        <button
                          disabled
                          className="p-2 rounded-lg bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-600 cursor-not-allowed"
                          title="Cannot delete team with sub-teams"
                        >
                          <TrashIcon className="h-5 w-5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden sm:block overflow-x-auto">
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
                            // Sideways, matching this codebase's tooltip
                            // convention (see Teams.jsx's identical fix):
                            // this row sits inside an `overflow-x-auto`
                            // table wrapper, which clips a `bottom-full`
                            // tooltip on both axes.
                            <div className="absolute left-full top-1/2 transform -translate-y-1/2 ml-2 px-3 py-2 bg-gray-900 text-white text-sm rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10 whitespace-normal w-64">
                              {subTeam.description}
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
            </>
          )}

          {/* Empty State. Omitted for the Team Devices tab -- TeamDeviceList
              renders its own empty state ("No devices are enrolled under
              this team.") and this generic one would otherwise ALSO render
              underneath it, since `currentData` falls back to an empty
              array for a tab id with no entry in `processedData`. */}
          {activeTab !== 'devices' && paginatedData.length === 0 && (
            <div className="text-center py-8">
              <p className="text-gray-500 dark:text-gray-400">
                {searchTerms[activeTab] ? `No ${activeTab} found matching your search.` : `No ${activeTab} yet.`}
              </p>
            </div>
          )}

          {/* Pagination */}
          {/* Bugfix: same `flex-wrap gap-2` fix as Teams.jsx's identical
              pagination row -- see that file's comment for why. */}
          {activeTab !== 'devices' && totalPages > 1 && (
            <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
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

      {/* Create Sub-Team Dialog. Bugfix: full-bleed on mobile
          (`h-full w-full`, no rounding, `sm:p-4` on the overlay) rather
          than a floating card -- its ~6 stacked fields/sections don't
          fit a phone viewport regardless of box size, so a full-screen
          sheet uses the space better than a small floating box would.
          `sm:` and up keeps the original floating-card treatment. */}
      {showSubTeamDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-sub-team-title"
            className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-2xl sm:h-auto sm:max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 id="create-sub-team-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">Create Team</h3>
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
                    <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Parent {teamLabel}:</h4>
                    <div className="relative group">
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 cursor-help">
                        {team.name}
                      </span>
                      {team.description && (
                        <div className="absolute left-full top-1/2 transform -translate-y-1/2 ml-2 px-3 py-2 bg-gray-900 text-white text-sm rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-10 whitespace-normal w-64">
                          {team.description}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-xs text-gray-500 dark:text-gray-400">Inherited TAK Colour:</span>
                    {team.color && (
                      <div className="flex items-center space-x-1">
                        <div 
                          className="w-3 h-3 rounded border border-gray-300" 
                          style={{ backgroundColor: getTakColorHex(team.color) }}
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
                    pattern={CALLSIGN_PREFIX_PATTERN}
                    title="Only letters and digits are allowed (no -)"
                    placeholder="STL, AKL, etc."
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Used to build callsigns. Example: FENZ-STL-John Smith
                  </p>
                  {!isValidSubTeamCallsignPrefix(subTeamFormData.callsignPrefix) && (
                    <p role="alert" className="text-red-600 dark:text-red-400 text-sm mt-1">Prefix may only contain letters and digits (no "-")</p>
                  )}
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
                  {creatingSubTeam ? 'Creating Team...' : 'Create Team'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Sub-Team Confirmation Dialog */}
      {deleteSubTeamId && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-sub-team-title"
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full"
          >
            <div className="p-6">
              <h3 id="delete-sub-team-title" className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
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
                  className="btn-danger disabled:opacity-50"
                >
                  {deletingSubTeam ? 'Deleting...' : 'Delete Sub-Team'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Member Dialog. Bugfix: full-bleed on mobile, same treatment
          as Create Sub-Team above -- its "Create New User" tab alone
          (5 fields/blocks plus 2 info panels) never fits a phone
          viewport regardless of box size. */}
      {showAddMemberDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-member-title"
            className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-2xl sm:h-auto sm:max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 id="add-member-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Add {addMemberRole === 'admin' ? 'Admin' : 'Member'} to Team
              </h3>
              <button
                onClick={() => {
                  setShowAddMemberDialog(false)
                  setAddMemberTab('new')
                  setSelectedUserId('')
                  setUserSearch('')
                  dispatchNewUserForm({ type: 'reset' })
                  setNewUserEmailError(null)
                  setAddMemberRole('member')
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
                  onClick={() => setAddMemberTab('new')}
                  className={`py-4 px-6 border-b-2 font-medium text-sm ${
                    addMemberTab === 'new'
                      ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                  }`}
                >
                  Create New User
                </button>
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
                          {describeEmptyAvailableUsers({ scope: availableUsersScope, search: userSearch }).message}
                        </div>
                      ) : (
                        <div className="space-y-1 p-2">
                          {availableUsers.map((user) => (
                            <label key={user.id} className="flex items-center p-3 hover:bg-gray-50 dark:hover:bg-gray-700 rounded cursor-pointer">
                              <input
                                type="radio"
                                name="selectedUser"
                                value={user.id}
                                checked={selectedUserId === String(user.id)}
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
                      value={newUserFormState.email}
                      onChange={(e) => {
                        dispatchNewUserForm({ type: 'fieldChanged', field: 'email', value: e.target.value })
                        setNewUserEmailError(null)
                      }}
                      onBlur={() => { if (newUserFormState.email && !isValidNewUserEmail(newUserFormState.email)) setNewUserEmailError('Please enter a valid email address.') }}
                      aria-invalid={newUserEmailError ? 'true' : undefined}
                      className="input w-full"
                      placeholder="user@organisation.nz"
                    />
                    {newUserEmailError && (
                      <p role="alert" className="text-red-600 text-sm mt-1">{newUserEmailError}</p>
                    )}
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="new-user-first-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        First Name *
                      </label>
                      <input
                        id="new-user-first-name"
                        type="text"
                        required
                        value={newUserFormState.firstName}
                        onChange={(e) => dispatchNewUserForm({ type: 'fieldChanged', field: 'firstName', value: e.target.value })}
                        onBlur={() => dispatchNewUserForm({ type: 'previewRequested', trigger: 'names', teamId: team?.id })}
                        className="input w-full"
                        placeholder="Joe"
                      />
                    </div>
                    
                    <div>
                      <label htmlFor="new-user-last-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        Last Name *
                      </label>
                      <input
                        id="new-user-last-name"
                        type="text"
                        required
                        value={newUserFormState.lastName}
                        onChange={(e) => dispatchNewUserForm({ type: 'fieldChanged', field: 'lastName', value: e.target.value })}
                        onBlur={() => dispatchNewUserForm({ type: 'previewRequested', trigger: 'names', teamId: team?.id })}
                        className="input w-full"
                        placeholder="Bloggs"
                      />
                    </div>
                  </div>

                  {/* Callsign Suffix: pre-filled from the advisory
                      `POST /api/users/callsign-suffix-preview` check on blur of
                      the name inputs, required when the Organisation's
                      `callsign_name_format` is `user_defined`, and re-checked on
                      its own blur so a manually typed value is collision-checked
                      before submit.

                      takserver-enrollment Requirement 9.7 (task 5.5): ALSO
                      required, unconditionally, when the target
                      Organisation is pseudonymous (`pseudonymousTarget`) --
                      Callsign_Default_Suppression means the server never
                      computes a name-derived default there
                      (`resolveNewUserIdentity`'s policy-enabled branch), so
                      this field is required regardless of what the
                      `callsign_name_format`-driven preview reports. Stated
                      here as visible TEXT and a `required` attribute BEFORE
                      submit, per Criterion 9.7 -- not left for the admin to
                      discover only from the server's rejection. */}
                  <div>
                    <label htmlFor="new-user-callsign-suffix" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Callsign Suffix {(newUserFormState.required || pseudonymousTarget) ? '*' : ''}
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="new-user-callsign-suffix"
                        type="text"
                        value={newUserFormState.suffix}
                        onChange={(e) => dispatchNewUserForm({ type: 'suffixEdited', value: e.target.value })}
                        onBlur={() => dispatchNewUserForm({ type: 'previewRequested', trigger: 'suffix', teamId: team?.id })}
                        className="input w-full"
                        pattern={CALLSIGN_SUFFIX_PATTERN}
                        title="Only letters, digits, - and . are allowed"
                        placeholder="Filled in automatically"
                        required={newUserFormState.required || pseudonymousTarget}
                        aria-invalid={newUserFormState.error ? 'true' : undefined}
                        aria-describedby={newUserFormState.error ? 'new-user-callsign-suffix-error' : ((newUserFormState.required || pseudonymousTarget) ? 'new-user-callsign-suffix-help' : undefined)}
                      />
                      {/* Recompute_Control: forces a Suffix_Preview that omits
                          `callsignSuffix`, discarding any Admin_Typed_Suffix and
                          resuming automatic tracking (Requirement 2). MUST be
                          `type="button"` -- inside this <form onSubmit=...>, a
                          typeless button defaults to submit and would create the
                          user instead of recomputing. */}
                      <button
                        type="button"
                        onClick={() => dispatchNewUserForm({ type: 'previewRequested', trigger: 'recompute', teamId: team?.id })}
                        disabled={isRecomputeDisabled(newUserFormState)}
                        aria-label="Recompute callsign suffix from the entered names"
                        title="Recompute callsign suffix from the entered names"
                        className="btn-secondary px-3 disabled:opacity-50"
                      >
                        <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                    {selectSuffixBusy(newUserFormState) && (
                      <span role="status" aria-live="polite" className="text-xs text-gray-500 dark:text-gray-400 mt-1 inline-block">
                        Checking callsign suffix…
                      </span>
                    )}
                    {pseudonymousTarget ? (
                      !newUserFormState.error && (
                        <p id="new-user-callsign-suffix-help" className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                          Required because this Organisation uses pseudonymous usernames: the username is generated automatically and carries no personal information, so it cannot stand in for a callsign the way a name-derived one would.
                        </p>
                      )
                    ) : (
                      newUserFormState.required && !newUserFormState.error && (
                        <p id="new-user-callsign-suffix-help" className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                          This Organisation requires a manually chosen callsign suffix.
                        </p>
                      )
                    )}
                    {newUserFormState.error && (
                      <p id="new-user-callsign-suffix-error" role="alert" className="text-red-600 text-sm mt-1">
                        {newUserFormState.error}
                      </p>
                    )}
                  </div>

                  {/* takserver-enrollment Requirement 6.3/6.4/9.7 (task
                      5.5): this tab has no Username input to begin with --
                      `create-and-add` always derives it server-side (from
                      the email when the policy is disabled, per
                      Criterion 6.8) -- so there is no field to hide. What
                      Criterion 9.7 requires here is the same fact stated as
                      visible text: under a pseudonymous policy the
                      username is generated, not derived from anything
                      submitted on this form, so no admin-supplied value is
                      ever silently discarded server-side because none is
                      ever offered. */}
                  {pseudonymousTarget && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      This Organisation uses pseudonymous usernames: the new member's TAK username will be generated automatically and will not be derived from their email address or name.
                    </p>
                  )}

                  <div className="bg-blue-50 dark:bg-blue-900 p-4 rounded-lg">
                    <p className="text-sm text-blue-800 dark:text-blue-200">
                      <strong>Note:</strong> The user will be created in the Account Management System and automatically added to this team. 
                      They will need to set their password on first login.
                    </p>
                  </div>
                  
                  <div className="flex justify-end space-x-3 pt-4">
                    <button
                      type="button"
                      onClick={() => { setShowAddMemberDialog(false); setNewUserEmailError(null) }}
                      className="btn-secondary px-6 py-2"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!newUserFormState.email || !newUserFormState.firstName || !newUserFormState.lastName || addingMember}
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

      {/* Create Channel Dialog. Bugfix: full-bleed on mobile, same
          treatment as Create Sub-Team/Add Member above. */}
      {showChannelDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-channel-title"
            className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-2xl sm:h-auto sm:max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 id="create-channel-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">Create Custom Channel</h3>
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
                      ? `Teams${folderSeparator}${parentTeam?.callsign_prefix || parentTeam?.name || 'Root'}${folderSeparator}${team.name}`
                      : `Teams${folderSeparator}${team.callsign_prefix || team.name}`
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
      {removeUserId && (() => {
        const removeTarget = [...members, ...admins].find(m => m.id === removeUserId)
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
                    setRemoveUserRole('')
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


      {/* Requirement 15.1: Transfer Member Dialog (Members and Team Admins tabs) */}
      {transferringMember && (
        <TransferMemberDialog
          member={transferringMember}
          team={team}
          // Requirement 15.9: the dialog's all-teams fallback is gated on the
          // operating user being a Global_Manager, so it needs this page's
          // own `user` -- the Organisation-scoped call returns [] for a
          // Global_Manager holding no team membership of their own.
          user={user}
          onClose={() => setTransferringMember(null)}
          onCompleted={handleTransferCompleted}
        />
      )}

      {/* Requirements 6.3, 6.5: the shared device modal (also attached in
          Users.jsx -- ONE component, two surfaces). Serves both the Members
          and Team Admins tabs. */}
      {devicesForMember && (
        <UserDevicesModal
          userId={devicesForMember.id}
          userName={`${devicesForMember.first_name || ''} ${devicesForMember.last_name || ''}`.trim() || devicesForMember.email}
          onClose={() => setDevicesForMember(null)}
        />
      )}

      {/* Header toolbar's "Add Team Device" action: creates a brand-new
          Team_Owned_Device (POST /api/devices), distinct from the Team
          Devices tab's "Enroll" action on an already-existing one. On
          success, bumps `deviceListVersion` so the Team Devices tab's
          `TeamDeviceList` remounts and shows the new device without a
          full page reload. */}
      {showAddDeviceDialog && (
        <AddTeamDeviceDialog
          teamId={team.id}
          team={team}
          allTeams={allTeams}
          onClose={() => setShowAddDeviceDialog(false)}
          onCreated={() => setDeviceListVersion((version) => version + 1)}
        />
      )}

      {/* takserver-enrollment Criteria 3.1, 3.6, 10.10 (task 11.3): the
          Team_Owned_Device's Enrollment_View, opened from the Devices
          section's "Enroll" action above. `fetchEnrollment` calls THIS
          device's own `POST /api/devices/:deviceUserId/qr-code` --
          `generateEnrollmentQrCode` server-side -- rather than
          `EnrollmentView`'s default self-service route, which is what lets
          the SAME component (Criterion 10.10) serve a Team_Owned_Device
          here and a Human_Principal at `/enrollment` without knowing which
          one it is showing. A short-lived dialog: closing it does not need
          to cancel anything in flight, since `EnrollmentView` itself never
          auto-refreshes (see its own doc comment). */}
      {/* Bugfix: full-bleed on mobile, same treatment as the other
          large dialogs above -- the 4-tab EnrollmentView (Enrollment
          Data grid, Device Enrollment Requirements list, instructions,
          countdown) needs to scroll regardless of container height. */}
      {enrollingDevice && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="enroll-device-title"
            className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-3xl sm:h-auto sm:max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 id="enroll-device-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Enroll {deviceDisplayName(enrollingDevice)}
              </h3>
              <button
                onClick={() => setEnrollingDevice(null)}
                className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
                aria-label="Close"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            <div className="p-6">
              <EnrollmentView
                fetchEnrollment={async () => {
                  const response = await devicesAPI.generateQrCode(enrollingDevice.deviceUserId)
                  return response.data.qrCode
                }}
                fetchPreview={async () => {
                  const response = await devicesAPI.previewQrCode(enrollingDevice.deviceUserId)
                  return response.data.preview
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Edit Team Dialog (shared with Teams.jsx). `isAdmin={canManageTeam}`
          gates the nested OrgDomainManager (Allowed Email Domains) the
          same way this page's own header actions and Team Devices tab
          already are. `isGlobalManager={isGlobalAdmin}` is DELIBERATELY
          NOT `canManageTeam` -- region-channel-tiers: the Channel Access
          tab has no Team_Admin fallback at all, unlike Allowed Email
          Domains, so a Team_Admin who is not also a Global_Manager (a
          real case `canManageTeam` alone does not distinguish) must not
          see that tab. */}
      <TeamFormDialog
        mode="edit"
        team={team}
        teams={allTeams}
        maxTeamDepth={maxTeamDepth}
        colorMappings={colorMappings}
        isOpen={showEditDialog}
        onClose={() => setShowEditDialog(false)}
        isAdmin={canManageTeam}
        isGlobalManager={isGlobalAdmin}
        onSaved={(updatedTeam) => {
          // Requirement 14.3 (task 37.1 fix): reflect the team as the
          // server actually persisted it (`response.data.team`, passed
          // here as `updatedTeam`) rather than blindly merging submitted
          // form values into local state. This matters concretely here
          // because the server silently ignores a Sub_Team's `color`/
          // `callsignNameFormat` overrides (Requirement 3.3) and may
          // normalize/default `callsign_level_selection` -- neither of
          // which the submitted form values alone would reflect.
          setTeam(updatedTeam)

          // Update parent team if changed
          if (updatedTeam.parent_team_id !== team.parent_team_id) {
            if (updatedTeam.parent_team_id) {
              const newParent = allTeams.find(t => t.id === updatedTeam.parent_team_id)
              setParentTeam(newParent || null)
            } else {
              setParentTeam(null)
            }
          }
        }}
      />
    </div>
  )
}