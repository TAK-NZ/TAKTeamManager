/**
 * Unit tests for server/config/logger.js (Requirement 13.6).
 *
 * `logger.js` decides, at module-require time, whether to wire pino's
 * `redact` option in at all based on `process.env.LOG_LEVEL`: redaction is
 * included for every level EXCEPT `debug`. That means the only way to
 * observe "redacted at info, unredacted at debug" is to re-require the
 * module fresh with a different `LOG_LEVEL` set beforehand for each case
 * (`jest.isolateModules` + `jest.doMock`, mirroring the pattern already
 * used in `server/config/configValidator.test.js` and
 * `server/services/CredentialEncryptionService.test.js` for modules that
 * read `process.env` once at require time).
 *
 * Output-capture approach: pino's default destination (when none is
 * passed to the `pino(options)` call) writes directly to fd 1 via
 * sonic-boom, which bypasses `process.stdout.write` entirely -- spying on
 * `process.stdout.write` would not reliably observe pino's output. Instead,
 * this test mocks the `pino` module itself to wrap the REAL `pino` package
 * (`jest.requireActual('pino')`) so that whatever options `logger.js`
 * builds (including the real `redact` config and the real censor value)
 * are passed through unchanged to the real pino constructor, but with a
 * second `destination` argument: a plain object exposing a synchronous
 * `write(str)` method that pino accepts directly (no sonic-boom wrapping
 * needed for a non-fd/non-path destination). This lets the test assert on
 * pino's actual, real JSON output rather than re-implementing the
 * redaction logic under test.
 */

function loadLoggerWithCapture(logLevel) {
  if (logLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = logLevel;
  }

  const rawLines = [];
  const captureDestination = {
    write(msg) {
      rawLines.push(msg);
    }
  };

  let loggerModule;
  jest.isolateModules(() => {
    jest.doMock('pino', () => {
      const actualPino = jest.requireActual('pino');
      const wrappedPino = (options) => actualPino(options, captureDestination);
      // `logger.js` reads `pino.stdTimeFunctions.isoTime`, and pino attaches
      // several other static helpers to the exported function itself --
      // copy them over so the wrapped mock behaves like the real module.
      Object.assign(wrappedPino, actualPino);
      return wrappedPino;
    });
    loggerModule = require('./logger');
  });

  return {
    logger: loggerModule,
    getLogLines: () =>
      rawLines
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
  };
}

describe('server/config/logger redaction (Requirement 13.6)', () => {
  const ORIGINAL_LOG_LEVEL = process.env.LOG_LEVEL;

  afterEach(() => {
    if (ORIGINAL_LOG_LEVEL === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = ORIGINAL_LOG_LEVEL;
    }
    jest.resetModules();
  });

  const samplePayload = () => ({
    email: 'test@example.com',
    password: 'secret123',
    someOtherField: 'visible-value',
    req: { body: { email: 'nested-req-body@example.com' } },
    user: { email: 'nested-user@example.com' }
  });

  describe('at the default (info) level', () => {
    it('redacts top-level email and password fields', () => {
      const { logger, getLogLines } = loadLoggerWithCapture(undefined);

      logger.info(samplePayload(), 'test message');

      const [line] = getLogLines();
      expect(line.email).toBe('[REDACTED]');
      expect(line.password).toBe('[REDACTED]');
    });

    it('redacts nested req.body.email and user.email fields', () => {
      const { logger, getLogLines } = loadLoggerWithCapture('info');

      logger.info(samplePayload(), 'test message');

      const [line] = getLogLines();
      expect(line.req.body.email).toBe('[REDACTED]');
      expect(line.user.email).toBe('[REDACTED]');
    });

    it('does not redact a field absent from REDACT_PATHS', () => {
      const { logger, getLogLines } = loadLoggerWithCapture('info');

      logger.info(samplePayload(), 'test message');

      const [line] = getLogLines();
      expect(line.someOtherField).toBe('visible-value');
    });
  });

  describe('at the debug level', () => {
    it('does NOT redact the same top-level and nested fields', () => {
      const { logger, getLogLines } = loadLoggerWithCapture('debug');

      logger.debug(samplePayload(), 'test message');

      const [line] = getLogLines();
      expect(line.email).toBe('test@example.com');
      expect(line.password).toBe('secret123');
      expect(line.req.body.email).toBe('nested-req-body@example.com');
      expect(line.user.email).toBe('nested-user@example.com');
    });

    it('still leaves a field absent from REDACT_PATHS unredacted (negative-case sanity check)', () => {
      const { logger, getLogLines } = loadLoggerWithCapture('debug');

      logger.debug(samplePayload(), 'test message');

      const [line] = getLogLines();
      expect(line.someOtherField).toBe('visible-value');
    });
  });

  it('REDACT_PATHS and REDACT_CENSOR are exported for reuse by other modules', () => {
    const { logger } = loadLoggerWithCapture('info');

    expect(Array.isArray(logger.REDACT_PATHS)).toBe(true);
    expect(logger.REDACT_PATHS).toEqual(expect.arrayContaining(['email', 'password']));
    expect(logger.REDACT_CENSOR).toBe('[REDACTED]');
  });
});
