/**
 * Update the callsign_mismatch_notice email body to use the shared blue
 * highlight block for the assigned/connected callsigns.
 *
 * WHY A SEPARATE MIGRATION (and not an edit to 1790300000000's seed):
 * `1790300000000` seeds the template with `INSERT ... ON CONFLICT
 * (template_key) DO NOTHING`. Once the row exists (as it does on the test
 * database), re-running that migration is a no-op — editing its INSERT body
 * only affects a brand-new database, never an existing one. Changing an
 * ALREADY-SEEDED template body therefore requires an explicit `UPDATE`, the
 * same shape the former `align-team-transfer-email-template` migration used
 * (folded into the baseline). This migration performs that UPDATE so every
 * environment converges on the blue-block body.
 *
 * The body is presented inside the same `#f0f7ff` / `border-left: 4px solid
 * #348eda` table block the welcome (`access_request_approved`) and
 * team-transfer emails use, with the two callsigns as `<code>`.
 *
 * Scoped by `template_key` and idempotent: it only rewrites this one row, and
 * re-running it simply re-applies the same body. `down` restores the prior
 * plain-text body.
 */

const shorthands = undefined;

const NEW_BODY = `Hi {{first_name}},

One of your devices is currently connected to the TAK server with a callsign that does not match the callsign assigned to you.

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 16px 0;"><tr><td style="background-color: #f0f7ff; border-radius: 8px; border-left: 4px solid #348eda; padding: 16px 20px;"><b>Assigned callsign:</b> <code>{{assigned_callsign}}</code><br><b>Connected callsign:</b> <code>{{observed_callsign}}</code></td></tr></table>

You may add to the end of your assigned callsign (for example "{{assigned_callsign}} (Tablet)"), but the assigned part must stay unchanged. Please correct the callsign in your TAK client.

You can review your devices at any time here: {{login_url}}`;

const OLD_BODY = `Hi {{first_name}},

One of your devices is currently connected to the TAK server with a callsign that does not match the callsign assigned to you.

Assigned callsign: {{assigned_callsign}}
Connected callsign: {{observed_callsign}}

You may add to the end of your assigned callsign (for example "{{assigned_callsign}} (Tablet)"), but the assigned part must stay unchanged. Please correct the callsign in your TAK client.

You can review your devices at any time here: {{login_url}}`;

const up = (pgm) => {
  pgm.sql(`
    UPDATE email_templates
       SET body_template = $tpl$${NEW_BODY}$tpl$
     WHERE template_key = 'callsign_mismatch_notice';
  `);
};

const down = (pgm) => {
  pgm.sql(`
    UPDATE email_templates
       SET body_template = $tpl$${OLD_BODY}$tpl$
     WHERE template_key = 'callsign_mismatch_notice';
  `);
};

module.exports = {
  shorthands,
  up,
  down
};
