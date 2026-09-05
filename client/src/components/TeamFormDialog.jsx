import { useState, useEffect } from 'react'
import { XMarkIcon, LockClosedIcon, LockOpenIcon, CheckIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { teamsAPI } from '../services/api'
import { labelFor, labelForNew } from '../utils/teamLabels'
import { formatLevelLabel, groupCallsignLevelOptionsByDepth } from '../utils/callsignLevels'
import OrgDomainManager from './OrgDomainManager'
import ChannelAccessManager from './ChannelAccessManager'
import InfoTooltip from './InfoTooltip'
import { tabAria } from './Tabs'
import { getCountry, filterCountries } from '../utils/isoCountry'

// Requirement 3.10 (task 32.6): mirrors
// server/utils/callsignValidation.js's `isValidCallsignPrefix` character
// class (letters and digits only, no `-` -- stricter than
// `callsign_suffix`, per Requirement 3.8) as an HTML `pattern`, applied
// to this dialog's own "Prefix" input (`formData.callsignPrefix`).
//
// Moved here from Teams.jsx (bugfix: the Create/Edit Team dialog used to
// be duplicated between Teams.jsx and TeamDetail.jsx and had drifted out
// of sync -- this component is now the single source of truth for both
// pages).
// Foreign-partner-prefix extension: mirrors server/utils/callsignValidation.js's
// widened CALLSIGN_PREFIX_PATTERN -- one or more `-`-separated alphanumeric
// segments (e.g. "AUS-FIRE"), not just a single hyphen-free run. The
// marker+body-shape rejection (`isValidCallsignPrefix`'s other new check)
// is server-side only; this HTML pattern is a first-pass UX guard, not the
// authoritative validator.
const CALLSIGN_PREFIX_PATTERN = '[A-Za-z0-9]+(-[A-Za-z0-9]+)*'
const CALLSIGN_PREFIX_REGEX = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/

// Pure validation helper for this dialog's `callsignPrefix` input,
// mirroring TeamDetail.jsx's `isValidSubTeamCallsignPrefix` convention --
// an empty value is valid (the field is optional). Exported for the same
// reason it previously was from Teams.jsx: direct unit testing without
// rendering the component.
export function isValidCallsignPrefixInput(value) {
  if (!value) {
    return true
  }
  return CALLSIGN_PREFIX_REGEX.test(value)
}

// takserver-enrollment Requirement 2.1/2.2/2.3 (task 4.2): mirrors the
// server's Requirement 2.1/2.4 rule -- an Organisation (no parentTeamId)
// requires a non-empty callsignPrefix, while a Sub_Team's prefix stays
// optional exactly as it is today (Criterion 2.3). Stated here as a pure,
// directly-testable predicate so the "required" marker and the live
// validation message below stay in sync with a single source of truth,
// the same convention `isValidCallsignPrefixInput` already established.
// The server remains the authority (Criterion 2.4) -- this only tells
// the truth about that rule earlier, in the form, rather than adding a
// second enforcement point. A whitespace-only value counts as missing,
// matching the server's own treatment.
export function isOrganisationCallsignPrefixMissing(parentTeamId, callsignPrefix) {
  if (parentTeamId) {
    return false
  }
  const trimmed = typeof callsignPrefix === 'string' ? callsignPrefix.trim() : callsignPrefix
  return !trimmed
}

// Bugfix: `formData.callsignLevelSelection` and
// `formData.pseudonymousUsernames` are ALWAYS seeded to a concrete value
// for a Sub_Team -- `[]` and `false` respectively (see the edit-mode
// seeding effect and `EMPTY_FORM_DATA`), never `undefined`/`null`. The
// server's own guard for both fields is `value !== undefined` (Sub_Team
// rejection in `Team.update`/`Team.create`) -- an empty array or `false`
// still counts as "supplied", so saving ANY existing Sub_Team (even with
// zero actual changes) always threw "callsignLevelSelection can only be
// set on an Organisation", since the whole `formData` object was sent
// verbatim as the request body.
//
// This builds the actual submit payload from `formData`, DELETING both
// Organisation-only keys entirely for a Sub_Team (parentTeamId present)
// rather than sending their always-populated placeholder values. Axios's
// JSON serialization drops a key whose value is `undefined`, but never
// drops an empty array or `false` -- so the key must be removed from the
// object, not merely set to `undefined` on it (both approaches serialize
// identically via `JSON.stringify`, but deleting is the explicit,
// self-documenting one). For an Organisation, the payload is unchanged.
//
// Exported for direct unit testing, matching this file's convention of
// testing extracted pure logic without rendering the component.
export function buildTeamSubmitPayload(formData) {
  if (!formData?.parentTeamId) {
    return formData
  }
  const payload = { ...formData }
  delete payload.callsignLevelSelection
  delete payload.pseudonymousUsernames
  // Foreign_Partner Organisation country prefix feature: countryCode is
  // Organisation-only (mirroring callsignLevelSelection/pseudonymousUsernames
  // immediately above) -- the server rejects it outright on a Sub_Team, so
  // it is dropped from a Sub_Team's payload rather than sent as an
  // always-empty placeholder.
  delete payload.countryCode
  // Callsign Team-segment separator toggle: Organisation-only, mirroring
  // countryCode immediately above -- the server rejects it outright on a
  // Sub_Team.
  delete payload.callsignTeamHyphenated
  return payload
}

// Bugfix (re-parent authorization gap, client-side follow-up): the
// "Parent Team" dropdown's candidate list. The SERVER now rejects a
// re-parent onto a destination the caller does not administer
// (`team:update`'s row-scoped resolver in authorize.js), but leaving the
// dropdown itself unfiltered would let a Team_Admin pick an option that
// silently 403s on submit -- a bad experience even though nothing unsafe
// would actually happen. This filters the dropdown to teams the caller
// could ACTUALLY move something onto:
//   - A Global_Manager sees every candidate, unfiltered (their `team:
//     update` re-parent check has no destination restriction at all).
//   - Anyone else sees only teams carrying `can_manage: true` -- the
//     field `GET /api/teams/my-teams` now annotates on every row
//     (mirroring `GET /api/users`' own `can_manage`, both ultimately
//     `Team.getManagedTeamIds`-backed), i.e. exactly the teams
//     `Team.isAdmin` would say yes to for this caller.
//
// The team currently being edited is excluded either way -- a team can
// never be its own parent -- matching this dropdown's pre-existing
// behaviour (unchanged from before this fix).
//
// A `can_manage` value that is missing entirely (e.g. a caller on an
// older cached response, or a test fixture that predates this field) is
// treated as NOT manageable (`t.can_manage === true` only, never a loose
// truthy check) -- failing closed is the safe default for a dropdown
// feeding an authorization-sensitive action, consistent with every
// server-side fail-closed convention this app already follows
// (`Team.isAdmin`'s own catch block, `DirectoryScopeService`, etc.).
//
// Exported for direct unit testing, matching this file's convention of
// testing extracted pure logic without rendering the component.
export function parentTeamCandidates(teams, editingTeam, isGlobalManager) {
  const withoutSelf = (teams || []).filter(t => t.id !== (editingTeam ? editingTeam.id : undefined))
  if (isGlobalManager) {
    return withoutSelf
  }
  return withoutSelf.filter(t => t.can_manage === true)
}

// Small inline indicator shown next to a form field's label, making it
// unambiguous at a glance whether a field can still be changed once the
// team exists: a green OPEN padlock for a field that remains editable
// after creation, or a red CLOSED padlock for a field that is locked
// after creation. A native title tooltip on hover explains why -- same
// `title=""` tooltip convention already used throughout Teams.jsx (e.g.
// the "Cannot delete team with sub-teams" trash icon).
function FieldLockIndicator({ locked, lockedReason, editableReason = 'Editable at any time' }) {
  return locked ? (
    <LockClosedIcon
      className="h-4 w-4 text-red-500 inline-block ml-1.5 align-text-top"
      title={lockedReason}
    />
  ) : (
    <LockOpenIcon
      className="h-4 w-4 text-green-500 inline-block ml-1.5 align-text-top"
      title={editableReason}
    />
  )
}

// A named section heading inside the "Team Settings" tab, grouping
// related fields under one label -- Identity, Callsign Structure,
// Membership Policy, Description -- rather than the two arbitrary
// height-balanced columns this form used to be split into. Matches the
// small-caps section-heading treatment `EnrollmentView.jsx` already uses
// for its own "Enrollment Data"/"Device Enrollment Requirements"
// headings, so this modal's groupings read the same way that page's do.
function SectionHeading({ children }) {
  return (
    <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
      {children}
    </h4>
  )
}

const EMPTY_FORM_DATA = {
  name: '',
  description: '',
  callsignPrefix: '',
  color: 'Blue',
  visibility: 'public',
  canJoin: false,
  parentTeamId: null,
  callsignLevelSelection: [],
  // Default for a brand-new Organisation is "First Initial + Dot + Last
  // Name" (e.g. "J.Bloggs"), not "Full Name" -- an operator creating a new
  // Organisation gets the more space-efficient callsign format unless
  // they choose otherwise. An existing team being EDITED still shows its
  // own stored `callsign_name_format` value (see the edit-mode seeding
  // effect below), so this default only affects the create path.
  callsignNameFormat: 'first_initial_dot_last',
  // takserver-enrollment Requirement 6.1 (task 5.5): Organisation-only,
  // mirroring callsignLevelSelection's own EMPTY_FORM_DATA default --
  // false until an operator opts in at Organisation-creation time. Never
  // rendered or submitted for a Sub_Team.
  pseudonymousUsernames: false,
  // Foreign_Partner Organisation country prefix feature: '' is the
  // default -- no country selected, i.e. a domestic (New Zealand)
  // Organisation. Organisation-only, mirroring pseudonymousUsernames'
  // own default; never rendered or submitted for a Sub_Team
  // (buildTeamSubmitPayload drops it).
  countryCode: '',
  // Callsign Team-segment separator toggle: `false` is the default --
  // the pre-existing no-separator concatenation (e.g. Level 1 `NSW` +
  // Level 2 `SYD` -> `NSWSYD`), unchanged for every Organisation that
  // does not opt in. Organisation-only, mirroring countryCode's own
  // default; never rendered or submitted for a Sub_Team
  // (buildTeamSubmitPayload drops it).
  callsignTeamHyphenated: false
}

/**
 * Shared Create/Edit Team dialog, used identically by Teams.jsx (both
 * `mode="create"` and `mode="edit"`, via the pencil icon on the Orgs &
 * Teams list) and TeamDetail.jsx (`mode="edit"` only, via its own "Edit
 * Team" button). Bugfix: these two pages each used to have their own
 * independent copy of this dialog which had drifted apart (TeamDetail.jsx's
 * copy was missing the Callsign_Level_Selection toggles, the
 * `FieldLockIndicator`s, and two of the five `callsign_name_format`
 * options, and still had the removed "Callsign Sub-team Depth" field).
 * This component is now the single, authoritative implementation --
 * matching Teams.jsx's previous (more complete/up to date) version
 * exactly.
 *
 * Data fetching that's shared page-wide (the team list for the Parent
 * Team dropdown, `maxTeamDepth`, `colorMappings`) stays owned by each
 * parent page and is passed down as props, rather than being re-fetched
 * inside this component. Local form state (`formData`,
 * `callsignLevelOptions`, submitting state) is owned internally.
 *
 * ## Allowed Email Domains (`OrgDomainManager`), nested but independently saved
 *
 * When editing an EXISTING Organisation (`mode === 'edit'` and
 * `!team.parent_team_id`), this dialog also renders `OrgDomainManager`
 * beneath the main form -- moved here from its own standalone card on
 * `TeamDetail.jsx` so an admin edits a Team's/Organisation's settings and
 * its domain restriction in one place. This is a VISUAL nesting only:
 * `OrgDomainManager` keeps its own independent fetch
 * (`GET /orgs/:orgId/domains`) and its own independent whole-list-replace
 * save (`PUT /orgs/:orgId/domains`, via `orgDomainsAPI`), decoupled from
 * this dialog's own single `teamsAPI.update(...)` submit. Folding the two
 * into one save would mean either a second API call bolted onto
 * `doSubmit` (a partial-failure state where the team saves but the
 * domains don't, or vice versa) or a bigger, cross-cutting server change
 * to accept a domains array inside the team PATCH -- the domains table
 * (`org_allowed_domains`) is a genuinely separate resource from `teams`,
 * with its own list-replace save semantics, so keeping the two saves
 * separate is the more honest representation of what is actually
 * happening. Never rendered on create (there is no `orgId` yet) and never
 * for a Sub_Team (domain restrictions are Organisation-only, matching
 * `OrgDomainManager`'s own `isAdmin`-gated, Organisation-only design).
 *
 * @param {'create'|'edit'} mode
 * @param {object|null} team - the team being edited (null when creating).
 * @param {Array<object>} teams - candidate teams for the Parent Team
 *   dropdown (array of team objects shaped like `{ id, name,
 *   callsign_prefix, color, parent_team_id, ... }`).
 * @param {number|null} maxTeamDepth
 * @param {object} colorMappings
 * @param {boolean} isOpen
 * @param {() => void} onClose
 * @param {(updatedTeam: object) => void} onSaved - invoked with the
 *   server's response team after a successful create/update, so each
 *   parent page can apply its own local state update.
 * @param {boolean} [isAdmin] - passed straight through to the nested
 *   `OrgDomainManager` as ITS `isAdmin` prop (that component renders
 *   nothing at all when this is falsy). Defaults to `true` so
 *   `Teams.jsx`'s call site -- which only ever opens this dialog for a
 *   Global_Manager -- does not need to pass it explicitly.
 * @param {boolean} [isGlobalManager] - region-channel-tiers: gates the
 *   "Channel Access" tab (`ChannelAccessManager`), Global_Manager-only
 *   with NO Team_Admin fallback -- deliberately a SEPARATE prop from
 *   `isAdmin` above (which a Team_Admin also satisfies), since
 *   `PUT /api/teams/:teamId/channel-access` has no Team_Admin path at
 *   all. Defaults to `true` for the same reason `isAdmin` does:
 *   `Teams.jsx`'s call site only ever opens this dialog for a
 *   Global_Manager already.
 */
export default function TeamFormDialog({
  mode,
  team,
  teams,
  maxTeamDepth,
  colorMappings,
  isOpen,
  onClose,
  onSaved,
  isAdmin = true,
  isGlobalManager = true
}) {
  const [formData, setFormData] = useState(EMPTY_FORM_DATA)
  const [submitting, setSubmitting] = useState(false)
  const [showCanJoinConfirm, setShowCanJoinConfirm] = useState(false)
  // Bugfix (#13): "Allowed Email Domains" (OrgDomainManager) moves from a
  // nested section beneath the main form into its own TAB, alongside a
  // "Team Settings" tab holding the main form. Only rendered/consulted
  // when the domains tab itself would be shown at all -- edit mode, on an
  // Organisation (`editingTeam && !formData.parentTeamId`, the SAME gate
  // OrgDomainManager's nested section used) -- so a Sub_Team or a
  // brand-new team never sees a tab bar with only one working tab. Reset
  // to 'settings' whenever the dialog opens/the team being edited
  // changes (see the seeding effect below), so switching teams never
  // leaves a stale tab selected.
  const [activeFormTab, setActiveFormTab] = useState('settings')
  // Requirement 5.7-5.11 (task 32.4): the Callsign_Level_Selection
  // toggle-labelling lookup, grouped depth -> deduplicated/sorted
  // callsign_prefix values, sourced from
  // `teamsAPI.getCallsignLevelOptions(id)`. Only ever populated when
  // editing an EXISTING Organisation -- a brand-new Organisation has no
  // id to call that endpoint with, and has no Sub_Teams yet anyway, so
  // every toggle renders with no parenthetical (Requirement 5.11) via the
  // empty-Map default here.
  const [callsignLevelOptions, setCallsignLevelOptions] = useState(new Map())
  // Foreign_Partner Organisation country prefix feature: free-text filter
  // for the country picker's option list, the same "find a team by typing
  // its name" search affordance TransferMemberDialog/RequestAccess already
  // use for a long list. Local UI state only -- never submitted.
  const [countrySearch, setCountrySearch] = useState('')

  // Requirement 5.3: the Client-side default for a brand-new
  // Organisation's Callsign_Level_Selection is every Team_Depth position
  // 1..maxTeamDepth. Falls back to an empty array while maxTeamDepth
  // hasn't loaded yet, rather than guessing a value.
  const defaultCallsignLevelSelection = () =>
    maxTeamDepth ? Array.from({ length: maxTeamDepth }, (_, i) => i + 1) : []

  // Seeds `formData` (and, when editing an existing Organisation, kicks
  // off the callsign-level-options fetch) whenever the dialog opens or
  // the team being edited changes -- matching exactly what Teams.jsx's
  // pencil-icon `onClick` used to do inline before this was extracted.
  useEffect(() => {
    if (!isOpen) {
      return
    }

    if (mode === 'edit' && team) {
      setFormData({
        name: team.name,
        description: team.description || '',
        callsignPrefix: team.callsign_prefix || '',
        color: team.color || 'Blue',
        visibility: team.visibility || 'private',
        canJoin: team.can_join || false,
        parentTeamId: team.parent_team_id || null,
        callsignLevelSelection: team.parent_team_id
          ? []
          : (team.callsign_level_selection || defaultCallsignLevelSelection()),
        callsignNameFormat: team.callsign_name_format || 'full_name',
        // takserver-enrollment Requirement 6.2 (task 5.5): NULL on a
        // Sub_Team (never rendered there), the stored boolean on an
        // Organisation. Normalised with `Boolean(...)` since the server
        // may return `null`/`undefined` rather than `false`.
        pseudonymousUsernames: team.parent_team_id ? false : Boolean(team.pseudonymous_usernames),
        // Foreign_Partner Organisation country prefix feature: NULL on a
        // Sub_Team (never rendered there) or a domestic Organisation --
        // both normalise to '' (no country selected).
        countryCode: team.parent_team_id ? '' : (team.country_code || ''),
        // Callsign Team-segment separator toggle: NULL on a Sub_Team
        // (never rendered there), the stored boolean on an Organisation.
        // Normalised with `Boolean(...)` since the server may return
        // `null`/`undefined` rather than `false`.
        callsignTeamHyphenated: team.parent_team_id ? false : Boolean(team.callsign_team_hyphenated)
      })
      setCountrySearch('')

      // Requirement 5.8-5.11 (task 32.4): only fetch Sub_Team
      // callsign-prefix options when editing an EXISTING Organisation (no
      // parent_team_id) -- a Sub_Team never shows this control at all
      // (Requirement 5.6).
      if (!team.parent_team_id) {
        setCallsignLevelOptions(new Map())
        teamsAPI.getCallsignLevelOptions(team.id)
          .then((response) => {
            setCallsignLevelOptions(groupCallsignLevelOptionsByDepth(response.data.options))
          })
          .catch((error) => {
            console.error('Failed to fetch callsign level options:', error)
          })
      } else {
        setCallsignLevelOptions(new Map())
      }
    } else {
      setFormData({
        ...EMPTY_FORM_DATA,
        callsignLevelSelection: defaultCallsignLevelSelection()
      })
      setCallsignLevelOptions(new Map())
      setCountrySearch('')
    }

    // Bugfix (#13): always reopen on the Team Settings tab, regardless
    // of which team was being edited or which tab was active last time
    // the dialog was open -- a stale "Allowed Email Domains" selection
    // must never survive into a NEW team's dialog (or a create dialog,
    // where that tab does not even render).
    setActiveFormTab('settings')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mode, team])

  // Foreign_Partner Organisation country prefix feature: if the operator
  // has a country selected and then types a search that hides it, clear
  // the selection so the <select> never shows a blank-but-selected value
  // (a browser renders a selected <option> that isn't in the list as
  // empty) -- the exact same safety net TransferMemberDialog's own
  // destination-team search applies.
  useEffect(() => {
    if (!formData.countryCode) {
      return
    }
    const stillVisible = filterCountries(countrySearch).some((c) => c.alpha3 === formData.countryCode)
    if (!stillVisible) {
      setFormData((prev) => ({ ...prev, countryCode: '' }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countrySearch])

  if (!isOpen) {
    return null
  }

  const editingTeam = mode === 'edit' ? team : null
  const teamLabel = editingTeam ? labelFor(editingTeam) : labelForNew(formData.parentTeamId)

  // Bugfix (callsign-handling): the Prefix field is locked ONLY when
  // editing an EXISTING ORGANISATION (no parentTeamId) -- mirroring the
  // server's `Team.update` OrganisationCallsignPrefixImmutableError
  // guard exactly. A Sub_Team's prefix (parentTeamId present) stays
  // editable on both create AND edit; there was previously no supported
  // way to correct one after creation at all.
  const prefixLocked = !!editingTeam && !formData.parentTeamId

  // Foreign_Partner Organisation country prefix feature: locked under the
  // SAME condition as the Prefix field above -- mirroring the server's
  // `Team.update` `OrganisationCountryCodeImmutableError` guard exactly.
  // It is composed as the leading segment of the callsign prefix, so it
  // carries the identical "every identifier already minted under it"
  // immutability rationale.
  const countryLocked = !!editingTeam && !formData.parentTeamId

  const handleSubmit = async (e) => {
    e.preventDefault()

    // takserver-enrollment Requirement 2.1/2.2 (task 4.2): an Organisation
    // requires a non-empty callsignPrefix, on both create and edit -- caught
    // here as a submit-time gate (in addition to the `required` marker
    // below) since the prefix input is disabled on edit and a disabled
    // `required` field is not validated by the browser at all.
    if (isOrganisationCallsignPrefixMissing(formData.parentTeamId, formData.callsignPrefix)) {
      toast.error('Prefix is required for an Organisation')
      return
    }

    // Requirement 3.4 (signup-flow-rework): when editing an existing team
    // and can_join is being toggled from true to false, warn the user that
    // any active sign-up code will be permanently deleted by the server.
    if (editingTeam && editingTeam.can_join && !formData.canJoin && !showCanJoinConfirm) {
      setShowCanJoinConfirm(true)
      return
    }

    await doSubmit()
  }

  const doSubmit = async () => {
    setShowCanJoinConfirm(false)
    setSubmitting(true)
    try {
      const payload = buildTeamSubmitPayload(formData)
      const response = editingTeam
        ? await teamsAPI.update(editingTeam.id, payload)
        : await teamsAPI.create(payload)
      onSaved(response.data.team)
      onClose()
    } catch (error) {
      console.error(editingTeam ? 'Failed to update team:' : 'Failed to create team:', error)
      toast.error((editingTeam ? 'Failed to update team: ' : 'Failed to create team: ') + (error.response?.data?.error || error.message))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
      {/* Bugfix: fixed OUTER size (`h-[85vh]` at `sm:` and up, was a
          content-driven `max-h-[90vh]`) plus `flex flex-col` --
          switching tabs used to resize AND reposition this whole box,
          because each tab's panel (Team Settings/Allowed Email
          Domains/Channel Access) has wildly different content height,
          and `max-h` combined with `overflow-y-auto` on this SAME
          element let the box shrink to fit whichever panel was showing.
          With the box's own height now fixed and only the content strip
          below the tab bar scrolling internally (see the `flex-1
          overflow-y-auto` wrapper below), the header, tab bar and
          footer never move and the centered overlay never re-centers
          around a different box size.

          Bugfix (mobile full-screen): below `sm:`, this box is
          `h-full w-full` with no rounding -- a full-bleed sheet, not a
          floating card -- since the Team Settings tab alone (~10 form
          controls across 4 sections, each with an info tooltip) never
          fits a phone viewport regardless of how the box is sized; the
          real choice at that point is between scrolling inside a small
          floating box or scrolling inside one that uses the whole
          screen. `sm:` and up keeps the original floating-card
          treatment unchanged. */}
      <div className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-4xl sm:h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {editingTeam ? `Edit ${teamLabel}` : `Create New ${teamLabel}`}
          </h3>
          {/* Bugfix (mobile tap target too small): p-2 rounded-lg box
              around the icon, matching every other modal's close button
              in this app -- was a bare h-6 w-6 icon with no padding. */}
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        {/* Bugfix (#13): a tab bar, but ONLY when there is a second tab to
            show -- editing an existing Organisation. A Sub_Team and a
            brand-new team both render the form directly with no tab bar
            at all, matching how OrgDomainManager's OWN nested section was
            already gated (`editingTeam && !formData.parentTeamId`). */}
        {editingTeam && !formData.parentTeamId && (
          <div className="border-b border-gray-200 dark:border-gray-700 px-6 flex-shrink-0">
            <nav className="-mb-px flex space-x-8" role="tablist">
              <button
                type="button"
                onClick={() => setActiveFormTab('settings')}
                {...tabAria(activeFormTab, 'settings')}
                className={`py-3 px-1 border-b-2 font-medium text-sm ${
                  activeFormTab === 'settings'
                    ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                }`}
              >
                Team Settings
              </button>
              <button
                type="button"
                onClick={() => setActiveFormTab('domains')}
                {...tabAria(activeFormTab, 'domains')}
                className={`py-3 px-1 border-b-2 font-medium text-sm ${
                  activeFormTab === 'domains'
                    ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                }`}
              >
                Allowed Email Domains
              </button>
              {/* region-channel-tiers: Global_Manager-only -- a Team_Admin
                  who is not also a Global_Manager sees only the two tabs
                  above, exactly as before this feature. */}
              {isGlobalManager && (
                <button
                  type="button"
                  onClick={() => setActiveFormTab('channelAccess')}
                  {...tabAria(activeFormTab, 'channelAccess')}
                  className={`py-3 px-1 border-b-2 font-medium text-sm ${
                    activeFormTab === 'channelAccess'
                      ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                  }`}
                >
                  Channel Access
                </button>
              )}
            </nav>
          </div>
        )}

        {/* Bugfix: the scrolling region is now this single wrapper
            (`flex-1 overflow-y-auto`) around everything between the tab
            bar and the footer, rather than `overflow-y-auto` on the
            OUTER box itself. The outer box's height is fixed (see
            above), so only this strip grows/scrolls internally --
            header, tab bar and footer stay put on every tab. */}
        <div className="flex-1 overflow-y-auto">

        {/* Bugfix (#13): the main form stays mounted whenever there is no
            tab bar at all (a Sub_Team or a create dialog), and is HIDDEN
            (not unmounted) rather than conditionally rendered while the
            Allowed Email Domains tab is active -- an unsaved edit on this
            tab must survive switching to the other tab and back, and
            `<form>`'s own uncontrolled-input state (if any were ever
            added) would otherwise reset on remount. `hidden` is a plain
            CSS display:none toggle, so `handleSubmit` and every existing
            input ref/state stay exactly as they were. */}
        <div hidden={editingTeam && !formData.parentTeamId && activeFormTab !== 'settings'}>
        <form id="team-settings-form" onSubmit={handleSubmit} className="p-6 space-y-8">
          {/* Section 1: Identity -- what this team/organisation is and
              where it sits in the hierarchy. */}
          <div>
            <SectionHeading>Identity</SectionHeading>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Team Name *
                  <FieldLockIndicator
                    locked={false}
                    editableReason="Editable at any time, before or after creation"
                  />
                  <InfoTooltip text="The name shown throughout the app for this team. For a Sub-team, the parent's prefix or name is automatically prepended to form its full display name." />
                </label>
                <input
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({...formData, name: e.target.value})}
                  className="input w-full"
                  placeholder={formData.parentTeamId ? "Southland District" : "Enter team name"}
                />
                {formData.parentTeamId && formData.name && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Display name will be: <span className="font-medium">{teams.find(t => t.id === formData.parentTeamId)?.callsign_prefix || teams.find(t => t.id === formData.parentTeamId)?.name || 'Parent'} - {formData.name}</span>
                  </p>
                )}
              </div>

              {/* Foreign_Partner Organisation country prefix feature:
                  Organisation-only, mirroring pseudonymousUsernames'/
                  callsignLevelSelection's own "never rendered for a
                  Sub_Team" treatment elsewhere in this form -- not merely
                  disabled, absent entirely, since a Sub_Team can never
                  carry one. Placed immediately before Prefix: the country
                  is composed as the LEADING segment of the effective
                  callsign prefix (e.g. country FJI + prefix FIRE ->
                  FJI-FIRE), so it reads as "what comes before the
                  prefix". */}
              {!formData.parentTeamId && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Country
                    {/* Bugfix: this field is rendered ONLY inside the
                        Organisation-only `!formData.parentTeamId`
                        fragment (a Sub_Team never carries a country at
                        all), so "cannot be changed after creation" is a
                        FIXED fact about it whenever it exists on screen --
                        `locked` must be unconditionally `true`, matching
                        TAK Colour's own unconditional `locked={true}`
                        below, never keyed to `countryLocked` (which is
                        `false` while CREATING, the same drift that
                        previously showed pseudonymousUsernames' padlock as
                        green/open while creating a field that can never
                        change once the Organisation exists).
                        `countryLocked` itself is untouched -- it still
                        correctly governs whether THIS INPUT is currently
                        editable (free during creation, read-only once the
                        Organisation exists), a separate question from
                        what the padlock icon states. */}
                    <FieldLockIndicator
                      locked={true}
                      lockedReason="An Organisation's Country cannot be changed after creation: it is composed into the callsign prefix, so every device and user identifier already minted under it is derived from it"
                    />
                    <InfoTooltip text="Select a foreign partner nation to prefix every callsign minted under this Organisation with its ISO 3166-1 country code, e.g. FJI-FIRE-Joe Bloggs. Leave as Domestic (New Zealand) for the default, unprefixed callsign. Permanent once this Organisation is created." />
                  </label>
                  {countryLocked ? (
                    <div className="input w-full bg-gray-100 dark:bg-gray-600 text-gray-500 flex items-center">
                      {formData.countryCode && getCountry(formData.countryCode) ? (
                        <>
                          <span className={`fi fi-${getCountry(formData.countryCode).alpha2} mr-2`} aria-hidden="true"></span>
                          {getCountry(formData.countryCode).name} ({getCountry(formData.countryCode).alpha3})
                        </>
                      ) : (
                        'Domestic (New Zealand)'
                      )}
                    </div>
                  ) : (
                    <>
                      <input
                        type="text"
                        value={countrySearch}
                        onChange={(e) => setCountrySearch(e.target.value)}
                        autoComplete="off"
                        className="input w-full mb-2"
                        placeholder="Search countries by name or code"
                        aria-label="Search countries by name or code"
                        aria-controls="team-country-select"
                      />
                      <select
                        id="team-country-select"
                        value={formData.countryCode || ''}
                        onChange={(e) => setFormData({ ...formData, countryCode: e.target.value })}
                        className="input w-full"
                      >
                        <option value="">Domestic (New Zealand) -- no country prefix</option>
                        {filterCountries(countrySearch).map((country) => (
                          <option key={country.alpha3} value={country.alpha3}>
                            {country.name} ({country.alpha3})
                          </option>
                        ))}
                      </select>
                      {countrySearch.trim() !== '' && filterCountries(countrySearch).length === 0 && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          No country matches &ldquo;{countrySearch.trim()}&rdquo;.
                        </p>
                      )}
                      {formData.countryCode && getCountry(formData.countryCode) && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 flex items-center">
                          <span className={`fi fi-${getCountry(formData.countryCode).alpha2} mr-1.5`} aria-hidden="true"></span>
                          Callsigns will be prefixed {getCountry(formData.countryCode).alpha3}-{formData.callsignPrefix || '<prefix>'}-...
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Prefix{!formData.parentTeamId && ' *'}
                  {/* Bugfix: for an ORGANISATION (no parentTeamId), the
                      padlock must state the fixed fact that this field can
                      never be changed once the Organisation exists --
                      unconditionally `locked={true}`, matching Country's
                      own unconditional icon immediately above, never
                      keyed to `prefixLocked` (which is `false` while
                      CREATING, the drift that previously showed a green
                      open lock beside a field that can never change once
                      created). `prefixLocked` itself is untouched -- it
                      still correctly governs whether THIS INPUT is
                      currently editable, a separate question from what
                      the padlock states. A Sub_Team's Prefix genuinely can
                      be corrected at any time, so it keeps the
                      conditional (green-capable) icon. */}
                  <FieldLockIndicator
                    locked={formData.parentTeamId ? prefixLocked : true}
                    lockedReason="An Organisation's Prefix cannot be changed after creation: every device and user identifier already minted under it is derived from this value"
                    editableReason="A Sub-team's Prefix may be corrected at any time -- it participates only in Callsign generation, never in a device/user identifier"
                  />
                  <InfoTooltip text={formData.parentTeamId
                    ? 'The Sub-team segment of generated callsigns, e.g. FENZ-STL-Joe Bloggs. Optional; may be corrected later.'
                    : "The Organisation segment of every callsign minted under it, e.g. FENZ-Joe Bloggs. Required, and permanent once this Organisation is created -- every device and user identifier is derived from it."} />
                </label>
                <input
                  type="text"
                  value={formData.callsignPrefix}
                  onChange={prefixLocked ? undefined : (e) => setFormData({...formData, callsignPrefix: e.target.value})}
                  className={`input w-full ${prefixLocked ? 'bg-gray-100 dark:bg-gray-600 text-gray-500' : ''}`}
                  disabled={prefixLocked}
                  // takserver-enrollment Requirement 2.1/2.2 (task 4.2):
                  // required WHEN this dialog represents an Organisation
                  // (no parentTeamId) -- an Organisation cannot mint a
                  // Managed_Identifier without a prefix. Left optional for
                  // a Sub_Team, exactly as today (Criterion 2.3). A
                  // disabled required field is not validated by the
                  // browser at all, which is why doSubmit's own check
                  // above is the real gate whenever the field is locked;
                  // this attribute is the "stated as text rather than
                  // discovered on submit" half of the requirement for the
                  // CREATE form and for a Sub_Team edit, where the field
                  // is not disabled.
                  required={!formData.parentTeamId}
                  pattern={CALLSIGN_PREFIX_PATTERN}
                  title="Letters and digits, optionally split into segments with a single hyphen (e.g. AUS-FIRE)"
                  placeholder={formData.parentTeamId ? "STL, CHC, etc." : "FENZ, DOC, etc."}
                />
                {!isValidCallsignPrefixInput(formData.callsignPrefix) && (
                  <p className="text-red-600 text-sm mt-1">Prefix may only contain letters and digits (no "-")</p>
                )}
                {isValidCallsignPrefixInput(formData.callsignPrefix) &&
                 isOrganisationCallsignPrefixMissing(formData.parentTeamId, formData.callsignPrefix) && (
                  <p className="text-red-600 text-sm mt-1">Prefix is required for an Organisation</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Parent Team
                  <FieldLockIndicator
                    locked={false}
                    editableReason="Editable at any time, before or after creation"
                  />
                  {/* Bugfix: this field sits in the RIGHT-hand column of
                      the Identity grid, close to the modal's own right
                      edge -- opening rightward (the default) pushed the
                      tooltip's w-64 popup past that edge, which the
                      dialog's overflow-y-auto-only wrapper turned into a
                      persistent horizontal scrollbar (leaving overflow-x
                      at its default `visible` while overflow-y is
                      non-visible computes to `overflow-x: auto`).
                      `side="left"` follows the client convention: "open
                      leftward from trailing columns, rightward
                      elsewhere". */}
                  <InfoTooltip text="Select a parent team to make this a Sub-team, or leave empty to make it a top-level Organisation." side="left" />
                </label>
                <select
                  value={formData.parentTeamId || ''}
                  onChange={(e) => {
                    const parentId = e.target.value ? parseInt(e.target.value) : null
                    const parentTeam = parentId ? teams.find(t => t.id === parentId) : null
                    setFormData({
                      ...formData,
                      parentTeamId: parentId,
                      color: parentTeam ? parentTeam.color : formData.color,
                      // Requirement 5.6: Callsign_Level_Selection is
                      // Organisation-only -- switching to a Sub_Team
                      // (a parent selected) clears it; switching back
                      // to no parent restores the default selection.
                      callsignLevelSelection: parentId ? [] : defaultCallsignLevelSelection(),
                      // takserver-enrollment Requirement 6.2 (task 5.5):
                      // Pseudonymous_Username_Policy is Organisation-only
                      // in exactly the same way -- switching to a
                      // Sub_Team resets it to false so it is never
                      // submitted for one.
                      pseudonymousUsernames: parentId ? false : formData.pseudonymousUsernames
                    })
                    if (parentId) {
                      setCallsignLevelOptions(new Map())
                    }
                  }}
                  className="input w-full"
                >
                  <option value="">No parent (Top-level team)</option>
                  {parentTeamCandidates(teams, editingTeam, isGlobalManager).map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Section 2: Callsign Structure -- everything that feeds
              callsign generation for this team's hierarchy, grouped
              together rather than split across the old two-column
              layout. Callsign Level Selection is Organisation-only. */}
          <div>
            <SectionHeading>Callsign Structure</SectionHeading>
            <div className="space-y-6">
              {!formData.parentTeamId && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Callsign Level Selection
                    <FieldLockIndicator
                      locked={false}
                      editableReason="Editable at any time, before or after creation"
                    />
                    <InfoTooltip text="Which Team-Depth levels are included in generated callsigns across this Organisation's whole hierarchy." />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {Array.from({ length: maxTeamDepth || 0 }, (_, i) => i + 1).map((depth) => {
                      const selected = formData.callsignLevelSelection.includes(depth)
                      const prefixesForDepth = callsignLevelOptions.get(depth) || []
                      return (
                        <button
                          key={depth}
                          type="button"
                          onClick={() => {
                            const newSelection = selected
                              ? formData.callsignLevelSelection.filter(d => d !== depth)
                              : [...formData.callsignLevelSelection, depth]
                            setFormData({ ...formData, callsignLevelSelection: newSelection })
                          }}
                          // Bugfix (mobile tap target too small): py-2.5
                          // (was py-1) -- text-xs's 16px line-height plus
                          // the old 8px vertical padding gave a ~24px-tall
                          // pill; py-2.5 (20px) brings it to a real ~36px
                          // tap target while keeping the compact px-3
                          // horizontal padding these need to fit several
                          // pills per row.
                          className={`inline-flex items-center gap-1 px-3 py-2.5 text-xs font-medium rounded-full border transition-colors ${
                            selected
                              ? 'bg-primary-100 text-primary-800 border-primary-300 dark:bg-primary-900 dark:text-primary-200'
                              : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50 dark:bg-gray-600 dark:text-gray-300 dark:border-gray-500 dark:hover:bg-gray-500'
                          }`}
                        >
                          {selected && <CheckIcon className="h-3 w-3" aria-hidden="true" />}
                          {formatLevelLabel(depth, prefixesForDepth)}
                        </button>
                      )
                    })}
                  </div>
                  {formData.callsignLevelSelection.length > 0 && formData.callsignLevelSelection.length < (maxTeamDepth || 5) && (
                    <p className="text-xs text-gray-600 dark:text-gray-300 mt-1">
                      Currently selected: {formData.callsignLevelSelection.slice().sort((a, b) => a - b).map(d => `Level ${d}`).join(', ')}
                    </p>
                  )}
                </div>
              )}

              {/* Callsign Team-segment separator toggle: Organisation-only
                  (rendered only inside this same `!formData.parentTeamId`
                  fragment, never for a Sub_Team), controlling how the
                  Team segment above (the concatenation of every selected
                  level's callsign_prefix) is JOINED -- with no separator
                  (the default, e.g. `NSWSYD`) or with a hyphen between
                  each PRESENT level (e.g. `NSW-SYD`, never a doubled `-`
                  when an intermediate level is unselected or absent).
                  Freely editable at any time, unlike Country/Prefix --
                  it only changes how the callsign is DISPLAYED, never a
                  Managed_Identifier already minted. Whole-row <label>
                  for a real mobile tap target, matching the
                  "Allow join requests"/pseudonymousUsernames checkbox
                  rows' own convention. */}
              {!formData.parentTeamId && (
                <div>
                  <label
                    htmlFor="callsignTeamHyphenated"
                    className="flex items-start -m-2 p-2 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  >
                    <input
                      type="checkbox"
                      id="callsignTeamHyphenated"
                      checked={formData.callsignTeamHyphenated}
                      onChange={(e) => setFormData({ ...formData, callsignTeamHyphenated: e.target.checked })}
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded mt-1"
                    />
                    <span className="ml-3 text-sm font-medium text-gray-700 dark:text-gray-300">
                      Hyphenate Team-Depth levels in generated callsigns
                      <span onClick={(e) => e.stopPropagation()} className="inline-flex">
                        <FieldLockIndicator
                          locked={false}
                          editableReason="Editable at any time, before or after creation"
                        />
                        <InfoTooltip text={`Joins each selected Team-Depth level with a hyphen (e.g. NSW-SYD) instead of the default no-separator concatenation (e.g. NSWSYD). Only changes how the callsign is displayed -- never a device or user identifier already minted.`} />
                      </span>
                    </span>
                  </label>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Callsign Name Format
                    <FieldLockIndicator
                      locked={!!formData.parentTeamId}
                      lockedReason="Sub-teams always inherit callsign name format from their parent team"
                    />
                    <InfoTooltip text="How each member's name appears in the Name segment of their generated callsign. Sub-teams always inherit this from their Organisation." />
                  </label>
                  <select
                    value={formData.callsignNameFormat}
                    onChange={formData.parentTeamId ? undefined : (e) => setFormData({...formData, callsignNameFormat: e.target.value})}
                    className={`input w-full ${formData.parentTeamId ? 'bg-gray-100 dark:bg-gray-600 text-gray-500' : ''}`}
                    disabled={!!formData.parentTeamId}
                  >
                    <option value="full_name">Full Name (Joe Bloggs)</option>
                    <option value="first_initial_last">First Initial + Last Name (J Bloggs)</option>
                    <option value="first_last_initial">First Name + Last Initial (Joe B)</option>
                    <option value="first_initial_dot_last">First Initial + Dot + Last Name (J.Bloggs)</option>
                    <option value="user_defined">User Defined (Custom per-member suffix)</option>
                  </select>
                  {!formData.parentTeamId && formData.callsignNameFormat === 'user_defined' && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                      New members will require a manually entered suffix
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    TAK Colour
                    <FieldLockIndicator
                      locked={true}
                      lockedReason={formData.parentTeamId ? 'Sub-teams always inherit TAK colour from their parent team' : 'Cannot be changed after the team is created'}
                    />
                    {/* Bugfix: right-hand column of the Callsign
                        Structure grid -- same right-edge overflow as
                        Parent Team above. */}
                    <InfoTooltip text="The TAK colour designation for this team's members. Sub-teams always inherit this from their Organisation, and it cannot be changed once a team is created." side="left" />
                  </label>
                  <select
                    value={formData.color}
                    onChange={editingTeam || formData.parentTeamId ? undefined : (e) => setFormData({...formData, color: e.target.value})}
                    className={`input w-full ${editingTeam || formData.parentTeamId ? 'bg-gray-100 dark:bg-gray-600 text-gray-500' : ''}`}
                    disabled={!!(editingTeam || formData.parentTeamId)}
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
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Membership Policy -- who can join, how they're
              identified, and how visible this team is. Pseudonymous
              Usernames moved here (from its old home beside Callsign
              Level Selection) since it governs identity/membership, not
              callsign structure. */}
          <div>
            <SectionHeading>Membership Policy</SectionHeading>
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Visibility
                    <FieldLockIndicator
                      locked={false}
                      editableReason="Editable at any time, before or after creation"
                    />
                    <InfoTooltip text="Public teams are visible to all users browsing Orgs & Teams. Private teams are visible only to their own members and admins." />
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

                {/* Bugfix (mobile tap target too small): the outer
                    element is now the `<label>` itself (was a plain
                    `<div>` containing a separate `<label>` beside the
                    checkbox) -- clicking ANYWHERE in this padded row,
                    not just the bare 16px checkbox square or the label
                    text's own bounds, now toggles the field. `-m-2 p-2`
                    keeps the row's visible size/alignment unchanged
                    (same technique InfoTooltip.jsx/OrgDomainManager.jsx
                    use) while growing the actual clickable area. */}
                <label htmlFor="canJoin" className="flex items-start pt-8 -m-2 p-2 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <input
                    type="checkbox"
                    id="canJoin"
                    checked={formData.canJoin}
                    onChange={(e) => setFormData({...formData, canJoin: e.target.checked})}
                    className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded mt-1"
                  />
                  <div className="ml-3">
                    <span className="text-sm text-gray-700 dark:text-gray-300 font-medium">
                      Allow join requests
                      {/* Bugfix: since the whole row is now a <label>
                          (see above), a tap anywhere in it -- including
                          on these two disclosure-only icons -- would
                          otherwise ALSO toggle the checkbox (a bare
                          `<span>` is not "labelable content" the browser
                          excludes from a label's click-forwarding).
                          `stopPropagation` keeps the icons' own hover/
                          focus tooltips working while preventing an
                          accidental toggle. */}
                      <span onClick={(e) => e.stopPropagation()} className="inline-flex">
                        <FieldLockIndicator
                          locked={false}
                          editableReason="Editable at any time, before or after creation"
                        />
                        {/* Bugfix: right-hand column of the Membership
                            Policy grid -- same right-edge overflow as
                            Parent Team/TAK Colour above. */}
                        <InfoTooltip text="Lets users request to join this team through the public interface. Disabling this after a sign-up code was issued permanently deletes that code." side="left" />
                      </span>
                    </span>
                  </div>
                </label>
              </div>

              {/*
                takserver-enrollment Requirement 6.1/6.2/7.1/7.2/9.7
                (task 5.5): the Pseudonymous_Username_Policy control.
                Organisation-only, rendered only inside this same
                `!formData.parentTeamId` fragment, never for a Sub_Team.

                The INPUT is disabled only when editing an EXISTING
                Organisation (`disabled={!!editingTeam}` below) -- it
                stays freely editable while the Organisation is still
                being created. The FieldLockIndicator is a SEPARATE
                question from that: `locked` states whether the field
                can EVER be changed once the Organisation exists, which
                is a fixed fact about this field independent of which
                mode the dialog is currently in -- so it passes
                `locked={true}` unconditionally rather than keying it to
                `editingTeam` (bugfix: it previously passed
                `locked={!!editingTeam}`, which showed a GREEN OPEN lock
                while creating, directly contradicting the "cannot be
                changed" fact this field carries).

                Requirement 8.2/8.3 (task 5.5, since amended): the
                Pseudonymity_Scope tooltip text below must NOT describe
                the policy as "anonymity" and must NOT claim TAK Team
                Manager holds no personally identifying information --
                it still stores every member's first name, last name and
                email, so an operator can always re-identify a member
                from that record. The pseudonymity is against TAK Server
                and other TAK users only. This is stated in the tooltip
                text (still real text, disclosed on hover/focus) rather
                than as a standalone paragraph, matching every other
                field's explanatory treatment in this modal now.
              */}
              <div>
                {/* Bugfix (mobile tap target too small): the outer
                    element is now the `<label>` itself (was a plain
                    `<div>` with the checkbox and a separate `<label>`
                    as siblings) -- same `-m-2 p-2` enlarged-hit-box
                    technique as the "Allow join requests" checkbox
                    above. A disabled checkbox (editing an existing
                    Organisation) still renders `cursor-not-allowed`
                    rather than `cursor-pointer`, and clicking the label
                    is a no-op for a disabled control, matching native
                    behaviour. */}
                <label
                  htmlFor="pseudonymousUsernames"
                  className={`flex items-start -m-2 p-2 rounded-lg ${editingTeam ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}
                >
                  <input
                    type="checkbox"
                    id="pseudonymousUsernames"
                    checked={formData.pseudonymousUsernames}
                    disabled={!!editingTeam}
                    onChange={(e) => setFormData({ ...formData, pseudonymousUsernames: e.target.checked })}
                    className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded mt-1 disabled:opacity-50"
                  />
                  <span className="ml-3 text-sm font-medium text-gray-700 dark:text-gray-300">
                    {/* Bugfix (tooltip see-through): `opacity-50` used to
                        sit on this whole <span>, ancestor of the
                        InfoTooltip's popup below -- CSS opacity compounds
                        through descendants, so the popup's own
                        `opacity-100` on disclosure was really rendering
                        at 50% (0.5 * 1.0), letting the "Allow join
                        requests" row behind it show through, unlike
                        every other InfoTooltip on this page (none of
                        which sit inside an opacity-reduced ancestor).
                        The disabled-look dimming now applies to ONLY the
                        label text span below, leaving the icon/tooltip
                        span at full, unreduced opacity so its disclosed
                        popup is solid like the others -- appropriate
                        anyway, since the padlock icon states a fixed
                        fact ("cannot be changed") that doesn't itself
                        become less true while editing. */}
                    <span className={editingTeam ? 'opacity-50' : ''}>
                      Give new members usernames that carry no personal information
                    </span>
                    {/* Bugfix: same click.stopPropagation() reasoning as
                        the "Allow join requests" checkbox above -- these
                        two disclosure-only icons must not toggle the
                        checkbox when tapped. */}
                    <span onClick={(e) => e.stopPropagation()} className="inline-flex">
                      <FieldLockIndicator
                        locked={true}
                        lockedReason="Cannot be changed after the Organisation is created: switching this policy would require every existing member's username to change, invalidating every certificate Common Name and every device record in the Organisation, and forcing every device to re-enroll"
                      />
                      <InfoTooltip text={<>Each new member's TAK username (and certificate name) becomes a random identifier instead of one derived from their email or name. This is <strong>not anonymity</strong>: TAK Team Manager still stores the member's first name, last name and email address, so an operator can always re-identify them from that record. The protection is only against TAK Server and other TAK users seeing who a member is. This cannot be changed once the Organisation is created.</>} />
                    </span>
                  </span>
                </label>
              </div>
            </div>
          </div>

          {/* Section 4: Description -- free text, standalone since it
              doesn't fit a policy group. */}
          <div>
            <SectionHeading>Description</SectionHeading>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Description
                <FieldLockIndicator
                  locked={false}
                  editableReason="Editable at any time, before or after creation"
                />
                <InfoTooltip text="A short description of this team's purpose, shown to admins and to prospective members considering a join request." />
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({...formData, description: e.target.value})}
                className="input w-full"
                rows={4}
                placeholder="Enter team description and purpose"
              />
            </div>
          </div>

        </form>
        </div>

        {/* Bugfix (#13): "Allowed Email Domains" (OrgDomainManager), now
            its own tab rather than a nested section beneath the main
            form -- see this component's own doc comment for why it keeps
            its own independent fetch/save, decoupled from the form
            above. Organisation-only (no parentTeamId) and edit-only (an
            Organisation must already exist to have an `id` this can
            fetch/save against) -- the SAME gate that shows the tab bar
            itself, so this is never reachable without a way to navigate
            to it. */}
        {editingTeam && !formData.parentTeamId && activeFormTab === 'domains' && (
          <div className="px-6 pb-6 pt-6">
            <OrgDomainManager orgId={editingTeam.id} isAdmin={isAdmin} />
          </div>
        )}

        {/* region-channel-tiers: Channel Access tab, Global_Manager-only
            (same gate as the tab button itself, plus ChannelAccessManager's
            own isGlobalManager no-op as defense in depth). `org={editingTeam}`
            passes the CURRENTLY STORED team row -- not `formData`, which
            only ever carries the main form's fields -- so this reads the
            Organisation's actual response_channel_access/
            support_channel_access straight from the same object the page's
            list already has, no extra fetch needed. */}
        {editingTeam && !formData.parentTeamId && isGlobalManager && activeFormTab === 'channelAccess' && (
          <div className="px-6 pb-6 pt-6">
            <ChannelAccessManager
              org={editingTeam}
              isGlobalManager={isGlobalManager}
              onSaved={onSaved}
            />
          </div>
        )}

        </div>
        {/* End of the scrolling region (`flex-1 overflow-y-auto`) opened
            above the main form -- the footer below stays OUTSIDE it,
            fixed at the bottom of the dialog on every tab. */}

        {/* Bugfix: Cancel/Update footer, moved OUTSIDE the `hidden`
            main-form `<div>` so it is visible on every tab, not just
            "Team Settings" -- it previously lived inside the `<form>`
            itself, so switching to "Allowed Email Domains" or "Channel
            Access" hid the only way to close or save the dialog at all.
            The submit button now targets the main form by id
            (`form="team-settings-form"`) rather than relying on
            `type="submit"` inside that form's own tree, since it no
            longer lives inside it; the form itself is still mounted (only
            visually hidden via `hidden`), so this still runs the SAME
            `handleSubmit` -- including the can-join confirmation gate --
            regardless of which tab is showing. Allowed Email Domains and
            Channel Access each keep their own independent Save button
            (OrgDomainManager/ChannelAccessManager's own `dirty`-gated
            buttons) for their own separately-saved resource; this footer
            only ever submits the Team Settings form. */}
        <div className="flex justify-end space-x-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary px-6 py-2"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="team-settings-form"
            disabled={submitting}
            className="btn-primary px-6 py-2"
          >
            {(() => {
              if (submitting) {
                return editingTeam ? `Updating ${teamLabel}...` : `Creating ${teamLabel}...`
              }
              return editingTeam ? `Update ${teamLabel}` : `Create ${teamLabel}`
            })()}
          </button>
        </div>

        {/* Disable join requests confirmation modal */}
        {showCanJoinConfirm && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[60]">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="disable-join-requests-title"
              className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full p-6"
            >
              <h3 id="disable-join-requests-title" className="text-lg font-medium text-amber-600 dark:text-amber-400 mb-2">
                Disable Join Requests?
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                This team has an active sign-up code. Disabling join requests will permanently delete the code and invalidate all distributed links and QR codes.
              </p>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setShowCanJoinConfirm(false)}
                  className="btn-secondary px-4 py-2 text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={doSubmit}
                  className="px-4 py-2 bg-amber-600 text-white rounded-md hover:bg-amber-700 text-sm"
                >
                  Confirm & Save
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
