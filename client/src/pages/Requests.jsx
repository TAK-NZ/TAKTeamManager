import { useState, useEffect } from 'react'
import { CheckIcon, XMarkIcon, ClockIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { requestsAPI } from '../services/api'
import OrgInterestRequests from '../components/OrgInterestRequests'
import { formatDate } from '../utils/dateFormat'

// Requirement 11.11/11.12: pure helper computing the initial per-request
// "Callsign Suffix" input value map from a `GET /api/requests/pending`
// response's `requests` array -- extracted as a standalone function (rather
// than inlined in the fetch effect) so the pre-fill rule can be unit tested
// without rendering the component.
export function getInitialCallsignSuffixMap(requestsList) {
  return Object.fromEntries(requestsList.map((r) => [r.id, r.effective_callsign_suffix || '']))
}

// Requirement 11.17: pure helper extracting a callsign-suffix collision
// message from a rejected `requestsAPI.approveRequest` call, or `null` when
// the failure is not a shaped 400 collision response (server/routes/
// requests.js maps `CallsignSuffixConflictError` to `res.status(400).json({
// error: error.message })`; every other approve failure keeps the existing
// generic-toast behavior).
export function extractCallsignSuffixConflictError(error) {
  const status = error?.response?.status
  const serverError = error?.response?.data?.error
  if (status === 400 && typeof serverError === 'string') {
    return serverError
  }
  return null
}

export default function Requests({ user }) {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  // Requirement 11.11/11.12: per-request editable "Callsign Suffix" value,
  // keyed by request id and seeded from that request's `effective_callsign_suffix`
  // (the request's own submitted value when present, otherwise the
  // server-computed default -- see server/routes/requests.js's GET /pending).
  const [callsignSuffixByRequestId, setCallsignSuffixByRequestId] = useState({})
  // Per-request editable first/last name, keyed by request id and seeded
  // from the request's requester_first_name / requester_last_name.
  const [namesByRequestId, setNamesByRequestId] = useState({})
  // Requirement 11.17: per-request inline collision error, surfaced instead
  // of (never in addition to) the generic toast when POST .../approve 400s
  // with a callsign_suffix conflict.
  const [callsignSuffixErrorByRequestId, setCallsignSuffixErrorByRequestId] = useState({})

  useEffect(() => {
    const fetchRequests = async () => {
      try {
        const response = await requestsAPI.getPending()
        const fetchedRequests = response.data.requests
        setRequests(fetchedRequests)
        setCallsignSuffixByRequestId(getInitialCallsignSuffixMap(fetchedRequests))
        // Seed editable first/last name per request
        setNamesByRequestId(Object.fromEntries(fetchedRequests.map((r) => [
          r.id,
          { firstName: r.requester_first_name || '', lastName: r.requester_last_name || '' }
        ])))
      } catch (error) {
        console.error('Failed to fetch requests:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchRequests()
  }, [])

  const handleCallsignSuffixChange = (requestId, value) => {
    setCallsignSuffixByRequestId((prev) => ({ ...prev, [requestId]: value }))
    // Editing the value after a collision is exactly the retry the inline
    // error is meant to invite -- clear the stale error rather than leaving
    // it displayed against a value the reviewer has already changed.
    setCallsignSuffixErrorByRequestId((prev) => ({ ...prev, [requestId]: null }))
  }

  const clearRequestState = (requestId) => {
    setRequests((prev) => prev.filter(r => r.id !== requestId))
    setCallsignSuffixByRequestId((prev) => {
      const { [requestId]: _removed, ...rest } = prev
      return rest
    })
    setCallsignSuffixErrorByRequestId((prev) => {
      const { [requestId]: _removed, ...rest } = prev
      return rest
    })
    setNamesByRequestId((prev) => {
      const { [requestId]: _removed, ...rest } = prev
      return rest
    })
  }

  const handleApprove = async (requestId) => {
    try {
      const additionalDetails = prompt('Any additional details for the user? (optional)');
      await requestsAPI.approveRequest(requestId, {
        additionalDetails: additionalDetails || '',
        callsignSuffix: callsignSuffixByRequestId[requestId] || '',
        firstName: namesByRequestId[requestId]?.firstName || '',
        lastName: namesByRequestId[requestId]?.lastName || ''
      })
      clearRequestState(requestId)
      toast.success('Request approved successfully')
    } catch (error) {
      // Requirement 11.17: a `callsign_suffix` collision (400, with a plain
      // `error` string body -- see server/routes/requests.js mapping
      // `CallsignSuffixConflictError` to 400) is surfaced inline next to the
      // field, and the field/card stays open for the reviewer to retry with
      // a different value, instead of the generic toast used for every
      // other approve failure (which does close/remove nothing either, but
      // gives no field-specific feedback).
      const conflictMessage = extractCallsignSuffixConflictError(error)
      if (conflictMessage) {
        setCallsignSuffixErrorByRequestId((prev) => ({ ...prev, [requestId]: conflictMessage }))
      } else {
        toast.error('Failed to approve request')
      }
    }
  }

  const handleDeny = async (requestId) => {
    const denialReason = prompt('Please provide a reason for denial:');
    if (!denialReason) return;
    
    try {
      await requestsAPI.denyRequest(requestId, { denialReason })
      clearRequestState(requestId)
      toast.success('Request denied successfully')
    } catch (error) {
      toast.error('Failed to deny request')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Access Requests</h1>
        <p className="text-gray-600 dark:text-gray-400">Review and approve team access requests from new users.</p>
      </div>

      {requests.length === 0 ? (
        <div className="card text-center py-12">
          <ClockIcon className="h-12 w-12 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">No pending requests</h3>
          <p className="text-gray-500 dark:text-gray-400">
            All team access requests have been reviewed. New requests will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {requests.map((request) => (
            <div key={request.id} className="card">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center space-x-3 mb-2">
                    <span className="px-2 py-1 text-xs font-medium bg-yellow-100 text-yellow-800 rounded-full">
                      Pending
                    </span>
                  </div>
                  
                  <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                    <p><span className="font-medium">Email:</span> {request.requester_email}</p>
                    <p><span className="font-medium">Requested Team:</span> {request.team_path || request.team_name}</p>
                    <p><span className="font-medium">Submitted:</span> {formatDate(request.created_at)}</p>
                  </div>
                  
                  <div className="mt-4">
                    <p className="font-medium text-gray-900 dark:text-gray-100 mb-2">Reason for Access:</p>
                    <p className="text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700 p-3 rounded-lg">{request.justification}</p>
                  </div>

                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
                    <div>
                      <label
                        htmlFor={`first-name-${request.id}`}
                        className="block font-medium text-gray-900 dark:text-gray-100 mb-1 text-sm"
                      >
                        First Name
                      </label>
                      <input
                        id={`first-name-${request.id}`}
                        type="text"
                        className="input w-full"
                        value={namesByRequestId[request.id]?.firstName ?? ''}
                        onChange={(e) => setNamesByRequestId((prev) => ({
                          ...prev,
                          [request.id]: { ...prev[request.id], firstName: e.target.value }
                        }))}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`last-name-${request.id}`}
                        className="block font-medium text-gray-900 dark:text-gray-100 mb-1 text-sm"
                      >
                        Last Name
                      </label>
                      <input
                        id={`last-name-${request.id}`}
                        type="text"
                        className="input w-full"
                        value={namesByRequestId[request.id]?.lastName ?? ''}
                        onChange={(e) => setNamesByRequestId((prev) => ({
                          ...prev,
                          [request.id]: { ...prev[request.id], lastName: e.target.value }
                        }))}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`callsign-suffix-${request.id}`}
                        className="block font-medium text-gray-900 dark:text-gray-100 mb-1 text-sm"
                      >
                        Callsign Suffix
                      </label>
                      <input
                        id={`callsign-suffix-${request.id}`}
                        type="text"
                        className="input w-full"
                        value={callsignSuffixByRequestId[request.id] ?? ''}
                        onChange={(e) => handleCallsignSuffixChange(request.id, e.target.value)}
                      />
                      {callsignSuffixErrorByRequestId[request.id] && (
                        <p className="text-red-600 text-sm mt-1">
                          {callsignSuffixErrorByRequestId[request.id]}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
                
                <div className="flex space-x-2 ml-6">
                  <button
                    onClick={() => handleApprove(request.id)}
                    className="flex items-center px-3 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors"
                  >
                    <CheckIcon className="h-4 w-4 mr-1" />
                    Approve
                  </button>
                  <button
                    onClick={() => handleDeny(request.id)}
                    className="flex items-center px-3 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
                  >
                    <XMarkIcon className="h-4 w-4 mr-1" />
                    Deny
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {/* Org Interest Requests (global admin only) */}
      {user?.is_global_manager && (
        <div className="card">
          <OrgInterestRequests />
        </div>
      )}
    </div>
  )
}
