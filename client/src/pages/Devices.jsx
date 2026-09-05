import { useState, useEffect, useCallback, useMemo } from 'react'
import { MagnifyingGlassIcon, XMarkIcon, ChevronUpIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { devicesAPI } from '../services/api'
import FormattedDate, { DATE_PRECISION } from '../components/FormattedDate'
import MultipleCertificateWarning from '../components/MultipleCertificateWarning'
import { DeviceExpiryLine } from '../components/DeviceListRow'
import TransferMemberDialog from '../components/TransferMemberDialog'
import SuspendAccountDialog from '../components/SuspendAccountDialog'
import EnrollmentView from './EnrollmentView'
import {
  DeviceActions,
  DeviceEditRow,
  deviceDisplayName,
  isValidTeamDeviceCallsignSuffix,
  extractDeviceEditServerError,
  toTransferMember
} from '../components/TeamDeviceList'
import { describeAccountStatusBadge } from '../utils/accountStatusBadge'

/**
 * Devices-page-parity: the org-wide counterpart of `/users`, listing every
 * Team_Owned_Device the caller may see across their Organisation-scoped
 * visibility (mirroring `GET /api/users`' own `DirectoryScopeService`
 * scoping, applied to devices by `DeviceEnrollmentService.listAllDevices`
 * rather than reinvented here), placed directly beneath Users in the nav.
 *
 * Reuses the SAME action-icon group, inline edit row, and Transfer/Suspend
 * dialogs `TeamDeviceList.jsx`'s single-team Devices tab already defines
 * (`DeviceActions`, `DeviceEditRow`, `toTransferMember`, all exported from
 * that file) -- per the "extract a shared component when BEHAVIOUR is
 * duplicated" convention, this page does not re-implement the Edit/
 * Transfer/Enroll/Suspend/Delete action set a second time.
 *
 * Three structural differences from `TeamDeviceList.jsx`, all because this
 * page has no single "current team" in scope the way that component does:
 *
 * - Every row here potentially belongs to a DIFFERENT team, so `teamId`/
 *   `teamName` travel on the row itself (from `GET /api/devices`) rather
 *   than coming from a page-level `teamId` prop.
 * - This listing is Organisation-wide, a WIDER visibility scope than any
 *   single team's Devices tab. `DeviceActions`' `hasTeam` prop is fed the
 *   row's own `canManage` (mirroring `Users.jsx`'s identical
 *   `Boolean(team_id) && can_manage` gating for `MemberActions`), so a
 *   Team_Admin cannot act on a device in a sibling sub-team they don't
 *   administer even though this page's visibility shows them the row.
 * - No "Create Device" dialog: device CREATION stays exactly where it is
 *   today, per-team via `AddTeamDeviceDialog` on a team's own Devices tab
 *   -- there is no team pre-selected here for a new device to belong to,
 *   and inventing one would duplicate that dialog's team/callsign-preview
 *   flow for no reason this page needs.
 */
export default function Devices({ user }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [devices, setDevices] = useState([])
  // pageSize is 20 -- the CLIENT's own chosen default, distinct from the
  // server's own `paginationParams` default of 50 (which still applies to
  // any caller that omits pageSize entirely).
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Sorting by "Device" (display name) or "Added", mirroring Users.jsx's
  // own sortField/sortDirection + handleSort/getSortIcon convention.
  const [sortField, setSortField] = useState('deviceLabel')
  const [sortDirection, setSortDirection] = useState('asc')

  // The row currently open for inline edit, mirroring TeamDeviceList.jsx's
  // own editingDeviceId/editForm state.
  const [editingDeviceId, setEditingDeviceId] = useState(null)
  const [editForm, setEditForm] = useState({ deviceLabel: '', callsignSuffix: '' })
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState(null)

  // The row whose Transfer dialog is open. Null when closed.
  const [transferringDevice, setTransferringDevice] = useState(null)

  // The row whose Suspend/Unsuspend confirmation is open, mirroring
  // TeamDeviceList.jsx's own suspendingDevice shape exactly.
  const [suspendingDevice, setSuspendingDevice] = useState(null)

  // The row whose Enrollment_View modal is open. Null when closed.
  const [enrollingDevice, setEnrollingDevice] = useState(null)

  // The Delete Device confirmation dialog's state.
  const [deletingDevice, setDeletingDevice] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const fetchDevices = useCallback(async () => {
    setLoading(true)
    try {
      const response = await devicesAPI.getAll({
        page: pagination.page,
        pageSize: pagination.pageSize,
        search: searchQuery || undefined
      })
      setDevices(response.data?.devices || [])
      setPagination(response.data?.pagination || { page: 1, pageSize: 20, total: 0 })
      setError(null)
    } catch (err) {
      console.error('Failed to fetch devices:', err)
      setError(`Failed to load devices: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }, [pagination.page, pagination.pageSize, searchQuery])

  useEffect(() => {
    fetchDevices()
  }, [fetchDevices])

  // Performance-hardening: memoized against [devices, sortField,
  // sortDirection] so an unrelated re-render (e.g. opening an edit row or
  // a dialog) does not re-sort the fetched device page from scratch.
  // Filtering itself is already server-side (searchQuery is sent to
  // GET /api/devices), so this page's own list is already bounded by
  // pagination.pageSize -- this is purely a wasted-work fix, not a
  // scaling one.
  const sortedDevices = useMemo(() => (
    sortField
      ? [...devices].sort((a, b) => {
          let aValue
          let bValue
          if (sortField === 'createdAt') {
            const aTime = Date.parse(a.createdAt)
            const bTime = Date.parse(b.createdAt)
            aValue = Number.isNaN(aTime) ? -Infinity : aTime
            bValue = Number.isNaN(bTime) ? -Infinity : bTime
          } else {
            aValue = (deviceDisplayName(a) || '').toLowerCase()
            bValue = (deviceDisplayName(b) || '').toLowerCase()
          }

          if (sortDirection === 'asc') {
            return aValue < bValue ? -1 : aValue > bValue ? 1 : 0
          }
          return aValue > bValue ? -1 : aValue < bValue ? 1 : 0
        })
      : devices
  ), [devices, sortField, sortDirection])

  const handleSort = (field) => {
    setSortDirection(sortField === field && sortDirection === 'asc' ? 'desc' : 'asc')
    setSortField(field)
  }

  const getSortIcon = (field) => {
    if (sortField !== field) return null
    return sortDirection === 'asc' ? (
      <ChevronUpIcon className="h-4 w-4" />
    ) : (
      <ChevronDownIcon className="h-4 w-4" />
    )
  }

  const handleStartEdit = (device) => {
    setEditingDeviceId(device.deviceUserId)
    setEditForm({ deviceLabel: device.deviceLabel || '', callsignSuffix: device.callsignSuffix || '' })
    setEditError(null)
  }

  const handleCancelEdit = () => {
    setEditingDeviceId(null)
    setEditError(null)
  }

  const handleSaveEdit = async (deviceUserId) => {
    if (!isValidTeamDeviceCallsignSuffix(editForm.callsignSuffix)) {
      setEditError('Callsign suffix may only contain letters, digits, "-", and "."')
      return
    }

    setSavingEdit(true)
    setEditError(null)
    try {
      const response = await devicesAPI.update(deviceUserId, {
        deviceLabel: editForm.deviceLabel,
        callsignSuffix: editForm.callsignSuffix
      })
      const updated = response.data.device
      setDevices((prev) => prev.map((d) => (d.deviceUserId === deviceUserId ? { ...d, ...updated } : d)))
      setEditingDeviceId(null)
    } catch (err) {
      setEditError(
        extractDeviceEditServerError(err) || err.response?.data?.error || 'Failed to update device'
      )
    } finally {
      setSavingEdit(false)
    }
  }

  const handleSuspendClick = (device) => {
    setSuspendingDevice({
      device,
      mode: device.accountStatus === 'suspended' ? 'unsuspend' : 'suspend'
    })
  }

  const handleRemoveDevice = (device) => {
    setDeletingDevice(device)
  }

  const handleConfirmDelete = async () => {
    if (!deletingDevice) return
    setDeleting(true)
    try {
      await devicesAPI.delete(deletingDevice.deviceUserId)
      setDevices((prev) => prev.filter((d) => d.deviceUserId !== deletingDevice.deviceUserId))
      toast.success('Device deleted')
      setDeletingDevice(null)
    } catch (err) {
      toast.error('Failed to delete device: ' + (err.response?.data?.error || err.message))
    } finally {
      setDeleting(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(pagination.total / (pagination.pageSize || 1)))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Devices</h1>
          <p className="text-gray-600 dark:text-gray-400">Manage team-owned devices across every team.</p>
        </div>
      </div>

      {/* Search */}
      <div className="card">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search devices by name or username..."
            className="input pl-10"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              setPagination((prev) => ({ ...prev, page: 1 }))
            }}
          />
        </div>
      </div>

      {/* Devices List */}
      <div className="card">
        {loading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
            <p className="text-gray-500 dark:text-gray-400 mt-2">Loading devices...</p>
          </div>
        ) : error ? (
          <div className="text-center py-12">
            <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>
          </div>
        ) : sortedDevices.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500 dark:text-gray-400">No devices found.</p>
          </div>
        ) : (
          <>
          {/* Mobile card list, mirroring TeamDeviceList.jsx's own
              sm:hidden divide-y card block. */}
          <div className="sm:hidden divide-y divide-gray-200 dark:divide-gray-700">
            {sortedDevices.map((device) => (
              editingDeviceId === device.deviceUserId ? (
                <div key={device.deviceUserId} className="overflow-x-auto">
                  <table className="min-w-full">
                    <tbody>
                      <DeviceEditRow
                        colSpan={1}
                        form={editForm}
                        setForm={setEditForm}
                        saving={savingEdit}
                        error={editError}
                        onSave={() => handleSaveEdit(device.deviceUserId)}
                        onCancel={handleCancelEdit}
                      />
                    </tbody>
                  </table>
                </div>
              ) : (
                <div key={device.deviceUserId} className="p-4 space-y-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 dark:text-gray-100 break-words">
                      {deviceDisplayName(device)}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 font-mono break-all">
                      {device.username}
                    </p>
                  </div>
                  {describeAccountStatusBadge(device.accountStatus) && (
                    <span className={describeAccountStatusBadge(device.accountStatus).className}>
                      {describeAccountStatusBadge(device.accountStatus).label}
                    </span>
                  )}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <p className="text-gray-500 dark:text-gray-400">
                      Team: <span className="text-gray-900 dark:text-gray-100">{device.teamName || 'Not assigned'}</span>
                    </p>
                    <p className="text-gray-500 dark:text-gray-400 text-right">
                      Added:{' '}
                      <span className="text-gray-900 dark:text-gray-100">
                        <FormattedDate value={device.createdAt} fallback="Unknown" precision={DATE_PRECISION.DATE} />
                      </span>
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-900 dark:text-gray-100">{device.callsign || '-'}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{device.takRole || 'Team Member'}</p>
                  </div>
                  <MultipleCertificateWarning count={device.liveCertificateCount} />
                  <DeviceExpiryLine expiresAt={device.expiresAt} />
                  <DeviceActions
                    device={device}
                    onEdit={handleStartEdit}
                    onTransfer={setTransferringDevice}
                    onEnroll={setEnrollingDevice}
                    onDelete={handleRemoveDevice}
                    onSuspend={device.accountStatus !== 'orphaned' ? handleSuspendClick : undefined}
                    accountStatus={device.accountStatus}
                    hasTeam={device.canManage === true}
                    variant="card"
                  />
                </div>
              )
            ))}
          </div>

          <div className="hidden sm:block overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-700">
                <tr>
                  <th
                    onClick={() => handleSort('deviceLabel')}
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600"
                  >
                    <div className="flex items-center space-x-1">
                      <span>Device</span>
                      {getSortIcon('deviceLabel')}
                    </div>
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Team
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    TAK Callsign &amp; Role
                  </th>
                  <th
                    onClick={() => handleSort('createdAt')}
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600"
                  >
                    <div className="flex items-center space-x-1">
                      <span>Added</span>
                      {getSortIcon('createdAt')}
                    </div>
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {sortedDevices.map((device) => (
                  editingDeviceId === device.deviceUserId ? (
                    <DeviceEditRow
                      key={device.deviceUserId}
                      colSpan={5}
                      form={editForm}
                      setForm={setEditForm}
                      saving={savingEdit}
                      error={editError}
                      onSave={() => handleSaveEdit(device.deviceUserId)}
                      onCancel={handleCancelEdit}
                    />
                  ) : (
                  <tr key={device.deviceUserId}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-gray-100">
                      <span className="break-all">{deviceDisplayName(device)}</span>
                      <p className="text-xs text-gray-500 dark:text-gray-400 font-mono break-all">{device.username}</p>
                      {describeAccountStatusBadge(device.accountStatus) && (
                        <div className="mt-1">
                          <span className={describeAccountStatusBadge(device.accountStatus).className}>
                            {describeAccountStatusBadge(device.accountStatus).label}
                          </span>
                        </div>
                      )}
                      <MultipleCertificateWarning count={device.liveCertificateCount} className="mt-1" />
                      <DeviceExpiryLine expiresAt={device.expiresAt} />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                      {device.teamName || 'Not assigned'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <p className="text-gray-900 dark:text-gray-100">{device.callsign || '-'}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{device.takRole || 'Team Member'}</p>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                      <FormattedDate value={device.createdAt} fallback="Unknown" precision={DATE_PRECISION.DATE} />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <DeviceActions
                        device={device}
                        onEdit={handleStartEdit}
                        onTransfer={setTransferringDevice}
                        onEnroll={setEnrollingDevice}
                        onDelete={handleRemoveDevice}
                        onSuspend={device.accountStatus !== 'orphaned' ? handleSuspendClick : undefined}
                        accountStatus={device.accountStatus}
                        // Devices-page-parity: a row is only actionable
                        // when the caller administers its team (mirroring
                        // Users.jsx's own can_manage gating) -- this
                        // listing's visibility is Organisation-wide, a
                        // wider scope than any single caller's management
                        // authority over a given row's team.
                        hasTeam={device.canManage === true}
                      />
                    </td>
                  </tr>
                  )
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}

        {/* Pagination, mirroring AuditLogs.jsx's own Previous/Page-N-of-M/Next row. */}
        {!loading && !error && sortedDevices.length > 0 && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Showing {(pagination.page - 1) * pagination.pageSize + 1} to{' '}
              {Math.min(pagination.page * pagination.pageSize, pagination.total)} of {pagination.total} devices
            </div>
            <div className="flex items-center space-x-2">
              <button
                type="button"
                onClick={() => setPagination((prev) => ({ ...prev, page: prev.page - 1 }))}
                disabled={pagination.page === 1}
                className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Page {pagination.page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPagination((prev) => ({ ...prev, page: prev.page + 1 }))}
                disabled={pagination.page === totalPages}
                className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Devices-page-parity: the shared Transfer dialog. `teamId`/`teamName`
          come from the ROW, since this page has no single team of its
          own -- mirroring Users.jsx's identical reasoning. */}
      {transferringDevice && (
        <TransferMemberDialog
          member={toTransferMember(transferringDevice)}
          team={{ id: transferringDevice.teamId, name: transferringDevice.teamName }}
          user={user}
          onClose={() => setTransferringDevice(null)}
          onCompleted={() => {
            setTransferringDevice(null)
            fetchDevices()
          }}
        />
      )}

      {/* The shared Suspend/Unsuspend confirmation dialog. */}
      {suspendingDevice && (
        <SuspendAccountDialog
          mode={suspendingDevice.mode}
          targetUserId={suspendingDevice.device.deviceUserId}
          targetName={deviceDisplayName(suspendingDevice.device)}
          targetUsername={suspendingDevice.device.username}
          onClose={() => setSuspendingDevice(null)}
          onCompleted={fetchDevices}
        />
      )}

      {/* The device's Enrollment_View, opened from the Enroll action --
          mirrors TeamDetail.jsx's identical dialog and `fetchEnrollment`/
          `fetchPreview` wiring against THIS device's own
          POST/GET /api/devices/:deviceUserId/qr-code|preview routes. */}
      {enrollingDevice && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="enroll-device-title"
            className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-3xl sm:h-auto sm:max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 id="enroll-device-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Enroll {deviceDisplayName(enrollingDevice)}
              </h3>
              <button
                onClick={() => setEnrollingDevice(null)}
                className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
                aria-label="Close"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            <div className="p-6">
              <EnrollmentView
                fetchEnrollment={async () => {
                  const response = await devicesAPI.generateQrCode(enrollingDevice.deviceUserId)
                  return response.data.qrCode
                }}
                fetchPreview={async () => {
                  const response = await devicesAPI.previewQrCode(enrollingDevice.deviceUserId)
                  return response.data.preview
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Delete Device confirmation, matching TeamDeviceList.jsx's own
          dialog exactly -- plain danger Cancel/Confirm, no type-in-email
          step (a device has none to type). */}
      {deletingDevice && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-device-title"
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full"
          >
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 id="delete-device-title" className="text-lg font-medium text-red-600 dark:text-red-400">
                Delete Device
              </h3>
              <button
                type="button"
                onClick={() => setDeletingDevice(null)}
                className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
                aria-label="Close"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            <div className="p-6">
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                Are you sure you want to permanently delete{' '}
                <span className="font-medium text-gray-900 dark:text-gray-100">{deviceDisplayName(deletingDevice)}</span>?
                This removes it from every team and channel, and deletes its account from the identity provider.
                This action cannot be undone.
              </p>
              <div className="flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setDeletingDevice(null)}
                  className="btn-secondary"
                  disabled={deleting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDelete}
                  disabled={deleting}
                  className="btn-danger disabled:opacity-50"
                >
                  {deleting ? 'Deleting...' : 'Delete Device'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
