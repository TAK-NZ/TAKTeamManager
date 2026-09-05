import { useState } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { devicesAPI, usersAPI } from '../services/api'
import { assembleCallsignPreview, resolveCallsignSegments } from '../utils/callsignAssembly'

/**
 * Mirrors `TeamDetail.jsx`'s own `CALLSIGN_SUFFIX_PATTERN`/
 * `CALLSIGN_SUFFIX_REGEX` (letters, digits, `-`, `.`), which itself
 * mirrors `server/utils/callsignValidation.js`'s `isValidCallsignSuffix`
 * character class -- a device's Name segment is validated identically to
 * a human member's.
 */
const CALLSIGN_SUFFIX_PATTERN = '[A-Za-z0-9.-]*'
const CALLSIGN_SUFFIX_REGEX = /^[A-Za-z0-9.-]*$/

/**
 * Pure validator for this dialog's Callsign Suffix input's CHARACTER
 * CLASS only. Note this dialog's Callsign Suffix field is itself
 * REQUIRED (bug #6: "It is definitely not optional") -- the presence
 * check is separate, enforced by `isCallsignSuffixMissing` below and by
 * the `required` attribute on the input. An empty value is accepted HERE
 * because the character-class check and the presence check are
 * deliberately independent, matching `isOrganisationCallsignPrefixMissing`/
 * `isValidCallsignPrefixInput`'s own non-overlapping convention in
 * `TeamFormDialog.jsx`.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidDeviceCallsignSuffix(value) {
  if (!value) {
    return true
  }
  return CALLSIGN_SUFFIX_REGEX.test(value)
}

/**
 * Bug #6: a Team_Owned_Device's Callsign Suffix is REQUIRED, not
 * optional -- a device with no Name segment produces a callsign
 * indistinguishable from its Organisation/Team prefix alone, which
 * defeats the point of the callsign identifying a specific device. A
 * whitespace-only value counts as missing, matching every other
 * presence check in this codebase (`isOrganisationCallsignPrefixMissing`).
 *
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export function isCallsignSuffixMissing(value) {
  return !(typeof value === 'string' ? value.trim() : value)
}

/**
 * Extracts an inline Callsign Suffix error message from a rejected
 * `devicesAPI.create` call, or `null` when the failure is not a shaped
 * 400. The server returns `{ error: <message> }` with status 400 for a
 * per-team collision (`CallsignSuffixConflictError`, naming the
 * conflicting value) and for a malformed character class -- both belong
 * against the Callsign Suffix field, with the dialog left open to
 * correct, rather than as a generic toast. Mirrors `TeamDetail.jsx`'s
 * `extractCallsignSuffixServerError` convention exactly, duplicated here
 * (rather than imported) so this dialog carries no dependency on
 * `TeamDetail.jsx`'s own module.
 *
 * @param {{response?: {status?: number, data?: {error?: string}}}} error
 * @returns {string|null}
 */
export function extractDeviceCallsignSuffixServerError(error) {
  const status = error?.response?.status
  const serverError = error?.response?.data?.error
  if (status === 400 && typeof serverError === 'string') {
    return serverError
  }
  return null
}

/**
 * Bug #6: the "Add Team Device" dialog's live preview/collision-check,
 * calling the SAME `POST /api/users/callsign-suffix-preview` route the
 * Create New User tab uses. Sending no `firstName`/`lastName` at all is
 * what selects that route's device-shaped branch (see
 * `server/routes/users.js`'s `noNameSupplied` handling, added alongside
 * this dialog's rework): a blank suffix reports `required: true` and a
 * non-blank one is checked directly against the shared per-team
 * uniqueness rule, with no mint attempt and no write either way.
 *
 * @param {number|string} teamId
 * @param {string} callsignSuffix
 * @returns {Promise<{suffix: string|null, required: boolean, conflict: {value: string, message: string}|null}>}
 */
async function previewDeviceCallsignSuffix(teamId, callsignSuffix) {
  const response = await usersAPI.previewCallsignSuffix({ teamId, callsignSuffix })
  return response.data
}

/**
 * The "Add Team Device" dialog: creates a brand-new Team_Owned_Device for
 * `teamId` via `POST /api/devices` (`DeviceEnrollmentService.createDevice`),
 * distinct from `TeamDeviceList.jsx`'s "Enroll" action, which mints
 * enrollment credentials for a device that ALREADY exists. This dialog is
 * the one and only place a NEW device is created.
 *
 * Bug #6 rework -- aligned with the Create New User tab's own UX:
 * - The Callsign Suffix field is REQUIRED (previously read "Optional",
 *   which was wrong -- see `isCallsignSuffixMissing`'s doc comment).
 * - The FULL resulting callsign is computed and shown LIVE as the admin
 *   types, via the same three-segment assembly rule the server itself
 *   uses (`assembleCallsignPreview`/`resolveCallsignSegments`, a
 *   client-side mirror of `CallsignService.assembleCallsign`).
 * - A live collision check runs on blur of the suffix field (the same
 *   trigger point the Create New User tab uses for its own Suffix_Field),
 *   via `POST /api/users/callsign-suffix-preview` -- the SAME
 *   uniqueness rule/route a human member's suffix is checked against
 *   (`checkCallsignSuffixUniqueness`), so a collision is surfaced before
 *   submit rather than only after.
 * - Submit is still checked server-side either way (defense in depth):
 *   a collision reaching submit anyway comes back as a 400 naming the
 *   conflicting value, surfaced inline against the field exactly as
 *   before.
 *
 * @param {object} props
 * @param {number|string} props.teamId
 * @param {object} [props.team] the Team the device is being created
 *   for -- used only to resolve the live callsign preview's segments,
 *   never sent to the server (the server resolves its own Ancestor_Chain
 *   independently at creation time).
 * @param {Array<object>} [props.allTeams] the caller's already-fetched
 *   team list, used the SAME way `computeTeamDepth`/
 *   `isPseudonymousOrganisation` already do, to walk `team`'s
 *   Ancestor_Chain client-side for the live preview.
 * @param {() => void} props.onClose
 * @param {(device: object) => void} props.onCreated - called with the
 *   server's created-device object on success, before `onClose`.
 */
export default function AddTeamDeviceDialog({ teamId, team, allTeams, onClose, onCreated }) {
  const [label, setLabel] = useState('')
  const [callsignSuffix, setCallsignSuffix] = useState('')
  const [suffixError, setSuffixError] = useState(null)
  const [checkingSuffix, setCheckingSuffix] = useState(false)
  const [creating, setCreating] = useState(false)

  const { organisationPrefix, teamSegmentPrefixes, teamSegmentSeparator } = resolveCallsignSegments(team, allTeams)
  const callsignPreview = assembleCallsignPreview({
    organisationPrefix,
    teamSegmentPrefixes,
    nameSegment: callsignSuffix.trim(),
    teamSegmentSeparator
  })

  const handleSuffixBlur = async () => {
    const trimmed = callsignSuffix.trim()
    if (!trimmed || !isValidDeviceCallsignSuffix(trimmed) || !teamId) {
      return
    }
    setCheckingSuffix(true)
    try {
      const result = await previewDeviceCallsignSuffix(teamId, trimmed)
      if (result?.conflict) {
        setSuffixError(result.conflict.message)
      } else {
        setSuffixError(null)
      }
    } catch (error) {
      // Advisory only, matching the Create New User tab's own
      // Suffix_Preview error handling: recorded through the console,
      // never surfaced -- submit still re-checks authoritatively.
      console.error('Failed to preview device callsign suffix:', error)
    } finally {
      setCheckingSuffix(false)
    }
  }

  const handleSubmit = async (event) => {
    event.preventDefault()

    const trimmedLabel = label.trim()
    const trimmedSuffix = callsignSuffix.trim()

    if (isCallsignSuffixMissing(trimmedSuffix)) {
      setSuffixError('Callsign suffix is required for a team device.')
      return
    }

    // Validated on the TRIMMED value -- surrounding whitespace is never
    // itself a reason to reject an otherwise-valid suffix, since it is
    // stripped before being sent either way.
    if (!isValidDeviceCallsignSuffix(trimmedSuffix)) {
      setSuffixError('Callsign suffix may only contain letters, digits, "-", and "."')
      return
    }

    setCreating(true)
    try {
      const response = await devicesAPI.create(
        teamId,
        trimmedLabel || null,
        trimmedSuffix
      )
      toast.success('Team device created')
      onCreated?.(response.data.device)
      onClose()
    } catch (error) {
      const inlineError = extractDeviceCallsignSuffixServerError(error)
      if (inlineError) {
        setSuffixError(inlineError)
      } else {
        toast.error('Failed to create team device: ' + (error.response?.data?.error || error.message))
      }
    } finally {
      setCreating(false)
    }
  }

  return (
    // Bugfix: full-bleed on mobile, matching the app-wide modal
    // treatment -- see RevokeDeviceDialog.jsx's identical comment.
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-team-device-title"
        className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-lg sm:h-auto sm:max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h3 id="add-team-device-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Add Team Device
          </h3>
          {/* Bugfix (mobile tap target too small): p-2 rounded-lg box
              around the icon, matching every other modal's close button
              in this app -- was a bare h-6 w-6 icon with no padding. */}
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label htmlFor="team-device-label" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Device Label
            </label>
            <input
              id="team-device-label"
              type="text"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className="input w-full"
              placeholder="Engine 4 Tablet"
              maxLength={255}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              A human-readable name for this device. Leave blank to identify it only by its generated username.
            </p>
          </div>

          <div>
            <label htmlFor="team-device-callsign-suffix" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Callsign Suffix *
            </label>
            <input
              id="team-device-callsign-suffix"
              type="text"
              required
              value={callsignSuffix}
              onChange={(event) => {
                setCallsignSuffix(event.target.value)
                setSuffixError(null)
              }}
              onBlur={handleSuffixBlur}
              className="input w-full"
              pattern={CALLSIGN_SUFFIX_PATTERN}
              title="Only letters, digits, - and . are allowed"
              placeholder="Tanker1"
              aria-invalid={suffixError ? 'true' : undefined}
              aria-describedby={suffixError ? 'team-device-callsign-suffix-error' : 'team-device-callsign-preview'}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Required. Must be unique within this team -- it cannot match another device's or member's callsign suffix.
            </p>
            {checkingSuffix && (
              <span role="status" aria-live="polite" className="text-xs text-gray-500 dark:text-gray-400 mt-1 inline-block">
                Checking callsign suffix…
              </span>
            )}
            {/* Bug #6: the FULL resulting callsign, computed live from the
                same three-segment assembly rule the server uses, so the
                admin sees exactly what this device's callsign will be
                before submitting. Shown only once a suffix has been
                entered -- before that there is no Name segment yet, and
                showing just the Organisation/Team prefixes alone would
                read as a (misleadingly nameless) callsign rather than as
                "nothing to preview yet". */}
            {callsignSuffix.trim() && callsignPreview && (
              <p id="team-device-callsign-preview" className="text-sm text-gray-700 dark:text-gray-300 mt-2">
                Full callsign: <span className="font-mono font-medium text-gray-900 dark:text-gray-100">{callsignPreview}</span>
              </p>
            )}
            {suffixError && (
              <p id="team-device-callsign-suffix-error" role="alert" className="text-red-600 dark:text-red-400 text-sm mt-1">
                {suffixError}
              </p>
            )}
          </div>

          <div className="flex justify-end space-x-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary px-6 py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className="btn-primary px-6 py-2"
            >
              {creating ? 'Creating...' : 'Create Device'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
