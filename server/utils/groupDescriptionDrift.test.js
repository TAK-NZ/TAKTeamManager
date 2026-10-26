const { selectGroupDescriptionDrift } = require('./groupDescriptionDrift');

describe('selectGroupDescriptionDrift', () => {
  const NEW = 'Users from FENZ - Auckland (Bi-directional location sharing)';
  const OLD = 'Users from FENZ - Auckland (Location sharing enabled)';

  it('selects a row whose group still carries the old qualifier', () => {
    const result = selectGroupDescriptionDrift(
      [{ id: 1, group_id: 'g1', description: NEW }],
      { g1: { description: OLD } }
    );
    expect(result).toEqual([{ row: { id: 1, group_id: 'g1', description: NEW }, currentDescription: OLD }]);
  });

  it('selects nothing when descriptions match (anti-vacuity: the group is present)', () => {
    const groups = { g1: { description: NEW } };
    expect(Object.keys(groups)).toContain('g1');
    expect(selectGroupDescriptionDrift([{ id: 1, group_id: 'g1', description: NEW }], groups)).toEqual([]);
  });

  it('treats null/undefined/empty descriptions on either side as equal', () => {
    for (const rowDesc of [null, undefined, '']) {
      for (const groupDesc of [null, undefined, '']) {
        expect(selectGroupDescriptionDrift(
          [{ id: 1, group_id: 'g1', description: rowDesc }],
          { g1: { description: groupDesc } }
        )).toEqual([]);
      }
    }
  });

  it('never touches a row whose group is absent from the fetched map, or that has no group id', () => {
    const rows = [
      { id: 1, group_id: 'missing', description: NEW },
      { id: 2, group_id: null, description: NEW },
      { id: 3, group_id: undefined, description: NEW },
      { id: 4, group_id: '', description: NEW },
      { id: 5, group_id: 'toString', description: NEW }
    ];
    expect(selectGroupDescriptionDrift(rows, { g1: { description: OLD } })).toEqual([]);
  });

  it('compares exactly, with no trimming or case folding', () => {
    const rows = [{ id: 1, group_id: 'g1', description: NEW }];
    expect(selectGroupDescriptionDrift(rows, { g1: { description: `${NEW} ` } })).toHaveLength(1);
    expect(selectGroupDescriptionDrift(rows, { g1: { description: NEW.toLowerCase() } })).toHaveLength(1);
  });
});
