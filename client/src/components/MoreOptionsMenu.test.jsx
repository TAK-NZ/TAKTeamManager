import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import MoreOptionsMenu from './MoreOptionsMenu.jsx'

// This project has no `@testing-library/react`, so the component is
// mounted with `react-dom/client`'s `createRoot` plus React 18's own
// `act`, following the pattern established by `TransferMemberDialog.test.jsx`.
globalThis.React = React

function DotIcon(props) {
  return <svg data-testid="dot-icon" {...props} />
}

describe('MoreOptionsMenu (mounted)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
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

  const mount = async (props) => {
    root = createRoot(container)
    await act(async () => {
      root.render(<MoreOptionsMenu {...props} />)
    })
  }

  const findTrigger = () => container.querySelector('button[aria-haspopup="true"]')

  it('renders the trigger button closed by default, with the default "More options" label', async () => {
    await mount({ items: [{ key: 'a', label: 'Do A', icon: DotIcon, onClick: () => {} }] })

    const trigger = findTrigger()
    expect(trigger).not.toBeNull()
    expect(trigger.textContent).toContain('More options')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('honours a custom buttonLabel', async () => {
    await mount({ items: [], buttonLabel: 'Actions' })

    expect(findTrigger().textContent).toContain('Actions')
  })

  // Bugfix (mobile header toolbar): `iconOnly` swaps the visible
  // "More options" text + chevron for a single icon, while keeping
  // `buttonLabel` as the accessible name so a screen reader still
  // announces "More options" (or a custom label) rather than nothing.
  describe('iconOnly', () => {
    it('renders no visible text and no chevron, but keeps buttonLabel as the aria-label', async () => {
      await mount({ items: [{ key: 'a', label: 'Do A', icon: DotIcon, onClick: () => {} }], iconOnly: true })

      const trigger = findTrigger()
      expect(trigger.textContent.trim()).toBe('')
      expect(trigger.getAttribute('aria-label')).toBe('More options')
      expect(trigger.getAttribute('title')).toBe('More options')
    })

    it('honours a custom buttonLabel as the aria-label/title even in iconOnly mode', async () => {
      await mount({ items: [], buttonLabel: 'Actions', iconOnly: true })

      const trigger = findTrigger()
      expect(trigger.getAttribute('aria-label')).toBe('Actions')
      expect(trigger.getAttribute('title')).toBe('Actions')
      expect(trigger.textContent.trim()).toBe('')
    })

    it('still opens the menu and renders items normally', async () => {
      await mount({
        items: [{ key: 'a', label: 'Do A', icon: DotIcon, onClick: () => {} }],
        iconOnly: true
      })

      await act(async () => {
        findTrigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      const menu = container.querySelector('[role="menu"]')
      expect(menu).not.toBeNull()
      expect(container.querySelector('[role="menuitem"]').textContent).toContain('Do A')
    })

    it('does not set a title attribute (relying on aria-label alone) when iconOnly is false, matching the pre-existing default behaviour', async () => {
      await mount({ items: [], buttonLabel: 'Actions' })

      expect(findTrigger().getAttribute('title')).toBeNull()
    })
  })

  // Bugfix: `iconOnly: true` (icon-only on EVERY viewport, including
  // desktop) was itself a regression from a mobile-only fix. `'below-sm'`
  // is the corrected shape: icon-only below `sm:`, full label + chevron
  // restored at `sm:` and up.
  describe('iconOnly: "below-sm"', () => {
    it('renders the label text and chevron with "hidden sm:inline"/"sm:hidden" responsive classes, not unconditionally hidden', async () => {
      await mount({ items: [{ key: 'a', label: 'Do A', icon: DotIcon, onClick: () => {} }], iconOnly: 'below-sm' })

      const trigger = findTrigger()
      const label = Array.from(trigger.querySelectorAll('span')).find((el) => el.textContent === 'More options')
      expect(label).toBeTruthy()
      expect(label.className).toContain('hidden')
      expect(label.className).toContain('sm:inline')

      const ellipsis = trigger.querySelector('svg.sm\\:hidden')
      expect(ellipsis).not.toBeNull()
    })

    it('keeps buttonLabel as the aria-label, and does NOT set a title (the visible label at sm:+ already serves that purpose)', async () => {
      await mount({ items: [], buttonLabel: 'Actions', iconOnly: 'below-sm' })

      const trigger = findTrigger()
      expect(trigger.getAttribute('aria-label')).toBe('Actions')
      expect(trigger.getAttribute('title')).toBeNull()
    })

    it('still opens the menu and renders items normally', async () => {
      await mount({
        items: [{ key: 'a', label: 'Do A', icon: DotIcon, onClick: () => {} }],
        iconOnly: 'below-sm'
      })

      await act(async () => {
        findTrigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      const menu = container.querySelector('[role="menu"]')
      expect(menu).not.toBeNull()
      expect(container.querySelector('[role="menuitem"]').textContent).toContain('Do A')
    })
  })

  // Bugfix: on TeamDetail.jsx's mobile toolbar, the panel's default
  // anchor (right-0, opening leftward) pushed it off the left edge of
  // the screen, since that toolbar's trigger sits near the LEFT edge
  // below `lg:` and only moves to the right edge AT `lg:`. `panelClassName`
  // lets a caller override the anchor to match where ITS OWN trigger
  // actually sits.
  describe('panelClassName', () => {
    it('defaults to right-0 (opening leftward), the pre-existing behaviour', async () => {
      await mount({ items: [{ key: 'a', label: 'Do A', icon: DotIcon, onClick: () => {} }] })

      await act(async () => {
        findTrigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(container.querySelector('[role="menu"]').className).toContain('right-0')
    })

    it('overrides the anchor classes when provided, e.g. opening rightward below a breakpoint and leftward at/above it', async () => {
      await mount({
        items: [{ key: 'a', label: 'Do A', icon: DotIcon, onClick: () => {} }],
        panelClassName: 'left-0 lg:left-auto lg:right-0'
      })

      await act(async () => {
        findTrigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      const menu = container.querySelector('[role="menu"]')
      expect(menu.className).toContain('left-0 lg:left-auto lg:right-0')
      // The default anchor is gone -- `absolute right-0` (unqualified,
      // not `lg:right-0`) no longer appears at all.
      expect(menu.className).not.toContain('absolute right-0')
    })
  })

  it('opens the menu on trigger click, rendering each item with its icon, label, and role="menuitem"', async () => {
    const onClickA = () => {}
    const onClickB = () => {}
    await mount({
      items: [
        { key: 'a', label: 'Do A', icon: DotIcon, onClick: onClickA },
        { key: 'b', label: 'Do B', icon: DotIcon, onClick: onClickB }
      ]
    })

    await act(async () => {
      findTrigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const menu = container.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    expect(findTrigger().getAttribute('aria-expanded')).toBe('true')

    const menuItems = Array.from(container.querySelectorAll('[role="menuitem"]'))
    expect(menuItems).toHaveLength(2)
    expect(menuItems[0].textContent).toContain('Do A')
    expect(menuItems[1].textContent).toContain('Do B')
    // Each item carries its own icon, so items stay visually
    // distinguishable from one another.
    expect(menuItems[0].querySelector('[data-testid="dot-icon"]')).not.toBeNull()
    expect(menuItems[1].querySelector('[data-testid="dot-icon"]')).not.toBeNull()
  })

  it('closes the menu and invokes the item\'s onClick when a menu item is activated', async () => {
    let clicked = false
    await mount({
      items: [{ key: 'a', label: 'Do A', icon: DotIcon, onClick: () => { clicked = true } }]
    })

    await act(async () => {
      findTrigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const menuItem = container.querySelector('[role="menuitem"]')
    await act(async () => {
      menuItem.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(clicked).toBe(true)
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(findTrigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('closes the menu on Escape without invoking any item\'s onClick', async () => {
    let clicked = false
    await mount({
      items: [{ key: 'a', label: 'Do A', icon: DotIcon, onClick: () => { clicked = true } }]
    })

    await act(async () => {
      findTrigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[role="menu"]')).not.toBeNull()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(clicked).toBe(false)
  })

  it('closes the menu when a click lands outside it (the overlay)', async () => {
    await mount({ items: [{ key: 'a', label: 'Do A', icon: DotIcon, onClick: () => {} }] })

    await act(async () => {
      findTrigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[role="menu"]')).not.toBeNull()

    // The click-outside overlay is the sibling `fixed inset-0` div
    // rendered alongside the menu panel.
    const overlay = container.querySelector('.fixed.inset-0')
    expect(overlay).not.toBeNull()
    await act(async () => {
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('toggles closed when the trigger is clicked again while open', async () => {
    await mount({ items: [{ key: 'a', label: 'Do A', icon: DotIcon, onClick: () => {} }] })

    await act(async () => {
      findTrigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[role="menu"]')).not.toBeNull()

    await act(async () => {
      findTrigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('renders a disabled item as disabled and dimmed, and does not close the menu or fire onClick when activated', async () => {
    let clicked = false
    await mount({
      items: [
        {
          key: 'a',
          label: 'Unavailable',
          icon: DotIcon,
          onClick: () => { clicked = true },
          disabled: true,
          title: 'Not available right now'
        }
      ]
    })

    await act(async () => {
      findTrigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const menuItem = container.querySelector('[role="menuitem"]')
    expect(menuItem.disabled).toBe(true)
    expect(menuItem.className).toContain('opacity-50')
    expect(menuItem.getAttribute('title')).toBe('Not available right now')

    // A disabled native <button> does not dispatch a click event at all,
    // matching every other disabled button in this app (e.g. the
    // "Create Channel" button at the 3-channel limit) -- so this asserts
    // the browser-level guarantee this component relies on rather than
    // its own JS logic.
    await act(async () => {
      menuItem.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(clicked).toBe(false)
  })
})
