import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import TransferMemberDialog, {
  CALLSIGN_CHANGE_STATEMENT,
  ADMIN_DEMOTION_STATEMENT,
  filterDestinationTeams,
  shouldFallBackToAllTeams,
  formatTeamPath,
  isCallsignSuffixConflictMessage,
  extractConflictingCallsignSuffix,
  buildTransferPayload,
  interpretTransferResponse,
  interpretTransferError
} from './TransferMemberDialog.jsx'
import { teamsAPI, usersAPI } from '../services/api'
import toast from 'react-hot-toast'

// Validates: Requirements 9.6, 10.4, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7,
// 15.8, 15.9, 17.7
//
// This project has no `@testing-library/react` (checked: absent from
// `client/package.json` and from `client/node_modules`), and no dependency
// is added for this task. The dialog is therefore driven two ways, both
// with what is already installed:
//
//  1. Its exported pure helpers are asserted directly, matching the
//     convention of `src/pages/TeamDetail.test.jsx` and
//     `src/utils/channelTree.test.js`.
//  2. The component itself is mounted with `react-dom/client`'s
//     `createRoot` plus React 18.3's own `act`, under the `jsdom`
//     environment already configured in `vite.config.js`. That covers the
//     render-level and flow-level criteria (which statement is shown,
//     which option list is offered, what a 200/202/4xx does) that the
//     helpers alone cannot demonstrate, and it is what makes
//     Requirement 17.7's two named assertions genuine assertions about
//     the dialog rather than about a helper.
//
// `../services/api` and `react-hot-toast` are the only mocks: the network
// boundary and the toast sink. Everything else is the real component.

vi.mock('../services/api', () => ({
  teamsAPI: { getMyTeams: vi.fn() },
  usersAPI: { transfer: vi.fn() }
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}))

// The three-team fixture used by the mounted tests: an Organisation with
// two Sub_Teams. Team 2 is the displayed Team, so Requirement 15.3 means
// only teams 1 and 3 may be offered.
// Vitest resolves this project's Vite config but does not apply
// `@vitejs/plugin-react` to the modules it loads, so JSX here and in the
// component under test is compiled by esbuild's classic transform to
// `React.createElement` rather than the automatic `react/jsx-runtime`
// import. The component source (correctly, for the app build) has no
// `React` import of its own, so the classic transform needs one in scope.
// Publishing the real React onto `globalThis` supplies it for both files.
// Harmless and forward-compatible: if the automatic runtime is ever active
// here, nothing reads this global.
globalThis.React = React

const ORG_TEAMS = [
  { id: 1, name: 'Organisation', callsign_prefix: 'ORG', parent_team_id: null },
  { id: 2, name: 'Alpha', callsign_prefix: 'ALF', parent_team_id: 1 },
  { id: 3, name: 'Bravo', callsign_prefix: 'BRV', parent_team_id: 1 }
]

const ADMIN_MEMBER = { id: 42, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', role: 'admin' }
const PLAIN_MEMBER = { id: 43, first_name: 'Bob', last_name: 'Brown', email: 'bob@example.com', role: 'member' }
const DISPLAYED_TEAM = { id: 2, name: 'Alpha', display_name: 'Organisation > Alpha' }

describe('TransferMemberDialog pure helpers', () => {
  describe('filterDestinationTeams (Req 15.3)', () => {
    it('excludes the displayed team and keeps every other team', () => {
      expect(filterDestinationTeams(ORG_TEAMS, 2).map((t) => t.id)).toEqual([1, 3])
    })

    it('compares ids as strings, so a string select value still excludes the team', () => {
      expect(filterDestinationTeams(ORG_TEAMS, '2').map((t) => t.id)).toEqual([1, 3])
    })

    it('returns an empty list for a non-array input rather than throwing', () => {
      expect(filterDestinationTeams(undefined, 2)).toEqual([])
      expect(filterDestinationTeams(null, 2)).toEqual([])
    })
  })

  describe('shouldFallBackToAllTeams (Reqs 15.8, 15.9)', () => {
    it('falls back only on an empty scoped list for an admin', () => {
      expect(shouldFallBackToAllTeams([], { isAdmin: true })).toBe(true)
    })

    it('does not fall back when the scoped list is non-empty, even for an admin', () => {
      expect(shouldFallBackToAllTeams(ORG_TEAMS, { isAdmin: true })).toBe(false)
    })

    it('does not fall back for a non-admin with an empty scoped list (Req 15.8)', () => {
      expect(shouldFallBackToAllTeams([], { isAdmin: false })).toBe(false)
      expect(shouldFallBackToAllTeams([], undefined)).toBe(false)
    })

    it('treats a missing scoped list as empty', () => {
      expect(shouldFallBackToAllTeams(undefined, { isAdmin: true })).toBe(true)
      expect(shouldFallBackToAllTeams(undefined, { isAdmin: false })).toBe(false)
    })
  })

  describe('formatTeamPath', () => {
    it('walks the parent chain with the callsign_prefix || name segment mapping', () => {
      expect(formatTeamPath(ORG_TEAMS[1], ORG_TEAMS)).toBe('ORG > Alpha')
    })

    it('renders an Organisation as its own name alone', () => {
      expect(formatTeamPath(ORG_TEAMS[0], ORG_TEAMS)).toBe('Organisation')
    })

    it('falls back to a parent name when the parent has no callsign_prefix', () => {
      const teams = [
        { id: 1, name: 'Organisation', callsign_prefix: null, parent_team_id: null },
        { id: 2, name: 'Alpha', parent_team_id: 1 }
      ]
      expect(formatTeamPath(teams[1], teams)).toBe('Organisation > Alpha')
    })

    it('stops when an ancestor is missing from the list instead of looping', () => {
      expect(formatTeamPath({ id: 9, name: 'Orphan', parent_team_id: 99 }, ORG_TEAMS)).toBe('Orphan')
    })

    it('terminates on a cyclic parent pointer', () => {
      const cyclic = [
        { id: 1, name: 'One', parent_team_id: 2 },
        { id: 2, name: 'Two', parent_team_id: 1 }
      ]
      expect(formatTeamPath(cyclic[0], cyclic)).toBe('Two > One')
    })
  })

  describe('isCallsignSuffixConflictMessage / extractConflictingCallsignSuffix (Req 9.6)', () => {
    const conflict = 'Callsign Suffix "K9" is already in use within this Team'

    it('recognises the server conflict message', () => {
      expect(isCallsignSuffixConflictMessage(conflict)).toBe(true)
    })

    it('does not recognise an unrelated 400 message', () => {
      expect(isCallsignSuffixConflictMessage('Target team not found')).toBe(false)
      expect(isCallsignSuffixConflictMessage(undefined)).toBe(false)
    })

    it('extracts the conflicting value for the replacement input placeholder', () => {
      expect(extractConflictingCallsignSuffix(conflict)).toBe('K9')
    })

    it('returns null when no quoted value is present', () => {
      expect(extractConflictingCallsignSuffix('no quotes here')).toBeNull()
      expect(extractConflictingCallsignSuffix(null)).toBeNull()
    })
  })

  describe('buildTransferPayload', () => {
    it('coerces targetTeamId and omits empty optional fields', () => {
      expect(buildTransferPayload({ targetTeamId: '3', justification: '  ', callsignSuffix: '' }))
        .toEqual({ targetTeamId: 3 })
    })

    it('trims and includes the optional fields when supplied', () => {
      expect(buildTransferPayload({ targetTeamId: 3, justification: ' moving ', callsignSuffix: ' K9 ' }))
        .toEqual({ targetTeamId: 3, justification: 'moving', callsignSuffix: 'K9' })
    })
  })

  describe('interpretTransferResponse (Reqs 15.5, 15.6)', () => {
    it('refreshes the Member_List for a 200 completed response', () => {
      const result = interpretTransferResponse({
        status: 200,
        data: { status: 'completed', callsign: 'BRV.Ada', destinationTeamPath: 'ORG > Bravo' }
      })
      expect(result.kind).toBe('completed')
      expect(result.refresh).toBe(true)
      expect(result.message).toContain('ORG > Bravo')
      expect(result.message).toContain('BRV.Ada')
    })

    it('leaves the Member_List alone for a 202 pending_approval response', () => {
      const result = interpretTransferResponse({
        status: 202,
        data: { status: 'pending_approval', requestId: 7, approvalTeamName: 'Bravo' }
      })
      expect(result.kind).toBe('pending_approval')
      expect(result.refresh).toBe(false)
      expect(result.message).toMatch(/approval/i)
      expect(result.message).toContain('Bravo')
    })

    it('treats the HTTP status as the fallback when the body carries no status field', () => {
      expect(interpretTransferResponse({ status: 202, data: {} }).refresh).toBe(false)
      expect(interpretTransferResponse({ status: 200, data: {} }).refresh).toBe(true)
    })
  })

  describe('interpretTransferError (Reqs 9.6, 15.7)', () => {
    it.each([400, 403, 404, 409])('keeps the dialog open and surfaces the body message for a %i', (status) => {
      const result = interpretTransferError({ response: { status, data: { error: `rejected with ${status}` } } })
      expect(result.kind).toBe('error')
      expect(result.keepOpen).toBe(true)
      expect(result.serverError).toBe(`rejected with ${status}`)
    })

    it('routes a 400 naming a conflicting callsign suffix to the retry prompt', () => {
      const message = 'Callsign Suffix "K9" is already in use within this Team'
      const result = interpretTransferError({ response: { status: 400, data: { error: message } } })
      expect(result.kind).toBe('callsign_suffix_conflict')
      expect(result.callsignSuffixPrompt).toBe(message)
      expect(result.serverError).toBeNull()
    })

    it('joins express-validator field messages, which carry no error field', () => {
      const result = interpretTransferError({
        response: { status: 400, data: { errors: [{ msg: 'targetTeamId is required' }, { msg: 'too long' }] } }
      })
      expect(result.serverError).toBe('targetTeamId is required, too long')
    })

    it('keeps the dialog open with a generic message for an unexpected failure', () => {
      const result = interpretTransferError({ message: 'Network Error' })
      expect(result.keepOpen).toBe(true)
      expect(result.serverError).toMatch(/failed to transfer/i)
    })
  })
})

describe('TransferMemberDialog (mounted)', () => {
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
        <TransferMemberDialog
          member={PLAIN_MEMBER}
          team={DISPLAYED_TEAM}
          onClose={onClose}
          onCompleted={onCompleted}
          {...props}
        />
      )
    })
  }

  const text = () => container.textContent
  const select = () => container.querySelector('#transfer-target-team')
  const suffixInput = () => container.querySelector('#transfer-callsign-suffix')
  const optionValues = () => Array.from(select().options).map((o) => o.value).filter(Boolean)

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

  const setSelectValue = async (value) => {
    const el = select()
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    await act(async () => {
      setter.call(el, value)
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  const setSuffixValue = async (value) => {
    const el = suffixInput()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const submit = async () => {
    const form = container.querySelector('form')
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
  }

  // Requirement 17.7, first named assertion.
  it('states the admin-demotion consequence for an admin member (Req 10.4)', async () => {
    await mount({ member: ADMIN_MEMBER })
    expect(text()).toContain(ADMIN_DEMOTION_STATEMENT)
  })

  it('omits the admin-demotion statement for a plain member (Req 10.4)', async () => {
    await mount({ member: PLAIN_MEMBER })
    expect(text()).not.toContain(ADMIN_DEMOTION_STATEMENT)
  })

  it('states that the transfer changes the TAK callsign, for every member (Req 15.4)', async () => {
    await mount({ member: PLAIN_MEMBER })
    expect(text()).toContain(CALLSIGN_CHANGE_STATEMENT)
  })

  it('offers the organisation-scoped list with the displayed team excluded (Reqs 15.2, 15.3, 15.8)', async () => {
    await mount()
    expect(teamsAPI.getMyTeams).toHaveBeenCalledTimes(1)
    expect(teamsAPI.getMyTeams).toHaveBeenCalledWith({ scope: 'organisation' })
    expect(optionValues()).toEqual(expect.arrayContaining(['1', '3']))
    expect(optionValues()).not.toContain('2')
    expect(text()).toContain('ORG > Bravo')
  })

  it('falls back to the all-teams call on an empty scoped list for an admin (Req 15.9)', async () => {
    teamsAPI.getMyTeams
      .mockResolvedValueOnce({ data: { teams: [] } })
      .mockResolvedValueOnce({ data: { teams: ORG_TEAMS } })

    await mount({ user: { isAdmin: true } })

    expect(teamsAPI.getMyTeams).toHaveBeenCalledTimes(2)
    expect(teamsAPI.getMyTeams).toHaveBeenNthCalledWith(1, { scope: 'organisation' })
    expect(teamsAPI.getMyTeams).toHaveBeenNthCalledWith(2)
    expect(optionValues()).toEqual(expect.arrayContaining(['1', '3']))
  })

  it('does not fall back for a non-admin with an empty scoped list (Req 15.8)', async () => {
    teamsAPI.getMyTeams.mockResolvedValue({ data: { teams: [] } })

    await mount({ user: { isAdmin: false } })

    expect(teamsAPI.getMyTeams).toHaveBeenCalledTimes(1)
    expect(optionValues()).toEqual([])
  })

  it('does not fall back for an admin whose scoped list is non-empty (Req 15.9)', async () => {
    await mount({ user: { isAdmin: true } })
    expect(teamsAPI.getMyTeams).toHaveBeenCalledTimes(1)
  })

  it('refreshes the Member_List and closes on a 200 completed response (Req 15.5)', async () => {
    usersAPI.transfer.mockResolvedValue({
      status: 200,
      data: { status: 'completed', callsign: 'BRV.Bob', destinationTeamPath: 'ORG > Bravo', demotedFromAdmin: false }
    })

    await mount()
    await setSelectValue('3')
    await submit()

    expect(usersAPI.transfer).toHaveBeenCalledWith(PLAIN_MEMBER.id, { targetTeamId: 3 })
    expect(onCompleted).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success.mock.calls[0][0]).toContain('ORG > Bravo')
  })

  it('leaves the Member_List unchanged on a 202 pending_approval response (Req 15.6)', async () => {
    usersAPI.transfer.mockResolvedValue({
      status: 202,
      data: { status: 'pending_approval', requestId: 11, approvalTeamId: 3, approvalTeamName: 'Bravo' }
    })

    await mount()
    await setSelectValue('3')
    await submit()

    expect(onCompleted).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success.mock.calls[0][0]).toMatch(/approval/i)
  })

  // Requirement 17.7, second named assertion (parameterised across the
  // four statuses Requirement 15.7 names).
  it.each([400, 403, 404, 409])(
    'keeps the dialog open and displays the server message on a %i (Req 15.7)',
    async (status) => {
      const message = `server said no (${status})`
      usersAPI.transfer.mockRejectedValue({ response: { status, data: { error: message } } })

      await mount()
      await setSelectValue('3')
      await submit()

      expect(onClose).not.toHaveBeenCalled()
      expect(onCompleted).not.toHaveBeenCalled()
      expect(container.querySelector('[role="dialog"]')).not.toBeNull()
      expect(container.querySelector('[role="alert"]').textContent).toBe(message)
    }
  )

  it('resubmits with the replacement suffix after a callsign-suffix conflict (Req 9.6)', async () => {
    const conflict = 'Callsign Suffix "K9" is already in use within this Team'
    usersAPI.transfer
      .mockRejectedValueOnce({ response: { status: 400, data: { error: conflict } } })
      .mockResolvedValueOnce({
        status: 200,
        data: { status: 'completed', callsign: 'BRV.Bob', destinationTeamPath: 'ORG > Bravo' }
      })

    await mount()
    await setSelectValue('3')
    await submit()

    // The dialog stays open, shows the server's message, and reveals the
    // replacement input naming the value that collided.
    expect(onClose).not.toHaveBeenCalled()
    expect(text()).toContain(conflict)
    expect(suffixInput()).not.toBeNull()
    expect(suffixInput().placeholder).toContain('K9')

    await setSuffixValue('K10')
    await submit()

    expect(usersAPI.transfer).toHaveBeenCalledTimes(2)
    expect(usersAPI.transfer.mock.calls[1]).toEqual([PLAIN_MEMBER.id, { targetTeamId: 3, callsignSuffix: 'K10' }])
    expect(onCompleted).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('blocks the retry until a replacement suffix is entered (Req 9.6)', async () => {
    const conflict = 'Callsign Suffix "K9" is already in use within this Team'
    usersAPI.transfer.mockRejectedValue({ response: { status: 400, data: { error: conflict } } })

    await mount()
    await setSelectValue('3')
    await submit()

    const submitButton = container.querySelector('button[type="submit"]')
    expect(submitButton.disabled).toBe(true)

    await setSuffixValue('K10')
    expect(container.querySelector('button[type="submit"]').disabled).toBe(false)
  })
})
