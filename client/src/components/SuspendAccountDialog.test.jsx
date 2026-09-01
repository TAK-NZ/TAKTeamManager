import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import SuspendAccountDialog from './SuspendAccountDialog.jsx'
import { usersAPI } from '../services/api'

// Bugfix (consistency with "Permanently Delete User"/"Delete Channel"):
// Suspend now requires the admin to TYPE the target's username exactly
// before the Confirm button is enabled, mirroring
// `RevokeDeviceDialog.test.jsx`'s own mount-and-drive convention (no
// `@testing-library/react` in this project). Only `../services/api` and
// `react-hot-toast` are mocked -- the network boundary and the toast sink.

vi.mock('../services/api', () => ({
  usersAPI: {
    suspendAccount: vi.fn(),
    unsuspendAccount: vi.fn()
  }
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}))

// Vitest compiles this JSX with esbuild's classic transform, and the page
// sources carry no React import of their own.
globalThis.React = React

const TARGET_USER_ID = 42
const TARGET_USERNAME = 'jdoe'
const TARGET_NAME = 'Jane Doe'

describe('SuspendAccountDialog (mounted)', () => {
  let container
  let root
  let onClose
  let onCompleted

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    onClose = vi.fn()
    onCompleted = vi.fn()
    usersAPI.suspendAccount.mockResolvedValue({ data: {} })
    usersAPI.unsuspendAccount.mockResolvedValue({ data: {} })
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

  const mount = async (props = {}) => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <SuspendAccountDialog
          mode="suspend"
          targetUserId={TARGET_USER_ID}
          targetName={TARGET_NAME}
          targetUsername={TARGET_USERNAME}
          onClose={onClose}
          onCompleted={onCompleted}
          {...props}
        />
      )
    })
  }

  const confirmButton = () => Array.from(container.querySelectorAll('button')).find((b) => /Suspend Account|Unsuspend Account|Suspending\.\.\.|Unsuspending\.\.\./.test(b.textContent))
  const cancelButton = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')
  const confirmInput = () => container.querySelector('#suspend-account-confirm')

  const type = async (value) => {
    const el = confirmInput()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const click = async (el) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  describe('mode="suspend"', () => {
    it('shows a type-to-confirm input naming the target username', async () => {
      await mount()
      expect(confirmInput()).not.toBeNull()
      expect(container.textContent).toContain(TARGET_USERNAME)
    })

    it('disables the confirm button until the input matches the username exactly', async () => {
      await mount()
      expect(confirmButton().disabled).toBe(true)

      for (const nearMiss of ['j', 'jdo', 'jdoe ', ' jdoe', 'JDOE', 'Jane Doe']) {
        await type(nearMiss)
        expect(confirmButton().disabled).toBe(true)
      }

      await type(TARGET_USERNAME)
      expect(confirmButton().disabled).toBe(false)
    })

    it('re-disables the confirm button when a confirmed input is edited away', async () => {
      await mount()
      await type(TARGET_USERNAME)
      expect(confirmButton().disabled).toBe(false)

      await type('jdo')
      expect(confirmButton().disabled).toBe(true)
    })

    it('never calls suspendAccount while the input does not match (defense in depth beyond the disabled attribute)', async () => {
      await mount()
      await type('not-the-username')
      await click(confirmButton())

      expect(usersAPI.suspendAccount).not.toHaveBeenCalled()
    })

    it('calls suspendAccount once the username is typed exactly, then closes and reports completion', async () => {
      await mount()
      await type(TARGET_USERNAME)
      await click(confirmButton())

      expect(usersAPI.suspendAccount).toHaveBeenCalledWith(TARGET_USER_ID)
      expect(onCompleted).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('clears the typed confirmation and closes on Cancel', async () => {
      await mount()
      await type(TARGET_USERNAME)
      await click(cancelButton())

      expect(onClose).toHaveBeenCalledTimes(1)
      expect(usersAPI.suspendAccount).not.toHaveBeenCalled()
    })

    it('keeps the dialog open and shows the failure inline when the suspend is rejected', async () => {
      usersAPI.suspendAccount.mockRejectedValue({
        response: { status: 409, data: { error: 'Account already suspended' } }
      })

      await mount()
      await type(TARGET_USERNAME)
      await click(confirmButton())

      expect(container.querySelector('[role="dialog"]')).not.toBeNull()
      expect(container.querySelector('[role="alert"]').textContent).toBe('Account already suspended')
      expect(onCompleted).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
    })
  })

  describe('mode="unsuspend"', () => {
    it('shows no type-to-confirm input at all', async () => {
      await mount({ mode: 'unsuspend' })
      expect(confirmInput()).toBeNull()
    })

    it('leaves the confirm button enabled with no typed input required', async () => {
      await mount({ mode: 'unsuspend' })
      expect(confirmButton().disabled).toBe(false)
    })

    it('calls unsuspendAccount on confirm', async () => {
      await mount({ mode: 'unsuspend' })
      await click(confirmButton())

      expect(usersAPI.unsuspendAccount).toHaveBeenCalledWith(TARGET_USER_ID)
      expect(usersAPI.suspendAccount).not.toHaveBeenCalled()
      expect(onCompleted).toHaveBeenCalledTimes(1)
    })
  })
})
