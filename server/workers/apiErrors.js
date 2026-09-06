'use strict';

/**
 * Shared upstream-API error classes for the Sync_Worker and the services
 * it calls.
 *
 * These were originally defined inline in `syncWorker.js`. They are
 * extracted here so a service the worker delegates to (e.g. the Phase-2
 * `OwnedGroupReconciler`) can throw the SAME classified error type the
 * worker's `executeOperationSafely` already inspects via `instanceof`,
 * without importing the worker module itself (which would be a circular
 * dependency: worker -> reconciler -> worker).
 *
 * `classification` is the result of
 * `server/workers/failureClassification.js`'s `classifyFailure(...)` --
 * either `'retryable'` or `'permanent'`. `executeOperationSafely` routes a
 * `'permanent'` classification straight to `markPermanentlyFailed` and lets
 * a `'retryable'` one fall through to the normal backoff path. A plain
 * `Error` (no `classification`) is treated as retryable, so throwing one is
 * always safe when in doubt.
 */

/**
 * A non-2xx Authentik response, or a caught network/timeout error from an
 * Authentik call.
 */
class AuthentikApiError extends Error {
  constructor(message, classification) {
    super(message);
    this.name = 'AuthentikApiError';
    this.classification = classification;
  }
}

/**
 * The TAK Server / Marti analogue of `AuthentikApiError`. A dedicated class
 * (rather than reusing `AuthentikApiError`) keeps the error's `name`/log
 * output honest about which upstream system actually failed, while the
 * worker's classification check inspects both identically via their shared
 * `classification` field.
 */
class TakServerApiError extends Error {
  constructor(message, classification) {
    super(message);
    this.name = 'TakServerApiError';
    this.classification = classification;
  }
}

module.exports = { AuthentikApiError, TakServerApiError };
