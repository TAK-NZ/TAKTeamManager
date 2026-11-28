const { deriveActivationStatus } = require('./activationStatus');
describe('deriveActivationStatus', () => {
  const now = new Date('2026-12-01T00:00:00Z');
  it('is active once there is a sign-in, whatever the window says', () => {
    expect(deriveActivationStatus({ last_login: '2026-11-01T00:00:00Z', activation_expires_at: '2026-10-01T00:00:00Z' }, now)).toBe('active');
    expect(deriveActivationStatus({ last_login: new Date(), activation_expires_at: null }, now)).toBe('active');
  });
  it('is invited while the window is open and expired once it has passed', () => {
    expect(deriveActivationStatus({ last_login: null, activation_expires_at: '2026-12-02T00:00:00Z' }, now)).toBe('invited');
    expect(deriveActivationStatus({ last_login: null, activation_expires_at: '2026-11-30T00:00:00Z' }, now)).toBe('expired');
  });
  it('is unknown (null) with no sign-in and no recorded window, or an unreadable one', () => {
    expect(deriveActivationStatus({ last_login: null, activation_expires_at: null }, now)).toBeNull();
    expect(deriveActivationStatus({}, now)).toBeNull();
    expect(deriveActivationStatus({ activation_expires_at: 'not a date' }, now)).toBeNull();
  });
});
