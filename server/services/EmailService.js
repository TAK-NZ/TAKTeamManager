const nodemailer = require('nodemailer');
const pool = require('../config/database');
const logger = require('../config/logger').createLogger('EmailService');
const { wrapInBrandedTemplate } = require('../templates/emailBase');
const { stripOneMatchedQuotePair } = require('../utils/channelFolderSeparator');
const { writeAuditLog } = require('../utils/auditLog');

// Audit action names for outbound email (dotted resource.verb convention,
// matching every other action string in this codebase). Every email the
// system sends is recorded in `audit_logs` from the ONE choke point below,
// so a new send site is covered automatically and the trail can never miss
// a message that actually left (or failed to leave) the system.
const EMAIL_AUDIT_RESOURCE_TYPE = 'email';
const EMAIL_SENT_ACTION = 'email.sent';
const EMAIL_SEND_FAILED_ACTION = 'email.send_failed';

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

    // Strip one matched pair of surrounding quotes, if present. EMAIL_FROM is
    // typically `Display Name <addr@host>`, and in the ECS deployment it comes
    // from the Part-2 S3 EnvironmentFile — which, unlike a shell sourcing a
    // .env, does NOT strip quotes from a `KEY="value"` line. A config file
    // written `EMAIL_FROM="TAK.NZ Account <account@tak.nz>"` therefore delivered
    // the literal quotes into process.env, and nodemailer then mangled the
    // whole quoted blob into a broken `From` header
    // (`<"TAK.NZ Account account"@tak.nz>`). Same ECS-quoting trap as
    // CHANNEL_FOLDER_SEPARATOR; reuse the same one-matched-pair stripper. A
    // value with no surrounding pair (the correct, unquoted form) is untouched.
    const rawFrom = process.env.EMAIL_FROM;
    this.fromAddress = typeof rawFrom === 'string' ? stripOneMatchedQuotePair(rawFrom) : rawFrom;

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

  /**
   * Send one templated email AND record it in the audit log.
   *
   * This is the single choke point every outbound email funnels through
   * (the sendVerificationEmail/sendApprovalEmail/sendDenialEmail helpers,
   * and every direct `sendEmail(...)` caller across routes, the transfer
   * post-commit effect, and the scheduled digest/notification jobs). Auditing
   * HERE -- rather than at each of the ~nine call sites -- is what makes the
   * "every email is logged" guarantee hold even for a future send site, and
   * it is the one place that always knows the real sent-vs-failed outcome.
   *
   * The audit write is BEST-EFFORT (writeAuditLog with no transaction client
   * swallows its own failure): an email that already went out must not be
   * reported as a failure just because its audit row could not be written,
   * and the audit write must never change what a caller observes -- important
   * for the public signup path, which deliberately returns a fixed response
   * for every outcome to avoid an enumeration oracle.
   *
   * @param {string} to  recipient address.
   * @param {string} templateKey  email_templates.template_key.
   * @param {object} [variables]  template substitution values.
   * @param {object} [context]  optional audit context from the caller.
   * @param {number|null} [context.actorUserId]  LOCAL users.id of the user who
   *   triggered the send, when a request/actor exists; null for background
   *   sends (digests, pollers, the public signup flow), which have no actor.
   * @param {number|null} [context.targetUserId]  LOCAL users.id the email is
   *   about, when there is a single subject user; recorded as resource_id.
   * @returns {Promise<object>} the nodemailer send result.
   */
  async sendEmail(to, templateKey, variables = {}, context = {}) {
    const { actorUserId = null, targetUserId = null } = context || {};

    // Template resolution and rendering happen BEFORE the audited region: a
    // missing template (or a render fault) is a configuration error, not a
    // send attempt, so it throws here and produces no email audit row. Only
    // an actual transport attempt below is audited -- so `email.sent` and
    // `email.send_failed` both mean "we handed a real message to SMTP", and
    // `email.send_failed` is a genuine delivery failure rather than config
    // noise.
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

    try {
      const result = await this.transporter.sendMail({
        from: this.fromAddress,
        to,
        subject,
        text: body,   // plain text fallback
        html          // branded HTML version
      });

      logger.info({ messageId: result.messageId }, 'Email sent');
      await this.auditEmail(EMAIL_SENT_ACTION, {
        actorUserId,
        targetUserId,
        recipient: to,
        templateKey,
        messageId: result && result.messageId ? result.messageId : null
      });
      return result;

    } catch (error) {
      logger.error({ err: error }, 'Failed to send email');
      // Record the failed attempt too -- "the system tried to email X and it
      // did not go out" is exactly the kind of event the audit log exists to
      // answer. Logged before the re-throw so a caller's own error handling is
      // unchanged. `resource_id` (targetUserId) is still recorded when known.
      await this.auditEmail(EMAIL_SEND_FAILED_ACTION, {
        actorUserId,
        targetUserId,
        recipient: to,
        templateKey,
        error: error && error.message ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Append one email audit row via the shared best-effort writeAuditLog.
   * `resource_id` is the subject user's LOCAL id when known (an integer
   * column, so the string template_key and recipient go in `details`, never
   * there). Never throws -- writeAuditLog without a transaction client logs
   * and swallows its own failure.
   *
   * @param {'email.sent'|'email.send_failed'} action
   * @param {{actorUserId: number|null, targetUserId: number|null, recipient: string, templateKey: string, messageId?: string|null, error?: string}} params
   */
  async auditEmail(action, { actorUserId, targetUserId, recipient, templateKey, messageId, error }) {
    const details = { recipient, templateKey };
    if (messageId != null) {
      details.messageId = messageId;
    }
    if (error != null) {
      details.error = error;
    }
    // Belt-and-braces: writeAuditLog (no transaction client) is already
    // best-effort and swallows its own failure, but this method is called on
    // the success path of a send that has ALREADY happened, so an audit
    // rejection must never propagate and turn a delivered email into a thrown
    // error. Catch here too, so the guarantee holds independent of the
    // helper's internal behaviour.
    try {
      await writeAuditLog({
        userId: actorUserId ?? null,
        action,
        resourceType: EMAIL_AUDIT_RESOURCE_TYPE,
        resourceId: targetUserId ?? null,
        details
      });
    } catch (auditErr) {
      logger.error({ err: auditErr, action }, 'Failed to write email audit_logs row');
    }
  }

  replaceVariables(template, variables) {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      result = result.replace(new RegExp(`{{${key}}}`, 'g'), value || '');
    }
    return result;
  }

  // The three template-specific helpers each forward an optional audit
  // `context` ({ actorUserId, targetUserId }) straight through to sendEmail,
  // so a caller that knows who triggered the send and who it is about can
  // have that recorded. Omitting it (the default {}) yields a null actor and
  // null target -- correct for a background send with no request behind it.

  async sendVerificationEmail(email, token, firstName = '', context = {}) {
    const verificationLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/request-access?token=${token}`;
    const expiryHours = await this.getConfigValue('email_verification_hours', '24');

    return this.sendEmail(email, 'access_request_verification', {
      first_name: firstName,
      verification_link: verificationLink,
      expiry_hours: expiryHours
    }, context);
  }

  async sendApprovalEmail(email, { teamPath, username, callsign, firstName, additionalDetails } = {}, context = {}) {
    return this.sendEmail(email, 'access_request_approved', {
      team_path: teamPath || '',
      username: username || email,
      first_name: firstName || '',
      callsign: callsign || 'Will be assigned',
      additional_details: additionalDetails || '',
      password_reset_url: process.env.PASSWORD_RESET_URL || '',
      login_url: process.env.ACCOUNT_LOGIN_URL || '',
      docs_url: process.env.DOCS_URL || ''
    }, context);
  }

  async sendDenialEmail(email, { teamPath, firstName, denialReason } = {}, context = {}) {
    return this.sendEmail(email, 'access_request_denied', {
      first_name: firstName || '',
      team_path: teamPath || '',
      denial_reason: denialReason || ''
    }, context);
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
}

module.exports = EmailService;
