import { useState, useEffect } from 'react'
import { ClipboardDocumentListIcon, EyeIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { teamsAPI, auditLogsAPI } from '../services/api'
import FormattedDate, {
  DATE_PRECISION,
  TOOLTIP_SIDES,
} from '../components/FormattedDate'
import { formatNumber } from '../utils/formatNumber'

/**
 * Global_Manager-only page rendering the filter bar, results table,
 * pagination controls, and export action for the audit log.
 *
 * @param {{ user: { is_global_manager?: boolean, isAdmin?: boolean } }} props
 */
export default function AuditLogs({ user }) {
  // Requirement 1.5 / design.md Error Scenario 2: a non-Global_Manager must
  // never trigger a fetch to the audit log query endpoint or the CSV export
  // endpoint. Checking this before any state/effect that fetches is declared
  // keeps the guard airtight regardless of how later tasks wire the fetch
  // effect (task 9.1) -- the guard below returns before that effect exists,
  // and later work must keep this early return above the fetch effect.
  const isGlobalManager = Boolean(user?.is_global_manager)

  const [auditLogs, setAuditLogs] = useState([])         // current page of rows
  const [pagination, setPagination] = useState({ page: 1, pageSize: 50, total: 0 })
  const [loading, setLoading] = useState(true)            // initial + refetch spinner
  const [error, setError] = useState(null)                // fetch error message, or null
  const [filters, setFilters] = useState({                // draft filter form values (uncommitted)
    userEmail: '', action: '', resourceType: '', teamId: '', startDate: '', endDate: ''
  })
  const [appliedFilters, setAppliedFilters] = useState({}) // last-applied filters
  const [teams, setTeams] = useState([])                  // for the team filter <select>
  // Bugfix (mobile responsiveness / details-in-a-modal): the row whose
  // full `details` JSON (and the rest of its fields, for context) is
  // currently shown in the Details_Modal, or null when the modal is
  // closed. Holds the whole row rather than just an id, matching this
  // app's own convention for a dialog that needs more than one field off
  // its target (e.g. Users.jsx's `suspendingUser`).
  const [selectedLog, setSelectedLog] = useState(null)

  // Requirement 4.1 / design.md "Team filter options": fetch the full team
  // list once on mount to populate the Team_Filter_Dropdown. Guarded on
  // `isGlobalManager` for the same reason as the not-authorized early
  // return below -- a non-Global_Manager must never trigger a request,
  // including this one (Requirement 1.5).
  useEffect(() => {
    if (!isGlobalManager) {
      return
    }

    let isMounted = true

    teamsAPI.getMyTeams({ page: 1, pageSize: 200 })
      .then((response) => {
        if (isMounted) {
          setTeams(response.data.teams || [])
        }
      })
      .catch((err) => {
        console.error('Failed to fetch teams:', err)
      })

    return () => {
      isMounted = false
    }
  }, [isGlobalManager])

  // Requirements 1.4, 2.1, 2.2, 2.3, 2.4, 2.9 / design.md "Request flow:
  // applying filters": fetch the current page of results whenever
  // `appliedFilters` or `pagination.page` changes, including the initial
  // mount (appliedFilters starts as {} and page starts as 1, so this runs
  // automatically on mount without any special-casing). Guarded on
  // `isGlobalManager` for the same reason as the team-fetch effect above --
  // a non-Global_Manager must never trigger a request (Requirement 1.5).
  useEffect(() => {
    if (!isGlobalManager) {
      return
    }

    let isMounted = true
    setLoading(true)

    auditLogsAPI.getAuditLogs(appliedFilters, { page: pagination.page, pageSize: pagination.pageSize })
      .then((response) => {
        if (isMounted) {
          setAuditLogs(response.data.auditLogs)
          setPagination(response.data.pagination)
          setLoading(false)
          // Requirement 6.4: a successful request (triggered by re-applying
          // filters or changing the page) clears any previously displayed
          // error message.
          setError(null)
        }
      })
      .catch((err) => {
        // Requirements 6.1, 6.2, 6.3 / design.md Error Scenario 1: surface
        // a user-facing error message and stop the loading indicator, but
        // deliberately do NOT clear/reset `auditLogs` here -- any rows
        // rendered from a prior successful fetch must remain visible
        // alongside the error, and the Filter_Form/pagination controls
        // stay interactive since nothing here disables them.
        console.error('Failed to fetch audit logs:', err)
        if (isMounted) {
          setError('Failed to load audit logs. Please try again.')
          setLoading(false)
        }
      })

    return () => {
      isMounted = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedFilters, pagination.page, isGlobalManager])

  // Requirement 2.5 / design.md Property 3: guard against `pagination.pageSize`
  // being falsy (it always defaults to 50 and is always overwritten by the
  // server's response, which always returns a positive pageSize, but the
  // `|| 1` keeps this expression safe regardless).
  const totalPages = Math.max(1, Math.ceil(pagination.total / (pagination.pageSize || 1)))

  if (!isGlobalManager) {
    return (
      <div className="text-center py-12">
        <ClipboardDocumentListIcon className="mx-auto h-12 w-12 text-gray-400" />
        <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">Access Denied</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          You need global admin privileges to access this page.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Audit Log</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Search, filter, and export the system audit log.
        </p>
      </div>

      {/* Filter form (task 6.1 / 7.1) */}
      <div className="card">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label htmlFor="audit-log-user-email-filter" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              User Email
            </label>
            <input
              id="audit-log-user-email-filter"
              type="email"
              value={filters.userEmail}
              onChange={(e) => setFilters({ ...filters, userEmail: e.target.value })}
              className="input w-full"
              placeholder="e.g. user@organisation.nz"
            />
          </div>

          <div>
            {/* Requirement 3.6: free-text input, not a fixed <select>, since
                audit_logs.action is an unconstrained varchar.

                Bugfix: the placeholder used to read "e.g. user.login", but
                this app never writes that action -- there is no
                `INSERT INTO audit_logs` call anywhere with that value (the
                closest real actions are things like `user.suspend`,
                `team.create`, `user.add_to_team`). `user.suspend` is a real
                action every deployment eventually has rows for, unlike an
                example that could never match anything. */}
            <label htmlFor="audit-log-action-filter" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Action
            </label>
            <input
              id="audit-log-action-filter"
              type="text"
              value={filters.action}
              onChange={(e) => setFilters({ ...filters, action: e.target.value })}
              className="input w-full"
              placeholder="e.g. user.suspend"
            />
          </div>

          <div>
            {/* Requirement 3.6: free-text input, not a fixed <select>, since
                audit_logs.resource_type is an unconstrained varchar. */}
            <label htmlFor="audit-log-resource-type-filter" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Resource Type
            </label>
            <input
              id="audit-log-resource-type-filter"
              type="text"
              value={filters.resourceType}
              onChange={(e) => setFilters({ ...filters, resourceType: e.target.value })}
              className="input w-full"
              placeholder="e.g. team"
            />
          </div>

          <div>
            <label htmlFor="audit-log-team-filter" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Team
            </label>
            <select
              id="audit-log-team-filter"
              value={filters.teamId}
              onChange={(e) => setFilters({ ...filters, teamId: e.target.value })}
              className="input w-full"
            >
              <option value="">All Teams</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="audit-log-start-date-filter" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Start Date
            </label>
            <input
              id="audit-log-start-date-filter"
              type="date"
              value={filters.startDate}
              onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
              className="input w-full"
            />
          </div>

          <div>
            <label htmlFor="audit-log-end-date-filter" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              End Date
            </label>
            <input
              id="audit-log-end-date-filter"
              type="date"
              value={filters.endDate}
              onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
              className="input w-full"
            />
          </div>
        </div>

        {/* Bugfix: `flex-wrap gap-2` (was a non-wrapping `space-x-2` row)
            so the three buttons can drop onto more than one line on a
            narrow phone instead of shrinking or overflowing. */}
        <div className="flex flex-wrap justify-end gap-2 mt-4">
          {/* Requirements 5.1, 5.2, 5.4: the Export_Action is inherently
              Global_Manager-only because this entire page returns the
              not-authorized guard above when isGlobalManager is false, so
              no further conditional is needed around this button. It uses
              appliedFilters (the last-submitted filters), not the draft
              filters state, per Requirement 5.2/5.3. */}
          <button
            type="button"
            onClick={() => window.open(auditLogsAPI.buildExportUrl(appliedFilters), '_blank')}
            className="btn-secondary"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => {
              setFilters({ userEmail: '', action: '', resourceType: '', teamId: '', startDate: '', endDate: '' })
              setAppliedFilters({})
              setPagination((prev) => ({ ...prev, page: 1 }))
            }}
            className="btn-secondary"
          >
            Clear Filters
          </button>
          <button
            type="button"
            onClick={() => {
              // Requirement 3.7: startDate/endDate are submitted unchanged,
              // with no cross-field validation -- the backend already
              // treats an unsatisfiable range as "zero matching rows".
              setAppliedFilters(filters)
              setPagination((prev) => ({ ...prev, page: 1 }))
            }}
            className="btn-primary"
          >
            Apply Filters
          </button>
        </div>
      </div>

      {/* Results table / pagination / export (tasks 9.1, 10.1, 12.1, 13.1) */}
      <div className="card">
        {/* Requirements 6.1, 6.2, 6.3 / design.md Error Scenario 1: the error
            banner is rendered ADDITIVELY, alongside whichever of the
            loading/empty/table states below is showing -- it never replaces
            the table, so previously-loaded rows (retained in `auditLogs`,
            which is never cleared on error) stay visible together with the
            error message once `loading` finishes. */}
        {error && !loading && (
          <div className="mb-4 rounded-md bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 p-4">
            <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          </div>
        ) : auditLogs.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500 dark:text-gray-400">No audit log entries match the current filters.</p>
          </div>
        ) : (
          <>
          {/* Bugfix (mobile responsiveness parity with /dashboard,
              /downloads, /enrollment, /teams, /users, /requests,
              /global-channels): a `sm:hidden` stacked card list alongside
              the existing `hidden sm:block overflow-x-auto` table.

              Also folds Details into a per-row modal, opened by clicking
              (or Enter/Space-activating) the row itself, rather than a
              `<pre>` JSON blob inline in every row -- that blob forced
              `overflow-x-auto` on this table even at desktop widths and
              had no mobile equivalent at all. Resource Type is dropped as
              its own column/line: it is shown as a small secondary label
              under Action instead (still visible, just no longer a
              redundant sibling column carrying mostly-the-same information
              -- `user.suspend` beside `user`, `team.create` beside `team`
              -- one glance instead of two). */}
          <div className="sm:hidden divide-y divide-gray-200 dark:divide-gray-700">
            {auditLogs.map((row) => (
              <div
                key={row.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedLog(row)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelectedLog(row)
                  }
                }}
                className="p-4 space-y-1 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                aria-label={`View details for audit log entry ${row.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 dark:text-gray-100 break-words">{row.action}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{row.resource_type}</p>
                  </div>
                  <EyeIcon className="h-4 w-4 text-gray-400 dark:text-gray-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
                </div>
                <p className="text-gray-500 dark:text-gray-400">
                  {/* Same fallback chain as the User column below -- a raw
                      numeric id is never shown; an unresolved value reads
                      as '—' instead. */}
                  {row.username || row.email || '—'}
                  {' · '}
                  {row.resource_name || '—'}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {/* Not inside an `overflow-x-auto` wrapper here, so this
                      opens rightward like most Date_Tooltip hosts --
                      unlike the table cell below, which stays LEFT. */}
                  <FormattedDate
                    value={row.created_at}
                    fallback={row.created_at}
                    precision={DATE_PRECISION.DATE_TIME}
                    side={TOOLTIP_SIDES.RIGHT}
                  />
                </p>
              </div>
            ))}
          </div>

          <div className="hidden sm:block overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-700">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    ID
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    User
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Action
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Resource
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Created At
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {auditLogs.map((row) => (
                  <tr
                    key={row.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedLog(row)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelectedLog(row)
                      }
                    }}
                    className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                    aria-label={`View details for audit log entry ${row.id}`}
                  >
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {row.id}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {/* The server resolves user_id to the acting user's
                          username/email via a LEFT JOIN (server/routes/
                          auditLogs.js), since a raw internal id is
                          meaningless to an admin reviewing the log.

                          Bugfix: this used to fall back to the raw
                          numeric `user_id` when the actor's user row was
                          later deleted (LEFT JOIN leaves username/email
                          null in that case) -- a bare internal database
                          id conveys nothing to an admin either way, so
                          this now falls straight to '—' instead, exactly
                          like the "no actor at all" case already did. */}
                      {row.username || row.email || '—'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {/* Bugfix (Action/Resource Type redundancy): the two
                          used to be separate columns carrying mostly the
                          same information (`user.suspend` beside `user`,
                          `team.create` beside `team`) -- Resource Type is
                          now a small secondary label under Action instead
                          of its own column. */}
                      {row.action}
                      <div className="text-xs text-gray-500 dark:text-gray-400">{row.resource_type}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {/* Bugfix: same "never show the raw internal id"
                          fix as the User column above -- resource_id is
                          an implementation detail (a bch_channels.id, a
                          deployment_channels.id, etc.), not something an
                          admin should ever have to look up manually. The
                          server (server/routes/auditLogs.js) now resolves
                          every nameable resource_type to a real name;
                          anything it can't resolve (already deleted, or a
                          resource_type with no meaningful name of its
                          own, e.g. a sync operation) reads as '—'
                          rather than a bare number. */}
                      {row.resource_name || '—'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      {/* Created At, the last cell of a table inside an
                          `overflow-x-auto` wrapper, so the tooltip opens
                          LEFTWARD (Criterion 3.5): a tooltip pushed past a
                          scroll container's right edge is clipped but
                          reachable by scrolling, while one pushed past the
                          left edge is clipped AND unreachable.

                          `fallback` is `row.created_at` itself -- the RAW
                          value, exactly as this cell passed it to
                          `formatDateTime` before. Rendered exactly as
                          passed: if the API ever sends a non-renderable
                          child here it fails exactly as it fails today,
                          and this spec neither introduces nor repairs that.

                          This page paginates at 50 rows, so it gains 50 tab
                          stops. That price is argued and accepted in
                          design.md Decision 5 -- do NOT try to avoid it
                          with a `title` (Criterion 3.3 forbids it and it is
                          never disclosed on focus) or by exposing only some
                          rows. */}
                      <FormattedDate
                        value={row.created_at}
                        fallback={row.created_at}
                        precision={DATE_PRECISION.DATE_TIME}
                        side={TOOLTIP_SIDES.LEFT}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}

        {/* Pagination (task 10.1). Bugfix: `flex-wrap gap-2` (was a
            non-wrapping `justify-between` row) -- same fix as Teams.jsx's
            identical pagination row, so the summary text doesn't compete
            against Previous/Page-N-of-M/Next for room on a narrow phone. */}
        {!loading && auditLogs.length > 0 && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Showing {formatNumber((pagination.page - 1) * pagination.pageSize + 1)} to{' '}
              {formatNumber(Math.min(pagination.page * pagination.pageSize, pagination.total))} of {formatNumber(pagination.total)} entries
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
                Page {pagination.page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPagination((prev) => ({ ...prev, page: prev.page + 1 }))}
                disabled={pagination.page === totalPages}
                className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bugfix (details-in-a-modal): the full row -- including the
          `details` JSON blob that used to render inline as a `<pre>` in
          every row -- now shows here, opened by clicking (or
          Enter/Space-activating) either the mobile card or the desktop
          table row above. Small confirm-dialog tier (plain `max-w-lg
          w-full`, matching e.g. Resend Welcome Email), not full-bleed:
          this is a single read-only record, not a multi-field form. */}
      {selectedLog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="audit-log-details-title"
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full max-h-[85vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 id="audit-log-details-title" className="text-lg font-medium text-gray-900 dark:text-gray-100">
                Audit Log Entry #{selectedLog.id}
              </h3>
              <button
                type="button"
                onClick={() => setSelectedLog(null)}
                aria-label="Close audit log details dialog"
                className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
              >
                <XMarkIcon className="h-6 w-6" aria-hidden="true" />
              </button>
            </div>
            <div className="p-6 space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                <div>
                  <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">User</dt>
                  <dd className="mt-1 text-gray-900 dark:text-gray-100">
                    {/* Bugfix: never a raw internal id -- '—' once
                        username/email can't be resolved. */}
                    {selectedLog.username || selectedLog.email || '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Created At</dt>
                  <dd className="mt-1 text-gray-900 dark:text-gray-100">
                    <FormattedDate
                      value={selectedLog.created_at}
                      fallback={selectedLog.created_at}
                      precision={DATE_PRECISION.DATE_TIME}
                      side={TOOLTIP_SIDES.RIGHT}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Action</dt>
                  <dd className="mt-1 text-gray-900 dark:text-gray-100 break-words">{selectedLog.action}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Resource Type</dt>
                  <dd className="mt-1 text-gray-900 dark:text-gray-100 break-words">{selectedLog.resource_type}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Resource</dt>
                  <dd className="mt-1 text-gray-900 dark:text-gray-100 break-words">
                    {/* Bugfix: never the raw resource_id -- '—' once the
                        server can't resolve a name for it. */}
                    {selectedLog.resource_name || '—'}
                  </dd>
                </div>
              </div>
              <div>
                <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">Details</dt>
                <dd>
                  {selectedLog.details == null ? (
                    <p className="text-gray-500 dark:text-gray-400">—</p>
                  ) : (
                    <pre className="whitespace-pre-wrap text-xs bg-gray-50 dark:bg-gray-900 rounded p-3 overflow-x-auto">
                      {JSON.stringify(selectedLog.details, null, 2)}
                    </pre>
                  )}
                </dd>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
