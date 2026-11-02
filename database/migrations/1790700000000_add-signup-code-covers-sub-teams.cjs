/**
 * Add `teams.signup_code_covers_sub_teams`.
 *
 * An Organisation that has a sign-up code can opt in to letting that one code
 * unlock sign-up to every joinable Sub_Team beneath it. When the flag is true,
 * the Organisation's Sub_Teams are only offered to someone presenting the
 * Organisation's code (or a Sub_Team's own code); without it they stay open to
 * everyone, as before.
 *
 * Organisation-only, exactly like `callsign_team_hyphenated`: NULL on a
 * Sub_Team, always. The column is nullable with no default; `Team.create`
 * supplies `false` for an Organisation, and existing Organisations are
 * backfilled to `false` here so behaviour does not change on deploy. Any query
 * that reads it must treat NULL as false.
 *
 * Incremental migration on top of the squashed baseline
 * (`1790200000000_baseline-schema.cjs`); NEVER hand-edit schema.sql.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE public.teams
      ADD COLUMN signup_code_covers_sub_teams boolean;
    UPDATE public.teams
       SET signup_code_covers_sub_teams = false
     WHERE parent_team_id IS NULL;
    COMMENT ON COLUMN public.teams.signup_code_covers_sub_teams IS 'Whether this Organisation''s sign-up code also unlocks sign-up to its joinable Sub_Teams. When true, those Sub_Teams are hidden from anyone who does not present the Organisation''s code (or the Sub_Team''s own code), and stay hidden while the Organisation has no code. NULL on a Sub_Team, always. Organisation-only, freely editable, enforced in Team.create/Team.update.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE public.teams
      DROP COLUMN IF EXISTS signup_code_covers_sub_teams;
  `);
};
