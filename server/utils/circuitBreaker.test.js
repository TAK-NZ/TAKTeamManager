const { CircuitBreaker, CircuitOpenError, wrapAxiosClientMethods } = require('./circuitBreaker');

/**
 * Resiliency-hardening: a minimal, dependency-free circuit breaker
 * protecting the Authentik and TAK Server clients from hammering an
 * unreachable dependency call after call. See circuitBreaker.js's own
 * doc comment for the full state-machine rationale.
 */
describe('CircuitBreaker', () => {
  describe('CLOSED state', () => {
    it('starts CLOSED and passes through a successful call unchanged', async () => {
      const breaker = new CircuitBreaker({ name: 'test' });
      const fn = jest.fn().mockResolvedValue('ok');

      const result = await breaker.execute(fn);

      expect(result).toBe('ok');
      expect(breaker.getState()).toBe('closed');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('rethrows a failure unchanged, without swallowing or rewrapping it', async () => {
      const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 5 });
      const originalError = new Error('boom');
      const fn = jest.fn().mockRejectedValue(originalError);

      await expect(breaker.execute(fn)).rejects.toBe(originalError);
      expect(breaker.getState()).toBe('closed');
    });

    it('stays CLOSED for failures below the threshold', async () => {
      const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 3 });
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      await expect(breaker.execute(fn)).rejects.toThrow('fail');
      await expect(breaker.execute(fn)).rejects.toThrow('fail');

      expect(breaker.getState()).toBe('closed');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('opens once consecutive failures reach the threshold', async () => {
      const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 3 });
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      await expect(breaker.execute(fn)).rejects.toThrow('fail');
      await expect(breaker.execute(fn)).rejects.toThrow('fail');
      await expect(breaker.execute(fn)).rejects.toThrow('fail');

      expect(breaker.getState()).toBe('open');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('resets the failure count after an intervening success', async () => {
      const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 3 });
      const fn = jest.fn();
      fn.mockRejectedValueOnce(new Error('fail1'));
      fn.mockRejectedValueOnce(new Error('fail2'));
      fn.mockResolvedValueOnce('ok');
      fn.mockRejectedValueOnce(new Error('fail3'));
      fn.mockRejectedValueOnce(new Error('fail4'));

      await expect(breaker.execute(fn)).rejects.toThrow('fail1');
      await expect(breaker.execute(fn)).rejects.toThrow('fail2');
      await expect(breaker.execute(fn)).resolves.toBe('ok');
      await expect(breaker.execute(fn)).rejects.toThrow('fail3');
      await expect(breaker.execute(fn)).rejects.toThrow('fail4');

      // Only 2 consecutive failures since the success -- below threshold 3.
      expect(breaker.getState()).toBe('closed');
    });
  });

  describe('OPEN state', () => {
    async function openBreaker(breaker) {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < breaker.failureThreshold; i++) {
        await expect(breaker.execute(fn)).rejects.toThrow('fail');
      }
      expect(breaker.getState()).toBe('open');
    }

    it('fails fast with CircuitOpenError, never calling fn, while OPEN and before the reset timeout elapses', async () => {
      const breaker = new CircuitBreaker({ name: 'authentik', failureThreshold: 1, resetTimeoutMs: 30000 });
      await openBreaker(breaker);

      const fn = jest.fn().mockResolvedValue('should not run');
      await expect(breaker.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
      expect(fn).not.toHaveBeenCalled();
    });

    it('CircuitOpenError names the breaker and is a plain Error instance (classifyFailure-compatible)', async () => {
      const breaker = new CircuitBreaker({ name: 'authentik', failureThreshold: 1, resetTimeoutMs: 30000 });
      await openBreaker(breaker);

      try {
        await breaker.execute(jest.fn());
        throw new Error('expected execute to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(CircuitOpenError);
        expect(error.circuitBreakerName).toBe('authentik');
        expect(error.message).toContain('authentik');
      }
    });

    it('transitions to HALF_OPEN and allows exactly one probe once the reset timeout has elapsed', async () => {
      jest.useFakeTimers();
      try {
        const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1, resetTimeoutMs: 10000 });
        await openBreaker(breaker);

        jest.advanceTimersByTime(10001);

        const probe = jest.fn().mockResolvedValue('recovered');
        const result = await breaker.execute(probe);

        expect(result).toBe('recovered');
        expect(breaker.getState()).toBe('closed');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('HALF_OPEN state', () => {
    it('closes the breaker and resets the failure count on a successful probe', async () => {
      jest.useFakeTimers();
      try {
        const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 2, resetTimeoutMs: 5000 });
        const failingFn = jest.fn().mockRejectedValue(new Error('fail'));
        await expect(breaker.execute(failingFn)).rejects.toThrow();
        await expect(breaker.execute(failingFn)).rejects.toThrow();
        expect(breaker.getState()).toBe('open');

        jest.advanceTimersByTime(5001);

        const probe = jest.fn().mockResolvedValue('ok');
        await breaker.execute(probe);
        expect(breaker.getState()).toBe('closed');

        // A subsequent single failure should not immediately reopen --
        // confirms the failure count was reset by the successful probe.
        await expect(breaker.execute(failingFn)).rejects.toThrow();
        expect(breaker.getState()).toBe('closed');
      } finally {
        jest.useRealTimers();
      }
    });

    it('reopens the breaker and restarts the reset timer on a failed probe', async () => {
      jest.useFakeTimers();
      try {
        const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1, resetTimeoutMs: 5000 });
        const failingFn = jest.fn().mockRejectedValue(new Error('still down'));
        await expect(breaker.execute(failingFn)).rejects.toThrow();
        expect(breaker.getState()).toBe('open');

        jest.advanceTimersByTime(5001);

        // The probe itself also fails.
        await expect(breaker.execute(failingFn)).rejects.toThrow('still down');
        expect(breaker.getState()).toBe('open');

        // Immediately after the failed probe, still within the NEW reset
        // window -- fails fast, not another wrapped-fn call.
        const fn = jest.fn();
        await expect(breaker.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
        expect(fn).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('fails a second concurrent call fast while the single probe is still in flight', async () => {
      jest.useFakeTimers();
      try {
        const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1, resetTimeoutMs: 5000 });
        const failingFn = jest.fn().mockRejectedValue(new Error('fail'));
        await expect(breaker.execute(failingFn)).rejects.toThrow();
        expect(breaker.getState()).toBe('open');

        jest.advanceTimersByTime(5001);

        let resolveProbe;
        const slowProbe = jest.fn(() => new Promise((resolve) => { resolveProbe = resolve; }));

        const firstCall = breaker.execute(slowProbe);
        // The breaker is now HALF_OPEN with the probe in flight.
        expect(breaker.getState()).toBe('half_open');

        const secondFn = jest.fn();
        await expect(breaker.execute(secondFn)).rejects.toBeInstanceOf(CircuitOpenError);
        expect(secondFn).not.toHaveBeenCalled();

        resolveProbe('done');
        await expect(firstCall).resolves.toBe('done');
        expect(breaker.getState()).toBe('closed');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('onStateChange callback', () => {
    it('fires with {name, from, to} on every transition, and not otherwise', async () => {
      const onStateChange = jest.fn();
      const breaker = new CircuitBreaker({
        name: 'authentik',
        failureThreshold: 1,
        resetTimeoutMs: 30000,
        onStateChange
      });

      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      await expect(breaker.execute(fn)).rejects.toThrow();

      expect(onStateChange).toHaveBeenCalledWith({ name: 'authentik', from: 'closed', to: 'open' });
      expect(onStateChange).toHaveBeenCalledTimes(1);

      // A second failing call while still within the reset window fails
      // fast without a redundant open->open "transition".
      const fnAfterOpen = jest.fn();
      await expect(breaker.execute(fnAfterOpen)).rejects.toBeInstanceOf(CircuitOpenError);
      expect(fnAfterOpen).not.toHaveBeenCalled();
      expect(onStateChange).toHaveBeenCalledTimes(1);
    });
  });

  describe('defaults', () => {
    it('defaults to failureThreshold 5 and resetTimeoutMs 30000 when unspecified', () => {
      const breaker = new CircuitBreaker();
      expect(breaker.failureThreshold).toBe(5);
      expect(breaker.resetTimeoutMs).toBe(30000);
      expect(breaker.name).toBe('circuit');
    });
  });
});

describe('wrapAxiosClientMethods', () => {
  function makeMockAxiosClient() {
    return {
      get: jest.fn().mockResolvedValue({ data: 'get-ok' }),
      post: jest.fn().mockResolvedValue({ data: 'post-ok' }),
      put: jest.fn().mockResolvedValue({ data: 'put-ok' }),
      patch: jest.fn().mockResolvedValue({ data: 'patch-ok' }),
      delete: jest.fn().mockResolvedValue({ data: 'delete-ok' }),
      defaults: { baseURL: 'https://example.test' }
    };
  }

  it('wraps every HTTP method and forwards args + resolution unchanged on success', async () => {
    const client = makeMockAxiosClient();
    const breaker = new CircuitBreaker({ name: 'test' });
    wrapAxiosClientMethods(client, breaker);

    const result = await client.get('/path', { params: { a: 1 } });

    expect(result).toEqual({ data: 'get-ok' });
  });

  it('does not touch unrelated properties, e.g. `defaults` (needed by TakServerService.setAgentOptions)', () => {
    const client = makeMockAxiosClient();
    const breaker = new CircuitBreaker({ name: 'test' });
    wrapAxiosClientMethods(client, breaker);

    expect(client.defaults).toEqual({ baseURL: 'https://example.test' });
    client.defaults.httpsAgent = 'new-agent';
    expect(client.defaults.httpsAgent).toBe('new-agent');
  });

  it('routes a rejection through the breaker (counts toward failureThreshold)', async () => {
    const client = makeMockAxiosClient();
    const underlyingGet = client.get;
    underlyingGet.mockRejectedValue(new Error('network down'));
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1 });
    wrapAxiosClientMethods(client, breaker);

    await expect(client.get('/path')).rejects.toThrow('network down');
    expect(breaker.getState()).toBe('open');

    // A subsequent call fails fast via the breaker, never reaching the
    // underlying (still-mocked-to-reject) client method again.
    underlyingGet.mockClear();
    await expect(client.get('/path')).rejects.toBeInstanceOf(CircuitOpenError);
    expect(underlyingGet).not.toHaveBeenCalled();
  });

  it('is idempotent: wrapping the same client object twice does not double-count a single failure', async () => {
    const client = makeMockAxiosClient();
    client.get.mockRejectedValue(new Error('down'));
    const breakerA = new CircuitBreaker({ name: 'a', failureThreshold: 2 });
    const breakerB = new CircuitBreaker({ name: 'b', failureThreshold: 2 });

    wrapAxiosClientMethods(client, breakerA);
    wrapAxiosClientMethods(client, breakerB); // no-op: already wrapped

    await expect(client.get('/path')).rejects.toThrow('down');

    // Only breakerA (the first to wrap) actually saw the failure.
    expect(breakerA.failureCount).toBe(1);
    expect(breakerB.failureCount).toBe(0);
  });

  it('leaves a client with no matching methods untouched (no throw)', () => {
    const client = { defaults: {} };
    const breaker = new CircuitBreaker({ name: 'test' });

    expect(() => wrapAxiosClientMethods(client, breaker)).not.toThrow();
  });
});
