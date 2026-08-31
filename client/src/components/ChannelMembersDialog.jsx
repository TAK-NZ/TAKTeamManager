import { useState, useEffect, useCallback } from 'react'
import { XMarkIcon, CheckIcon, TrashIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { channelsAPI } from '../services/api'

/**
 * Bugfix (Channels tab had no manage-members action): manages a single
 * CUSTOM channel's members -- lists current members with their
 * permission, lets an admin change a member's permission or remove
 * them, and lets an admin add a team member who isn't on the channel
 * yet. Mirrors `UserDevicesModal.jsx`'s shape (full-bleed-on-mobile
 * modal, own fetch/loading/error state, `Escape` closes) since this is
 * the same kind of "manage a related list for one row" modal.
 *
 * Reuses the exact read/write/read_write toggle-button convention the
 * Create Custom Channel dialog (`TeamDetail.jsx`) already established
 * for selecting a member's permission, so this dialog and that one look
 * like the same feature rather than two different pickers for the same
 * concept.
 *
 * `teamMembers` (the team's full Member_List, already held by
 * `TeamDetail.jsx`) is passed in rather than re-fetched here, so adding
 * a member offers the same roster the Create Custom Channel dialog
 * already draws from.
 *
 * @param {object} props
 * @param {{id: number, display_name: string}} props.channel the channel
 *   being managed.
 * @param {Array<{id: number, first_name: string, last_name: string, email: string}>} props.teamMembers
 * @param {() => void} props.onClose
 * @param {() => void} [props.onMembershipChanged] invoked after an
 *   add/remove/permission-change succeeds, so the parent can refresh
 *   the Channels tab's own member_count.
 */
export default function ChannelMembersDialog({ channel, teamMembers, onClose, onMembershipChanged }) {
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedNewMemberId, setSelectedNewMemberId] = useState('')
  const [selectedNewMemberPermission, setSelectedNewMemberPermission] = useState('read_write')
  const [savingUserId, setSavingUserId] = useState(null)
  const [addingMember, setAddingMember] = useState(false)

  const fetchMembers = useCallback(async () => {
    setLoading(true)
    try {
      const response = await channelsAPI.getMembers(channel.id)
      setMembers(response.data?.members ?? [])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch channel members:', err)
      setMembers([])
      setError(err.response?.data?.error || 'Failed to load this channel\'s members. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [channel.id])

  useEffect(() => {
    fetchMembers()
  }, [fetchMembers])

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  const availableMembers = teamMembers.filter(
    (teamMember) => !members.some((member) => member.id === teamMember.id)
  )

  const handleChangePermission = async (userId, permission) => {
    setSavingUserId(userId)
    try {
      await channelsAPI.addMember(channel.id, { userId, permission })
      await fetchMembers()
      if (onMembershipChanged) onMembershipChanged()
      toast.success('Channel permission updated')
    } catch (err) {
      console.error('Failed to update channel member permission:', err)
      toast.error('Failed to update permission: ' + (err.response?.data?.error || err.message))
    } finally {
      setSavingUserId(null)
    }
  }

  const handleRemoveMember = async (userId) => {
    setSavingUserId(userId)
    try {
      await channelsAPI.removeMember(channel.id, userId)
      await fetchMembers()
      if (onMembershipChanged) onMembershipChanged()
      toast.success('Member removed from channel')
    } catch (err) {
      console.error('Failed to remove channel member:', err)
      toast.error('Failed to remove member: ' + (err.response?.data?.error || err.message))
    } finally {
      setSavingUserId(null)
    }
  }

  const handleAddMember = async (e) => {
    e.preventDefault()
    if (!selectedNewMemberId) return

    setAddingMember(true)
    try {
      await channelsAPI.addMember(channel.id, {
        userId: selectedNewMemberId,
        permission: selectedNewMemberPermission
      })
      await fetchMembers()
      if (onMembershipChanged) onMembershipChanged()
      setSelectedNewMemberId('')
      setSelectedNewMemberPermission('read_write')
      toast.success('Member added to channel')
    } catch (err) {
      console.error('Failed to add channel member:', err)
      toast.error('Failed to add member: ' + (err.response?.data?.error || err.message))
    } finally {
      setAddingMember(false)
    }
  }

  const permissionLabel = (permission) =>
    permission === 'read_write' ? 'Read/Write' : permission.charAt(0).toUpperCase() + permission.slice(1)

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-members-title"
        className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-2xl sm:h-auto sm:max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <div>
            <h3 id="channel-members-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              Channel Members
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">{channel.display_name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close channel members dialog"
            className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          {loading ? (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
              <p className="text-gray-500 dark:text-gray-400 mt-2">Loading members...</p>
            </div>
          ) : (
            <div>
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Current Members ({members.length})
              </h4>
              {members.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">No members on this channel yet.</p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto border border-gray-200 dark:border-gray-600 rounded-lg p-3">
                  {members.map((member) => (
                    <div key={member.id} className="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-gray-700 rounded gap-2">
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {member.first_name} {member.last_name}
                        </span>
                        <span className="text-xs text-gray-500 dark:text-gray-400 ml-2 break-all">
                          {member.email}
                        </span>
                      </div>
                      <div className="flex items-center space-x-2 flex-shrink-0">
                        {['read', 'write', 'read_write'].map((permission) => (
                          <button
                            key={permission}
                            type="button"
                            disabled={savingUserId === member.id}
                            onClick={() => handleChangePermission(member.id, permission)}
                            className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors disabled:opacity-50 ${
                              member.permission === permission
                                ? 'bg-primary-100 text-primary-800 border-primary-300 dark:bg-primary-900 dark:text-primary-200'
                                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50 dark:bg-gray-600 dark:text-gray-300 dark:border-gray-500 dark:hover:bg-gray-500'
                            }`}
                          >
                            {member.permission === permission && <CheckIcon className="h-3 w-3 inline mr-1" />}
                            {permissionLabel(permission)}
                          </button>
                        ))}
                        <button
                          type="button"
                          disabled={savingUserId === member.id}
                          onClick={() => handleRemoveMember(member.id)}
                          aria-label={`Remove ${member.first_name} ${member.last_name} from channel`}
                          title="Remove from channel"
                          className="p-2 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 dark:bg-red-950/40 dark:hover:bg-red-900/60 dark:text-red-400 disabled:opacity-50"
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!loading && (
            <form onSubmit={handleAddMember} className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Add a Member</h4>
              {availableMembers.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">Every team member is already on this channel.</p>
              ) : (
                <div className="flex flex-col sm:flex-row gap-3">
                  <select
                    value={selectedNewMemberId}
                    onChange={(e) => setSelectedNewMemberId(e.target.value)}
                    className="input flex-1"
                    aria-label="Select a member to add"
                  >
                    <option value="">Select a member...</option>
                    {availableMembers.map((teamMember) => (
                      <option key={teamMember.id} value={teamMember.id}>
                        {teamMember.first_name} {teamMember.last_name} ({teamMember.email})
                      </option>
                    ))}
                  </select>
                  <select
                    value={selectedNewMemberPermission}
                    onChange={(e) => setSelectedNewMemberPermission(e.target.value)}
                    className="input sm:w-40"
                    aria-label="Select permission"
                  >
                    <option value="read">Read</option>
                    <option value="write">Write</option>
                    <option value="read_write">Read/Write</option>
                  </select>
                  <button
                    type="submit"
                    disabled={!selectedNewMemberId || addingMember}
                    className="btn-primary px-4 py-2 disabled:opacity-50 whitespace-nowrap"
                  >
                    {addingMember ? 'Adding...' : 'Add'}
                  </button>
                </div>
              )}
            </form>
          )}

          <div className="flex justify-end pt-2">
            <button type="button" onClick={onClose} className="btn-secondary px-4 py-2">
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
