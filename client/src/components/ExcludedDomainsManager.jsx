import { useState, useEffect } from 'react'
import { PlusIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { adminAPI } from '../services/api'
import toast from 'react-hot-toast'

/**
 * ExcludedDomainsManager — global admin panel for managing the list of
 * email domains excluded from org interest requests. Same pattern as
 * OrgDomainManager but uses admin endpoints.
 *
 * Rendered on the Admin page for global admins only.
 */
export default function ExcludedDomainsManager() {
  const [domains, setDomains] = useState([])
  const [newDomain, setNewDomain] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    fetchDomains()
  }, [])

  const fetchDomains = async () => {
    setLoading(true)
    try {
      const res = await adminAPI.getExcludedDomains()
      setDomains(res.data.domains || [])
      setDirty(false)
    } catch (err) {
      console.error('Failed to fetch excluded domains:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleAdd = () => {
    const trimmed = newDomain.trim().toLowerCase()
    if (!trimmed) return
    if (domains.includes(trimmed)) {
      toast.error('Domain already in list')
      return
    }
    setDomains([...domains, trimmed])
    setNewDomain('')
    setDirty(true)
  }

  const handleRemove = (domain) => {
    setDomains(domains.filter(d => d !== domain))
    setDirty(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await adminAPI.updateExcludedDomains(domains)
      setDirty(false)
      toast.success('Excluded domains saved')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save excluded domains')
    } finally {
      setSaving(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAdd()
    }
  }

  if (loading) {
    return (
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Excluded Email Domains</h3>
        <div className="animate-pulse h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/2"></div>
      </div>
    )
  }

  return (
    <div>
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">Excluded Email Domains</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Emails from these domains will be blocked from submitting org interest requests.
        This does not affect regular team sign-up.
      </p>

      {/* Domain list */}
      {domains.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {domains.map((domain) => (
            <span
              key={domain}
              className="inline-flex items-center gap-1 px-3 py-1 bg-gray-100 dark:bg-gray-700 rounded-full text-sm text-gray-700 dark:text-gray-300"
            >
              {domain}
              <button
                onClick={() => handleRemove(domain)}
                className="text-gray-400 hover:text-red-500"
                title="Remove domain"
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            </span>
          ))}
        </div>
      )}

      {domains.length === 0 && (
        <p className="text-sm text-gray-400 dark:text-gray-500 mb-4 italic">
          No excluded domains configured.
        </p>
      )}

      {/* Add domain input */}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          className="input flex-1"
          value={newDomain}
          onChange={(e) => setNewDomain(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="gmail.com"
        />
        <button
          onClick={handleAdd}
          disabled={!newDomain.trim()}
          className="btn-secondary text-sm flex items-center gap-1"
        >
          <PlusIcon className="h-4 w-4" />
          Add
        </button>
      </div>

      {/* Save button */}
      {dirty && (
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn-primary text-sm"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      )}
    </div>
  )
}
