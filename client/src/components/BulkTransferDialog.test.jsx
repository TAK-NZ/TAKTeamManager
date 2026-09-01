import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import BulkTransferDialog from './BulkTransferDialog.jsx'
import { teamsAPI, usersAPI } from '../services/api'

// Orgs & Teams multi-select: the bulk counterpart of
// `TransferMemberDialog.test.jsx`'s own mount convention. Only
// `../services/api` is mocked -- the network boundary.

vi.mock('../services/api', () => ({
  teamsAPI: { getMyTeams: vi.fn() },
  usersAPI: { bulkTransfer: vi.fn() }
}))

globalThis.React = React

const ORG_TEAMS = [
  { id: 1, name: 'Organisation', callsign_prefix: 'ORG', parent_team_id: null },
  { id: 2, name: 'Alpha', callsign_prefix: 'ALF', parent_team_id: 1 },
  { id: 3, name: 'Bravo', callsign_prefix: 'BRV', parent_team_id: 1 }
]

const ADMIN_MEMBER = { id: 42, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', role: 'admin' }
const PLAIN_MEMBER = { id: 43, first_name: 'Bob', last_name: 'Brown', email: 'bob@example.com', role: 'member' }
const DISPLAYED_TEAM = { id: 2, name: 'Alpha', display_name: 'Organisation > Alpha' }

describe('BulkTransferDialog (mounted)', () => {
  let container
  let root
  let onClose
  let onCompleted

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    onClose = vi.fn()
    onCompleted = vi.fn()
    teamsAPI.getMyTeams.mockResolvedValue({ data: { teams: ORG_TEAMS } })
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
        <BulkTransferDialog
          members={[PLAIN_MEMBER]}
          team={DISPLAYED_TEAM}
          onClose={onClose}
          onCompleted={onCompleted}
          {...props}
        />
      )
    })
  }

  const text = () => container.textContent
  const select = () => container.querySelector('#bulk-transfer-target-team')
  const optionValues = () => Array.from(select().options).map((o) => o.value).filter(Boolean)

  const setSelectValue = async (value) => {
    const el = select()
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    await act(async () => {
      setter.call(el, value)
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  const submit = async () => {
    const form = container.querySelector('form')
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
  }

  it('lists every selected member and excludes the displayed team from the destination options', async () => {
    await mount({ members: [ADMIN_MEMBER, PLAIN_MEMBER] })

    expect(text()).toContain('Ada Lovelace')
    expect(text()).toContain('Bob Brown')
    expect(optionValues()).toEqual(expect.arrayContaining(['1', '3']))
    expect(optionValues()).not.toContain('2')
  })

  it('shows the admin-demotion warning naming the count, only when at least one selected member is an admin', async () => {
    await mount({ members: [ADMIN_MEMBER, PLAIN_MEMBER] })
    expect(text()).toMatch(/1 of the selected members? is a team admin/)
  })

  it('omits the admin-demotion warning when no selected member is an admin', async () => {
    await mount({ members: [PLAIN_MEMBER] })
    expect(text()).not.toMatch(/team admin/)
  })

  it('falls back to the all-teams call on an empty scoped list for a Global_Manager', async () => {
    teamsAPI.getMyTeams
      .mockResolvedValueOnce({ data: { teams: [] } })
      .mockResolvedValueOnce({ data: { teams: ORG_TEAMS } })

    await mount({ user: { isAdmin: true } })

    expect(teamsAPI.getMyTeams).toHaveBeenCalledTimes(2)
    expect(optionValues()).toEqual(expect.arrayContaining(['1', '3']))
  })

  it('calls bulkTransfer with every selected member id and the chosen destination team', async () => {
    usersAPI.bulkTransfer.mockResolvedValue({
      data: {
        successCount: 2,
        failureCount: 0,
        results: [
          { userId: ADMIN_MEMBER.id, success: true, status: 'completed', destinationTeamPath: 'ORG > Bravo' },
          { userId: PLAIN_MEMBER.id, success: true, status: 'completed', destinationTeamPath: 'ORG > Bravo' }
        ]
      }
    })

    await mount({ members: [ADMIN_MEMBER, PLAIN_MEMBER] })
    await setSelectValue('3')
    await submit()

    expect(usersAPI.bulkTransfer).toHaveBeenCalledWith([ADMIN_MEMBER.id, PLAIN_MEMBER.id], { targetTeamId: 3 })
    expect(onCompleted).toHaveBeenCalledTimes(1)
  })

  it('includes a trimmed shared justification when supplied', async () => {
    usersAPI.bulkTransfer.mockResolvedValue({ data: { successCount: 1, failureCount: 0, results: [] } })

    await mount()
    await setSelectValue('3')
    const textarea = container.querySelector('#bulk-transfer-justification')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    await act(async () => {
      setter.call(textarea, '  moving the whole squad  ')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await submit()

    expect(usersAPI.bulkTransfer).toHaveBeenCalledWith([PLAIN_MEMBER.id], {
      targetTeamId: 3,
      justification: 'moving the whole squad'
    })
  })

  it('renders a per-row results table distinguishing a completed row from a pending-approval row, and does not auto-close', async () => {
    usersAPI.bulkTransfer.mockResolvedValue({
      data: {
        successCount: 2,
        failureCount: 0,
        results: [
          { userId: ADMIN_MEMBER.id, success: true, status: 'completed', destinationTeamPath: 'ORG > Bravo' },
          { userId: PLAIN_MEMBER.id, success: true, status: 'pending_approval', approvalTeamName: 'Bravo' }
        ]
      }
    })

    await mount({ members: [ADMIN_MEMBER, PLAIN_MEMBER] })
    await setSelectValue('3')
    await submit()

    expect(text()).toContain('2 succeeded, 0 failed')
    expect(text()).toContain('Transferred to ORG > Bravo')
    expect(text()).toMatch(/awaits approval by Bravo/)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows a per-row failure message without blocking the other row\'s success', async () => {
    usersAPI.bulkTransfer.mockResolvedValue({
      data: {
        successCount: 1,
        failureCount: 1,
        results: [
          { userId: ADMIN_MEMBER.id, success: false, error: 'An admin cannot transfer their own membership' },
          { userId: PLAIN_MEMBER.id, success: true, status: 'completed', destinationTeamPath: 'ORG > Bravo' }
        ]
      }
    })

    await mount({ members: [ADMIN_MEMBER, PLAIN_MEMBER] })
    await setSelectValue('3')
    await submit()

    expect(text()).toContain('1 succeeded, 1 failed')
    expect(text()).toContain('An admin cannot transfer their own membership')
  })

  it('shows a server-error message inline when the bulk call itself rejects, keeping the dialog open', async () => {
    usersAPI.bulkTransfer.mockRejectedValue({ response: { data: { error: 'network unreachable' } } })

    await mount()
    await setSelectValue('3')
    await submit()

    expect(container.querySelector('[role="alert"]').textContent).toBe('network unreachable')
    expect(onClose).not.toHaveBeenCalled()
    expect(onCompleted).not.toHaveBeenCalled()
  })

  it('renders the dialog box with w-full h-full and sm:-gated rounding/max-width (mobile full-bleed)', async () => {
    await mount()
    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog.className).toContain('w-full h-full')
    expect(dialog.className).toContain('sm:rounded-lg')
  })
})
