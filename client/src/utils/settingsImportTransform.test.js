import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { zipSync, strToU8 } from 'fflate'
import {
  mergeExportedJson,
  isImportPayloadShape,
  unzipExportedArchive
} from './settingsImportTransform.js'

// Feature: admin-settings-management, tasks 5.3 (property tests) and 5.4 (unit tests).
//
// The Import_Transform bridges an Exported_Archive (a `.zip` holding `settings.json`
// and `email_templates.json`) and the merged Import_Payload the import endpoint accepts
// (`{ systemConfig, siteConfig, emailTemplates }`). These tests exercise the three exported
// functions:
//   - mergeExportedJson   -> the pure pass-through merge (Property 1, round-trip preservation)
//   - isImportPayloadShape -> the exact shape guard (Property 2)
//   - unzipExportedArchive -> the only function touching fflate (task 5.4 unit tests)
//
// The property tests re-derive every expectation independently of the code under test: the
// round-trip is checked element-for-element against the generated inputs, and the shape
// predicate is re-derived from first principles rather than by calling isImportPayloadShape.

// A generator for a config-row-ish object: the merge is a pure pass-through, so the row
// contents are arbitrary. A mix of primitive fields and nested structures makes it clear
// nothing about the rows is inspected or transformed.
const configRowArb = fc.oneof(
  fc.record({
    key: fc.string(),
    value: fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
    updatedAt: fc.string()
  }),
  fc.dictionary(fc.string(), fc.jsonValue()),
  // Occasionally a non-object row, since the merge never looks inside rows.
  fc.jsonValue()
)

const configArrayArb = fc.array(configRowArb, { maxLength: 8 })

// An email-template-row-ish object; again arbitrary because the merge carries it verbatim.
const emailTemplateArb = fc.record({
  templateKey: fc.string(),
  subjectTemplate: fc.string(),
  bodyTemplate: fc.string()
})
const emailTemplatesArrayArb = fc.array(emailTemplateArb, { maxLength: 8 })

describe('settingsImportTransform', () => {
  // ---------------------------------------------------------------------------
  // TASK 5.3 - Property 1: Export-to-import round-trip preserves rows
  // Validates: Requirements 8.2, 8.4
  // ---------------------------------------------------------------------------
  describe('Feature: admin-settings-management, Property 1: Export-to-import round-trip preserves rows (Validates: Requirements 8.2, 8.4)', () => {
    // Feature: admin-settings-management, Property 1: Export-to-import round-trip preserves rows
    it('merging a settings.json ({exportedAt, siteConfig, ...}) with an emailTemplates array yields siteConfig + emailTemplates element-for-element, dropping any legacy systemConfig', () => {
      fc.assert(
        fc.property(
          fc.string(), // exportedAt: an arbitrary sibling field that must be ignored
          configArrayArb, // a legacy systemConfig that must be DROPPED (CDK trim)
          configArrayArb,
          emailTemplatesArrayArb,
          (exportedAt, legacySystemConfig, siteConfig, emailTemplates) => {
            const settingsJson = { exportedAt, systemConfig: legacySystemConfig, siteConfig }
            const merged = mergeExportedJson(settingsJson, emailTemplates)

            // CDK trim: the result carries exactly the two named arrays --
            // systemConfig is dropped, never carried into the payload.
            expect(Object.keys(merged).sort()).toEqual(['emailTemplates', 'siteConfig'])
            expect(merged.systemConfig).toBeUndefined()

            // Same length, and element-for-element identical references/values in order.
            expect(merged.siteConfig).toHaveLength(siteConfig.length)
            expect(merged.emailTemplates).toHaveLength(emailTemplates.length)

            for (let i = 0; i < siteConfig.length; i++) {
              expect(merged.siteConfig[i]).toBe(siteConfig[i])
            }
            for (let i = 0; i < emailTemplates.length; i++) {
              expect(merged.emailTemplates[i]).toBe(emailTemplates[i])
            }

            // The whole arrays are deep-equal to the inputs (no reordering/transformation).
            expect(merged.siteConfig).toEqual(siteConfig)
            expect(merged.emailTemplates).toEqual(emailTemplates)
          }
        ),
        { numRuns: 100 }
      )
    })
  })

  // ---------------------------------------------------------------------------
  // TASK 5.3 - Property 2: Import-payload shape recognition is exact
  // Validates: Requirements 8.3, 8.6
  // ---------------------------------------------------------------------------
  describe('Feature: admin-settings-management, Property 2: Import-payload shape recognition is exact (Validates: Requirements 8.3, 8.6)', () => {
    // A generator spanning the classes the property names:
    //   - valid payloads (systemConfig + siteConfig arrays; emailTemplates absent/array),
    //   - objects with a missing or non-array field,
    //   - objects with a non-array emailTemplates,
    //   - non-objects (number, string, null, array).
    const anArray = fc.array(fc.jsonValue(), { maxLength: 5 })
    const notAnArray = fc.oneof(
      fc.integer(),
      fc.string(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.dictionary(fc.string(), fc.jsonValue())
    )

    const candidateArb = fc.oneof(
      // Valid: both config arrays, emailTemplates absent.
      fc.record({ systemConfig: anArray, siteConfig: anArray }),
      // Valid: both config arrays + an emailTemplates array.
      fc.record({ systemConfig: anArray, siteConfig: anArray, emailTemplates: anArray }),
      // Object with a non-array systemConfig and/or siteConfig.
      fc.record({ systemConfig: notAnArray, siteConfig: anArray }),
      fc.record({ systemConfig: anArray, siteConfig: notAnArray }),
      fc.record({ systemConfig: notAnArray, siteConfig: notAnArray }),
      // Object missing one or both config fields.
      fc.record({ siteConfig: anArray }),
      fc.record({ systemConfig: anArray }),
      fc.record({ other: fc.jsonValue() }),
      // Valid config arrays but a non-array emailTemplates (must be rejected).
      fc.record({
        systemConfig: anArray,
        siteConfig: anArray,
        emailTemplates: fc.oneof(fc.integer(), fc.string(), fc.boolean(), fc.constant(null), fc.dictionary(fc.string(), fc.jsonValue()))
      }),
      // Non-objects: number, string, null, array, boolean, undefined.
      fc.integer(),
      fc.double(),
      fc.string(),
      fc.constant(null),
      fc.constant(undefined),
      fc.boolean(),
      fc.array(fc.jsonValue(), { maxLength: 5 })
    )

    // Feature: admin-settings-management, Property 2: Import-payload shape recognition is exact
    it('isImportPayloadShape(value) is true IFF value is a non-null non-array object with an array siteConfig and (undefined or array) emailTemplates (CDK trim: systemConfig is no longer part of the shape)', () => {
      fc.assert(
        fc.property(candidateArb, (value) => {
          // Re-derive the expected boolean independently of the function under
          // test. CDK trim: systemConfig is IRRELEVANT to the shape now -- only
          // siteConfig (array) and emailTemplates (undefined-or-array) decide it.
          const isPlainObject =
            typeof value === 'object' && value !== null && !Array.isArray(value)
          const expected =
            isPlainObject &&
            Array.isArray(value.siteConfig) &&
            (value.emailTemplates === undefined || Array.isArray(value.emailTemplates))

          expect(isImportPayloadShape(value)).toBe(expected)
        }),
        { numRuns: 100 }
      )
    })
  })

  // ---------------------------------------------------------------------------
  // TASK 5.4 - unit / example tests for unzip and the raw-json pass-through path
  // Requirements 8.2, 8.3, 8.6
  // ---------------------------------------------------------------------------
  describe('unzipExportedArchive (task 5.4, Requirements 8.2, 8.6)', () => {
    // Build a representative Exported_Archive in the test by zipping the two JSON entries
    // with fflate, exactly as the export endpoint does, and return its ArrayBuffer.
    function buildArchive(settingsJson, emailTemplatesJson) {
      const files = {}
      if (settingsJson !== undefined) {
        files['settings.json'] = strToU8(
          typeof settingsJson === 'string' ? settingsJson : JSON.stringify(settingsJson)
        )
      }
      if (emailTemplatesJson !== undefined) {
        files['email_templates.json'] = strToU8(
          typeof emailTemplatesJson === 'string' ? emailTemplatesJson : JSON.stringify(emailTemplatesJson)
        )
      }
      const zipped = zipSync(files)
      // Return an ArrayBuffer view over exactly the zip bytes.
      return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength)
    }

    const settingsJson = {
      exportedAt: '2024-01-01T00:00:00.000Z',
      systemConfig: [
        { key: 'featureFlag', value: 'on' },
        { key: 'maxUsers', value: 100 }
      ],
      siteConfig: [{ key: 'siteName', value: 'TAK NZ' }]
    }
    const emailTemplatesJson = [
      { templateKey: 'welcome', subjectTemplate: 'Hi', bodyTemplate: 'Welcome!' },
      { templateKey: 'reset', subjectTemplate: 'Reset', bodyTemplate: 'Reset link' }
    ]

    it('unzips a representative archive and resolves the merge of its two entries, dropping a legacy systemConfig (round-trip against the real fflate dependency)', async () => {
      // The fixture's settings.json carries a legacy systemConfig array; the
      // merged payload must DROP it (CDK trim) and keep only siteConfig +
      // emailTemplates.
      const arrayBuffer = buildArchive(settingsJson, emailTemplatesJson)

      const payload = await unzipExportedArchive(arrayBuffer)

      expect(payload).toEqual(mergeExportedJson(settingsJson, emailTemplatesJson))
      expect(payload.systemConfig).toBeUndefined()
      expect(payload.siteConfig).toEqual(settingsJson.siteConfig)
      expect(payload.emailTemplates).toEqual(emailTemplatesJson)
      // The result satisfies the guard the Admin UI checks before importing.
      expect(isImportPayloadShape(payload)).toBe(true)
    })

    it('rejects when the archive is missing settings.json', async () => {
      const arrayBuffer = buildArchive(undefined, emailTemplatesJson)
      await expect(unzipExportedArchive(arrayBuffer)).rejects.toThrow(/settings\.json/)
    })

    it('rejects when the archive is missing email_templates.json', async () => {
      const arrayBuffer = buildArchive(settingsJson, undefined)
      await expect(unzipExportedArchive(arrayBuffer)).rejects.toThrow(/email_templates\.json/)
    })

    it('rejects when settings.json is not valid JSON', async () => {
      const arrayBuffer = buildArchive('{ not valid json', emailTemplatesJson)
      await expect(unzipExportedArchive(arrayBuffer)).rejects.toThrow(/settings\.json is not valid JSON/)
    })

    it('rejects unreadable / garbage bytes that are not a zip at all', async () => {
      const garbage = strToU8('this is definitely not a zip archive')
      const arrayBuffer = garbage.buffer.slice(garbage.byteOffset, garbage.byteOffset + garbage.byteLength)
      await expect(unzipExportedArchive(arrayBuffer)).rejects.toThrow(/Could not read the archive/)
    })
  })

  describe('raw-json pass-through path (task 5.4, Requirements 8.3, 8.6)', () => {
    // The Admin UI, for a raw `.json` import, parses the file and uses isImportPayloadShape as
    // the guard - no unzip needed. An already-merged object that satisfies the shape is
    // recognised as such, and mergeExportedJson leaves such content intact.
    it('recognises an already-merged Import_Payload object via isImportPayloadShape', () => {
      const rawMerged = {
        siteConfig: [{ key: 'b', value: 2 }],
        emailTemplates: [{ templateKey: 'welcome', subjectTemplate: 'S', bodyTemplate: 'B' }]
      }
      expect(isImportPayloadShape(rawMerged)).toBe(true)
    })

    it('recognises an already-merged object even when emailTemplates is absent', () => {
      const rawMerged = {
        siteConfig: []
      }
      expect(isImportPayloadShape(rawMerged)).toBe(true)
    })

    it('accepts a legacy raw object that still carries a systemConfig array (it is ignored, not disqualifying)', () => {
      const legacy = { systemConfig: [{ key: 'a', value: 1 }], siteConfig: [] }
      expect(isImportPayloadShape(legacy)).toBe(true)
    })

    it('rejects a misshapen raw object (non-array siteConfig) so the UI blocks the import', () => {
      const misshapen = { siteConfig: 'nope' }
      expect(isImportPayloadShape(misshapen)).toBe(false)
    })
  })
})
