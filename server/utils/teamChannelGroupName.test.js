const {
  composeEffectiveRootPrefix,
  deriveTeamChannelName
} = require('./teamChannelGroupName');
const { toAsciiIdentifier } = require('./asciiNormalize');

const SEP = ' - ';

function derive(overrides) {
  return deriveTeamChannelName({
    rootPrefix: null,
    rootCountryCode: null,
    teamName: 'X',
    isSubTeam: false,
    separator: SEP,
    toAsciiIdentifier,
    ...overrides
  });
}

describe('composeEffectiveRootPrefix', () => {
  it('is just the callsign prefix for a domestic Organisation (no country_code)', () => {
    expect(composeEffectiveRootPrefix('FENZ', null)).toBe('FENZ');
    expect(composeEffectiveRootPrefix('FENZ', '')).toBe('FENZ');
  });

  it('prepends country_code as the leading segment for a Foreign_Partner Organisation', () => {
    expect(composeEffectiveRootPrefix('CDEM', 'CHL')).toBe('CHL-CDEM');
    expect(composeEffectiveRootPrefix('CDEM', 'USA')).toBe('USA-CDEM');
    expect(composeEffectiveRootPrefix('FIRE', 'FJI')).toBe('FJI-FIRE');
  });

  it('omits an empty part rather than emitting a stray separator', () => {
    expect(composeEffectiveRootPrefix(null, 'USA')).toBe('USA');
    expect(composeEffectiveRootPrefix('  ', 'USA')).toBe('USA');
    expect(composeEffectiveRootPrefix(null, null)).toBe('');
  });
});

describe('deriveTeamChannelName', () => {
  it('builds a root team name from the effective root prefix', () => {
    const { channelName, authentikGroupName } = derive({
      rootPrefix: 'FENZ',
      teamName: 'FENZ',
      isSubTeam: false
    });
    expect(channelName).toBe('Teams - FENZ');
    expect(authentikGroupName).toBe('tak_Teams - FENZ');
  });

  it('falls back to the team name for a root team with no prefix or country', () => {
    const { channelName } = derive({ rootPrefix: null, rootCountryCode: null, teamName: 'Solo Org', isSubTeam: false });
    expect(channelName).toBe('Teams - Solo Org');
  });

  it('builds a sub-team name from the effective root prefix and its own name', () => {
    const { channelName } = derive({
      rootPrefix: 'FENZ',
      teamName: 'Southland District',
      isSubTeam: true
    });
    expect(channelName).toBe('Teams - FENZ - Southland District');
  });

  it('composes country_code so CHL-CDEM and USA-CDEM never collide (Bug 2)', () => {
    const chl = derive({ rootPrefix: 'CDEM', rootCountryCode: 'CHL', teamName: 'CDEM', isSubTeam: false });
    const usa = derive({ rootPrefix: 'CDEM', rootCountryCode: 'USA', teamName: 'CDEM', isSubTeam: false });
    expect(chl.authentikGroupName).toBe('tak_Teams - CHL-CDEM');
    expect(usa.authentikGroupName).toBe('tak_Teams - USA-CDEM');
    expect(chl.authentikGroupName).not.toBe(usa.authentikGroupName);
  });

  it('ASCII-normalizes the Authentik group name while keeping the human name intact (macrons)', () => {
    const { channelName, authentikGroupName } = derive({
      rootPrefix: 'FENZ',
      teamName: 'Ngā Tai ki te Puku',
      isSubTeam: true
    });
    expect(channelName).toBe('Teams - FENZ - Ngā Tai ki te Puku');
    expect(authentikGroupName).toBe('tak_Teams - FENZ - Nga Tai ki te Puku');
  });
});
