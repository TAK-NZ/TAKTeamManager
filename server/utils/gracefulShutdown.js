/**
 * Graceful shutdown (Requirement 8: Handle Process-Level Errors Without
 * Crashing or Corrupting State)
 *
 * Criterion 8.4: WHEN the App receives `SIGTERM`, `SIGINT`, or an
 * `uncaughtException` requiring shutdown, THE App SHALL stop accepting new
 * HTTP connections, allow in-flight requests up to 30 seconds to complete,
 * close the database pool, and then exit; IF in-flight requests have not
 * completed within 30 seconds, THEN THE App SHALL immediately proceed to
 * close the database pool and exit without further waiting.
 *
 * The shutdown sequence is extracted into this standalone, dependency-
 * injected module (rather than being written inline in `server/index.js`)
 * so that the timeout-fallback behavior can be unit tested against mocked
 * `server`/`pool`/`exit` collaborators without needing a real HTTP server
 * or database connection.
 */

const DEFAULT_GRACE_PERIOD_MS = 30000;

/**
 * Wraps `server.close()` in a promise, matching the callback semantics of
 * `net.Server#close` (its callback fires once all in-flight connections
 * have ended).
 *
 * @param {import('http').Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Resolves with the literal string `'timeout'` after `ms` milliseconds.
 * Raced against `closeServer()` so in-flight requests are given at most
 * `ms` to finish before shutdown proceeds regardless (Criterion 8.4).
 *
 * @param {number} ms
 * @returns {Promise<'timeout'>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(() => resolve('timeout'), ms);
  });
}

/**
 * Builds a `gracefulShutdown(signal, options)` function bound to the given
 * HTTP server, database pool, and logger.
 *
 * The returned function is idempotent: once a shutdown has begun, a
 * subsequent call (e.g. `SIGTERM` followed quickly by `SIGINT`, or an
 * `uncaughtException` firing during an in-progress `SIGTERM` shutdown) is a
 * no-op, so the pool is never closed and the process never exits twice.
 *
 * @param {object} deps
 * @param {import('http').Server} deps.server - the HTTP server returned by `app.listen()`
 * @param {import('pg').Pool} deps.pool - the database pool to close (must expose an `end()` returning a Promise)
 * @param {{info: Function, warn: Function, error: Function}} deps.logger - structured logger (Requirement 13)
 * @param {number} [deps.gracePeriodMs] - defaults to 30000 (Criterion 8.4)
 * @param {(code: number) => void} [deps.exit] - injectable in place of `process.exit` for testing
 * @returns {(signal: string, options?: { exitCode?: number }) => Promise<void>}
 */
function createGracefulShutdown({
  server,
  pool,
  logger,
  gracePeriodMs = DEFAULT_GRACE_PERIOD_MS,
  exit = (code) => process.exit(code)
}) {
  let shuttingDown = false;

  return async function gracefulShutdown(signal, options = {}) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    const exitCode = options.exitCode || 0;

    logger.info({ signal }, 'Graceful shutdown initiated');

    try {
      const outcome = await Promise.race([
        closeServer(server).then(() => 'closed'),
        delay(gracePeriodMs)
      ]);

      if (outcome === 'timeout') {
        logger.warn(
          { signal, gracePeriodMs },
          'Graceful shutdown grace period elapsed before in-flight requests completed; forcing closure'
        );
      } else {
        logger.info({ signal }, 'HTTP server closed; no longer accepting new connections');
      }
    } catch (err) {
      logger.error({ err, signal }, 'Error while closing HTTP server during shutdown');
    }

    try {
      await pool.end();
      logger.info({ signal }, 'Database pool closed');
    } catch (err) {
      logger.error({ err, signal }, 'Error while closing database pool during shutdown');
    }

    exit(exitCode);
  };
}

module.exports = { createGracefulShutdown, DEFAULT_GRACE_PERIOD_MS };
