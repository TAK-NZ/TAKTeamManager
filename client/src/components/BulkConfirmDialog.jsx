import { useEffect, useCallback, useState } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'

/**
 * Orgs & Teams multi-select: the shared confirmation dialog for a bulk
 * action applied to N selected rows (Members tab / Team Devices tab).
 * One component serves BOTH confirmation tiers this app already
 * distinguishes for a single-row action (see the client-conventions
 * steering doc's "two tiers, chosen by reversibility"):
 *
 *   - `literalWord` supplied (e.g. `'SUSPEND'`, `'DELETE'`): the
 *     type-to-confirm tier. Rather than typing each selected row's own
 *     identifying field (unworkable for N rows at once), the operator
 *     types ONE fixed literal word while the affected rows are listed
 *     above it -- the bulk counterpart of `RevokeDeviceDialog`'s own
 *     narrower `REVOKE`-literal pattern, chosen here (over "type the
 *     count" or "re-confirm every row individually") because it reads
 *     the same regardless of how many rows are selected and cannot be
 *     satisfied by an accidental paste of one of the listed names.
 *   - `literalWord` omitted: the plain Cancel/Confirm tier, matching
 *     "Remove as admin"/"Resend welcome email"'s existing single-row
 *     shape -- just the list and a Confirm button, no typed input.
 *
 * This dialog itself never calls an API: `onConfirm` is the caller's
 * bulk-endpoint call (e.g. `usersAPI.bulkSuspend(ids)`), and its
 * resolved `{successCount, failureCount, results}` shape is rendered
 * here as a per-row results table, mirroring `BulkImportUsersDialog`'s
 * own commit-results convention -- one row's failure is shown next to
 * every other row's outcome, never swallowed into a single toast.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {'danger'|'primary'} [props.tone] - `'danger'` renders the
 *   Confirm button as `btn-danger` (Suspend/Delete); `'primary'` (the
 *   default) as `btn-primary` (Unsuspend/Resend/Remove-as-admin) --
 *   mirroring the SAME tone split `SuspendAccountDialog`'s own
 *   `isSuspend` branch already draws between its two directions.
 * @param {string} [props.literalWord] - when supplied, the Confirm
 *   button stays disabled until this EXACT string (case-sensitive, no
 *   trim, matching every other typed-confirm input in this app) is
 *   typed. Omit for the plain tier.
 * @param {React.ReactNode} props.description - the "Suspend N
 *   account(s)?" / "Permanently delete N device(s)?" statement, and any
 *   tone-appropriate warning text (e.g. the same certificate-revocation
 *   wording `SuspendAccountDialog` uses) -- passed as a node rather
 *   than a plain string so a caller can include multiple paragraphs or
 *   inline emphasis exactly like every other dialog in this app does.
 * @param {Array<{id: number|string, label: string}>} props.rows - the
 *   rows this action will be applied to, rendered as a plain list above
 *   the confirm input so the operator can see exactly who is affected
 *   before typing anything.
 * @param {() => void} props.onClose
 * @param {(ids: Array<number|string>) => Promise<{successCount: number, failureCount: number, results: Array<object>}>} props.onConfirm
 *   called with `rows.map(r => r.id)` when Confirm is clicked. Its
 *   resolved value is rendered as the per-row results table; this
 *   dialog stays open afterward (the operator reads the outcome, then
 *   closes it themselves) rather than auto-closing on success, since a
 *   partial-failure batch needs to be readable, not just toasted.
 * @param {(result: object) => React.ReactNode} props.renderRowResult -
 *   given one entry of `onConfirm`'s resolved `results` array, returns
 *   the "Message" cell's content (e.g. `Account suspended` or the
 *   entry's own `error`). Kept a caller-supplied renderer rather than a
 *   fixed field name, since each bulk action's result shape differs
 *   slightly (`accountStatus` vs `authentikAccountDeleted` vs nothing
 *   extra at all).
 * @param {(result: object) => string|number} props.resultRowId - the id
 *   field a result row is keyed on (`userId` for the member actions,
 *   `deviceUserId` for device delete), used both as the React `key` and
 *   to look the row's own `label` back up from `rows` for the results
 *   table.
 * @param {() => void} [props.onCompleted] - called once after a
 *   successful `onConfirm` resolves with `successCount > 0`, so the
 *   caller can refresh its own list -- mirrors every other dialog's
 *   `onCompleted` prop in this app. NOT called on a batch that is 100%
 *   failures.
 */
export default function BulkConfirmDialog({
  title,
  tone = 'primary',
  literalWord,
  description,
  rows,
  onClose,
  onConfirm,
  renderRowResult,
  resultRowId,
  onCompleted
}) {
  const [confirmInput, setConfirmInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState(null)
  const [serverError, setServerError] = useState(null)

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

  const handleConfirm = async () => {
    if (submitting) {
      return
    }
    setSubmitting(true)
    setServerError(null)
    try {
      const outcome = await onConfirm(rows.map((row) => row.id))
      setResults(outcome)
      if (outcome.successCount > 0) {
        onCompleted?.()
      }
    } catch (error) {
      setServerError(error.response?.data?.error || error.message || 'The bulk action failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const confirmDisabled = submitting || rows.length === 0 || (literalWord != null && confirmInput !== literalWord)
  const labelById = new Map(rows.map((row) => [String(row.id), row.label]))
  const toneButtonClass = tone === 'danger' ? 'btn-danger' : 'btn-primary'

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-confirm-title"
        className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-lg sm:h-auto sm:max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h3 id="bulk-confirm-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </h3>
          <button
            type="button"
            onClick={handleClose}
            aria-label={`Close ${title.toLowerCase()} dialog`}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {!results && (
            <>
              <div className="text-sm text-gray-600 dark:text-gray-400 space-y-2">
                {description}
              </div>

              <div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {rows.length} selected:
                </p>
                <ul className="max-h-40 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700 text-sm">
                  {rows.map((row) => (
                    <li key={row.id} className="px-3 py-1.5 text-gray-900 dark:text-gray-100">
                      {row.label}
                    </li>
                  ))}
                </ul>
              </div>

              {literalWord != null && (
                <div>
                  <label htmlFor="bulk-confirm-input" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Type <span className="font-mono font-bold text-gray-900 dark:text-gray-100">{literalWord}</span> to confirm:
                  </label>
                  <input
                    id="bulk-confirm-input"
                    type="text"
                    className="input w-full"
                    value={confirmInput}
                    onChange={(e) => setConfirmInput(e.target.value)}
                    placeholder={literalWord}
                    autoComplete="off"
                    disabled={submitting}
                  />
                </div>
              )}

              {serverError && (
                <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                  {serverError}
                </p>
              )}
            </>
          )}

          {results && (
            <div>
              <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
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
                    const rowId = resultRowId(result)
                    return (
                      <tr key={rowId}>
                        <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
                          {labelById.get(String(rowId)) ?? rowId}
                        </td>
                        <td className="px-3 py-2 text-sm">
                          {result.success ? (
                            <span className="text-green-600 dark:text-green-400 font-medium">Success</span>
                          ) : (
                            <span className="text-red-600 dark:text-red-400 font-medium">Failed</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-sm text-gray-700 dark:text-gray-300">
                          {renderRowResult(result)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex justify-end space-x-3 p-6 border-t border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="btn-secondary px-4 py-2"
          >
            {results ? 'Close' : 'Cancel'}
          </button>
          {!results && (
            <button
              type="button"
              onClick={handleConfirm}
              disabled={confirmDisabled}
              className={`${toneButtonClass} px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {submitting ? 'Working...' : title}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
