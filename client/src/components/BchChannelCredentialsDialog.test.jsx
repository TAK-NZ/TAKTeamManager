import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import BchChannelCredentialsDialog from './BchChannelCredentialsDialog.jsx'

// Bugfix (/global-channels "Get credentials" button): the lite credentials
// view -- username as copyable plain text, password masked behind bullet
// characters with its own Copy button, no expiry countdown (BCH service
// account credentials never expire).
//
// This project has no `@testing-library/react`, so the dialog is mounted
// with `react-dom/client`'s `createRoot` plus React 18's own `act`,
// following `RevokeDeviceDialog.test.jsx`'s established convention.
// `react-hot-toast` is the only mock -- the toast sink. Clipboard access is
// stubbed directly on `navigator.clipboard` rather than mocked as a module.

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}))

import toast from 'react-hot-toast'

// Vitest compiles this JSX with esbuild's classic transform; the component
// under test carries no `React` import of its own.
globalThis.React = React

const CREDENTIALS = {
  service_account_username: 'etl-data-packages',
  service_account_password: 'super-secret-value'
}

describe('BchChannelCredentialsDialog (mounted)', () => {
  let container
  let root
  let onClose
  let writeTextMock

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    onClose = vi.fn()

    writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true
    })
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
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
        <BchChannelCredentialsDialog
          channelName="Data Packages"
          credentials={CREDENTIALS}
          onClose={onClose}
          {...props}
        />
      )
    })
  }

  it('shows the channel name and the username as visible plain text', async () => {
    await mount()

    expect(container.textContent).toContain('Data Packages')
    expect(container.textContent).toContain('etl-data-packages')
  })

  it('never renders the real password as visible text -- only a fixed run of bullet characters', async () => {
    await mount()

    expect(container.textContent).not.toContain('super-secret-value')
    expect(container.textContent).toContain('•'.repeat(12))
  })

  it('renders no expiry countdown -- BCH service account credentials never expire', async () => {
    await mount()

    expect(container.textContent.toLowerCase()).not.toContain('expires')
    expect(container.textContent.toLowerCase()).not.toContain('countdown')
  })

  it('copies the real username to the clipboard when its Copy button is clicked', async () => {
    await mount()

    const copyUsernameButton = container.querySelector('button[aria-label="Copy username"]')
    await act(async () => {
      copyUsernameButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(writeTextMock).toHaveBeenCalledWith('etl-data-packages')
    expect(toast.success).toHaveBeenCalledWith('Username copied to clipboard')
  })

  it('copies the real password to the clipboard when its Copy button is clicked, even though it is never shown', async () => {
    await mount()

    const copyPasswordButton = container.querySelector('button[aria-label="Copy password"]')
    await act(async () => {
      copyPasswordButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(writeTextMock).toHaveBeenCalledWith('super-secret-value')
    expect(toast.success).toHaveBeenCalledWith('Password copied to clipboard')
  })

  it('calls onClose when the header close button is clicked', async () => {
    await mount()

    const closeButton = container.querySelector('button[aria-label="Close credentials dialog"]')
    await act(async () => {
      closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the footer Close button is clicked', async () => {
    await mount()

    const closeButtons = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent.trim() === 'Close'
    )
    expect(closeButtons).toHaveLength(1)

    await act(async () => {
      closeButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // Bugfix (explicit request: cycle password / delete service account).
  describe('Cycle Password / Delete Service Account actions', () => {
    it('renders neither action when their callback props are omitted', async () => {
      await mount()

      expect(container.textContent).not.toContain('Cycle Password')
      expect(container.textContent).not.toContain('Delete Service Account')
    })

    it('renders Cycle Password when onRotateRequested is supplied, and calls it with the username', async () => {
      const onRotateRequested = vi.fn()
      await mount({ onRotateRequested })

      const button = Array.from(container.querySelectorAll('button')).find((b) => /Cycle Password/.test(b.textContent))
      expect(button).toBeDefined()

      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(onRotateRequested).toHaveBeenCalledWith('etl-data-packages')
    })

    it('renders Delete Service Account when onDeleteRequested is supplied, and calls it with the username', async () => {
      const onDeleteRequested = vi.fn()
      await mount({ onDeleteRequested })

      const button = Array.from(container.querySelectorAll('button')).find((b) => /Delete Service Account/.test(b.textContent))
      expect(button).toBeDefined()

      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(onDeleteRequested).toHaveBeenCalledWith('etl-data-packages')
    })

    it('never calls the API directly from either action -- only the callback prop', async () => {
      const onRotateRequested = vi.fn()
      const onDeleteRequested = vi.fn()
      await mount({ onRotateRequested, onDeleteRequested })

      const rotateButton = Array.from(container.querySelectorAll('button')).find((b) => /Cycle Password/.test(b.textContent))
      const deleteButton = Array.from(container.querySelectorAll('button')).find((b) => /Delete Service Account/.test(b.textContent))

      await act(async () => {
        rotateButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      // Neither action closes the dialog or shows a toast itself -- both
      // are entirely the parent's responsibility once the callback fires.
      expect(onClose).not.toHaveBeenCalled()
      expect(toast.success).not.toHaveBeenCalled()
    })
  })
})
