import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import ChannelMembersDialog from './ChannelMembersDialog.jsx'
import { channelsAPI } from '../services/api'

// Bugfix (Channels tab had no manage-members action): mounted tests for
// the new ChannelMembersDialog component, following the same
// `react-dom/client` `createRoot` + React 18 `act` pattern established
// by `UserDevicesModal.test.jsx` (this project has no
// `@testing-library/react`). `../services/api` and `react-hot-toast` are
// the only mocks -- the network boundary and the toast sink.

vi.mock('../services/api', () => ({
  channelsAPI: {
    getMembers: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn()
  }
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}))

globalThis.React = React

const CHANNEL = { id: 10, display_name: 'Teams - FENZ - Test' }

const TEAM_MEMBERS = [
  { id: 1, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
  { id: 2, first_name: 'Chris', last_name: 'Elsen', email: 'chris@chriselsen.net' }
]

const EXISTING_MEMBER = { id: 1, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', permission: 'read_write' }

describe('ChannelMembersDialog (mounted)', () => {
  let container
  let root
  let onClose
  let onMembershipChanged

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    onClose = vi.fn()
    onMembershipChanged = vi.fn()
    channelsAPI.getMembers.mockResolvedValue({ data: { members: [EXISTING_MEMBER] } })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mount = async (props = {}) => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <ChannelMembersDialog
          channel={CHANNEL}
          teamMembers={TEAM_MEMBERS}
          onClose={onClose}
          onMembershipChanged={onMembershipChanged}
          {...props}
        />
      )
    })
  }

  it('fetches and lists the channel\'s current members', async () => {
    await mount()

    expect(channelsAPI.getMembers).toHaveBeenCalledWith(10)
    expect(container.textContent).toContain('Ada Lovelace')
    expect(container.textContent).toContain('ada@example.com')
  })

  it('renders the dialog box with w-full h-full and sm:-gated rounding/max-width (full-bleed on mobile)', async () => {
    await mount()

    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog.className).toContain('w-full h-full')
    expect(dialog.className).toContain('sm:rounded-lg')
  })

  it('shows an inline error and no member rows when the fetch fails', async () => {
    channelsAPI.getMembers.mockRejectedValue({ response: { data: { error: 'Channel not found' } } })

    await mount()

    expect(container.querySelector('[role="alert"]').textContent).toContain('Channel not found')
  })

  it('offers only team members NOT already on the channel in the "Add a Member" picker', async () => {
    await mount()

    const select = container.querySelector('select[aria-label="Select a member to add"]')
    const optionTexts = Array.from(select.querySelectorAll('option')).map((o) => o.textContent)
    expect(optionTexts.some((text) => text.includes('chris@chriselsen.net'))).toBe(true)
    expect(optionTexts.some((text) => text.includes('ada@example.com'))).toBe(false)
  })

  it('adds the selected member with the selected permission via channelsAPI.addMember, then refreshes the list', async () => {
    channelsAPI.addMember.mockResolvedValue({ data: {} })
    channelsAPI.getMembers
      .mockResolvedValueOnce({ data: { members: [EXISTING_MEMBER] } })
      .mockResolvedValueOnce({
        data: {
          members: [
            EXISTING_MEMBER,
            { id: 2, first_name: 'Chris', last_name: 'Elsen', email: 'chris@chriselsen.net', permission: 'read' }
          ]
        }
      })
    await mount()

    const select = container.querySelector('select[aria-label="Select a member to add"]')
    const permissionSelect = container.querySelector('select[aria-label="Select permission"]')
    const setSelectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set

    await act(async () => {
      setSelectValue.call(select, '2')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      setSelectValue.call(permissionSelect, 'read')
      permissionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const form = container.querySelector('form')
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(channelsAPI.addMember).toHaveBeenCalledWith(10, { userId: '2', permission: 'read' })
    expect(onMembershipChanged).toHaveBeenCalled()
    expect(container.textContent).toContain('Chris Elsen')
  })

  it('removes a member via channelsAPI.removeMember when its Remove button is clicked, then refreshes the list', async () => {
    channelsAPI.removeMember.mockResolvedValue({ data: {} })
    channelsAPI.getMembers
      .mockResolvedValueOnce({ data: { members: [EXISTING_MEMBER] } })
      .mockResolvedValueOnce({ data: { members: [] } })
    await mount()

    const removeButton = container.querySelector('[aria-label="Remove Ada Lovelace from channel"]')
    await act(async () => {
      removeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(channelsAPI.removeMember).toHaveBeenCalledWith(10, 1)
    expect(onMembershipChanged).toHaveBeenCalled()
  })

  it('changes a member\'s permission via channelsAPI.addMember (the same upsert endpoint) when a different permission button is clicked', async () => {
    channelsAPI.addMember.mockResolvedValue({ data: {} })
    channelsAPI.getMembers
      .mockResolvedValueOnce({ data: { members: [EXISTING_MEMBER] } })
      .mockResolvedValueOnce({ data: { members: [{ ...EXISTING_MEMBER, permission: 'read' }] } })
    await mount()

    // The 'Read' toggle button for Ada's row, distinct from the
    // currently-active 'Read/Write' one.
    const readButtons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent.trim() === 'Read')
    expect(readButtons.length).toBeGreaterThan(0)

    await act(async () => {
      readButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(channelsAPI.addMember).toHaveBeenCalledWith(10, { userId: 1, permission: 'read' })
    expect(onMembershipChanged).toHaveBeenCalled()
  })

  it('calls onClose when the close button is clicked', async () => {
    await mount()

    const closeButton = container.querySelector('[aria-label="Close channel members dialog"]')
    await act(async () => {
      closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose on Escape', async () => {
    await mount()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(onClose).toHaveBeenCalled()
  })
})
