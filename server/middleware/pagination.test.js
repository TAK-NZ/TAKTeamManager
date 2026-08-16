/**
 * Unit tests for the shared `paginationParams` middleware
 * (Requirements 11.4, 11.5).
 *
 * These tests mount `paginationParams` in a minimal Express app (mirroring
 * `server/middleware/validators.test.js`'s approach) and assert:
 *   - defaults are applied when `page`/`pageSize` are absent;
 *   - valid explicit values are parsed and attached to `req.pagination`;
 *   - out-of-range/non-numeric values are rejected with HTTP 400 and
 *     `next()` is never called (no downstream handler runs);
 *   - `pageSize` exactly at the 200 boundary is accepted, not rejected.
 */

const express = require('express');
const request = require('supertest');
const { paginationParams, DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } = require('./pagination');

function buildApp() {
  const app = express();
  app.get('/test', paginationParams, (req, res) => {
    res.status(200).json({ pagination: req.pagination });
  });
  return app;
}

describe('paginationParams', () => {
  it('defaults page to 1 and pageSize to 50 when absent, and calls next()', async () => {
    const app = buildApp();
    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({
      page: DEFAULT_PAGE,
      pageSize: DEFAULT_PAGE_SIZE,
      offset: 0
    });
    expect(DEFAULT_PAGE).toBe(1);
    expect(DEFAULT_PAGE_SIZE).toBe(50);
  });

  it('parses valid explicit page/pageSize and attaches them to req.pagination', async () => {
    const app = buildApp();
    const res = await request(app).get('/test').query({ page: 3, pageSize: 25 });

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({
      page: 3,
      pageSize: 25,
      offset: 50 // (3 - 1) * 25
    });
  });

  it('rejects pageSize exceeding the 200 maximum with 400 and does not call next()', async () => {
    const app = buildApp();
    const res = await request(app).get('/test').query({ pageSize: 201 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pageSize/);
    expect(res.body.pagination).toBeUndefined();
  });

  it('accepts pageSize exactly at the 200 boundary', async () => {
    const app = buildApp();
    const res = await request(app).get('/test').query({ pageSize: MAX_PAGE_SIZE });

    expect(res.status).toBe(200);
    expect(res.body.pagination.pageSize).toBe(200);
  });

  it('rejects a negative page with 400', async () => {
    const app = buildApp();
    const res = await request(app).get('/test').query({ page: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/page/);
  });

  it('rejects a zero page with 400', async () => {
    const app = buildApp();
    const res = await request(app).get('/test').query({ page: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/page/);
  });

  it('rejects a zero pageSize with 400', async () => {
    const app = buildApp();
    const res = await request(app).get('/test').query({ pageSize: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pageSize/);
  });

  it('rejects a non-numeric page with 400', async () => {
    const app = buildApp();
    const res = await request(app).get('/test').query({ page: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/page/);
  });

  it('rejects a non-numeric pageSize with 400', async () => {
    const app = buildApp();
    const res = await request(app).get('/test').query({ pageSize: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pageSize/);
  });

  it('rejects a fractional page value with 400', async () => {
    const app = buildApp();
    const res = await request(app).get('/test').query({ page: '1.5' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/page/);
  });
});

/**
 * Property-based test (design.md's "Property-Based Tests" section),
 * implemented with `fast-check` via `@fast-check/jest`'s `test.prop`
 * integration, matching the convention established in
 * `../config/configValidator.test.js`, `../config/permissions.registry.test.js`,
 * and `../config/htmlSafeSubset.test.js`.
 *
 * `paginationParams` is Express middleware rather than a standalone pure
 * function, so it is exercised end-to-end through a minimal Express app
 * plus `supertest`, mirroring the example-based tests above. `test.prop`
 * supports an async property function, so the `supertest` call is simply
 * awaited inside the property body.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

// Feature: production-hardening, Property 5: Pagination parameter validation
describe('Property 5: Pagination parameter validation', () => {
  // Sentinel distinguishing "query parameter omitted entirely" from any
  // generated value, since `undefined` cannot itself be assigned as a
  // query-string value.
  const ABSENT = Symbol('pagination-param-absent');

  function boundedValidIntegerArb(max) {
    return fc.oneof(
      fc.constant(1),
      fc.constant(max),
      fc.integer({ min: 1, max })
    );
  }

  const zeroOrNegativeIntegerArb = fc.integer({ min: -1000, max: 0 });

  // Guaranteed-fractional numbers (e.g. 3.7, -12.4) built from an integer
  // whole part plus a non-zero tenths digit, avoiding floating-point
  // precision edge cases that a raw `fc.double()` could otherwise produce
  // near integer boundaries.
  const nonIntegerFloatArb = fc
    .tuple(fc.integer({ min: -999, max: 999 }), fc.integer({ min: 1, max: 9 }))
    .map(([whole, tenths]) => whole + tenths / 10);

  const arbitraryStringArb = fc.string();

  const pageRawArb = fc.oneof(
    fc.constant(ABSENT),
    boundedValidIntegerArb(1000),
    zeroOrNegativeIntegerArb,
    nonIntegerFloatArb,
    arbitraryStringArb
  );

  const pageSizeRawArb = fc.oneof(
    fc.constant(ABSENT),
    boundedValidIntegerArb(MAX_PAGE_SIZE),
    fc.integer({ min: MAX_PAGE_SIZE + 1, max: MAX_PAGE_SIZE + 10_000 }),
    zeroOrNegativeIntegerArb,
    nonIntegerFloatArb,
    arbitraryStringArb
  );

  /**
   * Independently-computed reference/oracle, re-derived directly from
   * design.md's Property 5 statement ("validation accepts the request if
   * and only if page >= 1 and 1 <= pageSize <= 200 after numeric
   * coercion") and Requirement 11.4/11.5's text, WITHOUT importing or
   * reusing `./pagination.js`'s own `parsePositiveInteger`/
   * `paginationParams` logic, so a bug in the real implementation cannot
   * also be baked into the check meant to catch it.
   */
  function isValidPositiveIntegerAfterCoercion(raw) {
    const stringValue = String(raw).trim();
    if (stringValue === '') {
      return false;
    }
    const numericValue = Number(stringValue);
    return Number.isFinite(numericValue) && Number.isInteger(numericValue) && numericValue >= 1;
  }

  function coerceToInteger(raw) {
    return Number(String(raw).trim());
  }

  function expectedPaginationOutcome(pageRaw, pageSizeRaw) {
    const pagePresent = pageRaw !== ABSENT;
    const pageSizePresent = pageSizeRaw !== ABSENT;

    // Mirrors the requirements' page-then-pageSize validation ordering:
    // an invalid `page` is rejected before `pageSize` is even considered.
    if (pagePresent && !isValidPositiveIntegerAfterCoercion(pageRaw)) {
      return { status: 400, invalidField: 'page' };
    }

    if (pageSizePresent) {
      if (!isValidPositiveIntegerAfterCoercion(pageSizeRaw)) {
        return { status: 400, invalidField: 'pageSize' };
      }
      if (coerceToInteger(pageSizeRaw) > MAX_PAGE_SIZE) {
        return { status: 400, invalidField: 'pageSize' };
      }
    }

    const page = pagePresent ? coerceToInteger(pageRaw) : DEFAULT_PAGE;
    const pageSize = pageSizePresent ? coerceToInteger(pageSizeRaw) : DEFAULT_PAGE_SIZE;

    return {
      status: 200,
      pagination: { page, pageSize, offset: (page - 1) * pageSize }
    };
  }

  test.prop([pageRawArb, pageSizeRawArb], { numRuns: 100 })(
    'matches an independently-computed page>=1/1<=pageSize<=200-after-coercion reference check, rejecting with 400 before any downstream handler runs on an invalid value, and accepting with the correctly defaulted/parsed req.pagination otherwise',
    async (pageRaw, pageSizeRaw) => {
      const app = buildApp();
      const query = {};
      if (pageRaw !== ABSENT) {
        query.page = pageRaw;
      }
      if (pageSizeRaw !== ABSENT) {
        query.pageSize = pageSizeRaw;
      }

      const res = await request(app).get('/test').query(query);
      const expected = expectedPaginationOutcome(pageRaw, pageSizeRaw);

      expect(res.status).toBe(expected.status);

      if (expected.status === 200) {
        expect(res.body.pagination).toEqual(expected.pagination);
      } else {
        // A rejected request never calls next(), so the downstream
        // handler (which would populate `pagination` on the response
        // body) never runs.
        expect(res.body.pagination).toBeUndefined();
        expect(res.body.error).toMatch(new RegExp(expected.invalidField));
      }
    }
  );
});
