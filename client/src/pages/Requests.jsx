import { useState, useEffect } from 'react'
import { CheckIcon, XMarkIcon, ClockIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { requestsAPI } from '../services/api'
import OrgInterestRequests from '../components/OrgInterestRequests'
import FormattedDate, { DATE_PRECISION, TOOLTIP_SIDES } from '../components/FormattedDate'

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

// Requirement 16.1: a `team_change` card names the Transferred_User and the
// Initiating_Admin. Both come from the server as separate first/last columns
// (`transferred_user_*` / `initiated_by_*` -- see server/routes/requests.js's
// enrichPendingRequests), either of which may be null, so joining them is a
// small pure helper rather than inline JSX.
export function formatPersonName(firstName, lastName) {
  return [firstName, lastName].filter(Boolean).join(' ').trim()
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
  // Denial reason modal state
  const [denyingRequestId, setDenyingRequestId] = useState(null)
  const [denialReason, setDenialReason] = useState('')

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
    // A `team_change` row shows no First Name / Last Name / Callsign Suffix
    // inputs, so it must not submit those fields either: on the server
    // `firstName`/`lastName` overwrite the request's `requested_*` columns
    // (which hold the Initiating_Admin's name on a Transfer_Request) and
    // `callsignSuffix` becomes the Callsign_Suffix applied to the
    // Transferred_User. Sending the seeded values would apply the
    // Initiating_Admin's suffix to the transferred member.
    const isTeamChange = requests.find((r) => r.id === requestId)?.request_type === 'team_change'
    try {
      await requestsAPI.approveRequest(requestId, isTeamChange ? {
        additionalDetails: ''
      } : {
        additionalDetails: '',
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
      if (isTeamChange) {
        // Requirement 16.6: a `team_change` card renders no Callsign Suffix
        // field to hang an inline error off, so its failures (a 400 suffix
        // conflict, a 409 stale or cross-Organisation rejection) surface as a
        // toast carrying the server's own message. The row stays in the list
        // either way, since nothing is removed before the await resolves.
        toast.error(error?.response?.data?.error || 'Failed to approve request')
      } else if (conflictMessage) {
        setCallsignSuffixErrorByRequestId((prev) => ({ ...prev, [requestId]: conflictMessage }))
      } else {
        toast.error('Failed to approve request')
      }
    }
  }

  const handleDeny = (requestId) => {
    setDenyingRequestId(requestId)
    setDenialReason('')
  }

  const confirmDeny = async () => {
    if (!denialReason.trim()) return
    try {
      await requestsAPI.denyRequest(denyingRequestId, { denialReason })
      clearRequestState(denyingRequestId)
      setDenyingRequestId(null)
      setDenialReason('')
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
                    {request.request_type === 'team_change' && (
                      <span className="px-2 py-1 text-xs font-medium bg-blue-100 text-blue-800 rounded-full">
                        Team Transfer
                      </span>
                    )}
                  </div>

                  {request.request_type === 'team_change' ? (
                    /* Requirement 16.1/16.3: a Transfer_Request describes an
                       existing user moving between two teams, so the card names
                       the Transferred_User (not `requester_*`, which on this row
                       holds the Initiating_Admin's values), both hierarchy paths,
                       and the admin-rights consequence of approval. The First
                       Name / Last Name / Callsign Suffix inputs are deliberately
                       absent -- they edit the Initiating_Admin's columns and are
                       meaningful only for `new_account`. */
                    <>
                      <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                        <p>
                          <span className="font-medium">Member:</span>{' '}
                          {formatPersonName(request.transferred_user_first_name, request.transferred_user_last_name)}
                        </p>
                        <p><span className="font-medium">Email:</span> {request.transferred_user_email}</p>
                        <p><span className="font-medium">Current Team:</span> {request.source_team_path}</p>
                        <p><span className="font-medium">Destination Team:</span> {request.team_path}</p>
                        <p>
                          <span className="font-medium">Requested By:</span>{' '}
                          {formatPersonName(request.initiated_by_first_name, request.initiated_by_last_name)}
                        </p>
                        {/* Criteria 2.1/2.3/3.8: the value renders through the one
                            shared Formatted_Date so it carries the Date_Tooltip,
                            with the string itself unchanged character for
                            character. This is a non-table Date_Render_Position --
                            a `<p>` inside a card -- and it deliberately takes the
                            same Sideways_Tooltip_Placement as the table cells, so
                            the application has ONE tooltip behaviour rather than
                            one per surrounding element type. `fallback=''` is the
                            Date_Format_Helpers' own default, which is what this
                            site renders today for an absent or unparseable value. */}
                        <p>
                          <span className="font-medium">Submitted:</span>{' '}
                          <FormattedDate
                            value={request.created_at}
                            fallback=""
                            precision={DATE_PRECISION.DATE}
                            side={TOOLTIP_SIDES.RIGHT}
                          />
                        </p>
                      </div>

                      <div className="mt-4">
                        <p className="font-medium text-gray-900 dark:text-gray-100 mb-2">Reason for Transfer:</p>
                        <p className="text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700 p-3 rounded-lg">{request.justification}</p>
                      </div>

                      <p className="mt-4 text-sm text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-900 p-3 rounded-lg">
                        Approving this transfer removes this member&apos;s admin rights in their current
                        team{request.source_team_path ? ` (${request.source_team_path})` : ''}. Admin rights
                        must be granted again in the destination team if required.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                        <p><span className="font-medium">Email:</span> {request.requester_email}</p>
                        <p><span className="font-medium">Requested Team:</span> {request.team_path || request.team_name}</p>
                        {/* The new_account card's own "Submitted" value, the second
                            of this page's two Date_Render_Position call sites, on
                            the same terms as the team_change one above. */}
                        <p>
                          <span className="font-medium">Submitted:</span>{' '}
                          <FormattedDate
                            value={request.created_at}
                            fallback=""
                            precision={DATE_PRECISION.DATE}
                            side={TOOLTIP_SIDES.RIGHT}
                          />
                        </p>
                      </div>

                      {/* account-lifecycle-management Requirement 5.2:
                          distinguishes a Reclaimable_Account match from an
                          ordinary brand-new-person request -- the same
                          amber-notice treatment the team_change card above
                          uses for its own admin-rights consequence, so both
                          cards' "worth a second look before approving"
                          notices read consistently. Additive: rendered only
                          when the server found an orphaned match
                          (`request.reclaimableAccount` is non-null), never
                          changes the request's own displayed type/badge. */}
                      {request.reclaimableAccount && (
                        <p className="mt-4 text-sm text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-900 p-3 rounded-lg">
                          This email matches a previous account whose Authentik identity no
                          longer exists (Account_Status: orphaned). Approving this request will
                          reclaim that existing account rather than creating a new one -- its
                          prior activity history is preserved, but its team membership and any
                          admin rights are NOT automatically restored; assign them fresh as part
                          of this approval.
                        </p>
                      )}

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
                            <p role="alert" className="text-red-600 dark:text-red-400 text-sm mt-1">
                              {callsignSuffixErrorByRequestId[request.id]}
                            </p>
                          )}
                        </div>
                      </div>
                    </>
                  )}
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

      {/* Denial reason modal */}
      {denyingRequestId && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="deny-request-title"
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6"
          >
            <h3 id="deny-request-title" className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
              Deny Request
            </h3>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Reason for denial
              </label>
              <textarea
                className="input w-full"
                value={denialReason}
                onChange={(e) => setDenialReason(e.target.value)}
                rows={3}
                placeholder="Please explain why this request is being denied..."
                autoFocus
              />
            </div>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => { setDenyingRequestId(null); setDenialReason('') }}
                className="btn-secondary px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeny}
                disabled={!denialReason.trim()}
                className="btn-danger text-sm disabled:opacity-50"
              >
                Deny Request
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
