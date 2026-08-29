import { useState, useEffect } from 'react'
import { PlusIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { usersAPI } from '../services/api'
import FormattedDate, { DATE_PRECISION, TOOLTIP_SIDES } from '../components/FormattedDate'
import UserDevicesModal, { useDeviceManagementEnabled } from '../components/UserDevicesModal'
import MultipleCertificateWarning from '../components/MultipleCertificateWarning'

export default function Users() {
  const [searchQuery, setSearchQuery] = useState('')
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Requirement 6.4 (device-management task 15.4): the row whose "Devices"
  // action was activated, i.e. the user `UserDevicesModal` is open for. Null
  // when the modal is closed -- at most one is ever open. The SAME modal
  // component is attached in the Orgs & Teams view (`TeamDetail.jsx`), so
  // the device list itself is defined once, not per surface.
  const [devicesForUser, setDevicesForUser] = useState(null)
  // The device surfaces exist only WHILE the server-side DEVICE_MGMT_ENABLED
  // flag is on, and that flag is never exposed through /api/config/public
  // (Requirement 1.4), so the affordance is gated on the reachability probe.
  const devicesEnabled = useDeviceManagementEnabled()

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const response = await usersAPI.getAll()
        setUsers(response.data.users || response.data || [])
      } catch (error) {
        console.error('Failed to fetch users:', error)
        setError(`Failed to load users: ${error.message}`)
      } finally {
        setLoading(false)
      }
    }

    fetchUsers()
  }, [])

  const filteredUsers = users.filter(user => 
    user.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    user.username?.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Users</h1>
          <p className="text-gray-600 dark:text-gray-400">Manage users and their team assignments.</p>
        </div>
        <button className="btn-primary flex items-center">
          <PlusIcon className="h-5 w-5 mr-2" />
          Create User
        </button>
      </div>

      {/* Search */}
      <div className="card">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search users by name, email, or username..."
            className="input pl-10"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Users List */}
      <div className="card">
        {loading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
            <p className="text-gray-500 dark:text-gray-400 mt-2">Loading users...</p>
          </div>
        ) : error ? (
          <div className="text-center py-12">
            <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500 dark:text-gray-400">No users found.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-700">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    User
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Unit
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Last Login
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {filteredUsers.map((user) => (
                  <tr key={user.pk}>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="flex-shrink-0 h-10 w-10">
                          <img className="h-10 w-10 rounded-full" src={user.avatar} alt="" />
                        </div>
                        <div className="ml-4">
                          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{user.name}</div>
                          <div className="text-sm text-gray-500 dark:text-gray-400">{user.email}</div>
                          {/* takserver-enrollment Criterion 13.6: GET /api/users
                              already projects `live_certificate_count` from the
                              SAME batched query this page's fetch already runs,
                              so this renders with no second request. Renders
                              nothing at all for a count of 0 or 1 -- see
                              MultipleCertificateWarning.jsx's own doc comment
                              for why this is deliberately NOT gated on
                              devicesEnabled (design decision 17: the count is
                              zero whenever DEVICE_MGMT_ENABLED is off, so the
                              warning is already inert without a second flag
                              check). */}
                          <MultipleCertificateWarning count={user.live_certificate_count} />
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {user.team_name || 'Not assigned to a unit'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                        user.is_active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                      }`}>
                        {user.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      {/* Date_Render_Position 6 (Criteria 2.1, 2.2, 2.3): the
                          Last Login value renders through the ONE shared
                          FormattedDate, so it acquires the Date_Tooltip with
                          the same behaviour as every other date in the app.
                          `side` is LEFT because this is the second-to-last
                          cell of a horizontally scrolling table (Criterion
                          3.5) -- a tooltip pushed past the container's left
                          edge is clipped AND unreachable, so trailing columns
                          open leftward from `right-full`.

                          THE TERNARY STAYS, and `fallback` is the helper's own
                          `''` rather than `'Never'` (design.md Decision 13).
                          Folding the string into the prop reads better and
                          CHANGES what this page renders: a `last_login` that
                          is present but unparseable takes the truthy branch
                          today and renders the EMPTY STRING, because
                          `formatDate`'s default fallback is `''`. Passing
                          `fallback="Never"` would render `Never` for that
                          value instead. That is arguably the better product
                          decision, which is exactly why it does not belong in
                          a change whose Criterion 2.3 promises the same string
                          character for character and whose Criterion 2.4
                          preserves each caller's fallback rather than
                          relocating it. If anyone wants it, it is a one-line
                          change with its own justification. */}
                      {user.last_login ? (
                        <FormattedDate
                          value={user.last_login}
                          fallback=""
                          precision={DATE_PRECISION.DATE}
                          side={TOOLTIP_SIDES.LEFT}
                        />
                      ) : (
                        'Never'
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex items-center justify-end space-x-3">
                        {/* Requirement 6.4: opens the shared UserDevicesModal.
                            `local_user_id` is the LOCAL `users.id` the device
                            route is keyed on -- this list is sourced from
                            Authentik, so `pk` is an Authentik id and must not
                            be used here. A user with no local row (null) has
                            no devices to show, so the action is omitted.
                            Whether the caller may actually see this user's
                            devices is the server's call (403 when the target
                            is not a Managed_User), shown inside the modal. */}
                        {devicesEnabled && user.local_user_id && (
                          <button
                            type="button"
                            onClick={() => setDevicesForUser(user)}
                            className="text-primary-600 hover:text-primary-900"
                          >
                            Devices
                          </button>
                        )}
                        <button className="text-primary-600 hover:text-primary-900">
                          Manage
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Requirements 6.4, 6.5: the shared device modal (also attached in
          TeamDetail.jsx's member lists -- ONE component, two surfaces). */}
      {devicesForUser && (
        <UserDevicesModal
          userId={devicesForUser.local_user_id}
          userName={devicesForUser.name || devicesForUser.username || devicesForUser.email}
          onClose={() => setDevicesForUser(null)}
        />
      )}
    </div>
  )
}