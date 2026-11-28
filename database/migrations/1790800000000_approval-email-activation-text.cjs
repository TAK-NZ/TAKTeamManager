/**
 * Update the wording of the access_request_approved email for the new activation link.
 *
 * The seeded body ends its call to action with "Set a password, or sign in with an Apple or Google account linked
 * to your username above." That is out of date in two ways:
 *
 *   - Social login is gone from the Authentik login (auth-infra removed the Google and Apple sources), so the
 *     sentence points at something that no longer exists.
 *   - {{password_reset_url}} is now a one-time activation link made for the user (24 hours, used up the first time
 *     it is opened) where the account is new. The user sets a password and adds a passkey or authenticator app
 *     there, so "Set a password" understates it, and the email should say that the link expires.
 *
 * Only the two phrases are replaced, not the whole body, so a body an administrator has edited since it was seeded
 * keeps its edits; a body that no longer contains them is left alone. Scoped by `template_key` and idempotent.
 * `down` restores the two phrases.
 *
 * (database/init.js seeds with ON CONFLICT DO NOTHING, so editing the seed only affects a new database.)
 */
const shorthands = undefined;
const OLD_LINK_TEXT = 'Set a password</a>, or sign in with an Apple or Google account linked to your username above.';
const NEW_LINK_TEXT = 'Set up your sign-in</a>. The link works once and for 24 hours; if it has expired, ask your team administrator for a new one.';
const up = (pgm) => {
  pgm.sql(`
    UPDATE email_templates
       SET body_template = replace(body_template, $old$${OLD_LINK_TEXT}$old$, $new$${NEW_LINK_TEXT}$new$)
     WHERE template_key = 'access_request_approved';
  `);
};
const down = (pgm) => {
  pgm.sql(`
    UPDATE email_templates
       SET body_template = replace(body_template, $new$${NEW_LINK_TEXT}$new$, $old$${OLD_LINK_TEXT}$old$)
     WHERE template_key = 'access_request_approved';
  `);
};
module.exports = { shorthands, up, down };
