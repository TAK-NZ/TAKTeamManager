/**
 * Fix the access_request_denied email body.
 *
 * The seeded body used two placeholders that were WRONG:
 *
 *   - `{{admin_name}}` — the denying administrator's name. This LEAKED an
 *     internal user's identity to an external requester and must never appear
 *     in a requester-facing email. (It was also never supplied by
 *     `EmailService.sendDenialEmail`, so it rendered as the literal
 *     `{{admin_name}}` placeholder — a visible bug on top of the intended
 *     leak.)
 *   - `{{request_description}}` — likewise never supplied, so it too rendered
 *     as a literal placeholder.
 *
 * `sendDenialEmail` supplies exactly `first_name`, `team_path` and
 * `denial_reason` (matching the client's own `templateVariableHints` for this
 * key), so the body is rewritten to use only those.
 *
 * WHY A MIGRATION (and not just the database/init.js seed edit): the seed uses
 * `INSERT ... ON CONFLICT (template_key) DO NOTHING`, so editing it only
 * affects a brand-new database — every already-seeded environment keeps the
 * leaking body until an explicit `UPDATE`. This migration performs that
 * UPDATE, the same shape 1790300000001 used for callsign_mismatch_notice.
 *
 * Scoped by `template_key` and idempotent; `down` restores the prior body.
 */

const shorthands = undefined;

const NEW_BODY = `Hi {{first_name}},

Your request for access to {{team_path}} has been denied.

Reason: {{denial_reason}}

If you have questions, please contact your team administrator.`;

// The prior (leaking) body, restored by `down`.
const OLD_BODY = `Your request to {{request_description}} has been denied by {{admin_name}}.

Reason: {{denial_reason}}

If you have questions, please contact your team administrator.`;

const up = (pgm) => {
  pgm.sql(`
    UPDATE email_templates
       SET body_template = $tpl$${NEW_BODY}$tpl$
     WHERE template_key = 'access_request_denied';
  `);
};

const down = (pgm) => {
  pgm.sql(`
    UPDATE email_templates
       SET body_template = $tpl$${OLD_BODY}$tpl$
     WHERE template_key = 'access_request_denied';
  `);
};

module.exports = {
  shorthands,
  up,
  down
};
