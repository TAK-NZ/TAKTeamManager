const { fetchWithTimeout, DEFAULT_FETCH_TIMEOUT_MS } = require('./fetchWithTimeout');

/**
 * Resiliency-hardening: `fetchWithTimeout` always attaches a bounded
 * `signal` to the underlying `fetch` call, so a hung connection can
 * never leave a caller waiting indefinitely -- unlike native `fetch`,
 * which has no default timeout at all.
 */
describe('fetchWithTimeout', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('calls the underlying fetch with the same url and options', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await fetchWithTimeout('https://example.com/api', { method: 'POST', body: '{}' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://example.com/api');
    expect(options.method).toBe('POST');
    expect(options.body).toBe('{}');
  });

  it('attaches a signal that is an instance of AbortSignal', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    await fetchWithTimeout('https://example.com/api', {});

    const [, options] = global.fetch.mock.calls[0];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('defaults to DEFAULT_FETCH_TIMEOUT_MS (10000ms) when no timeout is specified', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');

    await fetchWithTimeout('https://example.com/api', {});

    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_FETCH_TIMEOUT_MS);
    timeoutSpy.mockRestore();
  });

  it('respects a custom timeout when supplied', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');

    await fetchWithTimeout('https://example.com/api', {}, 5000);

    expect(timeoutSpy).toHaveBeenCalledWith(5000);
    timeoutSpy.mockRestore();
  });

  it('rejects once the timeout elapses, for a fetch that never settles on its own', async () => {
    global.fetch = jest.fn().mockImplementation((url, { signal }) => {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    });

    await expect(fetchWithTimeout('https://example.com/api', {}, 10)).rejects.toThrow();
  });

  it('preserves a caller-supplied signal alongside the timeout, aborting on either', async () => {
    global.fetch = jest.fn().mockImplementation((url, { signal }) => {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    });

    const callerController = new AbortController();
    const fetchPromise = fetchWithTimeout('https://example.com/api', { signal: callerController.signal });
    callerController.abort();

    await expect(fetchPromise).rejects.toThrow();
  });

  it('resolves normally when the underlying fetch settles well within the timeout', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await fetchWithTimeout('https://example.com/api', {});

    expect(result).toEqual({ ok: true, status: 200 });
  });
});
