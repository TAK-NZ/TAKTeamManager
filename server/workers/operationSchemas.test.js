// Feature device-management, Requirements 12.2/12.3 (task 19.7): the
// `revoke_tak_certificates` entry's accept/reject BEHAVIOUR is asserted
// through the real `SyncWorker.validatePayloadSchema` (the only place the
// `exactlyOneOf` rule is interpreted) rather than by re-implementing that
// rule here -- a test that re-implemented it could agree with itself while
// disagreeing with the validator the queue actually runs.
//
// Requiring `syncWorker.js` pulls in `pg` (via `../config/database`, which
// constructs a Pool at import time) and the structured logger, so both are
// mocked exactly as `syncWorker.test.js` mocks them: no database connection
// and no log output are involved in validating a payload's shape.
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    on: jest.fn(),
    query: jest.fn(),
    connect: jest.fn(),
    end: jest.fn()
  }))
}));

jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn()
  }))
}));

const fs = require('fs');
const path = require('path');

const operationSchemas = require('./operationSchemas');
const SyncWorker = require('./syncWorker');

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

describe('CloudTAK operation schemas (Requirement 9.5, task 3.1)', () => {
  // The three CloudTAK operation types each carry only a numeric `team_id`
  // (see design.md "operationSchemas.js entries"). This is distinct from the
  // completeness test above: it pins the concrete required-field shape the
  // Sync_Worker handlers (tasks 4.1/4.2) read off the payload, independent
  // of whether their switch cases exist yet.
  const CLOUDTAK_OPERATION_TYPES = [
    'create_cloudtak_group',
    'update_cloudtak_group',
    'delete_cloudtak_group'
  ];

  it.each(CLOUDTAK_OPERATION_TYPES)('%s has requiredFields.team_id === \'number\'', (operationType) => {
    const schema = operationSchemas[operationType];
    expect(schema).toBeInstanceOf(Object);
    expect(schema.requiredFields).toBeInstanceOf(Object);
    expect(schema.requiredFields.team_id).toBe('number');
  });
});

describe('operationSchemas structure', () => {
  const entries = Object.entries(operationSchemas);

  it('is a non-empty plain object', () => {
    expect(typeof operationSchemas).toBe('object');
    expect(operationSchemas).not.toBeNull();
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s has a well-formed requiredFields map and, if present, optionalFields/exactlyOneOf maps', (operationType, schema) => {
    expect(schema).toBeInstanceOf(Object);

    // Feature device-management (task 19.2): an entry declaring
    // `exactlyOneOf` MAY omit `requiredFields` entirely, because a
    // discriminated entry can legitimately have no field that is required
    // across every accepted payload shape. Every OTHER entry must still
    // declare a non-empty `requiredFields` map, as before.
    const hasDiscriminators = schema.exactlyOneOf !== undefined;
    let requiredFieldNames = [];
    if (!hasDiscriminators || schema.requiredFields !== undefined) {
      expect(schema.requiredFields).toBeInstanceOf(Object);
      requiredFieldNames = Object.keys(schema.requiredFields);
      expect(requiredFieldNames.length).toBeGreaterThan(0);
      for (const fieldName of requiredFieldNames) {
        const expectedType = schema.requiredFields[fieldName];
        expect(typeof expectedType).toBe('string');
        expect(VALID_TYPES.has(expectedType)).toBe(true);
      }
    }

    let discriminatorFieldNames = [];
    if (hasDiscriminators) {
      expect(schema.exactlyOneOf).toBeInstanceOf(Object);
      discriminatorFieldNames = Object.keys(schema.exactlyOneOf);
      // A single-element `exactlyOneOf` would just be a required field.
      expect(discriminatorFieldNames.length).toBeGreaterThanOrEqual(2);
      for (const fieldName of discriminatorFieldNames) {
        const expectedType = schema.exactlyOneOf[fieldName];
        expect(typeof expectedType).toBe('string');
        expect(VALID_TYPES.has(expectedType)).toBe(true);
        // A discriminator must not also be unconditionally required.
        expect(requiredFieldNames).not.toContain(fieldName);
      }
    }

    if (schema.optionalFields !== undefined) {
      expect(schema.optionalFields).toBeInstanceOf(Object);
      const optionalFieldNames = Object.keys(schema.optionalFields);
      for (const fieldName of optionalFieldNames) {
        const expectedType = schema.optionalFields[fieldName];
        expect(typeof expectedType).toBe('string');
        expect(VALID_TYPES.has(expectedType)).toBe(true);
        // A field should not be listed as both required and optional, nor
        // as both a discriminator and optional.
        expect(requiredFieldNames).not.toContain(fieldName);
        expect(discriminatorFieldNames).not.toContain(fieldName);
      }
    }
  });
});

/**
 * Feature device-management, Requirements 12.2/12.3 (task 19.7): the
 * `revoke_tak_certificates`-SPECIFIC accept/reject behaviour of its two
 * mutually exclusive discriminators, driven through the real
 * `SyncWorker.validatePayloadSchema`.
 *
 * Distinct from the generic `exactlyOneOf` well-formedness case in
 * `describe('operationSchemas structure')` above, which only checks that every
 * entry DECLARING discriminators declares them in a legal shape. What matters
 * for this feature is what the validator DOES with the two shapes:
 *
 *   - the new device-scoped `{ client_uid }` payload validates (12.2), and
 *   - the pre-existing user-scoped `{ tak_usernames }` payload STILL validates,
 *     so this feature widened the contract rather than replacing it and the
 *     three pre-existing call sites keep working (12.3, main-spec 26.6/26.7);
 *   - a payload carrying BOTH is ambiguous about what to revoke, and one
 *     carrying NEITHER identifies nothing, so both are rejected up front
 *     instead of being silently resolved by the handler's branch order.
 *
 * `validatePayloadSchema` reads only its two arguments and the schema map (no
 * instance state), but it is invoked on a real instance here so the production
 * method -- not a copy of its logic -- is what these cases exercise.
 */
describe('revoke_tak_certificates payload validation (12.2, 12.3)', () => {
  let validate;

  beforeAll(() => {
    const worker = new SyncWorker();
    validate = (payload) => worker.validatePayloadSchema('revoke_tak_certificates', payload);
  });

  it('declares the two discriminators (and no unconditionally required field)', () => {
    const schema = operationSchemas.revoke_tak_certificates;

    // Neither shape's key may be listed as unconditionally required: doing so
    // would make the OTHER shape permanently invalid, which is exactly how the
    // device-scoped addition would break the user-scoped call sites (12.3).
    expect(schema.requiredFields).toBeUndefined();
    expect(schema.exactlyOneOf).toEqual({ client_uid: 'string', tak_usernames: 'object' });
    expect(schema.optionalFields).toEqual({ target_user_id: 'number' });
  });

  describe('accepts', () => {
    it.each([
      ['the device-scoped payload the revoke routes send', { client_uid: 'ANDROID-842f08e120efdbe3', target_user_id: 42 }],
      ['a device-scoped payload without the optional target_user_id', { client_uid: 'ANDROID-842f08e120efdbe3' }],
      ['the pre-existing user-scoped payload, unchanged', { tak_usernames: ['alice'] }],
      ['a user-scoped payload carrying the optional target_user_id', { tak_usernames: ['alice'], target_user_id: 42 }],
      ['a user-scoped payload with several usernames', { tak_usernames: ['alice', 'bob'] }]
    ])('%s', (_label, payload) => {
      expect(validate(payload)).toEqual({ valid: true });
    });
  });

  describe('rejects', () => {
    it('a payload carrying BOTH discriminators, naming both in the reason', () => {
      const result = validate({
        client_uid: 'ANDROID-842f08e120efdbe3',
        tak_usernames: ['alice'],
        target_user_id: 42
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('exactly one');
      expect(result.reason).toContain('client_uid');
      expect(result.reason).toContain('tak_usernames');
    });

    it.each([
      ['an empty payload', {}],
      ['a payload carrying only the optional target_user_id', { target_user_id: 42 }]
    ])('%s, which carries neither discriminator', (_label, payload) => {
      const result = validate(payload);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('carries none');
    });

    it.each([
      ['a numeric client_uid', { client_uid: 42 }],
      ['a string tak_usernames (the un-arrayed single-username mistake)', { tak_usernames: 'alice' }]
    ])('%s, whose present discriminator has the wrong type', (_label, payload) => {
      const result = validate(payload);

      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/expected/);
    });

    it('a device-scoped payload whose optional target_user_id is a string', () => {
      const result = validate({ client_uid: 'ANDROID-842f08e120efdbe3', target_user_id: '42' });

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('target_user_id');
    });
  });
});
