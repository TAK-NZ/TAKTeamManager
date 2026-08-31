/**
 * Bugfix: removes the "If you did not expect this email, you can safely
 * ignore it." footer line from the `access_request_approved` email
 * template's `body_template`.
 *
 * `database/init.js`'s seed INSERT for this row uses
 * `ON CONFLICT (template_key) DO NOTHING`, so editing that file's literal
 * alone has no effect on a database that already ran it -- this migration
 * is what actually corrects an already-seeded row. The replaced string is
 * copied character-for-character from the pre-fix `body_template` (the
 * `$tpl$`-quoted HTML `<span>` line, including its two-newline lead-in),
 * so the `UPDATE` is a no-op (`ROW_COUNT` 0) on any database where the row
 * was never seeded, or was already edited to remove the footer by hand --
 * never a destructive blind rewrite of the whole column.
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
SET body_template = replace(
  body_template,
  E'\n\n<span style="font-size: 12px; color: #999;">If you did not expect this email, you can safely ignore it.</span>',
  ''
)
WHERE template_key = 'access_request_approved';
`);
};

/**
 * Restores the footer line for `access_request_approved`, appending it back
 * exactly where `up()` removed it from -- immediately after the existing
 * body, with the same two-newline lead-in.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
UPDATE public.email_templates
SET body_template = body_template
  || E'\n\n<span style="font-size: 12px; color: #999;">If you did not expect this email, you can safely ignore it.</span>'
WHERE template_key = 'access_request_approved';
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
