// Formats a count/quantity for display with locale-aware grouping separators
// (e.g. 13329 -> "13,329"), so 5-figure figures on /admin and the pagination
// footers are readable at a glance. No React import (client-conventions: pure
// logic lives in utils so a test can reach it directly).
//
// LOCALE: reads getDisplayLocale() from dateFormat.js at CALL TIME, not import
// time, so the operator-configured locale (the `display_locale` public-config
// key, installed once in App.jsx via setDisplayLocale) is respected even
// though App's install runs after this module is first imported. This is the
// SAME locale the date-abbreviation suffix uses -- one operator-chosen locale
// for the whole UI, never the browser's own, which would be non-deterministic
// across machines. `display_locale` is env-configurable via DISPLAY_LOCALE.
//
// SCOPE: apply ONLY to counts/quantities. IDs, years, ports, version numbers
// and any value a user might copy as a machine token must stay bare -- a port
// "3001" must never render "3,001". This helper does not decide that; callers
// apply it deliberately at count sites.
//
// TOTALITY: unusable input (null, undefined, NaN, Infinity, a non-number)
// returns the empty string rather than a thrown error or a misleading "0"/
// "NaN" -- one odd value must never blank a whole card with an exception. A
// real count reaches this via the caller's own `?? 0` default, so the empty
// return is the genuinely-absent case, not the zero case.

import { getDisplayLocale } from './dateFormat'

/**
 * @param {number} value - a count/quantity.
 * @returns {string} the grouped string (e.g. "13,329"), or "" for unusable
 *   input.
 */
export function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return ''
  }
  return value.toLocaleString(getDisplayLocale())
}
