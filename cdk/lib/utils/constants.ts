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

/** Authentik OIDC application identity for this app. */
export const OIDC_CONSTANTS = {
  APPLICATION_NAME: 'Team Manager',
  APPLICATION_SLUG: 'team-manager',
  PROVIDER_NAME: 'TAK-TeamManager',
  /** Authentik group the application is placed in. */
  GROUP_NAME: 'Team Awareness Kit'
} as const;
