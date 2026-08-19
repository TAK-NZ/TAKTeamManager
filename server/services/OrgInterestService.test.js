/**
 * Unit + property tests for OrgInterestService.
 *
 * Tasks 5.2, 5.3 (signup-flow-rework spec)
 *
 * Property 9: Excluded domains block only org interest requests
 * Property 11: At most one pending org interest per email
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const pool = require('../config/database');
const OrgInterestService = require('./OrgInterestService');

// ──────────────────────────────────────────────────────────────────────────────
// Task 5.2 — Property tests
// ──────────────────────────────────────────────────────────────────────────────

describe('Property 9: Excluded domains block only org interest requests', () => {
  /**
   * Validates: Requirements 5.1
   *
   * When an email domain is in the excluded list, submitRequest throws.
   * The exclusion check works correctly for the OrgInterestService.
   */
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OrgInterestService();
  });

  test.prop(
    [fc.domain()],
    { numRuns: 30 }
  )(
    'isExcludedDomain returns true when domain is in excluded list',
    async (domain) => {
      pool.query.mockResolvedValueOnce({
        rows: [{ config_value: JSON.stringify([domain.toLowerCase()]) }]
      });

      const result = await service.isExcludedDomain(`user@${domain}`);
      expect(result).toBe(true);
    }
  );

  test.prop(
    [fc.domain()],
    { numRuns: 30 }
  )(
    'isExcludedDomain returns false when domain is NOT in excluded list',
    async (domain) => {
      pool.query.mockResolvedValueOnce({
        rows: [{ config_value: JSON.stringify(['other-domain.xyz']) }]
      });

      // Only fails if domain happens to be 'other-domain.xyz', which is unlikely
      const result = await service.isExcludedDomain(`user@${domain}`);
      if (domain.toLowerCase() !== 'other-domain.xyz') {
        expect(result).toBe(false);
      }
    }
  );

  it('excluded domain blocks submitRequest', async () => {
    pool.query
      // Token validation
      .mockResolvedValueOnce({
        rows: [{ id: 1, requester_email: 'user@blocked.com' }]
      })
      // isExcludedDomain query
      .mockResolvedValueOnce({
        rows: [{ config_value: JSON.stringify(['blocked.com']) }]
      });

    await expect(
      service.submitRequest({ token: 'tok', firstName: 'A', lastName: 'B', orgName: 'C' })
    ).rejects.toThrow('Please use an organisational email address');
  });
});

describe('Property 11: At most one pending org interest per email', () => {
  /**
   * Validates: Requirements 5.2
   *
   * If a pending request already exists for an email, a second
   * submission throws "A request is already pending for this email".
   */
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OrgInterestService();
  });

  it('throws when a pending request already exists', async () => {
    pool.query
      // Token validation
      .mockResolvedValueOnce({
        rows: [{ id: 1, requester_email: 'user@company.com' }]
      })
      // isExcludedDomain — not excluded
      .mockResolvedValueOnce({ rows: [] })
      // Pending check — existing pending row
      .mockResolvedValueOnce({ rows: [{ id: 99 }] });

    await expect(
      service.submitRequest({ token: 'tok', firstName: 'A', lastName: 'B', orgName: 'C' })
    ).rejects.toThrow('A request is already pending for this email');
  });

  test.prop(
    [fc.emailAddress()],
    { numRuns: 20 }
  )(
    'second submission always throws when pending row exists for any email',
    async (email) => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: 1, requester_email: email }] })
        .mockResolvedValueOnce({ rows: [] }) // not excluded
        .mockResolvedValueOnce({ rows: [{ id: 42 }] }); // pending exists

      await expect(
        service.submitRequest({ token: 'tok', firstName: 'A', lastName: 'B', orgName: 'C' })
      ).rejects.toThrow('A request is already pending for this email');
    }
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// Task 5.3 — Unit tests
// ──────────────────────────────────────────────────────────────────────────────

describe('OrgInterestService.isExcludedDomain', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OrgInterestService();
  });

  it('returns true for excluded domain', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ config_value: JSON.stringify(['gmail.com', 'yahoo.com']) }]
    });

    expect(await service.isExcludedDomain('user@gmail.com')).toBe(true);
  });

  it('returns false for non-excluded domain', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ config_value: JSON.stringify(['gmail.com']) }]
    });

    expect(await service.isExcludedDomain('user@company.org')).toBe(false);
  });

  it('returns false when no excluded_email_domains config exists', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    expect(await service.isExcludedDomain('user@anything.com')).toBe(false);
  });

  it('returns false for malformed config_value', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ config_value: 'not-json' }]
    });

    expect(await service.isExcludedDomain('user@test.com')).toBe(false);
  });
});

describe('OrgInterestService.submitRequest', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OrgInterestService();
  });

  it('validates token and throws on invalid/expired', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      service.submitRequest({ token: 'bad', firstName: 'A', lastName: 'B', orgName: 'C' })
    ).rejects.toThrow('Invalid or expired verification token');
  });

  it('checks excluded domain and throws if excluded', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, requester_email: 'user@blocked.com' }] })
      .mockResolvedValueOnce({ rows: [{ config_value: JSON.stringify(['blocked.com']) }] });

    await expect(
      service.submitRequest({ token: 'tok', firstName: 'A', lastName: 'B', orgName: 'C' })
    ).rejects.toThrow('Please use an organisational email address');
  });

  it('checks duplicate pending and throws', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, requester_email: 'user@good.com' }] })
      .mockResolvedValueOnce({ rows: [] }) // not excluded
      .mockResolvedValueOnce({ rows: [{ id: 99 }] }); // duplicate

    await expect(
      service.submitRequest({ token: 'tok', firstName: 'A', lastName: 'B', orgName: 'C' })
    ).rejects.toThrow('A request is already pending for this email');
  });

  it('creates record and deletes access_request on success', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, requester_email: 'user@good.com' }] })
      .mockResolvedValueOnce({ rows: [] }) // not excluded
      .mockResolvedValueOnce({ rows: [] }) // no duplicate
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // INSERT returning id
      .mockResolvedValueOnce({ rows: [] }); // DELETE access_request

    const result = await service.submitRequest({
      token: 'tok', firstName: 'Jane', lastName: 'Doe', orgName: 'MyCorp'
    });

    expect(result).toEqual({ id: 42 });

    // Verify INSERT was called with correct values
    const insertCall = pool.query.mock.calls[3];
    expect(insertCall[0]).toContain('INSERT INTO org_interest_requests');
    expect(insertCall[1]).toEqual(['user@good.com', 'Jane', 'Doe', 'MyCorp']);

    // Verify DELETE access_request was called
    const deleteCall = pool.query.mock.calls[4];
    expect(deleteCall[0]).toContain('DELETE FROM access_requests');
    expect(deleteCall[1]).toEqual([1]);
  });
});

describe('OrgInterestService.updateStatus', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OrgInterestService();
  });

  it('accepts valid status "actioned"', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    await expect(service.updateStatus(1, 'actioned')).resolves.toBeUndefined();
  });

  it('accepts valid status "dismissed"', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    await expect(service.updateStatus(1, 'dismissed')).resolves.toBeUndefined();
  });

  it('rejects invalid status', async () => {
    await expect(service.updateStatus(1, 'approved')).rejects.toThrow('Invalid status');
    await expect(service.updateStatus(1, '')).rejects.toThrow('Invalid status');
  });

  it('throws on not-found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(service.updateStatus(999, 'actioned')).rejects.toThrow('Org interest request not found');
  });
});

describe('OrgInterestService.listRequests', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OrgInterestService();
  });

  it('returns all requests without filter', async () => {
    const mockRows = [
      { id: 1, email: 'a@b.com', status: 'pending' },
      { id: 2, email: 'c@d.com', status: 'actioned' }
    ];
    pool.query.mockResolvedValueOnce({ rows: mockRows });

    const result = await service.listRequests();
    expect(result).toEqual(mockRows);
    expect(pool.query.mock.calls[0][1]).toEqual([]);
  });

  it('filters by status when provided', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, status: 'pending' }] });

    const result = await service.listRequests({ status: 'pending' });
    expect(result).toHaveLength(1);
    expect(pool.query.mock.calls[0][0]).toContain('WHERE status = $1');
    expect(pool.query.mock.calls[0][1]).toEqual(['pending']);
  });
});
