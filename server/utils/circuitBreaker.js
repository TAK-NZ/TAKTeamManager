/**
 * Resiliency-hardening: a minimal, dependency-free circuit breaker.
 *
 * Before this module existed, nothing in this codebase stopped a Sync_Worker
 * or a request-handling path from hammering an unreachable Authentik or TAK
 * Server with call after call, each one waiting out the full
 * `fetchWithTimeout`/axios `timeout` before failing -- an outage on either
 * dependency turned every dependent request into a slow failure instead of
 * a fast one, and kept retrying against a target that was not coming back
 * within the timeout window anyway.
 *
 * Three states, the standard shape (Closed -> Open -> Half-Open -> Closed):
 *  - CLOSED (normal): every call is attempted. A failure increments a
 *    counter; once it reaches `failureThreshold`, the breaker OPENS.
 *  - OPEN: calls fail FAST with `CircuitOpenError`, without even attempting
 *    the wrapped function, until `resetTimeoutMs` has elapsed since the
 *    breaker opened.
 *  - HALF_OPEN: entered automatically the first time a call is attempted
 *    after `resetTimeoutMs` has elapsed. Exactly one probe call is allowed
 *    through; a concurrent second call while the probe is in flight also
 *    fails fast. The probe's outcome decides the next state: success closes
 *    the breaker (and resets the failure counter), failure reopens it (and
 *    restarts the reset timer).
 *
 * This intentionally does NOT know anything about HTTP, axios, or
 * `fetch` -- `execute(fn)` takes any function returning a Promise, so it
 * stays a pure `server/utils/` module or usable by anything, and is unit
 * tested directly against a synthetic `fn`, per this repo's convention of
 * pure-logic-in-utils being reachable by a property test.
 *
 * `wrapAxiosClientMethods` (below) is the one HTTP-shaped adapter, used by
 * `server/services/authentik.js` and `server/services/TakServerService.js`
 * to route their `client.get`/`.post`/`.put`/`.patch`/`.delete` calls
 * through a shared breaker without changing any call site.
 */

const CLOSED = 'closed';
const OPEN = 'open';
const HALF_OPEN = 'half_open';

/**
 * Thrown by `CircuitBreaker#execute` when the breaker is OPEN (or
 * HALF_OPEN with a probe already in flight): the wrapped function is
 * never attempted. This IS an `Error` instance (not a distinct shape), so
 * `server/workers/failureClassification.js`'s `classifyFailure` -- which
 * treats any `Error` as `'retryable'`, the same as a caught network/timeout
 * failure -- classifies it identically to "the call never reached the
 * dependency at all", which is exactly what happened.
 */
class CircuitOpenError extends Error {
  /**
   * @param {string} name - the breaker's `name`, for a useful message and
   *   for callers that want to distinguish which dependency tripped.
   */
  constructor(name) {
    super(`Circuit breaker "${name}" is open; call was not attempted`);
    this.name = 'CircuitOpenError';
    this.circuitBreakerName = name;
  }
}

class CircuitBreaker {
  /**
   * @param {object} [options]
   * @param {string} [options.name] - used only in log/error messages, to
   *   tell multiple breakers apart.
   * @param {number} [options.failureThreshold] - consecutive failures (in
   *   CLOSED state) before the breaker opens. Default 5.
   * @param {number} [options.resetTimeoutMs] - how long the breaker stays
   *   OPEN before allowing a single HALF_OPEN probe. Default 30000 (30s) --
   *   long enough that a call storm against a dependency that is genuinely
   *   down does not retry every few milliseconds, short enough that a
   *   recovered dependency is noticed within about the same order of
   *   magnitude as `DEFAULT_FETCH_TIMEOUT_MS`
   *   (`server/utils/fetchWithTimeout.js`).
   * @param {(transition: {name: string, from: string, to: string}) => void} [options.onStateChange] -
   *   invoked on every state transition; the default is a no-op. Callers
   *   that want to log a breaker opening/closing (rather than every
   *   individual failed call) can pass a logger callback here.
   */
  constructor({
    name = 'circuit',
    failureThreshold = 5,
    resetTimeoutMs = 30000,
    onStateChange = () => {}
  } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.onStateChange = onStateChange;

    this.state = CLOSED;
    this.failureCount = 0;
    this.openedAt = null;
    this.halfOpenProbeInFlight = false;
  }

  /** @returns {'closed'|'open'|'half_open'} */
  getState() {
    return this.state;
  }

  _transitionTo(newState) {
    if (this.state === newState) return;
    const from = this.state;
    this.state = newState;
    this.onStateChange({ name: this.name, from, to: newState });
  }

  _open() {
    this.openedAt = Date.now();
    this.halfOpenProbeInFlight = false;
    this._transitionTo(OPEN);
  }

  _close() {
    this.failureCount = 0;
    this.openedAt = null;
    this.halfOpenProbeInFlight = false;
    this._transitionTo(CLOSED);
  }

  /**
   * Runs `fn()` through the breaker.
   *
   * @param {() => Promise<*>} fn
   * @returns {Promise<*>} `fn()`'s own resolution, unchanged, on success.
   * @throws {CircuitOpenError} without calling `fn()` at all, when OPEN
   *   (and the reset timeout has not yet elapsed) or when HALF_OPEN with a
   *   probe already in flight.
   * @throws {*} `fn()`'s own rejection, unchanged, on failure -- this
   *   breaker never swallows or rewraps the underlying error, it only
   *   decides whether to attempt the call and tracks the outcome.
   */
  async execute(fn) {
    if (this.state === OPEN) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.resetTimeoutMs) {
        throw new CircuitOpenError(this.name);
      }
      // Reset window elapsed: allow exactly one probe through.
      this._transitionTo(HALF_OPEN);
    }

    if (this.state === HALF_OPEN) {
      if (this.halfOpenProbeInFlight) {
        throw new CircuitOpenError(this.name);
      }
      this.halfOpenProbeInFlight = true;
      try {
        const result = await fn();
        this._close();
        return result;
      } catch (error) {
        this._open();
        throw error;
      }
    }

    // CLOSED.
    try {
      const result = await fn();
      this.failureCount = 0;
      return result;
    } catch (error) {
      this.failureCount += 1;
      if (this.failureCount >= this.failureThreshold) {
        this._open();
      }
      throw error;
    }
  }
}

const WRAPPED_MARKER = Symbol('circuitBreakerWrapped');

/**
 * Routes an axios instance's HTTP methods through `breaker.execute`, in
 * place -- `client` itself is mutated and returned, not cloned, so any
 * OTHER reference to the same instance (e.g. `client.defaults`, read and
 * mutated directly by `TakServerService#setAgentOptions`) keeps working
 * unchanged, and axios's own internal `this`-binding (each method reads
 * `this.defaults` at call time) still resolves to the real instance.
 *
 * Idempotent: a `client` already wrapped by this function is returned
 * as-is on a second call, rather than nesting a second layer of breaker
 * checks around the first. This matters because a production call site
 * always wraps a freshly-created, distinct axios instance, but doubling
 * the wrap is otherwise easy to trigger by accident wherever the SAME
 * object is wrapped from two code paths (this repo's own axios test
 * doubles which mock `axios.create` to return one shared object for
 * every call are exactly that shape) -- without this guard, a call that
 * fails would be counted as two failures against `breaker.failureThreshold`
 * rather than one.
 *
 * @param {object} client - an axios instance (or compatible test double
 *   exposing the same method names).
 * @param {CircuitBreaker} breaker
 * @param {Array<string>} [methods] - method names to wrap. Default covers
 *   every HTTP verb this codebase's Authentik/TAK Server clients use.
 * @returns {object} `client`, mutated in place.
 */
function wrapAxiosClientMethods(client, breaker, methods = ['get', 'post', 'put', 'patch', 'delete']) {
  if (!client || client[WRAPPED_MARKER]) {
    return client;
  }

  for (const method of methods) {
    if (typeof client[method] !== 'function') continue;
    const original = client[method];
    client[method] = (...args) => breaker.execute(() => original.apply(client, args));
  }

  client[WRAPPED_MARKER] = true;
  return client;
}

module.exports = { CircuitBreaker, CircuitOpenError, wrapAxiosClientMethods };
