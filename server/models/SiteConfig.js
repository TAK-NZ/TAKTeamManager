const pool = require('../config/database');
const sanitizeHtml = require('sanitize-html');
const { SANITIZE_HTML_OPTIONS } = require('../config/htmlSafeSubset');
const { MAX_TEAM_DEPTH } = require('../config/constants');
const { isRecaptchaDisabledForTesting } = require('../middleware/captcha');

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
    
    // Add channel folder separator from environment
    config.channel_folder_separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';

    // Expose the configured Authentik origin so the client can detect an
    // Authentik-originated referrer without hardcoding the Authentik
    // hostname (Requirement 1.4).
    if (process.env.AUTHENTIK_URL) {
      try {
        config.authentik_origin = new URL(process.env.AUTHENTIK_URL).origin;
      } catch (error) {
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

    return config;
  }
}

module.exports = SiteConfig;