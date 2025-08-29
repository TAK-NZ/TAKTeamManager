import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { PlusIcon, UsersIcon } from '@heroicons/react/24/outline'
import { teamsAPI, channelsAPI } from '../services/api'

export default function TeamDetail() {
  const { teamId } = useParams()
  const [team, setTeam] = useState(null)
  const [members, setMembers] = useState([])
  const [channels, setChannels] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchTeamData = async () => {
      try {
        const [teamResponse, channelsResponse] = await Promise.all([
          teamsAPI.getById(teamId),
          channelsAPI.getByTeam(teamId)
        ])
        
        setTeam(teamResponse.data.team)
        setMembers(teamResponse.data.members)
        setChannels(channelsResponse.data.channels)
      } catch (error) {
        console.error('Failed to fetch team data:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchTeamData()
  }, [teamId])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    )
  }

  if (!team) {
    return (
      <div className="card text-center py-12">
        <h3 className="text-lg font-medium text-gray-900 mb-2">Team not found</h3>
        <p className="text-gray-500">The team you're looking for doesn't exist or you don't have access.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Team Header */}
      <div className="card">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">{team.name}</h1>
            <p className="text-gray-600">{team.description || 'No description provided'}</p>
          </div>
          <div className="flex space-x-3">
            <button className="btn-secondary">
              <PlusIcon className="h-5 w-5 mr-2" />
              Add Member
            </button>
            <button className="btn-primary">
              <PlusIcon className="h-5 w-5 mr-2" />
              Create Channel
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Members */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium text-gray-900 flex items-center">
              <UsersIcon className="h-5 w-5 mr-2" />
              Members ({members.length})
            </h2>
          </div>
          
          <div className="space-y-3">
            {members.map((member) => (
              <div key={member.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div>
                  <p className="font-medium text-gray-900">
                    {member.first_name} {member.last_name}
                  </p>
                  <p className="text-sm text-gray-500">{member.email}</p>
                </div>
                <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                  member.role === 'admin' 
                    ? 'bg-blue-100 text-blue-800' 
                    : 'bg-gray-100 text-gray-800'
                }`}>
                  {member.role}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Channels */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium text-gray-900">
              Channels ({channels.length})
            </h2>
          </div>
          
          <div className="space-y-3">
            {channels.length === 0 ? (
              <p className="text-gray-500 text-center py-8">
                No channels created yet.
              </p>
            ) : (
              channels.map((channel) => (
                <div key={channel.id} className="p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-gray-900 flex items-center">
                        {channel.display_name}
                        {channel.is_primary && (
                          <span className="ml-2 px-2 py-1 text-xs bg-green-100 text-green-800 rounded-full">
                            Primary
                          </span>
                        )}
                      </p>
                      <p className="text-sm text-gray-500">{channel.description}</p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}