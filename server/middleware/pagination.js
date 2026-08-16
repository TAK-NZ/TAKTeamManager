/**
 * Shared pagination-parameter validation middleware (Requirements 11.4, 11.5).
 *
 * `paginationParams` reads `req.query.page` and `req.query.pageSize`,
 * applies the documented defaults (`page` defaults to 1, `pageSize`
 * defaults to 50 per Requirement 11.4), and validates both values are
 * positive integers with `pageSize` additionally capped at a maximum of
 * 200 (Requirement 11.4). A non-numeric string, a negative or zero value,
 * or a `pageSize` over 200 is rejected with HTTP 400 identifying which
 * parameter is invalid and why, and `next()` is NOT called — so the
 * underlying (potentially unbounded) query is never executed for an
 * out-of-range value (Requirement 11.5's "before executing the underlying
 * query").
 *
 * On success, the parsed/defaulted values are attached to `req.pagination`
 * as `{ page, pageSize, offset }`, where `offset = (page - 1) * pageSize`
 * is a precomputed convenience value for handlers that feed directly into
 * a SQL `LIMIT/OFFSET` clause.
 *
 * This module creates ONLY the shared middleware itself; wiring it onto
 * `GET /api/users`, `GET /api/teams/my-teams`, or any other list endpoint
 * is handled by the tasks that apply it (e.g. task 31.6), not here.
 *
 * Usage:
 *
 *   const { paginationParams } = require('../middleware/pagination');
 *
 *   router.get('/', paginationParams, async (req, res) => {
 *     const { page, pageSize, offset } = req.pagination;
 *     const rows = await pool.query(
 *       'SELECT * FROM users LIMIT $1 OFFSET $2',
 *       [pageSize, offset]
 *     );
 *     ...
 *   });
 */

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Parses a raw query-parameter value into a positive integer.
 *
 * Returns `undefined` when the raw value is absent (so the caller can
 * apply its own default), and `null` when the raw value is present but is
 * not a valid positive integer (non-numeric, fractional, negative, or
 * zero) so the caller can reject the request.
 *
 * `Number()` (rather than `parseInt`) is used so that inputs like `'12abc'`
 * or `''` are correctly rejected as non-numeric instead of being silently
 * truncated to `12` or `NaN`-coerced in a way that could slip past a
 * looser check.
 *
 * @param {unknown} rawValue - The raw `req.query.page`/`req.query.pageSize` value.
 * @returns {number|null|undefined}
 */
function parsePositiveInteger(rawValue) {
  if (rawValue === undefined) {
    return undefined;
  }

  // express's query parser can yield an array (e.g. `?page=1&page=2`) or
  // an object for repeated/complex query keys; neither is a valid single
  // pagination value.
  if (typeof rawValue !== 'string' && typeof rawValue !== 'number') {
    return null;
  }

  const stringValue = String(rawValue).trim();
  if (stringValue === '') {
    return null;
  }

  const numericValue = Number(stringValue);
  if (!Number.isFinite(numericValue) || !Number.isInteger(numericValue)) {
    return null;
  }

  if (numericValue < 1) {
    return null;
  }

  return numericValue;
}

/**
 * Express middleware validating `page`/`pageSize` query parameters
 * (Requirements 11.4, 11.5). See module doc comment above for full
 * behavior.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function paginationParams(req, res, next) {
  const parsedPage = parsePositiveInteger(req.query.page);
  if (parsedPage === null) {
    return res.status(400).json({
      error: `Invalid 'page' parameter: must be a positive integer (received '${req.query.page}')`
    });
  }
  const page = parsedPage === undefined ? DEFAULT_PAGE : parsedPage;

  const parsedPageSize = parsePositiveInteger(req.query.pageSize);
  if (parsedPageSize === null) {
    return res.status(400).json({
      error: `Invalid 'pageSize' parameter: must be a positive integer (received '${req.query.pageSize}')`
    });
  }
  const pageSize = parsedPageSize === undefined ? DEFAULT_PAGE_SIZE : parsedPageSize;

  if (pageSize > MAX_PAGE_SIZE) {
    return res.status(400).json({
      error: `Invalid 'pageSize' parameter: must not exceed ${MAX_PAGE_SIZE} (received '${req.query.pageSize}')`
    });
  }

  req.pagination = {
    page,
    pageSize,
    offset: (page - 1) * pageSize
  };

  next();
}

module.exports = {
  paginationParams,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE
};
