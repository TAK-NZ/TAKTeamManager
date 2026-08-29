import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import EnrollmentView, { interpretEnrollmentError } from './EnrollmentView.jsx'
import { enrollmentAPI, configAPI } from '../services/api'
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
// `EnrollmentCountdown` and `FormattedDate` are both the REAL components.

vi.mock('../services/api', () => ({
  enrollmentAPI: { generateSelf: vi.fn(), previewSelf: vi.fn() },
  configAPI: { getPublic: vi.fn() },
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
    // Bugfix (screen-wake reload): EnrollmentView now persists a minted
    // enrollment to sessionStorage and restores it on mount. jsdom's
    // sessionStorage otherwise leaks across tests in this same file, so a
    // later test's very first mount would restore an EARLIER test's
    // leftover "minted" state instead of starting fresh at the
    // "Generate Enrollment Data" button every other test here assumes.
    sessionStorage.clear()
    // Default: preview resolves cleanly for every test unless overridden.
    enrollmentAPI.previewSelf.mockResolvedValue({ data: { preview: buildPreviewFixture() } })
    // Default: the WinTAK/Manual tab's configurable Description fetch
    // resolves to the same default the server itself falls back to,
    // unless a test overrides it.
    configAPI.getPublic.mockResolvedValue({ data: { enrollment_manual_description: 'TAK.NZ' } })
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
    sessionStorage.clear()
  })

  const mount = async (props = {}) => {
    root = createRoot(container)
    await act(async () => {
      // Wrapped in MemoryRouter: the ATAK/TAK Aware/iTAK install
      // instructions each link the word "installed" to /downloads via
      // react-router-dom's <Link>, which throws outside a Router context.
      root.render(
        <MemoryRouter>
          <EnrollmentView {...props} />
        </MemoryRouter>
      )
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

  // ── Bugfix: certificate count moved into the Enrollment Data grid,
  // colour flips from amber-on->1 to amber-only-at-0 ────────────────────
  describe('Active TAK Server Certificates field (bugfix)', () => {
    const certificateFieldValue = () => {
      const dt = Array.from(container.querySelectorAll('dt')).find(
        (element) => element.textContent === 'Active TAK Server Certificates'
      )
      return dt?.nextElementSibling
    }

    it('shows the count as its own field in the Enrollment Data section, not a separate note', async () => {
      enrollmentAPI.previewSelf.mockResolvedValue({
        data: { preview: buildPreviewFixture({ liveCertificateCount: 2 }) },
      })
      await mount()
      await flush()

      expect(container.textContent).toContain('Active TAK Server Certificates')
      const dd = certificateFieldValue()
      expect(dd).toBeTruthy()
      expect(dd.textContent).toBe('2')
      // The old standalone note phrasing must be gone entirely.
      expect(container.textContent).not.toContain('active TAK Server certificates')
    })

    it('renders green for a count of exactly 1, the ordinary single-device case', async () => {
      enrollmentAPI.previewSelf.mockResolvedValue({
        data: { preview: buildPreviewFixture({ liveCertificateCount: 1 }) },
      })
      await mount()
      await flush()

      const dd = certificateFieldValue()
      expect(dd.textContent).toBe('1')
      expect(dd.className).toContain('text-green-700')
      expect(dd.className).not.toContain('text-amber-700')
    })

    it('renders green for a count greater than 1 -- multiple live certificates is normal here, not a warning', async () => {
      enrollmentAPI.previewSelf.mockResolvedValue({
        data: { preview: buildPreviewFixture({ liveCertificateCount: 3 }) },
      })
      await mount()
      await flush()

      const dd = certificateFieldValue()
      expect(dd.textContent).toBe('3')
      expect(dd.className).toContain('text-green-700')
      expect(dd.className).not.toContain('text-amber-700')
    })

    it('renders amber ONLY for a count of exactly 0', async () => {
      enrollmentAPI.previewSelf.mockResolvedValue({
        data: { preview: buildPreviewFixture({ liveCertificateCount: 0 }) },
      })
      await mount()
      await flush()

      const dd = certificateFieldValue()
      expect(dd.textContent).toBe('0')
      expect(dd.className).toContain('text-amber-700')
      expect(dd.className).not.toContain('text-green-700')
    })

    it('renders the None fallback in neutral gray for a missing/invalid count, never green or amber', async () => {
      enrollmentAPI.previewSelf.mockResolvedValue({
        data: { preview: buildPreviewFixture({ liveCertificateCount: undefined }) },
      })
      await mount()
      await flush()

      const dd = certificateFieldValue()
      expect(dd.textContent).toBe('None')
      expect(dd.className).not.toContain('text-green-700')
      expect(dd.className).not.toContain('text-amber-700')
    })
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
      expect(link.textContent).toContain('Enroll this device now')
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

  // ── Bugfix: persists across a screen-wake reload (sessionStorage) ──────
  describe('minted enrollment persists across a reload (screen-wake bugfix)', () => {
    it('restores a still-live minted enrollment on a fresh mount, with no new mint call', async () => {
      const enrollment = buildEnrollmentFixture()
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })
      await mount()
      await flush()
      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()
      expect(enrollmentAPI.generateSelf).toHaveBeenCalledTimes(1)

      // Simulate the reload: unmount and mount an entirely NEW instance,
      // exactly as a real page reload would recreate the whole component
      // tree from scratch. sessionStorage (unlike React state) survives
      // this, which is the whole point of the fix.
      await act(async () => {
        root.unmount()
      })
      container.remove()
      container = document.createElement('div')
      document.body.appendChild(container)

      await mount()
      await flush()

      // The QR code and username are back, with NO further mint call --
      // restoring from sessionStorage must never mint a second token.
      expect(container.querySelector('img[alt="ATAK enrollment QR code"]')).not.toBeNull()
      expect(container.textContent).toContain(enrollment.username)
      expect(enrollmentAPI.generateSelf).toHaveBeenCalledTimes(1)
      expect(findGenerateButton()).toBeUndefined()
    })

    it('does NOT restore an already-expired stored enrollment -- shows "Generate Enrollment Data" instead', async () => {
      const now = Date.now()
      const enrollment = buildEnrollmentFixture({ expiresAt: new Date(now - 1000).toISOString() })
      // Write directly, bypassing the component, to simulate a stored
      // value that has since lapsed (e.g. the tab sat backgrounded for
      // longer than the token's lifetime before reloading).
      sessionStorage.setItem('enrollmentView.selfService.enrollment', JSON.stringify(enrollment))

      await mount()
      await flush()

      expect(findGenerateButton()).toBeTruthy()
      expect(container.querySelector('img[alt="ATAK enrollment QR code"]')).toBeNull()
    })

    it('discards a restored enrollment whose principalId does not match the freshly fetched preview (different signed-in identity)', async () => {
      const staleEnrollment = buildEnrollmentFixture({
        principalId: 999,
        username: 'AUK-STALE-USER',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      })
      sessionStorage.setItem('enrollmentView.selfService.enrollment', JSON.stringify(staleEnrollment))
      // The live preview belongs to a DIFFERENT principalId (default
      // fixture's principalId is 1) -- e.g. a different user signed into
      // the same browser tab after the first user's enrollment was stored.
      enrollmentAPI.previewSelf.mockResolvedValue({ data: { preview: buildPreviewFixture({ principalId: 1 }) } })

      await mount()
      await flush()

      expect(container.textContent).not.toContain(staleEnrollment.username)
      expect(container.querySelector('img[alt="ATAK enrollment QR code"]')).toBeNull()
      expect(findGenerateButton()).toBeTruthy()
      // The mismatched value must also be cleared from storage, not just
      // hidden from this render.
      expect(sessionStorage.getItem('enrollmentView.selfService.enrollment')).toBeNull()
    })

    it('never reads or writes sessionStorage when the caller supplies its own fetchEnrollment/fetchPreview (e.g. TeamDetail.jsx\'s device-enrollment modal)', async () => {
      const customEnrollment = buildEnrollmentFixture({ username: 'AUK-DEVICE-XYZ' })
      const customFetchPreview = vi.fn().mockResolvedValue(buildPreviewFixture({ username: 'AUK-DEVICE-XYZ' }))
      const customFetchEnrollment = vi.fn().mockResolvedValue(customEnrollment)

      await mount({ fetchEnrollment: customFetchEnrollment, fetchPreview: customFetchPreview })
      await flush()
      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()

      expect(customFetchEnrollment).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain('AUK-DEVICE-XYZ')
      // The self-service key must never be written by a caller-supplied
      // fetcher pair -- a device-enrollment modal for one device, closed
      // and reopened for a DIFFERENT device in the same tab, must never
      // resurrect the first device's QR codes.
      expect(sessionStorage.getItem('enrollmentView.selfService.enrollment')).toBeNull()
    })

    it('clears the stored enrollment once the countdown reaches EXPIRED, so a later reload does not restore a spent token', async () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)

      const enrollment = buildEnrollmentFixture({ expiresAt: new Date(now + 1000).toISOString() })
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

      await mount()
      await act(async () => {
        await Promise.resolve()
      })
      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })

      expect(sessionStorage.getItem('enrollmentView.selfService.enrollment')).not.toBeNull()

      await act(async () => {
        vi.advanceTimersByTime(1500)
      })

      expect(container.textContent).toContain('EXPIRED')
      expect(sessionStorage.getItem('enrollmentView.selfService.enrollment')).toBeNull()
    })
  })

  // ── The ATAK direct-enroll shortcut (Android-only, above the QR steps) ──
  describe('the ATAK direct-enroll shortcut', () => {
    it('shows the explanation, "Enroll this device now" button and "OR" divider, all BEFORE the first QR-scan bullet, on Android', async () => {
      isAndroidClient.mockReturnValue(true)
      const enrollment = buildEnrollmentFixture()
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

      await mount()
      await flush()
      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()

      const tabPane = container.querySelector('[role="tablist"]').nextElementSibling
      expect(tabPane.textContent).toContain(
        'Already have ATAK installed on this Android device? You can directly enroll this device.'
      )

      const link = container.querySelector('a[href^="tak://"]')
      expect(link).not.toBeNull()
      expect(link.textContent).toBe('Enroll this device now')

      expect(tabPane.textContent).toContain('OR')

      // Ordering: the shortcut's explanation, its button, and the "OR"
      // divider must all appear before the first QR-scan bullet's text in
      // document order -- this is the whole point of the change (the fast
      // path is seen FIRST, not after already reading past the QR steps).
      const fullText = tabPane.textContent
      const explanationIndex = fullText.indexOf('Already have ATAK installed')
      const orIndex = fullText.indexOf('OR')
      const firstBulletIndex = fullText.indexOf('ATAK must already be installed')
      expect(explanationIndex).toBeGreaterThanOrEqual(0)
      expect(orIndex).toBeGreaterThan(explanationIndex)
      expect(firstBulletIndex).toBeGreaterThan(orIndex)
    })

    it('is entirely absent on a non-Android client -- no explanation, no button, no OR divider', async () => {
      isAndroidClient.mockReturnValue(false)
      const enrollment = buildEnrollmentFixture()
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

      await mount()
      await flush()
      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()

      const tabPane = container.querySelector('[role="tablist"]').nextElementSibling
      expect(tabPane.textContent).not.toContain('Already have ATAK installed')
      expect(tabPane.textContent).not.toContain('Enroll this device now')
      expect(container.querySelector('a[href^="tak://"]')).toBeNull()
    })

    it('shows "Enrollment link expired" instead of the button once the countdown expires, still on Android', async () => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)
      isAndroidClient.mockReturnValue(true)

      const enrollment = buildEnrollmentFixture({ expiresAt: new Date(now + 1000).toISOString() })
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })

      await mount()
      await act(async () => {
        await Promise.resolve()
      })
      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })

      expect(container.querySelector('a[href^="tak://"]')).not.toBeNull()

      await act(async () => {
        vi.advanceTimersByTime(1500)
      })

      expect(container.querySelector('a[href^="tak://"]')).toBeNull()
      const tabPane = container.querySelector('[role="tablist"]').nextElementSibling
      expect(tabPane.textContent).toContain('Enrollment link expired')
      // The explanation and "OR" divider remain -- only the button itself
      // swaps for the expired message.
      expect(tabPane.textContent).toContain('Already have ATAK installed')
    })
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

  // ── Bugfix: ATAK and TAK Aware split into distinct tabs ────────────────
  describe('the ATAK and TAK Aware tabs are distinct (bugfix)', () => {
    // Substring match, not exact equality: below `sm` and at `sm:` and up
    // labels are both PRESENT in jsdom at once (`sm:hidden`/`hidden
    // sm:inline` pairs -- no real CSS applies in this test environment, so
    // both text nodes render and concatenate in `textContent`), matching
    // this file's and this codebase's existing convention for the same
    // shortened-label pattern (see the pre-existing WinTAK tab lookup
    // below, `.textContent.includes('WinTAK')`).
    const findTab = (substring) =>
      Array.from(container.querySelectorAll('button[role="tab"]')).find((button) =>
        button.textContent.includes(substring)
      )
    const tabPane = () => container.querySelector('[role="tablist"]').nextElementSibling

    it('renders four separate tabs -- ATAK, TAK Aware, iTAK, WinTAK / Manual -- not a combined ATAK/TAK Aware tab', async () => {
      const enrollment = buildEnrollmentFixture()
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })
      await mount()
      await flush()
      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()

      const tabs = Array.from(container.querySelectorAll('button[role="tab"]'))
      expect(tabs).toHaveLength(4)
      expect(findTab('ATAK')).toBeTruthy()
      expect(findTab('TAK Aware')).toBeTruthy()
      expect(findTab('iTAK')).toBeTruthy()
      expect(findTab('WinTAK')).toBeTruthy()
      // The two used to share one combined tab -- this exact joined phrase
      // must no longer appear anywhere.
      expect(container.textContent).not.toContain('ATAK / TAK Aware')
    })

    it('shows the ATAK QR code and ATAK-only instructions on the ATAK tab, with no TAK-Aware-specific instructions present', async () => {
      const enrollment = buildEnrollmentFixture()
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })
      await mount()
      await flush()
      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()

      expect(container.querySelector('img[alt="ATAK enrollment QR code"]')).not.toBeNull()
      // Scoped to the content PANE below the tab strip, not the whole
      // container -- the tab strip itself legitimately contains the text
      // "TAK Aware" as its own tab's label.
      expect(tabPane().textContent).toContain('ATAK must already be installed')
      expect(tabPane().textContent).not.toContain('TAK Aware')
    })

    it('shows the SAME QR image (atakQrDataUrl) and TAK-Aware-only instructions on the TAK Aware tab', async () => {
      const enrollment = buildEnrollmentFixture()
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })
      await mount()
      await flush()
      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()

      await act(async () => {
        findTab('TAK Aware').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      const img = container.querySelector('img[alt="TAK Aware enrollment QR code"]')
      expect(img).not.toBeNull()
      expect(img.getAttribute('src')).toBe(enrollment.atakQrDataUrl)
      expect(tabPane().textContent).toContain('TAK Aware must already be installed')
      // The ATAK-tab-only camera-app instruction must not leak onto this tab.
      expect(tabPane().textContent).not.toContain('open your camera app')
    })

    it('links the word "installed" to /downloads on the ATAK, TAK Aware and iTAK tabs', async () => {
      const enrollment = buildEnrollmentFixture()
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })
      await mount()
      await flush()
      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()

      const installedLinkIn = () =>
        Array.from(tabPane().querySelectorAll('a')).find((a) => a.textContent === 'installed')

      // ATAK tab (already active after generate).
      let link = installedLinkIn()
      expect(link).toBeTruthy()
      expect(link.getAttribute('href')).toBe('/downloads')

      await act(async () => {
        findTab('TAK Aware').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      link = installedLinkIn()
      expect(link).toBeTruthy()
      expect(link.getAttribute('href')).toBe('/downloads')

      await act(async () => {
        findTab('iTAK').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      link = installedLinkIn()
      expect(link).toBeTruthy()
      expect(link.getAttribute('href')).toBe('/downloads')
    })

    it('renders the iTAK version requirement as the first bullet, not a separate "Note:" paragraph', async () => {
      const enrollment = buildEnrollmentFixture()
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })
      await mount()
      await flush()
      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()

      await act(async () => {
        findTab('iTAK').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(tabPane().textContent).not.toContain('Note:')
      const items = Array.from(tabPane().querySelectorAll('li'))
      expect(items.length).toBeGreaterThan(0)
      expect(items[0].textContent).toContain('iTAK version 2.12.3 or later must already be installed')
    })

    it('renders an OS logo <svg> in front of every one of the four tab labels', async () => {
      const enrollment = buildEnrollmentFixture()
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })
      await mount()
      await flush()
      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()

      for (const substring of ['ATAK', 'TAK Aware', 'iTAK', 'WinTAK']) {
        const tab = findTab(substring)
        expect(tab, `no tab found containing "${substring}"`).toBeTruthy()
        expect(tab.querySelector('svg'), `tab containing "${substring}" has no logo`).not.toBeNull()
      }
    })

    // Bugfix (twice regressed): a single non-wrapping row either
    // truncated "TAK Aware" to "Aware" to fit a phone width, or (when
    // fixed with `overflow-x-auto`) produced a spurious scrollbar on
    // desktop where nothing needed scrolling. The tab strip is now a 2x2
    // grid below `sm` (never abbreviates) and a plain flex row at `sm:`
    // and up with no `overflow-x-auto` anywhere.
    it('renders the "TAK Aware" tab label in full, never abbreviated to "Aware"', async () => {
      const enrollment = buildEnrollmentFixture()
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })
      await mount()
      await flush()
      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()

      const takAwareTab = Array.from(container.querySelectorAll('button[role="tab"]')).find((button) =>
        button.textContent.includes('TAK Aware')
      )
      expect(takAwareTab).toBeTruthy()
      // The full phrase "TAK Aware" is present verbatim, at every width --
      // there is no separate "Aware"-alone rendering hidden behind a
      // responsive class pair the way the tab labels used to abbreviate.
      expect(takAwareTab.textContent).toBe('TAK Aware')
    })

    it('the tab strip carries no overflow-x-auto class (the spurious-desktop-scrollbar regression)', async () => {
      const enrollment = buildEnrollmentFixture()
      enrollmentAPI.generateSelf.mockResolvedValue({ data: { enrollment } })
      await mount()
      await flush()
      await act(async () => {
        findGenerateButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()

      const tablist = container.querySelector('[role="tablist"]')
      expect(tablist).toBeTruthy()
      expect(tablist.className).not.toContain('overflow-x-auto')
    })
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

    it('copies the REAL password (not the bullet display) when its Copy button is clicked', async () => {
      const enrollment = await setUp()
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })

      const codeCopyButton = Array.from(container.querySelectorAll('button[aria-label]')).find(
        (button) => button.getAttribute('aria-label') === 'Copy password'
      )
      expect(codeCopyButton).toBeTruthy()

      await act(async () => {
        codeCopyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })

      expect(writeText).toHaveBeenCalledWith(enrollment.itakRegistrationPayload.userCredentials.password)
    })
  })

  // ── The expanded WinTAK/Manual field set ────────────────────────────
  describe('the expanded WinTAK/Manual field set', () => {
    const setUp = async (overrides = {}) => {
      const enrollment = buildEnrollmentFixture(overrides)
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

    it('renders Description, Protocol, Host Address, Port, both fixed checkboxes, Username, and Password', async () => {
      const enrollment = await setUp()

      expect(container.textContent).toContain('Description')
      expect(container.textContent).toContain('TAK.NZ')
      expect(container.textContent).toContain('Protocol')
      expect(container.textContent).toContain('SSL')
      expect(container.textContent).toContain('Host Address')
      expect(container.textContent).toContain(enrollment.host)
      expect(container.textContent).toContain('Port')
      expect(container.textContent).toContain('8089')
      expect(container.textContent).toContain('Enroll for Client Certificate')
      expect(container.textContent).toContain('Use Authentication')
      expect(container.textContent).toContain('Username')
      expect(container.textContent).toContain(enrollment.username)
      expect(container.textContent).toContain('Password')
    })

    // Bugfix: these used to be real <input type="checkbox" checked
    // disabled> elements -- a disabled checkbox is commonly rendered by
    // the browser's own native styling rather than the page's CSS, which
    // desaturated the box to a low-contrast system gray in both light and
    // dark mode. Rebuilt as a decorative, non-form "checked" indicator
    // (StaticCheckedIndicator) with an explicit bg-primary-500 fill and a
    // heroicons CheckIcon -- no <input> element exists here at all now.
    it('renders both "checked" indicators as decorative, non-interactive elements with an accessible name -- no real checkbox input exists', async () => {
      await setUp()

      // The old real checkbox inputs must be gone entirely.
      expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)

      for (const label of ['Enroll for Client Certificate', 'Use Authentication']) {
        const indicator = Array.from(container.querySelectorAll('[role="img"]')).find(
          (element) => element.getAttribute('aria-label') === `${label}: enabled`
        )
        expect(indicator, `no indicator found for "${label}"`).toBeTruthy()
        // A CheckIcon renders inside it, decoratively.
        expect(indicator.querySelector('svg')).not.toBeNull()
      }
    })

    it('renders the "checked" indicator fill in a shade that clears the WCAG 3:1 graphical-object floor against both the light and dark card backgrounds', async () => {
      await setUp()

      const indicator = Array.from(container.querySelectorAll('[role="img"]')).find(
        (element) => element.getAttribute('aria-label') === 'Enroll for Client Certificate: enabled'
      )
      expect(indicator).toBeTruthy()
      // primary-600 (this app's more common button shade) measures 2.84:1
      // against the dark card background and fails the floor there --
      // primary-500 is the one shade that clears both, so that is what
      // must be declared here, not primary-600.
      expect(indicator.className).toContain('bg-primary-500')
      expect(indicator.className).not.toContain('bg-primary-600')
    })

    it('renders the Description from WINTAK_MANUAL_DESCRIPTION (via GET /api/config/public) when configured', async () => {
      configAPI.getPublic.mockResolvedValue({ data: { enrollment_manual_description: 'Custom Org Name' } })

      await setUp()

      expect(container.textContent).toContain('Custom Org Name')
      expect(container.textContent).not.toContain('TAK.NZ')
    })

    it('falls back to the "TAK.NZ" default when the config fetch fails', async () => {
      configAPI.getPublic.mockRejectedValue(new Error('network error'))

      await setUp()

      expect(container.textContent).toContain('TAK.NZ')
    })

    it('copies the Description, and the Host Address, via their own Copy buttons', async () => {
      const enrollment = await setUp()
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })

      const descriptionCopyButton = Array.from(container.querySelectorAll('button[aria-label]')).find(
        (button) => button.getAttribute('aria-label') === 'Copy description'
      )
      expect(descriptionCopyButton).toBeTruthy()
      await act(async () => {
        descriptionCopyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })
      expect(writeText).toHaveBeenCalledWith('TAK.NZ')

      const hostCopyButton = Array.from(container.querySelectorAll('button[aria-label]')).find(
        (button) => button.getAttribute('aria-label') === 'Copy host address'
      )
      expect(hostCopyButton).toBeTruthy()
      await act(async () => {
        hostCopyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })
      expect(writeText).toHaveBeenCalledWith(enrollment.host)
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
