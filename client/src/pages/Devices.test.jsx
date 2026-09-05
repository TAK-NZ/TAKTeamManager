import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import Devices from './Devices.jsx'
import { devicesAPI, teamsAPI } from '../services/api'
import toast from 'react-hot-toast'

// Devices-page-parity: mirrors the mount pattern and mock-hygiene
// conventions established by src/pages/Users.test.jsx -- this project has
// no @testing-library/react, so the page is mounted with react-dom/client's
// createRoot plus React 18's own act.
//
// `../services/api` is the only mock: the network boundary. `devicesAPI`
// backs the page's own fetch/edit/transfer/delete calls; `teamsAPI` is
// stubbed because `TransferMemberDialog` (a REAL, unmocked component) reads
// `teamsAPI.getMyTeams` when its own dialog opens.

vi.mock('../services/api', () => ({
  devicesAPI: {
    getAll: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    generateQrCode: vi.fn(),
    previewQrCode: vi.fn()
  },
  teamsAPI: { getMyTeams: vi.fn() },
  usersAPI: {
    transfer: vi.fn(),
    suspendAccount: vi.fn(),
    unsuspendAccount: vi.fn()
  },
  // EnrollmentView.jsx (rendered by the Enroll dialog) imports these too;
  // a named import of a missing export from a mocked ES module is a
  // load-time failure, so both are present even though this file's own
  // tests never open the Enroll dialog.
  enrollmentAPI: { generateSelf: vi.fn(), previewSelf: vi.fn() },
  configAPI: { getPublic: vi.fn().mockResolvedValue({ data: {} }) }
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}))

// vitest compiles this JSX with esbuild's classic transform, and Devices.jsx
// (like Users.jsx) imports no React of its own.
globalThis.React = React

const deviceRow = (overrides = {}) => ({
  deviceUserId: 10,
  username: 'AUK-D7K3QMX',
  deviceLabel: 'Engine 4 Tablet',
  callsignSuffix: 'Tanker1',
  takRole: 'Team Member',
  callsign: 'AUK-Tanker1',
  teamId: 3,
  teamName: 'Auckland',
  createdAt: '2024-01-01T00:00:00.000Z',
  accountStatus: 'active',
  liveCertificateCount: 1,
  canManage: true,
  ...overrides
})

describe('Devices page', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mountWith = async (devices, pagination = { page: 1, pageSize: 20, total: devices.length }) => {
    devicesAPI.getAll.mockResolvedValue({ data: { devices, pagination } })
    root = createRoot(container)
    await act(async () => {
      root.render(<Devices user={{ isAdmin: true }} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  const bodyRows = () => container.querySelectorAll('tbody tr')
  const deviceNameHeader = () => container.querySelectorAll('thead th')[0]
  const addedHeader = () => container.querySelectorAll('thead th')[3]

  it('renders the fetched devices in a table, with no email column anywhere', async () => {
    await mountWith([deviceRow()])

    expect(bodyRows()).toHaveLength(1)
    expect(container.textContent).toContain('Engine 4 Tablet')
    expect(container.textContent).toContain('AUK-D7K3QMX')
    expect(container.textContent).toContain('Auckland')
    expect(container.textContent).not.toContain('@')
  })

  // Bugfix (admins had no way to see a device's certificate expiring soon
  // on the org-wide /devices page): DeviceExpiryLine reuses DeviceListRow's
  // own classification, so an imminent expiry renders bold-red with a
  // warning marker here too.
  describe('certificate expiry highlighting (bugfix)', () => {
    it('renders nothing extra for a device with no expiresAt', async () => {
      await mountWith([deviceRow({ expiresAt: null })])

      expect(container.textContent).not.toContain('Expires soon')
      expect(container.textContent).not.toContain('Expired')
    })

    it('highlights an imminently-expiring certificate as bold red with an "Expires soon" marker', async () => {
      const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
      await mountWith([deviceRow({ expiresAt: soon })])

      expect(container.textContent).toContain('Expires soon')
      const marker = container.querySelector('span.sr-only')
      expect(marker).not.toBeNull()
      expect(marker.textContent).toBe('Expires soon')
    })

    it('highlights an already-expired certificate with an "Expired" marker instead', async () => {
      const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
      await mountWith([deviceRow({ expiresAt: past })])

      expect(container.textContent).toContain('Expired')
      expect(container.textContent).not.toContain('Expires soon')
    })
  })

  it('shows a loading spinner before the fetch resolves, then the list', async () => {
    let resolveFetch
    devicesAPI.getAll.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve }))

    root = createRoot(container)
    await act(async () => {
      root.render(<Devices user={{ isAdmin: true }} />)
    })

    expect(container.textContent).toContain('Loading devices...')

    await act(async () => {
      resolveFetch({ data: { devices: [deviceRow()], pagination: { page: 1, pageSize: 20, total: 1 } } })
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Loading devices...')
    expect(container.textContent).toContain('Engine 4 Tablet')
  })

  it('shows an empty state when no devices are returned', async () => {
    await mountWith([])

    expect(container.textContent).toContain('No devices found.')
  })

  it('shows an inline error message on a failed fetch, without throwing', async () => {
    devicesAPI.getAll.mockRejectedValue(new Error('network down'))

    root = createRoot(container)
    await act(async () => {
      root.render(<Devices user={{ isAdmin: true }} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert.textContent).toContain('Failed to load devices')
  })

  it('re-fetches with the search term when the search input changes', async () => {
    await mountWith([deviceRow()])

    const input = container.querySelector('input[placeholder^="Search devices"]')
    expect(input).not.toBeNull()

    devicesAPI.getAll.mockResolvedValue({
      data: { devices: [deviceRow({ deviceUserId: 11, username: 'AUK-D0000BB', deviceLabel: 'Spare Tablet' })], pagination: { page: 1, pageSize: 20, total: 1 } }
    })

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setter.call(input, 'spare')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    const lastCall = devicesAPI.getAll.mock.calls.at(-1)[0]
    expect(lastCall.search).toBe('spare')
    expect(container.textContent).toContain('Spare Tablet')
  })

  describe('sorting', () => {
    it('defaults to ascending by device display name on initial load', async () => {
      await mountWith([
        deviceRow({ deviceUserId: 1, deviceLabel: 'Charlie Tablet', username: 'AUK-D0000A1' }),
        deviceRow({ deviceUserId: 2, deviceLabel: 'Alice Tablet', username: 'AUK-D0000A2' }),
        deviceRow({ deviceUserId: 3, deviceLabel: 'Bob Tablet', username: 'AUK-D0000A3' })
      ])

      const names = [...bodyRows()].map((row) => row.querySelector('td').textContent)
      expect(names[0]).toContain('Alice Tablet')
      expect(names[1]).toContain('Bob Tablet')
      expect(names[2]).toContain('Charlie Tablet')
      expect(deviceNameHeader().querySelector('svg')).not.toBeNull()
    })

    it('reverses to descending on a click of the active Device header', async () => {
      await mountWith([
        deviceRow({ deviceUserId: 1, deviceLabel: 'Charlie Tablet', username: 'AUK-D0000A1' }),
        deviceRow({ deviceUserId: 2, deviceLabel: 'Alice Tablet', username: 'AUK-D0000A2' }),
        deviceRow({ deviceUserId: 3, deviceLabel: 'Bob Tablet', username: 'AUK-D0000A3' })
      ])

      await act(async () => {
        deviceNameHeader().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      const names = [...bodyRows()].map((row) => row.querySelector('td').textContent)
      expect(names[0]).toContain('Charlie Tablet')
      expect(names[2]).toContain('Alice Tablet')
    })

    it('switching to the Added header sorts ascending regardless of the Device column\'s prior direction', async () => {
      await mountWith([
        deviceRow({ deviceUserId: 1, deviceLabel: 'Charlie Tablet', username: 'AUK-D0000A1', createdAt: '2024-01-10T00:00:00.000Z' }),
        deviceRow({ deviceUserId: 2, deviceLabel: 'Alice Tablet', username: 'AUK-D0000A2', createdAt: '2024-01-12T00:00:00.000Z' }),
        deviceRow({ deviceUserId: 3, deviceLabel: 'Bob Tablet', username: 'AUK-D0000A3', createdAt: '2024-01-11T00:00:00.000Z' })
      ])

      await act(async () => {
        deviceNameHeader().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        addedHeader().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      const names = [...bodyRows()].map((row) => row.querySelector('td').textContent)
      expect(names[0]).toContain('Charlie Tablet')
      expect(names[1]).toContain('Bob Tablet')
      expect(names[2]).toContain('Alice Tablet')
    })
  })

  describe('row actions gated by canManage', () => {
    it('renders enabled action buttons for a manageable row', async () => {
      await mountWith([deviceRow({ canManage: true })])

      const editButton = container.querySelector('button[aria-label="Edit device Engine 4 Tablet"]')
      expect(editButton).not.toBeNull()
      expect(editButton.disabled).toBe(false)
    })

    it('renders disabled action buttons for a row the caller does not manage', async () => {
      await mountWith([deviceRow({ canManage: false })])

      const editButton = container.querySelector('button[disabled]')
      expect(editButton).not.toBeNull()
      expect(editButton.getAttribute('aria-label')).toMatch(/don't administer/)
    })
  })

  describe('inline edit', () => {
    it('opens the edit row, saves via devicesAPI.update, and merges the response into the row', async () => {
      await mountWith([deviceRow()])

      const editButton = container.querySelector('button[aria-label="Edit device Engine 4 Tablet"]')
      await act(async () => {
        editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      const labelInput = container.querySelector('input[placeholder="Engine 4 Tablet"]')
      expect(labelInput).not.toBeNull()

      devicesAPI.update.mockResolvedValue({
        data: { device: { deviceUserId: 10, deviceLabel: 'Renamed Tablet', callsignSuffix: 'Tanker1' } }
      })

      const saveButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')
      await act(async () => {
        saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(devicesAPI.update).toHaveBeenCalledWith(10, { deviceLabel: 'Engine 4 Tablet', callsignSuffix: 'Tanker1' })
      expect(container.textContent).toContain('Renamed Tablet')
    })
  })

  describe('delete', () => {
    it('opens the delete confirmation, calls devicesAPI.delete, and removes the row on success', async () => {
      await mountWith([deviceRow()])

      const deleteButton = container.querySelector('button[aria-label="Delete device Engine 4 Tablet"]')
      await act(async () => {
        deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(container.textContent).toContain('Delete Device')

      devicesAPI.delete.mockResolvedValue({})

      const confirmButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Delete Device')
      await act(async () => {
        confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(devicesAPI.delete).toHaveBeenCalledWith(10)
      expect(toast.success).toHaveBeenCalledWith('Device deleted')
      expect(container.textContent).toContain('No devices found.')
    })

    it('shows an error toast and keeps the row when the delete call fails', async () => {
      await mountWith([deviceRow()])

      const deleteButton = container.querySelector('button[aria-label="Delete device Engine 4 Tablet"]')
      await act(async () => {
        deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      devicesAPI.delete.mockRejectedValue({ response: { data: { error: 'nope' } } })

      const confirmButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Delete Device')
      await act(async () => {
        confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(toast.error).toHaveBeenCalled()
      expect(container.textContent).toContain('Engine 4 Tablet')
    })
  })

  describe('pagination', () => {
    it('shows the Showing X to Y of Z summary and disables Previous on page 1', async () => {
      await mountWith([deviceRow()], { page: 1, pageSize: 20, total: 1 })

      expect(container.textContent).toContain('Showing 1 to 1 of 1 devices')
      const prevButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Previous')
      expect(prevButton.disabled).toBe(true)
    })

    it('requests the next page from devicesAPI.getAll when Next is clicked', async () => {
      await mountWith([deviceRow()], { page: 1, pageSize: 1, total: 2 })

      devicesAPI.getAll.mockResolvedValue({
        data: { devices: [deviceRow({ deviceUserId: 20, deviceLabel: 'Page 2 Tablet' })], pagination: { page: 2, pageSize: 1, total: 2 } }
      })

      const nextButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Next')
      await act(async () => {
        nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await Promise.resolve()
      })

      const lastCall = devicesAPI.getAll.mock.calls.at(-1)[0]
      expect(lastCall.page).toBe(2)
      expect(container.textContent).toContain('Page 2 Tablet')
    })
  })
})
