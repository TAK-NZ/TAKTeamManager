'use strict';

/**
 * ISO 3166-1 country lookup + validation (Foreign_Partner Organisation
 * country prefix feature).
 *
 * An Organisation may optionally carry a `country_code` -- the ISO 3166-1
 * ALPHA-3 code of a foreign partner nation (e.g. `AUS`, `FJI`) -- which is
 * composed as the LEADING segment of that Organisation's effective callsign
 * prefix: a Fiji fire org with `callsign_prefix = 'FIRE'` and
 * `country_code = 'FJI'` (Fiji's ISO 3166-1 alpha-3) yields the callsign
 * Organisation segment `FJI-FIRE`. A domestic (New Zealand) Organisation, or
 * any Organisation with no partner nation, carries `country_code = null` and
 * is unchanged:
 * its callsign segment is just its own `callsign_prefix`.
 *
 * Alpha-3 is the AUTHORITATIVE code everywhere in this app: it is what is
 * stored, what is composed into the callsign, and what is displayed. The
 * accompanying alpha-2 code (`alpha2`) exists ONLY to select a `flag-icons`
 * CSS class (`fi-<alpha2>`) for the flag glyph -- flag-icons is keyed on
 * alpha-2, so the country picker/Dashboard convert alpha-3 -> alpha-2 via
 * `getCountry(...).alpha2` purely for rendering.
 *
 * The dataset (`../config/iso3166Countries.json`) is the single vendored
 * source of truth: name + alpha3 + alpha2 for every ISO 3166-1 country. The
 * client carries a BYTE-IDENTICAL copy at
 * `client/src/utils/iso3166Countries.json` (a runtime fetch for a static
 * 249-row list would be wasteful, and flags must render without a round
 * trip); a structural test asserts the two copies never drift. Both were
 * generated once from flag-icons' own `country.json` (name + alpha-2,
 * filtered to `iso: true`) joined with the standard alpha-2 -> alpha-3
 * mapping.
 *
 * These helpers are pure (no I/O) and, like `callsignValidation.js`, treat
 * an empty/null/undefined value as VALID for `isValidCountryCode` -- the
 * field is genuinely optional (a domestic Organisation supplies none), and
 * "required-ness" (never, today) is a separate concern layered on by the
 * caller if ever needed.
 */

const COUNTRIES = require('../config/iso3166Countries.json');

// alpha3 (upper) -> { name, alpha3, alpha2 }. Built once at module load.
const BY_ALPHA3 = new Map(COUNTRIES.map((c) => [c.alpha3, c]));

/**
 * Is `value` a valid ISO 3166-1 alpha-3 country code present in the
 * dataset? Empty/null/undefined is treated as VALID (the field is
 * optional -- a domestic Organisation supplies no country). Matching is
 * case-INSENSITIVE on input but the dataset stores upper-case alpha-3, so
 * a supplied value is upper-cased before lookup. Never throws for any
 * input type.
 *
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
function isValidCountryCode(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }
  return BY_ALPHA3.has(value.toUpperCase());
}

/**
 * Resolves an ISO 3166-1 alpha-3 code to its `{ name, alpha3, alpha2 }`
 * record, or `null` when absent/unknown. Case-insensitive on input.
 *
 * @param {string|null|undefined} alpha3
 * @returns {{name: string, alpha3: string, alpha2: string}|null}
 */
function getCountry(alpha3) {
  if (typeof alpha3 !== 'string' || alpha3 === '') {
    return null;
  }
  return BY_ALPHA3.get(alpha3.toUpperCase()) || null;
}

/**
 * Normalises a supplied country code to the stored form (upper-case
 * alpha-3) when valid and non-empty, or `null` for an empty/absent value.
 * Throws is NOT done here -- callers that must reject an INVALID non-empty
 * value use `isValidCountryCode` first; this only canonicalises.
 *
 * @param {string|null|undefined} value
 * @returns {string|null} upper-case alpha-3, or null when empty/absent.
 */
function normaliseCountryCode(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = typeof value === 'string' ? value.trim() : value;
  if (!trimmed) {
    return null;
  }
  return String(trimmed).toUpperCase();
}

module.exports = { isValidCountryCode, getCountry, normaliseCountryCode, COUNTRIES };
