/**
 * Trust_Proxy_Hops (server-side only).
 *
 * Governs Express's `trust proxy` setting (applied in `server/index.js`
 * via `app.set('trust proxy', getTrustProxyHops())`), which controls:
 *
 *  - how many entries of an incoming `X-Forwarded-For` header Express
 *    trusts when resolving `req.ip`/`req.ips` -- consulted by every
 *    `req.ip`-keyed rate limiter in `server/middleware/rateLimiters.js`
 *    (`authFlowLimiter`, `authCallbackFailureLimiter`,
 *    `requestAccessLimiter`); and
 *  - how Express detects HTTPS via `X-Forwarded-Proto` -- consulted by
 *    `helmet`'s HSTS logic and `req.secure`.
 *
 * See BUGS.md NOTE-001 for the defect this addresses: with no `trust
 * proxy` configuration at all, `req.ip` resolves to the immediate TCP
 * peer's address for every request. Locally that's harmless (nothing
 * sits in front of the App), but behind a real reverse proxy/load
 * balancer -- the intended production topology, an AWS ALB fronting an
 * ECS Fargate task, deployed via a CDK stack that is a documented
 * follow-up (see README.md's Deployment section) -- that peer is always
 * the LB itself, collapsing every IP-keyed rate limiter in the app onto
 * one shared bucket regardless of how many distinct real clients there
 * are.
 *
 * Deliberately a HOP COUNT (an integer), read from `TRUSTED_PROXY_HOPS`,
 * rather than `app.set('trust proxy', true)`. `true` trusts the ENTIRE
 * `X-Forwarded-For` chain, including whatever a client sends itself --
 * since that header is just request input, any caller could set
 * `X-Forwarded-For: 1.2.3.4` directly and be believed, trivially
 * defeating every `req.ip`-keyed limiter by rotating the forged value
 * per request. A hop count of `N` instead trusts exactly the `N`
 * rightmost entries as genuine proxy-appended hops and treats anything
 * further left (attacker-suppliable) as untrusted, which is safe ONLY
 * as long as it is actually impossible to reach the App except through
 * those `N` real hops -- for the ALB topology this also depends on the
 * ECS task's security group accepting inbound traffic on the container
 * port ONLY from the ALB's security group, never `0.0.0.0/0` or a broad
 * VPC CIDR. `getTrustProxyHops` alone does not and cannot enforce that
 * network-level restriction; it must be paired with it in the CDK stack.
 *
 * Defaults to `0` (trust nothing) -- correct for local/dev/test, where
 * no proxy sits in front of the App and an incoming `X-Forwarded-For`
 * header must be treated as arbitrary, untrusted caller input rather
 * than as proxy-recorded state. Set to `1` once deployed behind exactly
 * one reverse-proxy hop (the ALB, with no CDN in front of it). If a
 * CDN/CloudFront is ever added in front of the ALB, this must become `2`
 * to account for the additional hop.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {number} A non-negative integer hop count; 0 when unset,
 *   empty, non-numeric, or negative.
 */
function getTrustProxyHops(env = process.env) {
  return Math.max(0, parseInt(env.TRUSTED_PROXY_HOPS, 10) || 0);
}

module.exports = { getTrustProxyHops };
