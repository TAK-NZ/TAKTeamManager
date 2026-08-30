require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');

const requestContext = require('./middleware/requestContext');
const { getLogger } = requestContext;
const logger = require('./config/logger');
const pool = require('./config/database');
const { createGracefulShutdown } = require('./utils/gracefulShutdown');
const { validateConfig, assertAuthRouteMounted } = require('./config/configValidator');
const { isDeviceMgmtEnabled } = require('./config/deviceMgmt');
const { getTrustProxyHops } = require('./config/trustProxy');

const app = express();
const PORT = process.env.PORT || 3000;

// BUGS.md NOTE-001: tells Express how many `X-Forwarded-For` hops to
// trust when resolving `req.ip`/`req.ips` (and how it detects HTTPS via
// `X-Forwarded-Proto`, consulted by helmet's HSTS logic). Defaults to 0
// (trust nothing) via `getTrustProxyHops`, which is correct for local/
// dev/test; set `TRUSTED_PROXY_HOPS=1` once deployed behind the
// production ALB (see README.md's Deployment section and
// `server/config/trustProxy.js`'s header comment for why this must be a
// hop COUNT, never `true`, and why it must be paired with an ALB-only
// ECS security group rule). Set before any middleware or route mount
// below, since `express-rate-limit`'s `req.ip`-keyed limiters and
// `helmet` both read this setting off `app`.
app.set('trust proxy', getTrustProxyHops());

// Requirement 15.2/6.4: validate required configuration -- including,
// when NODE_ENV=production, resolving secrets through the configured
// secrets provider -- before doing anything else. This must complete
// before any Express app setup (middleware, routes, etc.) and before the
// app binds to a port, so that a misconfigured environment or an
// unreachable secrets manager fails fast with a clear error instead of
// partially starting up. `validateConfig` is async (the production
// secrets-manager gate makes an external call), so startup is wrapped in
// an async IIFE that awaits it before doing anything else.
(async () => {
  await validateConfig();

  // Request correlation (Requirement 13.2/13.3): assign/propagate a
  // correlation ID for the lifetime of each request, before any other
  // middleware or route handler runs, so every log line produced while
  // handling this request can be tied back to it.
  app.use(requestContext);

  // Security middleware
  //
  // scriptSrc/connectSrc additionally allow www.google.com/gstatic.com and
  // frameSrc allows www.google.com/recaptcha.net, so the client-side
  // reCAPTCHA v3 script (loaded on the team-access request page to call
  // grecaptcha.execute()) can load and run. reCAPTCHA v3 has no visible
  // widget/iframe of its own by default, but Google's script internally
  // opens a hidden iframe for its own risk-analysis calls, so frameSrc
  // must allow it too or the script fails silently.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://www.google.com", "https://www.gstatic.com"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://www.gravatar.com"],
        connectSrc: ["'self'", "https://www.google.com"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameSrc: ["'self'", "https://www.google.com", "https://recaptcha.net"],
        frameAncestors: ["'self'"],
      }
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    crossOriginEmbedderPolicy: false
  }));
  app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true
  }));

  // Cookie parsing (Requirement 3.2): the JWT_Token is delivered as a
  // `tak_session` httpOnly cookie (set in server/routes/auth.js) rather than
  // via an Authorization header or URL param. Mounted before any route so
  // `req.cookies` is available to `authenticateToken` on every request.
  app.use(cookieParser());

  // Rate limiting
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000
  });
  app.use(limiter);

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Serve static files from client build
  app.use(express.static(path.join(__dirname, '../client/dist')));

  // Serve uploaded branding assets (Requirement 32.4, task 54.4): the
  // logo file `POST /api/settings/branding/logo` atomically writes into
  // `UPLOADS_DIR` (server/routes/settings.js, default
  // `server/uploads/branding`) needs to be reachable by the Client as a
  // plain `<img src>` URL. Mounted at `/uploads`, distinct from the
  // `client/dist` static mount above, and distinct from `CERTS_DIR` (TAK
  // Server cert/key uploads), which is intentionally NEVER served over
  // HTTP -- those files are only read directly off disk by
  // `TakServerService`.
  app.use('/uploads', express.static(process.env.UPLOADS_DIR || path.join(__dirname, 'uploads/branding')));

  // Serve downloadable CSV bulk-import templates (Requirement 29.1,
  // BUG-011): `public/templates/user-import-template.csv` and
  // `public/templates/team-import-template.csv` exist on disk but were
  // never reachable over HTTP -- the `client/dist` static mount above
  // only serves the built client, and the `/uploads` mount above only
  // serves `UPLOADS_DIR` (branding uploads). Mounted at `/templates`,
  // following that same `/uploads` pattern. These are non-sensitive
  // blank-header CSV templates, so no authentication is required, and --
  // matching `/uploads`'s own precedent (see
  // `permissions.registry.completeness.test.js`'s comment on why
  // `express.static()` mounts are excluded from its walk) -- this is a
  // static-file mount, not an Express route handler with a `req.route`,
  // so it is intentionally NOT added to the Public_Route_Registry
  // (`server/config/publicRoutes.js`), which is scoped to router-handled
  // routes only.
  app.use('/templates', express.static(path.join(__dirname, '../public/templates')));

  // Public_Route_Registry bootstrap (Requirement 33.2): consults the
  // Public_Route_Registry (server/config/publicRoutes.js) against every
  // incoming request's method + path before any route's own
  // `authenticateToken` would otherwise apply, i.e. mounted ahead of every
  // route mount below. Each individual route file still mounts
  // `authenticateToken`/`authorize` itself (see server/middleware/
  // authorize.js's header comment: `req.route` -- which `authorize.js`
  // depends on -- is only populated by Express once a request has matched
  // a specific route, not at this router-mount-level point in the chain).
  // `publicRouteBootstrap` therefore always calls `next()` here; its
  // purpose at this position is to satisfy Req 33.2's requirement that the
  // Public_Route_Registry be consulted upstream of the authentication edge,
  // and it is exercised by the Req 33.3/33.4 registry tests (tasks 55.3,
  // 55.4).
  app.use(require('./middleware/publicRouteBootstrap'));

  // Login-time user agreement gate (Requirement 28 Criteria 6-7):
  // mounted globally, mirroring `publicRouteBootstrap`'s "always runs"
  // precedent immediately above. `req.user` is not yet populated at this
  // router-mount-level point in the chain (each route file mounts its own
  // `authenticateToken`/`authorize` pair further down, per `authorize.js`'s
  // header comment). BUG-010 fix: `requireCurrentAgreement` no longer
  // relies on `req.user` being set here -- it independently resolves the
  // current user from the `tak_session` cookie itself (reusing
  // `server/middleware/auth.js`'s `resolveUserFromRequest`), so the gate
  // is actually enforced at this global mount point, not just when this
  // same middleware is mounted per-route after `authenticateToken`/
  // `authorize` (as `server/routes/mou.js` also does, task 50.5). See
  // that file's header comment for the full reasoning.
  app.use(require('./middleware/requireCurrentAgreement'));

  // Routes
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/teams', require('./routes/teams'));
  app.use('/api/users', require('./routes/users'));
  app.use('/api/channels', require('./routes/channels'));
  app.use('/api/signup-codes', require('./routes/signupCodes'));
  app.use('/api', require('./routes/signup'));
  app.use('/api', require('./routes/orgDomains'));
  app.use('/api/requests', require('./routes/requests'));
  app.use('/api/channel-requests', require('./routes/channelRequests'));
  app.use('/api/config', require('./routes/config'));
  app.use('/api/sync', require('./routes/sync'));
  app.use('/api/operations', require('./routes/operations'));
  app.use('/api/global-channels', require('./routes/globalChannels'));
  app.use('/api/vendor-channels', require('./routes/vendorChannels'));
  app.use('/api/deployment-channels', require('./routes/deploymentChannels'));
  app.use('/api/audit-logs', require('./routes/auditLogs'));
  app.use('/api/settings', require('./routes/settings'));
  app.use('/api/mou', require('./routes/mou'));
  app.use('/api/communications', require('./routes/communications'));
  app.use('/api/devices', require('./routes/devices'));
  app.use('/api/enrollment', require('./routes/enrollment'));
  app.use('/api/bulk-import', require('./routes/bulkImport'));

  // Device_Management (device-management Requirements 1.8, 1.9, task
  // 13.1): mounted ONLY while Device_Mgmt_Enabled is true, so while the
  // feature is off none of its four routes exist at all and the app's
  // catch-all answers them with its standard 404 -- no
  // `authenticateToken`, no `authorize`, no handler, and therefore no
  // Revoke_Operation enqueue. Each handler in `routes/deviceManagement.js`
  // ALSO re-checks `isDeviceMgmtEnabled()` and returns the same 404 shape;
  // that duplication is deliberate defense in depth (this mount decision
  // is made once at boot, the in-handler check reads `process.env` at call
  // time). NOT added to `publicRoutes`: every route requires
  // authentication.
  if (isDeviceMgmtEnabled()) {
    app.use('/api/device-management', require('./routes/deviceManagement'));
  }

  // Health check (Requirement 14.1/14.2): GET /health verifies Database
  // connectivity with a 2s-timeout SELECT 1, returning 200 {status:
  // 'healthy'} on success or 503 {status: 'unhealthy', reason} otherwise.
  app.use('/health', require('./routes/health'));

  // Serve React app for all non-API routes
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/health')) {
      res.sendFile(path.join(__dirname, '../client/dist/index.html'));
    }
  });

  // Error handling
  app.use((err, req, res, next) => {
    getLogger().error({ err }, err.message || 'Unhandled request error');
    res.status(500).json({
      error: 'Something went wrong!',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  });

  app.use('*', (req, res) => {
    res.status(404).json({ error: 'Route not found' });
  });

  // Requirement 1 Criterion 5: verify that the single active OAuth2
  // authentication route module (mounted above at '/api/auth') is
  // actually present in the router stack before binding to a port, so
  // correct APP_URL/FRONTEND_URL configuration alone is never mistaken
  // for evidence that authentication is functional. Must run after every
  // route mount above but before app.listen() below.
  assertAuthRouteMounted(app);

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'TAK Team Manager server running');

    // Start periodic sync service
    const authentikSync = require('./services/authentikSync');
    authentikSync.startPeriodicSync();

    // Start escalation service
    const EscalationService = require('./services/EscalationService');
    const escalationService = new EscalationService();
    escalationService.startDailySchedule();
  });

  // Requirement 8.4: graceful shutdown on SIGTERM, SIGINT, or a shutdown-
  // requiring uncaughtException — stop accepting new connections, allow
  // in-flight requests up to 30s to complete, close the DB pool, then exit.
  const gracefulShutdown = createGracefulShutdown({ server, pool, logger });

  // Requirement 8.1/8.2: log unhandledRejection via the structured logger and
  // keep the process running (do not exit).
  process.on('unhandledRejection', (reason, promise) => {
    logger.error({ err: reason, promise }, 'Unhandled promise rejection');
  });

  // Requirement 8.1/8.3: log uncaughtException (with stack trace) via the
  // structured logger and perform a controlled shutdown rather than
  // continuing in a potentially corrupted state.
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception');
    gracefulShutdown('uncaughtException', { exitCode: 1 });
  });

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
})();
