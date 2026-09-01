import { useEffect, useRef, useState } from 'react'
import { XMarkIcon, ArrowUpTrayIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { bulkImportAPI } from '../services/api'

/**
 * CSV user bulk import: a shared preview-then-confirm
 * dialog for `POST /api/bulk-import/users`, used from two entry points --
 * `Users.jsx`'s global "Import Users" action (no `defaultTeamId`; the
 * CSV's own `teamId` column decides each row's target team) and
 * `TeamDetail.jsx`'s team-scoped "Import Users" action, under its More
 * Options menu (`defaultTeamId={team.id}`, so the operator never types a
 * team id at all -- see `BulkImportService.parseRowTeamId`'s own doc
 * comment on why a row's own `teamId` column still wins when present).
 *
 * Two-step flow, per the user's own request (validate first, let the
 * operator SEE what will happen, only write to the DB after an explicit
 * confirm):
 *   1. Upload -> `bulkImportAPI.previewUsers` (read-only: no Authentik
 *      call, no DB write). Renders every row with its classification --
 *      `new` rows import normally; `duplicate_existing`/
 *      `duplicate_in_file`/`invalid`/`unauthorized` rows are shown
 *      grayed-out (never colour alone -- each also carries its own
 *      status TEXT and a `reason`) since they will NOT be imported.
 *   2. Confirm -> `bulkImportAPI.importUsers`, re-uploading the SAME
 *      file plus `rowNumbers` (only the rows that previewed as `new`),
 *      so the commit call touches exactly what the operator saw and
 *      approved. The per-row commit RESULT (success/failure) then
 *      replaces the preview table.
 *
 * Full-bleed on mobile, matching every other modal in this app (see
 * `AddTeamDeviceDialog.jsx`'s identical comment).
 *
 * @param {object} props
 * @param {number|string|null} [props.defaultTeamId] - a team-scoped
 *   caller's fixed target team. `null` for the global entry point.
 * @param {string} [props.title] - defaults to "Import Users".
 * @param {() => void} props.onClose
 * @param {() => void} [props.onImported] - called once after a
 *   successful commit (any successCount > 0), before the operator
 *   closes the dialog, so a caller can refresh its own list (e.g.
 *   `TeamDetail.jsx`'s member list).
 */
// The single canonical column list for the CSV both `/templates/user-
// import-template.csv` (the global, no-default-team case) and the
// team-scoped generated template below are built from -- one source of
// truth, so the two can never drift out of sync on a future column
// change. `teamScoped: 'omit'` means the column is dropped entirely
// from the GENERATED team-scoped template (see
// `buildTeamScopedTemplateCsv` below), since a team-scoped import's
// `teamId` is supplied by the dialog itself, never typed by the
// operator.
//
// Bugfix: there is deliberately no `username` column -- a
// non-pseudonymous account's username is always its email verbatim
// (matching `POST /api/users/create-and-add`'s own derivation), and a
// Pseudonymous_Organisation mints its own username regardless of any
// CSV value, so a separate column could only ever disagree with
// `email` or repeat it.
const TEMPLATE_COLUMNS = [
  { key: 'email' },
  { key: 'firstName' },
  { key: 'lastName' },
  { key: 'teamId', teamScoped: 'omit' }
]

const SAMPLE_ROWS = [
  { email: 'jane.doe@example.org', firstName: 'Jane', lastName: 'Doe', teamId: '1' },
  { email: 'john.smith@example.org', firstName: 'John', lastName: 'Smith', teamId: '2' }
]

/**
 * Bugfix (a team-scoped import's downloaded template
 * showed a `teamId` column identical to the global template's, with no
 * indication it could be left blank -- confusing when the dialog's own
 * body text says every row already defaults to the current team).
 * Generates the SAME template client-side with the `teamId` column
 * dropped entirely, built from `TEMPLATE_COLUMNS` -- the identical
 * source of truth `/templates/user-import-template.csv` on disk was
 * hand-written from, so the two can never silently diverge on a future
 * column addition/rename the static file forgets to mirror.
 *
 * @returns {string} CSV text, `\n`-terminated lines, matching the
 *   static file's own line-ending convention.
 */
function buildTeamScopedTemplateCsv() {
  const columns = TEMPLATE_COLUMNS.filter((column) => column.teamScoped !== 'omit')
  const header = columns.map((column) => column.key).join(',')
  const rows = SAMPLE_ROWS.map((row) => columns.map((column) => row[column.key] ?? '').join(','))
  return [header, ...rows].join('\n') + '\n'
}

/**
 * Triggers a browser download of `buildTeamScopedTemplateCsv()`'s
 * output, mirroring `Admin.jsx`'s `handleExportSettings`'s own
 * createObjectURL + temporary-anchor pattern for delivering a
 * client-generated blob as a download (that one downloads a server
 * response blob; this one downloads a client-BUILT one, but the
 * delivery mechanism -- object URL, temporary anchor, revoke -- is
 * identical).
 */
function downloadTeamScopedTemplate() {
  const blob = new Blob([buildTeamScopedTemplateCsv()], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'user-import-template.csv'
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export default function BulkImportUsersDialog({ defaultTeamId = null, title = 'Import Users', onClose, onImported }) {
  const [file, setFile] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewRows, setPreviewRows] = useState(null)
  const [previewError, setPreviewError] = useState(null)
  const [importing, setImporting] = useState(false)
  const [commitResults, setCommitResults] = useState(null)
  const fileInputRef = useRef(null)

  // Escape closes the dialog, matching every other modal in this app.
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  const handleFileChange = (event) => {
    setFile(event.target.files?.[0] || null)
    setPreviewRows(null)
    setPreviewError(null)
    setCommitResults(null)
  }

  const buildFormData = () => {
    const formData = new FormData()
    formData.append('csv', file)
    if (defaultTeamId != null) {
      formData.append('teamId', String(defaultTeamId))
    }
    return formData
  }

  const handlePreview = async () => {
    if (!file) {
      return
    }
    setPreviewing(true)
    setPreviewError(null)
    setCommitResults(null)
    try {
      const response = await bulkImportAPI.previewUsers(buildFormData())
      setPreviewRows(response.data.rows)
    } catch (error) {
      console.error('Failed to preview user CSV import:', error)
      setPreviewError(error.response?.data?.error || 'Failed to preview the CSV file. Please try again.')
    } finally {
      setPreviewing(false)
    }
  }

  const importableRowNumbers = (previewRows || [])
    .filter((row) => row.status === 'new')
    .map((row) => row.row)

  const handleConfirm = async () => {
    if (!file || importableRowNumbers.length === 0) {
      return
    }
    setImporting(true)
    try {
      const formData = buildFormData()
      formData.append('rowNumbers', JSON.stringify(importableRowNumbers))
      const response = await bulkImportAPI.importUsers(formData)
      setCommitResults(response.data)
      setPreviewRows(null)
      setFile(null)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
      if (response.data.successCount > 0) {
        toast.success(`${response.data.successCount} user(s) imported`)
        onImported?.()
      }
    } catch (error) {
      console.error('Failed to import user CSV:', error)
      toast.error('Failed to import user CSV: ' + (error.response?.data?.error || error.message))
    } finally {
      setImporting(false)
    }
  }

  const handleStartOver = () => {
    setPreviewRows(null)
    setPreviewError(null)
    setCommitResults(null)
    setFile(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-import-users-title"
        className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-3xl sm:h-auto sm:max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h3 id="bulk-import-users-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close import users dialog"
            className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {defaultTeamId != null
              ? 'Import members into this team from a CSV file. Download the template below for the expected columns -- the teamId column may be left blank, since every row defaults to this team.'
              : 'Import users from a CSV file, including which team each row belongs to. Download the template below for the expected columns.'}
          </p>

          {!commitResults && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                className="text-sm text-gray-900 dark:text-gray-100 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-primary-50 file:text-primary-700 dark:file:bg-primary-900 dark:file:text-primary-300"
              />
              <button
                type="button"
                onClick={handlePreview}
                disabled={!file || previewing}
                className="btn-primary flex items-center gap-2 disabled:opacity-50"
              >
                <ArrowUpTrayIcon className="h-4 w-4" />
                {previewing ? 'Checking...' : 'Preview'}
              </button>
              {defaultTeamId != null ? (
                // Bugfix: a team-scoped import generates its own
                // template with `teamId` dropped entirely, rather than
                // linking to the global static file that still shows
                // that column (see `buildTeamScopedTemplateCsv`'s own
                // doc comment).
                <button
                  type="button"
                  onClick={downloadTeamScopedTemplate}
                  className="text-sm text-primary-600 hover:text-primary-900 dark:text-primary-400 dark:hover:text-primary-300 underline"
                >
                  Download CSV template
                </button>
              ) : (
                <a
                  href="/templates/user-import-template.csv"
                  download
                  className="text-sm text-primary-600 hover:text-primary-900 dark:text-primary-400 dark:hover:text-primary-300 underline"
                >
                  Download CSV template
                </a>
              )}
            </div>
          )}

          {previewError && (
            <div className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 p-3">
              <p className="text-sm text-red-700 dark:text-red-300">{previewError}</p>
            </div>
          )}

          {previewRows && (
            <BulkImportPreviewTable rows={previewRows} showTeamIdColumn={defaultTeamId == null} />
          )}

          {commitResults && (
            <BulkImportCommitResultsTable results={commitResults} />
          )}
        </div>

        <div className="flex justify-end space-x-3 p-6 border-t border-gray-200 dark:border-gray-700">
          {previewRows && !commitResults && (
            <button
              type="button"
              onClick={handleStartOver}
              className="btn-secondary px-6 py-2"
            >
              Start Over
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary px-6 py-2"
          >
            {commitResults ? 'Close' : 'Cancel'}
          </button>
          {previewRows && !commitResults && (
            <button
              type="button"
              onClick={handleConfirm}
              disabled={importing || importableRowNumbers.length === 0}
              className="btn-primary px-6 py-2 disabled:opacity-50"
              title={importableRowNumbers.length === 0 ? 'No rows are eligible to import' : undefined}
            >
              {importing ? 'Importing...' : `Confirm Import (${importableRowNumbers.length})`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Human-readable label + description for each `previewUsers` row status.
 * Exported for direct unit testing of the STATE->TEXT mapping (never
 * colour alone -- see this file's own module doc comment).
 */
export const PREVIEW_STATUS_LABELS = {
  new: 'New',
  duplicate_existing: 'Already exists',
  duplicate_in_file: 'Duplicate in file',
  invalid: 'Invalid',
  unauthorized: 'Unauthorized'
}

/**
 * A preview row is excluded from import (grayed-out) for every status
 * except `'new'`. Exported so the dialog and any test can agree on
 * exactly which statuses count as "will not be imported" without
 * duplicating the list.
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isPreviewRowExcluded(status) {
  return status !== 'new'
}

function BulkImportPreviewTable({ rows, showTeamIdColumn }) {
  const newCount = rows.filter((row) => row.status === 'new').length
  const excludedCount = rows.length - newCount

  return (
    <div>
      <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
        {newCount} row(s) will be imported.
        {excludedCount > 0 && ` ${excludedCount} row(s) will be skipped -- see Status below.`}
      </p>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-700">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Row</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Email</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Name</th>
              {showTeamIdColumn && (
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Team ID</th>
              )}
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Status</th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
            {rows.map((row) => {
              const excluded = isPreviewRowExcluded(row.status)
              return (
                <tr key={row.row} className={excluded ? 'opacity-50' : undefined}>
                  <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">{row.row}</td>
                  <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">{row.email || '—'}</td>
                  <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
                    {[row.firstName, row.lastName].filter(Boolean).join(' ') || '—'}
                  </td>
                  {showTeamIdColumn && (
                    <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">{row.teamId ?? '—'}</td>
                  )}
                  <td className="px-3 py-2 text-sm">
                    <span className={excluded ? 'text-gray-500 dark:text-gray-400 font-medium' : 'text-green-600 dark:text-green-400 font-medium'}>
                      {PREVIEW_STATUS_LABELS[row.status] || row.status}
                    </span>
                    {row.reason && (
                      <span className="block text-xs text-gray-500 dark:text-gray-400">{row.reason}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function BulkImportCommitResultsTable({ results }) {
  return (
    <div>
      <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
        {results.successCount} succeeded, {results.failureCount} failed.
      </p>
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-700">
          <tr>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Row</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Status</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Message</th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
          {results.results.map((rowResult) => (
            <tr key={rowResult.row}>
              <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">{rowResult.row}</td>
              <td className="px-3 py-2 text-sm">
                {rowResult.success ? (
                  <span className="text-green-600 dark:text-green-400 font-medium">Success</span>
                ) : (
                  <span className="text-red-600 dark:text-red-400 font-medium">Failed</span>
                )}
              </td>
              <td className="px-3 py-2 text-sm text-gray-700 dark:text-gray-300">
                {rowResult.success ? `User created (ID: ${rowResult.userId})` : rowResult.error}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
