import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import Users from './Users.jsx'
import { usersAPI, teamsAPI, configAPI, deviceManagementAPI } from '../services/api'
import { setDisplayTimezone, DEFAULT_DISPLAY_TIMEZONE } from '../utils/dateFormat'
import toast from 'react-hot-toast'

// Validates: Requirements 2.3, 2.4, 3.1, 3.5, 3.7, 3.11
//
// date-tooltips-and-folder-contrast task 6.7. Date_Render_Position 6 -- the
// Last Login cell -- is ONE of the two ternary-guarded call sites, and
// design.md Decision 13 turns on what it renders for a value that is present
// but unparseable: the ternary takes its truthy branch, `formatDate`'s own
// default fallback applies, and the cell renders the EMPTY STRING. Folding
// `'Never'` into `FormattedDate`'s `fallback` prop would render `Never` there
// instead, which is arguably the better product decision and is exactly what
// Criterion 2.3 forbids this change from making as a side effect.
//
// This file is NEW, and creating it rather than asserting the ternary against
// the source was a deliberate call: Decision 13's claim is about three
// rendered strings, one of which ('') is invisible in the source and can only
// be established by rendering. `Users.jsx` had no test file at all, so there
// was nothing to extend.
//
// This project has no `@testing-library/react` (absent from
// `client/package.json` and from `client/node_modules`) and none is added, so
// the page is mounted with `react-dom/client`'s `createRoot` plus React 18's
// own `act` -- the pattern `src/components/TransferMemberDialog.test.jsx`
// established and `src/pages/AuditLogs.test.jsx` follows.
//
// `../services/api` is the only mock: the network boundary. The date module
// is REAL, with a fixed zone installed, so the rendered string is a checked
// fact rather than a value a mock invented.

vi.mock('../services/api', () => ({
  usersAPI: {
    getAll: vi.fn(),
    resendWelcome: vi.fn(),
    removeFromTeam: vi.fn(),
    createAndAdd: vi.fn(),
    transfer: vi.fn()
  },
  // Users-page-action-parity: `Users.jsx` now also reaches `teamsAPI`
  // (Edit's PATCH via `teamsAPI.updateMember`, and the Create User
  // dialog's team picker via `teamsAPI.getMyTeams`) and `configAPI`
  // (the TAK_Role fallback list via `configAPI.getPublic`). A named
  // import of a missing export from a mocked ES module is a load-time
  // failure, so both surfaces are present even where a given test does
  // not exercise them.
  teamsAPI: { updateMember: vi.fn(), getMyTeams: vi.fn() },
  configAPI: { getPublic: vi.fn() },
  // `Users.jsx` reaches this only through `useDeviceManagementEnabled`, which
  // gates the Devices action. A named import of a missing export from a
  // mocked ES module is a load-time failure, so the whole surface the modal
  // and its revoke dialog import is present.
  deviceManagementAPI: {
    probeEnabled: vi.fn(),
    getUserDevices: vi.fn(),
    revokeUserDevice: vi.fn(),
    revokeMyDevice: vi.fn()
  }
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}))

// vitest compiles this JSX with esbuild's classic transform, and neither
// `Users.jsx` nor `FormattedDate.jsx` imports `React` itself.
globalThis.React = React

/** The instant device-management Requirement 18.2 measured. */
const REPORTED_INSTANT = '2026-03-12T00:58:04.508Z'

const userRow = (overrides = {}) => ({
  pk: 1,
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  username: 'ada',
  team_name: 'ORG > Alpha',
  is_active: true,
  local_user_id: 7,
  last_login: REPORTED_INSTANT,
  ...overrides
})

describe('Users Last Login cell renders through FormattedDate (task 6.7)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: false })
    configAPI.getPublic.mockResolvedValue({ data: {} })
    setDisplayTimezone('UTC')
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
    // Module state shared with every other test file, so it goes back to the
    // documented default rather than staying on this file's fixed zone.
    setDisplayTimezone(DEFAULT_DISPLAY_TIMEZONE)
  })

  const mountWith = async (users) => {
    usersAPI.getAll.mockResolvedValue({ data: { users } })
    root = createRoot(container)
    await act(async () => {
      root.render(<Users />)
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  /** The Last Login cell -- the fourth of the row's five cells. */
  const lastLoginCell = () => container.querySelectorAll('tbody tr td')[3]
  const hostOf = () => lastLoginCell().querySelector('span[tabindex="0"]')

  const tooltipOf = () => {
    const host = hostOf()
    const id = host && host.getAttribute('aria-describedby')
    return id ? document.getElementById(id) : null
  }

  it('renders the date-only string in the installed zone, unchanged', async () => {
    await mountWith([userRow()])

    // `formatDate`, so the calendar day in the installed zone and no time of
    // day -- exactly what this cell rendered before the adoption.
    expect(lastLoginCell().textContent).toBe('2026-03-12')
    // The raw ISO value the row carries must not reach the page.
    expect(container.textContent).not.toContain(REPORTED_INSTANT)
  })

  it('leaves nothing disclosed at rest and opens LEFTWARD on pointer (Criteria 3.5, 3.7, 3.11)', async () => {
    await mountWith([userRow()])

    const host = hostOf()
    expect(host).not.toBeNull()
    expect(host.className).toContain('cursor-help')
    // Reachable by keyboard, not by hover alone (Criterion 3.1).
    expect(host.getAttribute('tabindex')).toBe('0')
    expect(host.hasAttribute('aria-describedby')).toBe(false)
    expect(tooltipOf()).toBeNull()

    await act(async () => {
      host.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    })

    const tooltip = tooltipOf()
    expect(tooltip).not.toBeNull()
    // Second-to-last cell of a horizontally scrolling table, so it opens
    // leftward -- a tooltip pushed past that container's left edge is clipped
    // AND unreachable.
    expect(tooltip.className).toContain('right-full')
    expect(tooltip.className).toContain('mr-2')
    expect(tooltip.className).toContain('top-1/2')
    expect(tooltip.className).toContain('-translate-y-1/2')
    expect(tooltip.className).not.toContain('left-full')
    expect(container.innerHTML).not.toContain('top-full')
    expect(container.innerHTML).not.toContain('bottom-full')

    // The tooltip carries the Relative_Time phrase alone -- no resolved
    // zone appended (removed once the visible date-and-time string carried
    // its own abbreviation) and no ISO instant.
    expect(tooltip.textContent.length).toBeGreaterThan(0)
    expect(tooltip.textContent).not.toContain(REPORTED_INSTANT)

    await act(async () => {
      host.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
    })
    expect(tooltipOf()).toBeNull()
    expect(lastLoginCell().textContent).toBe('2026-03-12')
  })

  // Decision 13, pinned rather than described. The absent case takes the
  // ternary's own false branch and renders `'Never'`; the present-but-
  // unparseable case takes the TRUTHY branch and renders the helper's default
  // `''`. Both carry no disclosure host at all (Criterion 2.7).
  it.each([
    ['an absent last_login (the ternary\'s own branch)', null, 'Never'],
    ['a present-but-unparseable last_login', 'not-a-date', '']
  ])('renders %s as %o with no disclosure host', async (_name, lastLogin, expected) => {
    await mountWith([userRow({ last_login: lastLogin })])

    expect(lastLoginCell().textContent).toBe(expected)
    expect(hostOf()).toBeNull()
    expect(container.querySelector('[aria-describedby]')).toBeNull()
  })
})

// Bugfix: the Users view used to render the amber MultipleCertificateWarning
// note ("This account has N active TAK Server certificates."), shown only
// for N > 1. It's now an unconditional, plain "TAK device certificates: N"
// line for every user, at any count including 0 -- more than one live
// certificate per user is an ordinary state, not a defect worth flagging as
// a warning. `live_certificate_count` is `GET /api/users`' own field, from
// the SAME batched query this page's `usersAPI.getAll()` fetch already
// runs -- no second request.
describe('"TAK device certificates" count in the Users view (bugfix)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: false })
    configAPI.getPublic.mockResolvedValue({ data: {} })
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

  const mountWith = async (users) => {
    usersAPI.getAll.mockResolvedValue({ data: { users } })
    root = createRoot(container)
    await act(async () => {
      root.render(<Users />)
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  it.each([0, 1, 2, 5])('renders "TAK device certificates: %i" unconditionally, at any count', async (count) => {
    await mountWith([userRow({ live_certificate_count: count })])

    const row = container.querySelector('tbody tr')
    expect(row.textContent).toContain(`TAK device certificates: ${count}`)
    // The old warning phrasing, and its warning framing, are both gone.
    expect(row.textContent).not.toMatch(/active TAK Server certificates?/)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('renders "TAK device certificates: 0" rather than throwing for a user row missing the field entirely', async () => {
    const { live_certificate_count, ...rowWithoutField } = userRow()
    await expect(mountWith([rowWithoutField])).resolves.not.toThrow()
    const row = container.querySelector('tbody tr')
    expect(row.textContent).toContain('TAK device certificates: 0')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// Users-page-action-parity: the row actions (Edit, Resend welcome, Transfer,
// View Devices, Remove) now match /teams' Member_List actions, via the SAME
// shared components (`MemberActions`, `MemberEditRow`, `TransferMemberDialog`).
// This block exercises the wiring specific to /users: each row supplies its
// OWN `team_id`/`team_name` (there is no single page-level team), and a row
// with no direct team membership disables Edit/Transfer/Remove rather than
// sending a request that could only fail.
// ══════════════════════════════════════════════════════════════════════════
describe('Users row actions (Users-page-action-parity)', () => {
  let container
  let root

  const userRowWithTeam = (overrides = {}) => ({
    pk: 1,
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    username: 'ada',
    first_name: 'Ada',
    last_name: 'Lovelace',
    team_name: 'Alpha Team',
    team_id: 42,
    // Users-page-action-parity: `can_manage`, from GET /api/users, is
    // what actually enables Edit/Transfer/Delete on a row -- true by
    // default here since this fixture represents the caller's OWN team;
    // the "no team_id" and "can_manage: false" cases are exercised by
    // their own, separate tests below.
    can_manage: true,
    is_active: true,
    local_user_id: 7,
    tak_role: 'Team Member',
    callsign_suffix: '',
    last_login: null,
    ...overrides
  })

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: false })
    configAPI.getPublic.mockResolvedValue({ data: {} })
    teamsAPI.getMyTeams.mockResolvedValue({ data: { teams: [] } })
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

  const mountWith = async (users, user) => {
    usersAPI.getAll.mockResolvedValue({ data: { users } })
    root = createRoot(container)
    await act(async () => {
      root.render(<Users user={user} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  const actionButtons = () => container.querySelectorAll('tbody tr td:last-child button')

  it('renders the full MemberActions group (Edit, Resend, Transfer, Remove) for a row with a local account and a team', async () => {
    await mountWith([userRowWithTeam()])

    const labels = Array.from(actionButtons()).map((b) => b.getAttribute('aria-label'))
    expect(labels).toContain('Edit user')
    expect(labels).toContain('Resend welcome email')
    expect(labels).toContain('Transfer member to another team')
    expect(labels).toContain('Delete user (permanently removes their account)')
  })

  it('shows "No local account" instead of any action button when local_user_id is absent', async () => {
    const { local_user_id, ...rowWithoutLocalId } = userRowWithTeam()
    await mountWith([rowWithoutLocalId])

    expect(actionButtons()).toHaveLength(0)
    expect(container.textContent).toContain('No local account')
  })

  it('disables every action (Edit, Resend, Transfer, Remove) for a row with no team_id', async () => {
    await mountWith([userRowWithTeam({ team_id: null, team_name: null, can_manage: false })])

    // Every disabled action shares the SAME accessible name/title
    // ("This user has no team assignment") per MemberActions' own
    // convention -- ALL FOUR actions in this group are now gated on
    // `hasTeam`, including Resend and View Devices: both are already
    // independently team-admin-scoped server-side
    // (`user:resend_welcome:team_admin`, `isManagedUser`), so this is the
    // client reflecting an existing server rule, not a new restriction.
    const disabledButtons = Array.from(actionButtons()).filter(
      (b) => b.getAttribute('aria-label') === 'This user has no team assignment'
    )
    expect(disabledButtons).toHaveLength(4)
    disabledButtons.forEach((b) => expect(b.disabled).toBe(true))
  })

  // Users-page-action-parity: the SECOND, DISTINCT reason a row's actions
  // can be disabled -- the row HAS a team, but the caller does not
  // administer it (`can_manage: false` from GET /api/users, mirroring
  // Team.isAdmin). This is the actual fix for "/users must not be a wider
  // escape hatch than /teams' own Member_List": a Team_Admin's directory
  // VISIBILITY is Organisation-wide, but their ability to ACT on a row
  // (including Resend and View Devices, not only Edit/Transfer/Delete)
  // stays scoped to teams they administer (or a descendant of one).
  it('disables every action with a DIFFERENT reason when the row has a team the caller does not administer', async () => {
    await mountWith([userRowWithTeam({ can_manage: false })])

    const disabledButtons = Array.from(actionButtons()).filter(
      (b) => b.getAttribute('aria-label') === "You don't administer this user's team"
    )
    expect(disabledButtons).toHaveLength(4)
    disabledButtons.forEach((b) => expect(b.disabled).toBe(true))

    // Distinct from the no-team-assignment case's wording -- the two are
    // different facts and must not collapse into one generic message.
    expect(container.textContent).not.toContain('This user has no team assignment')
  })

  it('enables every action when the row has a team the caller DOES administer (can_manage: true)', async () => {
    await mountWith([userRowWithTeam({ can_manage: true })])

    const labels = Array.from(actionButtons()).map((b) => b.getAttribute('aria-label'))
    expect(labels).toContain('Edit user')
    expect(labels).toContain('Resend welcome email')
    expect(labels).toContain('Transfer member to another team')
    expect(labels).toContain('Delete user (permanently removes their account)')
    actionButtons().forEach((b) => expect(b.disabled).toBe(false))
  })

  it('opens the inline MemberEditRow on Edit and saves via teamsAPI.updateMember using the ROW\'s own team_id', async () => {
    teamsAPI.updateMember.mockResolvedValue({
      data: { member: { first_name: 'Adele', last_name: 'Lovelace', tak_role: 'Team Lead', callsign_suffix: 'A.Lovelace' } }
    })
    await mountWith([userRowWithTeam()])

    const editButton = Array.from(actionButtons()).find((b) => b.getAttribute('aria-label') === 'Edit user')
    await act(async () => {
      editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const firstNameInput = Array.from(container.querySelectorAll('input')).find(
      (input) => input.previousSibling?.textContent === 'First Name'
    )
    expect(firstNameInput).not.toBeUndefined()

    const saveButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save')
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(teamsAPI.updateMember).toHaveBeenCalledWith(42, 7, expect.objectContaining({
      firstName: 'Ada',
      lastName: 'Lovelace',
      takRole: 'Team Member'
    }))
    // The inline edit form closes once the server's response has been
    // applied -- it does not stay open showing the submitted (not
    // necessarily accepted) values.
    expect(container.querySelector('input[value="Adele"]')).toBeNull()
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Save')).toBe(false)
  })

  // Bugfix (Resend welcome email was the only action with no
  // confirmation): the action icon now opens a confirmation dialog
  // rather than firing the request immediately; confirming inside it
  // is what actually calls usersAPI.resendWelcome.
  it('opens a confirmation dialog on Resend welcome, and calls usersAPI.resendWelcome with the local_user_id and the row\'s own team_id only after confirming', async () => {
    usersAPI.resendWelcome.mockResolvedValue({ data: {} })
    await mountWith([userRowWithTeam()])

    const resendButton = Array.from(actionButtons()).find((b) => b.getAttribute('aria-label') === 'Resend welcome email')
    await act(async () => {
      resendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(usersAPI.resendWelcome).not.toHaveBeenCalled()
    const dialog = container.querySelector('[role="dialog"][aria-labelledby="resend-welcome-title"]')
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('ada@example.com')

    const confirmButton = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Resend Email')
    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(usersAPI.resendWelcome).toHaveBeenCalledWith(7, 42)
    expect(container.querySelector('[role="dialog"][aria-labelledby="resend-welcome-title"]')).toBeNull()
  })

  it('does not call usersAPI.resendWelcome when the confirmation dialog is cancelled', async () => {
    await mountWith([userRowWithTeam()])

    const resendButton = Array.from(actionButtons()).find((b) => b.getAttribute('aria-label') === 'Resend welcome email')
    await act(async () => {
      resendButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const dialog = container.querySelector('[role="dialog"][aria-labelledby="resend-welcome-title"]')
    const cancelButton = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')
    await act(async () => {
      cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(usersAPI.resendWelcome).not.toHaveBeenCalled()
    expect(container.querySelector('[role="dialog"][aria-labelledby="resend-welcome-title"]')).toBeNull()
  })

  it('opens the shared TransferMemberDialog on Transfer, pre-populated with the row\'s own team as the source', async () => {
    await mountWith([userRowWithTeam()])

    const transferButton = Array.from(actionButtons()).find((b) => b.getAttribute('aria-label') === 'Transfer member to another team')
    await act(async () => {
      transferButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.querySelector('[role="dialog"][aria-labelledby="transfer-member-title"]')).not.toBeNull()
    expect(container.textContent).toContain('Alpha Team')
  })

  it('opens the Permanently Delete User dialog on Delete, gated on typing the exact email', async () => {
    usersAPI.removeFromTeam.mockResolvedValue({ data: {} })
    await mountWith([userRowWithTeam()])

    const removeButton = Array.from(actionButtons()).find((b) => b.getAttribute('aria-label') === 'Delete user (permanently removes their account)')
    await act(async () => {
      removeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const dialog = container.querySelector('[role="dialog"][aria-labelledby="delete-user-title"]')
    expect(dialog).not.toBeNull()

    const confirmButton = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent.includes('Delete User Permanently'))
    expect(confirmButton.disabled).toBe(true)

    const input = dialog.querySelector('input[type="text"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setter.call(input, 'ada@example.com')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(confirmButton.disabled).toBe(false)

    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(usersAPI.removeFromTeam).toHaveBeenCalledWith(7, 42)
  })

  // Bugfix (silent Authentik-delete failure): the local account is gone
  // either way, but the two outcomes read very differently to the admin
  // -- a plain success toast when Authentik's own delete succeeded (or
  // the field is absent, the pre-existing shape), versus a distinct
  // error toast naming the queued-for-retry cleanup when it didn't.
  it('shows a plain success toast when authentikAccountDeleted is true (or absent)', async () => {
    usersAPI.removeFromTeam.mockResolvedValue({ data: { authentikAccountDeleted: true } })
    await mountWith([userRowWithTeam()])

    const removeButton = Array.from(actionButtons()).find((b) => b.getAttribute('aria-label') === 'Delete user (permanently removes their account)')
    await act(async () => {
      removeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const dialog = container.querySelector('[role="dialog"][aria-labelledby="delete-user-title"]')
    const input = dialog.querySelector('input[type="text"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setter.call(input, 'ada@example.com')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const confirmButton = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent.includes('Delete User Permanently'))
    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(toast.success).toHaveBeenCalledWith('User permanently deleted')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('shows a distinct error toast, not the plain success one, when authentikAccountDeleted is false', async () => {
    usersAPI.removeFromTeam.mockResolvedValue({ data: { authentikAccountDeleted: false } })
    await mountWith([userRowWithTeam()])

    const removeButton = Array.from(actionButtons()).find((b) => b.getAttribute('aria-label') === 'Delete user (permanently removes their account)')
    await act(async () => {
      removeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const dialog = container.querySelector('[role="dialog"][aria-labelledby="delete-user-title"]')
    const input = dialog.querySelector('input[type="text"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setter.call(input, 'ada@example.com')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const confirmButton = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent.includes('Delete User Permanently'))
    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('queued for retry'))
    expect(toast.success).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════════════════
// Users-page-action-parity: the "Create User" button, previously dead (no
// `onClick` at all -- BUG-026), now opens a working dialog that collects a
// target team (this page has none in scope) before calling
// `usersAPI.createAndAdd`.
// ══════════════════════════════════════════════════════════════════════════
describe('Users "Create User" dialog (Users-page-action-parity, fixes BUG-026)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: false })
    configAPI.getPublic.mockResolvedValue({ data: {} })
    usersAPI.getAll.mockResolvedValue({ data: { users: [] } })
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

  const mount = async (user) => {
    root = createRoot(container)
    await act(async () => {
      root.render(<Users user={user} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  const openDialog = async () => {
    const createButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent.includes('Create User'))
    await act(async () => {
      createButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  it('has a working onClick handler that opens a dialog with a team picker (fixes BUG-026)', async () => {
    teamsAPI.getMyTeams.mockResolvedValue({
      data: { teams: [{ id: 5, name: 'Bravo Team', display_name: 'Bravo Team' }] }
    })
    await mount({ isAdmin: false })
    await openDialog()

    expect(container.querySelector('[role="dialog"][aria-labelledby="create-user-title"]')).not.toBeNull()
    const teamSelect = container.querySelector('#create-user-team')
    expect(teamSelect).not.toBeNull()
    expect(Array.from(teamSelect.querySelectorAll('option')).map((o) => o.textContent)).toContain('Bravo Team')
  })

  it('falls back to the all-teams list for a Global_Manager when the organisation-scoped list is empty', async () => {
    teamsAPI.getMyTeams.mockResolvedValueOnce({ data: { teams: [] } })
    teamsAPI.getMyTeams.mockResolvedValueOnce({ data: { teams: [{ id: 9, name: 'Charlie Team' }] } })
    await mount({ isAdmin: true })
    await openDialog()

    expect(teamsAPI.getMyTeams).toHaveBeenCalledTimes(2)
    expect(teamsAPI.getMyTeams).toHaveBeenNthCalledWith(1, { scope: 'organisation' })
    expect(teamsAPI.getMyTeams).toHaveBeenNthCalledWith(2)
    const teamSelect = container.querySelector('#create-user-team')
    expect(Array.from(teamSelect.querySelectorAll('option')).map((o) => o.textContent)).toContain('Charlie Team')
  })

  it('validates the email inline before submitting', async () => {
    teamsAPI.getMyTeams.mockResolvedValue({ data: { teams: [{ id: 5, name: 'Bravo Team' }] } })
    await mount({ isAdmin: false })
    await openDialog()

    const emailInput = container.querySelector('#create-user-email')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setter.call(emailInput, 'not-an-email')
      emailInput.dispatchEvent(new Event('input', { bubbles: true }))
      emailInput.focus()
    })
    await act(async () => {
      emailInput.blur()
    })

    expect(container.textContent).toContain('Please enter a valid email address.')
    expect(usersAPI.createAndAdd).not.toHaveBeenCalled()
  })

  it('submits usersAPI.createAndAdd with the selected team and closes on success', async () => {
    teamsAPI.getMyTeams.mockResolvedValue({ data: { teams: [{ id: 5, name: 'Bravo Team' }] } })
    usersAPI.createAndAdd.mockResolvedValue({ data: { user: { callsign_suffix: null } } })
    await mount({ isAdmin: false })
    await openDialog()

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const emailInput = container.querySelector('#create-user-email')
    const firstNameInput = container.querySelector('#create-user-first-name')
    const lastNameInput = container.querySelector('#create-user-last-name')
    const teamSelect = container.querySelector('#create-user-team')

    await act(async () => {
      setter.call(emailInput, 'new.user@example.test')
      emailInput.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(firstNameInput, 'New')
      firstNameInput.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(lastNameInput, 'User')
      lastNameInput.dispatchEvent(new Event('input', { bubbles: true }))
      const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      selectSetter.call(teamSelect, '5')
      teamSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const form = container.querySelector('form')
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(usersAPI.createAndAdd).toHaveBeenCalledWith('new.user@example.test', 'New', 'User', '5')
    expect(container.querySelector('[role="dialog"][aria-labelledby="create-user-title"]')).toBeNull()
  })

  // Bugfix (silent welcome-email failures): the account is created
  // either way, but `welcomeEmailSent: false` in the response now gets
  // its own toast.error naming the target email, rather than the
  // ordinary success toast -- and NOT both, since layering a success
  // toast plus a separate warning for one action would read as
  // contradictory.
  it('shows toast.success (not toast.error) on a normal create where welcomeEmailSent is absent/true', async () => {
    teamsAPI.getMyTeams.mockResolvedValue({ data: { teams: [{ id: 5, name: 'Bravo Team' }] } })
    usersAPI.createAndAdd.mockResolvedValue({ data: { user: { callsign_suffix: null } } })
    await mount({ isAdmin: false })
    await openDialog()

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const emailInput = container.querySelector('#create-user-email')
    const firstNameInput = container.querySelector('#create-user-first-name')
    const lastNameInput = container.querySelector('#create-user-last-name')
    const teamSelect = container.querySelector('#create-user-team')

    await act(async () => {
      setter.call(emailInput, 'new.user@example.test')
      emailInput.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(firstNameInput, 'New')
      firstNameInput.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(lastNameInput, 'User')
      lastNameInput.dispatchEvent(new Event('input', { bubbles: true }))
      const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      selectSetter.call(teamSelect, '5')
      teamSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const form = container.querySelector('form')
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(toast.success).toHaveBeenCalledWith('User created and added to the selected team')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('shows a single toast.error naming the email, and no toast.success, when welcomeEmailSent is false', async () => {
    teamsAPI.getMyTeams.mockResolvedValue({ data: { teams: [{ id: 5, name: 'Bravo Team' }] } })
    usersAPI.createAndAdd.mockResolvedValue({ data: { user: { callsign_suffix: null }, welcomeEmailSent: false } })
    await mount({ isAdmin: false })
    await openDialog()

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const emailInput = container.querySelector('#create-user-email')
    const firstNameInput = container.querySelector('#create-user-first-name')
    const lastNameInput = container.querySelector('#create-user-last-name')
    const teamSelect = container.querySelector('#create-user-team')

    await act(async () => {
      setter.call(emailInput, 'new.user@example.test')
      emailInput.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(firstNameInput, 'New')
      firstNameInput.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(lastNameInput, 'User')
      lastNameInput.dispatchEvent(new Event('input', { bubbles: true }))
      const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      selectSetter.call(teamSelect, '5')
      teamSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const form = container.querySelector('form')
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('new.user@example.test'))
    expect(toast.success).not.toHaveBeenCalled()
    // The dialog still closes -- the account WAS created.
    expect(container.querySelector('[role="dialog"][aria-labelledby="create-user-title"]')).toBeNull()
  })

  it('surfaces a server rejection inline and keeps the dialog open', async () => {
    teamsAPI.getMyTeams.mockResolvedValue({ data: { teams: [{ id: 5, name: 'Bravo Team' }] } })
    usersAPI.createAndAdd.mockRejectedValue({ response: { data: { error: 'Email already in use' } } })
    await mount({ isAdmin: false })
    await openDialog()

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const emailInput = container.querySelector('#create-user-email')
    const firstNameInput = container.querySelector('#create-user-first-name')
    const lastNameInput = container.querySelector('#create-user-last-name')
    const teamSelect = container.querySelector('#create-user-team')

    await act(async () => {
      setter.call(emailInput, 'new.user@example.test')
      emailInput.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(firstNameInput, 'New')
      firstNameInput.dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(lastNameInput, 'User')
      lastNameInput.dispatchEvent(new Event('input', { bubbles: true }))
      const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      selectSetter.call(teamSelect, '5')
      teamSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const form = container.querySelector('form')
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Email already in use')
    expect(container.querySelector('[role="dialog"][aria-labelledby="create-user-title"]')).not.toBeNull()
  })
})
