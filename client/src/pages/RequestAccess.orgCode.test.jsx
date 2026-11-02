import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

// Required: Vitest compiles this JSX with esbuild's classic transform and the
// page sources carry no React import of their own.
globalThis.React = React

const mockGetAvailableTeams = vi.fn()

vi.mock('../services/api', () => ({
  signupAPI: {
    getAvailableTeams: (...args) => mockGetAvailableTeams(...args),
    initiate: vi.fn(),
    submitTeamAccess: vi.fn(),
    submitOrgInterest: vi.fn()
  },
  configAPI: {
    getPublic: () => Promise.resolve({ data: { recaptcha_disabled: true } })
  }
}))
vi.mock('../utils/recaptcha', () => ({ getRecaptchaToken: vi.fn() }))

import RequestAccess, { teamOptionLabel } from './RequestAccess.jsx'

const ORG = { id: 1, name: 'LSAR', display_name: 'LSAR' }
const CHILD = { id: 2, name: 'Auckland', display_name: 'LSAR - Auckland', path: 'Auckland' }
const GRANDCHILD = { id: 3, name: 'Cave', display_name: 'LSAR - Cave', path: 'Auckland > Cave' }
const OPEN_TEAM = { id: 9, name: 'Open', display_name: 'Open' }

describe('teamOptionLabel', () => {
  it('is the display name for the Organisation and for a direct child', () => {
    expect(teamOptionLabel(ORG)).toBe('LSAR')
    expect(teamOptionLabel(CHILD)).toBe('LSAR - Auckland')
  })

  it('names the teams a deeper team sits under', () => {
    expect(teamOptionLabel(GRANDCHILD)).toBe('LSAR - Cave (in Auckland)')
    expect(teamOptionLabel({ ...GRANDCHILD, path: 'A > B > C' })).toBe('LSAR - Cave (in A > B)')
  })

  it('falls back to name, and is total over missing input', () => {
    expect(teamOptionLabel({ name: 'Only' })).toBe('Only')
    expect(teamOptionLabel(null)).toBe('')
    expect(teamOptionLabel(undefined)).toBe('')
    expect(teamOptionLabel({ display_name: 'X', path: 42 })).toBe('X')
  })
})

describe('RequestAccess team selection with an Organisation sign-up code (mounted)', () => {
  let container
  let root
  let originalMatchMedia

  async function mount(responseData) {
    mockGetAvailableTeams.mockResolvedValue({ data: { email: 'user@example.com', ...responseData } })
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/request-access?token=abc']}>
          <RequestAccess />
        </MemoryRouter>
      )
    })
    // Let the getAvailableTeams promise settle and the step change render.
    await act(async () => {})
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    mockGetAvailableTeams.mockReset()
    // jsdom has no matchMedia; ThemeProvider reads it on mount.
    originalMatchMedia = window.matchMedia
    window.matchMedia = () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {}
    })
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
    window.matchMedia = originalMatchMedia
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const optionTexts = () => [...container.querySelectorAll('select option')].map((o) => o.textContent)

  it('keeps the selector open, preselects the Organisation and lists its sub-teams', async () => {
    await mount({ teams: [ORG, CHILD, GRANDCHILD], codeTeamId: 1, codeScope: 'organisation' })

    const select = container.querySelector('select')
    expect(select, 'the team selector should be rendered for an Organisation code').not.toBeNull()
    expect(select.value).toBe('1')
    expect(optionTexts()).toEqual(['Select a team...', 'LSAR', 'LSAR - Auckland', 'LSAR - Cave (in Auckland)'])
    expect(container.querySelector('input[aria-label="Search teams by name"]')).not.toBeNull()
  })

  it('says the teams came from the code, as text, and hides the "request a new team" escape hatch', async () => {
    await mount({ teams: [ORG, CHILD], codeTeamId: 1, codeScope: 'organisation' })

    expect(container.textContent).toContain('via sign-up code')
    expect(container.textContent).toContain('Your sign-up code lets you choose any of these teams')
    expect(container.textContent).not.toContain('Request a new team here')
  })

  it('still locks the selection to the team for a Team code', async () => {
    await mount({ teams: [CHILD, OPEN_TEAM], codeTeamId: 2, codeScope: 'team' })

    expect(container.querySelector('select')).toBeNull()
    expect(container.textContent).toContain('LSAR - Auckland')
    expect(container.textContent).toContain('This team was selected via your sign-up code.')
  })

  it('shows the ordinary selector and the escape hatch when no code was used', async () => {
    await mount({ teams: [OPEN_TEAM] })

    const select = container.querySelector('select')
    expect(select).not.toBeNull()
    expect(optionTexts()).toEqual(['Select a team...', 'Open'])
    expect(container.textContent).not.toContain('via sign-up code')
    expect(container.textContent).toContain('Request a new team here')
  })
})
