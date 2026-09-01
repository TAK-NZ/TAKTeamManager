/**
 * Display label -> `system_config.config_key` for the TAK colour/role
 * mapping tables (Admin.jsx's "Colour Mappings"/"Role Descriptions" tabs).
 *
 * `GET /api/settings/tak-mappings` (`server/routes/settings.js`) returns
 * `{colorMappings, roleDescriptions}` keyed by human-readable LABEL
 * (`'Yellow'`, `'Team Member'`, ...) -- exactly the shape these two tables
 * already render from. But `PUT /api/settings/tak-mappings` accepts an
 * `updates` object keyed by the raw `config_key`
 * (`'tak_color_yellow'`, `'tak_role_team_member'`, ...), per that route's
 * own documented reasoning: the config_key is the single unambiguous,
 * allow-listable identifier, whereas the label has irregular cases
 * (`RTO`, `K9`, `HQ`) that don't reduce to the key by a simple
 * lower-case-and-replace-spaces rule.
 *
 * These two tables are therefore the CLIENT-SIDE mirror of that route's
 * `COLOR_KEY_LABELS`/`ROLE_KEY_LABELS`, reversed (label -> key instead of
 * key -> label), so a save handler can look up which config_key a given
 * table row's label corresponds to before calling
 * `settingsAPI.updateTakMappings`. Kept as a plain, framework-free data
 * module (no React/API import) so it is directly unit-testable and so a
 * key transcription error fails a test rather than silently mismatching
 * the server's own allow-list.
 */
export const COLOR_LABEL_TO_CONFIG_KEY = Object.freeze({
  Yellow: 'tak_color_yellow',
  Cyan: 'tak_color_cyan',
  Green: 'tak_color_green',
  Red: 'tak_color_red',
  Purple: 'tak_color_purple',
  Orange: 'tak_color_orange',
  Blue: 'tak_color_blue',
  Magenta: 'tak_color_magenta',
  White: 'tak_color_white',
  Maroon: 'tak_color_maroon',
  'Dark Blue': 'tak_color_dark_blue',
  Teal: 'tak_color_teal',
  'Dark Green': 'tak_color_dark_green',
  Brown: 'tak_color_brown'
})

export const ROLE_LABEL_TO_CONFIG_KEY = Object.freeze({
  'Team Member': 'tak_role_team_member',
  'Team Lead': 'tak_role_team_lead',
  Sniper: 'tak_role_sniper',
  Medic: 'tak_role_medic',
  'Forward Observer': 'tak_role_forward_observer',
  RTO: 'tak_role_rto',
  K9: 'tak_role_k9',
  HQ: 'tak_role_hq'
})

/**
 * Resolves a Colour Mappings table row's label to its `config_key`.
 * Returns `null` for a label outside the canonical 14 -- never throws,
 * so an unexpected label (e.g. a future server-side addition this map
 * hasn't caught up with yet) fails the save explicitly rather than
 * sending a malformed request.
 *
 * @param {string} label
 * @returns {string|null}
 */
export function colorLabelToConfigKey(label) {
  return COLOR_LABEL_TO_CONFIG_KEY[label] ?? null
}

/**
 * Resolves a Role Descriptions table row's label to its `config_key`.
 * Same total/never-throws contract as `colorLabelToConfigKey`.
 *
 * @param {string} label
 * @returns {string|null}
 */
export function roleLabelToConfigKey(label) {
  return ROLE_LABEL_TO_CONFIG_KEY[label] ?? null
}
