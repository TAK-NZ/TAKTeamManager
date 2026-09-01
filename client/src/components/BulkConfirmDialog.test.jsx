import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import BulkConfirmDialog from './BulkConfirmDialog.jsx'

// Orgs & Teams multi-select: the shared bulk-action confirmation dialog,
// mounted with `react-dom/client`'s `createRoot` + React 18's `act`,
// mirroring `SuspendAccountDialog.test.jsx`'s own convention (no
// `@testing-library/react` in this project).
globalThis.React = React

const ROWS = [
  { id: 10, label: 'Alice Smith' },
  { id: 11, label: 'Bob Jones' }
]

describe('BulkConfirmDialog (mounted)', () => {
  let container
  let root
  let onClose
  let onConfirm
  let onCompleted

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    onClose = vi.fn()
    onConfirm = vi.fn().mockResolvedValue({
      successCount: 2,
      failureCount: 0,
      results: [
        { userId: 10, success: true },
        { userId: 11, success: true }
      ]
    })
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
        <BulkConfirmDialog
          title="Suspend Accounts"
          rows={ROWS}
          onClose={onClose}
          onConfirm={onConfirm}
          renderRowResult={(result) => (result.success ? 'Account suspended' : result.error)}
          resultRowId={(result) => result.userId}
          onCompleted={onCompleted}
          {...props}
        />
      )
    })
  }

  const findButtonByText = (text) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text)
  const confirmInput = () => container.querySelector('#bulk-confirm-input')

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

  it('lists every selected row by its label', async () => {
    await mount()
    expect(container.textContent).toContain('Alice Smith')
    expect(container.textContent).toContain('Bob Jones')
    expect(container.textContent).toContain('2 selected')
  })

  describe('plain tier (no literalWord)', () => {
    it('renders no type-to-confirm input and leaves Confirm enabled', async () => {
      await mount()
      expect(confirmInput()).toBeNull()
      expect(findButtonByText('Suspend Accounts').disabled).toBe(false)
    })

    it('calls onConfirm with every row id, and onCompleted once results report a success', async () => {
      await mount()
      await click(findButtonByText('Suspend Accounts'))

      expect(onConfirm).toHaveBeenCalledWith([10, 11])
      expect(onCompleted).toHaveBeenCalledTimes(1)
    })
  })

  describe('type-to-confirm tier (literalWord supplied)', () => {
    it('disables Confirm until the exact literal word is typed', async () => {
      await mount({ literalWord: 'SUSPEND', tone: 'danger' })
      const confirmButton = findButtonByText('Suspend Accounts')
      expect(confirmButton.disabled).toBe(true)

      for (const nearMiss of ['s', 'suspend', 'SUSPEND ', ' SUSPEND']) {
        await type(nearMiss)
        expect(confirmButton.disabled).toBe(true)
      }

      await type('SUSPEND')
      expect(confirmButton.disabled).toBe(false)
    })

    it('never calls onConfirm while the literal word does not match exactly', async () => {
      await mount({ literalWord: 'SUSPEND', tone: 'danger' })
      await type('not-suspend')
      await click(findButtonByText('Suspend Accounts'))

      expect(onConfirm).not.toHaveBeenCalled()
    })

    it('calls onConfirm once the literal word matches exactly', async () => {
      await mount({ literalWord: 'SUSPEND', tone: 'danger' })
      await type('SUSPEND')
      await click(findButtonByText('Suspend Accounts'))

      expect(onConfirm).toHaveBeenCalledWith([10, 11])
    })
  })

  it('renders a per-row results table after onConfirm resolves, and does not call onClose automatically', async () => {
    await mount()
    await click(findButtonByText('Suspend Accounts'))

    expect(container.textContent).toContain('2 succeeded, 0 failed')
    expect(container.textContent).toContain('Alice Smith')
    expect(container.textContent).toContain('Account suspended')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows a per-row failure message via renderRowResult, without blocking the other row\'s success', async () => {
    onConfirm.mockResolvedValue({
      successCount: 1,
      failureCount: 1,
      results: [
        { userId: 10, success: false, error: 'Account already suspended' },
        { userId: 11, success: true }
      ]
    })

    await mount()
    await click(findButtonByText('Suspend Accounts'))

    expect(container.textContent).toContain('1 succeeded, 1 failed')
    expect(container.textContent).toContain('Account already suspended')
  })

  it('does not call onCompleted when every row fails', async () => {
    onConfirm.mockResolvedValue({
      successCount: 0,
      failureCount: 2,
      results: [
        { userId: 10, success: false, error: 'nope' },
        { userId: 11, success: false, error: 'nope' }
      ]
    })

    await mount()
    await click(findButtonByText('Suspend Accounts'))

    expect(onCompleted).not.toHaveBeenCalled()
  })

  it('shows a server-error message inline and keeps the dialog open when onConfirm itself rejects', async () => {
    onConfirm.mockRejectedValue({ response: { data: { error: 'network unreachable' } } })

    await mount()
    await click(findButtonByText('Suspend Accounts'))

    expect(container.querySelector('[role="alert"]').textContent).toBe('network unreachable')
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('closes via Cancel without ever calling onConfirm', async () => {
    await mount()
    await click(findButtonByText('Cancel'))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('renders the danger tone as btn-danger and the default tone as btn-primary', async () => {
    await mount({ literalWord: 'DELETE', tone: 'danger' })
    expect(findButtonByText('Suspend Accounts').className).toContain('btn-danger')

    await act(async () => {
      root.unmount()
    })
    root = createRoot(container)
    await act(async () => {
      root.render(
        <BulkConfirmDialog
          title="Resend Welcome Email"
          rows={ROWS}
          onClose={onClose}
          onConfirm={onConfirm}
          renderRowResult={() => 'ok'}
          resultRowId={(result) => result.userId}
        />
      )
    })
    expect(findButtonByText('Resend Welcome Email').className).toContain('btn-primary')
  })
})
