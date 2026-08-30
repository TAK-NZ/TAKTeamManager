import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { useTabs, tabAria, TabPanel, TabList } from './Tabs.jsx'

// This project has no @testing-library/react. Mount with react-dom/client's
// createRoot plus React 18's act, matching the established convention
// (see DeviceTypeIcon.test.jsx / RevokeDeviceDialog.test.jsx).
globalThis.React = React

describe('Tabs (mounted)', () => {
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

  const mount = async (Component) => {
    root = createRoot(container)
    await act(async () => {
      root.render(<Component />)
    })
  }

  // ── useTabs ──────────────────────────────────────────────────────────
  describe('useTabs', () => {
    it('returns a [value, setValue] pair, defaulting to the value passed in, just like useState', async () => {
      let captured
      function Harness() {
        const [activeTab, setActiveTab] = useTabs('settings')
        captured = { activeTab, setActiveTab }
        return <div data-active={activeTab} />
      }
      await mount(Harness)
      expect(container.querySelector('div').dataset.active).toBe('settings')
      expect(typeof captured.setActiveTab).toBe('function')
    })

    it('re-renders with the new active tab when setActiveTab is called', async () => {
      function Harness() {
        const [activeTab, setActiveTab] = useTabs('members')
        return (
          <div>
            <div data-active={activeTab} />
            <button type="button" onClick={() => setActiveTab('admins')}>switch</button>
          </div>
        )
      }
      await mount(Harness)
      expect(container.querySelector('[data-active]').dataset.active).toBe('members')

      await act(async () => {
        container.querySelector('button').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(container.querySelector('[data-active]').dataset.active).toBe('admins')
    })
  })

  // ── tabAria ──────────────────────────────────────────────────────────
  describe('tabAria', () => {
    it('returns role="tab" and aria-selected=true for the active tab id', () => {
      expect(tabAria('atak', 'atak')).toEqual({ role: 'tab', 'aria-selected': true })
    })

    it('returns role="tab" and aria-selected=false for an inactive tab id', () => {
      expect(tabAria('atak', 'itak')).toEqual({ role: 'tab', 'aria-selected': false })
    })

    it('spreads cleanly onto a button, producing real DOM role/aria-selected attributes', async () => {
      function Harness() {
        return (
          <button type="button" {...tabAria('settings', 'settings')}>
            Team Settings
          </button>
        )
      }
      await mount(Harness)
      const button = container.querySelector('button')
      expect(button.getAttribute('role')).toBe('tab')
      expect(button.getAttribute('aria-selected')).toBe('true')
    })
  })

  // ── TabPanel ─────────────────────────────────────────────────────────
  describe('TabPanel', () => {
    it('unmounts (renders nothing) while inactive, by default -- matching EnrollmentView/TeamDetail\'s existing {activeTab === id && (...)} behavior', async () => {
      function Harness() {
        return (
          <TabPanel id="members" activeTab="admins">
            <span>Members content</span>
          </TabPanel>
        )
      }
      await mount(Harness)
      expect(container.querySelector('span')).toBeNull()
      expect(container.innerHTML).toBe('')
    })

    it('renders its children while active, by default', async () => {
      function Harness() {
        return (
          <TabPanel id="members" activeTab="members">
            <span>Members content</span>
          </TabPanel>
        )
      }
      await mount(Harness)
      expect(container.querySelector('span').textContent).toBe('Members content')
    })

    it('with keepMounted=true, stays mounted (not unmounted) while inactive, hidden via a plain `hidden` attribute rather than being removed from the DOM', async () => {
      function Harness() {
        return (
          <TabPanel id="settings" activeTab="domains" keepMounted>
            <input defaultValue="unsaved edit" />
          </TabPanel>
        )
      }
      await mount(Harness)
      const wrapper = container.firstElementChild
      expect(wrapper).not.toBeNull()
      expect(wrapper.hidden).toBe(true)
      // The input itself is still mounted -- its uncontrolled value
      // would survive a switch back, unlike an unmount/remount cycle.
      expect(container.querySelector('input').value).toBe('unsaved edit')
    })

    it('with keepMounted=true, is not hidden while active', async () => {
      function Harness() {
        return (
          <TabPanel id="settings" activeTab="settings" keepMounted>
            <span>Settings content</span>
          </TabPanel>
        )
      }
      await mount(Harness)
      const wrapper = container.firstElementChild
      expect(wrapper.hidden).toBe(false)
      expect(container.querySelector('span').textContent).toBe('Settings content')
    })

    it('forwards arbitrary props (e.g. className) onto the wrapping div in both mount modes', async () => {
      function Harness() {
        return (
          <>
            <TabPanel id="a" activeTab="a" className="pane-a">
              <span>A</span>
            </TabPanel>
            <TabPanel id="b" activeTab="a" keepMounted className="pane-b">
              <span>B</span>
            </TabPanel>
          </>
        )
      }
      await mount(Harness)
      expect(container.querySelector('.pane-a')).not.toBeNull()
      expect(container.querySelector('.pane-b')).not.toBeNull()
    })
  })

  // ── TabList ──────────────────────────────────────────────────────────
  describe('TabList', () => {
    it('renders a div with role="tablist" by default', async () => {
      function Harness() {
        return (
          <TabList className="my-tablist">
            <button type="button">One</button>
          </TabList>
        )
      }
      await mount(Harness)
      const tablist = container.querySelector('[role="tablist"]')
      expect(tablist).not.toBeNull()
      expect(tablist.tagName).toBe('DIV')
      expect(tablist.className).toBe('my-tablist')
    })

    it('renders as a different element via the `as` prop (e.g. nav, matching TeamDetail/TeamFormDialog\'s existing <nav> tab bars)', async () => {
      function Harness() {
        return (
          <TabList as="nav" className="-mb-px flex">
            <button type="button">One</button>
          </TabList>
        )
      }
      await mount(Harness)
      const tablist = container.querySelector('[role="tablist"]')
      expect(tablist.tagName).toBe('NAV')
    })
  })
})
