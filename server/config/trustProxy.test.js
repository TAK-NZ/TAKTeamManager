/**
 * Tests for `getTrustProxyHops` (server/config/trustProxy.js), which
 * governs Express's `trust proxy` setting -- the fix for
 * req.ip collapsing onto a single shared bucket for every
 * `req.ip`-keyed rate limiter once deployed behind the production ALB.
 *
 * Mirrors `getRevokeMaxCerts`'s clamp-to-a-usable-positive-value
 * convention in `server/config/__tests__/deviceMgmt.test.js`: an unset,
 * empty, non-numeric, or negative value must never produce a negative
 * hop count (which would be meaningless to `app.set('trust proxy', ...)`),
 * and must default to 0 -- trust nothing -- rather than any nonzero
 * value, since a nonzero default would silently start trusting
 * `X-Forwarded-For` in every environment (local/dev/test included) where
 * no reverse proxy actually sits in front of the App.
 */

const { getTrustProxyHops } = require('./trustProxy');

describe('getTrustProxyHops', () => {
  it('defaults to 0 when TRUSTED_PROXY_HOPS is unset', () => {
    expect(getTrustProxyHops({})).toBe(0);
    expect(getTrustProxyHops({ TRUSTED_PROXY_HOPS: undefined })).toBe(0);
  });

  it.each([
    ['1', 1],
    ['2', 2],
    ['5', 5]
  ])('honours TRUSTED_PROXY_HOPS=%p as %i', (value, expected) => {
    expect(getTrustProxyHops({ TRUSTED_PROXY_HOPS: value })).toBe(expected);
  });

  // A negative or non-numeric value has no defensible hop count, and must
  // never be passed through as a negative number to `app.set('trust
  // proxy', ...)` -- clamp back to 0 (trust nothing) rather than an
  // unusable or dangerous value.
  it.each([
    ['', 0],
    ['not-a-number', 0],
    ['-1', 0],
    ['-5', 0]
  ])('clamps the unusable value %p to %i', (value, expected) => {
    expect(getTrustProxyHops({ TRUSTED_PROXY_HOPS: value })).toBe(expected);
  });

  it('treats "0" explicitly the same as unset', () => {
    expect(getTrustProxyHops({ TRUSTED_PROXY_HOPS: '0' })).toBe(0);
  });

  it('defaults to process.env when no env argument is supplied', () => {
    const original = process.env.TRUSTED_PROXY_HOPS;
    try {
      delete process.env.TRUSTED_PROXY_HOPS;
      expect(getTrustProxyHops()).toBe(0);

      process.env.TRUSTED_PROXY_HOPS = '1';
      expect(getTrustProxyHops()).toBe(1);
    } finally {
      if (original === undefined) {
        delete process.env.TRUSTED_PROXY_HOPS;
      } else {
        process.env.TRUSTED_PROXY_HOPS = original;
      }
    }
  });
});

/**
 * Integration coverage for `app.set('trust proxy', getTrustProxyHops())`
 * itself -- proving the actual `req.ip` resolution behaves as the
 * `trustProxy.js` header comment claims, not just that the hop-count
 * predicate returns the right number.
 *
 * With hops=1 (the documented single-ALB-hop production value), Express
 * must read the RIGHTMOST entry of `X-Forwarded-For` as the trusted
 * proxy's own record of the client IP, and ignore anything further left
 * -- which a caller could forge by prepending an arbitrary value of
 * their own. A caller sending `X-Forwarded-For: 9.9.9.9, 5.5.5.5` (as if
 * they'd forged a first hop ahead of the real ALB-appended one) must
 * resolve to `5.5.5.5`, never the attacker-supplied `9.9.9.9` -- this is
 * exactly what stops a caller from defeating `req.ip`-keyed rate
 * limiters (`authFlowLimiter`, `requestAccessLimiter`, etc.) by rotating
 * a forged header value per request.
 */
describe('app.set(\'trust proxy\', getTrustProxyHops()) resolves req.ip correctly', () => {
  const express = require('express');
  const request = require('supertest');

  function buildApp(hops) {
    const app = express();
    app.set('trust proxy', getTrustProxyHops({ TRUSTED_PROXY_HOPS: String(hops) }));
    app.get('/whoami', (req, res) => {
      res.json({ ip: req.ip });
    });
    return app;
  }

  it('with hops=0 (default/local/dev), ignores X-Forwarded-For entirely', async () => {
    const app = buildApp(0);

    const res = await request(app)
      .get('/whoami')
      .set('X-Forwarded-For', '9.9.9.9, 5.5.5.5');

    // No proxy is trusted, so req.ip is the raw connection's own address
    // (supertest's loopback), never anything from the forgeable header.
    expect(res.body.ip).not.toBe('9.9.9.9');
    expect(res.body.ip).not.toBe('5.5.5.5');
  });

  it('with hops=1 (single ALB hop), trusts only the rightmost X-Forwarded-For entry', async () => {
    const app = buildApp(1);

    const res = await request(app)
      .get('/whoami')
      .set('X-Forwarded-For', '9.9.9.9, 5.5.5.5');

    // 5.5.5.5 is the entry the (simulated) trusted proxy itself appended;
    // 9.9.9.9 is attacker-suppliable and must never be believed.
    expect(res.body.ip).toBe('5.5.5.5');
  });
});
