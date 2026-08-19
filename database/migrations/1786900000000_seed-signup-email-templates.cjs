/**
 * Seeds the `signup_pending_review` and `signup_already_active` email
 * templates required by SignupFlowService.initiateSignup (the two-step
 * sign-up flow). Without these rows, the 'pending_approval' and 'active'
 * email state branches throw "Email template not found".
 *
 * Uses ON CONFLICT DO NOTHING so this is idempotent.
 */
const shorthands = undefined;

const up = (pgm) => {
  pgm.sql(`
    INSERT INTO email_templates (template_key, subject_template, body_template, description)
    VALUES (
      'signup_pending_review',
      'Your account request is being reviewed',
      'Hi,

Your account request is currently being reviewed by a team administrator. You will receive another email once a decision has been made.

If you have questions, contact your team administrator.',
      'Sent when a user re-submits email at step 1 but already has a pending approval'
    )
    ON CONFLICT (template_key) DO NOTHING;

    INSERT INTO email_templates (template_key, subject_template, body_template, description)
    VALUES (
      'signup_already_active',
      'You already have an account',
      'Hi,

An account already exists with this email address.

If you need to reset your password, visit: {{password_reset_url}}

If you did not initiate this request, please ignore this email.',
      'Sent when a user submits email at step 1 but already has an active account'
    )
    ON CONFLICT (template_key) DO NOTHING;
  `);
};

const down = (pgm) => {
  pgm.sql(`
    DELETE FROM email_templates WHERE template_key IN ('signup_pending_review', 'signup_already_active');
  `);
};

module.exports = { shorthands, up, down };
