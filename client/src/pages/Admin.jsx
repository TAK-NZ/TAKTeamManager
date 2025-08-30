import { useState, useEffect } from 'react'
import { UserGroupIcon, UsersIcon, CogIcon, PencilIcon, CheckIcon, XMarkIcon } from '@heroicons/react/24/outline'
import axios from 'axios'

export default function Admin({ user }) {
  const [organizationMappings, setOrganizationMappings] = useState({})
  const [roleDescriptions, setRoleDescriptions] = useState({})
  const [stats, setStats] = useState({ totalUsers: 0, totalTeams: 0 })
  const [syncStatus, setSyncStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)
  
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await axios.get('/api/config/color-mappings', {
          headers: {
            Authorization: `Bearer ${localStorage.getItem('token')}`
          }
        })
        setOrganizationMappings(response.data.colorMappings)
        setRoleDescriptions(response.data.roleDescriptions)
      } catch (error) {
        console.error('Failed to fetch config:', error)
      }
    }

    const fetchStats = async () => {
      try {
        const usersResponse = await axios.get('/api/users', {
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
        })
        const teamsResponse = await axios.get('/api/teams/my-teams', {
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
        })
        
        setStats({
          totalUsers: usersResponse.data.users?.length || 0,
          totalTeams: teamsResponse.data.teams?.length || 0
        })
      } catch (error) {
        console.error('Failed to fetch stats:', error)
      }
    }

    const fetchSyncStatus = async () => {
      try {
        const response = await axios.get('/api/sync/status', {
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
        })
        setSyncStatus(response.data)
      } catch (error) {
        console.error('Failed to fetch sync status:', error)
      }
    }

    fetchConfig()
    fetchStats()
    fetchSyncStatus()
  }, [])
  const [activeTab, setActiveTab] = useState('colors')
  const [editingColor, setEditingColor] = useState(null)
  const [editingRole, setEditingRole] = useState(null)
  const [tempColorValue, setTempColorValue] = useState('')
  const [tempRoleValue, setTempRoleValue] = useState('')

  const handleEditColor = (colorName) => {
    setEditingColor(colorName)
    setTempColorValue(organizationMappings[colorName])
  }

  const handleSaveColor = (colorName) => {
    setOrganizationMappings(prev => ({ ...prev, [colorName]: tempColorValue }))
    setEditingColor(null)
    setTempColorValue('')
  }

  const handleCancelColorEdit = () => {
    setEditingColor(null)
    setTempColorValue('')
  }

  const handleEditRole = (roleName) => {
    setEditingRole(roleName)
    setTempRoleValue(roleDescriptions[roleName])
  }

  const handleSaveRole = (roleName) => {
    setRoleDescriptions(prev => ({ ...prev, [roleName]: tempRoleValue }))
    setEditingRole(null)
    setTempRoleValue('')
  }

  const handleCancelRoleEdit = () => {
    setEditingRole(null)
    setTempRoleValue('')
  }

  const triggerManualSync = async () => {
    setSyncing(true)
    try {
      await axios.post('/api/sync/users', {}, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      })
      // Refresh sync status after a short delay
      setTimeout(async () => {
        const response = await axios.get('/api/sync/status', {
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
        })
        setSyncStatus(response.data)
        setSyncing(false)
      }, 2000)
    } catch (error) {
      console.error('Failed to trigger sync:', error)
      setSyncing(false)
    }
  }

  if (!user?.isAdmin) {
    return (
      <div className="text-center py-12">
        <CogIcon className="mx-auto h-12 w-12 text-gray-400" />
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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Global Administration
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          Manage the TAK Team Manager system and create top-level teams.
        </p>
      </div>

      {/* Admin Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <UserGroupIcon className="h-8 w-8 text-primary-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Teams</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.totalTeams}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <UsersIcon className="h-8 w-8 text-green-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Users</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.totalUsers}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <CogIcon className="h-8 w-8 text-blue-600" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500 dark:text-gray-400">User Sync</p>
                <div className="flex items-center space-x-2">
                  <p className={`text-sm font-bold ${
                    syncStatus?.status === 'success' ? 'text-green-600' :
                    syncStatus?.status === 'running' || syncing ? 'text-blue-600' :
                    syncStatus?.status === 'error' ? 'text-red-600' : 'text-gray-600'
                  }`}>
                    {syncing ? 'Syncing...' :
                     syncStatus?.status === 'success' ? 'Synced' :
                     syncStatus?.status === 'running' ? 'Running' :
                     syncStatus?.status === 'error' ? 'Error' : 'Unknown'}
                  </p>
                  {syncStatus?.last_sync && !syncing && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {new Date(syncStatus.last_sync).toLocaleTimeString()}
                    </p>
                  )}
                </div>
              </div>
            </div>
            <button
              onClick={triggerManualSync}
              disabled={syncing || syncStatus?.status === 'running'}
              className="btn-secondary text-xs px-3 py-1 disabled:opacity-50"
            >
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>
        </div>
      </div>

      {/* Configuration Tabs */}
      <div className="card">
        <div className="border-b border-gray-200 dark:border-gray-700">
          <nav className="-mb-px flex space-x-8">
            <button
              onClick={() => setActiveTab('colors')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'colors'
                  ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
              }`}
            >
              Color Mappings
            </button>
            <button
              onClick={() => setActiveTab('roles')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'roles'
                  ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
              }`}
            >
              Role Descriptions
            </button>
          </nav>
        </div>

        <div className="mt-4">
          {activeTab === 'colors' && (
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                Configure how TAK color names map to organization names.
              </p>
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-700">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Color
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Organization
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                  {Object.entries(organizationMappings).map(([colorName, orgName]) => (
                    <tr key={colorName}>
                      <td className="px-3 py-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                        {colorName}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
                        {editingColor === colorName ? (
                          <input
                            type="text"
                            value={tempColorValue}
                            onChange={(e) => setTempColorValue(e.target.value)}
                            className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                          />
                        ) : (
                          orgName || 'Not set'
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {editingColor === colorName ? (
                          <div className="flex justify-end space-x-1">
                            <button onClick={() => handleSaveColor(colorName)} className="text-green-600 hover:text-green-900">
                              <CheckIcon className="h-4 w-4" />
                            </button>
                            <button onClick={handleCancelColorEdit} className="text-red-600 hover:text-red-900">
                              <XMarkIcon className="h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <button onClick={() => handleEditColor(colorName)} className="text-primary-600 hover:text-primary-900">
                            <PencilIcon className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'roles' && (
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                Configure descriptions for TAK roles that appear as tooltips.
              </p>
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-700">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Role
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Description
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                  {Object.entries(roleDescriptions).map(([roleName, description]) => (
                    <tr key={roleName}>
                      <td className="px-3 py-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                        {roleName}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
                        {editingRole === roleName ? (
                          <textarea
                            value={tempRoleValue}
                            onChange={(e) => setTempRoleValue(e.target.value)}
                            className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                            rows={2}
                          />
                        ) : (
                          description || 'No description set'
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {editingRole === roleName ? (
                          <div className="flex justify-end space-x-1">
                            <button onClick={() => handleSaveRole(roleName)} className="text-green-600 hover:text-green-900">
                              <CheckIcon className="h-4 w-4" />
                            </button>
                            <button onClick={handleCancelRoleEdit} className="text-red-600 hover:text-red-900">
                              <XMarkIcon className="h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <button onClick={() => handleEditRole(roleName)} className="text-primary-600 hover:text-primary-900">
                            <PencilIcon className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>


    </div>
  )
}