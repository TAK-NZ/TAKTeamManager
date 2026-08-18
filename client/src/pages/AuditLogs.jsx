import { useState, useEffect } from 'react'
import { ClipboardDocumentListIcon } from '@heroicons/react/24/outline'
import { teamsAPI, auditLogsAPI } from '../services/api'
import { formatDateTime } from '../utils/dateFormat'

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
              placeholder="e.g. user@example.com"
            />
          </div>

          <div>
            {/* Requirement 3.6: free-text input, not a fixed <select>, since
                audit_logs.action is an unconstrained varchar. */}
            <label htmlFor="audit-log-action-filter" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Action
            </label>
            <input
              id="audit-log-action-filter"
              type="text"
              value={filters.action}
              onChange={(e) => setFilters({ ...filters, action: e.target.value })}
              className="input w-full"
              placeholder="e.g. user.login"
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

        <div className="flex justify-end space-x-2 mt-4">
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
          <div className="overflow-x-auto">
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
                    Resource Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Resource ID
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Details
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Created At
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {auditLogs.map((row) => (
                  <tr key={row.id}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {row.id}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {/* The server resolves user_id to the acting user's
                          username/email via a LEFT JOIN (server/routes/
                          auditLogs.js), since a raw internal id is
                          meaningless to an admin reviewing the log. Falls
                          back to the numeric id if the actor's user row
                          was later deleted (LEFT JOIN leaves username/email
                          null in that case), and to '—' if there's no
                          actor at all. */}
                      {row.username || row.email || row.user_id || '—'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {row.action}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {row.resource_type}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {row.resource_id ?? '—'}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                      {row.details == null ? (
                        '—'
                      ) : (
                        <pre className="whitespace-pre-wrap text-xs bg-gray-50 dark:bg-gray-900 rounded p-2 max-w-md overflow-x-auto">
                          {JSON.stringify(row.details, null, 2)}
                        </pre>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      {formatDateTime(row.created_at, row.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination (task 10.1) */}
        {!loading && auditLogs.length > 0 && (
          <div className="mt-6 flex items-center justify-between">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Showing {(pagination.page - 1) * pagination.pageSize + 1} to{' '}
              {Math.min(pagination.page * pagination.pageSize, pagination.total)} of {pagination.total} entries
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
    </div>
  )
}
