'use strict';

/**
 * Foreign_Partner Organisation country prefix feature: adds a nullable
 * `teams.country_code` column holding the ISO 3166-1 ALPHA-3 code of a
 * foreign partner nation (e.g. `AUS`, `FJI`) for an Organisation.
 *
 * Semantics (mirroring the existing Organisation-only tri-state columns
 * `pseudonymous_usernames`/`response_channel_access`/`support_channel_access`,
 * which are likewise nullable with NO default and documented via a
 * `COMMENT ON COLUMN`):
 *
 *   - NULL           -> domestic (New Zealand) Organisation, OR a Sub_Team
 *                       (the column is only ever set on an Organisation row,
 *                       `parent_team_id IS NULL`; a Sub_Team always stores
 *                       NULL, enforced in `Team.create`/`Team.update`).
 *   - a 3-char code  -> a Foreign_Partner Organisation. The code is composed
 *                       as the LEADING segment of that Organisation's
 *                       effective callsign prefix -- `FJI` + prefix `FIRE`
 *                       yields the callsign Organisation segment `FJI-FIRE`
 *                       (see `userAttributes.computeCallsignAttributes`).
 *
 * WRITE-ONCE: once an Organisation is created with a `country_code`, it can
 * never be changed (a typed rejection in `Team.update`, exactly like
 * `callsign_prefix`'s `OrganisationCallsignPrefixImmutableError`), because
 * every Managed_Identifier and callsign already minted under it embeds the
 * composed prefix. Enforced at the application layer, not by a DB
 * constraint -- there is nothing here a CHECK/immutability trigger could
 * express that the model does not already guard.
 *
 * `character varying(3)`: an ISO 3166-1 alpha-3 code is exactly three
 * letters. The application validates membership against the vendored ISO
 * dataset (`server/utils/isoCountry.js`) before ever inserting, so the
 * column width is a backstop, not the validator. No default and no NOT
 * NULL: the overwhelming-majority domestic case is NULL.
 *
 * `down()` drops the column. Any Foreign_Partner Organisation's country
 * provenance is lost on rollback (the composed callsigns already minted
 * remain as stored strings, but the structured code behind them is gone) --
 * an honest, intentional rollback of a purely additive column.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE teams ADD COLUMN country_code character varying(3);
    COMMENT ON COLUMN teams.country_code IS 'ISO 3166-1 alpha-3 code of a Foreign_Partner Organisation (e.g. AUS, FJI), composed as the leading segment of the Organisation''s effective callsign prefix. NULL for a domestic (NZ) Organisation and always NULL on a Sub_Team. Organisation-only and write-once, enforced in Team.create/Team.update.';
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE teams DROP COLUMN country_code;
  `);
};

module.exports = { shorthands, up, down };
