/**
 * MfaResetService: refusals, step order, partial failure, and the audit row.
 */
jest.mock('../config/database', () => ({ query: jest.fn() }));
const mockLogger = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({ createLogger: jest.fn(() => mockLogger) }));
const mockCalls = [];
jest.mock('./authentik', () => ({
  invalidateUserPassword: jest.fn(),
  removeUserAuthenticators: jest.fn(),
  endUserSessions: jest.fn()
}));
const mockSendMfaResetEmail = jest.fn();
jest.mock('./EmailService', () => jest.fn().mockImplementation(() => ({ sendMfaResetEmail: mockSendMfaResetEmail })));
const pool = require('../config/database');
const authentikService = require('./authentik');
const MfaResetService = require('./MfaResetService');
const { MfaResetError } = MfaResetService;
const TARGET = {
  id: 42, email: 'p@example.com', first_name: 'Pat', authentik_user_id: '900',
  is_team_device: false, account_status: 'active', is_authentik_admin: false
};
const ACTOR = { userId: 7, is_global_manager: false };
function target(overrides = {}) {
  pool.query.mockImplementation(async (sql) => (String(sql).includes('FROM users u') ? { rows: [{ ...TARGET, ...overrides }] } : { rows: [] }));
}
function auditRow() {
  const call = pool.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO audit_logs'));
  return call ? { params: call[1], details: JSON.parse(call[1][4]) } : null;
}
describe('MfaResetService.resetMfa', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCalls.length = 0;
    authentikService.invalidateUserPassword.mockImplementation(async () => { mockCalls.push('password'); });
    authentikService.removeUserAuthenticators.mockImplementation(async () => { mockCalls.push('devices'); return { removed: [{}, {}], failed: [] }; });
    authentikService.endUserSessions.mockImplementation(async () => { mockCalls.push('sessions'); return 3; });
    mockSendMfaResetEmail.mockImplementation(async () => { mockCalls.push('email'); });
  });
  it('replaces the password, removes devices, ends sessions, then sends the link, and audits it', async () => {
    target();
    const result = await MfaResetService.resetMfa(42, ACTOR);
    expect(mockCalls).toEqual(['password', 'devices', 'sessions', 'email']);
    expect(authentikService.invalidateUserPassword).toHaveBeenCalledWith('900');
    expect(mockSendMfaResetEmail).toHaveBeenCalledWith('p@example.com', { firstName: 'Pat', activationUserId: '900' }, { actorUserId: 7, targetUserId: 42 });
    expect(result).toEqual({ userId: 42, email: 'p@example.com', devicesRemoved: 2, sessionsEnded: 3 });
    const audit = auditRow();
    expect(audit.params.slice(0, 4)).toEqual([7, 'user.mfa_reset', 'user', 42]);
    expect(audit.details).toMatchObject({ status: 'completed', devicesRemoved: 2, sessionsEnded: 3 });
  });
  it('refuses an unknown user', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await expect(MfaResetService.resetMfa(42, ACTOR)).rejects.toMatchObject({ status: 404 });
    expect(authentikService.invalidateUserPassword).not.toHaveBeenCalled();
  });
  it('refuses a reset of your own account', async () => {
    target();
    await expect(MfaResetService.resetMfa(42, { userId: 42, is_global_manager: true })).rejects.toMatchObject({ status: 400 });
    expect(authentikService.invalidateUserPassword).not.toHaveBeenCalled();
  });
  it('refuses a team device, an account that is not active, and one without a sign-in account or email', async () => {
    for (const overrides of [{ is_team_device: true }, { account_status: 'suspended' }, { account_status: 'orphaned' }, { authentik_user_id: null }, { email: null }]) {
      target(overrides);
      await expect(MfaResetService.resetMfa(42, ACTOR)).rejects.toBeInstanceOf(MfaResetError);
    }
    expect(authentikService.invalidateUserPassword).not.toHaveBeenCalled();
  });
  it('lets only a Global Manager reset an Authentik administrator', async () => {
    target({ is_authentik_admin: true });
    await expect(MfaResetService.resetMfa(42, ACTOR)).rejects.toMatchObject({ status: 403 });
    expect(authentikService.invalidateUserPassword).not.toHaveBeenCalled();
    await expect(MfaResetService.resetMfa(42, { userId: 7, is_global_manager: true })).resolves.toMatchObject({ userId: 42 });
  });
  it('stops before the email when a device cannot be removed, audits it as incomplete, and reports a 502', async () => {
    target();
    authentikService.removeUserAuthenticators.mockResolvedValue({ removed: [{}], failed: [{ kind: 'totp', id: 2, error: 'boom' }] });
    await expect(MfaResetService.resetMfa(42, ACTOR)).rejects.toMatchObject({ status: 502 });
    expect(authentikService.endUserSessions).not.toHaveBeenCalled();
    expect(mockSendMfaResetEmail).not.toHaveBeenCalled();
    expect(auditRow().details).toMatchObject({ status: 'incomplete', devicesRemoved: 1, devicesFailed: 1 });
  });
  it('audits as incomplete when the email cannot be sent', async () => {
    target();
    mockSendMfaResetEmail.mockRejectedValue(new Error('smtp down'));
    await expect(MfaResetService.resetMfa(42, ACTOR)).rejects.toMatchObject({ status: 502 });
    expect(auditRow().details).toMatchObject({ status: 'incomplete', error: 'smtp down', sessionsEnded: 3 });
  });
  it('still returns the result when only the audit write fails', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (String(sql).includes('INSERT INTO audit_logs')) throw new Error('audit down');
      return { rows: [{ ...TARGET }] };
    });
    await expect(MfaResetService.resetMfa(42, ACTOR)).resolves.toMatchObject({ userId: 42 });
  });
});
