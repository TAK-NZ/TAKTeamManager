import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import TeamDeviceList, {
  deviceDisplayName,
  interpretTeamDeviceListError,
} from './TeamDeviceList.jsx'
import { devicesAPI } from '../services/api'

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
})
