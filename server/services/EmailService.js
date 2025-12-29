const AWS = require('aws-sdk');
const pool = require('../config/database');

class EmailService {
  constructor() {
    this.ses = new AWS.SES({
      region: process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    });
  }

  async sendEmail(to, templateKey, variables = {}) {
    try {
      // Get template
      const templateResult = await pool.query(
        'SELECT subject_template, body_template FROM email_templates WHERE template_key = $1',
        [templateKey]
      );
      
      if (templateResult.rows.length === 0) {
        throw new Error(`Email template not found: ${templateKey}`);
      }
      
      const template = templateResult.rows[0];
      
      // Replace variables in template
      const subject = this.replaceVariables(template.subject_template, variables);
      const body = this.replaceVariables(template.body_template, variables);
      
      // Send email
      const params = {
        Source: process.env.SES_FROM_EMAIL,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: subject },
          Body: { Text: { Data: body } }
        }
      };
      
      const result = await this.ses.sendEmail(params).promise();
      console.log('Email sent:', result.MessageId);
      return result;
      
    } catch (error) {
      console.error('Failed to send email:', error);
      throw error;
    }
  }

  replaceVariables(template, variables) {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), value || '');
    }
    return result;
  }

  async sendVerificationEmail(email, token) {
    const verificationLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-request?token=${token}`;
    const expiryHours = await this.getConfigValue('email_verification_hours', '24');
    
    return this.sendEmail(email, 'access_request_verification', {
      verification_link: verificationLink,
      expiry_hours: expiryHours
    });
  }

  async sendApprovalEmail(email, requestDescription, adminName, additionalDetails = '') {
    return this.sendEmail(email, 'access_request_approved', {
      request_description: requestDescription,
      admin_name: adminName,
      additional_details: additionalDetails
    });
  }

  async sendDenialEmail(email, requestDescription, adminName, denialReason) {
    return this.sendEmail(email, 'access_request_denied', {
      request_description: requestDescription,
      admin_name: adminName,
      denial_reason: denialReason
    });
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

module.exports = EmailService;