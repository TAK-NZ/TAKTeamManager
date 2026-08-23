import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  SUBJECT_MAX_LENGTH,
  BODY_MAX_LENGTH,
  buildTemplateUpdatePayload,
  validateTemplateDraft
} from './templateUpdatePayload.js'

// Feature: admin-settings-management, task 4.2.
//
// Property tests for the Template_Editor's pure save-path helpers
// (`templateUpdatePayload.js`, created in task 4.1). Following the convention of
// `callsignSuffixPreview.test.js`: fast-check properties whose expected outcome
// is RE-DERIVED directly from the generated inputs -- never by calling back into
// the code under test -- plus a handful of direct example assertions. Each
// property is tagged with its design.md name and Requirement links and runs at
// least 100 times.

// Strings spanning the classes the property needs to exercise: empty,
// whitespace-only (empty once trimmed), a normal value, a value exactly at a
// boundary length, and a value one past a boundary. `boundary` and `over` are
// the two lengths a caller passes so the generator can target each field's own
// server bound (1000 for subject, 10000 for body).
function draftStringArb(boundary, over) {
  return fc.oneof(
    fc.constant(''), // empty
    fc.constantFrom(' ', '   ', '\t', '\n  \t'), // whitespace-only
    fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim() !== ''), // normal, non-empty trimmed
    fc.constant('a'.repeat(boundary)), // exactly at the boundary length
    fc.constant('a'.repeat(over)) // one past the boundary length
  )
}

// The independent oracle for change detection: raw strict string inequality,
// exactly what the property claims the payload keys off. Coerces a
// missing/non-string field to '' so the comparison matches the helper's
// like-with-like handling.
function asField(value) {
  return typeof value === 'string' ? value : ''
}

describe('templateUpdatePayload Property 3: Update payload contains exactly the changed fields (Requirements 4.2)', () => {
  // Original and draft strings drawn from the same varied space, so identical,
  // subject-only, body-only, and both-changed cases all arise.
  const subjectArb = draftStringArb(SUBJECT_MAX_LENGTH, SUBJECT_MAX_LENGTH + 1)
  const bodyArb = draftStringArb(BODY_MAX_LENGTH, BODY_MAX_LENGTH + 1)

  // Feature: admin-settings-management, Property 3: Update payload contains exactly the changed fields
  it('includes subjectTemplate iff the subject changed, bodyTemplate iff the body changed, and is non-empty iff something changed', () => {
    fc.assert(
      fc.property(
        subjectArb, bodyArb, subjectArb, bodyArb,
        (originalSubject, originalBody, draftSubject, draftBody) => {
          const original = { subject: originalSubject, body: originalBody }
          const draft = { subject: draftSubject, body: draftBody }

          // Expected presence re-derived directly from raw string inequality,
          // never by calling buildTemplateUpdatePayload.
          const subjectChanged = asField(draftSubject) !== asField(originalSubject)
          const bodyChanged = asField(draftBody) !== asField(originalBody)

          const payload = buildTemplateUpdatePayload(original, draft)
          const hasSubject = Object.prototype.hasOwnProperty.call(payload, 'subjectTemplate')
          const hasBody = Object.prototype.hasOwnProperty.call(payload, 'bodyTemplate')

          // subjectTemplate included iff the subject differs (Req 4.2).
          expect(hasSubject).toBe(subjectChanged)
          // bodyTemplate included iff the body differs (Req 4.2).
          expect(hasBody).toBe(bodyChanged)

          // When a field is included, it carries the draft's raw value.
          if (hasSubject) {
            expect(payload.subjectTemplate).toBe(draftSubject)
          }
          if (hasBody) {
            expect(payload.bodyTemplate).toBe(draftBody)
          }

          // Non-empty iff at least one field differs; exactly {} when identical.
          const anythingChanged = subjectChanged || bodyChanged
          expect(Object.keys(payload).length > 0).toBe(anythingChanged)
          if (!anythingChanged) {
            expect(payload).toEqual({})
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})

describe('templateUpdatePayload Property 4: Draft validation enforces the server\'s bounds (Requirements 4.3, 4.4, 4.5)', () => {
  const subjectArb = draftStringArb(SUBJECT_MAX_LENGTH, SUBJECT_MAX_LENGTH + 1)
  const bodyArb = draftStringArb(BODY_MAX_LENGTH, BODY_MAX_LENGTH + 1)

  // Feature: admin-settings-management, Property 4: Draft validation enforces the server's bounds
  it('reports a problem iff both-empty, or a supplied subject is empty-after-trim or > 1000, or a supplied body is empty-after-trim or > 10000', () => {
    fc.assert(
      fc.property(
        subjectArb, bodyArb,
        (subject, body) => {
          const draft = { subject, body }

          // Both fields are supplied strings in the editor. Re-derive the
          // expected "has a problem" boolean straight from the same rules the
          // server enforces -- checking behavior, not message wording.
          const subjectEmpty = subject.trim() === ''
          const bodyEmpty = body.trim() === ''
          const subjectTooLong = subject.length > SUBJECT_MAX_LENGTH
          const bodyTooLong = body.length > BODY_MAX_LENGTH

          const expectProblem =
            (subjectEmpty && bodyEmpty) || // Req 4.3
            (subjectEmpty || subjectTooLong) || // Req 4.4 (subject supplied)
            (bodyEmpty || bodyTooLong) // Req 4.5 (body supplied)

          const problems = validateTemplateDraft(draft)
          expect(Array.isArray(problems)).toBe(true)
          expect(problems.length > 0).toBe(expectProblem)
          // A valid draft returns exactly the empty array.
          if (!expectProblem) {
            expect(problems).toEqual([])
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})

// A few direct examples, matching the file convention, that pin the boundary
// behavior the property covers probabilistically.
describe('templateUpdatePayload examples (Requirements 4.2, 4.3, 4.4, 4.5)', () => {
  it('exposes the server bounds as constants (Req 4.4, 4.5)', () => {
    expect(SUBJECT_MAX_LENGTH).toBe(1000)
    expect(BODY_MAX_LENGTH).toBe(10000)
  })

  it('builds an empty payload when nothing changed (Req 4.2)', () => {
    const same = { subject: 'Hello', body: 'World' }
    expect(buildTemplateUpdatePayload(same, { ...same })).toEqual({})
  })

  it('includes only the changed field (Req 4.2)', () => {
    const original = { subject: 'Hello', body: 'World' }
    expect(buildTemplateUpdatePayload(original, { subject: 'Hi', body: 'World' }))
      .toEqual({ subjectTemplate: 'Hi' })
    expect(buildTemplateUpdatePayload(original, { subject: 'Hello', body: 'There' }))
      .toEqual({ bodyTemplate: 'There' })
    expect(buildTemplateUpdatePayload(original, { subject: 'Hi', body: 'There' }))
      .toEqual({ subjectTemplate: 'Hi', bodyTemplate: 'There' })
  })

  it('accepts a subject of exactly 1000 characters but rejects 1001 (Req 4.4)', () => {
    const at = { subject: 'a'.repeat(1000), body: 'body' }
    const over = { subject: 'a'.repeat(1001), body: 'body' }
    expect(validateTemplateDraft(at)).toEqual([])
    expect(validateTemplateDraft(over).length).toBeGreaterThan(0)
  })

  it('accepts a body of exactly 10000 characters but rejects 10001 (Req 4.5)', () => {
    const at = { subject: 'subject', body: 'a'.repeat(10000) }
    const over = { subject: 'subject', body: 'a'.repeat(10001) }
    expect(validateTemplateDraft(at)).toEqual([])
    expect(validateTemplateDraft(over).length).toBeGreaterThan(0)
  })

  it('reports a problem when both fields are empty after trimming (Req 4.3)', () => {
    expect(validateTemplateDraft({ subject: '   ', body: '\t' }).length).toBeGreaterThan(0)
  })
})
