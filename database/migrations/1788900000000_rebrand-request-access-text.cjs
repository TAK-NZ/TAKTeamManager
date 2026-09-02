/**
 * Bugfix: rebrands the `request_access_title`/`request_access_subtitle`
 * site_config rows from generic "Team" wording to "TAK.NZ" wording, and
 * turns the "TAK.GOV" mention in `request_access_footer` into a real
 * hyperlink to https://tak.gov/.
 *
 * `database/migrations/1786596755665_baseline-schema.cjs`'s seed INSERT
 * uses `ON CONFLICT (config_key) DO NOTHING`, so editing that file's
 * literal alone has no effect on a database that already ran it -- this
 * migration is what actually corrects an already-seeded row. Each `UPDATE`
 * below is scoped with `AND config_value = $orig$...$orig$` matching the
 * EXACT baseline-seeded text character-for-character, so it is a no-op
 * (`ROW_COUNT` 0) on a database where the row was never seeded, or was
 * already edited by an operator through `PUT /api/settings/:key` --
 * never a destructive blind rewrite of a customised value.
 *
 * The new footer's `<a href="https://tak.gov/">TAK.GOV</a>` is within the
 * safe HTML subset `server/config/htmlSafeSubset.js` already allows (`a`
 * with `href`, `https` scheme), so no sanitizer change is needed.
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
UPDATE public.site_config
SET config_value = 'Request TAK.NZ Access'
WHERE config_key = 'request_access_title'
  AND config_value = 'Request Team Access';
`);

  pgm.sql(`
UPDATE public.site_config
SET config_value = 'Fill out this form to request access to a TAK.NZ team'
WHERE config_key = 'request_access_subtitle'
  AND config_value = 'Fill out this form to request access to a TAK team';
`);

  pgm.sql(`
UPDATE public.site_config
SET config_value = $tpl$Note: TAK.NZ is for New Zealand Based First Responders or those sponsored by New Zealand Public Safety Agencies. If you are not a New Zealand First Responder refer to <a href="https://tak.gov/">TAK.GOV</a> for more information on TAK.$tpl$
WHERE config_key = 'request_access_footer'
  AND config_value = $orig$Note: TAK.NZ is for New Zealand Based First Responders or those sponsored by New Zealand Public Safety Agencies. If you are not a New Zealand First Responder refer to TAK.GOV for more information on TAK.$orig$;
`);
};

/**
 * Reverses exactly what `up()` did, restoring each former value -- but
 * only when the row still holds the value `up()` would have produced, so
 * a subsequent operator customisation is not clobbered by a `down()` run
 * either.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
UPDATE public.site_config
SET config_value = 'Request Team Access'
WHERE config_key = 'request_access_title'
  AND config_value = 'Request TAK.NZ Access';
`);

  pgm.sql(`
UPDATE public.site_config
SET config_value = 'Fill out this form to request access to a TAK team'
WHERE config_key = 'request_access_subtitle'
  AND config_value = 'Fill out this form to request access to a TAK.NZ team';
`);

  pgm.sql(`
UPDATE public.site_config
SET config_value = $orig$Note: TAK.NZ is for New Zealand Based First Responders or those sponsored by New Zealand Public Safety Agencies. If you are not a New Zealand First Responder refer to TAK.GOV for more information on TAK.$orig$
WHERE config_key = 'request_access_footer'
  AND config_value = $tpl$Note: TAK.NZ is for New Zealand Based First Responders or those sponsored by New Zealand Public Safety Agencies. If you are not a New Zealand First Responder refer to <a href="https://tak.gov/">TAK.GOV</a> for more information on TAK.$tpl$;
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
