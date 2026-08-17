/**
 * Shared ISO 8601 (yyyy-mm-dd) date formatting for user-visible dates
 * across the app, instead of each page independently calling
 * `toLocaleDateString()`/`toLocaleTimeString()` -- which render in the
 * browser's locale/format (e.g. American mm/dd/yyyy), not the
 * unambiguous, locale-independent yyyy-mm-dd format this app standardises
 * on everywhere a date is shown to a user.
 *
 * `formatDate` renders the date component only (yyyy-mm-dd); `formatDateTime`
 * additionally appends a 24-hour HH:MM time component (still yyyy-mm-dd
 * for the date part) for timestamps where the time is also meaningful
 * (e.g. "last synced", audit log entries).
 */

/**
 * @param {string|number|Date|null|undefined} value - anything `new Date()`
 *   accepts, or null/undefined.
 * @param {string} [fallback] - returned when `value` is null/undefined/
 *   unparseable. Defaults to an empty string.
 * @returns {string} `yyyy-mm-dd`, or `fallback`.
 */
export function formatDate(value, fallback = '') {
  if (value == null) {
    return fallback
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return fallback
  }
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * @param {string|number|Date|null|undefined} value
 * @param {string} [fallback]
 * @returns {string} `yyyy-mm-dd HH:MM` (24-hour), or `fallback`.
 */
export function formatDateTime(value, fallback = '') {
  if (value == null) {
    return fallback
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return fallback
  }
  const datePart = formatDate(date, fallback)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${datePart} ${hours}:${minutes}`
}
