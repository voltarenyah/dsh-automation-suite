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
 * Registration failures are logged, never thrown: one broken seat must not take
 * the rest of the client down.
 *
 * @module dsh-ui-project-dashboard/client
 */

import { createElement, Fragment } from 'react'

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
 * The P0 page: it states what is already wired and what comes next. Real data
 * arrives in P1/P2 through the host's standard hooks and `workspaceFiles`.
 *
 * @param {{ t: (key: string) => string }} props - the seat injects the bound translator.
 */
function Page(props) {
  const t = props.t
  const fact = (key, label, value) =>
    createElement(
      Fragment,
      { key },
      createElement('dt', null, label),
      createElement('dd', null, value),
    )

  return createElement(
    'div',
    { className: 'pd-root', 'data-dsh-panel': PANEL },
    createElement(
      'div',
      { className: 'pd-sheet' },
      createElement('div', { className: 'pd-eyebrow' }, t('eyebrow')),
      createElement('h1', { className: 'pd-title' }, t('title')),
      createElement('p', { className: 'pd-lead' }, t('lead')),

      createElement('div', { className: 'pd-h' }, t('statusTitle')),
      createElement(
        'dl',
        { className: 'pd-facts' },
        fact('id', t('idLabel'), createElement('code', null, PANEL)),
        fact('seat', t('seatLabel'), t('seatValue')),
        fact('order', t('orderLabel'), t('orderValue')),
        fact('locale', t('localeLabel'), t('localeValue')),
      ),

      createElement('div', { className: 'pd-h' }, t('nextTitle')),
      createElement(
        'ul',
        { className: 'pd-next' },
        createElement('li', null, createElement('b', null, 'P1'), t('next1')),
        createElement('li', null, createElement('b', null, 'P2'), t('next2')),
        createElement('li', null, createElement('b', null, 'P3'), t('next3')),
      ),

      createElement('p', { className: 'pd-note' }, t('note')),
    ),
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

  let t
  try {
    t = ctx.locale.bind(NS)
  } catch (error) {
    warn(`locale bind failed: ${String(error)}`)
    t = (key) => ({ panel: 'Project Dashboard' }[key] ?? key)
  }

  try {
    ctx.slots.inject('main', () => {
      let disposeMain
      try {
        disposeMain = ctx.slots.register(
          { name: 'main', key: PANEL, locale: NS },
          Page,
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
              label: () => t('panel'),
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
    document.documentElement.dataset.dshProjectDashboard = 'p0'
  } catch { /* non-browser hosts */ }
}
