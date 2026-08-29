import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { siAndroid, siApple } from 'simple-icons'

import { AndroidPlatformLogo, ApplePlatformLogo } from './PlatformLogos.jsx'

// Validates: Requirements 6.1, 6.2
//
// downloads-page-os-sections task 4.3. `PlatformLogos.jsx` is the ONE shared
// wrapper `Downloads.jsx`'s OsSection headers and `DeviceTypeIcon.jsx`'s
// android/ios glyphs both consume (Requirement 6.2's "same" wording), so
// what matters here is its external contract -- viewBox, className
// passthrough, aria-hidden default -- and a direct-dependency-fidelity
// check that the rendered path data is exactly what `simple-icons` itself
// exports, mirroring `storeBadgeFidelity.test.jsx`'s treatment of the
// existing store badges.
//
// This project has no `@testing-library/react` (absent from
// `client/package.json` and from `client/node_modules`), so both subjects
// are mounted with `react-dom/client`'s `createRoot` plus React 18's own
// `act`, following the pattern established by `DeviceTypeIcon.test.jsx` /
// `storeBadgeFidelity.test.jsx`. Neither subject fetches or takes context,
// so nothing is mocked.

// Vitest compiles this JSX with esbuild's classic transform, and the
// component source under test carries no `React` import of its own, so the
// classic transform needs one in scope.
globalThis.React = React

/** Each Platform_Logo paired with the simple-icons export it must match exactly. */
const PLATFORM_LOGOS = [
  ['AndroidPlatformLogo', AndroidPlatformLogo, siAndroid],
  ['ApplePlatformLogo', ApplePlatformLogo, siApple]
]

describe.each(PLATFORM_LOGOS)('%s (mounted)', (_name, PlatformLogo, simpleIconExport) => {
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

  const mount = async (props) => {
    root = createRoot(container)
    await act(async () => {
      root.render(<PlatformLogo {...props} />)
    })
    return container.querySelector('svg')
  }

  it('renders an <svg> with viewBox "0 0 24 24"', async () => {
    const svg = await mount({})

    expect(svg).not.toBeNull()
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
  })

  it('forwards a supplied className onto the <svg>', async () => {
    const svg = await mount({ className: 'h-5 w-5 text-gray-500 dark:text-gray-400' })

    expect(svg.getAttribute('class')).toBe('h-5 w-5 text-gray-500 dark:text-gray-400')
  })

  it('defaults aria-hidden to "true" when not supplied', async () => {
    const svg = await mount({})

    expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('honours an explicitly supplied aria-hidden rather than always defaulting', async () => {
    const svg = await mount({ 'aria-hidden': 'false' })

    expect(svg.getAttribute('aria-hidden')).toBe('false')
  })

  it("renders a <path> whose 'd' attribute equals simple-icons' own path export exactly", async () => {
    const svg = await mount({})
    const path = svg.querySelector('path')

    // Anti-vacuity: a scan that silently matched nothing would pass every
    // assertion below while measuring nothing.
    expect(path).not.toBeNull()
    expect(path.getAttribute('d')).toBe(simpleIconExport.path)
  })
})
