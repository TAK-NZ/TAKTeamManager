const { parse } = require('csv-parse');
const pool = require('../config/database');
const Team = require('../models/Team');
const UserProvisioningService = require('./UserProvisioningService');
const authentikService = require('./authentik');
const { isValidCallsignPrefix } = require('../utils/callsignValidation');
const logger = require('../config/logger').createLogger('BulkImportService');

/**
 * BulkImportService (Requirement 29, `design.md` Section 24: CSV Bulk
 * Import for Users and Teams).
 *
 * This task (51.1) implements only `importUsers`. `importTeams` (task
 * 51.2), the CSV template files (task 51.3), and the route layer (task
 * 51.4) are deliberately out of scope here.
 *
 * Thrown internally by `importUserRow` for any row-local validation or
 * authorization failure. Always caught by `importUsers`'s per-row loop
 * and recorded as `{row, success: false, error}` -- it never escapes
 * `importUsers` itself (Requirement 29.4: a rejected row must not affect
 * the processing of any other row in the batch).
 */
class BulkImportRowError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BulkImportRowError';
  }
}

/**
 * Thrown by `importTeams` (task 51.2) to reject an ENTIRE import batch
 * upfront, before any row is read from the CSV, when the importing user
 * is not a Global_Manager. Unlike `BulkImportRowError` (a per-row
 * failure that never stops the batch), this is a whole-batch failure --
 * team import is Global_Manager-only, per Requirement 29.5 and
 * `design.md` Section 24, since creating arbitrary new teams is not
 * scoped to any single team an admin might administer the way user
 * import is.
 */
class BulkImportAuthorizationError extends Error {
  constructor(message = 'Team import is restricted to Global_Manager') {
    super(message);
    this.name = 'BulkImportAuthorizationError';
  }
}

/**
 * Reads a row field, trimmed, treating `undefined`/`null` the same as an
 * empty string. Used throughout `buildImportGraph` (task 17.1) for the
 * optional `rowId`/`parentRowRef`/`parentTeamName`/`parentTeamId`
 * columns, none of which are required.
 *
 * @param {Record<string, string>} row
 * @param {string} field
 * @returns {string}
 */
function readOptionalField(row, field) {
  const value = row[field];
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

/**
 * Requirements 9.1-9.6, 9.12, 9.13 (design.md's Phase 1, tasks 17.1-
 * 17.3): builds an in-memory dependency graph from a whole file's
 * already-parsed CSV rows, PURE logic only -- no I/O, no DB access, no
 * async. This is a pre-step of the two-phase CSV team-import pipeline
 * (`importTeams`); it does not create any team, or resolve
 * `parentTeamName`/`parentTeamId` against the database (that remains a
 * later pipeline step's job).
 *
 * In addition to node construction and the whole-file rejections
 * described below, this function also (task 17.3):
 *   - Marks a row whose `parentRowRef` does not match any `rowId` in
 *     the file as a PER-ROW failure (`status: 'failed'`, with a
 *     `node.error` naming the unmatched value) -- Requirement 9.4. This
 *     is deliberately a per-row failure, recorded on the node itself,
 *     NOT a `wholeFileErrors` entry.
 *   - Propagates that failure transitively: a row whose resolved
 *     parent node is itself failed (whether dangling, transitively
 *     failed, or part of a detected cycle) is also marked failed --
 *     Requirement 9.12 -- computed as a graph-property fixed point,
 *     not by re-attempting row-by-row.
 *   - Marks every row that is part of a cycle detected by
 *     `detectCycles` (task 17.2) as failed too, so Kahn's algorithm
 *     below never considers a cyclic row a candidate (a cycle is also
 *     separately reported as a whole-file rejection; this per-node
 *     marking exists so `nodes`/`creationOrder` stay internally
 *     consistent even if a caller inspects them despite the whole-file
 *     rejection).
 *   - Computes `creationOrder`, a topological ordering (Kahn's
 *     algorithm) of every row that is NOT failed, so a
 *     `parentTeamName`/`parentTeamId`-rooted row (no in-file
 *     dependency) sorts before any `parentRowRef` chain that depends
 *     on it -- Requirement 9.6.
 *
 * Node keying: a row's `rowKey` is its own (trimmed) `rowId` when
 * present and non-empty, else a synthetic `` `__row_${index + 1}` ``
 * key derived from the row's 1-based position in `rows` (mirroring the
 * `rowNumber++` convention already used for error-reporting elsewhere
 * in this file). A row with no `rowId` still becomes a graph node --
 * it just cannot be referenced by any other row's `parentRowRef`.
 *
 * Whole-file rejections (Requirements 9.2, 9.5), both recorded as
 * entries in the returned `wholeFileErrors` array rather than as a
 * per-row failure, consistent with `design.md`'s Phase 1 description
 * (both are grouped there under "Rejects the WHOLE import if..."):
 *   - A non-empty `rowId` value that appears on more than one row (one
 *     `wholeFileErrors` entry per distinct duplicated value, naming
 *     that value, so multiple independently-duplicated values are all
 *     reported rather than only the first one found).
 *   - A row supplying both `parentRowRef` and `parentTeamName`/
 *     `parentTeamId` (one entry per offending row, naming that row's
 *     `rowKey`).
 *
 * Edge resolution (recorded per node, not yet validated/resolved
 * against anything -- later tasks own that):
 *   - `parentRowRef` present (and no combo violation on this row): the
 *     referenced value is recorded as-is on `resolvedParentKey`. This
 *     task does NOT check that the reference actually resolves to a
 *     node in `nodes` (task 17.3's dangling-reference job) or that it
 *     does not form a cycle (task 17.2's job).
 *   - `parentTeamName`/`parentTeamId` present (and no `parentRowRef`):
 *     this is NOT an in-file reference at all, so the raw value is
 *     recorded on `parentTeamNameRef`/`parentTeamIdRef` respectively
 *     (not `resolvedParentKey`) for a later pipeline step to resolve
 *     against the database. `resolvedParentTeamId` (named in
 *     `design.md`'s node shape) is left `undefined` here -- it is
 *     populated once that later DB lookup actually happens.
 *   - Neither present: this row has no in-file or existing-team parent
 *     at all. This is not an error -- it is a valid root/Organisation
 *     row.
 *
 * @param {Array<Record<string, string>>} rows - already-parsed CSV
 *   rows (e.g. via `csv-parse`'s `columns: true`), in file order. Row
 *   `i`'s 1-based position (`i + 1`) is used as its synthetic-key line
 *   number; callers do not need to attach a separate line-number field.
 * @returns {{
 *   nodes: Map<string, {
 *     row: Record<string, string>,
 *     resolvedParentKey: string|undefined,
 *     parentTeamNameRef: string|undefined,
 *     parentTeamIdRef: string|undefined,
 *     resolvedParentTeamId: number|undefined,
 *     teamId: number|undefined,
 *     status: string|undefined,
 *     error: string|undefined
 *   }>,
 *   wholeFileErrors: Array<{error: string, rowIds?: string[]}>,
 *   creationOrder: string[]
 * }}
 */
/**
 * Requirement 9.13 (design.md's Phase 1, task 17.2): detects every
 * cycle among `resolvedParentKey` edges (a directed child -> parent
 * edge, since a Team_Import_Row's `parentRowRef` names its PARENT) via
 * a standard three-colour (white/grey/black) DFS cycle detector.
 *
 * Every node in `nodes` has AT MOST one outgoing `resolvedParentKey`
 * edge, so the traversal below never branches -- each DFS root simply
 * walks its own parent chain, colouring nodes GREY as they're pushed
 * onto the in-progress path and BLACK once their single edge has been
 * fully examined. Re-encountering a GREY node means that node is still
 * on the current path (an ancestor-in-progress), i.e. a cycle.
 *
 * A `resolvedParentKey` that does not correspond to any node in `nodes`
 * at all (a dangling reference) is deliberately treated as a dead end
 * here, never an error -- it cannot be part of a cycle if it leads
 * nowhere, and task 17.3 independently flags it as a failed/dangling
 * row.
 *
 * @param {Map<string, {resolvedParentKey: string|undefined}>} nodes
 * @returns {string[][]} one array of rowKeys per DISTINCT cycle found,
 *   each ordered starting at the point the cycle was first closed (the
 *   earliest-pushed member of the cycle) through to the node whose edge
 *   closed it. Every node belongs to at most one returned cycle -- once
 *   a node has been attributed to a reported cycle, it is never
 *   re-reported as part of another (a node cannot be a member of two
 *   distinct cycles anyway, since it has only one outgoing edge, but a
 *   node's cycle is nonetheless only ever surfaced once even though
 *   every node is eventually visited as its own DFS root candidate).
 */
function detectCycles(nodes) {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const key of nodes.keys()) {
    color.set(key, WHITE);
  }

  const cycles = [];

  for (const startKey of nodes.keys()) {
    if (color.get(startKey) !== WHITE) {
      continue;
    }

    // Iterative walk of this node's own parent chain (never branches,
    // since every node has at most one outgoing edge). `stack` holds
    // the current in-progress path, root-first.
    const stack = [startKey];
    color.set(startKey, GREY);

    while (stack.length > 0) {
      const currentKey = stack[stack.length - 1];
      const node = nodes.get(currentKey);
      const parentKey = node?.resolvedParentKey;

      if (parentKey === undefined || !nodes.has(parentKey)) {
        // Dead end: no parent reference, or a dangling reference not
        // present in this file at all -- not this task's concern.
        color.set(currentKey, BLACK);
        stack.pop();
        continue;
      }

      const parentColor = color.get(parentKey);
      if (parentColor === WHITE) {
        color.set(parentKey, GREY);
        stack.push(parentKey);
      } else if (parentColor === GREY) {
        // parentKey is still on the current path -> cycle. Collect
        // every node from parentKey's position in `stack` through to
        // currentKey (inclusive) as this cycle's members.
        const cycleStartIndex = stack.indexOf(parentKey);
        cycles.push(stack.slice(cycleStartIndex));
        color.set(currentKey, BLACK);
        stack.pop();
      } else {
        // parentColor === BLACK: already fully explored via another
        // path -- no (new) cycle through this edge.
        color.set(currentKey, BLACK);
        stack.pop();
      }
    }
  }

  return cycles;
}

/**
 * Requirements 9.4, 9.6, 9.12 (design.md's Phase 1, task 17.3): given a
 * graph's `nodes` map and the list of cycles already detected by
 * `detectCycles` (task 17.2), this function mutates `nodes` in place --
 *   1. marking every node that participates in a detected cycle as
 *      `status: 'failed'` (a cycle has no valid resolution for its own
 *      members; see design.md's note that this keeps Kahn's algorithm
 *      below from ever attempting to process a cyclic node, since a
 *      cycle's members can never reach in-degree 0 on their own),
 *   2. marking every node with a `resolvedParentKey` that does not
 *      correspond to any node in `nodes` at all as `status: 'failed'`
 *      (a dangling `parentRowRef`, Requirement 9.4), and
 *   3. propagating failure transitively to fixed point: any node whose
 *      `resolvedParentKey` points at a node that is ITSELF failed (for
 *      any reason -- dangling, transitively failed, or cyclic) is also
 *      marked failed (Requirement 9.12). Because a chain can be
 *      arbitrarily long, this repeats until a full pass makes no
 *      further change.
 *
 * -- then computes and returns `creationOrder`: a topological ordering
 * (Kahn's algorithm) of every node that is NOT failed. A node with no
 * `resolvedParentKey` at all (a root row, or a row referencing an
 * existing team via `parentTeamName`/`parentTeamId` -- neither of
 * which is an in-file dependency) has in-degree 0 and therefore always
 * sorts before any `parentRowRef` chain that depends on it, per
 * Requirement 9.6.
 *
 * @param {Map<string, {resolvedParentKey: string|undefined, status: string|undefined, error: string|undefined}>} nodes
 * @param {string[][]} cycles - the result of `detectCycles(nodes)`.
 * @returns {string[]} `creationOrder`, the topologically sorted rowKeys
 *   of every non-failed node.
 */
function markFailedRowsAndComputeCreationOrder(nodes, cycles) {
  // --- Step 1: every row on a detected cycle has no valid resolution
  // for itself, regardless of the separate whole-file cycle rejection.
  for (const cycleKeys of cycles) {
    for (const key of cycleKeys) {
      const node = nodes.get(key);
      node.status = 'failed';
      node.error = 'row is part of a parentRowRef cycle';
    }
  }

  // --- Step 2: a resolvedParentKey that does not resolve to any node
  // in this file at all is a dangling parentRowRef (Requirement 9.4).
  for (const node of nodes.values()) {
    if (node.status === 'failed') {
      continue;
    }
    if (node.resolvedParentKey !== undefined && !nodes.has(node.resolvedParentKey)) {
      node.status = 'failed';
      node.error = `parentRowRef does not match any rowId in the file: ${node.resolvedParentKey}`;
    }
  }

  // --- Step 3: propagate failure to fixed point (Requirement 9.12).
  // A node whose resolvedParentKey points at an existing-but-failed
  // node is itself failed, for an arbitrarily long chain -- repeat
  // until a full pass makes no further change.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes.values()) {
      if (node.status === 'failed') {
        continue;
      }
      const parentKey = node.resolvedParentKey;
      if (parentKey === undefined) {
        continue;
      }
      const parentNode = nodes.get(parentKey);
      if (parentNode && parentNode.status === 'failed') {
        node.status = 'failed';
        node.error = `parent row failed: ${parentKey}`;
        changed = true;
      }
    }
  }

  // --- Kahn's algorithm over every non-failed node. In-degree counts
  // only an edge to another non-failed node in this file (a failed
  // parent's dependents are already excluded by Step 3 above, and a
  // parentTeamName/parentTeamId reference is never an in-file edge at
  // all, so those rows start at in-degree 0 and sort first). ---
  const inDegree = new Map();
  const dependents = new Map(); // parentKey -> [childKey, ...]

  for (const [key, node] of nodes.entries()) {
    if (node.status === 'failed') {
      continue;
    }
    const parentKey = node.resolvedParentKey;
    const hasLiveParentEdge = parentKey !== undefined && nodes.has(parentKey)
      && nodes.get(parentKey).status !== 'failed';
    inDegree.set(key, hasLiveParentEdge ? 1 : 0);
    if (hasLiveParentEdge) {
      if (!dependents.has(parentKey)) {
        dependents.set(parentKey, []);
      }
      dependents.get(parentKey).push(key);
    }
  }

  const queue = [];
  for (const [key, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(key);
    }
  }

  const creationOrder = [];
  while (queue.length > 0) {
    const key = queue.shift();
    creationOrder.push(key);
    const children = dependents.get(key) || [];
    for (const childKey of children) {
      const remaining = inDegree.get(childKey) - 1;
      inDegree.set(childKey, remaining);
      if (remaining === 0) {
        queue.push(childKey);
      }
    }
  }

  return creationOrder;
}

function buildImportGraph(rows) {
  const wholeFileErrors = [];

  // --- Pass 1: count every non-empty rowId value across the whole
  // file, so a value duplicated 3+ times is still reported once (naming
  // that value), and multiple distinct duplicated values are each
  // reported (Requirement 9.2). ---
  const rowIdCounts = new Map();
  rows.forEach((row) => {
    const rowId = readOptionalField(row, 'rowId');
    if (rowId !== '') {
      rowIdCounts.set(rowId, (rowIdCounts.get(rowId) || 0) + 1);
    }
  });
  for (const [rowId, count] of rowIdCounts.entries()) {
    if (count > 1) {
      wholeFileErrors.push({ error: `Duplicate rowId: ${rowId}`, rowIds: [rowId] });
    }
  }

  // --- Pass 2: build one node per row, keyed by rowId (else a
  // synthetic __row_N key), resolving each row's parent reference and
  // flagging any parentRowRef + parentTeamName/parentTeamId combo
  // violation (Requirement 9.5) as it goes. ---
  const nodes = new Map();
  rows.forEach((row, index) => {
    const rowId = readOptionalField(row, 'rowId');
    const rowKey = rowId !== '' ? rowId : `__row_${index + 1}`;

    const parentRowRef = readOptionalField(row, 'parentRowRef');
    const parentTeamName = readOptionalField(row, 'parentTeamName');
    const parentTeamId = readOptionalField(row, 'parentTeamId');

    const hasParentRowRef = parentRowRef !== '';
    const hasExistingTeamRef = parentTeamName !== '' || parentTeamId !== '';

    if (hasParentRowRef && hasExistingTeamRef) {
      wholeFileErrors.push({
        error: `Row ${rowKey} supplies both parentRowRef and parentTeamName/parentTeamId; only one parent-reference method may be used per row`,
        rowIds: [rowKey]
      });
    }

    const node = {
      row,
      resolvedParentKey: undefined,
      parentTeamNameRef: undefined,
      parentTeamIdRef: undefined,
      resolvedParentTeamId: undefined,
      teamId: undefined,
      status: undefined
    };

    if (hasParentRowRef && !hasExistingTeamRef) {
      node.resolvedParentKey = parentRowRef;
    } else if (!hasParentRowRef && hasExistingTeamRef) {
      if (parentTeamId !== '') {
        node.parentTeamIdRef = parentTeamId;
      } else {
        node.parentTeamNameRef = parentTeamName;
      }
    }
    // else: neither reference is present (valid root row), or both are
    // present (already flagged above as a whole-file error) -- either
    // way, no parent reference is recorded on the node.

    nodes.set(rowKey, node);
  });

  // --- Pass 3: cycle detection over resolvedParentKey edges
  // (Requirement 9.13). Runs regardless of whether passes 1-2 already
  // found whole-file errors, so a single buildImportGraph call surfaces
  // every whole-file problem in one pass over the file. Since every
  // node has at most one outgoing resolvedParentKey edge, distinct
  // cycles never share a member, so no separate de-duplication step is
  // needed beyond detectCycles' own BLACK-marking. ---
  const cycles = detectCycles(nodes);
  for (const cycleKeys of cycles) {
    wholeFileErrors.push({
      error: `Cycle detected among parentRowRef references: ${cycleKeys.join(' -> ')} -> ${cycleKeys[0]}`,
      rowIds: cycleKeys
    });
  }

  // --- Pass 4 (task 17.3): mark dangling-reference/transitively-failed/
  // cyclic rows as failed, and compute a topological creationOrder of
  // every row that survives (Requirements 9.4, 9.6, 9.12). ---
  const creationOrder = markFailedRowsAndComputeCreationOrder(nodes, cycles);

  return { nodes, wholeFileErrors, creationOrder };
}

function getRequiredField(row, field) {
  const value = row[field];
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new BulkImportRowError(`Missing required field: ${field}`);
  }
  return String(value).trim();
}

function parseRowTeamId(row) {
  const raw = row.teamId;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new BulkImportRowError('Missing required field: teamId');
  }
  const teamId = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    throw new BulkImportRowError(`Invalid teamId: ${raw}`);
  }
  return teamId;
}

/**
 * Requirement 9.7 (task 18.2): reads a Team_Import_Row's optional
 * `visibility` column, defaulting to `'public'` when omitted/empty --
 * consistent with Requirement 9.7's explicit CSV-import-specific
 * default, which differs from `POST /api/teams`'s own direct-creation
 * default of `'private'` (two independently specified defaults, not
 * required to match). Accepts only `'public'`/`'private'` when a
 * non-empty value is supplied; any other value fails this row alone
 * (not the whole batch), mirroring `getRequiredField`/`parseRowTeamId`'s
 * existing validate-then-throw pattern.
 *
 * @param {Record<string, string>} row
 * @returns {'public'|'private'}
 * @throws {BulkImportRowError} if a non-empty, non-`public`/`private`
 *   value is supplied.
 */
function parseRowVisibility(row) {
  const value = readOptionalField(row, 'visibility');
  if (value === '') {
    return 'public';
  }
  if (value !== 'public' && value !== 'private') {
    throw new BulkImportRowError(`Invalid visibility: ${value}`);
  }
  return value;
}

/**
 * Requirement 9.8 (task 18.2): reads a Team_Import_Row's optional
 * `callsignPrefix` column, defaulting to `null` when omitted/empty.
 * Validated via the SAME character-class rule used by the direct
 * single-team-creation API (`isValidCallsignPrefix`, task 6.5) -- an
 * invalid value fails this row alone, naming the disallowed value,
 * mirroring Requirement 3.9's row-level rejection style.
 *
 * @param {Record<string, string>} row
 * @returns {string|null}
 * @throws {BulkImportRowError} if the value contains a character other
 *   than a letter or digit.
 */
function parseRowCallsignPrefix(row) {
  const value = readOptionalField(row, 'callsignPrefix');
  if (value === '') {
    return null;
  }
  if (!isValidCallsignPrefix(value)) {
    throw new BulkImportRowError(`Invalid callsignPrefix: ${value} (letters and digits only)`);
  }
  return value;
}

class BulkImportService {
  /**
   * Requirement 29.2-29.4, 29.6 (task 51.1): streams a user-import CSV
   * (`csv-parse`, one row at a time -- memory-safe for large files, per
   * `design.md`) and, for every row: authorizes it (`Team.isAdmin(row
   * .teamId, importingUser) OR importingUser.is_global_manager`),
   * applies the same creation/inheritance/channel-assignment logic
   * already used by `POST /api/users/create-and-add` via
   * `UserProvisioningService.createAndAddUser`, and wraps that row's
   * local database writes in their OWN transaction on their OWN
   * acquired client -- so a failure processing one row (missing field,
   * Authentik creation failure, DB constraint violation, insufficient
   * authorization) rolls back only that row's partial writes and never
   * aborts or rolls back any other row's already-committed work.
   *
   * Rows are processed sequentially, in CSV order, so error attribution
   * (`row: n`) is unambiguous and deterministic; nothing about this
   * requirement calls for concurrent row processing.
   *
   * @param {Buffer|string} csvBuffer - the raw CSV file contents.
   * @param {{userId?: number, is_global_manager?: boolean}} importingUser
   * @returns {Promise<{successCount: number, failureCount: number, results: Array<{row: number, success: boolean, userId?: number, error?: string}>}>}
   */
  static async importUsers(csvBuffer, importingUser) {
    const results = [];
    let successCount = 0;
    let failureCount = 0;
    let rowNumber = 0;

    const parser = parse(csvBuffer, { columns: true, trim: true, skip_empty_lines: true });

    for await (const row of parser) {
      rowNumber++;
      try {
        const outcome = await BulkImportService.importUserRow(row, importingUser);
        results.push({ row: rowNumber, success: true, userId: outcome.localUserId });
        successCount++;
      } catch (error) {
        logger.error(
          { err: error, row: rowNumber },
          'CSV user import row failed; continuing with remaining rows'
        );
        results.push({ row: rowNumber, success: false, error: error.message });
        failureCount++;
      }
    }

    return { successCount, failureCount, results };
  }

  /**
   * Requirements 9.6, 9.7, 9.9, 9.10, 9.11 (design.md's two-phase CSV
   * team-import pipeline, task 18.1): parses the WHOLE file up front
   * (Phase 0), builds and validates the in-memory dependency graph via
   * `buildImportGraph` (Phase 1, tasks 17.1-17.3), and -- unless the
   * whole file was rejected -- creates every non-failed row via
   * `Team.create`, in topological (parent-before-child) order (Phase 2),
   * reusing `Team.create`'s own Max_Team_Depth (task 5.1) and
   * Organisation-only-field (task 6.1) enforcement unchanged.
   *
   * Unlike `importUsers`, whose per-row authorization lets a team admin
   * import users into team(s) they administer, team import is
   * Global_Manager-only for the ENTIRE batch: creating an arbitrary new
   * team (possibly a new root team) isn't scoped to any single team an
   * admin might administer. That check runs once, up front, before the
   * CSV is even parsed -- an unauthorized caller's request is rejected
   * outright rather than recorded as N per-row failures.
   *
   * @param {Buffer|string} csvBuffer - the raw CSV file contents.
   * @param {{userId?: number, is_global_manager?: boolean}} importingUser
   * @returns {Promise<{successCount: number, failureCount: number, results: Array<Object>, rejected?: boolean}>}
   *   On a whole-file rejection (duplicate `rowId`, or a `parentRowRef`
   *   cycle -- Requirement 9.2/9.13), `results` is instead the raw
   *   `wholeFileErrors` array (`{error, rowIds?}` shaped entries) and
   *   `rejected: true` is set, distinguishing this response shape from
   *   the normal per-row-results shape. No team is ever created in that
   *   case.
   * @throws {BulkImportAuthorizationError} if `importingUser` is not a
   *   Global_Manager.
   */
  static async importTeams(csvBuffer, importingUser) {
    if (!importingUser?.is_global_manager) {
      throw new BulkImportAuthorizationError();
    }

    // --- Phase 0: parse the WHOLE file into memory before any
    // validation or creation, since buildImportGraph needs every row up
    // front to detect duplicate rowIds/cycles/dangling references
    // (Requirement 9.6). ---
    const rows = [];
    const parser = parse(csvBuffer, { columns: true, trim: true, skip_empty_lines: true });
    for await (const row of parser) {
      rows.push(row);
    }

    // --- Phase 1: build+validate the in-memory dependency graph. ---
    const graph = buildImportGraph(rows);

    if (graph.wholeFileErrors.length > 0) {
      return {
        successCount: 0,
        failureCount: rows.length,
        results: graph.wholeFileErrors,
        rejected: true
      };
    }

    // --- Phase 2: create every non-failed row via Team.create, in
    // topological order, then assemble the final per-row results array
    // in ORIGINAL file order (Requirement 9.6/9.7/9.9/9.10/9.11). ---
    return await BulkImportService.createRowsInOrder(rows, graph, importingUser);
  }

  /**
   * Requirements 9.7, 9.9, 9.10, 9.11 (design.md's Phase 2, task 18.1):
   * given the whole file's already-parsed `rows` and the graph built
   * from them by `buildImportGraph` (whose `wholeFileErrors` are already
   * known to be empty by the time this is called), creates every
   * non-failed node's Team via `Team.create`, walking `graph.
   * creationOrder` so every parent is created before any child that
   * references it via `parentRowRef` -- reusing `Team.create`'s own
   * Max_Team_Depth and Organisation-only-field enforcement unchanged, so
   * this pipeline cannot drift from the single-team-creation API's
   * rules.
   *
   * Each node's actual parent team id is resolved just before its own
   * `Team.create` call:
   *   - `resolvedParentKey` (an in-file `parentRowRef`): read from that
   *     ancestor node's own `teamId`, already populated earlier in this
   *     same topologically-ordered loop.
   *   - `parentTeamNameRef` (`parentTeamName` column): looked up against
   *     the existing database by exact name (identical to the old
   *     `resolveParentTeamId`'s `parentTeamName` branch).
   *   - `parentTeamIdRef` (`parentTeamId` column): parsed/validated as a
   *     positive integer directly, no DB lookup (identical to the old
   *     `resolveParentTeamId`'s `parentTeamId` branch).
   *   - Neither: `parent_team_id` is `null` (root Organisation).
   *
   * A node with `status === 'failed'` (dangling reference, transitive
   * failure, or cyclic -- already excluded from `creationOrder` by
   * `buildImportGraph`) is never passed to `Team.create`; its `node.
   * error` is used directly as its final result's error message.
   *
   * The final `results` array is assembled in ORIGINAL file order (not
   * creation order), matching `importUsers`'/the old `importTeams`'s
   * convention that `results[i]` corresponds to `rows[i]`.
   *
   * @param {Array<Record<string, string>>} rows - every parsed CSV row,
   *   in original file order.
   * @param {{nodes: Map<string, Object>, creationOrder: string[]}} graph
   *   - the result of `buildImportGraph(rows)`.
   * @param {{userId?: number, is_global_manager?: boolean}} importingUser
   * @returns {Promise<{successCount: number, failureCount: number, results: Array<{row: number, success: boolean, teamId?: number, error?: string}>}>}
   */
  static async createRowsInOrder(rows, graph, importingUser) {
    // rowKey -> {success, teamId} | {success: false, error}
    const outcomeByRowKey = new Map();

    for (const rowKey of graph.creationOrder) {
      const node = graph.nodes.get(rowKey);
      try {
        const name = getRequiredField(node.row, 'name');
        const parentTeamId = await BulkImportService.resolveNodeParentTeamId(node, graph);
        const visibility = parseRowVisibility(node.row);
        const callsignPrefix = parseRowCallsignPrefix(node.row);

        // Requirement 9.7-9.11: `Team.create` is called exactly as the
        // single-team-creation API would, so Max_Team_Depth and
        // Organisation-only-field enforcement apply identically.
        // `visibility` (Requirement 9.7, defaulting to 'public') and
        // `callsign_prefix` (Requirement 9.8, character-class-validated
        // via `isValidCallsignPrefix`) are read from this row's own
        // `visibility`/`callsignPrefix` columns above; a validation
        // failure on either throws a `BulkImportRowError` caught by
        // this loop's own try/catch, failing only this row.
        const team = await Team.create({
          name,
          description: null,
          callsign_prefix: callsignPrefix,
          color: '#3B82F6',
          visibility,
          can_join: false,
          parent_team_id: parentTeamId,
          created_by: importingUser?.userId ?? null
        });

        // Record the created team's id back onto this node so any
        // dependent row later in creationOrder can resolve its actual
        // parent id via resolvedParentKey.
        node.teamId = team.id;
        outcomeByRowKey.set(rowKey, { success: true, teamId: team.id });
      } catch (error) {
        logger.error(
          { err: error, rowKey },
          'CSV team import row failed; continuing with remaining rows'
        );
        outcomeByRowKey.set(rowKey, { success: false, error: error.message });
      }
    }

    // A node with status === 'failed' was never in creationOrder at all
    // (dangling reference / transitive failure / cyclic) -- record its
    // failure here using node.error, without ever attempting Team.create.
    for (const [rowKey, node] of graph.nodes.entries()) {
      if (node.status === 'failed') {
        outcomeByRowKey.set(rowKey, { success: false, error: node.error });
      }
    }

    // Assemble the final results array in ORIGINAL file order.
    const results = [];
    let successCount = 0;
    let failureCount = 0;
    rows.forEach((row, index) => {
      const rowId = readOptionalField(row, 'rowId');
      const rowKey = rowId !== '' ? rowId : `__row_${index + 1}`;
      const outcome = outcomeByRowKey.get(rowKey);
      if (outcome.success) {
        results.push({ row: index + 1, success: true, teamId: outcome.teamId });
        successCount++;
      } else {
        results.push({ row: index + 1, success: false, error: outcome.error });
        failureCount++;
      }
    });

    return { successCount, failureCount, results };
  }

  /**
   * Resolves a single graph node's actual parent team id, just before
   * that node's own `Team.create` call (task 18.1's per-row parent
   * resolution step).
   *
   * @param {Object} node - the node from `graph.nodes`, as built by
   *   `buildImportGraph`.
   * @param {{nodes: Map<string, Object>}} graph
   * @returns {Promise<number|null>}
   * @throws {BulkImportRowError} if `parentTeamIdRef` is not a positive
   *   integer, or if `parentTeamNameRef` does not match any existing
   *   team.
   */
  static async resolveNodeParentTeamId(node, graph) {
    if (node.resolvedParentKey !== undefined) {
      // Topological order guarantees the referenced ancestor node was
      // already processed (and its teamId recorded) earlier in this
      // same loop.
      const parentNode = graph.nodes.get(node.resolvedParentKey);
      return parentNode.teamId;
    }

    if (node.parentTeamIdRef !== undefined) {
      const parentTeamId = Number.parseInt(node.parentTeamIdRef, 10);
      if (!Number.isInteger(parentTeamId) || parentTeamId <= 0) {
        throw new BulkImportRowError(`Invalid parentTeamId: ${node.parentTeamIdRef}`);
      }
      return parentTeamId;
    }

    if (node.parentTeamNameRef !== undefined) {
      const result = await pool.query('SELECT id FROM teams WHERE name = $1', [node.parentTeamNameRef]);
      const parentTeam = result.rows[0];
      if (!parentTeam) {
        throw new BulkImportRowError(`Parent team not found: ${node.parentTeamNameRef}`);
      }
      return parentTeam.id;
    }

    return null;
  }

  /**
   * Processes a single CSV row: authorization first, then Authentik
   * user creation (no open DB transaction), then every local write for
   * this row inside its own `BEGIN`/`COMMIT`-or-`ROLLBACK` transaction
   * on one acquired client, delegating to the same
   * `UserProvisioningService.createAndAddUser` used by
   * `POST /api/users/create-and-add`.
   *
   * @param {Record<string, string>} row - a parsed CSV row, keyed by
   *   header name (`email`, `firstName`, `lastName`, `teamId`, and an
   *   optional `username`).
   * @param {{userId?: number, is_global_manager?: boolean}} importingUser
   * @returns {Promise<{localUserId: number, queuedGroups: number}>}
   * @throws {BulkImportRowError} on missing/invalid fields or
   *   insufficient per-row authorization.
   */
  static async importUserRow(row, importingUser) {
    const teamId = parseRowTeamId(row);

    // Requirement 29.3-29.4: per-row authorization, checked before any
    // Authentik API call or database write for this row. A team admin
    // may only import into team(s) they administer; a Global_Manager
    // may import into any team.
    const isGlobalManager = Boolean(importingUser?.is_global_manager);
    if (!isGlobalManager) {
      const isAdmin = await Team.isAdmin(teamId, importingUser?.userId);
      if (!isAdmin) {
        throw new BulkImportRowError(`Unauthorized: importing user does not administer team ${teamId}`);
      }
    }

    const email = getRequiredField(row, 'email');
    const firstName = getRequiredField(row, 'firstName');
    const lastName = getRequiredField(row, 'lastName');
    const requestedUsername = (row.username && String(row.username).trim()) || email.split('@')[0];
    // Requirement 11.6, 11.7, 11.14 (task 22.2): optional callsignSuffix
    // CSV column, read via the same readOptionalField helper already
    // used for visibility/callsignPrefix (task 18.2).
    const requestedCallsignSuffix = readOptionalField(row, 'callsignSuffix') || undefined;

    // takserver-enrollment Requirements 6.3, 6.6, 6.8 (task 5.3):
    // resolve the username AND the callsign_suffix default together via
    // the single Phase-0 choke point, BEFORE Phase 1's Authentik call --
    // the same "avoid orphaning an Authentik user for a
    // request-validation failure" reasoning as the two route entry
    // points. `requestedUsername` is the existing `row.username ||
    // email.split('@')[0]` derivation, passed IN rather than used
    // directly, so a Pseudonymous_Organisation can override it with a
    // minted Pseudonymous_Username. Under a policy-disabled
    // Organisation the resolver returns it verbatim (Criterion 6.8).
    // A thrown CallsignSuffixRequiredError/CallsignSuffixConflictError/
    // OrganisationPrefixMissingError/ManagedIdentifierExhaustionError
    // here propagates naturally out of this function and is caught by
    // importUsers's existing per-row try/catch, recording it as this
    // row's own failure (via `error.message`) without affecting any
    // other row.
    const identity = await UserProvisioningService.resolveNewUserIdentity(null, {
      firstName,
      lastName,
      email,
      teamId,
      requestedUsername,
      requestedCallsignSuffix
    });
    const { username, callsignSuffix: resolvedCallsignSuffix, claimId } = identity;

    // --- Phase 1: Authentik user creation (no open DB transaction, per
    // the same "an external HTTP call must never be issued from inside
    // an open DB transaction" phasing established by
    // `UserProvisioningService.createAndAddUser`'s callers). Uses the
    // RESOLVED username, not the raw CSV-derived one. ---
    const authentikUser = await authentikService.createUser({
      username,
      name: `${firstName} ${lastName}`,
      email
    });

    // --- Phase 2: one transaction, on one acquired client, scoped to
    // THIS row only (Requirement 29.2: one row's failure rolls back
    // only that row's partial writes, never any other row's). ---
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await UserProvisioningService.createAndAddUser(client, {
        authentikUserId: authentikUser.pk,
        username,
        email,
        firstName,
        lastName,
        teamId,
        callsign_suffix: resolvedCallsignSuffix,
        createdBy: importingUser?.userId ?? null,
        // takserver-enrollment Requirement 6.6 (task 5.3): when the
        // target Organisation is pseudonymous, `claimId` names the
        // Claim_Row `resolveNewUserIdentity` already inserted under
        // `username` above -- adopted instead of the generic upsert.
        // `undefined` for a policy-disabled Organisation.
        claimId
      });

      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(
        { err: error, authentikUserId: authentikUser.pk, teamId },
        'Failed to provision CSV-imported user locally after Authentik user creation; row rolled back'
      );
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = BulkImportService;
module.exports.BulkImportRowError = BulkImportRowError;
module.exports.BulkImportAuthorizationError = BulkImportAuthorizationError;
module.exports.buildImportGraph = buildImportGraph;
