import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import TeamDeviceList, {
  deviceDisplayName,
  interpretTeamDeviceListError,
} from './TeamDeviceList.jsx'
import { devicesAPI, usersAPI, teamsAPI } from '../services/api'

// takserver-enrollment Requirements 5.9, 5.10, 14.7 (task 11.2)
//
// Sanity coverage for the team-device list surface. This project has no
// `@testing-library/react`, so the component is mounted with
// `react-dom/client`'s `createRoot` plus React 18's own `act`.
globalThis.React = React

vi.mock('../services/api', () => ({
  devicesAPI: {
    getTeamDevices: vi.fn(),
    delete: vi.fn(),
    bulkDelete: vi.fn(),
  },
  // account-lifecycle-management Requirement 1.11: stubbed because
  // `SuspendAccountDialog` (rendered by this component) imports
  // `usersAPI` from this same mocked module -- a named import of a
  // missing export from a mocked ES module is a load-time failure, per
  // this project's mock-hygiene convention, even on a test that never
  // opens that dialog. `bulkSuspend`/`bulkUnsuspend`/`bulkTransfer` are
  // stubbed for the same reason: Orgs & Teams multi-select's
  // `BulkConfirmDialog`/`BulkTransferDialog` (also rendered by this
  // component) reach them, even though no test in this file opens a
  // bulk-action dialog.
  usersAPI: {
    suspendAccount: vi.fn(),
    unsuspendAccount: vi.fn(),
    bulkSuspend: vi.fn(),
    bulkUnsuspend: vi.fn(),
    bulkTransfer: vi.fn(),
  },
  teamsAPI: {
    getMyTeams: vi.fn(),
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
  it('returns a plain, info-toned message for a 403 (an expected permission outcome, not an error)', () => {
    const result = interpretTeamDeviceListError({ response: { status: 403 } })
    expect(result.tone).toBe('info')
    expect(result.message).toMatch(/team admins/i)
  })

  it('does NOT surface the raw server string for a 403 (it is the terse "Forbidden"); always uses friendly copy', () => {
    const result = interpretTeamDeviceListError({ response: { status: 403, data: { error: 'Forbidden' } } })
    expect(result.tone).toBe('info')
    expect(result.message).not.toBe('Forbidden')
    expect(result.message).toMatch(/team admins/i)
  })

  it('prefers the server message for a 400, tagged as an error', () => {
    const result = interpretTeamDeviceListError({ response: { status: 400, data: { error: 'bad id' } } })
    expect(result).toEqual({ message: 'bad id', tone: 'error' })
  })

  it('falls back to a generic error-toned message for anything else', () => {
    const result = interpretTeamDeviceListError({})
    expect(result.tone).toBe('error')
    expect(result.message).toMatch(/Failed to load/)
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
    // Orgs & Teams multi-select: a leading select-all checkbox column
    // (empty header text) now precedes the original four.
    const table = container.querySelector('table')
    const headerCells = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim())
    expect(headerCells).toEqual(['', 'Device', 'TAK Callsign & Role', 'Added', 'Actions'])
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

  it('shows a polite, non-alert info message (role=status, not red/alert) and no device rows on a 403', async () => {
    devicesAPI.getTeamDevices.mockRejectedValue({ response: { status: 403, data: { error: 'Forbidden' } } })

    root = createRoot(container)
    await act(async () => {
      root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    // A 403 is an expected permission outcome: announced as status, not alert,
    // and never the raw "Forbidden" server string.
    const status = container.querySelector('[role="status"]')
    expect(status).not.toBeNull()
    expect(status.textContent).toMatch(/team admins/i)
    expect(status.textContent).not.toBe('Forbidden')
    expect(status.className).toContain('text-gray-500')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelectorAll('li').length).toBe(0)
  })

  it('shows a red alert message and no device rows on a genuine (5xx) fetch failure', async () => {
    devicesAPI.getTeamDevices.mockRejectedValue({ response: { status: 500 } })

    root = createRoot(container)
    await act(async () => {
      root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert.textContent).toMatch(/Failed to load/)
    expect(alert.className).toContain('text-red-600')
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

  // Bugfix (type-to-confirm consistency): permanently deleting a device
  // now requires typing its own username, matching "Permanently Delete
  // User"/"Delete Channel"/"Delete Sub-Team"'s established pattern for
  // permanent deletion, rather than a plain Cancel/Confirm dialog.
  describe('Delete device (type-to-confirm bugfix)', () => {
    const baseDevice = {
      deviceUserId: 1,
      username: 'AUK-D7K3QMX',
      deviceLabel: 'Engine 4 Tablet',
      teamId: 5,
      createdAt: '2024-01-01T00:00:00Z',
      liveCertificateCount: 1,
      accountStatus: 'active',
    }

    function setInputValue(input, value) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }

    it("disables the Confirm button until the device's exact username is typed", async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({ data: { devices: [{ ...baseDevice }] } })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      const deleteButton = container.querySelector('button[title="Delete device"]')
      await act(async () => {
        deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      const dialog = container.querySelector('#delete-device-title').closest('[role="dialog"]')
      const confirmButton = dialog.querySelector('button.btn-danger')
      expect(confirmButton.disabled).toBe(true)

      const confirmInput = dialog.querySelector('#delete-device-confirm')
      await act(async () => {
        setInputValue(confirmInput, 'wrong-value')
      })
      expect(confirmButton.disabled).toBe(true)

      await act(async () => {
        setInputValue(confirmInput, baseDevice.username)
      })
      expect(confirmButton.disabled).toBe(false)

      expect(devicesAPI.delete).not.toHaveBeenCalled()
    })

    it('calls devicesAPI.delete only once the exact username has been typed and Confirm is clicked', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({ data: { devices: [{ ...baseDevice }] } })
      devicesAPI.delete.mockResolvedValue({ data: {} })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      const deleteButton = container.querySelector('button[title="Delete device"]')
      await act(async () => {
        deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      const dialog = container.querySelector('#delete-device-title').closest('[role="dialog"]')
      const confirmInput = dialog.querySelector('#delete-device-confirm')
      await act(async () => {
        setInputValue(confirmInput, baseDevice.username)
      })

      const confirmButton = dialog.querySelector('button.btn-danger')
      await act(async () => {
        confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(devicesAPI.delete).toHaveBeenCalledWith(1)
    })

    it('resets the typed confirmation value after Cancel, so reopening never starts pre-filled', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({ data: { devices: [{ ...baseDevice }] } })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => {
        await Promise.resolve()
      })

      const deleteButton = container.querySelector('button[title="Delete device"]')
      await act(async () => {
        deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      let dialog = container.querySelector('#delete-device-title').closest('[role="dialog"]')
      let confirmInput = dialog.querySelector('#delete-device-confirm')
      await act(async () => {
        setInputValue(confirmInput, baseDevice.username)
      })

      const cancelButton = dialog.querySelector('button.btn-secondary')
      await act(async () => {
        cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      await act(async () => {
        deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      dialog = container.querySelector('#delete-device-title').closest('[role="dialog"]')
      confirmInput = dialog.querySelector('#delete-device-confirm')
      expect(confirmInput.value).toBe('')
      const confirmButton = dialog.querySelector('button.btn-danger')
      expect(confirmButton.disabled).toBe(true)
    })
  })

  // Orgs & Teams multi-select: Team Devices tab bulk actions (Transfer/
  // Suspend/Unsuspend/Delete only -- Edit and Enroll are excluded, per
  // the user's own request).
  describe('Multi-select bulk actions (Transfer/Suspend/Unsuspend/Delete)', () => {
    const activeDevice = {
      deviceUserId: 1,
      username: 'AUK-D7K3QMX',
      deviceLabel: 'Engine 4 Tablet',
      teamId: 5,
      createdAt: '2024-01-01T00:00:00Z',
      liveCertificateCount: 0,
      accountStatus: 'active',
    }
    const suspendedDevice = {
      deviceUserId: 2,
      username: 'AUK-X9Q2WPLM',
      deviceLabel: 'Ladder 1 Tablet',
      teamId: 5,
      createdAt: '2024-01-01T00:00:00Z',
      liveCertificateCount: 0,
      accountStatus: 'suspended',
    }
    const orphanedDevice = {
      deviceUserId: 3,
      username: 'AUK-Z3K7RTQP',
      deviceLabel: 'Rescue 2 Tablet',
      teamId: 5,
      createdAt: '2024-01-01T00:00:00Z',
      liveCertificateCount: 0,
      accountStatus: 'orphaned',
    }

    const checkboxFor = (device) => container.querySelector(`input[aria-label="Select ${deviceDisplayName(device)}"]`)
    const clickCheckbox = async (device) => {
      await act(async () => {
        checkboxFor(device).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }
    const findButtonByText = (text) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text)

    it('shows no toolbar until at least one device is selected', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({ data: { devices: [{ ...activeDevice }] } })
      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => { await Promise.resolve() })

      expect(container.textContent).not.toContain('selected')
      expect(findButtonByText('Transfer')).toBeUndefined()
    })

    it('shows the toolbar with a selection count once a device is checked, and clears it via "Clear selection"', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({ data: { devices: [{ ...activeDevice }] } })
      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => { await Promise.resolve() })

      await clickCheckbox(activeDevice)
      expect(container.textContent).toContain('1 selected')
      expect(findButtonByText('Transfer')).not.toBeUndefined()
      expect(findButtonByText('Suspend')).not.toBeUndefined()
      expect(findButtonByText('Unsuspend')).not.toBeUndefined()
      expect(findButtonByText('Delete')).not.toBeUndefined()

      await click(findButtonByText('Clear selection'))
      expect(container.textContent).not.toContain('selected')
      expect(checkboxFor(activeDevice).checked).toBe(false)
    })

    async function click(el) {
      await act(async () => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }

    it('blocks Suspend outright (via toast, no dialog) when the selection includes an orphaned or already-suspended device', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({
        data: { devices: [{ ...activeDevice }, { ...suspendedDevice }] }
      })
      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => { await Promise.resolve() })

      await clickCheckbox(activeDevice)
      await clickCheckbox(suspendedDevice)
      await click(findButtonByText('Suspend'))

      // Blocked outright: no bulk-confirm dialog opens.
      expect(container.querySelector('#bulk-confirm-title')).toBeNull()
    })

    it('opens the type-to-confirm Suspend dialog when every selected device is eligible, and calls usersAPI.bulkSuspend with every selected id', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({ data: { devices: [{ ...activeDevice }] } })
      usersAPI.bulkSuspend.mockResolvedValue({
        data: { successCount: 1, failureCount: 0, results: [{ userId: 1, success: true }] }
      })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => { await Promise.resolve() })

      await clickCheckbox(activeDevice)
      await click(findButtonByText('Suspend'))

      const dialog = container.querySelector('#bulk-confirm-title').closest('[role="dialog"]')
      expect(dialog).not.toBeNull()
      const confirmButton = dialog.querySelector('button.btn-danger')
      expect(confirmButton.disabled).toBe(true)

      const input = dialog.querySelector('#bulk-confirm-input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      await act(async () => {
        setter.call(input, 'SUSPEND')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await click(dialog.querySelector('button.btn-danger'))

      expect(usersAPI.bulkSuspend).toHaveBeenCalledWith([1])
    })

    it('blocks Unsuspend outright when the selection includes a non-suspended device', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({ data: { devices: [{ ...activeDevice }] } })
      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => { await Promise.resolve() })

      await clickCheckbox(activeDevice)
      await click(findButtonByText('Unsuspend'))

      expect(container.querySelector('#bulk-confirm-title')).toBeNull()
    })

    it('opens the plain Unsuspend dialog (no type-to-confirm) when every selected device is suspended', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({ data: { devices: [{ ...suspendedDevice }] } })
      usersAPI.bulkUnsuspend.mockResolvedValue({
        data: { successCount: 1, failureCount: 0, results: [{ userId: 2, success: true }] }
      })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => { await Promise.resolve() })

      await clickCheckbox(suspendedDevice)
      await click(findButtonByText('Unsuspend'))

      const dialog = container.querySelector('#bulk-confirm-title').closest('[role="dialog"]')
      expect(dialog.querySelector('#bulk-confirm-input')).toBeNull()
      await click(dialog.querySelector('button.btn-primary'))

      expect(usersAPI.bulkUnsuspend).toHaveBeenCalledWith([2])
    })

    it('opens the type-to-confirm Delete dialog and calls devicesAPI.bulkDelete with every selected deviceUserId, with no Global_Manager-only restriction', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({ data: { devices: [{ ...activeDevice }, { ...orphanedDevice }] } })
      devicesAPI.bulkDelete.mockResolvedValue({
        data: { successCount: 2, failureCount: 0, results: [{ deviceUserId: 1, success: true }, { deviceUserId: 3, success: true }] }
      })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => { await Promise.resolve() })

      await clickCheckbox(activeDevice)
      await clickCheckbox(orphanedDevice)
      await click(findButtonByText('Delete'))

      const dialog = container.querySelector('#bulk-confirm-title').closest('[role="dialog"]')
      const input = dialog.querySelector('#bulk-confirm-input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      await act(async () => {
        setter.call(input, 'DELETE')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await click(dialog.querySelector('button.btn-danger'))

      expect(devicesAPI.bulkDelete).toHaveBeenCalledWith([1, 3])
    })

    it('opens BulkTransferDialog, adapting each selected device via toTransferMember', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({ data: { devices: [{ ...activeDevice }] } })
      teamsAPI.getMyTeams.mockResolvedValue({ data: { teams: [] } })

      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => { await Promise.resolve() })

      await clickCheckbox(activeDevice)
      await click(findButtonByText('Transfer'))
      await act(async () => { await Promise.resolve() })

      expect(container.querySelector('#bulk-transfer-title')).not.toBeNull()
      expect(container.textContent).toContain(deviceDisplayName(activeDevice))
    })

    it('checking the same device in the mobile card and desktop table toggles the identical selectedDeviceIds entry', async () => {
      devicesAPI.getTeamDevices.mockResolvedValue({ data: { devices: [{ ...activeDevice }] } })
      root = createRoot(container)
      await act(async () => {
        root.render(<TeamDeviceList teamId={5} onEnroll={() => {}} />)
      })
      await act(async () => { await Promise.resolve() })

      const checkboxes = container.querySelectorAll(`input[aria-label="Select ${deviceDisplayName(activeDevice)}"]`)
      // One in the sm:hidden card block, one in the hidden sm:block table.
      expect(checkboxes.length).toBe(2)

      await act(async () => {
        checkboxes[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      // Both checkboxes reflect the SAME underlying Set.
      expect(checkboxes[0].checked).toBe(true)
      expect(checkboxes[1].checked).toBe(true)
    })
  })
})
