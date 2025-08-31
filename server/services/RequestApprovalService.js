const pool = require('../config/database');
const EmailService = require('./EmailService');
const crypto = require('crypto');

class RequestApprovalService {
  constructor() {
    this.emailService = new EmailService();
  }

  async createAccessRequest(requestData) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Generate verification token
      const token = crypto.randomBytes(32).toString('hex');
      const expiryHours = await this.getConfigValue('email_verification_hours', '24');
      const expiresAt = new Date(Date.now() + parseInt(expiryHours) * 60 * 60 * 1000);
      
      // Calculate escalation time (24 hours from now, excluding weekends if configured)
      const escalatesAt = await this.calculateEscalationTime();
      
      // Insert request
      const result = await client.query(`
        INSERT INTO access_requests (
          request_type, requester_email, requester_first_name, requester_last_name,
          existing_user_id, target_team_id, current_team_id, requested_role,
          requested_first_name, requested_last_name, justification,
          email_verification_token, email_verification_expires_at, escalates_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id
      `, [
        requestData.request_type,
        requestData.requester_email,
        requestData.requester_first_name,
        requestData.requester_last_name,
        requestData.existing_user_id || null,
        requestData.target_team_id || null,
        requestData.current_team_id || null,
        requestData.requested_role || null,
        requestData.requested_first_name || null,
        requestData.requested_last_name || null,
        requestData.justification,
        token,
        expiresAt,
        escalatesAt
      ]);
      
      const requestId = result.rows[0].id;
      
      // Send verification email
      await this.emailService.sendVerificationEmail(requestData.requester_email, token);
      
      await client.query('COMMIT');
      return { requestId, token };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async verifyEmail(token) {
    const result = await pool.query(`
      UPDATE access_requests 
      SET email_verified = true 
      WHERE email_verification_token = $1 
        AND email_verification_expires_at > NOW() 
        AND status = 'pending'
      RETURNING id, requester_email, target_team_id
    `, [token]);
    
    if (result.rows.length === 0) {
      throw new Error('Invalid or expired verification token');
    }
    
    const request = result.rows[0];
    
    // Assign to appropriate admin
    await this.assignToAdmin(request.id, request.target_team_id);
    
    return request;
  }

  async assignToAdmin(requestId, teamId) {
    if (!teamId) return;
    
    // Find team admins
    const adminResult = await pool.query(`
      SELECT u.id, u.email, u.first_name, u.last_name
      FROM users u
      JOIN team_memberships tm ON u.id = tm.user_id
      WHERE tm.team_id = $1 AND tm.role IN ('admin', 'owner')
      ORDER BY RANDOM()
      LIMIT 1
    `, [teamId]);
    
    if (adminResult.rows.length > 0) {
      const admin = adminResult.rows[0];
      await pool.query(
        'UPDATE access_requests SET assigned_to_admin = $1 WHERE id = $2',
        [admin.id, requestId]
      );
    }
  }

  async approveRequest(requestId, adminId, additionalDetails = '') {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get request details
      const requestResult = await client.query(`
        SELECT ar.*, t.name as team_name, u.first_name as admin_first_name, u.last_name as admin_last_name
        FROM access_requests ar
        LEFT JOIN teams t ON ar.target_team_id = t.id
        LEFT JOIN users u ON u.id = $2
        WHERE ar.id = $1 AND ar.status = 'pending'
      `, [requestId, adminId]);
      
      if (requestResult.rows.length === 0) {
        throw new Error('Request not found or already processed');
      }
      
      const request = requestResult.rows[0];
      
      // Update request status
      await client.query(`
        UPDATE access_requests 
        SET status = 'approved', processed_by = $2, processed_at = NOW()
        WHERE id = $1
      `, [requestId, adminId]);
      
      // Process the request based on type
      await this.processApprovedRequest(client, request);
      
      // Send approval email
      const adminName = `${request.admin_first_name} ${request.admin_last_name}`;
      const requestDescription = this.getRequestDescription(request);
      
      await this.emailService.sendApprovalEmail(
        request.requester_email,
        requestDescription,
        adminName,
        additionalDetails
      );
      
      await client.query('COMMIT');
      return { success: true };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async denyRequest(requestId, adminId, denialReason) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get request details
      const requestResult = await client.query(`
        SELECT ar.*, u.first_name as admin_first_name, u.last_name as admin_last_name
        FROM access_requests ar
        LEFT JOIN users u ON u.id = $2
        WHERE ar.id = $1 AND ar.status = 'pending'
      `, [requestId, adminId]);
      
      if (requestResult.rows.length === 0) {
        throw new Error('Request not found or already processed');
      }
      
      const request = requestResult.rows[0];
      
      // Update request status
      await client.query(`
        UPDATE access_requests 
        SET status = 'denied', processed_by = $2, processed_at = NOW(), denial_reason = $3
        WHERE id = $1
      `, [requestId, adminId, denialReason]);
      
      // Send denial email
      const adminName = `${request.admin_first_name} ${request.admin_last_name}`;
      const requestDescription = this.getRequestDescription(request);
      
      await this.emailService.sendDenialEmail(
        request.requester_email,
        requestDescription,
        adminName,
        denialReason
      );
      
      await client.query('COMMIT');
      return { success: true };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async processApprovedRequest(client, request) {
    switch (request.request_type) {
      case 'new_account':
        // Create user and add to team - this would integrate with existing user creation logic
        break;
      case 'team_change':
        // Move user to new team - integrate with TeamMembershipService
        break;
      case 'role_change':
        // Update user role
        break;
      case 'name_change':
        // Update user name in Authentik
        break;
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

  getRequestDescription(request) {
    switch (request.request_type) {
      case 'new_account':
        return `join team "${request.team_name}"`;
      case 'team_change':
        return `change teams`;
      case 'role_change':
        return `change role to "${request.requested_role}"`;
      case 'name_change':
        return `change name`;
      default:
        return 'access TAK Team Manager';
    }
  }

  async getConfigValue(key, defaultValue) {
    try {
      const result = await pool.query('SELECT config_value FROM system_config WHERE config_key = $1', [key]);
      return result.rows[0]?.config_value || defaultValue;
    } catch (error) {
      return defaultValue;
    }
  }
}

module.exports = RequestApprovalService;