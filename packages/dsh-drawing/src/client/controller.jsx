/**
 * The always-mounted controller: notice `drawing_show` and put it on screen.
 *
 * It lives in the composer dock and renders nothing — it exists because the tab
 * body is only mounted while the sidebar tab is open, and the whole point is to
 * open it. It reads the session's event window (the same channel the TIA console
 * uses), folds `tool/call` + `tool/result`, and on a successful `drawing_show`
 * loads `.dsh/drawing-view.json` and publishes it to the shared store, then asks
 * the host to bring the tab forward.
 *
 * Why the file and not the result text: the tool result the browser sees is the
 * *rendered* line (a sentence for humans), while the file carries the page, the
 * highlight box and the image path without any parsing.
 *
 * @module dsh-drawing/client/controller
 */

import { useEffect, useRef } from 'react'

import { setView } from './store.js'
import { openDrawingTab } from './open-tab.js'

/** The host tool whose result triggers a jump. */
const SHOW_TOOL = 'drawing_show'

/** Where the host leaves the last requested view, relative to the workspace. */
const VIEW_FILE = '.dsh/drawing-view.json'

/** Join an absolute base with a forward-slash relative path. */
function joinPath(base, rel) {
  return `${String(base).replace(/[\\/]+$/, '').replace(/\\/g, '/')}/${rel}`
}

/**
 * @param {object} props - seat props.
 */
export function Controller(props) {
  const { sessionId, kind, readTextFile, ctx } = props
  // Derived props are the same ones the tab body receives.
  const readSessions = typeof props.useSessions === 'function' ? props.useSessions : () => undefined
  const cwd = readSessions((sessions) => sessions?.byId?.[sessionId]?.cwd)

  // Tool names by call id: `tool/result` does not carry the name itself.
  const names = useRef(new Map())
  /** The last `drawing_show` call already applied, so re-folding is idempotent. */
  const handled = useRef(undefined)
  const retry = useRef(undefined)

  useEffect(() => {
    const source = ctx?.sessions?.binding?.(sessionId)?.eventSource
    if (source === undefined || source === null) return undefined
    let disposed = false

    const load = async () => {
      if (typeof cwd !== 'string' || cwd === '') return
      const answer = await readTextFile(joinPath(cwd, VIEW_FILE))
      if (disposed || answer?.ok !== true) return
      let view
      try {
        view = JSON.parse(answer.text)
      } catch {
        return
      }
      if (view === null || typeof view !== 'object') return
      setView(sessionId, view)
      const opened = openDrawingTab(ctx, kind, sessionId)
      if (opened.ok !== true && opened.reason === 'surface_transition') {
        // The session surface was mid-swap; one retry after the frame settles.
        if (retry.current !== undefined) clearTimeout(retry.current)
        retry.current = setTimeout(() => {
          openDrawingTab(ctx, kind, sessionId)
        }, 250)
      }
    }

    const fold = () => {
      const snapshot = source.getSnapshot()
      const rows = Array.isArray(snapshot) ? snapshot : (snapshot?.entries ?? [])
      for (const entry of rows) {
        if (entry === null || typeof entry !== 'object' || entry.type !== 'event') continue
        const event = entry.event
        if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
        const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
        if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
          names.current.set(data.callId, data.name)
          continue
        }
        if (event.type !== 'tool/result') continue
        const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
        const origin = message.source !== null && typeof message.source === 'object' ? message.source : {}
        const callId = typeof origin.callId === 'string' ? origin.callId : undefined
        if (callId === undefined || names.current.get(callId) !== SHOW_TOOL) continue
        names.current.delete(callId)
        if (handled.current === callId) continue
        const first = Array.isArray(message.content) ? message.content[0] : undefined
        if (first?.isError === true) continue
        handled.current = callId
        void load()
      }
    }

    fold()
    return source.subscribe(fold)
  }, [ctx, kind, sessionId, cwd, readTextFile])

  useEffect(
    () => () => {
      if (retry.current !== undefined) clearTimeout(retry.current)
    },
    [],
  )

  return null
}
