import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { UserGroupIcon, UsersIcon, ClipboardDocumentListIcon } from '@heroicons/react/24/outline'
import { teamsAPI, requestsAPI } from '../services/api'

export default function Dashboard({ user }) {
  const [stats, setStats] = useState({ teams: 0, requests: 0 })
  const [recentTeams, setRecentTeams] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [teamsResponse, requestsResponse] = await Promise.all([
          teamsAPI.getMyTeams(),
          requestsAPI.getPending().catch(() => ({ data: { requests: [] } }))
        ])
        
        setRecentTeams(teamsResponse.data.teams.slice(0, 5))
        setStats({
          teams: teamsResponse.data.teams.length,
          requests: requestsResponse.data.requests.length
        })
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

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
        <h1 className="text-2xl font-bold text-gray-900">
          Welcome back, {user.first_name}!
        </h1>
        <p className="text-gray-600">
          Manage your TAK teams and channels from your dashboard.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <UserGroupIcon className="h-8 w-8 text-primary-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">My Teams</p>
              <p className="text-2xl font-bold text-gray-900">{stats.teams}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <ClipboardDocumentListIcon className="h-8 w-8 text-yellow-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Pending Requests</p>
              <p className="text-2xl font-bold text-gray-900">{stats.requests}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <UsersIcon className="h-8 w-8 text-green-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total Channels</p>
              <p className="text-2xl font-bold text-gray-900">
                {recentTeams.reduce((acc, team) => acc + (team.channels?.length || 0), 0)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Teams */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-medium text-gray-900">My Teams</h2>
          <Link to="/teams" className="text-sm text-primary-600 hover:text-primary-500">
            View all
          </Link>
        </div>
        
        {recentTeams.length === 0 ? (
          <p className="text-gray-500 text-center py-8">
            You're not a member of any teams yet.
          </p>
        ) : (
          <div className="space-y-3">
            {recentTeams.map((team) => (
              <div key={team.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div>
                  <h3 className="font-medium text-gray-900">{team.name}</h3>
                  <p className="text-sm text-gray-500">
                    Role: {team.role} • {team.description || 'No description'}
                  </p>
                </div>
                <Link
                  to={`/teams/${team.id}`}
                  className="text-sm text-primary-600 hover:text-primary-500"
                >
                  View
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick Actions */}
      {stats.requests > 0 && (
        <div className="card bg-yellow-50 border-yellow-200">
          <div className="flex items-center">
            <ClipboardDocumentListIcon className="h-6 w-6 text-yellow-600" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-yellow-800">
                You have {stats.requests} pending request{stats.requests !== 1 ? 's' : ''}
              </h3>
              <p className="text-sm text-yellow-700">
                Review team access requests from new users.
              </p>
            </div>
            <div className="ml-auto">
              <Link to="/requests" className="btn-primary">
                Review Requests
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}