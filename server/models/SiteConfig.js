const pool = require('../config/database');
const sanitizeHtml = require('sanitize-html');
const { SANITIZE_HTML_OPTIONS } = require('../config/htmlSafeSubset');
const { MAX_TEAM_DEPTH } = require('../config/constants');
const { isRecaptchaDisabledForTesting } = require('../middleware/captcha');
const { resolveCloudTakUrl } = require('../utils/cloudtakUrl');
const { isForceSsoLoginEnabled } = require('../config/forceSso');
const { resolveChannelFolderSeparator } = require('../utils/channelFolderSeparator');
const logger = require('../config/logger').createLogger('SiteConfig');

/**
 * Default Expiry_Warning_Days: how far ahead of a certificate's `expires_at`
 * the Client draws an Imminent_Expiry. Used when
 * `DEVICE_MGMT_EXPIRY_WARNING_DAYS` is unset, empty, non-numeric, zero or
 * negative (Requirement 21.1).
 */
const DEFAULT_EXPIRY_WARNING_DAYS = 30;

class SiteConfig {
  static async getAll() {
    const result = await pool.query('SELECT * FROM site_config ORDER BY config_key');
    return result.rows;
  }

  static async getByKey(key) {
    const result = await pool.query('SELECT * FROM site_config WHERE config_key = $1', [key]);
    return result.rows[0];
  }

  static async update(key, value, userId) {
    // Restrict any admin-editable config_value to the documented safe HTML
    // subset before persisting, so storage is already safe regardless of
    // whether the value is later rendered via dangerouslySetInnerHTML on the
    // Client (Requirements 5.4, 5.5, 5.6).
    const sanitizedValue = typeof value === 'string'
      ? sanitizeHtml(value, SANITIZE_HTML_OPTIONS)
      : value;

    const result = await pool.query(
      'UPDATE site_config SET config_value = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP WHERE config_key = $3 RETURNING *',
      [sanitizedValue, userId, key]
    );
    return result.rows[0];
  }

  static async getPublicConfig() {
    const result = await pool.query(`
      SELECT config_key, config_value 
      FROM site_config 
      WHERE config_key IN ('request_access_title', 'request_access_subtitle', 'request_access_footer')
    `);
    const config = {};
    result.rows.forEach(row => {
      config[row.config_key] = row.config_value;
    });
    
    // Add channel folder separator from environment (quote-tolerant: an ECS
    // EnvironmentFile does not strip surrounding quotes, so `" - "` in the
    // config file would otherwise reach the client as a quoted literal and
    // stop the Dashboard folder tree from splitting names — see
    // resolveChannelFolderSeparator's doc comment).
    config.channel_folder_separator = resolveChannelFolderSeparator();

    // Expose the configured Authentik origin so the client can detect an
    // Authentik-originated referrer without hardcoding the Authentik
    // hostname (Requirement 1.4).
    if (process.env.AUTHENTIK_URL) {
      try {
        config.authentik_origin = new URL(process.env.AUTHENTIK_URL).origin;
      } catch (error) {
        logger.error({ err: error }, 'AUTHENTIK_URL is not a valid URL; omitting authentik_origin from public config');
        config.authentik_origin = null;
      }
    } else {
      config.authentik_origin = null;
    }

    // Expose the reCAPTCHA v3 SITE key (public by design -- it is
    // embedded directly in the rendered page to load Google's reCAPTCHA
    // script and call grecaptcha.execute()). The corresponding SECRET
    // key (RECAPTCHA_SECRET, used server-side only by
    // server/middleware/captcha.js's siteverify call) is never exposed
    // here or anywhere else.
    config.recaptcha_site_key = process.env.RECAPTCHA_SITE_KEY || null;

    // Expose whether the server-side reCAPTCHA check is currently
    // bypassed for testing (RECAPTCHA_DISABLED=true, non-production
    // only -- see captcha.js's isRecaptchaDisabledForTesting). The Client
    // uses this to skip loading Google's script / generating a token
    // entirely rather than blocking the form on a missing site key when
    // the server won't actually verify one.
    config.recaptcha_disabled = isRecaptchaDisabledForTesting();

    // Expose the system-wide Max_Team_Depth constant (Requirements 2.4,
    // 2.5, 5.7) so the Client's Add-Sub-team/Parent-dropdown disable logic
    // and the Callsign_Level_Selection toggle count never hardcode this
    // value a second time. Sourced from the same constant `Team.create`
    // enforces server-side, so it can never drift from the enforced limit.
    config.maxTeamDepth = MAX_TEAM_DEPTH;

    // Terms of Service URL — shown as a required checkbox on the sign-up
    // form (step 2). If not set, the checkbox is not shown.
    config.tos_url = process.env.TOS_URL || null;

    // Documentation URL — referenced in the approval email for getting started info.
    config.docs_url = process.env.DOCS_URL || null;

    // CloudTAK_URL — shown on the Downloads page as a browser-based option.
    // Independent of CLOUDTAK_ENABLED (server/config/cloudtak.js), which gates
    // an unrelated Authentik agency-group sync integration; this line never
    // reads isCloudTakEnabled() or process.env.CLOUDTAK_ENABLED
    // (downloads-page-os-sections Requirement 5.4).
    config.cloudtak_url = resolveCloudTakUrl(process.env.CLOUDTAK_URL);

    // Expose the 8 predefined TAK_Role display values (Requirement 13.4,
    // 13.5), so the Client's Member_List inline edit form (task 33.2,
    // `client/src/pages/TeamDetail.jsx`) can render its `TAK_Role` select
    // without hardcoding a second copy of this allow-list. This value is
    // not sensitive (it is the same fixed 8-label set already shown to
    // any authenticated user via the Role Descriptions admin surface,
    // `server/routes/settings.js`'s `ROLE_KEY_LABELS`), so exposing it on
    // this public, unauthenticated endpoint is safe.
    //
    // A Team_Admin editing a Member_List entry is not necessarily a
    // Global_Manager (`req.user.isAdmin`), so the existing
    // `GET /api/config/color-mappings` endpoint -- which 403s for any
    // non-Global_Manager -- is not a usable source here. `settings.js`
    // is required lazily (rather than at module load time) because
    // `settings.js` itself requires `SiteConfig` at module scope; a
    // top-level require here would create a load-order-dependent
    // circular require between the two modules.
    const { TAK_ROLE_VALUES } = require('../routes/settings');
    config.takRoleValues = TAK_ROLE_VALUES;

    // ---- Presentation_Config keys (Requirements 18.5, 18.6, 21.7) ----
    //
    // The two keys below exist ONLY so the Client can draw something the way
    // an operator configured it. They are deliberately here, and one of them
    // is deliberately named after a device-management environment variable.
    //
    // If you arrived at `device_expiry_warning_days` looking for a leak:
    // `DEVICE_MGMT_ENABLED` and `DEVICE_MGMT_REVOKE_ENABLED` are NOT here and
    // must never be added (Requirements 1.4, 12.9, 18.6). The distinction is
    // the whole reason these two are safe and those two are not negotiable:
    //
    //   - A display timezone and an expiry-highlight threshold are
    //     presentation. They carry no security meaning, arm no capability,
    //     and are useless on the server -- nothing server-side branches on
    //     either. The client that renders the dates is the only consumer, so
    //     the value has to reach it somehow, and this endpoint is that
    //     "somehow".
    //   - `DEVICE_MGMT_ENABLED` / `DEVICE_MGMT_REVOKE_ENABLED` describe the
    //     ARMING STATE OF A DESTRUCTIVE CAPABILITY. An unauthenticated caller
    //     has no business reading whether certificate revocation is live, and
    //     a client that could read the flag would branch on it instead of on
    //     the server's own 403/404. Feature discovery keeps using the
    //     self-view reachability probe, not a config key.
    //
    // So: presentation values may be exposed; capability-arming flags may
    // not. Adding a Presentation_Config key is not a precedent for exposing
    // the flags, and `server/models/SiteConfig.test.js` asserts their
    // continued absence.

    // Display_Timezone (Requirements 18.1, 18.5): the zone the Client's
    // shared Date_Format_Helpers (`client/src/utils/dateFormat.js`) compute
    // every user-visible date's wall-clock components in -- app-wide, not
    // just on device-management surfaces. Presentation only: stored, logged
    // and API-transported timestamps stay ISO-8601/UTC and are not converted
    // (Requirement 18.12). A client that never receives this key falls back
    // to the same `Pacific/Auckland` literal (Requirement 18.7).
    config.display_timezone = process.env.DISPLAY_TIMEZONE || 'Pacific/Auckland';

    // Display_Locale (Requirements 18.1, 18.5's sibling): the locale the
    // Client uses for locale-DEPENDENT formatting. Two consumers today:
    //   1. the short timezone abbreviation the Date_Format_Helpers append to
    //      a rendered date-and-time (e.g. "NZST" under 'en-NZ' vs "GMT+12"
    //      under 'en-US' for the same Pacific/Auckland zone). The numeric
    //      `yyyy-mm-dd HH:MM` components stay locale-INdependent.
    //   2. thousands grouping separators on counts/totals via
    //      `client/src/utils/formatNumber.js` (e.g. "13,329" under 'en-NZ',
    //      "13.329" under 'de-DE') -- surfaced on /admin stat cards, the
    //      Background Sync card, and pagination footers.
    // Both read the SAME configured locale (via `getDisplayLocale`), never the
    // browser's own (non-deterministic across machines). A client that never
    // receives this key falls back to the same `en-NZ` literal.
    config.display_locale = process.env.DISPLAY_LOCALE || 'en-NZ';

    // Expiry_Warning_Days (Requirements 21.1, 21.7): how many days ahead of a
    // certificate's `expires_at` the Client starts drawing it as an imminent
    // expiry. Resolved with the `parseInt(...) || <default>` discipline
    // `getRevokeMaxCerts()` follows in `server/config/deviceMgmt.js`, plus an
    // explicit positive-integer guard: unset, empty, non-numeric and zero all
    // fall through the `||`, and a NEGATIVE value is caught by the `> 0`
    // check, so all four cases yield 30 as Requirement 21.1 requires.
    // (`getRevokeMaxCerts` clamps with `Math.max(1, ...)` instead, which
    // would turn a negative into 1 -- correct for a blast-radius cap that
    // must stay usable, wrong for a threshold whose documented default is
    // 30.) Presentation only: nothing server-side reads this, and the read
    // path gained no expiry predicate (Requirement 21.9).
    const parsedExpiryWarningDays =
      parseInt(process.env.DEVICE_MGMT_EXPIRY_WARNING_DAYS, 10) || DEFAULT_EXPIRY_WARNING_DAYS;
    config.device_expiry_warning_days = parsedExpiryWarningDays > 0
      ? parsedExpiryWarningDays
      : DEFAULT_EXPIRY_WARNING_DAYS;

    // Enrollment_Manual_Description: the "Description" label shown on the
    // Enrollment_View's WinTAK/Manual tab (client/src/pages/EnrollmentView.jsx),
    // alongside the manually-entered Host/Port/Protocol/Username/Password
    // fields. Presentation only, same category as `docs_url`/`cloudtak_url`
    // above -- deployment-specific display text, arms no capability, and
    // nothing server-side branches on it.
    //
    // Named WINTAK_MANUAL_DESCRIPTION rather than ENROLLMENT_MANUAL_DESCRIPTION
    // deliberately: server/config/__tests__/enrollmentPermissions.test.js
    // asserts no NEW `ENROLLMENT_*` key is ever added to .env.example, because
    // that prefix is reserved for takserver-enrollment's own constants
    // (ENROLLMENT_PORT, token/cert lifetimes), which are deliberately code
    // constants, never env vars. This variable is unrelated to that feature.
    config.enrollment_manual_description = process.env.WINTAK_MANUAL_DESCRIPTION || 'TAK.NZ';

    // Force_Sso_Login (server/config/forceSso.js): whether the Login page
    // should immediately start the OAuth2 redirect itself rather than
    // waiting for the user to click "Sign in". Presentation only -- see
    // that module's own doc comment for why this, unlike
    // DEVICE_MGMT_ENABLED/DEVICE_MGMT_REVOKE_ENABLED, is safe to expose
    // here.
    config.force_sso_login = isForceSsoLoginEnabled();

    return config;
  }
}

module.exports = SiteConfig;