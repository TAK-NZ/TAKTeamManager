import { useState, useEffect } from 'react'
import { XMarkIcon, LockClosedIcon, LockOpenIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { teamsAPI } from '../services/api'
import { labelFor, labelForNew } from '../utils/teamLabels'
import { formatLevelLabel, groupCallsignLevelOptionsByDepth } from '../utils/callsignLevels'

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
const CALLSIGN_PREFIX_PATTERN = '[A-Za-z0-9]*'
const CALLSIGN_PREFIX_REGEX = /^[A-Za-z0-9]*$/

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

const EMPTY_FORM_DATA = {
  name: '',
  description: '',
  callsignPrefix: '',
  color: 'Blue',
  visibility: 'public',
  canJoin: false,
  parentTeamId: null,
  callsignLevelSelection: [],
  callsignNameFormat: 'full_name',
  // takserver-enrollment Requirement 6.1 (task 5.5): Organisation-only,
  // mirroring callsignLevelSelection's own EMPTY_FORM_DATA default --
  // false until an operator opts in at Organisation-creation time. Never
  // rendered or submitted for a Sub_Team.
  pseudonymousUsernames: false
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
 */
export default function TeamFormDialog({
  mode,
  team,
  teams,
  maxTeamDepth,
  colorMappings,
  isOpen,
  onClose,
  onSaved
}) {
  const [formData, setFormData] = useState(EMPTY_FORM_DATA)
  const [submitting, setSubmitting] = useState(false)
  const [showCanJoinConfirm, setShowCanJoinConfirm] = useState(false)
  // Requirement 5.7-5.11 (task 32.4): the Callsign_Level_Selection
  // toggle-labelling lookup, grouped depth -> deduplicated/sorted
  // callsign_prefix values, sourced from
  // `teamsAPI.getCallsignLevelOptions(id)`. Only ever populated when
  // editing an EXISTING Organisation -- a brand-new Organisation has no
  // id to call that endpoint with, and has no Sub_Teams yet anyway, so
  // every toggle renders with no parenthetical (Requirement 5.11) via the
  // empty-Map default here.
  const [callsignLevelOptions, setCallsignLevelOptions] = useState(new Map())

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
        pseudonymousUsernames: team.parent_team_id ? false : Boolean(team.pseudonymous_usernames)
      })

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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mode, team])

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
      const response = editingTeam
        ? await teamsAPI.update(editingTeam.id, formData)
        : await teamsAPI.create(formData)
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
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {editingTeam ? `Edit ${teamLabel}` : `Create New ${teamLabel}`}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Team Name *
                  <FieldLockIndicator
                    locked={false}
                    editableReason="Editable at any time, before or after creation"
                  />
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

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Prefix{!formData.parentTeamId && ' *'}
                  <FieldLockIndicator
                    locked={prefixLocked}
                    lockedReason="An Organisation's Prefix cannot be changed after creation: every device and user identifier already minted under it is derived from this value"
                    editableReason="A Sub-team's Prefix may be corrected at any time -- it participates only in Callsign generation, never in a device/user identifier"
                  />
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
                  title="Only letters and digits are allowed (no -)"
                  placeholder={formData.parentTeamId ? "STL, CHC, etc." : "FENZ, DOC, etc."}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {prefixLocked ? "An Organisation's Prefix cannot be changed after creation" :
                   formData.parentTeamId ? 'Sub-team prefix for callsigns. Example: FENZ-STL-John Smith' :
                   'Required for an Organisation. Team prefix for callsigns. Example: FENZ-John Smith'}
                </p>
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
                  {teams.filter(t => t.id !== (editingTeam ? editingTeam.id : undefined)).map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Select a parent team to create a sub-team, or leave empty for a top-level team.
                </p>
              </div>

              {!formData.parentTeamId && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Callsign Level Selection
                      <FieldLockIndicator
                        locked={false}
                        editableReason="Editable at any time, before or after creation"
                      />
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
                            className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                              selected
                                ? 'bg-primary-100 text-primary-800 border-primary-300 dark:bg-primary-900 dark:text-primary-200'
                                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50 dark:bg-gray-600 dark:text-gray-300 dark:border-gray-500 dark:hover:bg-gray-500'
                            }`}
                          >
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
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      Which Team-Depth levels to include in generated callsigns for this Organisation's hierarchy.
                    </p>
                  </div>

                  {/*
                    takserver-enrollment Requirement 6.1/6.2/7.1/7.2/9.7
                    (task 5.5): the Pseudonymous_Username_Policy control.
                    Organisation-only, mirroring the Callsign Level
                    Selection block above -- rendered only inside this
                    same `!formData.parentTeamId` fragment, never for a
                    Sub_Team.

                    The INPUT is disabled only when editing an EXISTING
                    Organisation (`disabled={!!editingTeam}` below) -- it
                    stays freely editable while the Organisation is still
                    being created. The FieldLockIndicator is a SEPARATE
                    question from that: `locked` states whether the field
                    can EVER be changed once the Organisation exists, which
                    is a fixed fact about this field independent of which
                    mode the dialog is currently in. That is why Prefix and
                    TAK Color both pass `locked={true}` unconditionally
                    (see their own FieldLockIndicators above) rather than
                    keying it to `editingTeam` -- and this control follows
                    the same convention. Bugfix: it previously passed
                    `locked={!!editingTeam}`, which showed a GREEN OPEN
                    lock while creating, directly contradicting the "This
                    cannot be changed once the Organisation is created"
                    text rendered a few lines below it.
                  */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Pseudonymous Usernames
                      <FieldLockIndicator
                        locked={true}
                        lockedReason="Cannot be changed after the Organisation is created: switching this policy would require every existing member's username to change, invalidating every certificate Common Name and every device record in the Organisation, and forcing every device to re-enroll"
                      />
                    </label>
                    <div className="flex items-start">
                      <input
                        type="checkbox"
                        id="pseudonymousUsernames"
                        checked={formData.pseudonymousUsernames}
                        disabled={!!editingTeam}
                        onChange={(e) => setFormData({ ...formData, pseudonymousUsernames: e.target.checked })}
                        className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded mt-1 disabled:opacity-50"
                      />
                      <label
                        htmlFor="pseudonymousUsernames"
                        className={`ml-3 text-sm font-medium text-gray-700 dark:text-gray-300 ${editingTeam ? 'opacity-50' : ''}`}
                      >
                        Give new members usernames that carry no personal information
                      </label>
                    </div>
                    {/*
                      Requirement 8.2/8.3 (task 5.5, since amended): the
                      Pseudonymity_Scope statement, in TEXT (never colour
                      alone). Must NOT describe the policy as "anonymity"
                      and must NOT claim TAK Team Manager holds no
                      personally identifying information -- it still
                      stores every member's first name, last name and
                      email, and an operator can always re-identify a
                      member from that record. The pseudonymity is
                      against TAK Server and other TAK users only.

                      The CloudTAK/WebTAK caveat this paragraph used to
                      carry (Criterion 16.4 in the original
                      takserver-enrollment spec: that connection path
                      built the certificate Common Name/clientUid and the
                      CoT uid from the member's EMAIL rather than their
                      username, defeating the pseudonymity entirely for a
                      CloudTAK/WebTAK member) is REMOVED -- that defeat has
                      since been fixed upstream in the CloudTAK fork
                      (`api/stateless/lib/authentik-provider.ts`,
                      `api/common/connection-config.ts`), which now builds
                      all three of those from the Authentik username, same
                      as every other connection path. A pseudonymous
                      member's CloudTAK/WebTAK session is pseudonymised
                      exactly like their native ATAK/iTAK/WinTAK one.
                    */}
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      When enabled, each new member's TAK username (and therefore their certificate name) is a random identifier instead of one derived from their email or name. This is <strong>not anonymity</strong>: TAK Team Manager still stores the member's first name, last name and email address, so an operator can always re-identify them from that record. The protection is only against TAK Server and other TAK users seeing who a member is.
                    </p>
                    {!editingTeam && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        This cannot be changed once the Organisation is created.
                      </p>
                    )}
                  </div>
                </>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Callsign Name Format
                  <FieldLockIndicator
                    locked={!!formData.parentTeamId}
                    lockedReason="Sub-teams always inherit callsign name format from their parent team"
                  />
                </label>
                <select
                  value={formData.callsignNameFormat}
                  onChange={formData.parentTeamId ? undefined : (e) => setFormData({...formData, callsignNameFormat: e.target.value})}
                  className={`input w-full ${formData.parentTeamId ? 'bg-gray-100 dark:bg-gray-600 text-gray-500' : ''}`}
                  disabled={!!formData.parentTeamId}
                >
                  <option value="full_name">Full Name (John Doe)</option>
                  <option value="first_initial_last">First Initial + Last Name (J Doe)</option>
                  <option value="first_last_initial">First Name + Last Initial (John D)</option>
                  <option value="first_initial_dot_last">First Initial + Dot + Last Name (J.Doe)</option>
                  <option value="user_defined">User Defined (Custom per-member suffix)</option>
                </select>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {formData.parentTeamId ? 'Sub-teams inherit callsign name format from parent team' :
                   'How user names will appear in callsigns for this team hierarchy.'}
                </p>
                {!formData.parentTeamId && formData.callsignNameFormat === 'user_defined' && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    New members will require a manually entered suffix
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  TAK Color
                  <FieldLockIndicator
                    locked={true}
                    lockedReason={formData.parentTeamId ? 'Sub-teams always inherit TAK color from their parent team' : 'Cannot be changed after the team is created'}
                  />
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
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {editingTeam ? 'TAK color cannot be changed after team creation' :
                   formData.parentTeamId ? 'Sub-teams inherit TAK color from parent team' :
                   'TAK color designation for team members.'}
                </p>
              </div>
            </div>

            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Description
                  <FieldLockIndicator
                    locked={false}
                    editableReason="Editable at any time, before or after creation"
                  />
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
                  <FieldLockIndicator
                    locked={false}
                    editableReason="Editable at any time, before or after creation"
                  />
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
                  <FieldLockIndicator
                    locked={false}
                    editableReason="Editable at any time, before or after creation"
                  />
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
              onClick={onClose}
              className="btn-secondary px-6 py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
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
        </form>

        {/* Disable join requests confirmation modal */}
        {showCanJoinConfirm && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[60]">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full p-6">
              <h4 className="text-lg font-medium text-amber-600 dark:text-amber-400 mb-2">
                Disable Join Requests?
              </h4>
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
