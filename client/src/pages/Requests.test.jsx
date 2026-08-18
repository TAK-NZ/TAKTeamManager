import { describe, it, expect } from 'vitest';
import { getInitialCallsignSuffixMap, extractCallsignSuffixConflictError } from './Requests.jsx';

// Validates: Requirements 11.11, 11.12, 11.17
//
// Requests.jsx renders an editable "Callsign Suffix" field per pending
// request, pre-filled from GET /api/requests/pending's `effective_callsign_suffix`
// field (Req 11.11/11.12), and surfaces a POST .../approve 400 collision
// inline instead of only a generic toast (Req 11.17). No component-render
// test harness (e.g. @testing-library/react) is set up in this project --
// see src/services/api.test.js and src/utils/channelTree.test.js, which
// both test extracted pure logic rather than rendering a component -- so
// this file follows that same convention and tests the pure helpers
// Requests.jsx uses to compute its pre-fill and inline-error state.

describe('getInitialCallsignSuffixMap', () => {
  it('pre-fills from effective_callsign_suffix when present (Req 11.12: request submitted its own value)', () => {
    const requests = [
      { id: 1, effective_callsign_suffix: 'Smith-J' },
      { id: 2, effective_callsign_suffix: 'JDoe' }
    ];

    expect(getInitialCallsignSuffixMap(requests)).toEqual({ 1: 'Smith-J', 2: 'JDoe' });
  });

  it('pre-fills from the server-computed default when effective_callsign_suffix is present but computed (Req 11.11: non-user_defined format)', () => {
    // The server computes this the same way regardless of source (task
    // 24.2) -- from the Client's perspective there is only ever a single
    // `effective_callsign_suffix` field to pre-fill from, whether it came
    // from the request's own submission or the server-computed default.
    const requests = [{ id: 3, effective_callsign_suffix: 'JohnDoe' }];

    expect(getInitialCallsignSuffixMap(requests)).toEqual({ 3: 'JohnDoe' });
  });

  it('falls back to an empty string when effective_callsign_suffix is absent/null', () => {
    const requests = [{ id: 4, effective_callsign_suffix: null }, { id: 5 }];

    expect(getInitialCallsignSuffixMap(requests)).toEqual({ 4: '', 5: '' });
  });

  it('handles an empty requests list', () => {
    expect(getInitialCallsignSuffixMap([])).toEqual({});
  });
});

describe('extractCallsignSuffixConflictError', () => {
  it('extracts the conflicting-value message from a shaped 400 response (Req 11.17)', () => {
    const error = {
      response: {
        status: 400,
        data: { error: 'callsign_suffix "Smith-J" is already in use within this Team' }
      }
    };

    expect(extractCallsignSuffixConflictError(error)).toBe(
      'callsign_suffix "Smith-J" is already in use within this Team'
    );
  });

  it('returns null for a non-400 failure (e.g. 500), deferring to the generic toast', () => {
    const error = { response: { status: 500, data: { error: 'Failed to approve request' } } };

    expect(extractCallsignSuffixConflictError(error)).toBeNull();
  });

  it('returns null for a 400 response with no string error body', () => {
    const error = { response: { status: 400, data: {} } };

    expect(extractCallsignSuffixConflictError(error)).toBeNull();
  });

  it('returns null when the error has no response at all (e.g. a network error)', () => {
    expect(extractCallsignSuffixConflictError(new Error('Network Error'))).toBeNull();
  });
});
