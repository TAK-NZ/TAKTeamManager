const nodemailer = require('nodemailer');
const pool = require('../config/database');
const logger = require('../config/logger').createLogger('EmailService');
const { wrapInBrandedTemplate } = require('../templates/emailBase');

// Requirement 6.5/6.6: generic SMTP configuration, not tied to any single
// provider (AWS SES, Authentik's own outbound mail relay, or otherwise) --
// any SMTP-compatible server can be plugged in via these env vars.
const DEFAULT_SMTP_PORT = 587;
const DEFAULT_TIMEOUT_SECONDS = 10;

class EmailService {
  constructor() {
    const port = parseInt(process.env.EMAIL_PORT, 10) || DEFAULT_SMTP_PORT;
    const timeoutSeconds = parseInt(process.env.EMAIL_TIMEOUT, 10) || DEFAULT_TIMEOUT_SECONDS;
    const timeoutMs = timeoutSeconds * 1000;

    // EMAIL_USE_SSL: connect over implicit TLS from the start (SMTPS,
    // typically port 465). EMAIL_USE_TLS: upgrade a plaintext connection
    // via STARTTLS (typically port 587) -- nodemailer's own `secure`
    // option controls the former; the latter is its default behavior for
    // a non-`secure` transport unless explicitly disabled, so
    // EMAIL_USE_TLS=false is honored via `requireTLS`/`ignoreTLS` below.
    const useSsl = process.env.EMAIL_USE_SSL === 'true';
    const useTls = process.env.EMAIL_USE_TLS !== 'false';

    this.fromAddress = process.env.EMAIL_FROM;

    this.transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port,
      secure: useSsl,
      // When not using implicit TLS (EMAIL_USE_SSL=false), EMAIL_USE_TLS
      // controls whether STARTTLS is required or skipped entirely.
      ...(useSsl
        ? {}
        : useTls
          ? { requireTLS: true }
          : { ignoreTLS: true }),
      auth: {
        user: process.env.EMAIL_USERNAME,
        pass: process.env.EMAIL_PASSWORD
      },
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs
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

      // Convert plain text body to simple HTML (paragraphs for line breaks)
      const bodyHtml = body
        .split('\n\n')
        .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
        .join('');
      const html = wrapInBrandedTemplate(bodyHtml);

      const result = await this.transporter.sendMail({
        from: this.fromAddress,
        to,
        subject,
        text: body,   // plain text fallback
        html          // branded HTML version
      });

      logger.info({ messageId: result.messageId }, 'Email sent');
      return result;

    } catch (error) {
      logger.error({ err: error }, 'Failed to send email');
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

  async sendVerificationEmail(email, token, firstName = '') {
    const verificationLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-request?token=${token}`;
    const expiryHours = await this.getConfigValue('email_verification_hours', '24');

    return this.sendEmail(email, 'access_request_verification', {
      first_name: firstName,
      verification_link: verificationLink,
      expiry_hours: expiryHours
    });
  }

  async sendApprovalEmail(email, { teamPath, username, callsign, firstName, additionalDetails } = {}) {
    return this.sendEmail(email, 'access_request_approved', {
      team_path: teamPath || '',
      username: username || email,
      first_name: firstName || '',
      callsign: callsign || 'Will be assigned',
      additional_details: additionalDetails || '',
      password_reset_url: process.env.PASSWORD_RESET_URL || '',
      login_url: process.env.ACCOUNT_LOGIN_URL || ''
    });
  }

  async sendDenialEmail(email, { teamPath, firstName, denialReason } = {}) {
    return this.sendEmail(email, 'access_request_denied', {
      first_name: firstName || '',
      team_path: teamPath || '',
      denial_reason: denialReason || ''
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
