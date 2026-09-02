import { describe, it, expect } from 'vitest'
import {
  SERVICE_ACCOUNT_USERNAME_PREFIX,
  MAX_SERVICE_ACCOUNT_USERNAME_SUFFIX_LENGTH,
  isValidServiceAccountUsernameSuffix,
  buildServiceAccountUsername,
  slugifyChannelName
} from './serviceAccountUsername.js'

// Bugfix (Add Service Account dialog): client-side mirror of
// server/utils/serviceAccountUsername.js's `etl-` prefix rule, used to
// validate the admin-typed suffix live before the request round-trips to
// the server (which is the actual enforcement point).

describe('SERVICE_ACCOUNT_USERNAME_PREFIX', () => {
  it('is the literal "etl-"', () => {
    expect(SERVICE_ACCOUNT_USERNAME_PREFIX).toBe('etl-')
  })
})

describe('isValidServiceAccountUsernameSuffix', () => {
  it('accepts a plain lowercase-and-hyphens suffix', () => {
    expect(isValidServiceAccountUsernameSuffix('data-packages')).toBe(true)
  })

  it('accepts a single word', () => {
    expect(isValidServiceAccountUsernameSuffix('weather')).toBe(true)
  })

  it('accepts digits', () => {
    expect(isValidServiceAccountUsernameSuffix('feed-2')).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(isValidServiceAccountUsernameSuffix('')).toBe(false)
  })

  it('rejects a leading hyphen', () => {
    expect(isValidServiceAccountUsernameSuffix('-data')).toBe(false)
  })

  it('rejects a trailing hyphen', () => {
    expect(isValidServiceAccountUsernameSuffix('data-')).toBe(false)
  })

  it('rejects a doubled hyphen', () => {
    expect(isValidServiceAccountUsernameSuffix('data--packages')).toBe(false)
  })

  it('rejects uppercase letters', () => {
    expect(isValidServiceAccountUsernameSuffix('Data-Packages')).toBe(false)
  })

  it('rejects a space', () => {
    expect(isValidServiceAccountUsernameSuffix('data packages')).toBe(false)
  })

  it('rejects a dot', () => {
    expect(isValidServiceAccountUsernameSuffix('data.packages')).toBe(false)
  })

  it('rejects an underscore', () => {
    expect(isValidServiceAccountUsernameSuffix('data_packages')).toBe(false)
  })

  it('rejects null', () => {
    expect(isValidServiceAccountUsernameSuffix(null)).toBe(false)
  })

  it('rejects undefined', () => {
    expect(isValidServiceAccountUsernameSuffix(undefined)).toBe(false)
  })

  it('rejects a non-string value', () => {
    expect(isValidServiceAccountUsernameSuffix(42)).toBe(false)
  })

  it('accepts a suffix exactly at the max length', () => {
    const suffix = 'a'.repeat(MAX_SERVICE_ACCOUNT_USERNAME_SUFFIX_LENGTH)
    expect(isValidServiceAccountUsernameSuffix(suffix)).toBe(true)
  })

  it('rejects a suffix one character over the max length', () => {
    const suffix = 'a'.repeat(MAX_SERVICE_ACCOUNT_USERNAME_SUFFIX_LENGTH + 1)
    expect(isValidServiceAccountUsernameSuffix(suffix)).toBe(false)
  })
})

describe('buildServiceAccountUsername', () => {
  it('prepends the etl- prefix to the suffix', () => {
    expect(buildServiceAccountUsername('data-packages')).toBe('etl-data-packages')
  })
})

/**
 * Bugfix (Add Service Account dialog: recommended name should derive
 * from the actual channel name, collapsing "---" to "-"): client-side
 * mirror of server/utils/serviceAccountUsername.js's slugifyChannelName.
 */
describe('slugifyChannelName', () => {
  it('lowercases the name and joins words with a single hyphen', () => {
    expect(slugifyChannelName('Data Packages')).toBe('data-packages')
  })

  it('produces "inreach-devices" for "InReach Devices", per the explicit example', () => {
    expect(slugifyChannelName('InReach Devices')).toBe('inreach-devices')
  })

  it('collapses a literal " - " folder-separator to a SINGLE hyphen, not three', () => {
    expect(slugifyChannelName('Alerts - MetService')).toBe('alerts-metservice')
  })

  it('collapses a literal " - " folder-separator for a multi-word channel name', () => {
    expect(slugifyChannelName('Community - Amateur Radio APRS')).toBe('community-amateur-radio-aprs')
  })

  it('strips a leading hyphen from leading punctuation', () => {
    expect(slugifyChannelName('- Leading Dash')).toBe('leading-dash')
  })

  it('strips a trailing hyphen from trailing punctuation', () => {
    expect(slugifyChannelName('Trailing Dash -')).toBe('trailing-dash')
  })

  it('produces a suffix that isValidServiceAccountUsernameSuffix itself accepts', () => {
    expect(isValidServiceAccountUsernameSuffix(slugifyChannelName('Alerts - MetService'))).toBe(true)
  })
})
