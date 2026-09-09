const { withJobLock, JOB_LOCK_KEYS } = require('./jobLock');

// A fake pg Pool/Client pair that lets a test control what
// pg_try_advisory_lock returns and record every query + release.
function makePool({ locked = true, connectRejects = false, tryLockRejects = false } = {}) {
  const calls = { queries: [], released: 0, connects: 0 };
  const client = {
    query: jest.fn(async (sql, params) => {
      calls.queries.push({ sql, params });
      if (sql.includes('pg_try_advisory_lock')) {
        if (tryLockRejects) throw new Error('try-lock boom');
        return { rows: [{ locked }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      return { rows: [] };
    }),
    release: jest.fn(() => {
      calls.released += 1;
    })
  };
  const pool = {
    connect: jest.fn(async () => {
      calls.connects += 1;
      if (connectRejects) throw new Error('connect boom');
      return client;
    })
  };
  return { pool, client, calls };
}

describe('withJobLock', () => {
  it('runs fn and reports ran:true when the lock is acquired', async () => {
    const { pool, calls } = makePool({ locked: true });
    const fn = jest.fn(async () => {});

    const result = await withJobLock(pool, JOB_LOCK_KEYS.RETENTION_CLEANUP, fn);

    expect(result).toEqual({ ran: true });
    expect(fn).toHaveBeenCalledTimes(1);
    // Locked on the key, then unlocked on the SAME client.
    expect(calls.queries.some((q) => q.sql.includes('pg_try_advisory_lock') && q.params[0] === JOB_LOCK_KEYS.RETENTION_CLEANUP)).toBe(true);
    expect(calls.queries.some((q) => q.sql.includes('pg_advisory_unlock') && q.params[0] === JOB_LOCK_KEYS.RETENTION_CLEANUP)).toBe(true);
    expect(calls.released).toBe(1);
  });

  it('does NOT run fn and reports ran:false when the lock is held by another worker', async () => {
    const { pool, calls } = makePool({ locked: false });
    const fn = jest.fn(async () => {});

    const result = await withJobLock(pool, JOB_LOCK_KEYS.CERT_EXPIRY_NOTIFICATION, fn);

    expect(result).toEqual({ ran: false });
    expect(fn).not.toHaveBeenCalled();
    // Must NOT try to unlock a lock it never acquired.
    expect(calls.queries.some((q) => q.sql.includes('pg_advisory_unlock'))).toBe(false);
    // But the client is still released back to the pool.
    expect(calls.released).toBe(1);
  });

  it('releases the lock even when fn throws, and re-throws', async () => {
    const { pool, calls } = makePool({ locked: true });
    const boom = new Error('fn failed');
    const fn = jest.fn(async () => {
      throw boom;
    });

    await expect(withJobLock(pool, JOB_LOCK_KEYS.DEVICE_SYNC, fn)).rejects.toBe(boom);

    // Unlock happened in finally despite the throw.
    expect(calls.queries.some((q) => q.sql.includes('pg_advisory_unlock'))).toBe(true);
    expect(calls.released).toBe(1);
  });

  it('fails closed (skips fn) when a client cannot be acquired', async () => {
    const { pool, calls } = makePool({ connectRejects: true });
    const fn = jest.fn(async () => {});

    const result = await withJobLock(pool, JOB_LOCK_KEYS.SUBSCRIPTION_POLLER, fn);

    expect(result).toEqual({ ran: false });
    expect(fn).not.toHaveBeenCalled();
    expect(calls.released).toBe(0); // never got a client to release
  });

  it('fails closed (skips fn) when the try-lock query itself throws', async () => {
    const { pool, calls } = makePool({ tryLockRejects: true });
    const fn = jest.fn(async () => {});

    const result = await withJobLock(pool, JOB_LOCK_KEYS.OWNED_GROUP_SWEEP, fn);

    expect(result).toEqual({ ran: false });
    expect(fn).not.toHaveBeenCalled();
    // No lock acquired -> no unlock attempted, but the client is released.
    expect(calls.queries.some((q) => q.sql.includes('pg_advisory_unlock'))).toBe(false);
    expect(calls.released).toBe(1);
  });

  it('two concurrent workers on the same key: exactly one runs', async () => {
    // Model a single real advisory lock shared across two pools: the first
    // try-lock wins (true), the second loses (false) until unlocked.
    let held = false;
    const makeContendingPool = () => ({
      connect: jest.fn(async () => ({
        query: jest.fn(async (sql) => {
          if (sql.includes('pg_try_advisory_lock')) {
            if (held) return { rows: [{ locked: false }] };
            held = true;
            return { rows: [{ locked: true }] };
          }
          if (sql.includes('pg_advisory_unlock')) {
            held = false;
            return { rows: [{ pg_advisory_unlock: true }] };
          }
          return { rows: [] };
        }),
        release: jest.fn()
      }))
    });

    const poolA = makeContendingPool();
    const poolB = makeContendingPool();
    const ranMarks = [];
    const slowFn = (label) => async () => {
      ranMarks.push(label);
      await new Promise((r) => setTimeout(r, 5));
    };

    // Start both "workers" contending on the same key at once.
    const [ra, rb] = await Promise.all([
      withJobLock(poolA, JOB_LOCK_KEYS.CERT_EXPIRY_NOTIFICATION, slowFn('A')),
      withJobLock(poolB, JOB_LOCK_KEYS.CERT_EXPIRY_NOTIFICATION, slowFn('B'))
    ]);

    // Exactly one ran.
    expect([ra.ran, rb.ran].filter(Boolean)).toHaveLength(1);
    expect(ranMarks).toHaveLength(1);
  });

  it('assigns a distinct, frozen key to every locked job (and no key for the credential refresh)', () => {
    const keys = Object.values(JOB_LOCK_KEYS);
    // All distinct.
    expect(new Set(keys).size).toBe(keys.length);
    // Frozen so a key can't be mutated at runtime.
    expect(Object.isFrozen(JOB_LOCK_KEYS)).toBe(true);
    // The locked jobs are present; the credential refresh is deliberately absent.
    expect(Object.keys(JOB_LOCK_KEYS).sort()).toEqual(
      [
        'CALLSIGN_POLLER',
        'CERT_EXPIRY_NOTIFICATION',
        'DEVICE_SYNC',
        'OWNED_GROUP_SWEEP',
        'RETENTION_CLEANUP',
        'SUBSCRIPTION_POLLER'
      ].sort()
    );
  });
});
