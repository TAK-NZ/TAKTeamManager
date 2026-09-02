/**
 * Bugfix: centers the "Verify my email" button in the
 * `access_request_verification` email template's `body_template`. The
 * button was a bare inline-block `<a>` tag inside an auto-generated `<p>`
 * (see `EmailService.sendEmail`'s plain-text-to-HTML conversion), which
 * left it flush against the left edge of the email body rather than
 * centered like every other branded element in the email base template
 * (`server/templates/emailBase.js`'s logo row, footer row).
 *
 * Wraps the existing `<a>` tag, byte-for-byte unchanged, in a
 * `<table role="presentation" ...><tr><td align="center">...</td></tr></table>`
 * -- the same centering mechanism `1788300000000_align-team-transfer-email-
 * template.cjs` already introduced for this template family's info-box
 * styling, chosen over a CSS `text-align: center` because most email
 * clients strip/ignore `<style>`-based centering on a block element far
 * more reliably than they honor `align="center"` on a `<td>`.
 *
 * `database/init.js`'s seed INSERT uses `ON CONFLICT (template_key) DO
 * NOTHING`, so editing that file's literal alone has no effect on a
 * database that already ran it -- this migration is what actually
 * corrects an already-seeded row. The `UPDATE` is scoped with `AND
 * body_template = $orig$...$orig$` matching the EXACT baseline-seeded
 * text character-for-character, so it is a no-op (`ROW_COUNT` 0) on a
 * database where the row was never seeded, or was already edited by an
 * operator through `PUT /api/communications/templates/:key` -- never a
 * destructive blind rewrite of a customised value.
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

Please verify your email to complete your account request.

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center"><a href="{{verification_link}}" class="btn-primary" style="text-decoration: none; color: #FFF; background-color: #348eda; border: solid #348eda; border-width: 10px 20px; font-weight: bold; display: inline-block; border-radius: 4px;">Verify my email</a></td></tr></table>

<span style="font-size: 12px; color: #999;">If the button above doesn't work, copy and paste this link into your browser:</span>
{{verification_link}}

This link will expire in {{expiry_hours}} hours.

If you did not make this request, you can safely ignore this email.$tpl$
WHERE template_key = 'access_request_verification'
  AND body_template = $orig$Hi {{first_name}},

Please verify your email to complete your account request.

<a href="{{verification_link}}" class="btn-primary" style="text-decoration: none; color: #FFF; background-color: #348eda; border: solid #348eda; border-width: 10px 20px; font-weight: bold; display: inline-block; border-radius: 4px;">Verify my email</a>

<span style="font-size: 12px; color: #999;">If the button above doesn't work, copy and paste this link into your browser:</span>
{{verification_link}}

This link will expire in {{expiry_hours}} hours.

If you did not make this request, you can safely ignore this email.$orig$;
`);
};

/**
 * Reverses exactly what `up()` did: restores the former left-aligned
 * button markup, but only when the row still holds the value `up()`
 * would have produced, so a subsequent operator customisation is not
 * clobbered by a `down()` run either.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
UPDATE public.email_templates
SET body_template = $orig$Hi {{first_name}},

Please verify your email to complete your account request.

<a href="{{verification_link}}" class="btn-primary" style="text-decoration: none; color: #FFF; background-color: #348eda; border: solid #348eda; border-width: 10px 20px; font-weight: bold; display: inline-block; border-radius: 4px;">Verify my email</a>

<span style="font-size: 12px; color: #999;">If the button above doesn't work, copy and paste this link into your browser:</span>
{{verification_link}}

This link will expire in {{expiry_hours}} hours.

If you did not make this request, you can safely ignore this email.$orig$
WHERE template_key = 'access_request_verification'
  AND body_template = $tpl$Hi {{first_name}},

Please verify your email to complete your account request.

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center"><a href="{{verification_link}}" class="btn-primary" style="text-decoration: none; color: #FFF; background-color: #348eda; border: solid #348eda; border-width: 10px 20px; font-weight: bold; display: inline-block; border-radius: 4px;">Verify my email</a></td></tr></table>

<span style="font-size: 12px; color: #999;">If the button above doesn't work, copy and paste this link into your browser:</span>
{{verification_link}}

This link will expire in {{expiry_hours}} hours.

If you did not make this request, you can safely ignore this email.$tpl$;
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
