import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// /global-channels keeps its channel lists current on the shared
// visibility-paused 60s interval (`startVisibilityPausedRefresh`, the same
// mechanism the Dashboard/Admin cards and the Teams overview use), but PAUSES
// while any of the page's dialogs is open -- several of which hold transient
// or secret state (notably the BCH credentials dialog) that a background
// refetch must not disrupt -- mirroring the Dashboard's open-dialog guard.
// Local UI state (expanded folders, search) is derived in-component and NOT
// re-seeded from the fetch, so it survives a refresh untouched; only the
// underlying list data is replaced, and a failed refresh leaves the last-good
// lists on screen (no toast, no cleared list).
//
// This project has no @testing-library/react (see Teams.test.jsx,
// TeamDetail.test.jsx, channelTree.test.js, which all test pure logic or the
// component source text rather than rendering a component). The rendered tree
// already has its own dedicated guard (channelTreeContrast.test.jsx); this
// file follows the source-contract convention to assert the auto-refresh
// wiring, which is not observable from that contrast guard.
describe('GlobalChannels.jsx auto-refreshes on the visibility-paused interval, paused while a dialog is open', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'GlobalChannels.jsx'), 'utf8');

  it('imports the shared startVisibilityPausedRefresh helper', () => {
    expect(source).toContain("import { startVisibilityPausedRefresh } from '../utils/visibilityPausedRefresh'");
  });

  it('wires refreshChannels into a startVisibilityPausedRefresh effect', () => {
    expect(source).toContain('startVisibilityPausedRefresh(refreshChannels)');
    // The effect returns the teardown directly so no timer/listener survives
    // the component.
    expect(source).toContain('useEffect(() => startVisibilityPausedRefresh(refreshChannels), [refreshChannels])');
  });

  it('refreshChannels re-fetches both channel lists and replaces them via their setters', () => {
    const refreshStart = source.indexOf('const refreshChannels = useCallback(');
    expect(refreshStart, 'refreshChannels should exist').toBeGreaterThan(-1);
    const refreshBlock = source.slice(refreshStart, source.indexOf('useEffect(() => startVisibilityPausedRefresh', refreshStart));
    expect(refreshBlock).toContain('globalChannelsAPI.getBchChannels()');
    expect(refreshBlock).toContain('globalChannelsAPI.getRegionChannels()');
    expect(refreshBlock).toContain('setBchChannels(');
    expect(refreshBlock).toContain('setRegionChannels(');
  });

  it('does not toast or clear the lists on a failed background refresh (only logs)', () => {
    const refreshStart = source.indexOf('const refreshChannels = useCallback(');
    const refreshBlock = source.slice(refreshStart, source.indexOf('useEffect(() => startVisibilityPausedRefresh', refreshStart));
    // The catch branch logs and does nothing else -- no toast, no setter that
    // would blank a rendered list. Bound the slice to the catch's own braces
    // so nothing after refreshChannels leaks into the assertion.
    const catchIndex = refreshBlock.indexOf('} catch');
    const catchBlock = refreshBlock.slice(catchIndex, refreshBlock.indexOf('}, []'));
    expect(catchBlock).toContain('console.error');
    // No toast CALL (the explanatory comment legitimately contains the word
    // "toast", so match the call forms, not the bare word).
    expect(catchBlock).not.toContain('toast.error');
    expect(catchBlock).not.toContain('toast(');
    expect(catchBlock).not.toContain('setBchChannels(');
    expect(catchBlock).not.toContain('setRegionChannels(');
  });

  it('guards the refresh behind an open-dialog ref covering every dialog on the page', () => {
    expect(source).toContain('const dialogOpenRef = useRef(false)');

    // Every dialog/modal/confirmation that can be open must pause the refresh:
    // a background refetch underneath any of them (especially the credentials
    // dialog's transient secret state) is the disruption the guard prevents.
    const refIndex = source.indexOf('dialogOpenRef.current =');
    expect(refIndex, 'dialogOpenRef should be assigned from the open-dialog state').toBeGreaterThan(-1);
    const refAssignment = source.slice(refIndex, source.indexOf(';', refIndex));
    for (const flag of [
      'showCreateModal',
      'showEditModal',
      'deleteChannel !== null',
      'showAssignDialog',
      'showSeedDialog',
      'credentialsDialog !== null',
      'addServiceAccountChannel !== null',
      'serviceAccountAction !== null'
    ]) {
      expect(refAssignment, `dialogOpenRef should cover ${flag}`).toContain(flag);
    }
  });

  it('refreshChannels bails out early when a dialog is open, before fetching', () => {
    const refreshStart = source.indexOf('const refreshChannels = useCallback(');
    const refreshBlock = source.slice(refreshStart, source.indexOf('useEffect(() => startVisibilityPausedRefresh', refreshStart));
    const guardIndex = refreshBlock.indexOf('if (dialogOpenRef.current)');
    const fetchIndex = refreshBlock.indexOf('globalChannelsAPI.getBchChannels()');
    expect(guardIndex, 'refreshChannels should check dialogOpenRef').toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(fetchIndex);
  });
});
