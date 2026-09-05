// ISO 3166-1 country lookup for the client (Foreign_Partner Organisation
// country prefix feature). Mirrors server/utils/isoCountry.js's semantics
// and reads the BYTE-IDENTICAL vendored dataset (a structural test asserts
// the server and client copies never drift).
//
// alpha-3 is the authoritative code (stored, composed into the callsign,
// displayed). alpha-2 exists ONLY to pick a flag-icons class (`fi-<alpha2>`).
//
// No React import (this file lives in client/src/utils/ per the placement
// rule: pure logic, directly unit-testable).

import COUNTRIES from './iso3166Countries.json'

// alpha3 (upper) -> { name, alpha3, alpha2 }
const BY_ALPHA3 = new Map(COUNTRIES.map((c) => [c.alpha3, c]))

/**
 * The full country list, already sorted by name (the vendored JSON is
 * generated pre-sorted). Exported for the country picker dropdown.
 *
 * @type {ReadonlyArray<{name: string, alpha3: string, alpha2: string}>}
 */
export const countries = COUNTRIES

/**
 * Resolves an ISO 3166-1 alpha-3 code to `{ name, alpha3, alpha2 }`, or
 * `null` for an empty/absent/unknown value. Case-insensitive on input.
 *
 * @param {string|null|undefined} alpha3
 * @returns {{name: string, alpha3: string, alpha2: string}|null}
 */
export function getCountry(alpha3) {
  if (typeof alpha3 !== 'string' || alpha3 === '') {
    return null
  }
  return BY_ALPHA3.get(alpha3.toUpperCase()) || null
}

/**
 * The flag-icons CSS class for a country's flag glyph, e.g.
 * `fi fi-fj` for Fiji. Returns `null` for an unknown/empty code so a caller
 * can render nothing rather than a broken/blank flag box.
 *
 * @param {string|null|undefined} alpha3
 * @returns {string|null}
 */
export function flagClass(alpha3) {
  const country = getCountry(alpha3)
  return country ? `fi fi-${country.alpha2}` : null
}

/**
 * Filters the country list by a free-text term, matched case-insensitively
 * (and whitespace-trimmed) as a SUBSTRING against either the country NAME or
 * its alpha-3 code -- so typing "fij", "FJI", or "Fiji" all find Fiji. An
 * empty/whitespace-only term returns the whole list unchanged (sorted by
 * name), mirroring the "find a team by typing its name" search affordance
 * used elsewhere (TransferMemberDialog, RequestAccess).
 *
 * Pure and directly unit-testable.
 *
 * @param {string|null|undefined} searchTerm
 * @returns {Array<{name: string, alpha3: string, alpha2: string}>}
 */
export function filterCountries(searchTerm) {
  const term = (searchTerm || '').trim().toLowerCase()
  if (term === '') {
    return countries
  }
  return countries.filter(
    (c) =>
      c.name.toLowerCase().includes(term) ||
      c.alpha3.toLowerCase().includes(term)
  )
}
