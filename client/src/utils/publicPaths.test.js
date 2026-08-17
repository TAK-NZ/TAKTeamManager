import { describe, it, expect } from 'vitest';
import { PUBLIC_ONLY_PATHS, isPublicOnlyPath } from './publicPaths.js';

// Regression coverage for the /request-access <-> /login redirect loop:
// App.jsx's mount-time GET /auth/me check and services/api.js's 401
// response interceptor both consult this shared list so a completely
// anonymous visitor can actually load these pages instead of being
// force-navigated to /login and looping forever.
describe('isPublicOnlyPath', () => {
  it('treats /request-access as a public-only path', () => {
    expect(isPublicOnlyPath('/request-access')).toBe(true);
  });

  it('treats /verify-request as a public-only path', () => {
    expect(isPublicOnlyPath('/verify-request')).toBe(true);
  });

  it('does not treat /login as a public-only path (a 401 there is expected/normal, not looped)', () => {
    expect(isPublicOnlyPath('/login')).toBe(false);
  });

  it('does not treat an authenticated page (e.g. /dashboard) as a public-only path', () => {
    expect(isPublicOnlyPath('/dashboard')).toBe(false);
  });

  it('does not match a path that merely starts with a public-only prefix', () => {
    // Exact-match only, not a prefix check -- a sub-path should still be
    // gated normally rather than silently treated as public.
    expect(isPublicOnlyPath('/request-access/extra')).toBe(false);
  });

  it('PUBLIC_ONLY_PATHS exposes exactly the two intentionally-public routes', () => {
    expect(PUBLIC_ONLY_PATHS).toEqual(['/request-access', '/verify-request']);
  });
});
