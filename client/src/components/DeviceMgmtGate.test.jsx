import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import DeviceMgmtGate from './DeviceMgmtGate'
import { deviceManagementAPI } from '../services/api'

// Only probeEnabled is used by the gate; stub the whole module so a named
// import of any sibling export never load-fails.
vi.mock('../services/api', () => ({
  deviceManagementAPI: { probeEnabled: vi.fn() }
}))

globalThis.React = React

describe('DeviceMgmtGate', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => { root.unmount() })
      root = null
    }
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mount = async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <DeviceMgmtGate>
          <div data-testid="child">the real page</div>
        </DeviceMgmtGate>
      )
    })
    // let the probe promise settle
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
  }

  it('shows a spinner while the probe is in flight, then the children once enabled', async () => {
    let resolveProbe
    deviceManagementAPI.probeEnabled.mockReturnValue(
      new Promise((resolve) => { resolveProbe = resolve })
    )

    root = createRoot(container)
    await act(async () => {
      root.render(
        <DeviceMgmtGate>
          <div data-testid="child">the real page</div>
        </DeviceMgmtGate>
      )
    })

    // Still probing: spinner, no children, no not-available panel.
    expect(container.querySelector('.animate-spin')).not.toBeNull()
    expect(container.textContent).not.toContain('the real page')
    expect(container.textContent).not.toContain('not available')

    await act(async () => {
      resolveProbe({ enabled: true })
      await Promise.resolve()
    })

    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(container.textContent).toContain('the real page')
  })

  it('renders the not-available panel (not the children) when the feature is off', async () => {
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: false })

    await mount()

    expect(container.textContent).not.toContain('the real page')
    expect(container.textContent).toContain('Device management is not available')
  })

  it('fails closed to not-available when the probe rejects (non-404 error)', async () => {
    deviceManagementAPI.probeEnabled.mockRejectedValue(new Error('network down'))

    await mount()

    expect(container.textContent).not.toContain('the real page')
    expect(container.textContent).toContain('Device management is not available')
  })

  it('renders the children when the feature is on', async () => {
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: true })

    await mount()

    expect(container.querySelector('[data-testid="child"]')).not.toBeNull()
    expect(container.textContent).toContain('the real page')
  })
})
