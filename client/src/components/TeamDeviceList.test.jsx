import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import TeamDeviceList, {
  deviceDisplayName,
  interpretTeamDeviceListError,
} from './TeamDeviceList.jsx'
import { devicesAPI, usersAPI } from '../services/api'

// takserver-enrollment Requirements 5.9, 5.10, 14.7 (task 11.2)
//
// Sanity coverage for the team-device list surface. This project has no
// `@testing-library/react`, so the component is mounted with
// `react-dom/client`'s `createRoot` plus React 18's own `act`.
globalThis.React = React

vi.mock('../services/api', () => ({
  devicesAPI: {
    getTeamDevices: vi.fn(),
  },
  // account-lifecycle-management Requirement 1.11: stubbed because
  // `SuspendAccountDialog` (rendered by this component) imports
  // `usersAPI` from this same mocked module -- a named import of a
  // missing export from a mocked ES module is a load-time failure, per
  // this project's mock-hygiene convention, even on a test that never
  // opens that dialog.
  usersAPI: {
    suspendAccount: vi.fn(),
    unsuspendAccount: vi.fn(),
  },
}))

describe('deviceDisplayName (Criterion 5.10)', () => {
  it('prefers the deviceLabel when present', () => {
    expect(deviceDisplayName({ username: 'AUK-D7K3QMX', deviceLabel: 'Engine 4 Tablet' })).toBe(
      'Engine 4 Tablet'
    )
  })

  it('falls back to the Managed_Identifier when the label is null', () => {
    expect(deviceDisplayName({ username: 'AUK-D7K3QMX', deviceLabel: null })).toBe('AUK-D7K3QMX')
  })

  it('never renders an "@" for either fallback', () => {
    expect(deviceDisplayName({ username: 'AUK-D7K3QMX', deviceLabel: 'Truck 1' })).not.toContain('@')
    expect(deviceDisplayName({ username: 'AUK-D7K3QMX', deviceLabel: null })).not.toContain('@')
  })

  it('does not throw for a missing or malformed device', () => {
    expect(() => deviceDisplayName(null)).not.toThrow()
    expect(() => deviceDisplayName(undefined)).not.toThrow()
    expect(deviceDisplayName(null)).toBe('')
  })
})

describe('interpretTeamDeviceListError', () => {
  it('returns a plain message for a 403', () => {
    expect(interpretTeamDeviceListError({ response: { status: 403 } })).toMatch(/administer/)
  })

  it('prefers the server message when present', () => {
    expect(
      interpretTeamDeviceListError({ response: { status: 403, data: { error: 'nope' } } })
    ).toBe('nope')
  })

  it('falls back to a generic message for anything else', () => {
    expect(interpretTeamDeviceListError({})).toMatch(/Failed to load/)
  })
})

describe('TeamDeviceList (mounted)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    devicesAPI.getTeamDevices.mockReset()
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  it('renders nothing when teamId is falsy, and fetches nothing', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<TeamDeviceList teamId={null} onEnroll={() => {}} />)
    })

    expect(devicesAPI.getTeamDevices).not.toHaveBeenCalled()
    expect(container.textContent).toBe('')
  })

  // Bugfix: TeamDetail.jsx's Team Devices tab was the only one of 5 tabs
  // with no item count badge, since this list's fetch/state is entirely
  // internal to this component. `onCountChange` reports the fetched
  // TOTAL (unfiltered by the search box), matching every other tab's own
  // count semantics (their own full list length, not a filtered subset).
  it('reports the fetched device count via onCountChange, unfiltered by the search term', async () => {
    devicesAPI.getTeamDevices.mockResolvedValue({
      data: {
        devices: [
          { deviceUserId: 1, username: 'AUK-D7K3QMX', deviceLabel: 'Engine 4 Tablet', teamId: 5, createdAt: '2025-01-02T03:04:05Z', liveCertificateCount: 1 },
          { deviceUserId: 2, username: 'AUK-D9Q2WXY', deviceLabel: null, teamId: 5, createdAt: '2025-02-03T03:04:05Z', liveCertificateCount: 0 },
        ],
      },
    })
    const onCountChange = vi.fn()

    root = createRoot(container)
    await act(async () => {
      root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} onCountChange={onCountChange} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(onCountChange).toHaveBeenCalledWith(2)
  })

  it('does not throw when onCountChange is omitted', async () => {
    devicesAPI.getTeamDevices.mockResolvedValue({ data: { devices: [] } })

    root = createRoot(container)
    await expect(
      act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
    ).resolves.not.toThrow()
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('renders each device by Device_Display_Name and Managed_Identifier, with no email anywhere', async () => {
    devicesAPI.getTeamDevices.mockResolvedValue({
      data: {
        devices: [
          {
            deviceUserId: 1,
            username: 'AUK-D7K3QMX',
            deviceLabel: 'Engine 4 Tablet',
            teamId: 5,
            createdAt: '2025-01-02T03:04:05Z',
            liveCertificateCount: 1,
          },
          {
            deviceUserId: 2,
            username: 'AUK-D9Q2WXY',
            deviceLabel: null,
            teamId: 5,
            createdAt: '2025-02-03T03:04:05Z',
            liveCertificateCount: 3,
          },
        ],
      },
    })

    root = createRoot(container)
    await act(async () => {
      root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
    })
    // Flush the pending fetch promise.
    await act(async () => {
      await Promise.resolve()
    })

    expect(devicesAPI.getTeamDevices).toHaveBeenCalledWith(5)
    expect(container.textContent).toContain('Engine 4 Tablet')
    expect(container.textContent).toContain('AUK-D7K3QMX')
    expect(container.textContent).toContain('AUK-D9Q2WXY')
    expect(container.textContent).not.toContain('@')

    // Criterion 13.1/13.5: the Multiple_Certificate_Warning renders only for
    // the second device (count 3 > 1), not the first (count 1).
    expect(container.textContent).toContain('3 active TAK Server certificates')
  })

  // Bugfix (admins had no way to see a device's certificate expiring soon
  // on the Team Devices tab): DeviceExpiryLine reuses DeviceListRow's own
  // classification, so this tab highlights an imminent/expired certificate
  // the same way the Dashboard "My Devices" card already does.
  describe('certificate expiry highlighting (bugfix)', () => {
    it('renders nothing extra for a device with no expiresAt', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({
        data: { devices: [{ deviceUserId: 1, username: 'AUK-D7K3QMX', deviceLabel: 'Engine 4 Tablet', teamId: 5, createdAt: '2025-01-02T03:04:05Z', liveCertificateCount: 0, expiresAt: null }] }
      })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(container.textContent).not.toContain('Expires soon')
      expect(container.textContent).not.toContain('Expired')
    })

    it('highlights an imminently-expiring certificate as bold red with an "Expires soon" marker', async () => {
      const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
      devicesAPI.getTeamDevices.mockResolvedValue({
        data: { devices: [{ deviceUserId: 1, username: 'AUK-D7K3QMX', deviceLabel: 'Engine 4 Tablet', teamId: 5, createdAt: '2025-01-02T03:04:05Z', liveCertificateCount: 1, expiresAt: soon }] }
      })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(container.textContent).toContain('Expires soon')
      const marker = container.querySelector('span.sr-only')
      expect(marker).not.toBeNull()
      expect(marker.textContent).toBe('Expires soon')
    })
  })

  // Bugfix (list-width reduction, consistency with Members/Team Admins):
  // this tab now shows Device+username, TAK Callsign & Role, Added,
  // Actions -- the "TAK Callsign & Role" column/label is new, and the
  // device's `callsign`/`takRole` fields (from
  // `DeviceEnrollmentService.listTeamDevices`) render in both the
  // desktop table and the mobile card.
  it('renders "TAK Callsign & Role" as a column header, and each device\'s callsign/takRole beneath it', async () => {
    devicesAPI.getTeamDevices.mockResolvedValue({
      data: {
        devices: [
          {
            deviceUserId: 1,
            username: 'AUK-D7K3QMX',
            deviceLabel: 'Engine 4 Tablet',
            callsignSuffix: 'Tanker1',
            takRole: 'Team Lead',
            callsign: 'AUK-Tanker1',
            teamId: 5,
            createdAt: '2025-01-02T03:04:05Z',
            liveCertificateCount: 0,
          },
        ],
      },
    })

    root = createRoot(container)
    await act(async () => {
      root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('TAK Callsign & Role')
    expect(container.textContent).toContain('AUK-Tanker1')
    expect(container.textContent).toContain('Team Lead')
    // Old separate "Device"/"Username" two-column table header and
    // plain "Added"-only informational column are gone; "Username" is
    // no longer its OWN column header (it now renders stacked under the
    // device name).
    const table = container.querySelector('table')
    const headerCells = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim())
    expect(headerCells).toEqual(['Device', 'TAK Callsign & Role', 'Added', 'Actions'])
  })

  it('falls back to "-" for the callsign and "Team Member" for the role when a device carries neither', async () => {
    devicesAPI.getTeamDevices.mockResolvedValue({
      data: {
        devices: [
          {
            deviceUserId: 2,
            username: 'AUK-D9Q2WXY',
            deviceLabel: null,
            callsignSuffix: null,
            takRole: null,
            callsign: null,
            teamId: 5,
            createdAt: '2025-02-03T03:04:05Z',
            liveCertificateCount: 0,
          },
        ],
      },
    })

    root = createRoot(container)
    await act(async () => {
      root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Team Member')
    const table = container.querySelector('table')
    expect(table.textContent).toContain('-')
  })

  it('calls onEnroll with the device when its action is activated', async () => {
    devicesAPI.getTeamDevices.mockResolvedValue({
      data: {
        devices: [
          {
            deviceUserId: 1,
            username: 'AUK-D7K3QMX',
            deviceLabel: 'Engine 4 Tablet',
            teamId: 5,
            createdAt: '2025-01-02T03:04:05Z',
            liveCertificateCount: 0,
          },
        ],
      },
    })
    const onEnroll = vi.fn()

    root = createRoot(container)
    await act(async () => {
      root.render(<TeamDeviceList teamId={5} onEnroll={onEnroll} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    const button = container.querySelector('button[title="Enroll device"]')
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onEnroll).toHaveBeenCalledWith(
      expect.objectContaining({ deviceUserId: 1, username: 'AUK-D7K3QMX' })
    )
  })

  it('shows an inline message and no device rows on a fetch failure', async () => {
    devicesAPI.getTeamDevices.mockRejectedValue({ response: { status: 403 } })

    root = createRoot(container)
    await act(async () => {
      root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]').textContent).toMatch(/administer/)
    expect(container.querySelectorAll('li').length).toBe(0)
  })

  it('does not throw for a device carrying an explicit null email field, and renders no email anywhere (Criteria 5.9, 5.10)', async () => {
    // The API contract is that a device carries no `email` field at all
    // (Criterion 5.10), but this asserts the defensive case too: even if a
    // future response defensively included `email: null`, this component
    // must not throw on it and must still show no email anywhere.
    devicesAPI.getTeamDevices.mockResolvedValue({
      data: {
        devices: [
          {
            deviceUserId: 3,
            username: 'AUK-D5H8NRT',
            deviceLabel: 'Spare Tablet',
            teamId: 5,
            createdAt: '2025-03-01T00:00:00Z',
            liveCertificateCount: 0,
            email: null,
          },
        ],
      },
    })

    root = createRoot(container)
    await expect(
      act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
    ).resolves.not.toThrow()
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Spare Tablet')
    expect(container.textContent).toContain('AUK-D5H8NRT')
    expect(container.textContent).not.toContain('@')
    expect(container.querySelector('[data-field="email"]')).toBeNull()
  })

  // Bugfix (mobile tap targets too small): the card block's DeviceActions
  // usage passes variant="card" (p-2/rounded-lg/h-5 w-5 button box); the
  // desktop table's usage stays the default compact variant (bare h-4 w-4
  // icon, no box). Both render simultaneously in jsdom (CSS-only
  // sm:hidden/hidden sm:block, not conditional rendering), so this reads
  // each action's button from its own DOM subtree via the .sm\\:hidden /
  // .hidden.sm\\:block wrapper.
  it('gives the mobile card\'s device actions a button-box (variant="card"), while the desktop table keeps the compact bare-icon style', async () => {
    devicesAPI.getTeamDevices.mockResolvedValue({
      data: {
        devices: [
          { deviceUserId: 1, username: 'AUK-D7K3QMX', deviceLabel: 'Engine 4 Tablet', teamId: 5, createdAt: '2025-01-02T03:04:05Z', liveCertificateCount: 0 },
        ],
      },
    })

    root = createRoot(container)
    await act(async () => {
      root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    const cardWrapper = container.querySelector('.sm\\:hidden')
    const tableWrapper = container.querySelector('.hidden.sm\\:block')
    expect(cardWrapper).not.toBeNull()
    expect(tableWrapper).not.toBeNull()

    const cardEditButton = cardWrapper.querySelector('button[title="Edit device"]')
    const tableEditButton = tableWrapper.querySelector('button[title="Edit device"]')
    expect(cardEditButton).not.toBeNull()
    expect(tableEditButton).not.toBeNull()

    expect(cardEditButton.className).toContain('p-2')
    expect(cardEditButton.className).toContain('rounded-lg')
    expect(cardEditButton.querySelector('svg').getAttribute('class')).toContain('h-5 w-5')

    expect(tableEditButton.className).not.toContain('p-2')
    expect(tableEditButton.className).not.toContain('rounded-lg')
    expect(tableEditButton.querySelector('svg').getAttribute('class')).toContain('h-4 w-4')
  })

  it('renders no `<table overflow-x-auto>` combination anywhere', async () => {
    devicesAPI.getTeamDevices.mockResolvedValue({ data: { devices: [] } })

    root = createRoot(container)
    await act(async () => {
      root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.querySelector('table')).toBeNull()
    expect(container.querySelector('.overflow-x-auto')).toBeNull()
  })

  // account-lifecycle-management Requirement 1.11: Suspend/Unsuspend is
  // offered on the Team Devices tab too (a Team_Owned_Device is a `users`
  // row like any other), mirroring `MemberActions.jsx`'s own
  // onSuspend/accountStatus convention exactly.
  describe('Suspend/Unsuspend action (account-lifecycle-management)', () => {
    const baseDevice = {
      deviceUserId: 1,
      username: 'AUK-D7K3QMX',
      deviceLabel: 'Engine 4 Tablet',
      teamId: 5,
      createdAt: '2025-01-02T03:04:05Z',
      liveCertificateCount: 0
    }

    it('renders nothing when the device carries no accountStatus (active, the pre-existing default)', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({ data: { devices: [{ ...baseDevice }] } })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      // Undefined accountStatus is not 'orphaned', so the action is
      // still offered (as a "Suspend" action, since it's not
      // 'suspended' either) -- this exercises that default branch.
      expect(container.querySelector('button[title="Suspend device account"]')).not.toBeNull()
    })

    it('renders a closed-lock "Suspend device account" button when accountStatus is "active"', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({
        data: { devices: [{ ...baseDevice, accountStatus: 'active' }] }
      })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(container.querySelector('button[title="Suspend device account"]')).not.toBeNull()
      expect(container.querySelector('button[title="Unsuspend device account"]')).toBeNull()
    })

    it('renders an open-lock "Unsuspend device account" button when accountStatus is "suspended"', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({
        data: { devices: [{ ...baseDevice, accountStatus: 'suspended' }] }
      })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(container.querySelector('button[title="Unsuspend device account"]')).not.toBeNull()
      expect(container.querySelector('button[title="Suspend device account"]')).toBeNull()
    })

    // Bugfix: Suspend now gets the same red/danger treatment as Delete,
    // not the neutral grey every other action uses -- locking the
    // account and revoking every live certificate is disruptive enough
    // to carry the same "this one's different" colour signal.
    it('applies the red/danger colour to Suspend, and grey to Unsuspend (the reverse, non-destructive direction)', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({
        data: { devices: [{ ...baseDevice, accountStatus: 'active' }] }
      })
      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      const suspendButton = container.querySelector('button[title="Suspend device account"]')
      expect(suspendButton.className).toContain('text-red-600')
      expect(suspendButton.className).not.toContain('text-gray-600')

      devicesAPI.getTeamDevices.mockResolvedValue({
        data: { devices: [{ ...baseDevice, accountStatus: 'suspended' }] }
      })
      const root2Container = document.createElement('div')
      document.body.appendChild(root2Container)
      const root2 = createRoot(root2Container)
      await act(async () => {
        root2.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => {
        await Promise.resolve()
      })
      const unsuspendButton = root2Container.querySelector('button[title="Unsuspend device account"]')
      expect(unsuspendButton.className).toContain('text-gray-600')
      expect(unsuspendButton.className).not.toContain('text-red-600')

      await act(async () => {
        root2.unmount()
      })
      root2Container.remove()
    })

    it('omits the action entirely when accountStatus is "orphaned"', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({
        data: { devices: [{ ...baseDevice, accountStatus: 'orphaned' }] }
      })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(container.querySelector('button[title="Suspend device account"]')).toBeNull()
      expect(container.querySelector('button[title="Unsuspend device account"]')).toBeNull()
      // The rest of the action group (Edit/Transfer/Enroll/Delete) is
      // unaffected -- only Suspend/Unsuspend is omitted.
      expect(container.querySelector('button[title="Delete device"]')).not.toBeNull()
    })

    it('opens the shared SuspendAccountDialog with this device\'s targetUserId/targetName/mode when the action is activated', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({
        data: { devices: [{ ...baseDevice, accountStatus: 'active' }] }
      })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      const button = container.querySelector('button[title="Suspend device account"]')
      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      const dialogTitle = container.querySelector('#suspend-account-title')
      expect(dialogTitle).not.toBeNull()
      expect(dialogTitle.textContent).toBe('Suspend Account')
      expect(container.textContent).toContain('Engine 4 Tablet')
    })

    it('renders the shared "Suspended"/"Account not found in Authentik" text badge for the corresponding accountStatus', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({
        data: {
          devices: [
            { ...baseDevice, deviceUserId: 1, accountStatus: 'suspended' },
            { ...baseDevice, deviceUserId: 2, username: 'AUK-D9Q2WXY', accountStatus: 'orphaned' }
          ]
        }
      })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(container.textContent).toContain('Suspended')
      expect(container.textContent).toContain('Account not found in Authentik')
    })

    it('renders no account-status badge for an active device', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({
        data: { devices: [{ ...baseDevice, accountStatus: 'active' }] }
      })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(container.textContent).not.toContain('Suspended')
      expect(container.textContent).not.toContain('Account not found in Authentik')
    })

    it('refetches the device list after a successful suspend/unsuspend, via the dialog\'s onCompleted callback', async () => {
      devicesAPI.getTeamDevices
        .mockResolvedValueOnce({ data: { devices: [{ ...baseDevice, accountStatus: 'active' }] } })
        .mockResolvedValueOnce({ data: { devices: [{ ...baseDevice, accountStatus: 'suspended' }] } })
      usersAPI.suspendAccount.mockResolvedValue({ data: {} })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      const suspendButton = container.querySelector('button[title="Suspend device account"]')
      await act(async () => {
        suspendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      const dialog = container.querySelector('#suspend-account-title').closest('[role="dialog"]')
      const confirmButton = dialog.querySelector('button.btn-danger')
      // Bugfix (type-to-confirm parity with "Permanently Delete User"/
      // "Delete Channel"): Suspend now requires the device's own
      // username typed exactly before the confirm button enables.
      expect(confirmButton.disabled).toBe(true)
      const confirmInput = dialog.querySelector('#suspend-account-confirm')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      await act(async () => {
        setter.call(confirmInput, baseDevice.username)
        confirmInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(confirmButton.disabled).toBe(false)

      await act(async () => {
        confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(usersAPI.suspendAccount).toHaveBeenCalledWith(1)
      expect(devicesAPI.getTeamDevices).toHaveBeenCalledTimes(2)
    })
  })
})
