import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

// Required: Vitest compiles this JSX with esbuild's classic transform and the
// page sources carry no React import of their own.
globalThis.React = React

const mockGet = vi.fn()

vi.mock('../services/api', () => ({
  signupCodesAPI: {
    get: (...args) => mockGet(...args),
    generate: vi.fn(),
    revoke: vi.fn(),
    getQr: vi.fn(),
    getPdf: vi.fn()
  }
}))
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))

import SignupCodeManager from './SignupCodeManager.jsx'

describe('SignupCodeManager — Organisation code covering sub-teams (mounted)', () => {
  let container
  let root

  async function mount(props, codeResponse) {
    if (codeResponse) {
      mockGet.mockResolvedValue({ data: codeResponse })
    } else {
      mockGet.mockRejectedValue({ response: { status: 404 } })
    }
    root = createRoot(container)
    await act(async () => {
      root.render(<SignupCodeManager teamId={1} teamName="LSAR" isAdmin {...props} />)
    })
    await act(async () => {})
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    mockGet.mockReset()
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

  const CODE = { code: 'ABCD2345', formatted: 'ABCD-2345', url: 'u', shortUrl: 's' }

  it('states in text that the code also covers sub-teams', async () => {
    await mount({ coversSubTeams: true }, CODE)
    expect(container.textContent).toContain('This code also lets people choose any sub-team that allows join requests.')
  })

  it('states that sub-teams are not offered while there is no code', async () => {
    await mount({ coversSubTeams: true }, null)
    expect(container.textContent).toContain('Sub-teams are not offered for sign-up until a code is generated.')
  })

  it('adds nothing when the Organisation does not cover its sub-teams', async () => {
    await mount({ coversSubTeams: false }, CODE)
    expect(container.textContent).not.toContain('sub-team')
    await act(async () => {})
  })

  it('warns in the revoke confirmation that sub-teams disappear until a new code exists', async () => {
    await mount({ coversSubTeams: true }, CODE)
    const revoke = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Revoke'))
    expect(revoke, 'Revoke button should exist when a code exists').toBeDefined()
    await act(async () => {
      revoke.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('Sub-teams will not be offered for sign-up at all until a new code is generated.')
  })
})
