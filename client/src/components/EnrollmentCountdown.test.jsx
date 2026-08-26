import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import EnrollmentCountdown from './EnrollmentCountdown.jsx'

// Required: Vitest compiles this JSX with esbuild's classic transform and the
// component carries no React import of its own from this test's perspective.
globalThis.React = React

// Basic sanity coverage for task 9.3's own implementation. The fuller client
// example tests (ticks/EXPIRED/clears-interval/no-fetch-on-expiry, mounted
// inside EnrollmentView) are task 9.9's responsibility -- this file only
// has to show the countdown ticks, reaches EXPIRED, and clears its interval
// on unmount and on expiry.
describe('EnrollmentCountdown', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    // Only `Date`/timers are faked; matches the FormattedDate.test.jsx /
    // Dashboard.test.jsx precedent of scoping fake timers per-suite.
    vi.useFakeTimers()
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
    vi.useRealTimers()
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  it('ticks the MM : SS display down by one second at a time', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    const expiresAt = new Date(now + 5 * 1000).toISOString()

    root = createRoot(container)
    await act(async () => {
      root.render(<EnrollmentCountdown expiresAt={expiresAt} />)
    })

    expect(container.textContent).toContain('00 : 05')

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(container.textContent).toContain('00 : 04')

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(container.textContent).toContain('00 : 03')
  })

  it('reaches the terminal EXPIRED state and clears its own interval', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    const expiresAt = new Date(now + 2 * 1000).toISOString()

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')

    root = createRoot(container)
    await act(async () => {
      root.render(<EnrollmentCountdown expiresAt={expiresAt} />)
    })

    expect(container.textContent).toContain('00 : 02')
    expect(clearIntervalSpy).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    expect(container.textContent).toContain('EXPIRED')
    // Reaching the terminal state clears the interval itself, without
    // waiting for unmount.
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)

    // Advancing further must not flip it back or throw: the interval is
    // gone, so nothing ticks anymore.
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(container.textContent).toContain('EXPIRED')
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)

    clearIntervalSpy.mockRestore()
  })

  it('clears its interval on unmount', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    const expiresAt = new Date(now + 60 * 1000).toISOString()

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')

    root = createRoot(container)
    await act(async () => {
      root.render(<EnrollmentCountdown expiresAt={expiresAt} />)
    })

    expect(clearIntervalSpy).not.toHaveBeenCalled()

    await act(async () => {
      root.unmount()
    })
    root = null

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)

    clearIntervalSpy.mockRestore()
  })

  it('renders no interval at all for an already-expired expiresAt', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    const expiresAt = new Date(now - 1000).toISOString()

    const setIntervalSpy = vi.spyOn(global, 'setInterval')

    root = createRoot(container)
    await act(async () => {
      root.render(<EnrollmentCountdown expiresAt={expiresAt} />)
    })

    expect(container.textContent).toContain('EXPIRED')
    expect(setIntervalSpy).not.toHaveBeenCalled()

    setIntervalSpy.mockRestore()
  })

  it('never re-fetches or calls any callback other than onExpired/onRegenerate on expiry', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    const expiresAt = new Date(now + 1000).toISOString()
    const onExpired = vi.fn()
    const onRegenerate = vi.fn()

    root = createRoot(container)
    await act(async () => {
      root.render(
        <EnrollmentCountdown expiresAt={expiresAt} onExpired={onExpired} onRegenerate={onRegenerate} />
      )
    })

    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(container.textContent).toContain('EXPIRED')
    expect(onExpired).toHaveBeenCalledTimes(1)
    expect(onRegenerate).not.toHaveBeenCalled()

    // Further ticks must not re-invoke onExpired for the same expiresAt.
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(onExpired).toHaveBeenCalledTimes(1)
  })

  // takserver-enrollment task 9.9: the "Generate a new code" affordance is
  // this component's OWN rendering responsibility (it is the thing that
  // decides when to show the button at all), even though calling
  // `onRegenerate` is never this component's own initiative -- see the file
  // header's "what this component does not own" note.
  it('renders "Generate a new code" only once EXPIRED, and calls onRegenerate exactly once per click', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    const expiresAt = new Date(now + 1000).toISOString()
    const onRegenerate = vi.fn()

    root = createRoot(container)
    await act(async () => {
      root.render(<EnrollmentCountdown expiresAt={expiresAt} onRegenerate={onRegenerate} />)
    })

    // Not yet expired: no regenerate affordance at all, so there is nothing
    // to click prematurely.
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Generate a new code'
      )
    ).toBe(false)

    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(container.textContent).toContain('EXPIRED')

    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Generate a new code'
    )
    expect(button).toBeTruthy()

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onRegenerate).toHaveBeenCalledTimes(1)

    // A second click issues a second call -- "exactly one request per
    // click", not one request total regardless of how many times it is
    // clicked.
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onRegenerate).toHaveBeenCalledTimes(2)
  })

  it('renders no regenerate affordance at all when onRegenerate is omitted, even once EXPIRED', async () => {
    const now = Date.now()
    vi.setSystemTime(now)
    const expiresAt = new Date(now + 1000).toISOString()

    root = createRoot(container)
    await act(async () => {
      root.render(<EnrollmentCountdown expiresAt={expiresAt} />)
    })

    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(container.textContent).toContain('EXPIRED')
    expect(container.querySelector('button')).toBeNull()
  })
})
