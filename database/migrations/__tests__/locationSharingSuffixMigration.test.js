/**
 * The suffix literals in migration
 * `1790500000002_standardize-location-sharing-suffix.cjs` are duplicated from
 * `LOCATION_SHARING_DESCRIPTION_SUFFIX` (a migration must not depend on
 * application code). This pins them together so they cannot drift.
 */
const fs = require('fs');
const path = require('path');
const { LOCATION_SHARING_DESCRIPTION_SUFFIX } = require('../../../server/config/constants');

const FILE = '1790500000002_standardize-location-sharing-suffix.cjs';
const present = fs.existsSync(path.join(__dirname, '..', FILE));

(present ? describe : describe.skip)('location-sharing suffix migration literals', () => {
  const source = present ? fs.readFileSync(path.join(__dirname, '..', FILE), 'utf8') : '';

  it('SUFFIX equals LOCATION_SHARING_DESCRIPTION_SUFFIX exactly', () => {
    const match = source.match(/const SUFFIX = '([^']*)';/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(LOCATION_SHARING_DESCRIPTION_SUFFIX);
  });

  it('OLD_TEAM_SUFFIX is the retired team qualifier', () => {
    const match = source.match(/const OLD_TEAM_SUFFIX = '([^']*)';/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(' (Location sharing enabled)');
  });
});
