import { useState, useEffect, useRef } from 'react'
import { UserGroupIcon, UsersIcon, CogIcon, PencilIcon, CheckIcon, XMarkIcon, ArrowUpTrayIcon } from '@heroicons/react/24/outline'
import { configAPI, usersAPI, teamsAPI, syncAPI, bulkImportAPI } from '../services/api'
import { formatDateTime } from '../utils/dateFormat'
import ExcludedDomainsManager from '../components/ExcludedDomainsManager'

export default function Admin({ user }) {
  const [organizationMappings, setOrganizationMappings] = useState({})
  const [roleDescriptions, setRoleDescriptions] = useState({})
  const [stats, setStats] = useState({ totalUsers: 0, totalTeams: 0 })
  const [syncStatus, setSyncStatus] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [siteConfig, setSiteConfig] = useState([])
  const [editingConfig, setEditingConfig] = useState(null)
  const [tempConfigValue, setTempConfigValue] = useState('')
  
  useEffect(() => {
    // Every raw axios.* call in this file previously sent
    // `Authorization: Bearer ${localStorage.getItem('token')}` -- but this
    // app has never stored a token in localStorage (auth lives solely in
    // the httpOnly `tak_session` cookie set by the server; see
    // server/middleware/auth.js), so that header was always literally
    // "Bearer null", and none of these raw calls set
    // `withCredentials: true` either, so the real session cookie was never
    // sent. Every one of these calls has been failing with 401 the entire
    // time -- which is why the whole page's stats cards and the Color
    // Mappings/Role Descriptions tabs never actually loaded real data.
    // Replaced throughout with the shared, correctly-configured `api`
    // axios instance via its API wrapper functions.
    const fetchConfig = async () => {
      try {
        const response = await configAPI.getColorMappings()
        setOrganizationMappings(response.data.colorMappings)
        setRoleDescriptions(response.data.roleDescriptions)
      } catch (error) {
        console.error('Failed to fetch config:', error)
      }
    }

    const fetchStats = async () => {
      try {
        const [usersResponse, teamsResponse] = await Promise.all([
          usersAPI.getAll(),
          teamsAPI.getMyTeams()
        ])
        
        // Both endpoints are paginated (default pageSize 50 -- see
        // server/middleware/pagination.js) -- use pagination.total, not
        // the returned array's .length, so this stat doesn't silently
        // undercount once there are more than one page of users/teams.
        setStats({
          totalUsers: usersResponse.data.pagination?.total ?? usersResponse.data.users?.length ?? 0,
          totalTeams: teamsResponse.data.pagination?.total ?? teamsResponse.data.teams?.length ?? 0
        })
      } catch (error) {
        console.error('Failed to fetch stats:', error)
      }
    }

    const fetchSyncStatus = async () => {
      try {
        const response = await syncAPI.getStatus()
        setSyncStatus(response.data)
      } catch (error) {
        console.error('Failed to fetch sync status:', error)
      }
    }

    const fetchSiteConfig = async () => {
      try {
        const response = await configAPI.getAll()
        setSiteConfig(response.data.config)
      } catch (error) {
        console.error('Failed to fetch site config:', error)
      }
    }

    fetchConfig()
    fetchStats()
    fetchSyncStatus()
    fetchSiteConfig()
  }, [])
  const [activeTab, setActiveTab] = useState('colors')
  const [editingColor, setEditingColor] = useState(null)
  const [editingRole, setEditingRole] = useState(null)
  const [tempColorValue, setTempColorValue] = useState('')
  const [tempRoleValue, setTempRoleValue] = useState('')

  // --- Bulk Import (Team CSV) state (Requirements 9.14, 14.1) ---
  const [bulkImportFile, setBulkImportFile] = useState(null)
  const [bulkImporting, setBulkImporting] = useState(false)
  const [bulkImportResult, setBulkImportResult] = useState(null)
  const [bulkImportError, setBulkImportError] = useState(null)
  const bulkImportFileInputRef = useRef(null)

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

  const handleEditConfig = (configKey) => {
    const config = siteConfig.find(c => c.config_key === configKey)
    setEditingConfig(configKey)
    setTempConfigValue(config?.config_value || '')
  }

  const handleSaveConfig = async (configKey) => {
    try {
      await configAPI.update(configKey, { value: tempConfigValue })
      setSiteConfig(prev => prev.map(c => 
        c.config_key === configKey 
          ? { ...c, config_value: tempConfigValue }
          : c
      ))
      setEditingConfig(null)
      setTempConfigValue('')
    } catch (error) {
      console.error('Failed to update config:', error)
    }
  }

  const handleCancelConfigEdit = () => {
    setEditingConfig(null)
    setTempConfigValue('')
  }

  const triggerManualSync = async () => {
    setSyncing(true)
    try {
      await syncAPI.triggerUserSync()
      // Refresh sync status after a short delay
      setTimeout(async () => {
        const response = await syncAPI.getStatus()
        setSyncStatus(response.data)
        setSyncing(false)
      }, 2000)
    } catch (error) {
      console.error('Failed to trigger sync:', error)
      setSyncing(false)
    }
  }

  const handleBulkImportFileChange = (e) => {
    setBulkImportFile(e.target.files?.[0] || null)
    setBulkImportResult(null)
    setBulkImportError(null)
  }

  const handleBulkImportUpload = async () => {
    if (!bulkImportFile) {
      return
    }
    setBulkImporting(true)
    setBulkImportResult(null)
    setBulkImportError(null)
    try {
      const formData = new FormData()
      formData.append('csv', bulkImportFile)
      const response = await bulkImportAPI.importTeams(formData)
      setBulkImportResult(response.data)
      setBulkImportFile(null)
      if (bulkImportFileInputRef.current) {
        bulkImportFileInputRef.current.value = ''
      }
    } catch (error) {
      console.error('Failed to import team CSV:', error)
      setBulkImportError(
        error.response?.data?.error || 'Failed to import team CSV. Please try again.'
      )
    } finally {
      setBulkImporting(false)
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
                      {formatDateTime(syncStatus.last_sync)}
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
            <button
              onClick={() => setActiveTab('site')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'site'
                  ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
              }`}
            >
              Site Content
            </button>
            <button
              onClick={() => setActiveTab('bulkImport')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'bulkImport'
                  ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
              }`}
            >
              Bulk Import
            </button>
            <button
              onClick={() => setActiveTab('excludedDomains')}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'excludedDomains'
                  ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
              }`}
            >
              Excluded Domains
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

          {activeTab === 'site' && (
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                Configure text content displayed on the request access page.
              </p>
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-700">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Setting
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Content
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                  {siteConfig.filter(config => config.config_key.startsWith('request_access')).map((config) => (
                    <tr key={config.config_key}>
                      <td className="px-3 py-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                        {config.description || config.config_key}
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
                        {editingConfig === config.config_key ? (
                          <textarea
                            value={tempConfigValue}
                            onChange={(e) => setTempConfigValue(e.target.value)}
                            className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                            rows={config.config_key === 'request_access_footer' ? 4 : 2}
                          />
                        ) : (
                          <div className="max-w-md truncate">{config.config_value}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {editingConfig === config.config_key ? (
                          <div className="flex justify-end space-x-1">
                            <button onClick={() => handleSaveConfig(config.config_key)} className="text-green-600 hover:text-green-900">
                              <CheckIcon className="h-4 w-4" />
                            </button>
                            <button onClick={handleCancelConfigEdit} className="text-red-600 hover:text-red-900">
                              <XMarkIcon className="h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <button onClick={() => handleEditConfig(config.config_key)} className="text-primary-600 hover:text-primary-900">
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

          {activeTab === 'bulkImport' && (
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                Import an entire Organisation's Team hierarchy from a CSV file. Download the template
                below for the expected columns, including how to reference a row's parent within the
                same file.
              </p>

              <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
                <input
                  ref={bulkImportFileInputRef}
                  type="file"
                  accept=".csv"
                  onChange={handleBulkImportFileChange}
                  className="text-sm text-gray-900 dark:text-gray-100 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-primary-50 file:text-primary-700 dark:file:bg-primary-900 dark:file:text-primary-300"
                />
                <button
                  onClick={handleBulkImportUpload}
                  disabled={!bulkImportFile || bulkImporting}
                  className="btn-primary flex items-center gap-2 disabled:opacity-50"
                >
                  <ArrowUpTrayIcon className="h-4 w-4" />
                  {bulkImporting ? 'Uploading...' : 'Upload Team CSV'}
                </button>
                <a
                  href="/templates/team-import-template.csv"
                  download
                  className="text-sm text-primary-600 hover:text-primary-900 dark:text-primary-400 dark:hover:text-primary-300 underline"
                >
                  Download CSV template
                </a>
              </div>

              {bulkImportError && (
                <div className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 p-3 mb-4">
                  <p className="text-sm text-red-700 dark:text-red-300">{bulkImportError}</p>
                </div>
              )}

              {bulkImportResult && bulkImportResult.rejected && (
                <div className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 p-3 mb-4">
                  <p className="text-sm font-medium text-red-800 dark:text-red-200 mb-2">
                    The entire import was rejected. No teams were created.
                  </p>
                  <ul className="list-disc list-inside space-y-1">
                    {bulkImportResult.results.map((wholeFileError, index) => (
                      <li key={index} className="text-sm text-red-700 dark:text-red-300">
                        {wholeFileError.error}
                        {wholeFileError.rowIds?.length > 0 && (
                          <> (rows: {wholeFileError.rowIds.join(', ')})</>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {bulkImportResult && !bulkImportResult.rejected && (
                <div>
                  <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
                    {bulkImportResult.successCount} succeeded, {bulkImportResult.failureCount} failed.
                  </p>
                  <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-700">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                          Row
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                          Status
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                          Message
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                      {bulkImportResult.results.map((rowResult) => (
                        <tr key={rowResult.row}>
                          <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
                            {rowResult.row}
                          </td>
                          <td className="px-3 py-2 text-sm">
                            {rowResult.success ? (
                              <span className="text-green-600 dark:text-green-400 font-medium">Success</span>
                            ) : (
                              <span className="text-red-600 dark:text-red-400 font-medium">Failed</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-sm text-gray-700 dark:text-gray-300">
                            {rowResult.success
                              ? `Team created (ID: ${rowResult.teamId})`
                              : rowResult.error}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeTab === 'excludedDomains' && (
            <ExcludedDomainsManager />
          )}
        </div>
      </div>


    </div>
  )
}