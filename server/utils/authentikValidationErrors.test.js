const { extractMissingUserPks } = require('./authentikValidationErrors');

describe('extractMissingUserPks', () => {
  it('extracts the pk from the exact DRF message under `users`', () => {
    expect(extractMissingUserPks({ users: ['Invalid pk "474" - object does not exist.'] })).toEqual([474]);
  });

  it('extracts several pks in order, de-duplicated', () => {
    expect(
      extractMissingUserPks({
        users: [
          'Invalid pk "9" - object does not exist.',
          'Invalid pk "474" - object does not exist.',
          'Invalid pk "9" - object does not exist.'
        ]
      })
    ).toEqual([9, 474]);
  });

  it('finds messages nested under an index key (the ListField error shape)', () => {
    expect(
      extractMissingUserPks({ users: { 3: ['Invalid pk "12" - object does not exist.'] } })
    ).toEqual([12]);
  });

  it('ignores the same message under a different key', () => {
    expect(extractMissingUserPks({ parent: ['Invalid pk "5" - object does not exist.'] })).toEqual([]);
    expect(extractMissingUserPks({ detail: 'Invalid pk "5" - object does not exist.' })).toEqual([]);
  });

  it('returns only the recognised messages when others are mixed in', () => {
    expect(
      extractMissingUserPks({
        users: ['Invalid pk "7" - object does not exist.', 'Some other validation problem']
      })
    ).toEqual([7]);
  });

  describe('is strict: anything unrecognised yields no pks (the caller then fails as before)', () => {
    it.each([
      ['wrong wording', { users: ['Invalid pk "5" - something else.'] }],
      ['not a pk', { users: ['Invalid pk "abc" - object does not exist.'] }],
      ['negative pk', { users: ['Invalid pk "-5" - object does not exist.'] }],
      ['decimal pk', { users: ['Invalid pk "5.5" - object does not exist.'] }],
      ['empty pk', { users: ['Invalid pk "" - object does not exist.'] }],
      ['extra text before', { users: ['x Invalid pk "5" - object does not exist.'] }],
      ['extra text after', { users: ['Invalid pk "5" - object does not exist. and more'] }],
      ['incorrect type message', { users: ['Incorrect type. Expected pk value, received str.'] }],
      ['huge pk', { users: ['Invalid pk "99999999999999999999" - object does not exist.'] }],
      ['no users key', { name: ['This field is required.'] }],
      ['users is a number', { users: 5 }],
      ['empty object', {}],
      ['empty array', []],
      ['null', null],
      ['undefined', undefined],
      ['a string', 'Invalid pk "5" - object does not exist.'],
      ['a number', 400]
    ])('%s', (_label, body) => {
      expect(extractMissingUserPks(body)).toEqual([]);
    });

    it('does not recurse without limit into a deeply nested body', () => {
      let deep = 'Invalid pk "5" - object does not exist.';
      for (let i = 0; i < 20; i++) deep = [deep];
      expect(extractMissingUserPks({ users: deep })).toEqual([]);
    });
  });
});
