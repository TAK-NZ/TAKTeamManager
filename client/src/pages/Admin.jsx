import { useState, useEffect } from 'react'
import { UserGroupIcon, UsersIcon, CogIcon, PencilIcon, CheckIcon, XMarkIcon } from '@heroicons/react/24/outline'

export default function Admin({ user }) {
  const [organizationMappings, setOrganizationMappings] = useState({})
  const [roleDescriptions, setRoleDescriptions] = useState({})
  
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
    fetchConfig()
  }, [])
  const [editingColor, setEditingColor] = useState(null)
  const [tempValue, setTempValue] = useState('')

  const handleEditColor = (colorName) => {
    setEditingColor(colorName)
    setTempValue(organizationMappings[colorName])
  }

  const handleSaveColor = (colorName) => {
    setOrganizationMappings(prev => ({ ...prev, [colorName]: tempValue }))
    setEditingColor(null)
    setTempValue('')
  }

  const handleCancelEdit = () => {
    setEditingColor(null)
    setTempValue('')
  }

  if (!user?.isGlobalAdmin) {
    return (
      <div className="text-center py-12">
        <CogIcon className="mx-auto h-12 w-12 text-gray-400" />
        <h3 className="mt-2 text-sm font-medium text-gray-900">Access Denied</h3>
        <p className="mt-1 text-sm text-gray-500">
          You need global admin privileges to access this page.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          Global Administration
        </h1>
        <p className="text-gray-600">
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
              <p className="text-sm font-medium text-gray-500">Total Teams</p>
              <p className="text-2xl font-bold text-gray-900">-</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <UsersIcon className="h-8 w-8 text-green-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total Users</p>
              <p className="text-2xl font-bold text-gray-900">-</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <CogIcon className="h-8 w-8 text-blue-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">System Status</p>
              <p className="text-2xl font-bold text-green-600">Active</p>
            </div>
          </div>
        </div>
      </div>

      {/* Color Mappings */}
      <div className="card">
        <h2 className="text-lg font-medium text-gray-900 mb-4">TAK Color Mappings</h2>
        <p className="text-sm text-gray-600 mb-4">
          Configure how TAK color names map to organization names.
        </p>
        <div className="space-y-3">
          {Object.entries(organizationMappings).map(([colorName, orgName]) => (
            <div key={colorName} className="border rounded p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-gray-900">{colorName}</span>
                {editingColor === colorName ? (
                  <div className="flex space-x-2">
                    <button
                      onClick={() => handleSaveColor(colorName)}
                      className="text-green-600 hover:text-green-900"
                    >
                      <CheckIcon className="h-4 w-4" />
                    </button>
                    <button
                      onClick={handleCancelEdit}
                      className="text-red-600 hover:text-red-900"
                    >
                      <XMarkIcon className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => handleEditColor(colorName)}
                    className="text-primary-600 hover:text-primary-900"
                  >
                    <PencilIcon className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div>
                {editingColor === colorName ? (
                  <input
                    type="text"
                    value={tempValue}
                    onChange={(e) => setTempValue(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Organization name"
                  />
                ) : (
                  <span className="text-gray-900">{orgName}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Role Descriptions */}
      <div className="card">
        <h2 className="text-lg font-medium text-gray-900 mb-4">TAK Role Descriptions</h2>
        <p className="text-sm text-gray-600 mb-4">
          Configure descriptions for TAK roles that appear as tooltips on the dashboard.
        </p>
        <div className="space-y-3">
          {Object.entries(roleDescriptions).map(([roleName, description]) => (
            <div key={roleName} className="border rounded p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-gray-900">{roleName}</span>
                {editingColor === roleName ? (
                  <div className="flex space-x-2">
                    <button
                      onClick={() => handleSaveColor(roleName)}
                      className="text-green-600 hover:text-green-900"
                    >
                      <CheckIcon className="h-4 w-4" />
                    </button>
                    <button
                      onClick={handleCancelEdit}
                      className="text-red-600 hover:text-red-900"
                    >
                      <XMarkIcon className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => handleEditColor(roleName)}
                    className="text-primary-600 hover:text-primary-900"
                  >
                    <PencilIcon className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div>
                {editingColor === roleName ? (
                  <textarea
                    value={tempValue}
                    onChange={(e) => setTempValue(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Role description"
                    rows={2}
                  />
                ) : (
                  <span className="text-gray-900">{description || 'No description set'}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Admin Actions */}
      <div className="card">
        <h2 className="text-lg font-medium text-gray-900 mb-4">Admin Actions</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button className="btn-primary">
            Create Top-Level Team
          </button>
          <button className="btn-secondary">
            Manage Global Settings
          </button>
          <button className="btn-secondary">
            View System Logs
          </button>
          <button className="btn-secondary">
            Export Data
          </button>
        </div>
      </div>
    </div>
  )
}