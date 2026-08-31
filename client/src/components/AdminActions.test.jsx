import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import AdminActions from './AdminActions.jsx'

// Bugfix (Team Admins tab action-set mismatch): AdminActions replaces
// MemberActions on the Team Admins tab with a single "Remove as admin"
// action -- mirrors MemberActions' variant/table/card styling
// convention exactly (see MemberActions.test.jsx), but this component
// has exactly one action, always red-tinted (never grey), since it is
// the tab's one meaningful, authority-changing action.
//
// This project has no `@testing-library/react`, so the component is
// mounted with `react-dom/client`'s `createRoot` plus React 18's own
// `act`, following the pattern established elsewhere in this project.
globalThis.React = React

const ADMIN = { id: 42, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' }

describe('AdminActions (mounted)', () => {
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
        <AdminActions
          member={ADMIN}
          onRemoveAdmin={noop}
          {...props}
        />
      )
    })
  }

  const buttonByLabel = (label) => container.querySelector(`[aria-label="${label}"]`)

  const REMOVE_LABEL = 'Remove as admin (keeps their team membership)'

  describe('default (variant="table")', () => {
    it('renders a single bare h-4 w-4 red-tinted action, no button-box classes', async () => {
      await mount()

      const remove = buttonByLabel(REMOVE_LABEL)
      expect(remove).toBeTruthy()
      expect(remove.className).toContain('text-red-600')
      expect(remove.className).not.toContain('p-2')
      expect(remove.className).not.toContain('rounded-lg')
      expect(remove.querySelector('svg').getAttribute('class')).toContain('h-4 w-4')
    })

    it('calls onRemoveAdmin with the member row when clicked', async () => {
      const onRemoveAdmin = vi.fn()
      await mount({ onRemoveAdmin })

      await act(async () => {
        buttonByLabel(REMOVE_LABEL).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(onRemoveAdmin).toHaveBeenCalledWith(ADMIN)
    })
  })

  describe('variant="card"', () => {
    it('wraps the action in a p-2 rounded-lg red-tinted button box with an h-5 w-5 icon', async () => {
      await mount({ variant: 'card' })

      const remove = buttonByLabel(REMOVE_LABEL)
      expect(remove.className).toContain('p-2')
      expect(remove.className).toContain('rounded-lg')
      expect(remove.className).toContain('bg-red-50')
      expect(remove.className).toContain('text-red-600')
      expect(remove.querySelector('svg').getAttribute('class')).toContain('h-5 w-5')
    })

    it('still fires onRemoveAdmin when the card-styled action is clicked', async () => {
      const onRemoveAdmin = vi.fn()
      await mount({ variant: 'card', onRemoveAdmin })

      await act(async () => {
        buttonByLabel(REMOVE_LABEL).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(onRemoveAdmin).toHaveBeenCalledWith(ADMIN)
    })
  })

  describe('hasTeam=false', () => {
    it('disables the action and shows the disabled reason instead', async () => {
      await mount({ hasTeam: false })

      const disabled = buttonByLabel('This user has no team assignment')
      expect(disabled).toBeTruthy()
      expect(disabled.disabled).toBe(true)
      expect(buttonByLabel(REMOVE_LABEL)).toBeFalsy()
    })

    it('never calls onRemoveAdmin when clicked while disabled', async () => {
      const onRemoveAdmin = vi.fn()
      await mount({ hasTeam: false, onRemoveAdmin })

      await act(async () => {
        buttonByLabel('This user has no team assignment').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(onRemoveAdmin).not.toHaveBeenCalled()
    })

    it('supports a custom disabledReason', async () => {
      await mount({ hasTeam: false, disabledReason: 'Not administered by you' })

      expect(buttonByLabel('Not administered by you')).toBeTruthy()
    })
  })
})
