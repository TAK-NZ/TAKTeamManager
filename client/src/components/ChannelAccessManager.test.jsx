import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import ChannelAccessManager from './ChannelAccessManager.jsx'
import { teamsAPI } from '../services/api'

// region-channel-tiers: mounted component tests for ChannelAccessManager.
//
// This project has no `@testing-library/react`, so the component is
// mounted with `react-dom/client`'s `createRoot` plus React 18's own
// `act`, following the pattern established by
// `src/components/RevokeDeviceDialog.test.jsx`.
//
// `../services/api` and `react-hot-toast` are the only mocks: the network
// boundary and the toast sink. Everything else is the real component.

vi.mock('../services/api', () => ({
  teamsAPI: {
    updateChannelAccess: vi.fn()
  }
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}))

globalThis.React = React

describe('ChannelAccessManager (mounted)', () => {
  let container
  let root
  let onSaved

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    onSaved = vi.fn()
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
        <ChannelAccessManager
          org={{ id: 42, response_channel_access: false, support_channel_access: true }}
          isGlobalManager={true}
          onSaved={onSaved}
          {...props}
        />
      )
    })
  }

  const responseCheckbox = () => container.querySelector('#responseChannelAccess')
  const supportCheckbox = () => container.querySelector('#supportChannelAccess')
  const saveButton = () => container.querySelector('button')

  const click = async (el) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  }

  it('returns null (renders nothing) when isGlobalManager is false', async () => {
    await mount({ isGlobalManager: false })
    expect(container.innerHTML).toBe('')
  })

  it('seeds the two checkboxes from the org prop', async () => {
    await mount()
    expect(responseCheckbox().checked).toBe(false)
    expect(supportCheckbox().checked).toBe(true)
  })

  it('defaults both checkboxes to false when the org prop carries null/undefined flags', async () => {
    await mount({ org: { id: 7, response_channel_access: null, support_channel_access: undefined } })
    expect(responseCheckbox().checked).toBe(false)
    expect(supportCheckbox().checked).toBe(false)
  })

  it('shows no Save Changes button while the checkboxes match the saved baseline', async () => {
    await mount()
    expect(saveButton()).toBeNull()
  })

  it('shows a Save Changes button once a checkbox is toggled away from the saved baseline', async () => {
    await mount()
    await click(responseCheckbox())
    const button = saveButton()
    expect(button).not.toBeNull()
    expect(button.textContent).toContain('Save Changes')
  })

  it('hides the Save Changes button again when a toggle is reverted back to the saved baseline', async () => {
    await mount()
    await click(responseCheckbox())
    expect(saveButton()).not.toBeNull()
    await click(responseCheckbox())
    expect(saveButton()).toBeNull()
  })

  it('calls teamsAPI.updateChannelAccess with both flags (camelCase) on save', async () => {
    teamsAPI.updateChannelAccess.mockResolvedValue({
      data: { team: { id: 42, response_channel_access: true, support_channel_access: true } }
    })
    await mount()
    await click(responseCheckbox())
    await click(saveButton())

    expect(teamsAPI.updateChannelAccess).toHaveBeenCalledWith(42, {
      responseChannelAccess: true,
      supportChannelAccess: true
    })
  })

  it('calls onSaved with the updated team returned from the API', async () => {
    const updatedTeam = { id: 42, response_channel_access: true, support_channel_access: true }
    teamsAPI.updateChannelAccess.mockResolvedValue({ data: { team: updatedTeam } })
    await mount()
    await click(responseCheckbox())
    await click(saveButton())

    expect(onSaved).toHaveBeenCalledWith(updatedTeam)
  })

  it('hides the Save Changes button again immediately after a successful save, even though the org prop itself has not changed', async () => {
    // Deliberately do NOT re-render with an updated org prop -- this is
    // the exact scenario ChannelAccessManager's own savedBaseline state
    // exists to handle: the parent's onSaved may not refresh the org
    // prop synchronously, so the dirty check must not depend on it.
    teamsAPI.updateChannelAccess.mockResolvedValue({
      data: { team: { id: 42, response_channel_access: true, support_channel_access: true } }
    })
    await mount()
    await click(responseCheckbox())
    expect(saveButton()).not.toBeNull()

    await click(saveButton())

    expect(saveButton()).toBeNull()
  })

  it('shows an error toast and keeps the Save Changes button visible when the save fails', async () => {
    const toast = (await import('react-hot-toast')).default
    teamsAPI.updateChannelAccess.mockRejectedValue({
      response: { data: { error: 'Response/Support channel access can only be set on an Organisation, not a Sub_Team' } }
    })
    await mount()
    await click(responseCheckbox())
    await click(saveButton())

    expect(toast.error).toHaveBeenCalledWith(
      'Response/Support channel access can only be set on an Organisation, not a Sub_Team'
    )
    // Save did not succeed, so the button must still be present (still dirty).
    expect(saveButton()).not.toBeNull()
    expect(onSaved).not.toHaveBeenCalled()
  })

  // Bugfix (mobile tap target too small): the outer element of each row
  // is now the <label> itself, so a click anywhere in the row -- not
  // just the bare 16px checkbox -- toggles the field.
  it('wraps each checkbox in a clickable <label> with an enlarged (-m-2 p-2) hit box, and toggling via the label works', async () => {
    await mount()

    const responseLabel = responseCheckbox().closest('label')
    expect(responseLabel).not.toBeNull()
    expect(responseLabel.getAttribute('for')).toBe('responseChannelAccess')
    expect(responseLabel.className).toContain('-m-2')
    expect(responseLabel.className).toContain('p-2')
    expect(responseLabel.className).toContain('cursor-pointer')

    const supportLabel = supportCheckbox().closest('label')
    expect(supportLabel.getAttribute('for')).toBe('supportChannelAccess')

    // Clicking the LABEL (not the input) toggles the checkbox, exactly
    // like clicking the input itself would.
    expect(responseCheckbox().checked).toBe(false)
    await click(responseLabel)
    expect(responseCheckbox().checked).toBe(true)
  })

  it('re-seeds from a new org prop (and clears any dirty state) when the Organisation being edited changes', async () => {
    await mount({ org: { id: 1, response_channel_access: false, support_channel_access: false } })
    await click(responseCheckbox())
    expect(saveButton()).not.toBeNull()

    // Switching to a DIFFERENT Organisation entirely (different id) while
    // the dialog stays mounted -- e.g. re-opening for another team without
    // this component being unmounted first.
    await act(async () => {
      root.render(
        <ChannelAccessManager
          org={{ id: 2, response_channel_access: true, support_channel_access: false }}
          isGlobalManager={true}
          onSaved={onSaved}
        />
      )
    })

    expect(responseCheckbox().checked).toBe(true)
    expect(supportCheckbox().checked).toBe(false)
    expect(saveButton()).toBeNull()
  })
})
