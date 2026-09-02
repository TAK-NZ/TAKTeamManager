import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import ServiceAccountActionConfirmDialog from './ServiceAccountActionConfirmDialog.jsx'
import { globalChannelsAPI } from '../services/api'

// Bugfix (BCH credentials modal: cycle password / delete service
// account): both type-to-confirm the service account's own username,
// mirroring SuspendAccountDialog.jsx's targetUsername convention.

vi.mock('../services/api', () => ({
  globalChannelsAPI: {
    rotateServiceAccountPassword: vi.fn(),
    deleteServiceAccount: vi.fn()
  }
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}))

import toast from 'react-hot-toast'

globalThis.React = React

const USERNAME = 'etl-data-packages'

describe('ServiceAccountActionConfirmDialog (mounted)', () => {
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
        <ServiceAccountActionConfirmDialog
          mode="rotate"
          channelId={1}
          channelName="Data Packages"
          serviceAccountUsername={USERNAME}
          onClose={onClose}
          onCompleted={onCompleted}
          {...props}
        />
      )
    })
  }

  const confirmInput = () => container.querySelector('#service-account-action-confirm')
  const confirmButton = (label) =>
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === label)

  const typeConfirm = async (value) => {
    const input = confirmInput()
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      nativeInputValueSetter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  describe('mode="rotate"', () => {
    it('shows the rotate copy and requires the exact username to enable the confirm button', async () => {
      await mount({ mode: 'rotate' })

      expect(container.textContent).toContain('Cycle Service Account Password')
      expect(confirmButton('Cycle Password').disabled).toBe(true)

      await typeConfirm(USERNAME)

      expect(confirmButton('Cycle Password').disabled).toBe(false)
    })

    it('rejects a near-miss (case, whitespace, partial) confirmation', async () => {
      await mount({ mode: 'rotate' })

      for (const wrong of [USERNAME.toUpperCase(), `${USERNAME} `, USERNAME.slice(0, -1)]) {
        await typeConfirm(wrong)
        expect(confirmButton('Cycle Password').disabled, `expected disabled for "${wrong}"`).toBe(true)
      }
    })

    it('calls rotateServiceAccountPassword and completes on confirm', async () => {
      globalChannelsAPI.rotateServiceAccountPassword.mockResolvedValue({ data: {} })
      await mount({ mode: 'rotate' })

      await typeConfirm(USERNAME)
      await act(async () => {
        confirmButton('Cycle Password').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(globalChannelsAPI.rotateServiceAccountPassword).toHaveBeenCalledWith(1)
      expect(globalChannelsAPI.deleteServiceAccount).not.toHaveBeenCalled()
      expect(onCompleted).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(toast.success).toHaveBeenCalled()
    })

    it('renders btn-primary (not btn-danger) for the reversible rotate action', async () => {
      await mount({ mode: 'rotate' })

      await typeConfirm(USERNAME)
      expect(confirmButton('Cycle Password').className).toContain('btn-primary')
    })
  })

  describe('mode="delete"', () => {
    it('shows the delete copy and requires the exact username to enable the confirm button', async () => {
      await mount({ mode: 'delete' })

      expect(container.textContent).toContain('Delete Service Account')
      expect(confirmButton('Delete Service Account').disabled).toBe(true)

      await typeConfirm(USERNAME)

      expect(confirmButton('Delete Service Account').disabled).toBe(false)
    })

    it('calls deleteServiceAccount and completes on confirm', async () => {
      globalChannelsAPI.deleteServiceAccount.mockResolvedValue({ data: {} })
      await mount({ mode: 'delete' })

      await typeConfirm(USERNAME)
      await act(async () => {
        confirmButton('Delete Service Account').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(globalChannelsAPI.deleteServiceAccount).toHaveBeenCalledWith(1)
      expect(globalChannelsAPI.rotateServiceAccountPassword).not.toHaveBeenCalled()
      expect(onCompleted).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('renders btn-danger for the destructive delete action', async () => {
      await mount({ mode: 'delete' })

      await typeConfirm(USERNAME)
      expect(confirmButton('Delete Service Account').className).toContain('btn-danger')
    })
  })

  it('shows the server error inline and does not close the dialog on failure', async () => {
    globalChannelsAPI.deleteServiceAccount.mockRejectedValue({
      response: { data: { error: 'This channel has no service account to delete' } }
    })
    await mount({ mode: 'delete' })

    await typeConfirm(USERNAME)
    await act(async () => {
      confirmButton('Delete Service Account').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('This channel has no service account to delete')
    expect(onClose).not.toHaveBeenCalled()
    expect(onCompleted).not.toHaveBeenCalled()
  })

  it('calls onClose (and clears the input) when Cancel is clicked', async () => {
    await mount({ mode: 'delete' })

    await typeConfirm('partial')
    const cancelButton = confirmButton('Cancel')
    await act(async () => {
      cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the header close button is clicked', async () => {
    await mount({ mode: 'rotate' })

    const closeButton = container.querySelector('button[aria-label="Close cycle password dialog"]')
    await act(async () => {
      closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
