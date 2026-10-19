/**
 * The tab's view state, declared as a slot store so it outlives the component.
 *
 * Why a store: a body is unmounted when the user switches to another sidebar tab
 * (or another session's dock surface), and reading it again costs one
 * `readBytes` of a 773 KB manifest per device. The store keeps what the user had
 * set up — device/type filters, the search query, the selected row, the scroll
 * offset — plus the rows themselves as a *view cache*, which is the same thing
 * the shipped workspace-files tab does with its directory listings.
 *
 * State is bucketed per tab id because one session may hold more than one pane.
 * Everything a component reads comes back through `useStore`, and every write
 * goes through a declared action; modules never hold a handle (that would be a
 * disguised singleton across plugin reloads), so the handle is created in
 * `apply` and passed to the registration.
 *
 * @module dsh-ui-plc-source/store
 */

import { defineStore } from '@deepseek-ai/dsh-client-store'

/** Filter value meaning "no constraint"; kept in step with the model's `ALL`. */
const ALL = 'all'

/** The view state a tab starts from. Frozen so React sees one stable reference. */
export const EMPTY_VIEW = Object.freeze({
  status: 'idle',
  rows: [],
  refused: 0,
  notes: [],
  errorCode: '',
  device: ALL,
  type: ALL,
  query: '',
  selected: '',
  scrollTop: 0,
})

/**
 * @param {object} state - the store's state object.
 * @param {string} tabId - tab identity.
 * @returns {object} that tab's view state, or the frozen default.
 */
export function viewOf(state, tabId) {
  const bucket = state?.byTab?.[tabId]
  return bucket === undefined ? EMPTY_VIEW : bucket
}

/**
 * Create the store handle. Called once inside `apply`; the framework then
 * creates one instance per session scope.
 *
 * @returns {object} the store handle to hand to `slots.register({ store })`.
 */
export function createPlcStore() {
  return defineStore({
    init: () => ({ byTab: {} }),
    actions: {
      /** Merge a partial view state into one tab's bucket. */
      set(draft, tabId, patch) {
        draft.byTab[tabId] = { ...(draft.byTab[tabId] ?? EMPTY_VIEW), ...patch }
      },
      /** Drop a tab's bucket; the tab record is gone, so nothing can read it again. */
      forget(draft, tabId) {
        delete draft.byTab[tabId]
      },
    },
  })
}
