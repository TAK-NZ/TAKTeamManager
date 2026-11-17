const { sameMemberSet } = require('./groupMembershipDiff');

describe('sameMemberSet', () => {
  it('is true for identical sets', () => {
    expect(sameMemberSet([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it('ignores order', () => {
    expect(sameMemberSet([3, 1, 2], [2, 3, 1])).toBe(true);
  });

  it('ignores duplicates on either side', () => {
    expect(sameMemberSet([1, 1, 2], [1, 2])).toBe(true);
    expect(sameMemberSet([1, 2], [2, 2, 1, 1])).toBe(true);
  });

  it('treats a number, a numeric string and a padded string as the same pk', () => {
    expect(sameMemberSet([10, '11'], ['10', 11])).toBe(true);
    expect(sameMemberSet([' 10 '], [10])).toBe(true);
  });

  it('is true for two empty sets (an empty group that should stay empty)', () => {
    expect(sameMemberSet([], [])).toBe(true);
  });

  it('is false when the desired set adds a member', () => {
    expect(sameMemberSet([1, 2], [1, 2, 3])).toBe(false);
  });

  it('is false when the desired set removes a member (the PATCH must run)', () => {
    expect(sameMemberSet([1, 2, 3], [1, 2])).toBe(false);
  });

  it('is false for the same size but a different member', () => {
    expect(sameMemberSet([1, 2, 3], [1, 2, 4])).toBe(false);
  });

  it('is false when an empty desired set would clear a populated group', () => {
    expect(sameMemberSet([5], [])).toBe(false);
  });

  it('is false when a populated desired set would fill an empty group', () => {
    expect(sameMemberSet([], [5])).toBe(false);
  });

  describe('is false (never "skip") when anything is doubtful', () => {
    const doubtful = [null, undefined, NaN, Infinity, -1, 1.5, '', '   ', 'abc', {}, [], true];

    it.each(doubtful.map((v) => [String(v), v]))('rejects %s on the current side', (_label, bad) => {
      expect(sameMemberSet([1, bad], [1])).toBe(false);
      expect(sameMemberSet([bad], [bad])).toBe(false);
    });

    it.each(doubtful.map((v) => [String(v), v]))('rejects %s on the desired side', (_label, bad) => {
      expect(sameMemberSet([1], [1, bad])).toBe(false);
    });

    it('rejects a non-array on either side', () => {
      expect(sameMemberSet(null, [])).toBe(false);
      expect(sameMemberSet([], undefined)).toBe(false);
      expect(sameMemberSet('1,2', [1, 2])).toBe(false);
      expect(sameMemberSet(new Set([1]), [1])).toBe(false);
    });
  });
});
