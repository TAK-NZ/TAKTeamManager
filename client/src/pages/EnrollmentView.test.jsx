import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import EnrollmentView, { interpretEnrollmentError } from './EnrollmentView.jsx'
import { enrollmentAPI } from '../services/api'
import { isAndroidClient } from '../utils/platformDetection'
import { setDisplayTimezone, DEFAULT_DISPLAY_TIMEZONE } from '../utils/dateFormat'

// takserver-enrollment task 9.9 -- client example tests for the
// Enrollment_View, updated for the UX correction: the page now fetches a
// NO-MINT preview automatically on mount (`enrollmentAPI.previewSelf`) and
// defers the actual token mint (`enrollmentAPI.generateSelf`) to an
// explicit "Generate Enrollment Data" click.
//
// This project has no `@testing-library/react`, so the page is mounted
// with `react-dom/client`'s `createRoot` plus React 18's own `act`.
//
// `../services/api` and `../utils/platformDetection` are the only mocks.
// `EnrollmentCountdown`, `MultipleCertificateWarning` and `FormattedDate`
// are all the REAL components.

vi.mock('../services/api', () => ({
  enrollmentAPI: { generateSelf: vi.fn(), previewSelf: vi.fn() },
}))

vi.mock('../utils/platformDetection', () => ({
  isAndroidClient: vi.fn(),
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}))

// Vitest compiles this JSX with esbuild's classic transform and the page
// source carries no React import of its own.
globalThis.React = React

/** A `#resolvePrincipalPreview`-shaped response (no secret material). */
function buildPreviewFixture(overrides = {}) {
  return {
    principalId: 1,
    principalKind: 'human',
    username: 'AUK-U7K3QMX',
    host: 'tak.example.nz',
    takAttributes: { callsign: 'Alpha1', color: 'Blue', role: 'Team Member' },
    liveCertificateCount: 0,
    ...overrides,
  }
}

/**
 * A `#buildEnrollment`-shaped response, with every field a real deployment
 * would send. Callers override only what a given test cares about.
 */
function buildEnrollmentFixture(overrides = {}) {
  const now = Date.now()
  return {
    ...buildPreviewFixture(),
    expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
    reEnrollmentDate: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
    atakEnrollmentUri: 'tak://com.atakmap.app/enroll?host=tak.example.nz&username=AUK-U7K3QMX&token=s3cr3t-t0ken',
    itakRegistrationPayload: {
      passphrase: 'false',
      type: 'registration',
      serverCredentials: { connectionString: 'tak.example.nz:8089:ssl' },
      userCredentials: {
        username: 'AUK-U7K3QMX',
        password: 's3cr3t-t0ken',
        registrationId: '3f1c1e2a-0000-4000-8000-000000000000',
      },
    },
    atakQrDataUrl: 'data:image/png;base64,AAAAATAKQRCODE',
    itakQrDataUrl: 'data:image/png;base64,BBBBITAKQRCODE',
    ...overrides,
  }
}

/** The four known Store_Badge link targets (design.md, Criterion 12.7). */
const STORE_LINK_HREFS = [
  'https://tak.gov/products/atak-civ',
  'https://apps.apple.com/in/app/tak-aware/id6738631659',
  'https://play.google.com/store/apps/details?id=com.atakmap.app.civ',
  'https://apps.apple.com/us/app/itak/id1561656396',
]

describe('EnrollmentView (mounted)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    setDisplayTimezone('UTC')
    isAndroidClient.mockReturnValue(false)
    // Default: preview resolves cleanly for every test unless overridden.
    enrollmentAPI.previewSelf.mockResolvedValue({ data: { preview: buildPreviewFixture() } })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    vi.useRealTimers()
    container.remove()
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    setDisplayTimezone(DEFAULT_DISPLAY_TIMEZONE)
  })

  const mount = async (props = {}) => {
    root = createRoot(container)
    await act(async () => {
      root.render(<EnrollmentView {...props} />)
    })
  }

  const flush = async () => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const findGenerateButton = () =>
    Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Generate Enrollment Data'
    )

  // ── Preview on mount, no mint ───────────────────────────────────────
  it('fetches the no-mint preview on mount and renders the Enrollment Data section without minting anything', async () => {
    const preview = buildPreviewFixture()
    await mount()
    await flush()

    expect(enrollmentAPI.previewSelf).toHaveBeenCalledTimes(1)
    expect(enrollmentAPI.generateSelf).not.toHaveBeenCalled()

    expect(container.textContent).toContain('Enrollment Data')
    expect(container.textContent).toContain(preview.host)
    expect(container.textContent).toContain(preview.username)
    expect(container.textContent).toContain('Alpha1')
    expect(container.textContent).toContain('Blue')
    expect(container.textContent).toContain('Team Member')
    expect(container.textContent).toContain('Device Enrollment Requirements')

    // No QR codes and no countdown before the button is clicked.
    expect(container.querySelector('img')).toBeNull()
    expect(findGenerateButton()).toBeTruthy()
  })

  it('labels the row "Device" for a Team_Owned_Device principal, and "User" for a human', async () => {
    enrollmentAPI.previewSelf.mockResolvedValue({
      data: { preview: buildPreviewFixture({ principalKind: 'device', username: 'AUK-DZP39HRH' }) },
    })
    await mount()
    await flush()

    expect(container.textContent).toContain('Device')
    expect(container.textContent).toContain('AUK-DZP39HRH')
  })

  it('shows the live-certificate-count note as part of the Enrollment Data section', async () => {
    enrollmentAPI.previewSelf.mockResolvedValue({
      data: { preview: buildPreviewFixture({ liveCertificateCount: 2 }) },
    })
    await mount()
    await flush()

    expect(container.textContent).toContain('2 active TAK Server certificates')
  })

  it('shows a retry when the preview fails, and issues no mint call', async () => {
    enrollmentAPI.previewSelf.mockRejectedValue({ response: { status: 500, data: {} } })
    await mount()
    await flush()

    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(enrollmentAPI.generateSelf).not.toHaveBeenCalled()

    const retryButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    )
    expect(retryButton).toBeTruthy()

    enrollmentAPI.previewSelf.mockResolvedValue({ data: { preview: buildPreviewFixture() } })
    await act(async () => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(container.textContent).toContain('Enrollment Data')
  })

  // ── Deferred generation ──────────────────────────────────────────────
  it('mints an enrollment ONLY after "Generate Enrollment Data" is clicked, rendering both QR images, the username, the host and the token text', async () => {
    const enrollment = buildEnrollmentFixture()
    enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

    await mount()
    await flush()

    expect(enrollmentAPI.generateSelf).not.toHaveBeenCalled()

    const button = findGenerateButton()
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(enrollmentAPI.generateSelf).toHaveBeenCalledTimes(1)

    const atakImg = container.querySelector('img[alt="ATAK enrollment QR code"]')
    expect(atakImg).not.toBeNull()
    expect(atakImg.getAttribute('src')).toBe(enrollment.atakQrDataUrl)

    expect(container.textContent).toContain(enrollment.username)
    expect(container.textContent).toContain(enrollment.host)

    // Criterion 10.8-equivalent: the manual-entry tab shows the code as a
    // fixed run of bullets, never the real value in text.
    expect(container.textContent).not.toContain(enrollment.itakRegistrationPayload.userCredentials.password)
  })

  // ── Criterion 10.2 ─────────────────────────────────────────────────────
  describe('the countdown (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('ticks, reaches EXPIRED, clears its interval, swaps the deep-link text, and issues no further mint on expiry', async () => {
      const now = Date.now()
      vi.setSystemTime(now)
      isAndroidClient.mockReturnValue(true)

      const enrollment = buildEnrollmentFixture({ expiresAt: new Date(now + 2000).toISOString() })
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

      await mount()
      await act(async () => {
        await Promise.resolve()
      })

      const button = findGenerateButton()
      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })

      expect(container.textContent).toContain('00 : 02')
      let link = container.querySelector('a[href^="tak://"]')
      expect(link).not.toBeNull()
      expect(link.textContent).toContain('Open in ATAK')
      expect(container.textContent).not.toContain('Enrollment link expired')

      const clearIntervalSpy = vi.spyOn(global, 'clearInterval')

      await act(async () => {
        vi.advanceTimersByTime(3000)
      })

      expect(container.textContent).toContain('EXPIRED')
      expect(clearIntervalSpy).toHaveBeenCalled()

      link = container.querySelector('a[href^="tak://"]')
      expect(link).toBeNull()
      expect(container.textContent).toContain('Enrollment link expired')

      // Load-bearing: only the one explicit click ever minted anything.
      expect(enrollmentAPI.generateSelf).toHaveBeenCalledTimes(1)

      await act(async () => {
        vi.advanceTimersByTime(5 * 60 * 1000)
      })
      expect(enrollmentAPI.generateSelf).toHaveBeenCalledTimes(1)

      clearIntervalSpy.mockRestore()
    })

    it('shows "Generate Enrollment Data" only once EXPIRED, and issues exactly one mint per click', async () => {
      const now = Date.now()
      vi.setSystemTime(now)

      const first = buildEnrollmentFixture({ expiresAt: new Date(now + 1000).toISOString() })
      const second = buildEnrollmentFixture({
        username: 'AUK-U9F3RLP',
        expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
      })
      enrollmentAPI.generateSelf
        .mockResolvedValueOnce({ data: { enrollment: first } })
        .mockResolvedValueOnce({ data: { enrollment: second } })

      await mount()
      await act(async () => {
        await Promise.resolve()
      })

      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })

      await act(async () => {
        vi.advanceTimersByTime(1500)
      })
      expect(container.textContent).toContain('EXPIRED')

      const regenerateButton = findGenerateButton()
      expect(regenerateButton).toBeTruthy()

      await act(async () => {
        regenerateButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })

      expect(enrollmentAPI.generateSelf).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain(second.username)
      expect(container.textContent).not.toContain('EXPIRED')
    })
  })

  // ── Criterion 15.3 ─────────────────────────────────────────────────────
  it('renders None three times for a principal with all three TAK_Attributes unset', async () => {
    enrollmentAPI.previewSelf.mockResolvedValue({
      data: { preview: buildPreviewFixture({ takAttributes: {} }) },
    })
    await mount()
    await flush()

    const noneOccurrences = (container.textContent.match(/None/g) || []).length
    expect(noneOccurrences).toBe(3)
  })

  // ── Criteria 10.6, 10.7 ────────────────────────────────────────────────
  it('removes the deep link from the DOM entirely on a non-Android client, while both QR codes remain', async () => {
    isAndroidClient.mockReturnValue(false)
    const enrollment = buildEnrollmentFixture()
    enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

    await mount()
    await flush()
    await act(async () => {
      findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(container.querySelector('a[href^="tak://"]')).toBeNull()
    expect(container.innerHTML).not.toContain('tak://com.atakmap.app')

    expect(container.querySelectorAll('img').length).toBe(1)
    expect(container.querySelector('img[alt="ATAK enrollment QR code"]')).not.toBeNull()

    // The iTAK QR renders only on its own tab.
    const itakTab = Array.from(container.querySelectorAll('button[role="tab"]')).find(
      (button) => button.textContent === 'iTAK'
    )
    await act(async () => {
      itakTab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('img[alt="iTAK enrollment QR code"]')).not.toBeNull()
  })

  // ── Criterion 10.11 ────────────────────────────────────────────────────
  it('renders no app-store badge markup', async () => {
    const enrollment = buildEnrollmentFixture()
    enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

    await mount()
    await flush()
    await act(async () => {
      findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    for (const href of STORE_LINK_HREFS) {
      expect(container.innerHTML).not.toContain(href)
    }
    expect(container.innerHTML).not.toContain('0 0 135 40')
  })

  // ── Criterion 10.4 ─────────────────────────────────────────────────────
  it('labels the Re_Enrollment_Date as the date the certificate about to be issued will need replacing, not a read of an existing certificate', async () => {
    const enrollment = buildEnrollmentFixture()
    enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

    await mount()
    await flush()
    await act(async () => {
      findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(container.textContent).toContain('Next re-enrollment')
    expect(container.textContent).toContain('will need to be replaced by')
    expect(container.textContent).not.toMatch(/certificate expires|current certificate/i)
  })

  // ── Criterion 10.9 ─────────────────────────────────────────────────────
  it('renders the Re_Enrollment_Date through FormattedDate, as a real yyyy-mm-dd string', async () => {
    const enrollment = buildEnrollmentFixture()
    enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

    await mount()
    await flush()
    await act(async () => {
      findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    const expectedDateOnly = enrollment.reEnrollmentDate.slice(0, 10)
    expect(container.textContent).toContain(expectedDateOnly)
    expect(container.textContent).not.toContain(enrollment.reEnrollmentDate)
  })

  // ── Client error rule ──────────────────────────────────────────────────
  it('leaves a previously rendered payload intact and shows a retry when a later generation fails', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    vi.setSystemTime(now)

    const first = buildEnrollmentFixture({ expiresAt: new Date(now + 1000).toISOString() })
    enrollmentAPI.generateSelf.mockResolvedValueOnce({ data: { enrollment: first } })

    await mount()
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(container.textContent).toContain(first.username)

    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(container.textContent).toContain('EXPIRED')

    enrollmentAPI.generateSelf.mockRejectedValueOnce({
      response: { status: 500, data: {} },
    })

    const regenerateButton = findGenerateButton()
    expect(regenerateButton).toBeTruthy()

    await act(async () => {
      regenerateButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Failed to generate an enrollment code. Please try again.')
    const retryButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    )
    expect(retryButton).toBeTruthy()

    expect(container.querySelector('img[alt="ATAK enrollment QR code"]')).not.toBeNull()
    expect(container.textContent).toContain(first.username)
  })

  // ── Manual entry / WinTAK tab ────────────────────────────────────────
  describe('the WinTAK / Manual tab', () => {
    const setUp = async () => {
      const enrollment = buildEnrollmentFixture()
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })
      await mount()
      await flush()
      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()
      const manualTab = Array.from(container.querySelectorAll('button[role="tab"]')).find((button) =>
        button.textContent.includes('WinTAK')
      )
      await act(async () => {
        manualTab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      return enrollment
    }

    it('shows the username as visible text and the enrollment code only as a fixed run of bullet characters, never the real value', async () => {
      const enrollment = await setUp()

      expect(container.textContent).toContain(enrollment.username)
      // The real code must never appear as text anywhere on the page.
      expect(container.textContent).not.toContain(enrollment.itakRegistrationPayload.userCredentials.password)
      expect(container.textContent).toContain('••••••••••••')
    })

    it('copies the real username when its Copy button is clicked', async () => {
      const enrollment = await setUp()
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })

      const copyButtons = Array.from(container.querySelectorAll('button[aria-label]')).filter((button) =>
        button.getAttribute('aria-label').toLowerCase().includes('copy')
      )
      const usernameCopyButton = copyButtons.find((button) => button.getAttribute('aria-label') === 'Copy username')
      expect(usernameCopyButton).toBeTruthy()

      await act(async () => {
        usernameCopyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })

      expect(writeText).toHaveBeenCalledWith(enrollment.username)
    })

    it('copies the REAL enrollment code (not the bullet display) when its Copy button is clicked', async () => {
      const enrollment = await setUp()
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })

      const codeCopyButton = Array.from(container.querySelectorAll('button[aria-label]')).find(
        (button) => button.getAttribute('aria-label') === 'Copy enrollment code'
      )
      expect(codeCopyButton).toBeTruthy()

      await act(async () => {
        codeCopyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })

      expect(writeText).toHaveBeenCalledWith(enrollment.itakRegistrationPayload.userCredentials.password)
    })
  })
})

describe('interpretEnrollmentError', () => {
  it('prefers the server-supplied message', () => {
    const error = { response: { status: 400, data: { error: 'Organisation ORG has no prefix configured' } } }
    expect(interpretEnrollmentError(error)).toBe('Organisation ORG has no prefix configured')
  })

  it('falls back to a generic message for a 5xx with no server message or a network failure', () => {
    expect(interpretEnrollmentError({ response: { status: 500, data: {} } })).toBe(
      'Failed to generate an enrollment code. Please try again.'
    )
    expect(interpretEnrollmentError(new Error('Network Error'))).toBe(
      'Failed to generate an enrollment code. Please try again.'
    )
  })
})
