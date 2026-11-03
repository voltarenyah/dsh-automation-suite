/**
 * Browser half: the right-sidebar "Drawing" tab plus a headless controller.
 *
 * Everything cross-package stays on the sanctioned channels: Cordis services
 * (`slots`, `sessions`, `locale`, `remote.workspaceFiles`, `sidebarRight`), slot
 * registrations, and the shell's frozen platform table (`react` and its JSX
 * runtime).
 *
 * Why a controller in the composer dock: the tab body is mounted only while the
 * tab is open, and the whole point of `drawing_show` is to open it. The dock seat
 * is mounted for the session's lifetime and renders nothing.
 *
 * Registration details that are load-bearing (same as the sibling ui-* plugins):
 *
 *  - the tab-type registry is provided **after** the seat exists, so registration
 *    waits on it with `ctx.inject`;
 *  - both tab slots go through `ctx.slots.inject`, because a child slot only
 *    exists while its owning entry is mounted.
 *
 * @module dsh-drawing/client
 */

import { Panel } from './Panel.jsx'
import { Title } from './Title.jsx'
import { Controller } from './controller.jsx'
import { ensureStyle } from './style.js'
import { NS, en, zh } from './locales.js'

/** Package name. Also the tab-type id and the body seat's key — they must agree. */
export const ID = 'dsh-drawing'

/** A fresh kind, so the type cannot collide with the shipped tab types. */
const KIND = 'drawing'

/** Cordis services this plugin waits for before its body runs. */
export const inject = ['slots', 'sessions', 'locale', 'remote', 'remote.workspaceFiles']

/** Read one file whole; text for JSON, bytes for images and PDFs. */
async function readFile(context, sessionId, path, signal) {
  try {
    const answer = await context.remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
    if (answer?.ok !== true) return { ok: false, code: answer?.error?.code ?? 'gateway/internal' }
    const data = answer.value?.data
    if (!(data instanceof Uint8Array)) return { ok: false, code: 'workspace-file/not-bytes' }
    return { ok: true, data }
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

  // The controller first: it is what makes the agent's request visible.
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            // A list slot addresses its entries by `id`.
            id: 'drawing-controller',
            order: 40,
            locale: NS,
            inject: (sessionId) => ({
              t,
              kind: KIND,
              ctx,
              readTextFile: async (path, signal) => {
                const answer = await readFile(ctx, sessionId, path, signal)
                if (answer.ok !== true) return { ok: false, code: answer.code }
                return { ok: true, text: new TextDecoder('utf-8').decode(answer.data) }
              },
            }),
          },
          Controller,
        ),
      ),
    `${ID}: controller`,
  )

  // The body goes first among the tab seats: it is what the tab is for.
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
              readTextFile: async (path, signal) => {
                const answer = await readFile(ctx, sessionId, path, signal)
                if (answer.ok !== true) return { ok: false, code: answer.code }
                return { ok: true, text: new TextDecoder('utf-8').decode(answer.data) }
              },
              readBytes: async (path, signal) => {
                const answer = await readFile(ctx, sessionId, path, signal)
                return answer.ok === true ? answer.data : undefined
              },
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
