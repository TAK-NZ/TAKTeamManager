const {
  SERVICE_ACCOUNT_USERNAME_PREFIX,
  MAX_SERVICE_ACCOUNT_USERNAME_LENGTH,
  slugifyChannelName,
  buildDefaultServiceAccountUsername,
  isValidServiceAccountUsername
} = require('./serviceAccountUsername');

/**
 * Bugfix (BCH/UTL service account naming): the single source of truth for
 * the `etl-` prefix, shared by the auto-derived default name
 * (`createBchChannel`/`provisionServiceAccount`'s no-custom-name path) and
 * the admin-supplied custom name (the "Add Service Account" dialog's
 * validation, both client-side hint and server-side enforcement).
 */

describe('SERVICE_ACCOUNT_USERNAME_PREFIX', () => {
  it('is the literal "etl-"', () => {
    expect(SERVICE_ACCOUNT_USERNAME_PREFIX).toBe('etl-');
  });
});

/**
 * Bugfix: `slugifyChannelName` (and therefore `buildDefaultServiceAccountUsername`)
 * previously only collapsed WHITESPACE runs to a single `-`, leaving a
 * channel name's own literal ` - ` folder-separator untouched -- e.g.
 * "Alerts - MetService" produced "alerts---metservice" (three hyphens:
 * the space-before, the literal hyphen, and the space-after each became
 * their own `-`). Confirmed live: `etl-alerts---metservice` and
 * `etl-community---amateur-radio-aprs` were exactly the two malformed
 * usernames this app generated and silently failed to provision in
 * Authentik.
 */
describe('slugifyChannelName', () => {
  it('lowercases the name and joins words with a single hyphen', () => {
    expect(slugifyChannelName('Data Packages')).toBe('data-packages');
  });

  it('collapses a run of multiple spaces into a single hyphen', () => {
    expect(slugifyChannelName('Data   Packages')).toBe('data-packages');
  });

  it('collapses a literal " - " folder-separator to a SINGLE hyphen, not three', () => {
    expect(slugifyChannelName('Alerts - MetService')).toBe('alerts-metservice');
  });

  it('collapses a literal " - " folder-separator for a multi-word channel name', () => {
    expect(slugifyChannelName('Community - Amateur Radio APRS')).toBe('community-amateur-radio-aprs');
  });

  it('produces the exact expected slug for "InReach Devices"', () => {
    expect(slugifyChannelName('InReach Devices')).toBe('inreach-devices');
  });

  it('strips a leading hyphen that would otherwise result from leading punctuation', () => {
    expect(slugifyChannelName('- Leading Dash')).toBe('leading-dash');
  });

  it('strips a trailing hyphen that would otherwise result from trailing punctuation', () => {
    expect(slugifyChannelName('Trailing Dash -')).toBe('trailing-dash');
  });

  it('collapses other punctuation (slash, ampersand, parentheses) to a single hyphen too', () => {
    expect(slugifyChannelName('Fire/Rescue & EMS (Combined)')).toBe('fire-rescue-ems-combined');
  });

  it('preserves digits', () => {
    expect(slugifyChannelName('Region 5 Feed')).toBe('region-5-feed');
  });
});

describe('buildDefaultServiceAccountUsername', () => {
  it('lowercases the channel name and joins words with a single hyphen', () => {
    expect(buildDefaultServiceAccountUsername('Data Packages')).toBe('etl-data-packages');
  });

  it('collapses a run of multiple spaces into a single hyphen', () => {
    expect(buildDefaultServiceAccountUsername('Data   Packages')).toBe('etl-data-packages');
  });

  it('collapses a literal " - " folder-separator to a single hyphen (the confirmed live bug)', () => {
    expect(buildDefaultServiceAccountUsername('Alerts - MetService')).toBe('etl-alerts-metservice');
    expect(buildDefaultServiceAccountUsername('Community - Amateur Radio APRS')).toBe(
      'etl-community-amateur-radio-aprs'
    );
  });

  it('produces "etl-inreach-devices" for "InReach Devices", per the explicit example', () => {
    expect(buildDefaultServiceAccountUsername('InReach Devices')).toBe('etl-inreach-devices');
  });

  it('always starts with the etl- prefix', () => {
    expect(buildDefaultServiceAccountUsername('Test Channel').startsWith('etl-')).toBe(true);
  });

  it('produces a value that isValidServiceAccountUsername itself accepts, for a plain alphanumeric name', () => {
    expect(isValidServiceAccountUsername(buildDefaultServiceAccountUsername('Test Channel'))).toBe(true);
  });

  it('produces a value that isValidServiceAccountUsername accepts for a folder-separated name too', () => {
    expect(isValidServiceAccountUsername(buildDefaultServiceAccountUsername('Alerts - MetService'))).toBe(true);
  });
});

describe('isValidServiceAccountUsername', () => {
  it('accepts a plain lowercase-and-hyphens username after the prefix', () => {
    expect(isValidServiceAccountUsername('etl-data-packages')).toBe(true);
  });

  it('accepts a single-word suffix', () => {
    expect(isValidServiceAccountUsername('etl-weather')).toBe(true);
  });

  it('accepts digits in the suffix', () => {
    expect(isValidServiceAccountUsername('etl-feed-2')).toBe(true);
  });

  it('rejects a value with no etl- prefix at all', () => {
    expect(isValidServiceAccountUsername('data-packages')).toBe(false);
  });

  it('rejects a value with the wrong-case prefix', () => {
    expect(isValidServiceAccountUsername('ETL-data-packages')).toBe(false);
  });

  it('rejects a value that is only the bare prefix, with nothing after it', () => {
    expect(isValidServiceAccountUsername('etl-')).toBe(false);
  });

  it('rejects a suffix with a leading hyphen (an empty first segment)', () => {
    expect(isValidServiceAccountUsername('etl--data')).toBe(false);
  });

  it('rejects a suffix with a trailing hyphen', () => {
    expect(isValidServiceAccountUsername('etl-data-')).toBe(false);
  });

  it('rejects a suffix with a doubled hyphen', () => {
    expect(isValidServiceAccountUsername('etl-data--packages')).toBe(false);
  });

  it('rejects uppercase letters in the suffix', () => {
    expect(isValidServiceAccountUsername('etl-Data-Packages')).toBe(false);
  });

  it('rejects a space in the suffix', () => {
    expect(isValidServiceAccountUsername('etl-data packages')).toBe(false);
  });

  it('rejects a dot in the suffix', () => {
    expect(isValidServiceAccountUsername('etl-data.packages')).toBe(false);
  });

  it('rejects an underscore in the suffix', () => {
    expect(isValidServiceAccountUsername('etl-data_packages')).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidServiceAccountUsername(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidServiceAccountUsername(undefined)).toBe(false);
  });

  it('rejects a non-string value', () => {
    expect(isValidServiceAccountUsername(42)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidServiceAccountUsername('')).toBe(false);
  });

  it('accepts a value exactly at MAX_SERVICE_ACCOUNT_USERNAME_LENGTH', () => {
    const suffix = 'a'.repeat(MAX_SERVICE_ACCOUNT_USERNAME_LENGTH - SERVICE_ACCOUNT_USERNAME_PREFIX.length);
    const value = `${SERVICE_ACCOUNT_USERNAME_PREFIX}${suffix}`;
    expect(value.length).toBe(MAX_SERVICE_ACCOUNT_USERNAME_LENGTH);
    expect(isValidServiceAccountUsername(value)).toBe(true);
  });

  it('rejects a value one character over MAX_SERVICE_ACCOUNT_USERNAME_LENGTH', () => {
    const suffix = 'a'.repeat(MAX_SERVICE_ACCOUNT_USERNAME_LENGTH - SERVICE_ACCOUNT_USERNAME_PREFIX.length + 1);
    const value = `${SERVICE_ACCOUNT_USERNAME_PREFIX}${suffix}`;
    expect(value.length).toBe(MAX_SERVICE_ACCOUNT_USERNAME_LENGTH + 1);
    expect(isValidServiceAccountUsername(value)).toBe(false);
  });
});
