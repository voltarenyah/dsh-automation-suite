/**
 * Browser half of the TIA console.
 *
 * Registers one `conversation.input.dock` occupant: the bar above the composer.
 * Everything cross-package stays on the sanctioned channels — the `slots`
 * service for the seat, the `sessions` service for the session's event window
 * and its `command(line)` verb, and `locale` for the copy. No host service and
 * no model message is involved.
 *
 * @module dsh-ui-tia-console/client
 */

import { TiaBar } from './TiaBar.jsx'
import { ensureStyle } from './style.js'
import { NS, en, zh } from './locales.js'

/** Package name; also the slot key, so a second registration cannot collide. */
export const ID = 'dsh-ui-tia-console'

/** Client services this plugin waits for before its body runs. */
export const inject = ['slots', 'sessions', 'locale']

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

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${ID}: dictionaries`)
  const t = ctx.locale.bind(NS)

  ctx.effect(
    () =>
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            // A list slot addresses its entries by `id` (a single slot uses `key`).
            id: 'tia-console',
            order: 30,
            locale: NS,
            inject: (sessionId) => ({
              t,
              // The binding appears with the session's scope; resolve lazily so a
              // session that is still being staged recovers on the next render.
              eventSource: () => ctx.sessions?.binding?.(sessionId)?.eventSource,
              runCommand: (line) => {
                const binding = ctx.sessions?.binding?.(sessionId)
                if (binding === undefined) {
                  return Promise.resolve({
                    ok: false,
                    error: { code: 'session/unbound', message: 'this session is not bound yet' },
                  })
                }
                return binding.session.command(line)
              },
            }),
          },
          TiaBar,
        ),
      ),
    `${ID}: console bar`,
  )
}
