/**
 * Browser half: one right-sidebar tab type ("Versions") and its body.
 *
 * Everything cross-package stays on the sanctioned channels: Cordis services
 * (`slots`, `sessions`, `locale`, `remote.workspaceFiles`), slot registrations
 * and `import type`. The bundle requests nothing beyond the shell's frozen
 * platform table (`react` and its JSX runtime).
 *
 * The data is `<workspace>/.dsh/versions-view.json`, produced by the
 * engineering-context plugin. The tab reads it through `workspaceFiles.readBytes`
 * (one call, whole file), so no new HTTP route or remote service is involved.
 *
 * @module dsh-ui-versions/client
 */

import { Panel } from './Panel.jsx'
import { Title } from './Title.jsx'
import { ensureStyle } from './style.js'
import { NS, en, zh } from './locales.js'

/** Package name. Also the tab-type id and the body seat's key — they must agree. */
export const ID = 'dsh-ui-versions'

/** A fresh kind, so the type cannot collide with the shipped tab types. */
const KIND = 'versions'

/** Cordis services this plugin waits for before its body runs. */
export const inject = ['slots', 'sessions', 'locale', 'remote', 'remote.workspaceFiles']

/**
 * Read one UTF-8 text file whole.
 *
 * @param {any} context - client root context.
 * @param {string} sessionId - the session the tab belongs to.
 * @param {string} path - absolute file path.
 * @param {AbortSignal | undefined} signal - aborts with the tab.
 * @returns {Promise<{ ok: true, text: string } | { ok: false, code: string }>}
 */
async function readTextFile(context, sessionId, path, signal) {
  try {
    const answer = await context.remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
    if (answer?.ok !== true) return { ok: false, code: answer?.error?.code ?? 'gateway/internal' }
    const data = answer.value?.data
    if (!(data instanceof Uint8Array)) return { ok: false, code: 'workspace-file/not-text' }
    return { ok: true, text: new TextDecoder('utf-8').decode(data) }
  } catch {
    return { ok: false, code: 'gateway/internal' }
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
                order: 101,
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
              readTextFile: (path, signal) => readTextFile(ctx, sessionId, path, signal),
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
