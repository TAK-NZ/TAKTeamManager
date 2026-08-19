/**
 * Unit + property tests for SignupFlowService.
 *
 * Tasks 4.5, 4.6 (signup-flow-rework spec)
 *
 * Property 3: Uniform API response
 * Property 5: Team filtering — can_join invariant
 * Property 6: Team filtering — code visibility
 * Property 7: Team filtering — domain restrictions
 * Property 8: Domain restrictions apply even with code
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

const mockSendVerificationEmail = jest.fn().mockResolvedValue({});
const mockSendEmail = jest.fn().mockResolvedValue({});
jest.mock('./EmailService', () => {
  return jest.fn().mockImplementation(() => ({
    sendVerificationEmail: mockSendVerificationEmail,
    sendEmail: mockSendEmail
  }));
});

const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const pool = require('../config/database');
const SignupFlowService = require('./SignupFlowService');

// ──────────────────────────────────────────────────────────────────────────────
// Task 4.5 — Property tests
// ──────────────────────────────────────────────────────────────────────────────

describe('Property 3: Uniform API response', () => {
  /**
   * Validates: Requirements 4.1
   *
   * initiateSignup always returns {message: "Check your email to continue"}
   * regardless of email state.
   */
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SignupFlowService();
  });

  const EMAIL_STATES = ['active', 'pending_approval', 'pending_verification_valid', 'pending_verification_expired', 'new'];

  test.prop(
    [fc.constantFrom(...EMAIL_STATES), fc.emailAddress()],
    { numRuns: 50 }
  )(
    'returns identical message regardless of email state',
    async (state, email) => {
      // Mock determineEmailState to return the given state
      jest.spyOn(service, 'determineEmailState').mockResolvedValue(state);

      // Mock the DB queries that each state branch might need
      pool.query.mockResolvedValue({ rows: [{ email_verification_token: 'tok-123' }] });

      const result = await service.initiateSignup(email, null);
      expect(result).toEqual({ message: 'Check your email to continue' });
    }
  );
});

describe('Property 5: Team filtering — can_join invariant', () => {
  /**
   * Validates: Requirements 4.3
   *
   * Only teams with can_join=true pass the filter. The SQL WHERE clause
   * enforces this; we mock the query response to simulate.
   */
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SignupFlowService();
  });

  test.prop(
    [
      fc.uniqueArray(
        fc.record({
          id: fc.integer({ min: 1, max: 1000 }),
          name: fc.string({ minLength: 1, maxLength: 20 }),
          can_join: fc.boolean()
        }),
        { minLength: 1, maxLength: 10, selector: (t) => t.id }
      )
    ],
    { numRuns: 50 }
  )(
    'only can_join=true teams appear in the result from getAvailableTeams',
    async (teamSpecs) => {
      // The SQL only returns can_join=true teams. Simulate this filtering.
      const canJoinTeams = teamSpecs
        .filter(t => t.can_join)
        .map(t => ({ id: t.id, name: t.name, display_name: t.name }));

      // Mock token validation
      pool.query
        .mockResolvedValueOnce({
          rows: [{ id: 1, requester_email: 'user@example.com', signup_code_used: '' }]
        })
        // Mock the teams query — simulates the SQL filtering
        .mockResolvedValueOnce({ rows: canJoinTeams })
        // Mock code team lookup (no code provided)
        .mockResolvedValue({ rows: [] });

      const result = await service.getAvailableTeams('valid-token', null);

      // All returned teams should be from can_join=true set
      const canJoinIds = new Set(teamSpecs.filter(s => s.can_join).map(s => s.id));
      for (const team of result.teams) {
        expect(canJoinIds.has(team.id)).toBe(true);
      }
    }
  );
});

describe('Property 6: Team filtering — code visibility', () => {
  /**
   * Validates: Requirements 4.4
   *
   * A team with an active code is excluded from results unless the
   * matching code is provided.
   */
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SignupFlowService();
  });

  it('team with active code is excluded when no code provided', async () => {
    // Token validation
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 1, requester_email: 'user@example.com', signup_code_used: '' }]
      })
      // SQL query returns no teams (team has code, no matching code provided)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] });

    const result = await service.getAvailableTeams('valid-token', null);
    expect(result.teams).toHaveLength(0);
  });

  it('team with active code IS included when matching code provided', async () => {
    const teamWithCode = { id: 5, name: 'Coded Team', display_name: 'Coded Team' };

    // Token validation
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 1, requester_email: 'user@example.com', signup_code_used: '' }]
      })
      // SQL returns the team because code matches
      .mockResolvedValueOnce({ rows: [teamWithCode] })
      // Code lookup
      .mockResolvedValueOnce({ rows: [{ team_id: 5 }] });

    const result = await service.getAvailableTeams('valid-token', 'ABCD5678');
    expect(result.teams).toContainEqual(expect.objectContaining({ id: 5 }));
  });
});

describe('Property 7: Team filtering — domain restrictions', () => {
  /**
   * Validates: Requirements 4.5
   *
   * Teams in restricted orgs are excluded for non-matching email domains.
   */
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SignupFlowService();
  });

  it('team in restricted org is excluded for non-matching email domain', async () => {
    // User email: user@other.com, org restricts to: example.com
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 1, requester_email: 'user@other.com', signup_code_used: '' }]
      })
      // SQL returns empty since domain doesn't match
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] });

    const result = await service.getAvailableTeams('valid-token', null);
    expect(result.teams).toHaveLength(0);
  });

  it('team in restricted org IS included for matching email domain', async () => {
    const team = { id: 10, name: 'Restricted Team', display_name: 'Restricted Team' };

    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 1, requester_email: 'user@example.com', signup_code_used: '' }]
      })
      // SQL returns team because domain matches
      .mockResolvedValueOnce({ rows: [team] })
      .mockResolvedValue({ rows: [] });

    const result = await service.getAvailableTeams('valid-token', null);
    expect(result.teams).toContainEqual(expect.objectContaining({ id: 10 }));
  });
});

describe('Property 8: Domain restrictions apply even with code', () => {
  /**
   * Validates: Requirements 4.6
   *
   * A sign-up code does NOT bypass domain restrictions.
   */
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SignupFlowService();
  });

  it('code does not bypass domain restriction — team excluded despite valid code', async () => {
    // User from wrong domain, has valid code for team in restricted org
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 1, requester_email: 'user@wrongdomain.com', signup_code_used: '' }]
      })
      // SQL enforces both code AND domain — returns empty because domain fails
      .mockResolvedValueOnce({ rows: [] })
      // Code resolves to a team
      .mockResolvedValueOnce({ rows: [{ team_id: 5 }] });

    const result = await service.getAvailableTeams('valid-token', 'VALIDCODE');

    // Team is NOT in the list despite having the correct code
    expect(result.teams).toHaveLength(0);
    // codeTeamMessage should explain why
    expect(result.codeTeamMessage).toContain('requires an email address');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Task 4.6 — Unit tests
// ──────────────────────────────────────────────────────────────────────────────

describe('SignupFlowService.determineEmailState', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SignupFlowService();
  });

  it('returns "active" when user exists in users table', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }); // user found

    const state = await service.determineEmailState('user@example.com');
    expect(state).toBe('active');
  });

  it('returns "pending_approval" when email_verified and status=pending', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // no user
      .mockResolvedValueOnce({
        rows: [{
          email_verified: true,
          email_verification_expires_at: new Date(Date.now() + 86400000).toISOString(),
          status: 'pending',
          target_team_id: 42
        }]
      });

    const state = await service.determineEmailState('user@example.com');
    expect(state).toBe('pending_approval');
  });

  it('returns "pending_verification_valid" when unverified with non-expired token', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // no user
      .mockResolvedValueOnce({
        rows: [{
          email_verified: false,
          email_verification_expires_at: new Date(Date.now() + 86400000).toISOString(),
          status: 'pending'
        }]
      });

    const state = await service.determineEmailState('user@example.com');
    expect(state).toBe('pending_verification_valid');
  });

  it('returns "pending_verification_expired" when unverified with expired token', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // no user
      .mockResolvedValueOnce({
        rows: [{
          email_verified: false,
          email_verification_expires_at: new Date(Date.now() - 86400000).toISOString(),
          status: 'pending'
        }]
      });

    const state = await service.determineEmailState('user@example.com');
    expect(state).toBe('pending_verification_expired');
  });

  it('returns "new" when no user and no access request exists', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // no user
      .mockResolvedValueOnce({ rows: [] }); // no access_request

    const state = await service.determineEmailState('user@example.com');
    expect(state).toBe('new');
  });
});

describe('SignupFlowService.initiateSignup', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SignupFlowService();
  });

  it('sends verification email for "new" state', async () => {
    jest.spyOn(service, 'determineEmailState').mockResolvedValue('new');
    pool.query.mockResolvedValue({ rows: [] });

    await service.initiateSignup('new@example.com', null);

    expect(mockSendVerificationEmail).toHaveBeenCalledWith(
      'new@example.com',
      expect.any(String),
      ''
    );
  });

  it('resends existing token for "pending_verification_valid" state', async () => {
    jest.spyOn(service, 'determineEmailState').mockResolvedValue('pending_verification_valid');
    pool.query.mockResolvedValueOnce({ rows: [{ email_verification_token: 'existing-token' }] });

    await service.initiateSignup('pending@example.com', null);

    expect(mockSendVerificationEmail).toHaveBeenCalledWith(
      'pending@example.com',
      'existing-token',
      ''
    );
  });

  it('generates new token for "pending_verification_expired" state', async () => {
    jest.spyOn(service, 'determineEmailState').mockResolvedValue('pending_verification_expired');
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // UPDATE

    await service.initiateSignup('expired@example.com', null);

    expect(mockSendVerificationEmail).toHaveBeenCalled();
  });

  it('sends "still being reviewed" email for "pending_approval" state', async () => {
    jest.spyOn(service, 'determineEmailState').mockResolvedValue('pending_approval');

    await service.initiateSignup('approved@example.com', null);

    expect(mockSendEmail).toHaveBeenCalledWith(
      'approved@example.com',
      'signup_pending_review',
      {}
    );
  });

  it('sends "already active" email for "active" state', async () => {
    jest.spyOn(service, 'determineEmailState').mockResolvedValue('active');

    await service.initiateSignup('active@example.com', null);

    expect(mockSendEmail).toHaveBeenCalledWith(
      'active@example.com',
      'signup_already_active',
      expect.objectContaining({ password_reset_url: expect.any(String) })
    );
  });
});

describe('SignupFlowService.getAvailableTeams — token expiry', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SignupFlowService();
  });

  it('rejects with error when token is expired/invalid', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // token not found

    await expect(service.getAvailableTeams('expired-token', null))
      .rejects.toThrow('Invalid or expired verification link');
  });
});

describe('SignupFlowService.submitTeamAccess — token consumption', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SignupFlowService();
  });

  it('sets email_verified to true on successful submission', async () => {
    // Token validation
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: 1, requester_email: 'user@example.com', signup_code_used: '' }]
      })
      // Eligibility check
      .mockResolvedValueOnce({ rows: [{ id: 5 }] })
      // UPDATE access_request
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.submitTeamAccess({
      token: 'valid-token',
      firstName: 'Jane',
      lastName: 'Doe',
      teamId: 5
    });

    expect(result).toEqual({ requestId: 1 });
    // Verify the UPDATE sets email_verified = true
    const updateCall = pool.query.mock.calls[2];
    expect(updateCall[0]).toContain('email_verified = true');
  });

  it('rejects when token is invalid', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(service.submitTeamAccess({
      token: 'bad-token',
      firstName: 'Jane',
      lastName: 'Doe',
      teamId: 5
    })).rejects.toThrow('Invalid or expired verification link');
  });
});
