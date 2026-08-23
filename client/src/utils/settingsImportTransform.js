/**
 * The Import_Transform for the Settings Export / Import feature (Requirement 8).
 *
 * An Exported_Archive produced by `GET /api/settings/export` is a `.zip` holding
 * two JSON entries:
 *   - `settings.json`        -> `{ exportedAt, systemConfig, siteConfig }`
 *   - `email_templates.json` -> an array of template rows
 *
 * The import endpoint (`POST /api/settings/import`) instead accepts a single
 * merged JSON body of the Import_Payload shape
 * (`{ systemConfig, siteConfig, emailTemplates }`). This module bridges the two.
 *
 * The merge and shape helpers are deliberately dependency-free and pure so they
 * are trivially unit- and property-testable; `unzipExportedArchive` is the ONLY
 * function that touches the client-side unzip dependency (`fflate`).
 */

import { unzipSync, strFromU8 } from 'fflate'

/**
 * Merge the two parsed export files into an Import_Payload (Requirements 8.2,
 * 8.4). This is a pure pass-through: the `systemConfig`, `siteConfig`, and
 * `emailTemplates` arrays are carried across element for element, in order, with
 * no reordering or transformation (Property 1 requires exact round-trip
 * preservation). Missing fields default to an empty array so a partial export
 * still yields a well-shaped payload.
 *
 * @param {{systemConfig?: Array, siteConfig?: Array}} settingsJson - parsed `settings.json`
 * @param {Array} emailTemplatesJson - parsed `email_templates.json`
 * @returns {{systemConfig: Array, siteConfig: Array, emailTemplates: Array}}
 */
export function mergeExportedJson(settingsJson, emailTemplatesJson) {
  const source = settingsJson || {}
  return {
    systemConfig: Array.isArray(source.systemConfig) ? source.systemConfig : [],
    siteConfig: Array.isArray(source.siteConfig) ? source.siteConfig : [],
    emailTemplates: Array.isArray(emailTemplatesJson) ? emailTemplatesJson : [],
  }
}

/**
 * Exact recognition of the Import_Payload shape (Requirements 8.3, 8.6,
 * Property 2). Returns true if and only if `value` is a non-null object whose
 * `systemConfig` and `siteConfig` are arrays and whose `emailTemplates`, when
 * present, is an array. Returns false for any non-object, a missing array
 * field, or a non-array field.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isImportPayloadShape(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  if (!Array.isArray(value.systemConfig) || !Array.isArray(value.siteConfig)) {
    return false
  }
  if (value.emailTemplates !== undefined && !Array.isArray(value.emailTemplates)) {
    return false
  }
  return true
}

/**
 * Unzip an Exported_Archive in the browser and produce an Import_Payload
 * (Requirement 8.2). Reads the `settings.json` and `email_templates.json`
 * entries from the archive, decodes each to a UTF-8 string, parses them, and
 * merges via `mergeExportedJson`.
 *
 * Throws a clear Error when a required entry is missing or when either entry
 * fails to parse, so the caller can surface the "unreadable/misshapen file"
 * error (Requirement 8.6) without issuing an import request.
 *
 * @param {ArrayBuffer} arrayBuffer - the raw bytes of the selected `.zip`
 * @returns {Promise<{systemConfig: Array, siteConfig: Array, emailTemplates: Array}>}
 */
export async function unzipExportedArchive(arrayBuffer) {
  let entries
  try {
    entries = unzipSync(new Uint8Array(arrayBuffer))
  } catch (error) {
    throw new Error(`Could not read the archive: ${error.message}`)
  }

  const settingsEntry = entries['settings.json']
  const templatesEntry = entries['email_templates.json']

  if (!settingsEntry) {
    throw new Error('Archive is missing settings.json')
  }
  if (!templatesEntry) {
    throw new Error('Archive is missing email_templates.json')
  }

  let settingsJson
  try {
    settingsJson = JSON.parse(strFromU8(settingsEntry))
  } catch (error) {
    throw new Error(`settings.json is not valid JSON: ${error.message}`)
  }

  let emailTemplatesJson
  try {
    emailTemplatesJson = JSON.parse(strFromU8(templatesEntry))
  } catch (error) {
    throw new Error(`email_templates.json is not valid JSON: ${error.message}`)
  }

  return mergeExportedJson(settingsJson, emailTemplatesJson)
}
