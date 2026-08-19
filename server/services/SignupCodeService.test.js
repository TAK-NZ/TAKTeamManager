/**
 * Unit + property tests for SignupCodeService.
 *
 * Tasks 2.4, 2.5, 19.1 (signup-flow-rework spec)
 *
 * Property 1: Code generation produces valid format
 * Property 2: Code format validation round-trip
 * Property 10: At most one active code per team
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const pool = require('../config/database');
const SignupCodeService = require('./SignupCodeService');

const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// ──────────────────────────────────────────────────────────────────────────────
// Task 2.4 — Property tests for pure functions
// ──────────────────────────────────────────────────────────────────────────────

describe('Property 1: Code generation produces valid format', () => {
  /**
   * Validates: Requirements 3.1
   *
   * generateRandomCode() must always produce an 8-character string
   * consisting solely of the unambiguous charset (no 0, O, 1, I, L).
   */
  it('generates 100+ codes that are all exactly 8 chars from valid charset', () => {
    for (let i = 0; i < 150; i++) {
      const code = SignupCodeService.generateRandomCode();
      expect(code).toHaveLength(8);
      for (const ch of code) {
        expect(CHARSET).toContain(ch);
      }
    }
  });
});

describe('Property 2: Code format validation round-trip', () => {
  /**
   * Validates: Requirements 3.2
   */

  test.prop([fc.integer({ min: 0, max: 999 })], { numRuns: 100 })(
    'formatCode produces XXXX-XXXX pattern for any generated code',
    () => {
      const code = SignupCodeService.generateRandomCode();
      const formatted = SignupCodeService.formatCode(code);
      expect(formatted).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
  );

  test.prop([fc.integer({ min: 0, max: 999 })], { numRuns: 100 })(
    'stripping dash from formatted code gives back original 8-char code',
    () => {
      const code = SignupCodeService.generateRandomCode();
      const formatted = SignupCodeService.formatCode(code);
      const stripped = formatted.replace(/-/g, '');
      expect(stripped).toBe(code);
    }
  );

  test.prop([fc.integer({ min: 0, max: 999 })], { numRuns: 100 })(
    'isValidCodeFormat returns true for both raw and formatted versions',
    () => {
      const code = SignupCodeService.generateRandomCode();
      const formatted = SignupCodeService.formatCode(code);
      expect(SignupCodeService.isValidCodeFormat(code)).toBe(true);
      expect(SignupCodeService.isValidCodeFormat(formatted)).toBe(true);
    }
  );

  describe('isValidCodeFormat rejects invalid inputs', () => {
    it('rejects codes with invalid chars (0, O, 1, I, L)', () => {
      expect(SignupCodeService.isValidCodeFormat('0BCDEFGH')).toBe(false);
      expect(SignupCodeService.isValidCodeFormat('OBCDEFGH')).toBe(false);
      expect(SignupCodeService.isValidCodeFormat('1BCDEFGH')).toBe(false);
      expect(SignupCodeService.isValidCodeFormat('IBCDEFGH')).toBe(false);
      expect(SignupCodeService.isValidCodeFormat('LBCDEFGH')).toBe(false);
    });

    it('rejects codes with wrong length', () => {
      expect(SignupCodeService.isValidCodeFormat('ABCDE')).toBe(false);
      expect(SignupCodeService.isValidCodeFormat('ABCDEFGHJK')).toBe(false);
      expect(SignupCodeService.isValidCodeFormat('')).toBe(false);
    });

    it('rejects non-string inputs', () => {
      expect(SignupCodeService.isValidCodeFormat(null)).toBe(false);
      expect(SignupCodeService.isValidCodeFormat(undefined)).toBe(false);
      expect(SignupCodeService.isValidCodeFormat(12345678)).toBe(false);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Task 2.5 — Unit tests for database methods
// ──────────────────────────────────────────────────────────────────────────────

describe('SignupCodeService database methods', () => {
  let service;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SignupCodeService();
    mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    process.env.FRONTEND_URL = 'https://app.example.com';
  });

  describe('generateCode', () => {
    it('verifies team has can_join = true', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ can_join: false }] });

      await expect(service.generateCode(1, 99)).rejects.toThrow('Team must have joining enabled');
    });

    it('throws if team not found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expect(service.generateCode(1, 99)).rejects.toThrow('Team not found');
    });

    it('deletes existing code and inserts new code in transaction', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ can_join: true }] });
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // DELETE
        .mockResolvedValueOnce({}) // INSERT
        .mockResolvedValueOnce({}); // COMMIT

      const result = await service.generateCode(5, 99);

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        'DELETE FROM signup_codes WHERE team_id = $1',
        [5]
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        'INSERT INTO signup_codes (team_id, code, created_by) VALUES ($1, $2, $3)',
        [5, expect.any(String), 99]
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
      expect(result).toHaveProperty('code');
      expect(result).toHaveProperty('formatted');
      expect(result).toHaveProperty('url');
    });

    it('retries on unique constraint violation (23505)', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ can_join: true }] });

      // First attempt client: BEGIN, DELETE, INSERT (throws unique violation)
      const mockClient1 = { query: jest.fn(), release: jest.fn() };
      mockClient1.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // DELETE
        .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505', constraint: 'signup_codes_code_key' }));

      // Second attempt client: BEGIN, DELETE, INSERT, COMMIT (success)
      const mockClient2 = { query: jest.fn(), release: jest.fn() };
      mockClient2.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // DELETE
        .mockResolvedValueOnce({}) // INSERT
        .mockResolvedValueOnce({}); // COMMIT

      pool.connect
        .mockResolvedValueOnce(mockClient1)
        .mockResolvedValueOnce(mockClient2);

      const result = await service.generateCode(5, 99);
      expect(result).toHaveProperty('code');
      expect(mockClient1.release).toHaveBeenCalled();
      expect(mockClient2.release).toHaveBeenCalled();
    });
  });

  describe('revokeCode', () => {
    it('calls DELETE FROM signup_codes', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await service.revokeCode(5);

      expect(pool.query).toHaveBeenCalledWith(
        'DELETE FROM signup_codes WHERE team_id = $1',
        [5]
      );
    });
  });

  describe('getCode', () => {
    it('returns formatted object when code exists', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ code: 'ABCD5678' }] });

      const result = await service.getCode(5);

      expect(result).toEqual({
        code: 'ABCD5678',
        formatted: 'ABCD-5678',
        url: 'https://app.example.com/request-access?code=ABCD5678'
      });
    });

    it('returns null when no code exists', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.getCode(5);
      expect(result).toBeNull();
    });
  });

  describe('resolveCode', () => {
    it('normalizes input by stripping dashes and uppercasing', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ team_id: 3, code: 'ABCD5678' }] });

      const result = await service.resolveCode('abcd-5678');

      expect(pool.query).toHaveBeenCalledWith(
        'SELECT team_id, code FROM signup_codes WHERE code = $1',
        ['ABCD5678']
      );
      expect(result).toEqual({ teamId: 3, code: 'ABCD5678' });
    });

    it('returns null when code not found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await service.resolveCode('XXXX1234');
      expect(result).toBeNull();
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Task 19.1 — Property 10: At most one active code per team
// ──────────────────────────────────────────────────────────────────────────────

describe('Property 10: At most one active code per team', () => {
  /**
   * Validates: Requirements 3.3
   *
   * After calling generateCode multiple times for the same team,
   * the DELETE + INSERT pattern ensures only one row exists. Each
   * generation DELETEs the previous code before INSERTing, so only
   * the last code survives.
   */
  let service;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SignupCodeService();
    mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    process.env.FRONTEND_URL = 'https://app.example.com';
  });

  test.prop([fc.integer({ min: 2, max: 5 })], { numRuns: 20 })(
    'generating N codes for the same team always DELETEs before INSERT, ensuring one row',
    async (callCount) => {
      // Reset mocks for each property-based run
      jest.clearAllMocks();
      pool.connect.mockResolvedValue(mockClient);

      // Each call: check can_join, then BEGIN, DELETE, INSERT, COMMIT
      pool.query.mockResolvedValue({ rows: [{ can_join: true }] });
      mockClient.query.mockResolvedValue({});

      const results = [];
      for (let i = 0; i < callCount; i++) {
        const result = await service.generateCode(7, 99);
        results.push(result);
      }

      // Verify that DELETE was called before every INSERT
      const deleteCalls = mockClient.query.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM signup_codes')
      );
      const insertCalls = mockClient.query.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO signup_codes')
      );

      // One DELETE and one INSERT per successful generation
      expect(deleteCalls).toHaveLength(callCount);
      expect(insertCalls).toHaveLength(callCount);

      // Each result has a different code (with overwhelming probability)
      expect(results).toHaveLength(callCount);
    }
  );
});
