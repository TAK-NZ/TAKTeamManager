import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import EnrollmentView, { interpretEnrollmentError } from './EnrollmentView.jsx'
import { enrollmentAPI } from '../services/api'
import { isAndroidClient } from '../utils/platformDetection'
import { setDisplayTimezone, DEFAULT_DISPLAY_TIMEZONE } from '../utils/dateFormat'

// takserver-enrollment task 9.9 -- client example tests for the
// Enrollment_View (Requirements 10.1, 10.2, 10.4, 10.6, 10.7, 10.8, 10.9,
// 10.11, 15.3).
//
// This project has no `@testing-library/react` (absent from
// `client/package.json` and from `client/node_modules`) and no dependency is
// added for this task, so the page is mounted with `react-dom/client`'s
// `createRoot` plus React 18's own `act`, following the pattern
// `src/components/TransferMemberDialog.test.jsx` established and
// `src/components/EnrollmentCountdown.test.jsx` (task 9.3) already uses for
// this same feature.
//
// `../services/api` and `../utils/platformDetection` are the only mocks: the
// network boundary and the one piece of client-side platform detection this
// view depends on. `EnrollmentCountdown`, `MultipleCertificateWarning` and
// `FormattedDate` are all the REAL components -- in particular `FormattedDate`
// is real so that Criterion 10.9's "dates render through FormattedDate" is a
// checked fact (a real yyyy-mm-dd string in the DOM) rather than something a
// mock invented. `client/src/utils/dateFormatConsumers.test.js` is the
// structural guard that FormattedDate stays the ONLY consumer of the
// Date_Format_Helpers; this file does not duplicate that guard -- it only has
// to import `FormattedDate` (which it does, unconditionally) rather than
// `formatDate`/`formatDateTime` directly, and that guard's own suite is what
// is run to confirm the one-entry allow-list is unaffected (see task 9.10).

vi.mock('../services/api', () => ({
  enrollmentAPI: { generateSelf: vi.fn() },
}))

vi.mock('../utils/platformDetection', () => ({
  isAndroidClient: vi.fn(),
}))

// Vitest compiles this JSX with esbuild's classic transform and the page
// source carries no React import of its own.
globalThis.React = React

/**
 * A `#buildEnrollment`-shaped response, with every field a real deployment
 * would send. Callers override only what a given test cares about.
 */
function buildEnrollmentFixture(overrides = {}) {
  const now = Date.now()
  return {
    principalId: 1,
    principalKind: 'human',
    username: 'AUK-U7K3QMX',
    host: 'tak.example.nz',
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
    takAttributes: { callsign: 'Alpha1', color: 'Blue', role: 'Team Member' },
    liveCertificateCount: 0,
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
    // Deterministic zone for the Re_Enrollment_Date assertions -- matches the
    // `Users.test.jsx` convention.
    setDisplayTimezone('UTC')
    // Default: not Android, so the deep link is absent unless a test opts in.
    isAndroidClient.mockReturnValue(false)
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

  /** Flushes the mount-time `fetchEnrollment()` call without advancing any clock. */
  const flush = async () => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  // ── Criteria 10.1, 10.8 ────────────────────────────────────────────────
  it('renders both QR images, the username, the host and the token text', async () => {
    const enrollment = buildEnrollmentFixture()
    enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

    await mount()
    await flush()

    const atakImg = container.querySelector('img[alt="ATAK enrollment QR code"]')
    const itakImg = container.querySelector('img[alt="iTAK enrollment QR code"]')
    expect(atakImg).not.toBeNull()
    expect(atakImg.getAttribute('src')).toBe(enrollment.atakQrDataUrl)
    expect(itakImg).not.toBeNull()
    expect(itakImg.getAttribute('src')).toBe(enrollment.itakQrDataUrl)

    // The username appears (top summary + manual-entry block); the host
    // appears in the top summary.
    expect(container.textContent).toContain(enrollment.username)
    expect(container.textContent).toContain(enrollment.host)

    // Criterion 10.8: the Enrollment_Token is rendered as TEXT so a device
    // that cannot scan can be enrolled manually.
    expect(container.textContent).toContain(enrollment.itakRegistrationPayload.userCredentials.password)
  })

  // ── Criterion 10.2 ─────────────────────────────────────────────────────
  describe('the countdown (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('ticks, reaches EXPIRED, clears its interval, swaps the deep-link text, and issues no fetch on expiry', async () => {
      const now = Date.now()
      vi.setSystemTime(now)
      isAndroidClient.mockReturnValue(true)

      const enrollment = buildEnrollmentFixture({ expiresAt: new Date(now + 2000).toISOString() })
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

      await mount()
      await act(async () => {
        await Promise.resolve()
      })

      // Ticking: the live MM : SS value is present before expiry.
      expect(container.textContent).toContain('00 : 02')
      // Android forced true, not yet expired: the deep link is a live <a>.
      let link = container.querySelector('a[href^="tak://"]')
      expect(link).not.toBeNull()
      expect(link.textContent).toContain('Open in ATAK')
      expect(container.textContent).not.toContain('Enrollment link expired')

      const clearIntervalSpy = vi.spyOn(global, 'clearInterval')

      await act(async () => {
        vi.advanceTimersByTime(3000)
      })

      expect(container.textContent).toContain('EXPIRED')
      // The interval is cleared the moment the terminal state is reached.
      expect(clearIntervalSpy).toHaveBeenCalled()

      // The deep link's TEXT is replaced with the expired message -- and it
      // is no longer a clickable <a>, since an expired token's deep link
      // resolves nowhere.
      link = container.querySelector('a[href^="tak://"]')
      expect(link).toBeNull()
      expect(container.textContent).toContain('Enrollment link expired')

      // The load-bearing assertion: an idle open tab past expiry issues NO
      // further fetch. Only the one mount-time call ever happened.
      expect(enrollmentAPI.generateSelf).toHaveBeenCalledTimes(1)

      // Advance well past expiry again -- still no additional fetch.
      await act(async () => {
        vi.advanceTimersByTime(5 * 60 * 1000)
      })
      expect(enrollmentAPI.generateSelf).toHaveBeenCalledTimes(1)

      clearIntervalSpy.mockRestore()
    })

    // ── "Generate a new code" (bullet 3) ──────────────────────────────
    it('shows "Generate a new code" only once EXPIRED, and issues exactly one request per click', async () => {
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

      const findButton = () =>
        Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent === 'Generate a new code'
        )

      // Not yet expired: no regenerate button anywhere on the page.
      expect(findButton()).toBeUndefined()

      await act(async () => {
        vi.advanceTimersByTime(1500)
      })
      expect(container.textContent).toContain('EXPIRED')

      const button = findButton()
      expect(button).toBeTruthy()

      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })

      // Exactly one additional request for the one click: mount (1) + click (1).
      expect(enrollmentAPI.generateSelf).toHaveBeenCalledTimes(2)
      // The freshly minted code is rendered and is not itself expired.
      expect(container.textContent).toContain(second.username)
      expect(container.textContent).not.toContain('EXPIRED')
      expect(findButton()).toBeUndefined()
    })
  })

  // ── Criterion 15.3 ─────────────────────────────────────────────────────
  it('renders None three times for a principal with all three TAK_Attributes unset', async () => {
    const enrollment = buildEnrollmentFixture({ takAttributes: {} })
    enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

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

    // Absent from the DOM, not merely hidden: no element carrying the deep
    // link's href anywhere in the markup.
    expect(container.querySelector('a[href^="tak://"]')).toBeNull()
    expect(container.innerHTML).not.toContain('tak://com.atakmap.app')

    // Both QR codes still render: they are scanned by a second device and
    // are useful on any platform.
    expect(container.querySelectorAll('img').length).toBe(2)
    expect(container.querySelector('img[alt="ATAK enrollment QR code"]')).not.toBeNull()
    expect(container.querySelector('img[alt="iTAK enrollment QR code"]')).not.toBeNull()
  })

  // ── Criterion 10.11 ────────────────────────────────────────────────────
  it('renders no app-store badge markup', async () => {
    const enrollment = buildEnrollmentFixture()
    enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

    await mount()
    await flush()

    for (const href of STORE_LINK_HREFS) {
      expect(container.innerHTML).not.toContain(href)
    }
    // The TAK_Gov_Badge's signature viewBox, if the badges were ever rendered
    // on this page by mistake.
    expect(container.innerHTML).not.toContain('0 0 135 40')
  })

  // ── Criterion 10.4 ─────────────────────────────────────────────────────
  it("labels the Re_Enrollment_Date as the date the certificate about to be issued will need replacing, not a read of an existing certificate", async () => {
    const enrollment = buildEnrollmentFixture()
    enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

    await mount()
    await flush()

    expect(container.textContent).toContain('Next re-enrollment')
    expect(container.textContent).toContain('will need to be replaced by')
    // Never phrased as a report on an existing certificate.
    expect(container.textContent).not.toMatch(/certificate expires|current certificate/i)
  })

  // ── Criterion 10.9 ─────────────────────────────────────────────────────
  it('renders the Re_Enrollment_Date through FormattedDate, as a real yyyy-mm-dd string', async () => {
    const enrollment = buildEnrollmentFixture()
    enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

    await mount()
    await flush()

    // FormattedDate renders `formatDate`'s yyyy-mm-dd string; this is real
    // output from the real component and the real date module (installed at
    // 'UTC' above), not a value a mock invented. The structural guard that
    // FormattedDate is the ONLY module permitted to import the
    // Date_Format_Helpers directly (`dateFormatConsumers.test.js`) is
    // unaffected by this page: it imports `FormattedDate`, never
    // `formatDate`/`formatDateTime`.
    const expectedDateOnly = enrollment.reEnrollmentDate.slice(0, 10)
    expect(container.textContent).toContain(expectedDateOnly)
    // The raw ISO instant itself must not leak into the rendered text.
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

    expect(container.textContent).toContain(first.username)

    // Reach EXPIRED so the "Generate a new code" affordance -- the page's
    // own trigger for a second `generate()` call -- is on screen.
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(container.textContent).toContain('EXPIRED')

    // The next generation fails.
    enrollmentAPI.generateSelf.mockRejectedValueOnce({
      response: { status: 500, data: {} },
    })

    const regenerateButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Generate a new code'
    )
    expect(regenerateButton).toBeTruthy()

    await act(async () => {
      regenerateButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    // The error and a Retry control appear, ALONGSIDE the previous payload
    // -- never in its place. `generate`'s catch branch never clears
    // `enrollment`.
    expect(container.textContent).toContain('Failed to generate an enrollment code. Please try again.')
    const retryButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    )
    expect(retryButton).toBeTruthy()

    // The previously rendered payload -- QR images, username, manual-entry
    // token -- is still fully intact.
    expect(container.querySelector('img[alt="ATAK enrollment QR code"]')).not.toBeNull()
    expect(container.querySelector('img[alt="iTAK enrollment QR code"]')).not.toBeNull()
    expect(container.textContent).toContain(first.username)
    expect(container.textContent).toContain(first.itakRegistrationPayload.userCredentials.password)
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
