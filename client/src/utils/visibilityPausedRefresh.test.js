import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startVisibilityPausedRefresh, DEFAULT_REFRESH_INTERVAL_MS } from './visibilityPausedRefresh'

// Pure timer/DOM lifecycle helper -- no React mounting, so plain Vitest with
// fake timers and a stubbed `document.hidden`.

describe('startVisibilityPausedRefresh', () => {
  let originalHidden

  beforeEach(() => {
    vi.useFakeTimers()
    originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
    // Make document.hidden writable for the test.
    Object.defineProperty(document, 'hidden', { configurable: true, value: false, writable: true })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    if (originalHidden) {
      Object.defineProperty(document, 'hidden', originalHidden)
    } else {
      delete document.hidden
    }
  })

  function setHidden(hidden) {
    document.hidden = hidden
    document.dispatchEvent(new Event('visibilitychange'))
  }

  it('does NOT call refresh up front -- only on the interval', () => {
    const refresh = vi.fn()
    const stop = startVisibilityPausedRefresh(refresh)
    expect(refresh).not.toHaveBeenCalled()

    vi.advanceTimersByTime(DEFAULT_REFRESH_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(DEFAULT_REFRESH_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
  })

  it('honours a custom interval', () => {
    const refresh = vi.fn()
    const stop = startVisibilityPausedRefresh(refresh, 5000)
    vi.advanceTimersByTime(4999)
    expect(refresh).toHaveBeenCalledTimes(0)
    vi.advanceTimersByTime(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    stop()
  })

  it('pauses ticking while the tab is hidden and does not fire on the hidden transition', () => {
    const refresh = vi.fn()
    const stop = startVisibilityPausedRefresh(refresh)

    setHidden(true) // tab hidden -> interval cleared, no immediate refresh
    expect(refresh).not.toHaveBeenCalled()

    // Time passes while hidden -- no ticks.
    vi.advanceTimersByTime(DEFAULT_REFRESH_INTERVAL_MS * 3)
    expect(refresh).not.toHaveBeenCalled()
    stop()
  })

  it('refreshes immediately when the tab becomes visible again, then resumes ticking', () => {
    const refresh = vi.fn()
    const stop = startVisibilityPausedRefresh(refresh)

    setHidden(true)
    vi.advanceTimersByTime(DEFAULT_REFRESH_INTERVAL_MS)
    expect(refresh).not.toHaveBeenCalled()

    setHidden(false) // becomes visible -> immediate refresh
    expect(refresh).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(DEFAULT_REFRESH_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
  })

  it('does not double the rate if a visible->visible transition is reported twice', () => {
    const refresh = vi.fn()
    const stop = startVisibilityPausedRefresh(refresh)

    // Two visibilitychange events while already visible: the clear-before-
    // restart guard must not leave two intervals running.
    setHidden(false)
    setHidden(false)
    refresh.mockClear()

    vi.advanceTimersByTime(DEFAULT_REFRESH_INTERVAL_MS)
    // Exactly one tick, not two.
    expect(refresh).toHaveBeenCalledTimes(1)
    stop()
  })

  it('teardown removes the interval and the visibilitychange listener', () => {
    const refresh = vi.fn()
    const stop = startVisibilityPausedRefresh(refresh)
    stop()

    // No more ticks after teardown.
    vi.advanceTimersByTime(DEFAULT_REFRESH_INTERVAL_MS * 3)
    expect(refresh).not.toHaveBeenCalled()

    // And a visibilitychange after teardown does nothing.
    setHidden(false)
    expect(refresh).not.toHaveBeenCalled()
  })
})
