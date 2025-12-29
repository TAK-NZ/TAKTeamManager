import { useState, useEffect } from 'react'
import { CheckIcon, XMarkIcon, ClockIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { requestsAPI } from '../services/api'

export default function Requests() {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchRequests = async () => {
      try {
        const response = await requestsAPI.getPending()
        setRequests(response.data.requests)
      } catch (error) {
        console.error('Failed to fetch requests:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchRequests()
  }, [])

  const handleApprove = async (requestId) => {
    try {
      const additionalDetails = prompt('Any additional details for the user? (optional)');
      await requestsAPI.approveRequest(requestId, { additionalDetails: additionalDetails || '' })
      setRequests(requests.filter(r => r.id !== requestId))
      toast.success('Request approved successfully')
    } catch (error) {
      toast.error('Failed to approve request')
    }
  }

  const handleDeny = async (requestId) => {
    const denialReason = prompt('Please provide a reason for denial:');
    if (!denialReason) return;
    
    try {
      await requestsAPI.denyRequest(requestId, { denialReason })
      setRequests(requests.filter(r => r.id !== requestId))
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
                    <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                      {request.first_name} {request.last_name}
                    </h3>
                    <span className="px-2 py-1 text-xs font-medium bg-yellow-100 text-yellow-800 rounded-full">
                      Pending
                    </span>
                  </div>
                  
                  <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                    <p><span className="font-medium">Email:</span> {request.email}</p>
                    <p><span className="font-medium">Requested Team:</span> {request.team_name}</p>
                    <p><span className="font-medium">Submitted:</span> {new Date(request.created_at).toLocaleDateString()}</p>
                  </div>
                  
                  <div className="mt-4">
                    <p className="font-medium text-gray-900 dark:text-gray-100 mb-2">Reason for Access:</p>
                    <p className="text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700 p-3 rounded-lg">{request.reason}</p>
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
    </div>
  )
}