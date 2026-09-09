/**
 * The Import_Transform for the Settings Export / Import feature.
 *
 * An Exported_Archive produced by `GET /api/settings/export` is a `.zip` holding
 * two JSON entries:
 *   - `settings.json`        -> `{ exportedAt, siteConfig }`
 *   - `email_templates.json` -> an array of template rows
 *
 * The import endpoint (`POST /api/settings/import`) instead accepts a single
 * merged JSON body of the Import_Payload shape
 * (`{ siteConfig, emailTemplates }`). This module bridges the two.
 *
 * CDK trim: `systemConfig` (the `tak_server_*` rows) is no longer part of the
 * export or the import shape -- TAK Server config is owned by the CDK
 * deployment via env, not by this feature. A legacy archive that still carries
 * a `settings.json` `systemConfig` array is tolerated: `mergeExportedJson`
 * simply drops it (it is not carried into the payload), and the server ignores
 * a stray `systemConfig` on import too.
 *
 * The merge and shape helpers are deliberately dependency-free and pure so they
 * are trivially unit- and property-testable; `unzipExportedArchive` is the ONLY
 * function that touches the client-side unzip dependency (`fflate`).
 */

import { unzipSync, strFromU8 } from 'fflate'

/**
 * Merge the two parsed export files into an Import_Payload. This is a pure
 * pass-through: the `siteConfig` and `emailTemplates` arrays are carried across
 * element for element, in order, with no reordering or transformation (exact
 * round-trip preservation). Missing fields default to an empty array so a
 * partial export still yields a well-shaped payload.
 *
 * CDK trim: a legacy `settings.json`'s `systemConfig` array is intentionally
 * NOT carried into the payload -- it is dropped here, so an old export imports
 * only its still-relevant `siteConfig`/`emailTemplates`.
 *
 * @param {{siteConfig?: Array}} settingsJson - parsed `settings.json`
 * @param {Array} emailTemplatesJson - parsed `email_templates.json`
 * @returns {{siteConfig: Array, emailTemplates: Array}}
 */
export function mergeExportedJson(settingsJson, emailTemplatesJson) {
  const source = settingsJson || {}
  return {
    siteConfig: Array.isArray(source.siteConfig) ? source.siteConfig : [],
    emailTemplates: Array.isArray(emailTemplatesJson) ? emailTemplatesJson : [],
  }
}

/**
 * Exact recognition of the Import_Payload shape. Returns true if and only if
 * `value` is a non-null non-array object whose `siteConfig` is an array and
 * whose `emailTemplates`, when present, is an array. Returns false for any
 * non-object, a missing `siteConfig`, or a non-array field.
 *
 * CDK trim: `systemConfig` is no longer required (or considered) by the shape.
 * A raw `.json` a user selects for import needs only a `siteConfig` array; a
 * stray `systemConfig` key does not make it invalid (it is ignored), matching
 * the server's tolerance of a legacy archive.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isImportPayloadShape(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  if (!Array.isArray(value.siteConfig)) {
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
 * @returns {Promise<{siteConfig: Array, emailTemplates: Array}>}
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
