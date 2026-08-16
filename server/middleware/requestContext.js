/**
 * Request correlation context (Requirement 13: Implement Structured,
 * Correlated Logging)
 *
 * Uses Node's `AsyncLocalStorage` to stash a correlation ID for the
 * lifetime of a single HTTP request, so that any code invoked
 * synchronously (or via promises/async-await, which `AsyncLocalStorage`
 * follows) while handling that request can retrieve the same correlation
 * ID without it being threaded through every function signature
 * (Criterion 13.3: "every log line produced by the App, including logs
 * emitted by services it calls synchronously").
 *
 * Criterion 13.2: the correlation ID is taken from the incoming
 * `x-correlation-id` header when present and non-empty, otherwise a fresh
 * `crypto.randomUUID()` is generated.
 *
 * `getLogger()` pulls the active correlation ID out of the
 * `AsyncLocalStorage` context (if any) and returns a correlation-scoped
 * child logger derived from `server/config/logger.js`'s `pino` instance
 * (`logger.child({ correlationId })`), falling back to the plain logger
 * when called outside of a request context (e.g. at startup, or from the
 * Sync_Worker, which is a separate process with its own context needs per
 * Criterion 13.5).
 */

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const logger = require('../config/logger');

const asyncLocalStorage = new AsyncLocalStorage();

/**
 * Extracts a usable, trimmed correlation ID from the incoming
 * `x-correlation-id` header, if any. Node normally joins duplicate
 * non-special headers into a single comma-separated string, but this
 * defensively handles an array value too (e.g. if a proxy forwards the
 * header multiple times) by taking the first entry.
 *
 * @param {import('express').Request} req
 * @returns {string|undefined}
 */
function extractIncomingCorrelationId(req) {
  let headerValue = req.headers['x-correlation-id'];

  if (Array.isArray(headerValue)) {
    headerValue = headerValue[0];
  }

  if (typeof headerValue !== 'string') {
    return undefined;
  }

  const trimmed = headerValue.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Express middleware. Wraps the rest of the request's handling in an
 * `AsyncLocalStorage.run()` call so `getCorrelationId()`/`getLogger()`
 * resolve consistently for the lifetime of this request, then calls
 * `next()` inside that context.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requestContext(req, res, next) {
  const correlationId = extractIncomingCorrelationId(req) || crypto.randomUUID();

  // Echo the correlation ID back so a caller that didn't supply one can
  // still correlate their request against server-side logs.
  res.setHeader('x-correlation-id', correlationId);

  asyncLocalStorage.run({ correlationId }, () => {
    next();
  });
}

/**
 * Returns the correlation ID active for the current request, or
 * `undefined` when called outside of a `requestContext`-wrapped request
 * (e.g. at App startup, or from the Sync_Worker process).
 *
 * @returns {string|undefined}
 */
function getCorrelationId() {
  const store = asyncLocalStorage.getStore();
  return store ? store.correlationId : undefined;
}

/**
 * Returns a correlation-scoped child logger for the active request
 * context (Criterion 13.3), or the plain `server/config/logger.js`
 * instance when there is no active request context, so call sites can
 * always call `getLogger()` safely regardless of whether they're
 * currently inside a request.
 *
 * @returns {import('pino').Logger}
 */
function getLogger() {
  const correlationId = getCorrelationId();
  return correlationId ? logger.child({ correlationId }) : logger;
}

module.exports = requestContext;
module.exports.getLogger = getLogger;
module.exports.getCorrelationId = getCorrelationId;
module.exports.asyncLocalStorage = asyncLocalStorage;
