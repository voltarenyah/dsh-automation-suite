/**
 * Open (and focus) the Drawing tab in the host's right sidebar.
 *
 * The host exposes `sidebarRight` with `openTab/focus/active/isExpanded/
 * toggleExpanded/mounted/openTabs`; `dsh-better-sidebar` drives its own Tasks
 * page the same way. Two details matter:
 *
 *  - probe every member before use — the service face differs between host
 *    versions, and a missing method must degrade, not throw;
 *  - a switch of session throws `sidebarRight: no session surface is mounted`
 *    for a moment, so that one error is retried rather than reported.
 *
 * We never steal the column from a page the reader is on: if the sidebar is open
 * and showing something else, the tab is opened without forcing focus (the
 * caller then just tells the user it is ready).
 *
 * @module dsh-drawing/client/open-tab
 */

const NEEDED = ['openTab', 'focus', 'active', 'isExpanded', 'toggleExpanded']

/** @returns {object | undefined} the `sidebarRight` service face, when usable. */
export function rightFace(ctx) {
  const face = ctx?.get?.('sidebarRight')
  if (face === undefined || face === null) return undefined
  for (const name of NEEDED) {
    if (typeof face[name] !== 'function') return undefined
  }
  return face
}

/**
 * Bring the Drawing tab to the front.
 *
 * @param {object} ctx - client root context.
 * @param {string} kind - the tab kind registered with `sidebarRightTabs`.
 * @param {string} sessionId - the session whose sidebar to touch.
 * @returns {{ ok: boolean, reason?: string, stolen?: boolean }}
 */
export function openDrawingTab(ctx, kind, sessionId) {
  const face = rightFace(ctx)
  if (face === undefined) return { ok: false, reason: 'sidebar_unavailable' }

  try {
    const mounted = face.mounted?.getSnapshot?.()
    if (typeof mounted === 'string' && mounted !== '' && mounted !== sessionId) {
      return { ok: false, reason: 'session_not_mounted' }
    }

    const expanded = face.isExpanded() === true
    const active = expanded ? face.active() : undefined
    const showingOther = expanded && active !== undefined && active !== null && active.kind !== kind

    face.openTab(kind)
    const rows = face.openTabs?.getSnapshot?.() ?? []
    const mine = rows.find((row) => row.sessionId === sessionId && row.kind === kind)
    if (mine !== undefined && typeof mine.tabId === 'string') {
      if (!showingOther) face.focus(mine.tabId)
    }
    if (!face.isExpanded()) face.toggleExpanded()
    return { ok: true, stolen: showingOther === true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no session surface is mounted')) {
      return { ok: false, reason: 'surface_transition' }
    }
    return { ok: false, reason: 'open_failed' }
  }
}
