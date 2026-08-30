import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import RevokeDeviceDialog, {
  REVOKE_CONFIRMATION_WORD,
  REVOKE_WARNING_STATEMENT,
  isRevokeConfirmed,
  interpretRevokeError
} from './RevokeDeviceDialog.jsx'
import { deviceManagementAPI } from '../services/api'

// Validates: Requirements 7.2, 7.3, 8.2, 8.3
//
// This project has no `@testing-library/react` (absent from
// `client/package.json` and from `client/node_modules`) and no dependency is
// added for this task, so the dialog is driven the way
// `src/components/TransferMemberDialog.test.jsx` established: its exported
// pure helpers are asserted directly, and the component itself is mounted
// with `react-dom/client`'s `createRoot` plus React 18's own `act` under the
// `jsdom` environment already configured in `vite.config.js`.
//
// `../services/api` and `react-hot-toast` are the only mocks: the network
// boundary and the toast sink. Everything else is the real component.

vi.mock('../services/api', () => ({
  deviceManagementAPI: {
    revokeMyDevice: vi.fn(),
    revokeUserDevice: vi.fn()
  }
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}))

// Vitest resolves this project's Vite config but does not apply
// `@vitejs/plugin-react` to the modules it loads, so JSX here and in the
// component under test is compiled by esbuild's classic transform to
// `React.createElement` rather than the automatic `react/jsx-runtime`
// import. The component source (correctly, for the app build) has no
// `React` import of its own, so the classic transform needs one in scope.
globalThis.React = React

const DEVICE = { clientUid: 'ANDROID-deadbeef01', issuedAt: '2025-01-02T03:04:05Z' }

describe('isRevokeConfirmed (Reqs 7.3, 8.3)', () => {
  it('accepts only the exact literal REVOKE', () => {
    expect(isRevokeConfirmed('REVOKE')).toBe(true)
    expect(REVOKE_CONFIRMATION_WORD).toBe('REVOKE')
  })

  it('rejects case, whitespace, and partial variants', () => {
    for (const text of ['revoke', 'Revoke', ' REVOKE', 'REVOKE ', 'REVOK', 'REVOKEE', '']) {
      expect(isRevokeConfirmed(text)).toBe(false)
    }
  })

  it('rejects a missing value rather than throwing', () => {
    expect(isRevokeConfirmed(undefined)).toBe(false)
    expect(isRevokeConfirmed(null)).toBe(false)
  })

  it('rejects the device UID, which is deliberately not the confirmation word', () => {
    expect(isRevokeConfirmed(DEVICE.clientUid)).toBe(false)
  })
})

describe('interpretRevokeError', () => {
  it('prefers the server-supplied message', () => {
    const error = { response: { status: 403, data: { error: 'Not a managed user' } } }
    expect(interpretRevokeError(error)).toBe('Not a managed user')
  })

  it('maps a rejected confirmation (400) to a retype instruction', () => {
    expect(interpretRevokeError({ response: { status: 400 } })).toContain(REVOKE_CONFIRMATION_WORD)
  })

  it('maps 403 and 404 to their own messages', () => {
    expect(interpretRevokeError({ response: { status: 403 } })).toBe('You are not allowed to revoke this device.')
    expect(interpretRevokeError({ response: { status: 404 } })).toBe('This device is no longer available.')
  })

  it('falls back to a generic message for a 5xx or a network failure', () => {
    expect(interpretRevokeError({ response: { status: 500 } })).toBe('Failed to revoke the device. Please try again.')
    expect(interpretRevokeError(new Error('Network Error'))).toBe('Failed to revoke the device. Please try again.')
  })
})

describe('RevokeDeviceDialog (mounted)', () => {
  let container
  let root
  let onClose
  let onRevoked

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    onClose = vi.fn()
    onRevoked = vi.fn()
    deviceManagementAPI.revokeMyDevice.mockResolvedValue({ data: { enqueued: true } })
    deviceManagementAPI.revokeUserDevice.mockResolvedValue({ data: { enqueued: true } })
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

  const mount = async (props = {}) => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <RevokeDeviceDialog device={DEVICE} onClose={onClose} onRevoked={onRevoked} {...props} />
      )
    })
  }

  const text = () => container.textContent
  const confirmButton = () => container.querySelector('button[type="submit"]')
  const confirmInput = () => container.querySelector('#revoke-confirmation')

  const type = async (value) => {
    const el = confirmInput()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const submit = async () => {
    const form = container.querySelector('form')
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
  }

  it('shows the warning and asks for the REVOKE type-in (Reqs 7.2, 8.2)', async () => {
    await mount()
    expect(text()).toContain(REVOKE_WARNING_STATEMENT)
    expect(text()).toContain(REVOKE_CONFIRMATION_WORD)
    expect(text()).toContain(DEVICE.clientUid)
  })

  // Requirements 7.2, 8.2: the confirm button stays disabled until the typed
  // text is exactly `REVOKE`.
  it('disables the confirm button until the input is exactly REVOKE', async () => {
    await mount()
    expect(confirmButton().disabled).toBe(true)

    for (const nearMiss of ['R', 'revoke', 'Revoke', 'REVOK', ' REVOKE', 'REVOKE ', DEVICE.clientUid]) {
      await type(nearMiss)
      expect(confirmButton().disabled).toBe(true)
    }

    await type(REVOKE_CONFIRMATION_WORD)
    expect(confirmButton().disabled).toBe(false)
  })

  it('re-disables the confirm button when a confirmed input is edited away', async () => {
    await mount()
    await type(REVOKE_CONFIRMATION_WORD)
    expect(confirmButton().disabled).toBe(false)

    await type('REVOK')
    expect(confirmButton().disabled).toBe(true)
  })

  it('sends nothing while the confirmation is not exactly REVOKE (Reqs 7.3, 8.3)', async () => {
    await mount()
    await type('revoke')
    await submit()

    expect(deviceManagementAPI.revokeMyDevice).not.toHaveBeenCalled()
    expect(deviceManagementAPI.revokeUserDevice).not.toHaveBeenCalled()
    expect(onRevoked).not.toHaveBeenCalled()
  })

  // The same component serves both revocation surfaces; `userId` is what
  // selects the endpoint.
  it('calls revokeMyDevice for the self-service flow (no userId) (Req 7.3)', async () => {
    await mount()
    await type(REVOKE_CONFIRMATION_WORD)
    await submit()

    expect(deviceManagementAPI.revokeMyDevice).toHaveBeenCalledWith(DEVICE.clientUid, 'REVOKE')
    expect(deviceManagementAPI.revokeUserDevice).not.toHaveBeenCalled()
    expect(onRevoked).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls revokeUserDevice for the admin flow (userId given) (Req 8.3)', async () => {
    await mount({ userId: 42, userName: 'Ada Lovelace' })
    expect(text()).toContain('Ada Lovelace')

    await type(REVOKE_CONFIRMATION_WORD)
    await submit()

    expect(deviceManagementAPI.revokeUserDevice).toHaveBeenCalledWith(42, DEVICE.clientUid, 'REVOKE')
    expect(deviceManagementAPI.revokeMyDevice).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and shows the failure inline when the revoke is rejected', async () => {
    deviceManagementAPI.revokeMyDevice.mockRejectedValue({
      response: { status: 403, data: { error: 'Not your device' } }
    })

    await mount()
    await type(REVOKE_CONFIRMATION_WORD)
    await submit()

    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(container.querySelector('[role="alert"]').textContent).toBe('Not your device')
    expect(onRevoked).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

// Bugfix (mobile UI/UX pass): the dialog box is full-bleed on mobile
// (w-full h-full, no rounding) rather than a small floating card, for
// consistency with every other modal in this app -- see
// TeamDetail.jsx's comment on the same fix for its own dialogs.
describe('RevokeDeviceDialog: full-bleed on mobile (bugfix)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
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
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  it('renders the dialog box with w-full h-full and sm:-gated rounding/max-width, not an unconditional rounded-lg/max-w-lg', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <RevokeDeviceDialog
          device={{ deviceUserId: 1, username: 'AUK-D7K3QMX', deviceLabel: null }}
          onClose={() => {}}
          onRevoked={() => {}}
        />
      )
    })

    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog.className).toContain('w-full h-full')
    expect(dialog.className).toContain('sm:rounded-lg')
    expect(dialog.className).toContain('sm:max-w-lg')
    expect(dialog.className).not.toMatch(/(?<!sm:)rounded-lg/)
  })
})
