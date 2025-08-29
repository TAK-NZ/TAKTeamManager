import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { PlusIcon, UserGroupIcon } from '@heroicons/react/24/outline'
import { teamsAPI } from '../services/api'

export default function Teams() {
  const [teams, setTeams] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchTeams = async () => {
      try {
        const response = await teamsAPI.getMyTeams()
        setTeams(response.data.teams)
      } catch (error) {
        console.error('Failed to fetch teams:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchTeams()
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Teams</h1>
          <p className="text-gray-600">Manage your team memberships and create new teams.</p>
        </div>
        <button className="btn-primary flex items-center">
          <PlusIcon className="h-5 w-5 mr-2" />
          Create Team
        </button>
      </div>

      {teams.length === 0 ? (
        <div className="card text-center py-12">
          <UserGroupIcon className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No teams yet</h3>
          <p className="text-gray-500 mb-6">
            You're not a member of any teams. Create your first team or request access to an existing one.
          </p>
          <button className="btn-primary">Create Your First Team</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {teams.map((team) => (
            <div key={team.id} className="card hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-4">
                <div className="flex-1">
                  <h3 className="text-lg font-medium text-gray-900 mb-1">{team.name}</h3>
                  <p className="text-sm text-gray-500">{team.description || 'No description'}</p>
                </div>
                <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                  team.role === 'admin' 
                    ? 'bg-blue-100 text-blue-800' 
                    : 'bg-gray-100 text-gray-800'
                }`}>
                  {team.role}
                </span>
              </div>
              
              <div className="flex items-center justify-between">
                <div className="text-sm text-gray-500">
                  {team.member_count || 0} members
                </div>
                <Link
                  to={`/teams/${team.id}`}
                  className="text-sm text-primary-600 hover:text-primary-500 font-medium"
                >
                  View Details →
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}