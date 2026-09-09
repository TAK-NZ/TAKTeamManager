const {
  CALLSIGN_MATCH_RESULTS,
  classifyObservedCallsign,
  isCallsignAcceptable
} = require('./callsignMatch');

describe('classifyObservedCallsign', () => {
  const ASSIGNED = 'FENZ-STL-J.Doe';

  it('returns ok when observed exactly equals assigned', () => {
    expect(classifyObservedCallsign(ASSIGNED, ASSIGNED)).toBe(CALLSIGN_MATCH_RESULTS.OK);
  });

  it('returns appended for a space-delimited addition', () => {
    expect(classifyObservedCallsign('FENZ-STL-J.Doe (Tablet)', ASSIGNED)).toBe(
      CALLSIGN_MATCH_RESULTS.APPENDED
    );
  });

  it('returns appended for a hyphen-delimited addition', () => {
    expect(classifyObservedCallsign('FENZ-STL-J.Doe-Drone', ASSIGNED)).toBe(
      CALLSIGN_MATCH_RESULTS.APPENDED
    );
  });

  it('returns appended for a dot-delimited addition', () => {
    expect(classifyObservedCallsign('FENZ-STL-J.Doe.spare', ASSIGNED)).toBe(
      CALLSIGN_MATCH_RESULTS.APPENDED
    );
  });

  it('returns mismatch when the assigned part is altered', () => {
    expect(classifyObservedCallsign('FENZ-XYZ-J.Doe', ASSIGNED)).toBe(
      CALLSIGN_MATCH_RESULTS.MISMATCH
    );
  });

  it('returns mismatch when the assigned callsign is truncated', () => {
    expect(classifyObservedCallsign('FENZ-STL-J.Do', ASSIGNED)).toBe(
      CALLSIGN_MATCH_RESULTS.MISMATCH
    );
  });

  it('returns mismatch when a bare name is used', () => {
    expect(classifyObservedCallsign('J.Doe', ASSIGNED)).toBe(CALLSIGN_MATCH_RESULTS.MISMATCH);
  });

  it('returns mismatch for a longer name that only shares a string prefix (the boundary rule)', () => {
    // `J.Doews` is a different person; a naive startsWith would wrongly accept.
    expect(classifyObservedCallsign('FENZ-STL-J.Doews', ASSIGNED)).toBe(
      CALLSIGN_MATCH_RESULTS.MISMATCH
    );
  });

  it('is case-sensitive: a casing difference in the assigned part is a mismatch', () => {
    expect(classifyObservedCallsign('fenz-stl-J.Doe', ASSIGNED)).toBe(
      CALLSIGN_MATCH_RESULTS.MISMATCH
    );
  });

  it('does not trim: leading whitespace is a mismatch', () => {
    expect(classifyObservedCallsign(' FENZ-STL-J.Doe', ASSIGNED)).toBe(
      CALLSIGN_MATCH_RESULTS.MISMATCH
    );
  });

  describe('absent assigned callsign (teamless user) yields ok — never a manufactured violation', () => {
    it.each([null, undefined, '', 42, {}])('assigned = %p', (assigned) => {
      expect(classifyObservedCallsign('anything', assigned)).toBe(CALLSIGN_MATCH_RESULTS.OK);
    });
  });

  describe('absent observed callsign against a present assignment is a mismatch', () => {
    it.each([null, undefined, '', 42, {}])('observed = %p', (observed) => {
      expect(classifyObservedCallsign(observed, ASSIGNED)).toBe(CALLSIGN_MATCH_RESULTS.MISMATCH);
    });
  });

  it('never throws for arbitrary inputs', () => {
    expect(() => classifyObservedCallsign({ a: 1 }, ['x'])).not.toThrow();
  });
});

describe('isCallsignAcceptable', () => {
  const ASSIGNED = 'FENZ-STL-J.Doe';

  it('is true for exact and appended', () => {
    expect(isCallsignAcceptable(ASSIGNED, ASSIGNED)).toBe(true);
    expect(isCallsignAcceptable('FENZ-STL-J.Doe (Tablet)', ASSIGNED)).toBe(true);
  });

  it('is false for a mismatch', () => {
    expect(isCallsignAcceptable('FENZ-XYZ-J.Doe', ASSIGNED)).toBe(false);
  });

  it('is true (no violation) when assigned is absent', () => {
    expect(isCallsignAcceptable('anything', null)).toBe(true);
  });
});
