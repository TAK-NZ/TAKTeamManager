/**
 * Seeds the `team_transfer_completed` email template sent to a user whose
 * Direct_Membership was moved by a Team_Transfer (Requirements 13.2, 13.3).
 *
 * Substitution variables are exactly `first_name`, `team_path`, and
 * `callsign`, matching EmailService.sendEmail's `{{variable}}` substitution.
 *
 * `ON CONFLICT (template_key) DO NOTHING` leaves an existing row with this
 * `template_key` unchanged, which also makes the migration idempotent.
 *
 * The body is dollar-quoted (`$tpl$...$tpl$`) unconditionally. That is the
 * convention which survived the earlier template corruption caused by
 * `""`-escaping, so a later edit adding an `<a href="...">` cannot
 * reintroduce that failure.
 */
const shorthands = undefined;

const up = (pgm) => {
  pgm.sql(`
    INSERT INTO email_templates (template_key, subject_template, body_template, description)
    VALUES (
      'team_transfer_completed',
      'Your team assignment has changed',
      $tpl$Hi {{first_name}},

Your team assignment has been changed to:

  {{team_path}}

Your TAK callsign is now: {{callsign}}

Your previous team's channels are no longer available to you. If this
change is unexpected, contact your team administrator.$tpl$,
      'Sent to a user whose Direct_Membership was moved by a Team_Transfer'
    )
    ON CONFLICT (template_key) DO NOTHING;
  `);
};

const down = (pgm) => {
  pgm.sql(`
    DELETE FROM email_templates WHERE template_key = 'team_transfer_completed';
  `);
};

module.exports = { shorthands, up, down };
