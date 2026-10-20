/**
 * Browser half: one right-sidebar tab type ("PLC Blocks") and its body.
 *
 * Everything cross-package stays on the three sanctioned channels: Cordis
 * services (`slots`, `remote.workspaceFiles`), slot registrations, and `import
 * type`. No feature plugin's values are imported at runtime, and the bundle
 * requests nothing beyond the shell's frozen platform table.
 *
 * Two registration details are load-bearing:
 *
 *  - The tab-type registry is provided **after** the seat that declares
 *    `sidebar.right.pane.tab`, so `ctx.sidebarRightTabs` is not readable at
 *    `apply` time. The registration therefore waits on the service with
 *    `ctx.inject([...])` instead of reading the property directly.
 *  - Both slot registrations go through `ctx.slots.inject`, because a child slot
 *    only exists while its owning entry is mounted and a bare `register` throws.
 *
 * @module dsh-ui-plc-source/client
 */

import { Panel } from './Panel.jsx'
import { BlockMention } from './Mention.jsx'
import { Title } from './Title.jsx'
import { createPlcStore } from './store.js'
import { ensureStyle } from './style.js'
import { NS, en, zh } from './locales.js'
import { nextMention } from '../model'

/** Package name. Also the tab-type id and the body seat's key — they must agree. */
export const ID = 'dsh-ui-plc-source'

/** A fresh kind, so the type cannot collide with the shipped files/browser/terminal types. */
const KIND = 'plc-source'

/** Cordis services this plugin waits for before its body runs. */
export const inject = ['slots', 'sessions', 'locale', 'remote', 'remote.workspaceFiles']

/**
 * The user-text rule that gives `@'NAME'` a chip in the transcript.
 *
 * `order: 5` outranks the file grammar (30) and the session grammar (10): all
 * three would match this spelling, and only the lowest order may claim a span.
 * Without it the file rule wins and a mention renders as a file that cannot be
 * opened. The grammar itself lives in the pure core, where the host half reads
 * the same tokens.
 */
const BLOCK_MENTION_RULE = {
  id: 'plc-block',
  order: 5,
  match(text, from) {
    const hit = nextMention(text, from)
    if (hit === undefined) return undefined
    return { id: 'plc-block', start: hit.start, end: hit.end, data: { name: hit.name } }
  },
}

/**
 * Drop a mention into one session's composer.
 *
 * The composer is owned by `ui-conversation`, reachable from the session scope as
 * `conversation`; its input face is the only supported writer, and `insertText`
 * is preferred over `setDraft` because the latter replaces the whole document
 * (and with it any reference chips already in it). When the machine is mid-submit
 * the insert is refused, and saying so beats silently rewriting the draft.
 *
 * @param ctx - client root context.
 * @param sessionId - the session the tab belongs to.
 * @param text - the mention token to insert.
 * @param translate - the bound translator, for the failure notice.
 * @returns whether the composer took the text.
 */
function insertMention(ctx, sessionId, text, translate) {
  let shell
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined || actx === null) throw new Error('no session scope')
    const conversation = actx.get('conversation')
    if (conversation === undefined || conversation === null) throw new Error('no conversation service')
    shell = conversation.input.for(actx)
  } catch (error) {
    ctx.logger?.warn?.(`${ID}: the composer is unavailable: ${String(error)}`)
    return { ok: false, code: 'unavailable' }
  }
  try {
    // The insertion verbs live on the shell's action face; `notify`/`focus` are
    // the shell's own. `insertText` is preferred over `setDraft` because the
    // latter replaces the whole document, and with it any reference chips.
    const actions = shell?.actions ?? {}
    const draft = typeof shell?.projection?.clipboardText === 'string' ? shell.projection.clipboardText : ''
    // A mention is its own paragraph: appending it to a half-typed sentence would
    // put it inside that sentence, and the host grammar requires a word boundary.
    const separator = draft.length === 0 || draft.endsWith('\n') ? '' : '\n'
    const span = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : undefined
    const inserted =
      span !== undefined &&
      typeof actions.insertText === 'function' &&
      actions.insertText(`${separator}${text}`, span) === true
    if (!inserted) {
      shell.notify?.('error', translate('mention.failed'))
      return { ok: false, code: 'refused' }
    }
    if (typeof shell.focus === 'function') shell.focus()
    return { ok: true }
  } catch (error) {
    ctx.logger?.warn?.(`${ID}: the mention could not be inserted: ${String(error)}`)
    return { ok: false, code: 'failed' }
  }
}


/**
 * Normalize one `workspaceFiles.list` answer for the panel.
 *
 * @param {any} context - client root context.
 * @param {string} sessionId - the session the tab belongs to.
 * @param {string} path - absolute directory path.
 * @param {AbortSignal | undefined} signal - aborts with the tab.
 * @returns {Promise<{ ok: true, entries: any[], truncated: boolean } | { ok: false, code: string }>}
 */
async function listDirectory(context, sessionId, path, signal) {
  try {
    const answer = await context.remote.workspaceFiles.list(sessionId, path, signal)
    if (answer?.ok === true) {
      const value = answer.value ?? {}
      return {
        ok: true,
        entries: Array.isArray(value.entries) ? value.entries : [],
        truncated: value.truncated === true,
      }
    }
    return { ok: false, code: answer?.error?.code ?? 'gateway/internal' }
  } catch {
    return { ok: false, code: 'gateway/internal' }
  }
}

/**
 * Read one UTF-8 text file whole. `readBytes` is the right call here: the
 * manifest is pretty-printed JSON whose 17 464 lines would need four paginated
 * `read` calls, while one whole-file read costs a single round trip and stays
 * under the 32 MiB complete-file cap.
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

  // Dictionaries first: registration is what lets the labels below translate at
  // all, and a dictionary registered after the UI mounts still takes effect.
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
            // A thunk, not a string: the registry holds the function, so the chip
            // and the guide capsule follow the active locale without a reload.
            title: () => t('tab.title'),
            // `order` only sorts the guide-page entries; 100 keeps this one last.
            guide: [
              {
                id: KIND,
                order: 100,
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

  // One handle, created in the apply world; the framework then makes one store
  // instance per session scope, which is what survives a tab switch.
  const store = createPlcStore()

  // The body goes first: it is what the tab is for, so nothing decorative may
  // be able to take it down with it.
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: ID,
            store,
            // Declares which namespace the framework's `t` seat translates for
            // this body; the bound function travels through inject as well, since
            // its identity is stable per namespace.
            locale: NS,
            inject: (sessionId) => ({
              t,
              mention: (text) => insertMention(ctx, sessionId, text, t),
              listDirectory: (path, signal) => listDirectory(ctx, sessionId, path, signal),
              readTextFile: (path, signal) => readTextFile(ctx, sessionId, path, signal),
            }),
          },
          Panel,
        ),
      ),
    `${ID}: tab body`,
  )

  // The chip is rendered by a seat of its own, because a tab record freezes the
  // title text it was opened with; the seat is what keeps it following the locale.
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

  // A mention is plain prompt text, but the transcript still has to render it:
  // the file grammar matches the same `@…` shape, so without this rule the chip
  // would be a file path that no viewer can open.
  ctx.effect(
    () =>
      ctx.inject(['uiConversation'], (injected) => {
        const conversation = typeof injected?.get === 'function' ? injected.get('uiConversation') : undefined
        if (conversation?.userText === undefined) return () => {}
        return conversation.userText.register(BLOCK_MENTION_RULE)
      }),
    `${ID}: block mention rule`,
  )

  ctx.effect(
    () =>
      ctx.slots.inject('conversation.user.text.node', () =>
        ctx.slots.register(
          { name: 'conversation.user.text.node', key: 'plc-block', priority: 100, locale: NS },
          BlockMention,
        ),
      ),
    `${ID}: block mention chip`,
  )
}
