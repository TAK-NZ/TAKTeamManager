const { buildRegionGroupName, selectRegionGroupRenames } = require('./regionGroupName');

describe('buildRegionGroupName', () => {
  // Expected values are transcribed from the documented group naming
  // (`tak_<TierPrefix><separator><ascii name>`), not derived from the module.
  it('builds the Authentik group name for each tier', () => {
    expect(buildRegionGroupName('coordination', 'Auckland', ' - ')).toBe('tak_Coordination - Auckland');
    expect(buildRegionGroupName('response', 'Auckland', ' - ')).toBe('tak_Response - Auckland');
  });

  it('honours a custom folder separator', () => {
    expect(buildRegionGroupName('coordination', 'Auckland', ' / ')).toBe('tak_Coordination / Auckland');
  });

  it('ASCII-normalises the channel name', () => {
    expect(buildRegionGroupName('coordination', 'Tāmaki Makaurau', ' - ')).toBe('tak_Coordination - Tamaki Makaurau');
  });

  it('returns null for an unknown tier, including the retired "support" value and inherited object keys', () => {
    for (const tier of ['support', '', undefined, null, 'toString', '__proto__', 'constructor']) {
      expect(buildRegionGroupName(tier, 'Auckland', ' - ')).toBeNull();
    }
  });
});

describe('selectRegionGroupRenames', () => {
  const channel = (over = {}) => ({
    id: 1, name: 'Auckland', tier: 'coordination', group_id: 'g1', description: 'd', ...over
  });

  it('selects a channel whose group still carries the retired prefix', () => {
    const result = selectRegionGroupRenames([channel()], { g1: 'tak_Support - Auckland' }, ' - ');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      expectedName: 'tak_Coordination - Auckland',
      currentName: 'tak_Support - Auckland'
    });
    expect(result[0].channel.id).toBe(1);
  });

  it('selects nothing when the name already matches (anti-vacuity: the fixture is present in the map)', () => {
    const groupMap = { g1: 'tak_Coordination - Auckland' };
    expect(Object.keys(groupMap)).toContain('g1');
    expect(selectRegionGroupRenames([channel()], groupMap, ' - ')).toEqual([]);
  });

  it('never touches a channel whose group is absent from the fetched map', () => {
    expect(selectRegionGroupRenames([channel()], {}, ' - ')).toEqual([]);
    expect(selectRegionGroupRenames([channel()], { other: 'tak_Support - Auckland' }, ' - ')).toEqual([]);
  });

  it('skips channels with no group_id or an unknown tier', () => {
    const channels = [
      channel({ id: 1, group_id: null }),
      channel({ id: 2, group_id: '' }),
      channel({ id: 3, tier: 'support', group_id: 'g3' })
    ];
    expect(selectRegionGroupRenames(channels, { g3: 'tak_Support - Auckland' }, ' - ')).toEqual([]);
  });

  it('selects only the mismatching channels from a mixed list', () => {
    const channels = [
      channel({ id: 1, name: 'Auckland', group_id: 'g1' }),
      channel({ id: 2, name: 'Waikato', group_id: 'g2' }),
      channel({ id: 3, name: 'Otago', tier: 'response', group_id: 'g3' })
    ];
    const groupMap = {
      g1: 'tak_Support - Auckland',
      g2: 'tak_Coordination - Waikato',
      g3: 'tak_Response - Otago'
    };
    expect(selectRegionGroupRenames(channels, groupMap, ' - ').map((r) => r.channel.id)).toEqual([1]);
  });

  it('is not fooled by a group pk that collides with an Object.prototype key', () => {
    expect(selectRegionGroupRenames([channel({ group_id: 'toString' })], {}, ' - ')).toEqual([]);
  });
});
