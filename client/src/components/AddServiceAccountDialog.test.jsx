import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import AddServiceAccountDialog, { AVAILABILITY_CHECK_DEBOUNCE_MS } from './AddServiceAccountDialog.jsx'
import { globalChannelsAPI } from '../services/api'

// Bugfix (Add Service Account dialog): replaces the previous one-click
// "Provision Service Account" action with a dialog naming the account,
// the `etl-` prefix fixed and non-editable.
//
// Bugfix (collision/takeover risk): also runs a debounced live
// availability check before submit is enabled -- fake timers are used
// throughout so tests can deterministically advance past
// AVAILABILITY_CHECK_DEBOUNCE_MS rather than racing a real setTimeout.
//
// This project has no `@testing-library/react`, so the dialog is mounted
// with `react-dom/client`'s `createRoot` plus React 18's own `act`,
// following `RevokeDeviceDialog.test.jsx`'s established convention.
// `../services/api` and `react-hot-toast` are the only mocks.

vi.mock('../services/api', () => ({
  globalChannelsAPI: {
    provisionServiceAccount: vi.fn(),
    checkServiceAccountAvailability: vi.fn()
  }
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}))

import toast from 'react-hot-toast'

globalThis.React = React

describe('AddServiceAccountDialog (mounted)', () => {
  let container
  let root
  let onClose
  let onCompleted

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    onClose = vi.fn()
    onCompleted = vi.fn()
    // Available by default -- most tests below are about the dialog's
    // mechanics, not the availability check itself (which has its own
    // dedicated describe block further down).
    globalChannelsAPI.checkServiceAccountAvailability.mockResolvedValue({ data: { available: true } })
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
    vi.useRealTimers()
  })

  const mount = async (props = {}) => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <AddServiceAccountDialog
          channelId={1}
          channelName="Data Packages"
          onClose={onClose}
          onCompleted={onCompleted}
          {...props}
        />
      )
    })
  }

  const suffixInput = () => container.querySelector('#service-account-suffix')
  const submitButton = () =>
    Array.from(container.querySelectorAll('button')).find((b) => /Add Service Account/.test(b.textContent))

  const typeSuffix = async (value) => {
    const input = suffixInput()
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      nativeInputValueSetter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  /** Advances past the debounce and flushes the resulting async check. */
  const runDebounce = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AVAILABILITY_CHECK_DEBOUNCE_MS)
    })
  }

  it('shows the channel name and the fixed, non-editable etl- prefix', async () => {
    await mount()

    expect(container.textContent).toContain('Data Packages')
    expect(container.textContent).toContain('etl-')
  })

  // Bugfix (explicit request): the input pre-fills with the
  // channel-name-derived recommendation rather than starting empty, and
  // that recommendation collapses a literal " - " folder-separator to a
  // single hyphen instead of "---".
  it('pre-fills the suffix input with the channel-name-derived recommendation', async () => {
    await mount({ channelName: 'Data Packages' })

    expect(suffixInput().value).toBe('data-packages')
  })

  it('pre-fills "inreach-devices" for channelName "InReach Devices", per the explicit example', async () => {
    await mount({ channelName: 'InReach Devices' })

    expect(suffixInput().value).toBe('inreach-devices')
  })

  it('collapses a literal " - " folder-separator in the channel name to a single hyphen, not "---"', async () => {
    await mount({ channelName: 'Alerts - MetService' })

    expect(suffixInput().value).toBe('alerts-metservice')
  })

  it('leaves the pre-filled recommendation editable by the admin', async () => {
    await mount({ channelName: 'Data Packages' })

    await typeSuffix('custom-name')

    expect(suffixInput().value).toBe('custom-name')
  })

  it('does not enable the submit button immediately -- availability has not been confirmed yet', async () => {
    await mount({ channelName: 'Data Packages' })

    expect(submitButton().disabled).toBe(true)
  })

  it('enables the submit button once the debounced availability check confirms the pre-filled recommendation is free', async () => {
    await mount({ channelName: 'Data Packages' })

    await runDebounce()

    expect(submitButton().disabled).toBe(false)
  })

  it('disables the submit button once the suffix is cleared', async () => {
    await mount({ channelName: 'Data Packages' })
    await runDebounce()
    expect(submitButton().disabled).toBe(false)

    await typeSuffix('')

    expect(submitButton().disabled).toBe(true)
  })

  it('keeps the submit button disabled for an invalid suffix (uppercase, spaces, leading hyphen), without calling the availability check', async () => {
    await mount()
    await runDebounce()
    globalChannelsAPI.checkServiceAccountAvailability.mockClear()

    for (const invalid of ['Data-Packages', 'data packages', '-data', 'data-', 'data--packages']) {
      await typeSuffix(invalid)
      await runDebounce()
      expect(submitButton().disabled, `expected disabled for suffix "${invalid}"`).toBe(true)
    }
    expect(globalChannelsAPI.checkServiceAccountAvailability).not.toHaveBeenCalled()
  })

  it('keeps the submit button disabled while the check is in flight, mid-debounce', async () => {
    let resolveCheck
    globalChannelsAPI.checkServiceAccountAvailability.mockReturnValue(
      new Promise((resolve) => { resolveCheck = resolve })
    )
    await mount({ channelName: 'Data Packages' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AVAILABILITY_CHECK_DEBOUNCE_MS)
    })
    // The debounce has fired and the request is in flight, but unresolved.
    expect(submitButton().disabled).toBe(true)
    expect(container.textContent).toContain('Checking availability')

    await act(async () => {
      resolveCheck({ data: { available: true } })
    })
    expect(submitButton().disabled).toBe(false)
  })

  it('submits the full etl-prefixed username, never the bare suffix', async () => {
    globalChannelsAPI.provisionServiceAccount.mockResolvedValue({ data: {} })
    await mount()
    await runDebounce()

    // The pre-filled recommendation for "Data Packages" is already
    // "data-packages" -- submitting without editing it.
    await act(async () => {
      submitButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(globalChannelsAPI.provisionServiceAccount).toHaveBeenCalledWith(1, 'etl-data-packages')
  })

  it('submits an admin-edited suffix instead of the pre-filled recommendation', async () => {
    globalChannelsAPI.provisionServiceAccount.mockResolvedValue({ data: {} })
    await mount()

    await typeSuffix('custom-name')
    await runDebounce()
    await act(async () => {
      submitButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(globalChannelsAPI.provisionServiceAccount).toHaveBeenCalledWith(1, 'etl-custom-name')
  })

  it('calls onCompleted and onClose after a successful submit', async () => {
    globalChannelsAPI.provisionServiceAccount.mockResolvedValue({ data: {} })
    await mount()
    await runDebounce()

    await act(async () => {
      submitButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onCompleted).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalled()
  })

  it('shows the server error inline and does not close the dialog on failure', async () => {
    globalChannelsAPI.provisionServiceAccount.mockRejectedValue({
      response: { data: { error: 'This channel already has a service account configured' } }
    })
    await mount()
    await runDebounce()

    await act(async () => {
      submitButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('This channel already has a service account configured')
    expect(onClose).not.toHaveBeenCalled()
    expect(onCompleted).not.toHaveBeenCalled()
  })

  it('calls onClose when the header close button is clicked', async () => {
    await mount()

    const closeButton = container.querySelector('button[aria-label="Close add service account dialog"]')
    await act(async () => {
      closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when Cancel is clicked', async () => {
    await mount()

    const cancelButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Cancel')
    await act(async () => {
      cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // Bugfix (collision/takeover risk): the live availability check itself.
  describe('live availability check', () => {
    it('calls checkServiceAccountAvailability with the full etl-prefixed username and the channelId', async () => {
      await mount({ channelId: 42, channelName: 'Data Packages' })

      await runDebounce()

      expect(globalChannelsAPI.checkServiceAccountAvailability).toHaveBeenCalledWith('etl-data-packages', 42)
    })

    it('does not fire the check until the debounce elapses', async () => {
      await mount()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(AVAILABILITY_CHECK_DEBOUNCE_MS - 50)
      })

      expect(globalChannelsAPI.checkServiceAccountAvailability).not.toHaveBeenCalled()
    })

    it('debounces rapid typing into a single check for the final value', async () => {
      await mount({ channelName: '' })

      await typeSuffix('d')
      await typeSuffix('da')
      await typeSuffix('dat')
      await typeSuffix('data')
      await runDebounce()

      expect(globalChannelsAPI.checkServiceAccountAvailability).toHaveBeenCalledTimes(1)
      expect(globalChannelsAPI.checkServiceAccountAvailability).toHaveBeenCalledWith('etl-data', 1)
    })

    it('shows the collision reason and keeps submit disabled when the name is unavailable', async () => {
      globalChannelsAPI.checkServiceAccountAvailability.mockResolvedValue({
        data: { available: false, reason: '"etl-data-packages" is already the service account for another channel ("Other Channel")' }
      })
      await mount()

      await runDebounce()

      expect(container.textContent).toContain('already the service account for another channel');
      expect(submitButton().disabled).toBe(true)
    })

    it('fails closed (submit stays disabled) when the availability check itself errors', async () => {
      globalChannelsAPI.checkServiceAccountAvailability.mockRejectedValue(new Error('network error'))
      await mount()

      await runDebounce()

      expect(submitButton().disabled).toBe(true)
    })

    it('re-checks and flips back to disabled when the admin edits an already-available name', async () => {
      await mount()
      await runDebounce()
      expect(submitButton().disabled).toBe(false)

      globalChannelsAPI.checkServiceAccountAvailability.mockResolvedValue({
        data: { available: false, reason: 'taken' }
      })
      await typeSuffix('data-packages-2')

      // Disabled immediately (a new suffix with no confirmed availability
      // yet), before the debounce has even fired.
      expect(submitButton().disabled).toBe(true)

      await runDebounce()

      expect(submitButton().disabled).toBe(true)
      expect(container.textContent).toContain('taken')
    })

    it('ignores a stale check result for a suffix the admin has since typed past', async () => {
      let resolveFirst
      globalChannelsAPI.checkServiceAccountAvailability.mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve })
      )
      await mount()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AVAILABILITY_CHECK_DEBOUNCE_MS)
      })
      // First check ("data-packages") is now in flight.

      globalChannelsAPI.checkServiceAccountAvailability.mockResolvedValue({ data: { available: true } })
      await typeSuffix('data-packages-renamed')
      await runDebounce()
      // Second check ("data-packages-renamed") has resolved as available.
      expect(submitButton().disabled).toBe(false)

      // The FIRST (stale) check now resolves as unavailable -- must not
      // override the second, more recent, already-applied result.
      await act(async () => {
        resolveFirst({ data: { available: false, reason: 'stale result, ignore me' } })
      })

      expect(submitButton().disabled).toBe(false)
      expect(container.textContent).not.toContain('stale result')
    })
  })
})
