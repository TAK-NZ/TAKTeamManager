import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { teamsAPI } from '../services/api'

/**
 * region-channel-tiers: Response/Support channel-access flag editor for an
 * Organisation, Global_Manager-only.
 *
 * Mirrors `OrgDomainManager`'s shape deliberately: its OWN independent
 * fetch is unnecessary here (the Organisation row -- and therefore its
 * current `response_channel_access`/`support_channel_access` values -- is
 * already available as the `org` prop from the parent dialog's own
 * `team`/`editingTeam`), but its SAVE is kept independent, via
 * `teamsAPI.updateChannelAccess`, a route deliberately SEPARATE from the
 * main Team_Settings form's `teamsAPI.update` call
 * (`PUT /api/teams/:teamId/channel-access`, gated by
 * `team:channel_access:manage` -- Global_Manager-only, no Team_Admin
 * fallback, unlike `team:update`). Folding this into the main form's
 * submit would mean either sending these two fields through a permission
 * boundary that does not grant them (a Team_Admin's otherwise-valid save
 * would 403 on a field they never touched) or bypassing that boundary
 * entirely -- keeping the two saves separate is what lets a Team_Admin
 * keep editing everything else about their Organisation while these two
 * flags stay reachable only to a Global_Manager.
 *
 * Rendered ONLY when ALL of: editing an EXISTING team (an Organisation
 * must already exist -- there is no `id` to call this endpoint against
 * otherwise), that team IS an Organisation (`!team.parent_team_id`), and
 * the CURRENT USER is a Global_Manager. The gate is applied by the
 * caller (`TeamFormDialog`), matching `OrgDomainManager`'s own
 * `isAdmin`-gated, Organisation-only convention -- this component itself
 * additionally no-ops (`isGlobalManager` false) as defense in depth.
 *
 * @param {{ org: object, isGlobalManager: boolean, onSaved: (updatedTeam: object) => void }} props
 */
export default function ChannelAccessManager({ org, isGlobalManager, onSaved }) {
  const [responseChannelAccess, setResponseChannelAccess] = useState(Boolean(org?.response_channel_access))
  const [supportChannelAccess, setSupportChannelAccess] = useState(Boolean(org?.support_channel_access))
  const [saving, setSaving] = useState(false)
  // The last-known-saved baseline this component compares against for its
  // `dirty` state, updated in TWO places: the seeding effect below (when
  // the Organisation being edited changes) AND a successful save's own
  // response (see handleSave). The second update matters concretely:
  // unlike the main Team_Settings form's submit (which always closes the
  // dialog via `onClose()`, so `org` is guaranteed stale-free on next
  // open), this component's save does NOT close the dialog -- the parent
  // page's `onSaved` may or may not refresh the `org` prop this component
  // was handed, and this component must not assume it will. Comparing
  // against a baseline THIS component owns and updates itself means the
  // "Save Changes" button correctly disappears immediately after a
  // successful save regardless of what the parent page does with `org`
  // afterward.
  const [savedBaseline, setSavedBaseline] = useState({
    responseChannelAccess: Boolean(org?.response_channel_access),
    supportChannelAccess: Boolean(org?.support_channel_access)
  })

  // Re-seeds from the Organisation's CURRENT stored values whenever the
  // Organisation being edited changes (switching which team the parent
  // dialog is open for) -- mirrors TeamFormDialog's own edit-mode seeding
  // effect, but scoped to just these two fields since this component
  // owns its own state independently of `formData`.
  useEffect(() => {
    const seeded = {
      responseChannelAccess: Boolean(org?.response_channel_access),
      supportChannelAccess: Boolean(org?.support_channel_access)
    }
    setResponseChannelAccess(seeded.responseChannelAccess)
    setSupportChannelAccess(seeded.supportChannelAccess)
    setSavedBaseline(seeded)
  }, [org?.id, org?.response_channel_access, org?.support_channel_access])

  if (!isGlobalManager) return null

  const dirty =
    responseChannelAccess !== savedBaseline.responseChannelAccess ||
    supportChannelAccess !== savedBaseline.supportChannelAccess

  const handleSave = async () => {
    setSaving(true)
    try {
      const response = await teamsAPI.updateChannelAccess(org.id, {
        responseChannelAccess,
        supportChannelAccess
      })
      setSavedBaseline({ responseChannelAccess, supportChannelAccess })
      onSaved(response.data.team)
      toast.success('Channel access saved')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save channel access')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card">
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">Response/Support Channel Access</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Controls whether members of this Organisation (and its Sub-teams) are synced into the
        Response (Emergency_Response, ES-only) and Support (all-agency) region channels. Global admin only.
      </p>

      {/* Bugfix (mobile tap target too small): the outer element of each
          row is now the `<label>` itself (was a plain `<div>` with the
          checkbox and a separate `<label>` as siblings), so tapping
          anywhere in the row -- not just the bare 16px checkbox square
          -- toggles the field. `-m-2 p-2` enlarges the hit box without
          changing the row's own visible size (same technique
          TeamFormDialog.jsx's checkboxes use). */}
      <div className="space-y-1 mb-4">
        <label htmlFor="responseChannelAccess" className="flex items-start -m-2 p-2 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50">
          <input
            type="checkbox"
            id="responseChannelAccess"
            checked={responseChannelAccess}
            onChange={(e) => setResponseChannelAccess(e.target.checked)}
            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded mt-1"
          />
          <span className="ml-3 text-sm text-gray-700 dark:text-gray-300 font-medium">
            Response channel access
            <p className="text-xs text-gray-500 dark:text-gray-400 font-normal">
              Emergency services coordination channels, inner circle. Defaults to off for a new Organisation.
            </p>
          </span>
        </label>
        <label htmlFor="supportChannelAccess" className="flex items-start -m-2 p-2 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50">
          <input
            type="checkbox"
            id="supportChannelAccess"
            checked={supportChannelAccess}
            onChange={(e) => setSupportChannelAccess(e.target.checked)}
            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded mt-1"
          />
          <span className="ml-3 text-sm text-gray-700 dark:text-gray-300 font-medium">
            Support channel access
            <p className="text-xs text-gray-500 dark:text-gray-400 font-normal">
              All-agency coordination channels, outer circle. Defaults to on for a new Organisation.
            </p>
          </span>
        </label>
      </div>

      {dirty && (
        <button
          type="button"
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
