import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import MemberActions from './MemberActions.jsx'

// Bugfix (mobile tap targets too small): the Edit/Resend/Transfer/View
// Devices/Delete action icons on TeamDetail.jsx's mobile cards were bare
// `h-4 w-4` icons in a `space-x-3` row -- a ~16px hit target. `variant`
// ('table', the default | 'card') swaps that for a `p-2 rounded-lg`
// button box per icon (a real ~36px target, matching the header
// toolbar's own icon-only buttons), grey for every neutral action and a
// red-tinted box (not just red text) for the destructive one so the
// "this one's different" signal survives once every action is an
// identically-shaped box.
//
// This project has no `@testing-library/react`, so the component is
// mounted with `react-dom/client`'s `createRoot` plus React 18's own
// `act`, following the pattern established elsewhere in this project
// (e.g. `TransferMemberDialog.test.jsx`).
globalThis.React = React

const MEMBER = { id: 42, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' }

describe('MemberActions (mounted)', () => {
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

  const noop = () => {}

  const mount = async (props = {}) => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemberActions
          member={MEMBER}
          roleLabel="member"
          devicesEnabled={true}
          onEdit={noop}
          onResendWelcome={noop}
          onTransfer={noop}
          onViewDevices={noop}
          onRemove={noop}
          {...props}
        />
      )
    })
  }

  const buttonByLabel = (label) => container.querySelector(`[aria-label="${label}"]`)

  describe('default (variant="table")', () => {
    it('renders bare h-4 w-4 icons with no button-box classes', async () => {
      await mount()

      const edit = buttonByLabel('Edit member')
      expect(edit.className).not.toContain('p-2')
      expect(edit.className).not.toContain('rounded-lg')
      expect(edit.querySelector('svg').getAttribute('class')).toContain('h-4 w-4')
    })

    it('renders the destructive action as plain red text, no box background', async () => {
      await mount()

      const remove = buttonByLabel('Delete user (permanently removes their account)')
      expect(remove.className).toContain('text-red-600')
      expect(remove.className).not.toContain('bg-red-50')
      expect(remove.className).not.toContain('p-2')
    })
  })

  describe('variant="card"', () => {
    it('wraps every neutral action in a p-2 rounded-lg grey button box with h-5 w-5 icons', async () => {
      await mount({ variant: 'card' })

      for (const label of ['Edit member', 'Resend welcome email', 'Transfer member to another team', 'View member devices']) {
        const button = buttonByLabel(label)
        expect(button, `missing button for "${label}"`).toBeTruthy()
        expect(button.className).toContain('p-2')
        expect(button.className).toContain('rounded-lg')
        expect(button.className).toContain('bg-gray-100')
        expect(button.querySelector('svg').getAttribute('class')).toContain('h-5 w-5')
      }
    })

    it('gives the destructive action a red-tinted BOX (not just red text), same box shape as the neutral actions', async () => {
      await mount({ variant: 'card' })

      const remove = buttonByLabel('Delete user (permanently removes their account)')
      expect(remove.className).toContain('p-2')
      expect(remove.className).toContain('rounded-lg')
      expect(remove.className).toContain('bg-red-50')
      expect(remove.className).toContain('text-red-600')
      expect(remove.querySelector('svg').getAttribute('class')).toContain('h-5 w-5')
    })

    it('still disables Edit/Transfer/Delete (as a distinct box style) when hasTeam is false, at the larger card size', async () => {
      await mount({ variant: 'card', hasTeam: false })

      const edit = buttonByLabel('This user has no team assignment')
      expect(edit).toBeTruthy()
      expect(edit.disabled).toBe(true)
      expect(edit.className).toContain('p-2')
      expect(edit.className).toContain('rounded-lg')
      expect(edit.className).not.toContain('bg-gray-100 hover:bg-gray-200')
    })

    it('still fires the same callbacks as the table variant when a card-styled action is clicked', async () => {
      const onEdit = vi.fn()
      await mount({ variant: 'card', onEdit })

      await act(async () => {
        buttonByLabel('Edit member').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(onEdit).toHaveBeenCalledWith(MEMBER)
    })
  })
})

// account-lifecycle-management Requirement 1.11: the Suspend/Unsuspend
// action icon. Omitted entirely (no `onSuspend` prop passed) is the
// existing default in every test above, confirming a caller that doesn't
// wire this up (or a row with no valid suspend/unsuspend action, e.g. an
// orphaned account) renders nothing extra.
describe('MemberActions (mounted) -- Suspend/Unsuspend action', () => {
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

  const noop = () => {}

  const mount = async (props = {}) => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemberActions
          member={MEMBER}
          roleLabel="member"
          devicesEnabled={true}
          onEdit={noop}
          onResendWelcome={noop}
          onTransfer={noop}
          onViewDevices={noop}
          onRemove={noop}
          {...props}
        />
      )
    })
  }

  const buttonByLabel = (label) => container.querySelector(`[aria-label="${label}"]`)

  it('renders nothing when onSuspend is not passed (the pre-existing default for every other test in this file)', async () => {
    await mount()

    expect(buttonByLabel('Suspend account')).toBeFalsy()
    expect(buttonByLabel('Unsuspend account')).toBeFalsy()
  })

  it('renders a "Suspend account" closed-lock button when accountStatus is "active" (the default)', async () => {
    const onSuspend = vi.fn()
    await mount({ onSuspend })

    const button = buttonByLabel('Suspend account')
    expect(button).toBeTruthy()
    expect(buttonByLabel('Unsuspend account')).toBeFalsy()

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSuspend).toHaveBeenCalledWith(MEMBER)
  })

  it('renders an "Unsuspend account" open-lock button when accountStatus is "suspended"', async () => {
    const onSuspend = vi.fn()
    await mount({ onSuspend, accountStatus: 'suspended' })

    const button = buttonByLabel('Unsuspend account')
    expect(button).toBeTruthy()
    expect(buttonByLabel('Suspend account')).toBeFalsy()

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSuspend).toHaveBeenCalledWith(MEMBER)
  })

  it('is disabled, with the no-team title, when hasTeam is false', async () => {
    const onSuspend = vi.fn()
    await mount({ onSuspend, hasTeam: false })

    const button = buttonByLabel('This user has no team assignment')
    // Two buttons now share that exact fallback label (Edit and Suspend),
    // so scope to the disabled ones specifically rather than assuming
    // there's only one match.
    const candidates = [...container.querySelectorAll('[aria-label="This user has no team assignment"]')]
    expect(candidates.length).toBeGreaterThanOrEqual(2)
    expect(candidates.every((el) => el.disabled)).toBe(true)
    expect(button).toBeTruthy()
  })

  // Bugfix: Suspend now gets the SAME red/danger button-box treatment as
  // Delete, not the neutral grey every other action uses -- locking the
  // account and revoking every live certificate is disruptive enough to
  // carry the same "this one's different" colour signal.
  it('applies the card variant\u2019s RED/danger button-box treatment to Suspend, matching Delete rather than the neutral actions', async () => {
    const onSuspend = vi.fn()
    await mount({ onSuspend, variant: 'card' })

    const button = buttonByLabel('Suspend account')
    expect(button.className).toContain('p-2')
    expect(button.className).toContain('rounded-lg')
    expect(button.className).toContain('bg-red-50')
    expect(button.className).not.toContain('bg-gray-100')
    expect(button.querySelector('svg').getAttribute('class')).toContain('h-5 w-5')
  })

  // Unsuspend is the reverse direction -- it UNDOES the disruption rather
  // than causing it, matching SuspendAccountDialog's own btn-primary (not
  // btn-danger) choice for that mode -- so it keeps the neutral grey
  // treatment every other non-destructive action uses.
  it('keeps the NEUTRAL/grey button-box treatment for Unsuspend, unlike Suspend', async () => {
    const onSuspend = vi.fn()
    await mount({ onSuspend, accountStatus: 'suspended', variant: 'card' })

    const button = buttonByLabel('Unsuspend account')
    expect(button.className).toContain('bg-gray-100')
    expect(button.className).not.toContain('bg-red-50')
  })

  // Table variant (bare text colour, no box) must carry the same red/grey
  // split as the card variant's box colours.
  it('applies red TEXT to Suspend in the default table variant', async () => {
    const onSuspend = vi.fn()
    await mount({ onSuspend })
    expect(buttonByLabel('Suspend account').className).toContain('text-red-600')
  })

  it('applies grey TEXT (not red) to Unsuspend in the default table variant', async () => {
    const onSuspend = vi.fn()
    await mount({ onSuspend, accountStatus: 'suspended' })
    expect(buttonByLabel('Unsuspend account').className).toContain('text-gray-600')
    expect(buttonByLabel('Unsuspend account').className).not.toContain('text-red-600')
  })
})
