/**
 * Per-session view state, shared by the always-mounted controller and the tab
 * body.
 *
 * A plain module-level store, deliberately: the controller lives in the composer
 * dock (mounted for the whole session) while the panel lives in the sidebar tab
 * (mounted only while open), and both must agree on "which page did the agent
 * just put on screen". Cordis slot stores are scoped per registration; this is
 * one small map on the plugin's own module, which is a singleton per page load.
 *
 * @module dsh-drawing/client/store
 */

/** sessionId -> latest view (see `DrawingView` on the host side). */
const views = new Map()
/** sessionId -> listeners. */
const listeners = new Map()

/** The latest view for a session, or undefined. */
export function getView(sessionId) {
  return views.get(sessionId)
}

/**
 * Replace the view for a session.
 *
 * @param {string} sessionId
 * @param {object} view - the `drawing-view.json` payload.
 */
export function setView(sessionId, view) {
  const previous = views.get(sessionId)
  if (previous !== undefined && previous.ts === view?.ts) return
  views.set(sessionId, view)
  for (const listener of listeners.get(sessionId) ?? []) listener()
}

/** Subscribe to changes; returns the unsubscribe function. */
export function subscribeView(sessionId, listener) {
  const set = listeners.get(sessionId) ?? new Set()
  set.add(listener)
  listeners.set(sessionId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(sessionId)
  }
}
