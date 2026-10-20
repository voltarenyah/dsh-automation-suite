/**
 * The TIA console's state machine, folded from the session's event window.
 *
 * Why the session events and not the controller: the bar must reflect every
 * trigger — a model tool call, a `/tia-…` command, or a button that dispatches
 * one of those commands — and all three write a durable event into the session.
 * The event window is the one live source a browser plugin can read without a
 * host service (Step 1); the refresh button re-syncs the derived state with the
 * controller through `/tia-info`.
 *
 * Everything here is pure so `test/model.test.mjs` can drive it with fixtures.
 *
 * @module dsh-ui-tia-console/model
 */

/** Slash commands that touch TIA Portal. */
export const TIA_COMMAND_NAMES = [
  'tia-open',
  'tia-save',
  'tia-compile',
  'tia-close',
  'tia-info',
  'tia-find',
  'tia-status',
]

/** Model-facing tool names that touch TIA Portal. */
export const TIA_TOOL_NAMES = [
  'open_project',
  'export_blocks',
  'import_blocks',
  'compile_plc',
  'close_project',
  'create_project',
  'save_project',
  'archive_project',
  'project_info',
  'project_languages',
  'project_texts',
  'update_project',
  'portal_settings',
  'list_plc_objects',
  'create_plc_objects',
  'delete_plc_objects',
  'write_tags',
  'set_block_attributes',
  'protect_blocks',
  'generate_source',
  'watch_and_force_tables',
  'software_units',
  'safety_status',
  'set_safety_settings',
  'safety_signatures',
  'controller_status',
]

/** Operation descriptors for the commands: the phase it puts the bar in, and its label key. */
const COMMAND_OPS = {
  'tia-open': { phase: 'opening', label: 'op.open' },
  'tia-save': { phase: 'saving', label: 'op.save' },
  'tia-compile': { phase: 'compiling', label: 'op.compile' },
  'tia-close': { phase: 'closing', label: 'op.close' },
  'tia-info': { phase: 'busy', label: 'op.refresh' },
  'tia-find': { phase: 'busy', label: 'op.query' },
  'tia-status': { phase: 'busy', label: 'op.status' },
}

/** Operation descriptors for the model tools. */
const TOOL_OPS = {
  open_project: { phase: 'opening', label: 'op.open' },
  create_project: { phase: 'opening', label: 'op.create' },
  close_project: { phase: 'closing', label: 'op.close' },
  save_project: { phase: 'saving', label: 'op.save' },
  compile_plc: { phase: 'compiling', label: 'op.compile' },
  export_blocks: { phase: 'busy', label: 'op.export' },
  import_blocks: { phase: 'busy', label: 'op.import' },
  project_info: { phase: 'busy', label: 'op.query' },
  list_plc_objects: { phase: 'busy', label: 'op.query' },
  controller_status: { phase: 'busy', label: 'op.status' },
}

const UNKNOWN_OP = { phase: 'busy', label: 'op.busy' }

const PHASES_BUSY = new Set(['opening', 'saving', 'compiling', 'closing', 'busy'])

/**
 * @param {unknown} name - event operation name.
 * @returns {boolean} whether it is a TIA slash command.
 */
export function isTiaCommand(name) {
  return typeof name === 'string' && TIA_COMMAND_NAMES.includes(name)
}

/**
 * @param {unknown} name - event operation name.
 * @returns {boolean} whether it is a TIA model tool.
 */
export function isTiaTool(name) {
  return typeof name === 'string' && TIA_TOOL_NAMES.includes(name)
}

/**
 * Whether this session is a subagent's. Subagent sessions carry a `subagent`
 * address in their snapshot; the console belongs to the main agent only.
 * @param {{ subagent?: unknown } | null | undefined} session - session snapshot.
 * @returns {boolean} true for a subagent session.
 */
export function isSubagentSession(session) {
  return session != null && session.subagent != null
}

/**
 * @param {string} phase - console phase.
 * @returns {boolean} whether an operation is in flight.
 */
export function isBusyPhase(phase) {
  return PHASES_BUSY.has(phase)
}

/**
 * Format a running operation's elapsed time.
 * @param {number} milliseconds - elapsed milliseconds.
 * @returns {string} `42s` or `1:42`.
 */
export function formatElapsed(milliseconds) {
  const total = Math.max(0, Math.floor((Number.isFinite(milliseconds) ? milliseconds : 0) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`
}

/** @param {unknown} value - any text-ish value. @returns {string} its first line. */
export function firstLine(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const index = text.indexOf('\n')
  return (index < 0 ? text : text.slice(0, index)).trim()
}

/**
 * Extract the stable error code from a rendered tool/command failure.
 * @param {string} text - rendered outcome text.
 * @returns {string | null} the code, or null.
 */
export function errorCodeOf(text) {
  const match = /Error code:\s*([A-Za-z0-9_]+)/.exec(typeof text === 'string' ? text : '')
  return match === null ? null : match[1]
}

/**
 * Extract the project's name and path from a rendered tool/command outcome.
 * Both renderers print `Project: <name> (<path>)`.
 * @param {string} text - rendered outcome text.
 * @returns {{ name: string | null, path: string | null }} what could be read.
 */
export function parseProjectText(text) {
  const value = typeof text === 'string' ? text : ''
  const withPath = /^\s*Project:\s*(.+?)\s*\((.+)\)\s*$/m.exec(value)
  if (withPath !== null) return { name: withPath[1].trim(), path: withPath[2].trim() }

  const opened = /^\s*Opened\s+(.+?)\s+—/m.exec(value)
  if (opened !== null) return { name: opened[1].trim(), path: null }

  const info = /^\s*Project\s+(.+?)\s+—/m.exec(value)
  if (info !== null) return { name: info[1].trim(), path: null }

  const bare = /^\s*Project:\s*(.+?)\s*$/m.exec(value)
  if (bare !== null) return { name: bare[1].trim(), path: null }

  return { name: null, path: null }
}

/**
 * Extract the compile result from a rendered tool/command outcome.
 * @param {string} text - rendered outcome text.
 * @returns {{ state: string | null, errors: number, warnings: number } | null} the result, or null.
 */
export function parseCompileText(text) {
  const value = typeof text === 'string' ? text : ''

  const body = /Compile state:\s*([^,\n]+),\s*errors:\s*(\d+),\s*warnings:\s*(\d+)/.exec(value)
  if (body !== null) {
    return { state: body[1].trim(), errors: Number(body[2]), warnings: Number(body[3]) }
  }

  const clean = /Compile\s+[^\n:]+:\s*no errors\s*\((\d+)\s*warning\(s\)\)/.exec(value)
  if (clean !== null) return { state: 'Success', errors: 0, warnings: Number(clean[1]) }

  const broken = /Compile\s+[^\n:]+:\s*(\d+)\s*error\(s\),\s*(\d+)\s*warning\(s\)/.exec(value)
  if (broken !== null) return { state: 'Error', errors: Number(broken[1]), warnings: Number(broken[2]) }

  return null
}

/**
 * Render one tool-result content value as text.
 * @param {unknown} content - a string, a content-block array, or a single block.
 * @returns {string} the joined text.
 */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block !== null && typeof block === 'object' && typeof block.text === 'string') return block.text
        return ''
      })
      .join('\n')
  }
  if (content !== null && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

/** The initial, empty console state. */
export function initialState() {
  return {
    /** unknown | unavailable | idle | opening | open | saving | compiling | closing | busy */
    phase: 'unknown',
    /** The operation in flight, or null. */
    operation: null,
    /** The project the bar believes is open, or null. */
    project: null,
    /** The last compile result, or null. */
    compile: null,
    /** The last failure, or null. */
    lastError: null,
    /** The last settled result (command text or tool text), or null. */
    lastResult: null,
    /** When the project was last saved, or null. */
    savedAt: null,
    /** Epoch ms of the last state change. */
    updatedAt: 0,
  }
}

/**
 * Start one operation and mark it in flight.
 * @param {object} state - mutable fold state.
 * @param {Map<string, object>} pending - in-flight operations by id.
 * @param {string} id - command id or tool call id.
 * @param {'command'|'tool'} kind - event family.
 * @param {string} name - operation name.
 * @param {{ phase: string, label: string }} op - phase and label.
 * @param {number} at - event time.
 */
function begin(state, pending, id, kind, name, op, at) {
  pending.set(id, { kind, name, op, startedAt: at })
  state.operation = { kind, name, phase: op.phase, label: op.label, startedAt: at }
  state.phase = op.phase
  state.lastError = null
  state.updatedAt = at
}

/**
 * Apply one successful operation to the persistent state.
 * @param {object} state - mutable fold state.
 * @param {{ name: string }} run - the operation that settled.
 * @param {string} text - rendered outcome text.
 * @param {number} at - event time.
 */
function applySuccess(state, run, text, at) {
  switch (run.name) {
    case 'tia-open':
    case 'open_project':
    case 'create_project': {
      const project = parseProjectText(text)
      // A successful open always names the project. Without a name there is
      // nothing to conclude — fabricating an empty project here is exactly how
      // the bar used to show "TIA open" with no project at all.
      if (project.name === null && project.path === null) break
      state.project = {
        name: project.name ?? state.project?.name ?? null,
        path: project.path ?? state.project?.path ?? null,
        since: at,
        modified: false,
      }
      state.compile = null
      break
    }
    case 'tia-info':
    case 'project_info': {
      const project = parseProjectText(text)
      if (project.name === null && project.path === null) break
      state.project = {
        name: project.name ?? state.project?.name ?? null,
        path: project.path ?? state.project?.path ?? null,
        since: state.project?.since ?? null,
        modified: state.project?.modified ?? null,
      }
      break
    }
    case 'tia-close':
    case 'close_project': {
      state.project = null
      state.compile = null
      break
    }
    case 'tia-save':
    case 'save_project': {
      state.savedAt = at
      if (state.project !== null) state.project = { ...state.project, modified: false }
      break
    }
    case 'tia-compile':
    case 'compile_plc': {
      const compile = parseCompileText(text)
      if (compile !== null) state.compile = { at, ...compile }
      break
    }
    default:
      break
  }
}

/**
 * Settle one operation and derive the resting phase.
 * @param {object} state - mutable fold state.
 * @param {{ name: string }} run - the operation that settled.
 * @param {string} kind - `success` or `error`.
 * @param {string} text - rendered outcome text.
 * @param {number} at - event time.
 */
function settle(state, run, kind, text, at) {
  state.operation = null
  state.updatedAt = at

  // A model-facing tool returns its canonical value even when the operation
  // failed, so the `tool/result` carries `isError: false` while the rendered
  // text says "ProjectInfo FAILED." and names an `Error code:`. Trust the text:
  // otherwise a failed `project_info` is read as a successful open project.
  const failed = kind !== 'success' || errorCodeOf(text) !== null || /^\s*\S+ FAILED\./m.test(text)
  state.lastResult = { at, kind: failed ? 'error' : 'success', text }

  if (failed) {
    const code = errorCodeOf(text)

    // A refresh (or project_info) that reports "no project" answered the
    // question; it is the resting state, not a failure the user should see.
    if (code === 'project_not_open' && (run.name === 'tia-info' || run.name === 'project_info')) {
      state.project = null
      state.compile = null
      state.phase = 'idle'
      return
    }

    state.lastError = { at, code, text: firstLine(text) || text }

    if (code === 'project_not_open') {
      state.project = null
      state.compile = null
    } else if (code === 'project_already_open' && state.project === null) {
      // The controller says a project is open, but this event does not say which.
      state.project = { name: null, path: null, since: null, modified: null }
    } else if (
      code === 'controller_not_found' ||
      code === 'controller_exited' ||
      code === 'controller_spawn_failed' ||
      code === 'openness_unavailable' ||
      code === 'openness_load_failed'
    ) {
      state.phase = 'unavailable'
      return
    }

    state.phase = state.project !== null ? 'open' : 'idle'
    return
  }

  applySuccess(state, run, text, at)
  if (state.phase === 'unavailable') return
  state.phase = state.project !== null ? 'open' : 'idle'
}

/**
 * Fold one session event window into the console state.
 * @param {readonly { type: string, event?: { type: string, time?: number, data?: object } }[]} entries - window entries.
 * @returns {object} the derived state.
 */
export function foldTiaState(entries) {
  const state = initialState()
  /** In-flight operations by command id / tool call id. */
  const pending = new Map()

  for (const entry of entries ?? []) {
    if (entry === null || typeof entry !== 'object' || entry.type !== 'event') continue
    const event = entry.event
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    const at = typeof event.time === 'number' ? event.time : 0
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}

    switch (event.type) {
      case 'command/run': {
        const name = data.name
        if (!isTiaCommand(name)) break
        begin(state, pending, String(data.commandId), 'command', name, COMMAND_OPS[name] ?? UNKNOWN_OP, at)
        break
      }
      case 'command/done': {
        const run = pending.get(String(data.commandId))
        if (run === undefined) break
        pending.delete(String(data.commandId))
        settle(state, run, String(data.kind), typeof data.text === 'string' ? data.text : '', at)
        break
      }
      case 'tool/call': {
        const name = data.name
        if (!isTiaTool(name)) break
        begin(state, pending, String(data.callId), 'tool', name, TOOL_OPS[name] ?? UNKNOWN_OP, at)
        break
      }
      case 'tool/result': {
        const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
        const source = message.source !== null && typeof message.source === 'object' ? message.source : {}
        const run = pending.get(String(source.callId))
        if (run === undefined) break
        pending.delete(String(source.callId))
        const first = Array.isArray(message.content) ? message.content[0] : undefined
        const text = textOfContent(first?.content)
        settle(state, run, first?.isError === true ? 'error' : 'success', text, at)
        break
      }
      default:
        break
    }
  }

  // Queued operations: the oldest pending one is the next to run.
  if (state.operation === null && pending.size > 0) {
    const [next] = pending.values()
    state.operation = { ...next.op, kind: next.kind, name: next.name, startedAt: next.startedAt }
    state.phase = next.op.phase
  }

  return state
}
