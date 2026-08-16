/**
 * Requirement 9.6: classify an Authentik API call failure as either
 * 'retryable' or 'permanent'.
 *
 * - A numeric HTTP status in the 5xx range (500-599) is retryable: it
 *   indicates a server-side/transient problem on Authentik's end that may
 *   succeed on a later attempt.
 * - A numeric HTTP status in the 4xx range (400-499) is permanent: it
 *   indicates a client-side error (e.g. "group not found", "bad request")
 *   that will not be resolved by retrying the exact same request.
 * - An `Error` instance (a caught network/timeout failure -- e.g. a
 *   rejected `fetch()` promise from a DNS failure, connection refused, or
 *   an AbortController-driven timeout producing an `AbortError`) is
 *   retryable, since the call never reached Authentik at all and may
 *   succeed once the underlying connectivity issue clears. This still
 *   applies even though the current handlers in `syncWorker.js` do not yet
 *   wire up an explicit `fetch()` timeout via `AbortController` -- any
 *   thrown/caught `Error` from a fetch call is treated as a network
 *   failure for classification purposes.
 * - Any other numeric status (e.g. below 400, which shouldn't normally
 *   reach this function since 2xx/3xx responses aren't failures) falls
 *   back to 'retryable', on the theory that an unexpected/unclassified
 *   status is more likely a transient anomaly than something the caller
 *   should permanently give up on.
 * - `null`/`undefined`/any other non-Error, non-number input also falls
 *   back to 'retryable', so that an ambiguous or malformed input fails
 *   toward more retries rather than prematurely abandoning an operation
 *   (consistent with the bounded-retry safety net from task 26.1, which
 *   already caps both the per-retry delay and the total retry count).
 *
 * @param {number|Error} statusOrError - either a numeric HTTP status code
 *   (e.g. `response.status` from a `fetch()` call), or an `Error` instance
 *   representing a network/timeout failure.
 * @returns {'retryable'|'permanent'}
 */
function classifyFailure(statusOrError) {
  if (statusOrError instanceof Error) {
    return 'retryable';
  }

  if (typeof statusOrError === 'number' && Number.isFinite(statusOrError)) {
    if (statusOrError >= 500 && statusOrError <= 599) {
      return 'retryable';
    }
    if (statusOrError >= 400 && statusOrError <= 499) {
      return 'permanent';
    }
    // Any other numeric status (e.g. < 400, or >= 600) is not an expected
    // failure status; default to retryable per the documented fallback.
    return 'retryable';
  }

  // null/undefined/string/object/etc: default to retryable per the
  // documented fallback (fail toward more retries).
  return 'retryable';
}

module.exports = { classifyFailure };
