jest.mock('../../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../../config/database');
const CallsignPoller = require('../CallsignPoller');
const { reduceObservedCallsigns } = require('../CallsignPoller');

/**
 * Unit tests for `CallsignPoller` (callsign-mismatch detection,
 * docs/ARCHITECTURE.md ("Callsign Mismatch Detection" section)): the live-subscription reducer, the
 * mismatch-episode latch state machine, and the post-commit best-effort email.
 * Mocked collaborators only. The append-only comparison rule itself has its own
 * property test (`server/utils/callsignMatch.property.test.js`); these are
 * example/unit tests of the poller's orchestration.
 */

function subscription(overrides = {}) {
  return {
    callsign: 'FENZ-STL-J.Doe',
    clientUid: 'ANDROID-842f08e120efdbe3',
    username: 'jdoe',
    dn: 'CN=jdoe',
    lastReportMilliseconds: 1000,
    ...overrides
  };
}

function makePoller({ subscriptions = [], sendEmail } = {}) {
  const takServerService = {
    getAllSubscriptions: jest.fn().mockResolvedValue(subscriptions)
  };
  const emailService = { sendEmail: sendEmail || jest.fn().mockResolvedValue({ messageId: 'x' }) };
  const poller = new CallsignPoller({ takServerService, pool, emailService });
  return { poller, takServerService, emailService };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reduceObservedCallsigns', () => {
  it('keeps a real client entry keyed by clientUid', () => {
    const map = reduceObservedCallsigns([subscription()]);
    expect(map.get('ANDROID-842f08e120efdbe3')).toBe('FENZ-STL-J.Doe');
  });

  it('drops entries with a blank/missing clientUid (API-only/ETL sessions)', () => {
    const map = reduceObservedCallsigns([
      subscription({ clientUid: '' }),
      subscription({ clientUid: undefined, callsign: 'X' }),
      { callsign: 'etl-only', dn: 'CN=etl' }
    ]);
    expect(map.size).toBe(0);
  });

  it('drops CloudTAK entries by the ANDROID-CloudTAK- cert prefix', () => {
    const map = reduceObservedCallsigns([
      subscription({ clientUid: 'ANDROID-CloudTAK-jdoe@example.com', callsign: 'WHATEVER' })
    ]);
    expect(map.size).toBe(0);
  });

  it('drops entries with no usable callsign', () => {
    const map = reduceObservedCallsigns([
      subscription({ callsign: '' }),
      subscription({ clientUid: 'UID2', callsign: undefined })
    ]);
    expect(map.size).toBe(0);
  });

  it('keeps the most recent entry per clientUid by lastReportMilliseconds', () => {
    const map = reduceObservedCallsigns([
      subscription({ callsign: 'OLD', lastReportMilliseconds: 100 }),
      subscription({ callsign: 'NEW', lastReportMilliseconds: 900 })
    ]);
    expect(map.get('ANDROID-842f08e120efdbe3')).toBe('NEW');
  });

  it('is total against hostile input', () => {
    expect(() => reduceObservedCallsigns([null, 42, {}, { clientUid: 5 }])).not.toThrow();
    expect(reduceObservedCallsigns([null, 42, {}]).size).toBe(0);
  });
});

describe('run(): latch state machine', () => {
  // Helper: stub the device-row load once, then let the UPDATE statements
  // resolve with whatever RETURNING the state machine needs.
  function stubDeviceRow(row) {
    // loadDeviceForUid SELECT
    pool.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('FROM tak_devices d')) {
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    });
  }

  it('acceptable observation clears the latch (no email)', async () => {
    const { poller, emailService } = makePoller({ subscriptions: [subscription()] });
    stubDeviceRow({ email: 'j@example.com', first_name: 'J', tak_callsign: 'FENZ-STL-J.Doe' });

    const counts = await poller.run();

    expect(counts.acceptable).toBe(1);
    expect(counts.mismatched).toBe(0);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    // The acceptable UPDATE nulls both latch columns.
    const acceptableUpdate = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('callsign_violation_notified_at = NULL')
    );
    expect(acceptableUpdate).toBeTruthy();
  });

  it('an append is acceptable (no email)', async () => {
    const { poller, emailService } = makePoller({
      subscriptions: [subscription({ callsign: 'FENZ-STL-J.Doe (Tablet)' })]
    });
    stubDeviceRow({ email: 'j@example.com', first_name: 'J', tak_callsign: 'FENZ-STL-J.Doe' });

    const counts = await poller.run();

    expect(counts.acceptable).toBe(1);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('first mismatching poll opens an episode but sends NO email (debounce)', async () => {
    const { poller, emailService } = makePoller({
      subscriptions: [subscription({ callsign: 'FENZ-WRONG' })]
    });
    pool.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('FROM tak_devices d')) {
        return { rows: [{ email: 'j@example.com', first_name: 'J', tak_callsign: 'FENZ-STL-J.Doe' }] };
      }
      if (typeof sql === 'string' && sql.includes('COALESCE(callsign_violation_first_seen_at')) {
        // was NULL -> this poll opens the episode
        return { rows: [{ was_first_seen: true, already_notified: false }] };
      }
      return { rows: [] };
    });

    const counts = await poller.run();

    expect(counts.mismatched).toBe(1);
    expect(counts.firstSeen).toBe(1);
    expect(counts.emailed).toBe(0);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('second consecutive mismatching poll sends exactly one email and stamps notified', async () => {
    const { poller, emailService } = makePoller({
      subscriptions: [subscription({ callsign: 'FENZ-WRONG' })]
    });
    const markNotified = [];
    pool.query.mockImplementation(async (sql, params) => {
      if (typeof sql === 'string' && sql.includes('FROM tak_devices d')) {
        return { rows: [{ email: 'j@example.com', first_name: 'J', tak_callsign: 'FENZ-STL-J.Doe' }] };
      }
      if (typeof sql === 'string' && sql.includes('COALESCE(callsign_violation_first_seen_at')) {
        // episode already open, not yet notified -> confirmed
        return { rows: [{ was_first_seen: false, already_notified: false }] };
      }
      if (typeof sql === 'string' && sql.includes('callsign_violation_notified_at = NOW()')) {
        markNotified.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    });

    const counts = await poller.run();

    expect(counts.emailed).toBe(1);
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendEmail).toHaveBeenCalledWith(
      'j@example.com',
      'callsign_mismatch_notice',
      expect.objectContaining({
        assigned_callsign: 'FENZ-STL-J.Doe',
        observed_callsign: 'FENZ-WRONG'
      })
    );
    // notified_at stamped exactly once, after the send.
    expect(markNotified).toHaveLength(1);
  });

  it('an already-notified episode sends nothing', async () => {
    const { poller, emailService } = makePoller({
      subscriptions: [subscription({ callsign: 'FENZ-WRONG' })]
    });
    pool.query.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('FROM tak_devices d')) {
        return { rows: [{ email: 'j@example.com', first_name: 'J', tak_callsign: 'FENZ-STL-J.Doe' }] };
      }
      if (typeof sql === 'string' && sql.includes('COALESCE(callsign_violation_first_seen_at')) {
        return { rows: [{ was_first_seen: false, already_notified: true }] };
      }
      return { rows: [] };
    });

    const counts = await poller.run();

    expect(counts.mismatched).toBe(1);
    expect(counts.emailed).toBe(0);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('a confirmed mismatch for a user with no email does not send and does not stamp', async () => {
    const { poller, emailService } = makePoller({
      subscriptions: [subscription({ callsign: 'FENZ-WRONG' })]
    });
    const stampCalls = [];
    pool.query.mockImplementation(async (sql, params) => {
      if (typeof sql === 'string' && sql.includes('FROM tak_devices d')) {
        return { rows: [{ email: null, first_name: 'J', tak_callsign: 'FENZ-STL-J.Doe' }] };
      }
      if (typeof sql === 'string' && sql.includes('COALESCE(callsign_violation_first_seen_at')) {
        return { rows: [{ was_first_seen: false, already_notified: false }] };
      }
      if (typeof sql === 'string' && sql.includes('callsign_violation_notified_at = NOW()')) {
        stampCalls.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    });

    const counts = await poller.run();

    expect(counts.emailed).toBe(0);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(stampCalls).toHaveLength(0);
    expect(mockLoggerInstance.warn).toHaveBeenCalled();
  });

  it('a failed email send does NOT stamp notified (retries next poll)', async () => {
    const sendEmail = jest.fn().mockRejectedValue(new Error('smtp down'));
    const { poller } = makePoller({
      subscriptions: [subscription({ callsign: 'FENZ-WRONG' })],
      sendEmail
    });
    const stampCalls = [];
    pool.query.mockImplementation(async (sql, params) => {
      if (typeof sql === 'string' && sql.includes('FROM tak_devices d')) {
        return { rows: [{ email: 'j@example.com', first_name: 'J', tak_callsign: 'FENZ-STL-J.Doe' }] };
      }
      if (typeof sql === 'string' && sql.includes('COALESCE(callsign_violation_first_seen_at')) {
        return { rows: [{ was_first_seen: false, already_notified: false }] };
      }
      if (typeof sql === 'string' && sql.includes('callsign_violation_notified_at = NOW()')) {
        stampCalls.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    });

    const counts = await poller.run();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(counts.emailed).toBe(0);
    expect(counts.failed).toBe(1);
    expect(stampCalls).toHaveLength(0);
  });

  it('a teamless user (no assigned callsign) is acceptable, never a violation', async () => {
    const { poller, emailService } = makePoller({
      subscriptions: [subscription({ callsign: 'ANYTHING' })]
    });
    stubDeviceRow({ email: 'j@example.com', first_name: 'J', tak_callsign: null });

    const counts = await poller.run();

    expect(counts.mismatched).toBe(0);
    expect(counts.acceptable).toBe(1);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  it('a reported uid with no matching device row is skipped, not an error', async () => {
    const { poller } = makePoller({ subscriptions: [subscription()] });
    stubDeviceRow(null);

    const counts = await poller.run();

    expect(counts.matched).toBe(0);
    expect(counts.failed).toBe(0);
  });
});

describe('run(): fetch failure handling', () => {
  it('a fetch rejection returns undefined and writes nothing', async () => {
    const takServerService = {
      getAllSubscriptions: jest.fn().mockRejectedValue(new Error('unreachable'))
    };
    const poller = new CallsignPoller({ takServerService, pool, emailService: { sendEmail: jest.fn() } });

    const result = await poller.run();

    expect(result).toBeUndefined();
    expect(pool.query).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalled();
  });

  it('a non-array payload returns undefined and writes nothing', async () => {
    const takServerService = {
      getAllSubscriptions: jest.fn().mockResolvedValue({ not: 'an array' })
    };
    const poller = new CallsignPoller({ takServerService, pool, emailService: { sendEmail: jest.fn() } });

    const result = await poller.run();

    expect(result).toBeUndefined();
    expect(pool.query).not.toHaveBeenCalled();
  });
});
