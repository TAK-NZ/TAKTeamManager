import { useState, useEffect, useMemo, useCallback } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { teamsAPI, usersAPI } from '../services/api'

/**
 * Requirement 15.4: a fixed statement, shown for every transfer, that the
 * move changes the member's TAK callsign. The callsign is derived
 * server-side from the Destination_Team's Ancestor_Chain
 * (Requirement 8.1), so it changes on every transfer regardless of which
 * team is picked -- hence a fixed statement rather than a computed one.
 */
export const CALLSIGN_CHANGE_STATEMENT =
  "This transfer changes the member's TAK callsign, which is derived from the destination team's hierarchy."

/**
 * Requirement 10.4: shown only when the member holds `role` of `admin` in
 * the displayed Team. A transfer always lands the member as a plain
 * `member` (Requirement 10.1), so admin rights are lost and have to be
 * granted again by the Destination_Team.
 */
export const ADMIN_DEMOTION_STATEMENT =
  'This member is a team admin. The transfer removes their admin rights, which must be granted again in the destination team.'

/**
 * The four statuses Requirement 15.7 names. Anything else (a 500, a
 * network failure) is still surfaced inline and still keeps the dialog
 * open -- the requirement's list is a floor, not a ceiling, and silently
 * closing on an unexpected failure would lose the operator's input.
 */
const INLINE_ERROR_STATUSES = [400, 403, 404, 409]

/**
 * Requirement 15.3: the displayed Team can never be its own destination
 * (the server answers that with a 400 via `AlreadyInDestinationTeamError`,
 * so excluding it here is about not offering an impossible choice, not
 * about being trusted).
 *
 * Exported for direct unit testing, matching this project's convention of
 * testing extracted pure logic rather than rendering a component (see
 * `src/pages/TeamDetail.test.jsx`, `src/utils/channelTree.test.js`).
 *
 * @param {Array<{id: number|string}>} teams
 * @param {number|string|null|undefined} excludedTeamId
 * @returns {Array<object>}
 */
export function filterDestinationTeams(teams, excludedTeamId) {
  if (!Array.isArray(teams)) {
    return []
  }
  return teams.filter((t) => String(t?.id) !== String(excludedTeamId))
}

/**
 * Requirement 15.9 (and the caveat that makes it work): the
 * Organisation-scoped call resolves the caller's OWN Organisation from
 * their first `team_memberships` row, so it returns an empty list for a
 * caller with no membership of their own -- which a Global_Manager may
 * well be. Only then, and only for a Global_Manager, does the dialog fall
 * back to the all-teams branch of `GET /api/teams/my-teams`.
 *
 * Requirement 15.8 still holds for everyone else: the fallback is
 * unreachable for a non-admin caller, because the all-teams branch is
 * itself admin-gated server-side, so a non-admin with an empty scoped list
 * simply keeps the empty list.
 *
 * @param {Array<object>|null|undefined} scopedTeams the result of the
 *   `scope: 'organisation'` call.
 * @param {{isAdmin?: boolean}|null|undefined} user the operating user.
 * @returns {boolean}
 */
export function shouldFallBackToAllTeams(scopedTeams, user) {
  return (!Array.isArray(scopedTeams) || scopedTeams.length === 0) && !!user?.isAdmin
}

/**
 * A Team's hierarchy path for the destination dropdown, using the same
 * `callsign_prefix || name` segment mapping and `' > '` join as the
 * server's `formatTeamPathForResponse` / `GET /api/requests/pending`'s
 * `team_path`, so the option the operator picks reads the same as the path
 * echoed back in the confirmation.
 *
 * `GET /api/teams/my-teams?scope=organisation` returns no `display_name`,
 * only `parent_team_id`/`callsign_prefix`/`name`, so the path is walked
 * client-side from the fetched list. Terminates defensively if an ancestor
 * is missing from the list (e.g. a Team filtered out as not a
 * Visible_Branch) rather than looping forever, matching
 * `utils/teamDepth.js`.
 *
 * @param {{id: number|string, name: string, callsign_prefix?: string|null, parent_team_id?: number|string|null}} team
 * @param {Array<object>} allTeams
 * @returns {string}
 */
export function formatTeamPath(team, allTeams) {
  if (!team) {
    return ''
  }
  const teamsById = new Map((allTeams || []).map((t) => [String(t.id), t]))
  const segments = [team.name]
  let parentId = team.parent_team_id
  const seen = new Set([String(team.id)])
  while (parentId && !seen.has(String(parentId))) {
    seen.add(String(parentId))
    const parent = teamsById.get(String(parentId))
    if (!parent) {
      break
    }
    segments.unshift(parent.callsign_prefix || parent.name)
    parentId = parent.parent_team_id
  }
  return segments.join(' > ')
}

/**
 * Requirement 9.6: recognises the 400 raised by
 * `CallsignSuffixConflictError`, whose message is
 * `Callsign Suffix "<value>" is already in use within this Team`. Matched
 * on the message rather than a dedicated response field because the route
 * passes the typed error's own message through as `error` and adds nothing
 * machine-readable beside it.
 *
 * @param {string|null|undefined} message
 * @returns {boolean}
 */
export function isCallsignSuffixConflictMessage(message) {
  if (typeof message !== 'string') {
    return false
  }
  return /callsign[_ ]?suffix/i.test(message) && /already in use/i.test(message)
}

/**
 * The conflicting value the server named, used as the replacement input's
 * placeholder so the operator can see what they must not reuse.
 *
 * @param {string|null|undefined} message
 * @returns {string|null}
 */
export function extractConflictingCallsignSuffix(message) {
  if (typeof message !== 'string') {
    return null
  }
  const match = message.match(/"([^"]*)"/)
  return match ? match[1] : null
}

/**
 * The request body for `POST /api/users/:userId/transfer`. Optional fields
 * are omitted rather than sent as empty strings: the server's validators
 * are `.optional()`, which skips an ABSENT field but would happily store
 * an empty `justification`/`callsignSuffix`.
 *
 * @param {{targetTeamId: number|string, justification?: string, callsignSuffix?: string}} form
 * @returns {{targetTeamId: number, justification?: string, callsignSuffix?: string}}
 */
export function buildTransferPayload({ targetTeamId, justification, callsignSuffix }) {
  const payload = { targetTeamId: Number(targetTeamId) }
  const trimmedJustification = (justification || '').trim()
  if (trimmedJustification) {
    payload.justification = trimmedJustification
  }
  const trimmedSuffix = (callsignSuffix || '').trim()
  if (trimmedSuffix) {
    payload.callsignSuffix = trimmedSuffix
  }
  return payload
}

/**
 * Requirements 15.5, 15.6: turns a successful transfer response into what
 * the dialog does next. The `status` field is authoritative and the HTTP
 * status is the fallback, so a 200/`completed` refreshes the Member_List
 * and a 202/`pending_approval` deliberately does not.
 *
 * @param {{status?: number, data?: object}} response an axios response.
 * @returns {{kind: 'completed'|'pending_approval', message: string, refresh: boolean, close: boolean}}
 */
export function interpretTransferResponse(response) {
  const data = response?.data || {}
  const isPending = data.status === 'pending_approval' || response?.status === 202

  if (isPending) {
    const approver = data.approvalTeamName ? `by ${data.approvalTeamName}` : 'by the other team'
    return {
      kind: 'pending_approval',
      message: `Transfer requested. It awaits approval ${approver}.`,
      // Requirement 15.6: nothing has moved yet, so the Member_List must
      // not be refetched -- a refresh here would suggest it had.
      refresh: false,
      close: true
    }
  }

  const destination = data.destinationTeamPath ? ` to ${data.destinationTeamPath}` : ''
  const callsign = data.callsign ? ` New callsign: ${data.callsign}.` : ''
  return {
    kind: 'completed',
    message: `Member transferred${destination}.${callsign}`,
    refresh: true,
    close: true
  }
}

/**
 * Requirements 9.6, 15.7: turns a failed transfer into what the dialog
 * does next. Every branch keeps the dialog open -- the suffix conflict
 * because it needs a replacement value, everything else because the
 * operator's selection and justification are still worth keeping.
 *
 * @param {{response?: {status?: number, data?: object}, message?: string}} error an axios error.
 * @returns {{kind: 'callsign_suffix_conflict'|'error', serverError: string|null, callsignSuffixPrompt: string|null, keepOpen: true}}
 */
export function interpretTransferError(error) {
  const status = error?.response?.status
  const data = error?.response?.data || {}
  let message = data.error

  if (!message && Array.isArray(data.errors) && data.errors.length > 0) {
    // express-validator's 400 shape (`{ errors: [...] }`) carries no
    // `error` field, so its per-field messages are joined instead of
    // rendering nothing at all.
    message = data.errors.map((e) => e.msg || e.message).filter(Boolean).join(', ')
  }

  if (!message) {
    message = INLINE_ERROR_STATUSES.includes(status)
      ? 'The transfer was rejected.'
      : 'Failed to transfer member. Please try again.'
  }

  if (status === 400 && isCallsignSuffixConflictMessage(message)) {
    return {
      kind: 'callsign_suffix_conflict',
      serverError: null,
      callsignSuffixPrompt: message,
      keepOpen: true
    }
  }

  return { kind: 'error', serverError: message, callsignSuffixPrompt: null, keepOpen: true }
}

/**
 * Requirement 15 / Requirement 10.4 / Requirement 9.6: the transfer
 * confirmation dialog opened from a Member_List row.
 *
 * Lives in its own component rather than inside `TeamDetail.jsx` (which is
 * already past 1300 lines with several in-component modals) because it
 * carries its own multi-field form, its own destination fetch, and the
 * Requirement 9.6 retry loop.
 *
 * Uses no native `confirm`/`alert` -- those were deliberately removed from
 * this codebase in favour of in-page dialogs and `react-hot-toast`.
 *
 * @param {object} props
 * @param {{id: number, first_name?: string, last_name?: string, email?: string, role?: string}} props.member
 *   the Member_List row being transferred. `member.role` of `'admin'` is
 *   what triggers Requirement 10.4's statement.
 * @param {{id: number, name?: string, display_name?: string}} props.team the
 *   displayed Team, i.e. the Source_Team -- excluded from the destination
 *   options (Requirement 15.3).
 * @param {{isAdmin?: boolean}} [props.user] the operating user. Only
 *   consulted for Requirement 15.9's all-teams fallback; when omitted, the
 *   dialog offers the Organisation-scoped list only, which is always safe.
 * @param {() => void} props.onClose
 * @param {() => void} props.onCompleted invoked only when the App reports
 *   `status` of `completed`, so the parent refetches the Member_List
 *   (Requirement 15.5) and leaves it untouched on a 202
 *   (Requirement 15.6).
 */
export default function TransferMemberDialog({ member, team, user, onClose, onCompleted }) {
  const [targetTeamId, setTargetTeamId] = useState('')
  const [justification, setJustification] = useState('')
  const [callsignSuffix, setCallsignSuffix] = useState('')
  const [serverError, setServerError] = useState(null)
  const [callsignSuffixPrompt, setCallsignSuffixPrompt] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [availableTeams, setAvailableTeams] = useState([])
  const [loadingTeams, setLoadingTeams] = useState(true)

  const isGlobalAdmin = !!user?.isAdmin

  // Requirements 15.2, 15.8, 15.9: the Organisation-scoped list is the
  // primary source (server-side Visible_Branch filtering plus server-side
  // Organisation narrowing), with the all-teams fallback reached only on an
  // empty scoped list for a Global_Manager.
  useEffect(() => {
    let isMounted = true

    const fetchTeams = async () => {
      setLoadingTeams(true)
      try {
        const scopedResponse = await teamsAPI.getMyTeams({ scope: 'organisation' })
        let teams = scopedResponse.data?.teams || []

        if (shouldFallBackToAllTeams(teams, { isAdmin: isGlobalAdmin })) {
          const allResponse = await teamsAPI.getMyTeams()
          teams = allResponse.data?.teams || []
        }

        if (isMounted) {
          setAvailableTeams(teams)
        }
      } catch (error) {
        console.error('Failed to fetch destination teams:', error)
        if (isMounted) {
          setServerError('Failed to load the list of destination teams.')
        }
      } finally {
        if (isMounted) {
          setLoadingTeams(false)
        }
      }
    }

    fetchTeams()

    return () => {
      isMounted = false
    }
  }, [isGlobalAdmin])

  const handleClose = useCallback(() => {
    if (!submitting) {
      onClose()
    }
  }, [submitting, onClose])

  // Escape closes the dialog, matching the expectation for any modal; the
  // guard in `handleClose` keeps it from abandoning an in-flight submit.
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        handleClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleClose])

  const destinationOptions = useMemo(() => {
    const options = filterDestinationTeams(availableTeams, team?.id).map((t) => ({
      id: t.id,
      label: formatTeamPath(t, availableTeams)
    }))
    options.sort((a, b) => a.label.localeCompare(b.label))
    return options
  }, [availableTeams, team?.id])

  const memberName = [member?.first_name, member?.last_name].filter(Boolean).join(' ') || member?.email || 'this member'
  const sourceTeamName = team?.display_name || team?.name || 'this team'
  const conflictingSuffix = extractConflictingCallsignSuffix(callsignSuffixPrompt)

  const submitTransfer = async () => {
    setSubmitting(true)
    setServerError(null)

    try {
      const response = await usersAPI.transfer(member.id, buildTransferPayload({
        targetTeamId,
        justification,
        callsignSuffix
      }))

      const result = interpretTransferResponse(response)
      if (result.refresh) {
        onCompleted()
      }
      toast.success(result.message)
      onClose()
    } catch (error) {
      console.error('Failed to transfer member:', error)
      const result = interpretTransferError(error)
      if (result.kind === 'callsign_suffix_conflict') {
        setCallsignSuffixPrompt(result.callsignSuffixPrompt)
        setServerError(null)
      } else {
        setServerError(result.serverError)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    await submitTransfer()
  }

  const submitDisabled =
    submitting
    || !targetTeamId
    // Requirement 9.6: once a conflict has been reported, a resubmit with
    // no replacement value would just collide again.
    || (!!callsignSuffixPrompt && !callsignSuffix.trim())

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="transfer-member-title"
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h3 id="transfer-member-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Transfer Member
          </h3>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close transfer dialog"
            className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Move <span className="font-medium text-gray-900 dark:text-gray-100">{memberName}</span>
            {member?.email && <span className="text-gray-500 dark:text-gray-400"> ({member.email})</span>}
            {' '}out of <span className="font-medium text-gray-900 dark:text-gray-100">{sourceTeamName}</span> and into another team.
          </p>

          {/* Requirement 15.4 */}
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {CALLSIGN_CHANGE_STATEMENT}
          </p>

          {/* Requirement 10.4 */}
          {member?.role === 'admin' && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              {ADMIN_DEMOTION_STATEMENT}
            </p>
          )}

          <div>
            <label htmlFor="transfer-target-team" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Destination team *
            </label>
            <select
              id="transfer-target-team"
              required
              value={targetTeamId}
              onChange={(e) => setTargetTeamId(e.target.value)}
              disabled={loadingTeams || submitting}
              className="input w-full"
            >
              <option value="">{loadingTeams ? 'Loading teams...' : 'Select a destination team'}</option>
              {destinationOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {!loadingTeams && destinationOptions.length === 0 && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                No other team is available as a destination.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="transfer-justification" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Justification
            </label>
            <textarea
              id="transfer-justification"
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              maxLength={500}
              rows={3}
              disabled={submitting}
              className="input w-full"
              placeholder="Why is this member moving?"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Shown to the approving team when the transfer needs their approval. Up to 500 characters.
            </p>
          </div>

          {/* Requirement 9.6: the conflict message plus a replacement input. */}
          {callsignSuffixPrompt && (
            <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 p-3">
              <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">
                {callsignSuffixPrompt}
              </p>
              <label htmlFor="transfer-callsign-suffix" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mt-3 mb-1">
                Replacement callsign suffix *
              </label>
              <input
                id="transfer-callsign-suffix"
                type="text"
                value={callsignSuffix}
                onChange={(e) => setCallsignSuffix(e.target.value)}
                maxLength={255}
                disabled={submitting}
                autoComplete="off"
                className="input w-full"
                placeholder={conflictingSuffix ? `Not "${conflictingSuffix}"` : 'Enter a different suffix'}
              />
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                Confirm to retry the transfer with this suffix.
              </p>
            </div>
          )}

          {/* Requirement 15.7 */}
          {serverError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {serverError}
            </p>
          )}

          <div className="flex justify-end space-x-3 pt-2 border-t border-gray-200 dark:border-gray-700">
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="btn-secondary px-4 py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitDisabled}
              className="btn-primary px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {(() => {
                if (submitting) {
                  return 'Transferring...'
                }
                return callsignSuffixPrompt ? 'Confirm & Retry' : 'Transfer Member'
              })()}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
