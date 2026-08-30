import { useState } from 'react'

/**
 * Tabs (shared component): the tab-selection primitives factored out of
 * three previously-independent hand-rolled implementations --
 * `EnrollmentView.jsx` (ATAK/TAK Aware/iTAK/Manual, the only one of the
 * three with real `role="tablist"`/`role="tab"`/`aria-selected`
 * semantics already), `TeamDetail.jsx` (icon+count tabs, `aria-current`
 * instead of `aria-selected`), and `TeamFormDialog.jsx` (a plain-text
 * nav inside a modal, no tab ARIA at all, with a hidden-not-unmounted
 * "Team Settings" panel so unsaved form state survives a tab switch).
 *
 * This is deliberately a set of small, composable pieces rather than one
 * all-in-one `<Tabs>` component that owns the tab BUTTONS' markup: the
 * three sites' buttons differ too much (icon+2-col-grid-below-sm vs
 * icon-only-below-sm-with-count-badge vs plain text, in a `<div>` row vs
 * a `<nav>`) to share safely without either a large prop surface or a
 * regression at one of the sites. Each call site keeps authoring its own
 * button/list markup and className logic, and gains consistent,
 * correct ARIA semantics and state handling through these primitives.
 */

/**
 * useTabs: shared tab-selection state. Same [value, setValue] shape as
 * `useState`, so it drops into any of the three existing
 * `useState(<defaultTabId>)` call sites unchanged at the destructuring
 * site -- only the hook name changes.
 */
export function useTabs(defaultTab) {
  return useState(defaultTab)
}

/**
 * tabAria: the accessible-tab attribute pair (`role="tab"`,
 * `aria-selected`) as one spreadable object, so a caller wires correct
 * tab semantics onto whatever button markup it already owns without
 * hand-writing both attributes at every tab button. This is the piece
 * `EnrollmentView.jsx` already had by hand and the other two call sites
 * were missing (`TeamDetail.jsx` used `aria-current`; `TeamFormDialog.jsx`
 * had no tab ARIA at all).
 */
export function tabAria(activeTab, id) {
  return {
    role: 'tab',
    'aria-selected': activeTab === id
  }
}

/**
 * TabPanel: a tab's content, in one of two mount modes.
 *
 * - `keepMounted={false}` (default): unmounted while inactive, matching
 *   `EnrollmentView.jsx`'s and `TeamDetail.jsx`'s existing
 *   `{activeTab === id && (...)}` behavior -- neither has any state that
 *   needs to survive a tab switch, so a DOM query for inactive content
 *   still finds nothing, exactly as before.
 * - `keepMounted={true}`: hidden via a plain CSS `hidden` (display:none)
 *   attribute rather than unmounted, matching `TeamFormDialog.jsx`'s
 *   Team Settings panel -- an unsaved edit in an uncontrolled form input
 *   must survive switching to another tab and back.
 */
export function TabPanel({ id, activeTab, keepMounted = false, children, ...rest }) {
  const isActive = activeTab === id
  if (!keepMounted) {
    return isActive ? <div {...rest}>{children}</div> : null
  }
  return (
    <div hidden={!isActive} {...rest}>
      {children}
    </div>
  )
}

/**
 * TabList: an optional `role="tablist"` wrapper for new tab bars
 * (`GlobalChannels.jsx`). Not used to retrofit the three existing tab
 * bars in place -- each of those already has its own wrapper element
 * (a `<div>` or `<nav>`) with a specific className pinned by an existing
 * source-contract test; adding `role="tablist"` directly to that
 * existing element (rather than swapping it for this component) avoids
 * changing the literal JSX those tests match on.
 */
export function TabList({ as: Component = 'div', className = '', children, ...rest }) {
  return (
    <Component role="tablist" className={className} {...rest}>
      {children}
    </Component>
  )
}
