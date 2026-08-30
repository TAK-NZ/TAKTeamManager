import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import AddTeamDeviceDialog, {
  isValidDeviceCallsignSuffix,
  isCallsignSuffixMissing,
  extractDeviceCallsignSuffixServerError
} from './AddTeamDeviceDialog.jsx'
import { devicesAPI, usersAPI } from '../services/api'
import toast from 'react-hot-toast'

// This project has no `@testing-library/react`, so the dialog is mounted
// with `react-dom/client`'s `createRoot` plus React 18's own `act`,
// following the pattern established by `TransferMemberDialog.test.jsx`.
globalThis.React = React

vi.mock('../services/api', () => ({
  devicesAPI: { create: vi.fn() },
  usersAPI: { previewCallsignSuffix: vi.fn() }
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}))

describe('isValidDeviceCallsignSuffix', () => {
  it('accepts an empty value (the character-class check alone does not enforce presence)', () => {
    expect(isValidDeviceCallsignSuffix('')).toBe(true)
  })

  it('accepts letters, digits, "-", and "."', () => {
    expect(isValidDeviceCallsignSuffix('Tanker1')).toBe(true)
    expect(isValidDeviceCallsignSuffix('Engine-4.Tablet')).toBe(true)
  })

  it('rejects a value containing a disallowed character', () => {
    expect(isValidDeviceCallsignSuffix('Tanker 1')).toBe(false)
    expect(isValidDeviceCallsignSuffix('Tanker_1')).toBe(false)
  })
})

// Bug #6: "It is definitely not optional" -- the Callsign Suffix field is
// required, unlike the old copy that read "Optional".
describe('isCallsignSuffixMissing (bug #6: required, not optional)', () => {
  it('is missing for an empty, null, undefined, or whitespace-only value', () => {
    expect(isCallsignSuffixMissing('')).toBe(true)
    expect(isCallsignSuffixMissing(null)).toBe(true)
    expect(isCallsignSuffixMissing(undefined)).toBe(true)
    expect(isCallsignSuffixMissing('   ')).toBe(true)
  })

  it('is not missing for a non-empty value', () => {
    expect(isCallsignSuffixMissing('Tanker1')).toBe(false)
  })
})

describe('extractDeviceCallsignSuffixServerError', () => {
  it('returns the server message for a 400 (per-team collision or malformed value)', () => {
    const error = { response: { status: 400, data: { error: 'Callsign Suffix "Tanker1" is already in use within this Team' } } }
    expect(extractDeviceCallsignSuffixServerError(error)).toBe('Callsign Suffix "Tanker1" is already in use within this Team')
  })

  it('returns null for any non-400 failure, leaving the generic toast in place', () => {
    expect(extractDeviceCallsignSuffixServerError({ response: { status: 403 } })).toBeNull()
    expect(extractDeviceCallsignSuffixServerError({ response: { status: 500 } })).toBeNull()
  })

  it('returns null for a 400 with no string error body, and for a network failure', () => {
    expect(extractDeviceCallsignSuffixServerError({ response: { status: 400, data: {} } })).toBeNull()
    expect(extractDeviceCallsignSuffixServerError(new Error('Network Error'))).toBeNull()
  })
})

describe('AddTeamDeviceDialog (mounted)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    usersAPI.previewCallsignSuffix.mockResolvedValue({ data: { suffix: null, required: false, conflict: null } })
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

  const mount = async (props) => {
    root = createRoot(container)
    await act(async () => {
      root.render(<AddTeamDeviceDialog teamId={5} onClose={() => {}} onCreated={() => {}} {...props} />)
    })
  }

  const labelInput = () => container.querySelector('#team-device-label')
  const suffixInput = () => container.querySelector('#team-device-callsign-suffix')

  // React overrides the native <input> value setter to hook its own
  // change detection, so directly assigning `.value` and dispatching a
  // plain `input` event does not reach the controlled component's
  // `onChange` -- the native setter must be invoked explicitly first,
  // matching `TransferMemberDialog.test.jsx`'s/`Requests.test.jsx`'s own
  // established convention for a controlled input in this project.
  const setInputValue = async (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  // Dispatching a click on the submit <button> does not reliably reach
  // the form's onSubmit handler under jsdom in this project's test setup
  // -- `RevokeDeviceDialog.test.jsx` establishes the same convention of
  // dispatching a `submit` event on the <form> directly instead.
  const submitForm = async () => {
    const form = container.querySelector('form')
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
  }

  // Bugfix (mobile UI/UX pass): full-bleed on mobile, matching every
  // other modal in this app.
  it('renders the dialog box with w-full h-full and sm:-gated rounding/max-width', async () => {
    await mount()

    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog.className).toContain('w-full h-full')
    expect(dialog.className).toContain('sm:rounded-lg')
    expect(dialog.className).toContain('sm:max-w-lg')
    expect(dialog.className).not.toMatch(/(?<!sm:)rounded-lg/)
  })

  it('renders a dialog with role="dialog"/aria-modal, a label input and a REQUIRED callsign suffix input', async () => {
    await mount()

    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(container.querySelector('[aria-modal="true"]')).not.toBeNull()
    expect(labelInput()).not.toBeNull()
    expect(suffixInput()).not.toBeNull()
    expect(suffixInput().hasAttribute('required')).toBe(true)
    // Bug #6: no longer says "Optional" anywhere near the field.
    expect(container.textContent).not.toContain('Optional')
    expect(container.textContent).toContain('Required')
  })

  it('submits label and callsignSuffix trimmed, and calls onCreated then onClose on success', async () => {
    devicesAPI.create.mockResolvedValue({ data: { device: { deviceUserId: 10, username: 'AUK-D1', callsignSuffix: 'Tanker1' } } })
    const onCreated = vi.fn()
    const onClose = vi.fn()
    await mount({ onCreated, onClose })

    await setInputValue(labelInput(), '  Engine 4 Tablet  ')
    await setInputValue(suffixInput(), '  Tanker1  ')

    await submitForm()

    expect(devicesAPI.create).toHaveBeenCalledWith(5, 'Engine 4 Tablet', 'Tanker1')
    expect(toast.success).toHaveBeenCalledWith('Team device created')
    expect(onCreated).toHaveBeenCalledWith({ deviceUserId: 10, username: 'AUK-D1', callsignSuffix: 'Tanker1' })
    expect(onClose).toHaveBeenCalled()
  })

  it('rejects submit inline when the callsign suffix is left blank, without calling the API (bug #6: required, not optional)', async () => {
    await mount()

    await submitForm()

    expect(devicesAPI.create).not.toHaveBeenCalled()
    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert.textContent).toMatch(/required/i)
  })

  it('submits null for label when left blank, alongside a non-empty required suffix', async () => {
    devicesAPI.create.mockResolvedValue({ data: { device: { deviceUserId: 11, username: 'AUK-D2', callsignSuffix: 'Tanker1' } } })
    await mount()

    await setInputValue(suffixInput(), 'Tanker1')
    await submitForm()

    expect(devicesAPI.create).toHaveBeenCalledWith(5, null, 'Tanker1')
  })

  it('surfaces a 400 collision response inline against the Callsign Suffix field, not as a toast, and keeps the dialog open', async () => {
    devicesAPI.create.mockRejectedValue({
      response: { status: 400, data: { error: 'Callsign Suffix "Tanker1" is already in use within this Team' } }
    })
    const onClose = vi.fn()
    await mount({ onClose })

    await setInputValue(suffixInput(), 'Tanker1')
    await submitForm()

    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert.textContent).toContain('Tanker1')
    expect(toast.error).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(suffixInput().getAttribute('aria-invalid')).toBe('true')
  })

  it('falls back to a generic toast for a non-400 failure, and keeps the dialog open', async () => {
    devicesAPI.create.mockRejectedValue({ response: { status: 500, data: { error: 'unexpected' } } })
    const onClose = vi.fn()
    await mount({ onClose })

    await setInputValue(suffixInput(), 'Tanker1')
    await submitForm()

    expect(toast.error).toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('rejects a callsign suffix with a disallowed character inline, before calling the API at all', async () => {
    await mount()

    await setInputValue(suffixInput(), 'Tanker 1')
    await submitForm()

    expect(devicesAPI.create).not.toHaveBeenCalled()
    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert.textContent).toMatch(/letters, digits/)
  })

  it('clears the inline suffix error as soon as the field is edited again', async () => {
    devicesAPI.create.mockRejectedValue({
      response: { status: 400, data: { error: 'Callsign Suffix "Tanker1" is already in use within this Team' } }
    })
    await mount()

    await setInputValue(suffixInput(), 'Tanker1')
    await submitForm()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()

    await setInputValue(suffixInput(), 'Tanker2')

    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('calls onClose when the Cancel button is clicked, without calling the API', async () => {
    const onClose = vi.fn()
    await mount({ onClose })

    const cancelButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')
    await act(async () => {
      cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalled()
    expect(devicesAPI.create).not.toHaveBeenCalled()
  })

  // Bug #6: live full-callsign preview, computed from team/allTeams via
  // the same three-segment assembly rule the server uses.
  describe('live full-callsign preview', () => {
    const ORG = { id: 1, parent_team_id: null, callsign_prefix: 'FENZ', callsign_level_selection: [1] }
    const SUB_TEAM = { id: 2, parent_team_id: 1, callsign_prefix: 'STL' }
    const ALL_TEAMS = [ORG, SUB_TEAM]

    it('shows no preview line until a suffix is entered', async () => {
      await mount({ team: SUB_TEAM, allTeams: ALL_TEAMS })

      expect(container.textContent).not.toContain('Full callsign:')
    })

    it('shows the assembled Organisation-Team-Name callsign live as the suffix is typed', async () => {
      await mount({ team: SUB_TEAM, allTeams: ALL_TEAMS })

      await setInputValue(suffixInput(), 'Tanker1')

      expect(container.textContent).toContain('Full callsign:')
      expect(container.textContent).toContain('FENZ-STL-Tanker1')
    })

    it('omits the Team segment for a device created directly under the Organisation', async () => {
      await mount({ team: ORG, allTeams: ALL_TEAMS })

      await setInputValue(suffixInput(), 'Tanker1')

      expect(container.textContent).toContain('FENZ-Tanker1')
    })
  })

  // Bug #6: live collision check on blur, via the SAME preview route the
  // Create New User tab uses.
  describe('live collision check on blur', () => {
    it('calls usersAPI.previewCallsignSuffix with no firstName/lastName (the device-shaped preview) on blur', async () => {
      await mount({ teamId: 7 })

      await setInputValue(suffixInput(), 'Tanker1')
      await act(async () => {
        suffixInput().focus()
      })
      await act(async () => {
        suffixInput().blur()
      })

      expect(usersAPI.previewCallsignSuffix).toHaveBeenCalledWith({ teamId: 7, callsignSuffix: 'Tanker1' })
    })

    it('surfaces a conflict reported by the preview inline, before submit', async () => {
      usersAPI.previewCallsignSuffix.mockResolvedValue({
        data: { suffix: 'Tanker1', required: false, conflict: { value: 'Tanker1', message: 'Callsign Suffix "Tanker1" is already in use within this Team' } }
      })
      await mount()

      await setInputValue(suffixInput(), 'Tanker1')
      await act(async () => {
        suffixInput().focus()
      })
      await act(async () => {
        suffixInput().blur()
      })

      const alert = container.querySelector('[role="alert"]')
      expect(alert).not.toBeNull()
      expect(alert.textContent).toContain('Tanker1')
      expect(devicesAPI.create).not.toHaveBeenCalled()
    })

    it('does not call the preview route for an empty suffix', async () => {
      await mount()

      await act(async () => {
        suffixInput().focus()
      })
      await act(async () => {
        suffixInput().blur()
      })

      expect(usersAPI.previewCallsignSuffix).not.toHaveBeenCalled()
    })
  })
})
