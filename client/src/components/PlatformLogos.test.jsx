import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { siAndroid, siApple } from 'simple-icons'
import { faWindows } from '@fortawesome/free-brands-svg-icons'

import { AndroidPlatformLogo, ApplePlatformLogo, WindowsPlatformLogo, CloudTakPlatformLogo } from './PlatformLogos.jsx'

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

/**
 * WindowsPlatformLogo, mirroring the fidelity checks above, but against
 * `@fortawesome/free-brands-svg-icons`' own export shape (`icon: [width,
 * height, ligatures, unicode, svgPathData]`) and its non-square viewBox
 * (448 x 512), rather than simple-icons' uniform 24 x 24 -- a separate
 * describe block rather than folding into `PLATFORM_LOGOS` above, since the
 * two source libraries' shapes and expected viewBox differ.
 */
describe('WindowsPlatformLogo (mounted)', () => {
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
      root.render(<WindowsPlatformLogo {...props} />)
    })
    return container.querySelector('svg')
  }

  const [faWidth, faHeight, , , faSvgPathData] = faWindows.icon

  it('renders an <svg> with the FontAwesome icon\'s own (non-square) viewBox', async () => {
    const svg = await mount({})

    expect(svg).not.toBeNull()
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${faWidth} ${faHeight}`)
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

  it("renders a <path> whose 'd' attribute equals FontAwesome's own path export exactly", async () => {
    const svg = await mount({})
    const path = svg.querySelector('path')

    // Anti-vacuity: a scan that silently matched nothing would pass every
    // assertion below while measuring nothing.
    expect(path).not.toBeNull()
    expect(path.getAttribute('d')).toBe(faSvgPathData)
  })

  it('fills with currentColor, matching the Android/Apple wrapper (Requirement 6.1)', async () => {
    const svg = await mount({})

    expect(svg.getAttribute('fill')).toBe('currentColor')
  })
})

/**
 * CloudTakPlatformLogo, TAK-NZ's own two-tone (black + white outline) mark,
 * NOT a single-color brand glyph like the three above -- so it carries no
 * `fill="currentColor"` contract, unlike every other Platform_Logo in this
 * file. Its own two `<path>` elements carry FIXED, explicit fill/stroke
 * instead. This test group otherwise matches the shared external contract
 * (className/aria-hidden passthrough, viewBox) every glyph in
 * `DeviceTypeIcon.jsx`'s `GLYPHS` map must satisfy.
 */
describe('CloudTakPlatformLogo (mounted)', () => {
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
      root.render(<CloudTakPlatformLogo {...props} />)
    })
    return container.querySelector('svg')
  }

  it('renders an <svg> with the CloudTAK mark\'s own viewBox, matching the public asset', async () => {
    const svg = await mount({})

    expect(svg).not.toBeNull()
    expect(svg.getAttribute('viewBox')).toBe('0 0 79.3 51.62')
  })

  it('forwards a supplied className onto the <svg>', async () => {
    const svg = await mount({ className: 'h-5 w-5 cursor-help' })

    expect(svg.getAttribute('class')).toBe('h-5 w-5 cursor-help')
  })

  it('defaults aria-hidden to "true" when not supplied', async () => {
    const svg = await mount({})

    expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('honours an explicitly supplied aria-hidden rather than always defaulting', async () => {
    const svg = await mount({ 'aria-hidden': 'false' })

    expect(svg.getAttribute('aria-hidden')).toBe('false')
  })

  it('renders exactly two <path> elements -- the white silhouette layer and the black evenodd-cutout layer -- neither using currentColor', async () => {
    const svg = await mount({})
    const paths = svg.querySelectorAll('path')

    expect(paths).toHaveLength(2)
    expect(paths[0].getAttribute('fill')).toBe('#ffffff')
    expect(paths[1].getAttribute('fill')).toBe('#000000')
    expect(paths[1].getAttribute('fill-rule')).toBe('evenodd')
    expect(paths[1].getAttribute('stroke')).toBe('#ffffff')
    // Anti-vacuity: this mark's whole point is the white outline BEHIND the
    // black fill (`paint-order="stroke fill"`) -- confirm the attribute
    // that produces that effect is actually present, not merely that some
    // stroke color is set.
    expect(paths[1].getAttribute('paint-order')).toBe('stroke fill')
  })

  it('has no fill="currentColor" anywhere, unlike every other Platform_Logo in this file', async () => {
    const svg = await mount({})

    expect(svg.getAttribute('fill')).not.toBe('currentColor')
    svg.querySelectorAll('path').forEach((path) => {
      expect(path.getAttribute('fill')).not.toBe('currentColor')
    })
  })
})
