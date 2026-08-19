import { useState, useEffect } from 'react'
import { adminAPI } from '../services/api'
import { formatDateTime } from '../utils/dateFormat'
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
        <div className="overflow-x-auto">
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
                    {req.created_at ? formatDateTime(req.created_at) : '-'}
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
      )}
    </div>
  )
}
