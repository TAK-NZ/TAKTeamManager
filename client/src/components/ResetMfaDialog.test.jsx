import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import ResetMfaDialog from './ResetMfaDialog.jsx'
import { usersAPI } from '../services/api'
vi.mock('../services/api', () => ({ usersAPI: { resetMfa: vi.fn() } }))
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))
globalThis.React = React
describe('ResetMfaDialog (mounted)', () => {
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
    usersAPI.resetMfa.mockResolvedValue({ data: {} })
  })
  afterEach(async () => {
    if (root) {
      await act(async () => root.unmount())
      root = null
    }
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })
  const mount = async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<ResetMfaDialog targetUserId={42} targetName="Pat Lee" targetEmail="pat@example.com" onClose={onClose} onCompleted={onCompleted} />)
    })
  }
  const confirmButton = () => Array.from(container.querySelectorAll('button')).find((b) => /^(Reset MFA|Resetting\.\.\.)$/.test(b.textContent))
  const click = async (el) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
  it('names the person and the address the link goes to', async () => {
    await mount()
    expect(container.textContent).toContain('Pat Lee')
    expect(container.textContent).toContain('pat@example.com')
  })
  it('keeps the button disabled, and sends nothing, until the identity check is ticked', async () => {
    await mount()
    expect(confirmButton().disabled).toBe(true)
    await click(confirmButton())
    expect(usersAPI.resetMfa).not.toHaveBeenCalled()
  })
  it('sends the reset with the confirmation, then refreshes and closes', async () => {
    await mount()
    await click(container.querySelector('#reset-mfa-identity'))
    expect(confirmButton().disabled).toBe(false)
    await click(confirmButton())
    expect(usersAPI.resetMfa).toHaveBeenCalledWith(42, true)
    expect(onCompleted).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
  it('shows the server message and stays open when the reset is refused', async () => {
    usersAPI.resetMfa.mockRejectedValue({ response: { data: { error: 'Only a Global Manager can reset the MFA of an administrator' } } })
    await mount()
    await click(container.querySelector('#reset-mfa-identity'))
    await click(confirmButton())
    expect(container.querySelector('[role="alert"]').textContent).toMatch(/Global Manager/)
    expect(onClose).not.toHaveBeenCalled()
    expect(onCompleted).not.toHaveBeenCalled()
  })
})
