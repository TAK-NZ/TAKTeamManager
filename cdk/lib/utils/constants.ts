/**
 * Shared constants for the TAK Team Manager CDK stack.
 */

/** Default AWS region, matching the other TAK-NZ stacks. */
export const DEFAULT_AWS_REGION = 'ap-southeast-2';

/** Database-related constants. */
export const DATABASE_CONSTANTS = {
  /** Postgres port. */
  PORT: 5432,
  /** Generated master-password length (no punctuation, safe in a URL). */
  PASSWORD_LENGTH: 64,
  /** Local application database name — matches the app's DB_NAME default. */
  DEFAULT_DATABASE_NAME: 'tak_team_manager',
  /** Master DB username. The app passes this through as DB_USER. */
  USERNAME: 'takteammanager'
} as const;

/** Application-container constants. */
export const APP_CONSTANTS = {
  /** The port the Express server listens on (matches the app's PORT default). */
  CONTAINER_PORT: 3000,
  /** DB-connectivity health-check path (server/routes/health.js). */
  HEALTH_CHECK_PATH: '/health'
} as const;

/** TAK Server (Marti API) integration constants. */
export const TAK_SERVER_CONSTANTS = {
  /**
   * The name TAK Server's own TLS certificate carries. A stock TAK Server
   * presents `CN=takserver` with a single `DNS:takserver` SAN, which never
   * matches the load-balancer host we dial (e.g. `tak.test.tak.nz`), so Node's
   * default identity check fails with `ERR_TLS_CERT_ALTNAME_INVALID` on every
   * Marti call. Setting this as `TAK_SERVER_TLS_SERVERNAME` points the identity
   * check at the name the certificate actually carries. It narrows WHICH name
   * is verified, not WHETHER — the chain is still verified (see
   * `buildMutualTlsAgentOptions` in `server/services/TakServerService.js` and
   * `.env.example`). `rejectUnauthorized` is never disabled.
   */
  TLS_SERVERNAME: 'takserver'
} as const;

/** Authentik OIDC application identity for this app. */
export const OIDC_CONSTANTS = {
  APPLICATION_NAME: 'Team Manager',
  APPLICATION_SLUG: 'team-manager',
  PROVIDER_NAME: 'TAK-TeamManager',
  /** Authentik group the application is placed in. */
  GROUP_NAME: 'Team Awareness Kit',

  /**
   * Second, LINK-ONLY Authentik application: a launcher tile deep-linking to
   * this app's /enrollment page. NO provider of its own (an OAuth2 provider
   * binds to exactly one application, so it cannot reuse the Team Manager
   * provider); the user is already authenticated through the Team Manager
   * provider by the time they follow the link. Placed in the same GROUP_NAME.
   */
  ENROLLMENT_APPLICATION_NAME: 'TAK Device Enrollment',
  ENROLLMENT_APPLICATION_SLUG: 'tak-device-enrollment',
  ENROLLMENT_APPLICATION_DESCRIPTION: 'Enrol a mobile device with ATAK/TAK Aware/iTAK'
} as const;
