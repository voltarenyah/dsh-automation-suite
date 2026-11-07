/**
 * Browser half: one right-sidebar tab type ("Changes") and its body.
 *
 * Everything cross-package stays on the sanctioned channels: Cordis services
 * (`slots`, `sessions`, `locale`), slot registrations and `import type`. The
 * bundle requests nothing beyond the shell's frozen platform table (`react` and
 * its JSX runtime).
 *
 * The data is the plugin's own host route — `GET /changes/api/status` — which is
 * the one place in this distribution where a UI plugin needs live host state
 * (the working tree) instead of a file written earlier. The route's security
 * posture lives in `src/route.ts`; this half only calls it.
 *
 * P0: the route answers with a stub payload, so the panel shows a "sample data"
 * banner. P1 replaces the provider behind the route and nothing here changes.
 *
 * @module dsh-ui-changes/client
 */

import { Panel } from './Panel.jsx'
import { Title } from './Title.jsx'
import { ensureStyle } from './style.js'
import { NS, en, zh } from './locales.js'

/** Package name. Also the tab-type id and the body seat's key — they must agree. */
export const ID = 'dsh-ui-changes'

/** A fresh kind, so the type cannot collide with the shipped tab types. */
const KIND = 'changes'

/** Where the host half answers. */
const STATUS_URL = '/changes/api/status'

/** Cordis services this plugin waits for before its body runs. */
export const inject = ['slots', 'sessions', 'locale']

/**
 * Read the working-tree status for one session.
 *
 * Never throws: the panel branches on `{ ok, code }`, and a route that is not
 * registered yet (older composition) degrades to one visible error line instead
 * of an empty pane.
 *
 * @param {any} context - client root context.
 * @param {string} sessionId - the session the tab belongs to.
 * @param {AbortSignal | undefined} signal - aborts with the tab or a refresh.
 * @returns {Promise<{ ok: true, value: any } | { ok: false, code: string }>}
 */
async function fetchStatus(context, sessionId, signal) {
  try {
    const response = await fetch(`${STATUS_URL}?session=${encodeURIComponent(sessionId)}`, {
      signal,
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    if (!response.ok) return { ok: false, code: body?.code ?? `http/${response.status}` }
    if (body === null || body.ok !== true) return { ok: false, code: body?.code ?? 'changes/bad-response' }
    return { ok: true, value: body }
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, code: 'changes/aborted' }
    return { ok: false, code: 'changes/network' }
  }
}

/**
 * Client plugin body.
 *
 * @param {any} ctx - client root context.
 */
export function apply(ctx) {
  try {
    ensureStyle(ID)
  } catch (error) {
    ctx.logger?.warn?.(`${ID}: stylesheet injection failed: ${String(error)}`)
  }

  // Dictionaries first: registration is what lets the labels below translate.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${ID}: dictionaries`)
  const t = ctx.locale.bind(NS)

  ctx.effect(
    () =>
      ctx.inject(['sidebarRightTabs'], (injected) => {
        const tabs = typeof injected?.get === 'function' ? injected.get('sidebarRightTabs') : undefined
        if (tabs === undefined || tabs === null) {
          ctx.logger?.warn?.(`${ID}: sidebarRightTabs is unavailable; the tab type is not registered`)
          return () => {}
        }
        try {
          return tabs.register({
            id: ID,
            kind: KIND,
            // A thunk, not a string: the chip follows the active locale.
            title: () => t('tab.title'),
            guide: [
              {
                id: KIND,
                order: 102,
                title: () => t('guide.title'),
                description: () => t('guide.description'),
              },
            ],
          })
        } catch (error) {
          ctx.logger?.warn?.(`${ID}: registering the tab type failed: ${String(error)}`)
          return () => {}
        }
      }),
    `${ID}: tab type`,
  )

  // The body goes first: it is what the tab is for, so nothing decorative may
  // be able to take it down with it.
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: ID,
            locale: NS,
            inject: (sessionId) => ({
              t,
              fetchStatus: (signal) => fetchStatus(ctx, sessionId, signal),
            }),
          },
          Panel,
        ),
      ),
    `${ID}: tab body`,
  )

  // The chip is rendered by a seat of its own, because a tab record freezes the
  // title text it was opened with.
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab.title',
            key: ID,
            locale: NS,
            inject: () => ({ t }),
          },
          Title,
        ),
      ),
    `${ID}: tab title`,
  )
}
