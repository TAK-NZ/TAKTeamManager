const pool = require('../config/database');
const sanitizeHtml = require('sanitize-html');
const { SANITIZE_HTML_OPTIONS } = require('../config/htmlSafeSubset');

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

    return config;
  }
}

module.exports = SiteConfig;