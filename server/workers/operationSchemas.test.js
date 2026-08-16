const fs = require('fs');
const path = require('path');

const operationSchemas = require('./operationSchemas');

// A valid `typeof`-result string, per the shape documented at the top of
// operationSchemas.js.
const VALID_TYPES = new Set(['string', 'number', 'boolean', 'object']);

/**
 * Statically extracts every `operation_type` string handled by
 * `executeOperation`'s `switch` statement in syncWorker.js, by scanning the
 * source text for `case '<value>':` lines.
 *
 * A static scan (rather than `require('./syncWorker')` and driving
 * `executeOperation` for every possible string) is used deliberately:
 * `syncWorker.js` requires `pg`, `../services/authentik`, and
 * `../services/TeamMembershipService` (which itself pulls in the real
 * database pool module), and while none of those perform network I/O at
 * module-load time, actually calling `executeOperation` would require
 * either a live DB connection or extensive mocking of `fetch`/the pool for
 * every operation type -- overkill for what is purely a completeness check
 * of the schema map's keys against the switch statement's case labels.
 */
function extractHandledOperationTypes() {
  const source = fs.readFileSync(path.join(__dirname, 'syncWorker.js'), 'utf8');

  // Only scan the executeOperation method's switch statement, so a `case`
  // string appearing elsewhere in the file (there is none today, but this
  // keeps the extraction scoped) can't produce a false positive.
  const methodMatch = source.match(
    /async executeOperation\(operation\) \{[\s\S]*?\n {2}\}\n/
  );
  expect(methodMatch).not.toBeNull();
  const methodBody = methodMatch[0];

  const caseRegex = /case\s+'([^']+)':/g;
  const types = [];
  let match;
  while ((match = caseRegex.exec(methodBody)) !== null) {
    types.push(match[1]);
  }
  return types;
}

/**
 * Requirement 26.6/26.7/26.8 (tasks 48.4/48.5): `revoke_tak_certificates`
 * now has both a schema entry (task 48.4) and a corresponding `case` in
 * `executeOperation`'s switch statement (task 48.5, `revokeTakCertificates`),
 * so it no longer needs to be listed here. This list is kept (currently
 * empty) as the documented mechanism for the schema-before-handler
 * staging pattern, should a future operation type need it again.
 */
const PENDING_HANDLER_OPERATION_TYPES = [];

describe('operationSchemas completeness', () => {
  const handledOperationTypes = extractHandledOperationTypes();

  it('finds at least the operation types documented in the task/design docs', () => {
    // Sanity check on the extractor itself: if this list is empty or tiny,
    // the regex above stopped matching syncWorker.js's actual shape and the
    // completeness assertions below would trivially (and wrongly) pass.
    expect(handledOperationTypes.length).toBeGreaterThanOrEqual(10);
  });

  it('has a schema entry for every operation_type handled by executeOperation\'s switch statement', () => {
    const missing = handledOperationTypes.filter(
      (operationType) => !Object.prototype.hasOwnProperty.call(operationSchemas, operationType)
    );
    expect(missing).toEqual([]);
  });

  it('does not define a schema entry for an operation_type executeOperation does not handle (excluding documented pending-handler entries)', () => {
    // Guards against the map drifting out of sync in the other direction
    // (a stale/renamed entry left behind after a handler is removed or
    // renamed), while allowing the specific, documented
    // schema-before-handler staging described above.
    const extra = Object.keys(operationSchemas).filter(
      (operationType) =>
        !handledOperationTypes.includes(operationType)
        && !PENDING_HANDLER_OPERATION_TYPES.includes(operationType)
    );
    expect(extra).toEqual([]);
  });
});

describe('operationSchemas structure', () => {
  const entries = Object.entries(operationSchemas);

  it('is a non-empty plain object', () => {
    expect(typeof operationSchemas).toBe('object');
    expect(operationSchemas).not.toBeNull();
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s has a well-formed requiredFields map and, if present, optionalFields map', (operationType, schema) => {
    expect(schema).toBeInstanceOf(Object);

    expect(schema.requiredFields).toBeInstanceOf(Object);
    const requiredFieldNames = Object.keys(schema.requiredFields);
    expect(requiredFieldNames.length).toBeGreaterThan(0);
    for (const fieldName of requiredFieldNames) {
      const expectedType = schema.requiredFields[fieldName];
      expect(typeof expectedType).toBe('string');
      expect(VALID_TYPES.has(expectedType)).toBe(true);
    }

    if (schema.optionalFields !== undefined) {
      expect(schema.optionalFields).toBeInstanceOf(Object);
      const optionalFieldNames = Object.keys(schema.optionalFields);
      for (const fieldName of optionalFieldNames) {
        const expectedType = schema.optionalFields[fieldName];
        expect(typeof expectedType).toBe('string');
        expect(VALID_TYPES.has(expectedType)).toBe(true);
        // A field should not be listed as both required and optional.
        expect(requiredFieldNames).not.toContain(fieldName);
      }
    }
  });
});
