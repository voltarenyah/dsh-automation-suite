/**
 * Browser half: one entry in the main sidebar's global panel list and its
 * full-page panel.
 *
 * Two root-scoped seats, both owned by shipped plugins:
 *
 *  - `sidebar.panellist` — a **root list** seat declared by
 *    `@deepseek-ai/dsh-client-ui-sidebar` (`{ kind: 'list', scope: 'root' }`).
 *    The sidebar re-sorts its registrations by `order` (ascending) and re-resolves
 *    the label thunk on locale change. Plugins registers itself at `order: 0`
 *    and Schedules at `10`, so `-10` puts this row first.
 *  - `main` — a **root keyed** seat declared by `@deepseek-ai/dsh-client-ui-layout`;
 *    the row and the page share the id `project-dashboard`.
 *
 * Registration order matters: the rail row is registered only after the `main`
 * entry exists, because selecting a row whose main entry is missing throws inside
 * the shell's click handler (`layout.selectPanel: main panel "…" is not
 * registered`). A failed page registration therefore leaves no dead entry.
 *
 * The page itself lives in `dashboard.jsx`; workspace/session data arrives through
 * the standard root hooks, tags through this plugin's own endpoint, and the two
 * navigation verbs through the injected face below.
 *
 * @module dsh-ui-project-dashboard/client
 */

import { createElement } from 'react'

import { Dashboard } from './dashboard.jsx'
import { NS, zh, en } from './locales.js'
import { ensureStyle } from './style.js'

/** Package name; also the panel id and the `main` seat key — they must agree. */
export const ID = 'dsh-ui-project-dashboard'

/** Panel id used by both root seats. */
const PANEL = 'project-dashboard'

/**
 * Rail order. Plugins is `0` and Schedules `10`; the sidebar sorts ascending by
 * `order` only (not `priority`), so a negative value is the way to sit first.
 */
const ORDER = -10

/** Services this plugin waits for before its body runs. */
export const inject = ['slots', 'locale']

/**
 * The sidebar glyph: three stacked sheets — "the overview of every project".
 *
 * @param {{ size?: number }} props - seat-provided sizing.
 */
function PanelIcon(props) {
  const size = (props && props.size) || 18
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    createElement('rect', { x: 3.2, y: 3.8, width: 17.6, height: 5.4, rx: 1.6 }),
    createElement('rect', { x: 3.2, y: 12.4, width: 10.4, height: 8, rx: 1.6 }),
    createElement('rect', { x: 16.2, y: 12.4, width: 4.6, height: 8, rx: 1.6 }),
  )
}

/**
 * Client plugin body.
 *
 * @param {any} ctx - client root context.
 */
export function apply(ctx) {
  const warn = (message) => {
    try { ctx.logger?.warn?.(`${ID}: ${message}`) } catch { /* logging must never break the plugin */ }
  }

  try {
    ensureStyle(ID)
  } catch (error) {
    warn(`stylesheet injection failed: ${String(error)}`)
  }

  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${ID}: dictionaries`)
  } catch (error) {
    warn(`locale registration failed: ${String(error)}`)
  }

  /** `uiWorkspace` may arrive later (and may be absent in a composition). */
  const uiWorkspace = () => {
    try {
      return ctx.get('uiWorkspace')
    } catch {
      return undefined
    }
  }

  const newSession = (workspaceId) => {
    const service = uiWorkspace()
    if (service === undefined || typeof service.startSession !== 'function') throw new Error('uiWorkspace is unavailable')
    return service.startSession(workspaceId)
  }

  try {
    ctx.slots.inject('main', () => {
      let disposeMain
      try {
        disposeMain = ctx.slots.register(
          { name: 'main', key: PANEL, locale: NS, inject: () => ({ newSession }) },
          Dashboard,
        )
      } catch (error) {
        warn(`the main panel could not be registered: ${String(error)}`)
        return () => {}
      }

      // The page exists, so the rail row is safe to add. It waits for the
      // sidebar's declaration independently (the two owners are different plugins).
      let disposeRow = () => {}
      try {
        disposeRow = ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL,
              order: ORDER,
              label: () => {
                try {
                  return ctx.locale.bind(NS)('panel')
                } catch {
                  return 'Project Dashboard'
                }
              },
              locale: NS,
            },
            PanelIcon,
          ),
        )
      } catch (error) {
        warn(`the sidebar entry could not be registered: ${String(error)}`)
      }

      return () => {
        try { disposeRow() } catch { /* ignore */ }
        disposeMain()
      }
    })
  } catch (error) {
    warn(`the main seat could not be injected: ${String(error)}`)
  }

  // Acceptance probe: only apply() writes it, so "row missing" and "bundle never
  // ran" stay distinguishable in the browser.
  try {
    document.documentElement.dataset.dshProjectDashboard = 'p1'
  } catch { /* non-browser hosts */ }
}
