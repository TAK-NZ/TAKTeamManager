/**
 * Add `users.activation_expires_at`.
 *
 * When Team Manager sends a new or re-invited account its one-time activation link, it also opens an activation window
 * on the Authentik user (attribute `tak_activation_expires`, 7 days): an account with no authenticator is refused by
 * Authentik's recovery flow once the window has passed. This column mirrors the end of that window so that Team Manager
 * can show an account as "invited" or "not activated" and suspend an account that was never activated, without asking
 * Authentik about every user.
 *
 * NULL means no window was ever recorded: an account created before this column existed, or one that never had a link
 * made by Team Manager. Such accounts are not treated as unactivated.
 *
 * Incremental migration on top of the squashed baseline; NEVER hand-edit schema.sql.
 */
exports.shorthands = undefined;
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE public.users
      ADD COLUMN activation_expires_at timestamp with time zone;
    COMMENT ON COLUMN public.users.activation_expires_at IS 'End of the activation window opened on the Authentik user when Team Manager last made an activation link for it (mirror of the Authentik attribute tak_activation_expires, 7 days). NULL: no window was recorded, so the account is never treated as unactivated. An account with a window in the past and no Authentik sign-in (user_cache.last_login IS NULL) is not activated and is suspended by ActivationExpiryJob.';
  `);
};
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE public.users
      DROP COLUMN IF EXISTS activation_expires_at;
  `);
};
