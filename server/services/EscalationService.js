const pool = require('../config/database');
const EmailService = require('./EmailService');
const { createLogger } = require('../config/logger');

const logger = createLogger('EscalationService');

class EscalationService {
  constructor() {
    this.emailService = new EmailService();
  }

  async processEscalations() {
    try {
      logger.info('Processing request escalations');
      
      // Get requests that need escalation
      const escalationResult = await pool.query(`
        SELECT ar.*, t.name as team_name, t.parent_team_id
        FROM access_requests ar
        LEFT JOIN teams t ON ar.target_team_id = t.id
        WHERE ar.status = 'pending' 
          AND ar.email_verified = true
          AND ar.escalates_at <= NOW()
        ORDER BY ar.created_at ASC
      `);
      
      for (const request of escalationResult.rows) {
        await this.escalateRequest(request);
      }
      
      logger.info({ count: escalationResult.rows.length }, 'Processed escalations');

    } catch (error) {
      logger.error({ err: error }, 'Escalation processing failed');
    }
  }

  async escalateRequest(request) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const nextLevel = request.escalation_level + 1;
      let newAdminId = null;
      
      if (nextLevel === 1 && request.team_name) {
        // Escalate to parent team admin
        const parentAdminResult = await client.query(`
          SELECT u.id
          FROM users u
          JOIN team_memberships tm ON u.id = tm.user_id
          WHERE tm.team_id = $1 AND tm.role IN ('admin', 'owner')
          ORDER BY RANDOM()
          LIMIT 1
        `, [request.parent_team_id]);
        
        if (parentAdminResult.rows.length > 0) {
          newAdminId = parentAdminResult.rows[0].id;
        }
      } else if (nextLevel >= 2) {
        // Escalate to global admin
        const globalAdminResult = await client.query(`
          SELECT id FROM users WHERE is_global_manager = true ORDER BY RANDOM() LIMIT 1
        `);
        
        if (globalAdminResult.rows.length > 0) {
          newAdminId = globalAdminResult.rows[0].id;
        }
      }
      
      if (newAdminId) {
        // Calculate next escalation time
        const nextEscalationTime = await this.calculateEscalationTime();
        
        // Update request
        await client.query(`
          UPDATE access_requests 
          SET escalation_level = $1, assigned_to_admin = $2, escalates_at = $3
          WHERE id = $4
        `, [nextLevel, newAdminId, nextEscalationTime, request.id]);
        
        logger.info({ requestId: request.id, escalationLevel: nextLevel }, 'Escalated request');
      } else {
        // No more escalation levels, mark as expired
        await client.query(`
          UPDATE access_requests 
          SET status = 'expired'
          WHERE id = $1
        `, [request.id]);
        
        logger.info({ requestId: request.id }, 'Request expired - no more escalation levels');
      }
      
      await client.query('COMMIT');
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async sendDailyDigests() {
    try {
      logger.info('Sending daily admin notification digests');
      
      // Get admins with pending requests
      const adminResult = await pool.query(`
        SELECT DISTINCT 
          u.id, u.email, u.first_name, u.last_name,
          anp.notification_method, anp.digest_time
        FROM users u
        LEFT JOIN admin_notification_preferences anp ON u.id = anp.user_id
        JOIN access_requests ar ON u.id = ar.assigned_to_admin
        WHERE ar.status = 'pending' AND ar.email_verified = true
          AND (anp.notification_method IS NULL OR anp.notification_method = 'daily_digest')
      `);
      
      for (const admin of adminResult.rows) {
        await this.sendAdminDigest(admin);
      }
      
      logger.info({ count: adminResult.rows.length }, 'Sent digests to admins');

    } catch (error) {
      logger.error({ err: error }, 'Daily digest sending failed');
    }
  }

  async sendAdminDigest(admin) {
    try {
      // Get pending requests for this admin
      const requestsResult = await pool.query(`
        SELECT ar.*, t.name as team_name
        FROM access_requests ar
        LEFT JOIN teams t ON ar.target_team_id = t.id
        WHERE ar.assigned_to_admin = $1 
          AND ar.status = 'pending' 
          AND ar.email_verified = true
        ORDER BY ar.created_at ASC
      `, [admin.id]);
      
      if (requestsResult.rows.length === 0) return;
      
      // Format request list as structured blocks
      const requestList = requestsResult.rows.map(req => {
        const email = req.requester_email || '';
        const emailDisplay = `<a href="#" style="color: #212124; text-decoration: none; cursor: default; pointer-events: none;">${email}</a>`;
        return `<b>User:</b> ${req.requester_first_name || ''} ${req.requester_last_name || ''}
<b>E-Mail:</b> ${emailDisplay}
<b>Team:</b> ${req.team_name || 'Team access'}`;
      }).join('\n\n');
      
      // Send digest email
      await this.emailService.sendEmail(admin.email, 'admin_notification_digest', {
        first_name: admin.first_name || '',
        pending_count: requestsResult.rows.length,
        request_list: requestList,
        team_manager_url: process.env.FRONTEND_URL || ''
      });
      
    } catch (error) {
      logger.error({ err: error, adminEmail: admin.email }, 'Failed to send digest to admin');
    }
  }

  async calculateEscalationTime() {
    const escalationHours = await this.getConfigValue('escalation_hours', '24');
    const excludeWeekends = await this.getConfigValue('weekend_escalation', 'false') === 'false';
    
    let escalationTime = new Date(Date.now() + parseInt(escalationHours) * 60 * 60 * 1000);
    
    if (excludeWeekends) {
      // Skip weekends
      while (escalationTime.getDay() === 0 || escalationTime.getDay() === 6) {
        escalationTime.setDate(escalationTime.getDate() + 1);
      }
    }
    
    return escalationTime;
  }

  async getConfigValue(key, defaultValue) {
    try {
      const result = await pool.query('SELECT config_value FROM system_config WHERE config_key = $1', [key]);
      return result.rows[0]?.config_value || defaultValue;
    } catch (error) {
      logger.warn({ err: error, key }, 'Failed to read system_config value; falling back to default');
      return defaultValue;
    }
  }

  startDailySchedule() {
    // Run escalation check every hour. processEscalations() already has its
    // own internal try/catch, but setInterval's callback never awaits or
    // catches the promise it returns, so this remains a fire-and-forget
    // async invocation. The .catch() below is a defensive backstop per
    // Requirement 8.7, routing any error that escapes the internal
    // try/catch through the structured logger instead of going unhandled.
    setInterval(() => {
      this.processEscalations().catch(err =>
        logger.error({ err }, 'Scheduled escalation processing failed')
      );
    }, 60 * 60 * 1000);

    // Run daily digest at configured time/timezone (defaults: 9:00 Pacific/Auckland).
    const digestHour = parseInt(process.env.DIGEST_HOUR, 10) || 9;
    const digestMinute = parseInt(process.env.DIGEST_MINUTE, 10) || 0;
    const digestTimezone = process.env.DIGEST_TIMEZONE || 'Pacific/Auckland';
    logger.info({ digestHour, digestMinute, digestTimezone }, 'Daily digest scheduled');

    setInterval(() => {
      const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: digestTimezone }));
      if (nowInTz.getHours() === digestHour && nowInTz.getMinutes() === digestMinute) {
        this.sendDailyDigests().catch(err =>
          logger.error({ err }, 'Scheduled daily digest sending failed')
        );
      }
    }, 60 * 1000);

    logger.info('Escalation service scheduled');
  }
}

module.exports = EscalationService;