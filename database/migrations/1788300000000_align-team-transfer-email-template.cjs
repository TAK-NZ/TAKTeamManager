/**
 * Aligns the `team_transfer_completed` email template with
 * `access_request_approved`'s styling: the same blue info box (`<table>`
 * with `background-color: #f0f7ff`, `border-left: 4px solid #348eda`)
 * holding the Team/Username/TAK-Callsign facts, instead of the former
 * plain-text "Your team assignment has been changed to: ..." body.
 *
 * `EmailService.sendEmail` (`server/services/EmailService.js`) already
 * converts the plain-text body into HTML paragraphs before wrapping it in
 * the branded template (`server/templates/emailBase.js`), so embedded
 * inline-styled HTML -- exactly as `access_request_approved`'s body
 * already does -- renders correctly; no client-side change is needed.
 *
 * `username` is a NEW substitution variable this template did not
 * previously accept (Requirement 13.3 named only `first_name`,
 * `team_path`, `callsign`). `TeamTransferService.applyPostCommitEffects`
 * is updated in the same change to read `users.username` and pass it
 * through, mirroring `RequestApprovalService.sendApprovalEmail`'s own
 * `username || email` fallback shape.
 *
 * `body_template`/`description` are only UPDATEd when the row's
 * `body_template` still matches the EXACT plain-text content the
 * baseline migration seeded (copied character-for-character below), so
 * this is a no-op (`ROW_COUNT` 0) rather than a destructive blind
 * rewrite on a database where an operator has already customised this
 * template's body through the Template_Editor
 * (`PUT /api/communications/templates/:key`).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.sql(`
UPDATE public.email_templates
SET body_template = $tpl$Hi {{first_name}},

Your team assignment has changed.

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 16px 0;"><tr><td style="background-color: #f0f7ff; border-radius: 8px; border-left: 4px solid #348eda; padding: 16px 20px;"><b>Team:</b> {{team_path}}<br><b>Username:</b> <a href="#" style="color: #212124; text-decoration: none; cursor: default; pointer-events: none;">{{username}}</a><br><b>TAK Callsign:</b> <code>{{callsign}}</code></td></tr></table>

Your previous team's channels are no longer available to you. If this
change is unexpected, contact your team administrator.$tpl$
WHERE template_key = 'team_transfer_completed'
  AND body_template = $orig$Hi {{first_name}},

Your team assignment has been changed to:

  {{team_path}}

Your TAK callsign is now: {{callsign}}

Your previous team's channels are no longer available to you. If this
change is unexpected, contact your team administrator.$orig$;
`);
};

/**
 * Reverses exactly what `up()` did: restores the former plain-text body,
 * but only when the row still holds the styled body `up()` would have
 * produced -- so a subsequent operator customisation is not clobbered by
 * a `down()` run either.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
UPDATE public.email_templates
SET body_template = $orig$Hi {{first_name}},

Your team assignment has been changed to:

  {{team_path}}

Your TAK callsign is now: {{callsign}}

Your previous team's channels are no longer available to you. If this
change is unexpected, contact your team administrator.$orig$
WHERE template_key = 'team_transfer_completed'
  AND body_template = $tpl$Hi {{first_name}},

Your team assignment has changed.

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 16px 0;"><tr><td style="background-color: #f0f7ff; border-radius: 8px; border-left: 4px solid #348eda; padding: 16px 20px;"><b>Team:</b> {{team_path}}<br><b>Username:</b> <a href="#" style="color: #212124; text-decoration: none; cursor: default; pointer-events: none;">{{username}}</a><br><b>TAK Callsign:</b> <code>{{callsign}}</code></td></tr></table>

Your previous team's channels are no longer available to you. If this
change is unexpected, contact your team administrator.$tpl$;
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
