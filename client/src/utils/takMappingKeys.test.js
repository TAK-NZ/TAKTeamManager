import { describe, it, expect } from 'vitest'
import {
  COLOR_LABEL_TO_CONFIG_KEY,
  ROLE_LABEL_TO_CONFIG_KEY,
  colorLabelToConfigKey,
  roleLabelToConfigKey
} from './takMappingKeys.js'

// Bugfix (BUG-014): Admin.jsx's Colour Mappings / Role Descriptions save
// handlers previously never called any API at all. The fix routes saves
// through PUT /api/settings/tak-mappings, which is keyed by config_key
// (e.g. 'tak_color_yellow'), not by the display label the table renders
// ('Yellow'). These tests pin the label->key table against the server's
// own COLOR_KEY_LABELS/ROLE_KEY_LABELS (server/routes/settings.js),
// transcribed here as the independent oracle -- not by importing the
// server module (client code must not import server code), but by
// checking every key/value pair by hand against that file's literal
// content.
describe('takMappingKeys', () => {
  // Transcribed directly from COLOR_KEY_LABELS in server/routes/settings.js.
  const expectedColorKeyToLabel = {
    tak_color_yellow: 'Yellow',
    tak_color_cyan: 'Cyan',
    tak_color_green: 'Green',
    tak_color_red: 'Red',
    tak_color_purple: 'Purple',
    tak_color_orange: 'Orange',
    tak_color_blue: 'Blue',
    tak_color_magenta: 'Magenta',
    tak_color_white: 'White',
    tak_color_maroon: 'Maroon',
    tak_color_dark_blue: 'Dark Blue',
    tak_color_teal: 'Teal',
    tak_color_dark_green: 'Dark Green',
    tak_color_brown: 'Brown'
  }

  // Transcribed directly from ROLE_KEY_LABELS in server/routes/settings.js.
  const expectedRoleKeyToLabel = {
    tak_role_team_member: 'Team Member',
    tak_role_team_lead: 'Team Lead',
    tak_role_sniper: 'Sniper',
    tak_role_medic: 'Medic',
    tak_role_forward_observer: 'Forward Observer',
    tak_role_rto: 'RTO',
    tak_role_k9: 'K9',
    tak_role_hq: 'HQ'
  }

  it('COLOR_LABEL_TO_CONFIG_KEY is exactly the reverse of the server\'s COLOR_KEY_LABELS, 14 entries', () => {
    const expectedLabelToKey = Object.fromEntries(
      Object.entries(expectedColorKeyToLabel).map(([key, label]) => [label, key])
    )
    expect(COLOR_LABEL_TO_CONFIG_KEY).toEqual(expectedLabelToKey)
    expect(Object.keys(COLOR_LABEL_TO_CONFIG_KEY)).toHaveLength(14)
  })

  it('ROLE_LABEL_TO_CONFIG_KEY is exactly the reverse of the server\'s ROLE_KEY_LABELS, 8 entries', () => {
    const expectedLabelToKey = Object.fromEntries(
      Object.entries(expectedRoleKeyToLabel).map(([key, label]) => [label, key])
    )
    expect(ROLE_LABEL_TO_CONFIG_KEY).toEqual(expectedLabelToKey)
    expect(Object.keys(ROLE_LABEL_TO_CONFIG_KEY)).toHaveLength(8)
  })

  it('colorLabelToConfigKey resolves every canonical label and returns null for an unrecognised one', () => {
    for (const [label, key] of Object.entries(COLOR_LABEL_TO_CONFIG_KEY)) {
      expect(colorLabelToConfigKey(label)).toBe(key)
    }
    expect(colorLabelToConfigKey('Not A Real Colour')).toBeNull()
    expect(colorLabelToConfigKey('')).toBeNull()
    expect(colorLabelToConfigKey(null)).toBeNull()
    expect(colorLabelToConfigKey(undefined)).toBeNull()
  })

  it('roleLabelToConfigKey resolves every canonical label and returns null for an unrecognised one', () => {
    for (const [label, key] of Object.entries(ROLE_LABEL_TO_CONFIG_KEY)) {
      expect(roleLabelToConfigKey(label)).toBe(key)
    }
    expect(roleLabelToConfigKey('Not A Real Role')).toBeNull()
    expect(roleLabelToConfigKey('')).toBeNull()
    expect(roleLabelToConfigKey(null)).toBeNull()
    expect(roleLabelToConfigKey(undefined)).toBeNull()
  })
})
