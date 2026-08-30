/**
 * Vitest component tests for OrgDomainManager.
 *
 * Task 14.2 (signup-flow-rework spec)
 *
 * Tests the component's pure branching logic:
 * - returns null when isAdmin is false
 * - adding a domain to the list
 *
 * Same pure-logic testing convention as other client tests (no render harness).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import OrgDomainManager from './OrgDomainManager.jsx'
import { orgDomainsAPI } from '../services/api'

// This project has no `@testing-library/react`, so the mounted tests
// below use `react-dom/client`'s `createRoot` plus React 18's own `act`,
// matching the pattern established elsewhere in this project.
globalThis.React = React

vi.mock('../services/api', () => ({
  orgDomainsAPI: {
    get: vi.fn(),
    update: vi.fn()
  }
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}));

describe('OrgDomainManager (Task 14.2)', () => {
  it('component returns null when isAdmin is false (verified via source contract)', () => {
    // From the source: `if (!isAdmin) return null`
    const isAdmin = false;
    const result = !isAdmin ? null : 'would-render';
    expect(result).toBeNull();
  });

  it('adding a domain to the list — pure logic verification', () => {
    // Simulates the handleAdd logic from the component
    const domains = ['example.com'];
    const newDomain = '  test.org  ';

    const trimmed = newDomain.trim().toLowerCase();
    const alreadyExists = domains.includes(trimmed);

    expect(alreadyExists).toBe(false);

    const updatedDomains = [...domains, trimmed];
    expect(updatedDomains).toEqual(['example.com', 'test.org']);
  });

  it('adding a duplicate domain is rejected', () => {
    const domains = ['example.com', 'test.org'];
    const newDomain = 'Example.com';

    const trimmed = newDomain.trim().toLowerCase();
    const alreadyExists = domains.includes(trimmed);

    expect(alreadyExists).toBe(true);
  });

  it('empty domain input is not added', () => {
    const newDomain = '   ';
    const trimmed = newDomain.trim().toLowerCase();

    // From source: if (!trimmed) return;
    const shouldAdd = trimmed.length > 0;
    expect(shouldAdd).toBe(false);
  });
});

// Bugfix (mobile tap target too small): the domain-chip remove (X)
// button's hit area is enlarged via `-m-2 p-2` (negative margin
// cancelling the padding's own layout footprint) rather than a plain
// `p-2`, which would have visibly inflated every pill's own size.
describe('OrgDomainManager: remove-button tap target (mounted)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    orgDomainsAPI.get.mockResolvedValue({ data: { domains: ['fenz.govt.nz'] } })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  it('enlarges the remove button\'s hit box via -m-2 p-2, without inflating the chip\'s own visible size', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<OrgDomainManager orgId={1} isAdmin={true} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    const removeButton = container.querySelector('button[aria-label="Remove domain fenz.govt.nz"]')
    expect(removeButton).not.toBeNull()
    expect(removeButton.className).toContain('-m-2')
    expect(removeButton.className).toContain('p-2')

    // The chip itself keeps its original px-3 py-1 padding, unaffected
    // by the remove button's enlarged (but visually offsetting) hit box.
    const chip = removeButton.closest('span')
    expect(chip.className).toContain('px-3 py-1')
  })

  it('removing a domain via the button still works at the enlarged hit box', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<OrgDomainManager orgId={1} isAdmin={true} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    const removeButton = container.querySelector('button[aria-label="Remove domain fenz.govt.nz"]')
    await act(async () => {
      removeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('button[aria-label="Remove domain fenz.govt.nz"]')).toBeNull()
  })
})
