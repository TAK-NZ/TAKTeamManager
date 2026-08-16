const { createGracefulShutdown, DEFAULT_GRACE_PERIOD_MS } = require('./gracefulShutdown');

function buildLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
}

describe('createGracefulShutdown', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('closes the server and the DB pool, then exits 0, when the server closes before the grace period', async () => {
    const closeCallbacks = [];
    const server = {
      close: jest.fn((cb) => {
        closeCallbacks.push(cb);
      })
    };
    const pool = { end: jest.fn().mockResolvedValue(undefined) };
    const logger = buildLogger();
    const exit = jest.fn();

    const gracefulShutdown = createGracefulShutdown({ server, pool, logger, exit });

    const shutdownPromise = gracefulShutdown('SIGTERM');

    // Simulate server.close()'s callback firing (all in-flight requests done)
    // well within the 30s grace period.
    closeCallbacks[0]();

    await shutdownPromise;

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('forces closure (proceeds to close the pool and exit) when the grace period elapses before in-flight requests complete', async () => {
    // server.close() never invokes its callback, simulating in-flight
    // requests that don't finish within the grace period (Criterion 8.4).
    const server = { close: jest.fn() };
    const pool = { end: jest.fn().mockResolvedValue(undefined) };
    const logger = buildLogger();
    const exit = jest.fn();

    const gracefulShutdown = createGracefulShutdown({ server, pool, logger, exit });

    const shutdownPromise = gracefulShutdown('SIGTERM');

    // Advance past the 30s grace period so the timeout branch of the
    // Promise.race wins.
    await jest.advanceTimersByTimeAsync(DEFAULT_GRACE_PERIOD_MS + 1);
    await shutdownPromise;

    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'SIGTERM' }),
      expect.stringContaining('grace period elapsed')
    );
  });

  it('exits with the provided exit code (e.g. 1 for uncaughtException)', async () => {
    const closeCallbacks = [];
    const server = {
      close: jest.fn((cb) => {
        closeCallbacks.push(cb);
      })
    };
    const pool = { end: jest.fn().mockResolvedValue(undefined) };
    const logger = buildLogger();
    const exit = jest.fn();

    const gracefulShutdown = createGracefulShutdown({ server, pool, logger, exit });

    const shutdownPromise = gracefulShutdown('uncaughtException', { exitCode: 1 });
    closeCallbacks[0]();
    await shutdownPromise;

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('is idempotent: a second call while shutdown is in progress does not close the pool twice', async () => {
    const closeCallbacks = [];
    const server = {
      close: jest.fn((cb) => {
        closeCallbacks.push(cb);
      })
    };
    const pool = { end: jest.fn().mockResolvedValue(undefined) };
    const logger = buildLogger();
    const exit = jest.fn();

    const gracefulShutdown = createGracefulShutdown({ server, pool, logger, exit });

    const first = gracefulShutdown('SIGTERM');
    const second = gracefulShutdown('SIGINT');

    closeCallbacks[0]();

    await Promise.all([first, second]);

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('still closes the DB pool and exits when server.close() errors', async () => {
    const closeCallbacks = [];
    const server = {
      close: jest.fn((cb) => {
        closeCallbacks.push(cb);
      })
    };
    const pool = { end: jest.fn().mockResolvedValue(undefined) };
    const logger = buildLogger();
    const exit = jest.fn();

    const gracefulShutdown = createGracefulShutdown({ server, pool, logger, exit });

    const shutdownPromise = gracefulShutdown('SIGTERM');
    closeCallbacks[0](new Error('close failed'));
    await shutdownPromise;

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'SIGTERM' }),
      expect.stringContaining('Error while closing HTTP server')
    );
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
