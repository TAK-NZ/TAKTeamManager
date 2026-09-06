// Shared auto-refresh lifecycle used by pages that keep on-screen data
// current while the tab is open (the Dashboard's "My Channels"/"My Devices"
// cards and the Admin page's stat cards).
//
// `startVisibilityPausedRefresh(refresh, intervalMs)` owns the whole
// lifecycle: it starts the interval, clears it WHILE the tab is hidden,
// re-fetches immediately and restarts it WHEN the tab becomes visible again,
// and returns a teardown that removes BOTH the interval and the
// `visibilitychange` listener -- so an effect can
// `return startVisibilityPausedRefresh(fn)` and be sure no timer survives the
// component (device-management Requirement 19.3).
//
// Extracted from Dashboard.jsx (where it was defined locally and used twice)
// so Dashboard and Admin share ONE definition rather than each hand-rolling
// the same timer/visibility logic -- per the client-conventions rule to
// extract a shared module when behaviour is duplicated.
//
// On the interval length: 60000 ms is a UI-CONSISTENCY choice, not a
// data-freshness one -- the same rhythm across pages, not a claim that the
// underlying data moves that fast. Callers may pass a different interval, but
// 60000 is the shared default.

export const DEFAULT_REFRESH_INTERVAL_MS = 60000

/**
 * Start a visibility-paused refresh loop.
 *
 * @param {() => void} refresh - called on each interval tick, and once
 *   immediately when the tab transitions back to visible. NOT called up
 *   front (mounting an effect should perform its own single first fetch;
 *   this only schedules subsequent refreshes).
 * @param {number} [intervalMs=DEFAULT_REFRESH_INTERVAL_MS]
 * @returns {() => void} teardown that clears the interval and removes the
 *   visibilitychange listener.
 */
export function startVisibilityPausedRefresh(refresh, intervalMs = DEFAULT_REFRESH_INTERVAL_MS) {
  let intervalId = setInterval(refresh, intervalMs)

  const handleVisibilityChange = () => {
    // Always clear before (re)starting: a `visibilitychange` that reports
    // visible twice in a row would otherwise leave the previous interval
    // running and double the fetch rate.
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }
    if (!document.hidden) {
      // Tab became visible again -- refresh immediately, then restart timer.
      refresh()
      intervalId = setInterval(refresh, intervalMs)
    }
  }
  document.addEventListener('visibilitychange', handleVisibilityChange)

  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    if (intervalId) clearInterval(intervalId)
  }
}
