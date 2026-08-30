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
