/**
 * Host half of the plugin.
 *
 * The browser half inserts `@'NAME'` into the composer; this half is what makes
 * that token mean something to the model. At `agent/pre-step` — the waterfall
 * the built-in session references also use — it looks for those tokens in the
 * direct user messages of the step, resolves each name against the workspace
 * `source/` manifests, and appends one text block of machine-readable context to
 * the citing message.
 *
 * Why here rather than in the page: DSH has no "visible to the model only"
 * channel on the composer, so the browser can either write the reference into
 * the input box (noisy, and the user asked for a bare mention) or the host can
 * add it to the request. Appending a content block keeps the request shape the
 * one every user message already has — no new message kind, no new event.
 *
 * The listing is cached per workspace root and re-read once when a name misses,
 * so a typo costs one directory walk instead of one per keystroke, while a block
 * exported since the last read is still found. Failures are contained: a plugin
 * must never turn a broken manifest into a failed turn.
 *
 * @module dsh-ui-plc-source
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  MANIFEST_FILE,
  SOURCE_DIRECTORY,
  mentionContext,
  mentionNames,
  parseManifest,
  type SourceRow,
} from './model.js'

/** Cordis plugin name, kept in step with the row id in `cordis.patch.yml`. */
export const name = 'ui-plc-source'

/** One content block of a user message, as the request carries it. */
export interface HostContentBlock {
  readonly type: string
  readonly text?: string
}

/** One message entering the model step. Only the fields this plugin reads. */
export interface HostMessage {
  readonly source?: { readonly kind?: string }
  readonly content?: readonly HostContentBlock[]
}

/** The `agent/pre-step` payload, narrowed to what is used here. */
export interface PreStepPayload {
  readonly agent?: {
    readonly session?: { readonly header?: { readonly cwd?: string } }
  }
}

/** What a pre-step listener returns: either a rejection or the messages to send. */
export interface PreStepDecision {
  readonly kind?: string
  readonly messages?: readonly HostMessage[]
}

/** The two seams the resolution needs, so tests can drive it without a disk. */
export interface MentionSource {
  /** Read rows, normally from cache. */
  readonly read: (sourceRoot: string) => Promise<readonly SourceRow[]>
  /** Drop the cache for one root and read it again. */
  readonly refresh: (sourceRoot: string) => Promise<readonly SourceRow[]>
}

/** The slice of the cordis context this plugin uses. */
export interface HostContext {
  on(
    event: string,
    listener: (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>,
    options?: { readonly prepend?: boolean },
  ): unknown
  logger?: { warn?(message: string): void }
}

/** Parsed rows per workspace root; the key is the absolute `source/` path. */
const rowsByRoot = new Map<string, readonly SourceRow[]>()

/**
 * Turn every device manifest under one root into rows.
 *
 * A device whose manifest is missing or unparseable contributes nothing: the
 * mention resolution only needs names, and the tab already reports the
 * degradation, so repeating it in the prompt would be noise.
 *
 * @param sourceRoot - absolute path of the workspace's `source/`.
 * @returns every row the manifests described.
 */
async function readRoot(sourceRoot: string): Promise<readonly SourceRow[]> {
  const rows: SourceRow[] = []
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let text: string
    try {
      text = await readFile(join(sourceRoot, entry.name, MANIFEST_FILE), { encoding: 'utf8' })
    } catch {
      continue
    }
    const parsed = parseManifest(text, entry.name)
    if (parsed.ok === true) rows.push(...parsed.rows)
  }
  return rows
}

/** @returns the rows for one root, reading them on first use. */
async function cachedRoot(sourceRoot: string): Promise<readonly SourceRow[]> {
  const cached = rowsByRoot.get(sourceRoot)
  if (cached !== undefined) return cached
  const rows = await readRoot(sourceRoot)
  rowsByRoot.set(sourceRoot, rows)
  return rows
}

/** @returns the rows for one root, always re-read. */
async function freshRoot(sourceRoot: string): Promise<readonly SourceRow[]> {
  const rows = await readRoot(sourceRoot)
  rowsByRoot.set(sourceRoot, rows)
  return rows
}

/** The default source: process-lifetime cache, one miss-triggered reload. */
export const diskSource: MentionSource = { read: cachedRoot, refresh: freshRoot }

/** Forget every cached listing (used by tests and by a workspace switch). */
export function forgetListings(): void {
  rowsByRoot.clear()
}

/** @returns whether any row answers a cited name, case-insensitively. */
function hasName(rows: readonly SourceRow[], name: string): boolean {
  const needle = name.toLowerCase()
  return rows.some((row) => row.name.toLowerCase() === needle)
}

/**
 * Build the context block for one message's citations.
 *
 * @param cwd - the session workspace root.
 * @param names - names cited by the message, in citation order.
 * @param source - where the listings come from.
 * @returns the context text, or null when nothing could be said about them.
 */
export async function resolveMentionContext(
  cwd: string,
  names: readonly string[],
  source: MentionSource = diskSource,
): Promise<string | null> {
  if (names.length === 0) return null
  const sourceRoot = join(cwd, SOURCE_DIRECTORY)
  let rows = await source.read(sourceRoot)
  // A miss is the only signal that the cache may be behind: re-read once, then
  // let the miss stand rather than walking the tree on every step.
  if (names.some((name) => !hasName(rows, name))) rows = await source.refresh(sourceRoot)
  return mentionContext(names, rows, cwd)
}

/**
 * Append the mention context to each direct user message that cites a block.
 *
 * Only `source.kind === 'user'` messages are considered, the same rule the
 * session-reference resolver applies: injected context must never re-trigger a
 * mention, or a turn would keep quoting itself.
 *
 * @param messages - messages accepted by downstream pre-step listeners.
 * @param cwd - the session workspace root, when the session has one.
 * @param source - where the listings come from.
 * @returns the same messages, with one extra text block where a block was cited.
 */
export async function annotateMessages(
  messages: readonly HostMessage[],
  cwd: string | undefined,
  source: MentionSource = diskSource,
): Promise<readonly HostMessage[]> {
  if (typeof cwd !== 'string' || cwd.length === 0) return messages
  const annotated: HostMessage[] = []
  let changed = false
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : []
    const citing = message.source?.kind === 'user' && blocks.length > 0
    if (!citing) {
      annotated.push(message)
      continue
    }
    const text = blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('\n')
    const context = await resolveMentionContext(cwd, mentionNames(text), source)
    if (context === null) {
      annotated.push(message)
      continue
    }
    annotated.push({ ...message, content: [...blocks, { type: 'text', text: context }] })
    changed = true
  }
  return changed ? annotated : messages
}

/**
 * Register the pre-step listener.
 *
 * `prepend` plus `await next()` makes this the outermost listener: it sees the
 * messages every other listener has already accepted, so a rewritten message
 * from another plugin is annotated too, and a rejection is passed straight
 * through.
 *
 * @param ctx - host plugin context.
 */
export function apply(ctx: HostContext): void {
  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next()
      if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      try {
        const messages = await annotateMessages(decision.messages, payload?.agent?.session?.header?.cwd)
        return messages === decision.messages ? decision : { ...decision, messages }
      } catch (error) {
        // A broken source tree must not fail the turn it was mentioned in.
        ctx.logger?.warn?.(`ui-plc-source: block mentions were not annotated: ${String(error)}`)
        return decision
      }
    },
    { prepend: true },
  )
}
