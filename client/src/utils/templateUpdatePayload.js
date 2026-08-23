/**
 * Pure, framework-free helpers for the Template_Editor's save path
 * (admin-settings-management, task 4.1). No React import, no API import --
 * following the convention of `callsignSuffixPreview.js` and
 * `directoryScopeMessage.js` so the decision logic is directly unit- and
 * property-testable independent of rendering.
 *
 * Two responsibilities live here:
 *
 * 1. `buildTemplateUpdatePayload(original, draft)` builds the
 *    `PUT /api/communications/templates/:key` body containing ONLY the fields
 *    that changed, so the Client never sends an unchanged field and the
 *    server's COALESCE partial-update semantics apply exactly to the fields the
 *    operator touched (Requirement 4.2).
 *
 * 2. `validateTemplateDraft(draft)` mirrors the server's own express-validator
 *    bounds so the Client fails fast before the network round-trip
 *    (Requirements 4.3, 4.4, 4.5). It reports problems for the both-empty case,
 *    a supplied subject that is empty-after-trim or longer than 1000
 *    characters, and a supplied body that is empty-after-trim or longer than
 *    10000 characters.
 */

/**
 * The server's upper bound on a subject template (express-validator
 * `isLength({ max: 1000 })`). Compared against the RAW string length, matching
 * the server which bounds the untrimmed value.
 */
export const SUBJECT_MAX_LENGTH = 1000

/**
 * The server's upper bound on a body template (express-validator
 * `isLength({ max: 10000 })`).
 */
export const BODY_MAX_LENGTH = 10000

/**
 * Requirement 4.2. Builds the `PUT /api/communications/templates/:key` body,
 * including `subjectTemplate` if and only if the draft subject differs from the
 * original subject, and `bodyTemplate` if and only if the draft body differs
 * from the original body.
 *
 * When at least one field changed the returned object is non-empty; when
 * nothing changed it returns `{}` and the caller decides not to send. An
 * unchanged field is NEVER included.
 *
 * The comparison is strict string inequality on the raw values -- the same
 * bytes the operator will save. Trimming is a validation concern
 * (`validateTemplateDraft`), not a change-detection concern: a whitespace-only
 * edit the operator made is still a change worth sending.
 *
 * @param {{subject: string, body: string}} original  the loaded template's fields
 * @param {{subject: string, body: string}} draft     the edited fields
 * @returns {{subjectTemplate?: string, bodyTemplate?: string}}
 */
export function buildTemplateUpdatePayload(original, draft) {
  const originalSubject = readField(original, 'subject')
  const originalBody = readField(original, 'body')
  const draftSubject = readField(draft, 'subject')
  const draftBody = readField(draft, 'body')

  const payload = {}
  if (draftSubject !== originalSubject) {
    payload.subjectTemplate = draftSubject
  }
  if (draftBody !== originalBody) {
    payload.bodyTemplate = draftBody
  }
  return payload
}

/**
 * Requirements 4.3, 4.4, 4.5. Returns an array of human-readable problem
 * strings (an empty array means the draft is valid), mirroring the server's
 * express-validator bounds so the Client can block a save before the network
 * round-trip.
 *
 * Rules, evaluated so the messages read naturally:
 *
 * - If BOTH subject and body are empty after trimming -> one problem
 *   (Requirement 4.3). The endpoint requires at least one field, so this is the
 *   only problem worth reporting in that case; per-field checks below would be
 *   redundant noise.
 * - Otherwise, a SUPPLIED subject (a non-undefined value) that is empty after
 *   trimming, or whose raw length exceeds 1000, is a problem (Requirement 4.4).
 * - Otherwise, a SUPPLIED body (a non-undefined value) that is empty after
 *   trimming, or whose raw length exceeds 10000, is a problem (Requirement 4.5).
 *
 * "Supplied" means a non-undefined value; in the editor both fields are always
 * present strings. Emptiness is checked against the TRIMMED value; the upper
 * bounds are checked against the RAW string length, matching the server which
 * trims for the presence check and bounds the untrimmed value.
 *
 * @param {{subject?: string, body?: string}} draft
 * @returns {string[]}
 */
export function validateTemplateDraft(draft) {
  const subject = draft ? draft.subject : undefined
  const body = draft ? draft.body : undefined

  const subjectSupplied = subject !== undefined
  const bodySupplied = body !== undefined

  const subjectStr = subjectSupplied ? String(subject) : ''
  const bodyStr = bodySupplied ? String(body) : ''

  const subjectEmpty = subjectStr.trim() === ''
  const bodyEmpty = bodyStr.trim() === ''

  const problems = []

  // Requirement 4.3: both empty after trimming -> the endpoint needs at least
  // one field. Report only this, since the per-field checks below would just
  // repeat the same emptiness.
  if (subjectEmpty && bodyEmpty) {
    problems.push('At least one of subject or body is required.')
    return problems
  }

  // Requirement 4.4: a supplied subject must be non-empty after trimming and at
  // most 1000 characters (raw length).
  if (subjectSupplied) {
    if (subjectEmpty) {
      problems.push('Subject must not be empty.')
    } else if (subjectStr.length > SUBJECT_MAX_LENGTH) {
      problems.push(`Subject must be at most ${SUBJECT_MAX_LENGTH} characters.`)
    }
  }

  // Requirement 4.5: a supplied body must be non-empty after trimming and at
  // most 10000 characters (raw length).
  if (bodySupplied) {
    if (bodyEmpty) {
      problems.push('Body must not be empty.')
    } else if (bodyStr.length > BODY_MAX_LENGTH) {
      problems.push(`Body must be at most ${BODY_MAX_LENGTH} characters.`)
    }
  }

  return problems
}

/**
 * Reads a `subject`/`body` field from an `{ subject, body }` object as a string,
 * coercing a missing or non-string value to an empty string so change
 * detection compares like with like.
 *
 * @param {{subject?: string, body?: string}|null|undefined} source
 * @param {'subject'|'body'} field
 * @returns {string}
 */
function readField(source, field) {
  if (!source) {
    return ''
  }
  const value = source[field]
  return typeof value === 'string' ? value : ''
}
