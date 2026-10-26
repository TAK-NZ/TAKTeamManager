const { buildRegionGroupName, selectRegionGroupUpdates } = require('./regionGroupName');

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

describe('selectRegionGroupUpdates', () => {
  const channel = (over = {}) => ({
    id: 1, name: 'Auckland', tier: 'coordination', group_id: 'g1',
    description: 'Auckland (Coordination - All Agencies) (Bi-directional location sharing)', ...over
  });
  const inSync = {
    g1: {
      name: 'tak_Coordination - Auckland',
      description: 'Auckland (Coordination - All Agencies) (Bi-directional location sharing)'
    }
  };

  it('selects a channel whose group still carries the retired prefix', () => {
    const groups = { g1: { ...inSync.g1, name: 'tak_Support - Auckland' } };
    const result = selectRegionGroupUpdates([channel()], groups, ' - ');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      expectedName: 'tak_Coordination - Auckland',
      currentName: 'tak_Support - Auckland',
      nameDrift: true,
      descriptionDrift: false
    });
  });

  it('selects a channel whose group description lacks the location-sharing suffix', () => {
    const groups = { g1: { ...inSync.g1, description: 'Auckland (Coordination - All Agencies)' } };
    const result = selectRegionGroupUpdates([channel()], groups, ' - ');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ nameDrift: false, descriptionDrift: true });
  });

  it('treats a missing group description as empty, and a null row description as empty', () => {
    const noAttrs = { g1: { name: 'tak_Coordination - Auckland' } };
    expect(selectRegionGroupUpdates([channel()], noAttrs, ' - ')).toHaveLength(1);
    expect(selectRegionGroupUpdates([channel({ description: null })], noAttrs, ' - ')).toEqual([]);
    expect(selectRegionGroupUpdates([channel({ description: '' })], noAttrs, ' - ')).toEqual([]);
  });

  it('selects nothing when name and description both match (anti-vacuity: the fixture is present)', () => {
    expect(Object.keys(inSync)).toContain('g1');
    expect(selectRegionGroupUpdates([channel()], inSync, ' - ')).toEqual([]);
  });

  it('never touches a channel whose group is absent from the fetched map', () => {
    expect(selectRegionGroupUpdates([channel()], {}, ' - ')).toEqual([]);
    expect(selectRegionGroupUpdates([channel()], { other: inSync.g1 }, ' - ')).toEqual([]);
  });

  it('skips channels with no group_id or an unknown tier', () => {
    const channels = [
      channel({ id: 1, group_id: null }),
      channel({ id: 2, group_id: '' }),
      channel({ id: 3, tier: 'support', group_id: 'g3' })
    ];
    const groups = { g3: { name: 'tak_Support - Auckland', description: 'x' } };
    expect(selectRegionGroupUpdates(channels, groups, ' - ')).toEqual([]);
  });

  it('selects only the drifted channels from a mixed list', () => {
    const channels = [
      channel({ id: 1, name: 'Auckland', group_id: 'g1' }),
      channel({ id: 2, name: 'Waikato', group_id: 'g2', description: 'W' }),
      channel({ id: 3, name: 'Otago', tier: 'response', group_id: 'g3', description: 'O' })
    ];
    const groups = {
      g1: inSync.g1,
      g2: { name: 'tak_Coordination - Waikato', description: 'W' },
      g3: { name: 'tak_Response - Otago', description: 'old' }
    };
    expect(selectRegionGroupUpdates(channels, groups, ' - ').map((r) => r.channel.id)).toEqual([3]);
  });

  it('is not fooled by a group pk that collides with an Object.prototype key', () => {
    expect(selectRegionGroupUpdates([channel({ group_id: 'toString' })], {}, ' - ')).toEqual([]);
  });
});
