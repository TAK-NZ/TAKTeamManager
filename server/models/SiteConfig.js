const pool = require('../config/database');

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
    const result = await pool.query(
      'UPDATE site_config SET config_value = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP WHERE config_key = $3 RETURNING *',
      [value, userId, key]
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
    
    return config;
  }
}

module.exports = SiteConfig;