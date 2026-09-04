import { useState, useEffect, useCallback } from 'react'
import { PlusIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { orgDomainsAPI } from '../services/api'
import toast from 'react-hot-toast'

/**
 * OrgDomainManager — domain list editor for org admins. Shows current
 * allowed domains as a list with remove (X) buttons, an input + Add button
 * to add new domains, and a Save button that PUTs the whole list.
 *
 * Only shown on the org (root team) TeamDetail page for admins.
 *
 * @param {{ orgId: number, isAdmin: boolean }} props
 */
export default function OrgDomainManager({ orgId, isAdmin }) {
  const [domains, setDomains] = useState([])
  const [newDomain, setNewDomain] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  // Wrapped in useCallback (stable per orgId) so the effect below can list
  // it as a dependency without re-running on every render -- satisfies
  // react-hooks/exhaustive-deps without changing behaviour (the effect
  // still fetches once per orgId/isAdmin change).
  const fetchDomains = useCallback(async () => {
    setLoading(true)
    try {
      const res = await orgDomainsAPI.get(orgId)
      setDomains(res.data.domains || [])
      setDirty(false)
    } catch (err) {
      console.error('Failed to fetch org domains:', err)
    } finally {
      setLoading(false)
    }
  }, [orgId])

  useEffect(() => {
    if (!orgId || !isAdmin) return
    fetchDomains()
  }, [orgId, isAdmin, fetchDomains])

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
      await orgDomainsAPI.update(orgId, domains)
      setDirty(false)
      toast.success('Domains saved')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save domains')
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

  if (!isAdmin) return null

  if (loading) {
    return (
      <div className="card">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Allowed Email Domains</h3>
        <div className="animate-pulse h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/2"></div>
      </div>
    )
  }

  return (
    <div className="card">
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">Allowed Email Domains</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Only users with email addresses from these domains can sign up to teams in this organisation.
        Leave empty to allow any email domain.
      </p>

      {/* Domain list. Bugfix (mobile tap target too small): the remove
          button's hit area is enlarged via `-m-2 p-2` (negative margin
          cancelling the padding's own layout footprint, same technique
          InfoTooltip.jsx uses) rather than a plain `p-2`, which would
          have inflated every pill's own rendered height/width -- this
          way the chip's visual size is unchanged, only the invisible
          tap/hover area around the X icon grows to ~32px. `gap-2` on
          the wrapping row (8px) leaves enough clearance that the
          enlarged area of one chip's remove button doesn't visually
          overlap its neighbour. */}
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
                className="-m-2 p-2 rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
                title="Remove domain"
                aria-label={`Remove domain ${domain}`}
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            </span>
          ))}
        </div>
      )}

      {domains.length === 0 && (
        <p className="text-sm text-gray-400 dark:text-gray-500 mb-4 italic">
          No domain restrictions — any email domain is allowed.
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
          placeholder="fenz.govt.nz"
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
