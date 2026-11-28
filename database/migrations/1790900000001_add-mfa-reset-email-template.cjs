/**
 * Add the `mfa_reset` email template: sent to a user after an administrator reset their MFA (Team Manager,
 * POST /api/users/:userId/reset-mfa). It carries a new one-time activation link.
 *
 * database/init.js seeds with ON CONFLICT DO NOTHING and runs migrations first, so this migration is where the row is
 * created, on a new database as well as an existing one. An administrator's edits to the body are never overwritten.
 */
const shorthands = undefined;
const up = (pgm) => {
  pgm.sql(`
    INSERT INTO email_templates (template_key, subject_template, body_template, description)
    VALUES (
      'mfa_reset',
      'Set up your TAK.NZ sign-in again',
      $tpl$Hi {{first_name}},

An administrator has reset the sign-in methods on your TAK.NZ account ({{username}}) at your request. Your password, your passkeys, authenticator apps and recovery codes have been removed, and you have been signed out everywhere.

Set up your sign-in again: <a href="{{password_reset_url}}">Set up your sign-in</a>. The link works once and for 24 hours; if it has expired, ask your team administrator for a new one.

If you did not ask for this, contact your team administrator straight away.

Login at: {{login_url}}$tpl$,
      'Sent after an administrator reset a user''s MFA (passkeys, authenticator apps, recovery codes, password). Carries a new one-time activation link.'
    )
    ON CONFLICT (template_key) DO NOTHING;
  `);
};
const down = (pgm) => {
  pgm.sql(`DELETE FROM email_templates WHERE template_key = 'mfa_reset';`);
};
module.exports = { shorthands, up, down };
