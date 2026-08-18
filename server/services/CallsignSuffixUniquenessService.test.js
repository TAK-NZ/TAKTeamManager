/**
 * Unit tests for `checkCallsignSuffixUniqueness` (Requirement 11.14,
 * task 23.1). `Team.getFullMemberList` is mocked directly, per the task's
 * own testing instructions.
 */

jest.mock('../models/Team', () => ({
  getFullMemberList: jest.fn()
}));

const Team = require('../models/Team');
const {
  CallsignSuffixConflictError,
  checkCallsignSuffixUniqueness
} = require('./CallsignSuffixUniquenessService');

describe('checkCallsignSuffixUniqueness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves without throwing when no member has a conflicting callsign_suffix', async () => {
    Team.getFullMemberList.mockResolvedValueOnce([
      { id: 1, callsign_suffix: 'J.Doe' },
      { id: 2, callsign_suffix: 'A.Smith' }
    ]);

    await expect(checkCallsignSuffixUniqueness(42, 'J.Bloggs')).resolves.toBeUndefined();
  });

  it('throws CallsignSuffixConflictError naming the conflicting value on a case-insensitive match', async () => {
    Team.getFullMemberList.mockResolvedValueOnce([
      { id: 1, callsign_suffix: 'J.Doe' },
      { id: 2, callsign_suffix: 'A.Smith' }
    ]);

    await expect(checkCallsignSuffixUniqueness(42, 'j.doe')).rejects.toThrow(CallsignSuffixConflictError);

    Team.getFullMemberList.mockResolvedValueOnce([
      { id: 1, callsign_suffix: 'J.Doe' }
    ]);
    try {
      await checkCallsignSuffixUniqueness(42, 'J.DOE');
      throw new Error('expected checkCallsignSuffixUniqueness to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CallsignSuffixConflictError);
      expect(error.conflictingValue).toBe('J.DOE');
    }
  });

  it('does not throw when the candidate value matches only the excluded user\'s own existing value', async () => {
    Team.getFullMemberList.mockResolvedValueOnce([
      { id: 1, callsign_suffix: 'J.Doe' },
      { id: 2, callsign_suffix: 'A.Smith' }
    ]);

    await expect(
      checkCallsignSuffixUniqueness(42, 'J.Doe', 1)
    ).resolves.toBeUndefined();
  });

  it('still throws when the candidate value matches another (non-excluded) member, even with excludeUserId set', async () => {
    Team.getFullMemberList.mockResolvedValueOnce([
      { id: 1, callsign_suffix: 'J.Doe' },
      { id: 2, callsign_suffix: 'A.Smith' }
    ]);

    await expect(
      checkCallsignSuffixUniqueness(42, 'a.smith', 1)
    ).rejects.toThrow(CallsignSuffixConflictError);
  });

  it.each([null, undefined, ''])(
    'never throws and never calls getFullMemberList for a %p candidate value',
    async (candidateValue) => {
      await expect(checkCallsignSuffixUniqueness(42, candidateValue)).resolves.toBeUndefined();
      expect(Team.getFullMemberList).not.toHaveBeenCalled();
    }
  );

  it('does not crash when a member in the list has a null callsign_suffix', async () => {
    Team.getFullMemberList.mockResolvedValueOnce([
      { id: 1, callsign_suffix: null },
      { id: 2, callsign_suffix: 'A.Smith' }
    ]);

    await expect(checkCallsignSuffixUniqueness(42, 'J.Doe')).resolves.toBeUndefined();
  });
});
