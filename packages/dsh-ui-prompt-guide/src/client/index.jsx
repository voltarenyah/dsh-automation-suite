/**
 * Browser half: one entry in the main sidebar and its full-page panel.
 *
 * This is the same injection shape as `dsh-guizang-design` (the plugin whose
 * sidebar page this one copies), and it is worth naming the four seats it uses:
 *
 *  - `sidebar.panellist` — a **root list** seat: one row (icon + label) in the
 *    narrow left rail. Registration is `{ id, order, label }`; the label is a
 *    thunk so it can follow the app's language without re-registering.
 *  - `main` — a **root keyed** seat: the full-area panel, keyed by the same id.
 *    Clicking the rail row selects that key.
 *  - `theme` — injected lazily (`ctx.inject(['theme'], …)`) because the service
 *    can arrive after this plugin; the current color scheme is forwarded into
 *    the iframe and every later change is forwarded too.
 *  - `uiWorkspace.startSession` — the page posts
 *    `{ type: 'prompt-guide:start', prompt }` and this half opens a new session
 *    with the prompt pre-filled (not sent). Same-origin and source checks gate
 *    the message, so a random frame cannot drive the session.
 *
 * The page itself is served by the host half at `/prompt-guide/`; this bundle
 * only frames it. Registration failures are logged, never thrown: one broken
 * seat must not take the rest of the client down.
 *
 * @module dsh-ui-prompt-guide/client
 */

import { createElement, useEffect, useRef } from 'react'

import { NS, zh, en } from './locales.js'

/** Package name; also the panel id and the `main` seat key — they must agree. */
export const ID = 'dsh-ui-prompt-guide'

/** Panel id used by both root seats. */
const PANEL = 'prompt-guide'

/** Where the host half serves the page. */
const SRC = '/prompt-guide/'

/** Services this plugin waits for before its body runs. */
export const inject = ['slots', 'uiWorkspace', 'locale']

/** The rail row must sit after the shipped entries (Plugins is below 6). */
const ORDER = 7

/**
 * The sidebar icon: a speech bubble over an open page — "the prompts are here".
 *
 * @param {{ size?: number }} props - seat-provided sizing.
 */
function GuideIcon(props) {
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
    createElement('path', { d: 'M4 4.75h11.5a1.75 1.75 0 0 1 1.75 1.75v6.5a1.75 1.75 0 0 1-1.75 1.75H9l-3.6 3v-3H4a1.75 1.75 0 0 1-1.75-1.75V6.5A1.75 1.75 0 0 1 4 4.75Z' }),
    createElement('path', { d: 'M8 9h6M8 12h3.5' }),
  )
}

/**
 * Client plugin body.
 *
 * @param {any} ctx - client root context.
 */
export function apply(ctx) {
  const frames = new Set()
  let scheme = null

  // Dictionaries first: the rail label and the iframe's accessible name both
  // resolve through the locale service, and registration after mount still
  // takes effect (renderers re-resolve the label thunk on locale change).
  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${ID}: dictionaries`)
  } catch (error) {
    ctx.logger?.warn?.(`${ID}: dictionary registration failed: ${String(error)}`)
  }

  /** Resolve one dictionary key; undefined keeps the English fallback working. */
  const translate = (key) => {
    try {
      const value = ctx.locale.bind(NS)(key)
      // A missing dictionary falls back to printing the key itself, which is not
      // a label. Treat that as "unknown" so the caller's fallback wins.
      return typeof value === 'string' && value !== key ? value : undefined
    } catch {
      return undefined
    }
  }

  /** Push the current scheme into one frame, if the page is ready for it. */
  const post = (frame) => {
    if (scheme === null || !frame || !frame.contentWindow) return
    frame.contentWindow.postMessage({ type: `prompt-guide:scheme`, scheme }, location.origin)
  }

  // The theme service may be absent (older shell) or arrive later; never let a
  // missing palette block the page itself.
  try {
    ctx.inject(['theme'], (injected) => {
      const push = (snapshot) => {
        scheme = snapshot?.active?.colorScheme ?? null
        frames.forEach(post)
      }
      try {
        push(injected.theme.getTheme())
        injected.on('theme/change', push)
      } catch (error) {
        ctx.logger?.warn?.(`${ID}: reading the theme failed: ${String(error)}`)
      }
    })
  } catch (error) {
    ctx.logger?.warn?.(`${ID}: the theme service is unavailable: ${String(error)}`)
  }

  /** The full-page panel: one iframe, one message bridge. */
  function GuidePanel() {
    const ref = useRef(null)

    useEffect(() => {
      const self = ref.current
      if (self) frames.add(self)

      function onMessage(event) {
        const frame = ref.current
        if (!frame || event.source !== frame.contentWindow) return
        if (event.origin !== location.origin) return
        const message = event.data
        if (!message || typeof message !== 'object') return
        if (message.type !== 'prompt-guide:start' || typeof message.prompt !== 'string') return
        try {
          ctx.uiWorkspace.startSession(undefined, { prompt: message.prompt, whenDraftExists: 'replace' })
          frame.contentWindow.postMessage({ type: 'prompt-guide:start-ok' }, location.origin)
        } catch (error) {
          ctx.logger?.warn?.(`${ID}: opening a session failed: ${String(error)}`)
          frame.contentWindow.postMessage(
            { type: 'prompt-guide:start-failed', message: String((error && error.message) || error) },
            location.origin,
          )
        }
      }

      addEventListener('message', onMessage)
      return () => {
        removeEventListener('message', onMessage)
        frames.delete(self)
      }
    }, [])

    return createElement('iframe', {
      ref,
      src: SRC,
      title: translate('iframe.title') ?? 'Prompt Guide',
      allow: 'fullscreen',
      onLoad: (event) => post(event.currentTarget),
      style: { width: '100%', height: '100%', border: 0, display: 'block' },
    })
  }

  try {
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: PANEL,
          order: ORDER,
          label: () => translate('label') ?? 'Prompt Guide',
          locale: NS,
        },
        GuideIcon,
      ),
    )
  } catch (error) {
    ctx.logger?.warn?.(`${ID}: the sidebar entry could not be registered: ${String(error)}`)
  }

  try {
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: NS }, GuidePanel))
  } catch (error) {
    ctx.logger?.warn?.(`${ID}: the main panel could not be registered: ${String(error)}`)
  }
}
