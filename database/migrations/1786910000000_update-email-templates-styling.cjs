/**
 * Updates the verification and approval email templates with improved
 * styling: better fallback URL wording, info-box styling for approval
 * details, and safety notes.
 */
const shorthands = undefined;

const up = (pgm) => {
  pgm.sql(`
    UPDATE email_templates SET body_template = E'Hi {{first_name}},\\n\\nPlease verify your email to complete your account request.\\n\\n<a href="{{verification_link}}" class="btn-primary" style="text-decoration: none; color: #FFF; background-color: #348eda; border: solid #348eda; border-width: 10px 20px; font-weight: bold; display: inline-block; border-radius: 4px;">Verify my email</a>\\n\\n<span style="font-size: 12px; color: #999;">If the button above doesn\\x27t work, copy and paste this link into your browser:</span>\\n{{verification_link}}\\n\\nThis link will expire in {{expiry_hours}} hours.\\n\\nIf you did not make this request, you can safely ignore this email.' WHERE template_key = 'access_request_verification';

    UPDATE email_templates SET body_template = E'Hi {{first_name}},\\n\\nYour request for an account has been approved.\\n\\n<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 16px 0;"><tr><td style="background-color: #f0f7ff; border-radius: 8px; border-left: 4px solid #348eda; padding: 16px 20px;"><b>Team:</b> {{team_path}}<br><b>Username:</b> <a href="#" style="color: #212124; text-decoration: none; cursor: default; pointer-events: none;">{{username}}</a><br><b>TAK Callsign:</b> <code>{{callsign}}</code></td></tr></table>\\n\\nGet started: <a href="{{password_reset_url}}">Set a password</a>, or sign in with an Apple or Google account linked to your username above.\\n\\nLogin at: {{login_url}}\\n\\nIf you have questions, contact your team administrator.\\n\\n<span style="font-size: 12px; color: #999;">If you did not expect this email, you can safely ignore it.</span>' WHERE template_key = 'access_request_approved';
  `);
};

const down = (pgm) => {
  // No rollback — template content is always forward-only
};

module.exports = { shorthands, up, down };
