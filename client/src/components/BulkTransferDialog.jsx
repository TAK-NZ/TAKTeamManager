import { useState, useEffect, useMemo, useCallback } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { teamsAPI, usersAPI } from '../services/api'
import {
  filterDestinationTeams,
  formatTeamPath,
  shouldFallBackToAllTeams
} from './TransferMemberDialog'

/**
 * Orgs & Teams multi-select: the bulk counterpart of
 * `TransferMemberDialog` -- ONE destination team, ONE optional shared
 * justification, applied to every selected row via
 * `POST /api/users/bulk-transfer`. Reuses that dialog's own pure
 * destination-team helpers (`filterDestinationTeams`/`formatTeamPath`/
 * `shouldFallBackToAllTeams`) rather than re-deriving the same
 * Organisation-scoped-with-Global_Manager-fallback logic a second time.
 *
 * Unlike the single-member dialog, there is no per-row Callsign_Suffix
 * retry loop here: a callsign-suffix collision on one row is just that
 * row's own bulk-result failure (the operator can retry that one row
 * individually from the Members tab afterward), not a batch-wide
 * blocking prompt -- forcing every OTHER already-eligible row to wait on
 * one row's naming collision would defeat the point of doing this in
 * bulk.
 *
 * @param {object} props
 * @param {Array<{id: number|string, first_name?: string, last_name?: string, email?: string, role?: string}>} props.members
 *   the selected Member_List rows.
 * @param {{id: number|string, name?: string, display_name?: string}} props.team
 *   the displayed Team, i.e. the Source_Team -- excluded from the
 *   destination options, matching `TransferMemberDialog`'s own
 *   Requirement 15.3.
 * @param {{isAdmin?: boolean}} [props.user]
 * @param {() => void} props.onClose
 * @param {() => void} props.onCompleted - called once after a
 *   successful call resolves with `successCount > 0`.
 */
export default function BulkTransferDialog({ members, team, user, onClose, onCompleted }) {
  const [targetTeamId, setTargetTeamId] = useState('')
  const [justification, setJustification] = useState('')
  const [availableTeams, setAvailableTeams] = useState([])
  const [loadingTeams, setLoadingTeams] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState(null)
  const [results, setResults] = useState(null)

  const isGlobalAdmin = !!user?.isAdmin

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

  const adminCount = members.filter((m) => m.role === 'admin').length
  const sourceTeamName = team?.display_name || team?.name || 'this team'

  const memberLabel = (member) =>
    [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email || member.username || `#${member.id}`

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (submitting) {
      return
    }
    setSubmitting(true)
    setServerError(null)
    try {
      const trimmedJustification = justification.trim()
      const response = await usersAPI.bulkTransfer(
        members.map((m) => m.id),
        { targetTeamId: Number(targetTeamId), ...(trimmedJustification ? { justification: trimmedJustification } : {}) }
      )
      setResults(response.data)
      if (response.data.successCount > 0) {
        onCompleted?.()
      }
    } catch (error) {
      setServerError(error.response?.data?.error || error.message || 'Failed to transfer the selected members.')
    } finally {
      setSubmitting(false)
    }
  }

  const submitDisabled = submitting || !targetTeamId || members.length === 0

  const describeTransferResult = (result) => {
    if (!result.success) {
      return result.error
    }
    if (result.status === 'pending_approval') {
      return `Requested; awaits approval${result.approvalTeamName ? ` by ${result.approvalTeamName}` : ''}.`
    }
    const destination = result.destinationTeamPath ? ` to ${result.destinationTeamPath}` : ''
    return `Transferred${destination}.`
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-transfer-title"
        className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-lg sm:h-auto sm:max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h3 id="bulk-transfer-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Transfer {members.length} Member{members.length !== 1 ? 's' : ''}
          </h3>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close bulk transfer dialog"
            className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        {!results ? (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Move the {members.length} selected member{members.length !== 1 ? 's' : ''} out of{' '}
              <span className="font-medium text-gray-900 dark:text-gray-100">{sourceTeamName}</span> and into another team.
            </p>

            <ul className="max-h-32 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700 text-sm">
              {members.map((member) => (
                <li key={member.id} className="px-3 py-1.5 text-gray-900 dark:text-gray-100">
                  {memberLabel(member)}
                </li>
              ))}
            </ul>

            <p className="text-sm text-amber-700 dark:text-amber-400">
              This transfer changes each member's TAK callsign, which is derived from the destination team's hierarchy.
            </p>

            {adminCount > 0 && (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                {adminCount} of the selected member{adminCount !== 1 ? 's are' : ' is'} a team admin. The transfer removes admin
                rights, which must be granted again in the destination team.
              </p>
            )}

            <div>
              <label htmlFor="bulk-transfer-target-team" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Destination team *
              </label>
              <select
                id="bulk-transfer-target-team"
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
              <label htmlFor="bulk-transfer-justification" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Justification
              </label>
              <textarea
                id="bulk-transfer-justification"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                maxLength={500}
                rows={3}
                disabled={submitting}
                className="input w-full"
                placeholder="Why are these members moving? Shared across every selected member."
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Shown to the approving team for any row that needs approval. Up to 500 characters.
              </p>
            </div>

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
                {submitting ? 'Transferring...' : `Transfer ${members.length} Member${members.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </form>
        ) : (
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {results.successCount} succeeded, {results.failureCount} failed.
            </p>
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-700">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Name</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Status</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Message</th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {results.results.map((result) => {
                  const member = members.find((m) => String(m.id) === String(result.userId))
                  return (
                    <tr key={result.userId}>
                      <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
                        {member ? memberLabel(member) : result.userId}
                      </td>
                      <td className="px-3 py-2 text-sm">
                        {result.success ? (
                          <span className="text-green-600 dark:text-green-400 font-medium">Success</span>
                        ) : (
                          <span className="text-red-600 dark:text-red-400 font-medium">Failed</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-700 dark:text-gray-300">
                        {describeTransferResult(result)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="flex justify-end pt-2 border-t border-gray-200 dark:border-gray-700">
              <button type="button" onClick={onClose} className="btn-secondary px-4 py-2">
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
