import { useState, useEffect } from 'react'
import { adminAPI } from '../services/api'
import FormattedDate, { DATE_PRECISION, TOOLTIP_SIDES } from './FormattedDate'
import toast from 'react-hot-toast'

/**
 * OrgInterestRequests — global admin panel showing org interest requests
 * with status management. For each pending row, shows "Mark Actioned" and
 * "Dismiss" buttons.
 *
 * Rendered on the Admin page for global admins only.
 */
export default function OrgInterestRequests() {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [updatingId, setUpdatingId] = useState(null)

  useEffect(() => {
    fetchRequests()
  }, [])

  const fetchRequests = async () => {
    setLoading(true)
    try {
      const res = await adminAPI.getOrgInterest()
      setRequests(res.data.requests || [])
    } catch (err) {
      console.error('Failed to fetch org interest requests:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleUpdateStatus = async (id, status) => {
    setUpdatingId(id)
    try {
      await adminAPI.updateOrgInterest(id, status)
      setRequests(requests.map(r =>
        r.id === id ? { ...r, status } : r
      ))
      toast.success(`Request marked as ${status}`)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update request')
    } finally {
      setUpdatingId(null)
    }
  }

  if (loading) {
    return (
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Org Interest Requests</h3>
        <div className="animate-pulse h-8 bg-gray-200 dark:bg-gray-700 rounded w-full"></div>
      </div>
    )
  }

  return (
    <div>
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">Org Interest Requests</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        People who expressed interest in onboarding their organisation.
      </p>

      {requests.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500 italic">
          No org interest requests.
        </p>
      ) : (
        <>
        {/* Bugfix (mobile responsiveness parity with /dashboard, /downloads,
            /enrollment, /teams, /users): a `sm:hidden` stacked card list
            alongside the existing `hidden sm:block overflow-x-auto` table,
            same dual-render convention as every other tabular surface in
            this pass. */}
        <div className="sm:hidden divide-y divide-gray-200 dark:divide-gray-700">
          {requests.map((req) => (
            <div key={req.id} className="py-3 space-y-1 text-sm">
              <p className="font-medium text-gray-900 dark:text-gray-100 break-words">
                {req.first_name} {req.last_name}
              </p>
              <p className="text-gray-500 dark:text-gray-400 break-all">{req.email}</p>
              <p className="text-gray-900 dark:text-gray-100">{req.org_name}</p>
              <div className="flex items-center justify-between gap-2">
                <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                  req.status === 'pending'
                    ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
                    : req.status === 'actioned'
                      ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                      : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                }`}>
                  {req.status}
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {req.created_at ? (
                    <FormattedDate
                      value={req.created_at}
                      fallback=""
                      precision={DATE_PRECISION.DATE_TIME}
                      side={TOOLTIP_SIDES.RIGHT}
                    />
                  ) : (
                    '-'
                  )}
                </span>
              </div>
              {req.status === 'pending' && (
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => handleUpdateStatus(req.id, 'actioned')}
                    disabled={updatingId === req.id}
                    className="flex-1 text-xs btn-primary px-2 py-1"
                  >
                    Mark Actioned
                  </button>
                  <button
                    onClick={() => handleUpdateStatus(req.id, 'dismissed')}
                    disabled={updatingId === req.id}
                    className="flex-1 text-xs btn-secondary px-2 py-1"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="hidden sm:block overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-700">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Email
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Name
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Organisation
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Status
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Date
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
              {requests.map((req) => (
                <tr key={req.id}>
                  <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
                    {req.email}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
                    {req.first_name} {req.last_name}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
                    {req.org_name}
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                      req.status === 'pending'
                        ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
                        : req.status === 'actioned'
                          ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                          : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                    }`}>
                      {req.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
                    {/* Date_Render_Position 11 (Criteria 2.1, 2.2, 2.3): the
                        created-at value renders through the ONE shared
                        FormattedDate, so it acquires the Date_Tooltip with the
                        same behaviour as every other date in the app. `side`
                        is LEFT because this is the second-to-last cell of a
                        horizontally scrolling table (Criterion 3.5) -- a
                        tooltip pushed past the container's left edge is
                        clipped AND unreachable, so trailing columns open
                        leftward from `right-full`.

                        THE TERNARY STAYS, and `fallback` is the helper's own
                        `''` rather than `'-'` (design.md Decision 13, the same
                        reasoning `Users.jsx` records for its `'Never'`).
                        Folding the string into the prop reads better and
                        CHANGES what this table renders: a `created_at` that is
                        present but unparseable takes the truthy branch today
                        and renders the EMPTY STRING, because `formatDateTime`'s
                        default fallback is `''`. Passing `fallback="-"` would
                        render `-` for that value instead. That is arguably the
                        better product decision, which is exactly why it does
                        not belong in a change whose Criterion 2.3 promises the
                        same string character for character and whose Criterion
                        2.4 preserves each caller's fallback rather than
                        relocating it. */}
                    {req.created_at ? (
                      <FormattedDate
                        value={req.created_at}
                        fallback=""
                        precision={DATE_PRECISION.DATE_TIME}
                        side={TOOLTIP_SIDES.LEFT}
                      />
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {req.status === 'pending' && (
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => handleUpdateStatus(req.id, 'actioned')}
                          disabled={updatingId === req.id}
                          className="text-xs btn-primary px-2 py-1"
                        >
                          Mark Actioned
                        </button>
                        <button
                          onClick={() => handleUpdateStatus(req.id, 'dismissed')}
                          disabled={updatingId === req.id}
                          className="text-xs btn-secondary px-2 py-1"
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  )
}
