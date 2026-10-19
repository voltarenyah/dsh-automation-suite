/**
 * The human-facing slash commands (`/tia-…`) over the same controller seam the
 * model-facing tools use.
 *
 * DSH's command plane is a **direct** surface: a command line is parsed and run
 * by the host, and neither the line nor the result becomes a model message
 * (`@deepseek-ai/dsh-commands`). That shapes everything here:
 *
 *   - the handler gets one free-form `rawInput` line and must parse it itself;
 *   - the result is plain text, and only the first line is visible while the
 *     card is collapsed, so every command starts with a human headline;
 *   - there is no confirmation dialog, so the destructive variants are explicit
 *     flags (`--discard`) and the safe default wins (`/tia-close` saves);
 *   - a command must not start TIA Portal just to answer a question, so
 *     `/tia-status` reads the host row's snapshot (`controllerStatusOutcome`).
 *
 * The commands deliberately cover the operations a human drives by hand with a
 * path or a name. Structured writes (tags, attributes, imports, deletes) stay
 * model-facing tools: they need a dry run and a reviewer, which a one-line
 * command cannot provide.
 *
 * @module dsh-tia-openness-v17-min/commands
 */

import { existsSync, type Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import type { JsonRecord, ToolOutcome } from './protocol.js'
import {
  controllerStatusOutcome,
  renderOutcome,
  renderOutcomeBody,
  runOperation,
  type ToolDependencies,
} from './tools.js'

// --------------------------------------------------------------- payload access

/**
 * The tiny payload readers the renderers need. They mirror the private helpers
 * in `tools.ts`; the two modules format the same controller payloads, and
 * sharing a helper module would add an import hop for eight one-line functions.
 */
function record(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function field(data: JsonRecord | null, ...path: string[]): unknown {
  let current: unknown = data
  for (const key of path) {
    const container = record(current)
    if (container === null) return undefined
    current = container[key]
  }
  return current
}

// --------------------------------------------------------------------- parsing

/** One parsed command line: `--flag` tokens and everything else, in order. */
interface ParsedInput {
  readonly flags: ReadonlySet<string>
  readonly positionals: readonly string[]
}

/**
 * Splits a command line into tokens, honoring single and double quotes.
 *
 * Quoting is not cosmetic on Windows: a project directory or a block name can
 * contain spaces, and a slash command has no other way to say where a token
 * ends. Flags are recognized only after tokenization, so a quoted `--x` stays a
 * literal argument.
 *
 * @param rawInput - the text after the command name.
 * @returns the tokens, in order.
 * @throws when a quote is left open.
 */
function tokenize(rawInput: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (const character of rawInput) {
    if (quote !== null) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      started = true
      continue
    }
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += character
    started = true
  }

  if (quote !== null) throw new Error('Unterminated quote in the command line.')
  if (started) tokens.push(current)
  return tokens
}

function parseInput(rawInput: string): ParsedInput {
  const flags = new Set<string>()
  const positionals: string[] = []
  for (const token of tokenize(rawInput)) {
    if (token.startsWith('--') && token.length > 2) flags.add(token.slice(2).toLowerCase())
    else positionals.push(token)
  }
  return { flags, positionals }
}

/** Rejects an option the command does not implement, with its usage line. */
function unknownOptions(parsed: ParsedInput, allowed: readonly string[], usage: string): DshCommandResult | null {
  for (const flag of parsed.flags) {
    if (!allowed.includes(flag)) return { kind: 'error', text: `Unknown option --${flag}.\n${usage}` }
  }
  return null
}

function usageError(usage: string): DshCommandResult {
  return { kind: 'error', text: usage }
}

/** Rejects arguments for a command that takes none. */
function noArguments(name: string, usage: string): DshCommandResult {
  return { kind: 'error', text: `/${name} takes no arguments.\n${usage}` }
}

// ------------------------------------------------------------- outcome rendering

/**
 * Converts a controller outcome into the card text: a human headline the
 * collapsed row shows, then the same detail the tools render.
 */
function accepted(outcome: ToolOutcome, headline: string, verbose: boolean): DshCommandResult {
  const body = renderOutcomeBody(outcome, verbose)
  return { kind: 'success', text: body.length === 0 ? headline : `${headline}\n${body}` }
}

/** A failed operation keeps the tool's structured error rendering. */
function refused(outcome: ToolOutcome, verbose: boolean): DshCommandResult {
  return { kind: 'error', text: renderOutcome(outcome, verbose) }
}

/** Wraps one handler so a transport failure or an abort settles as text. */
async function guard(run: () => Promise<DshCommandResult>, invocation: DshCommandInvocation): Promise<DshCommandResult> {
  try {
    return await run()
  } catch (error) {
    if (invocation.signal.aborted) return { kind: 'error', text: 'Cancelled.' }
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

// ------------------------------------------------------------ workspace project

/** The workspace project a command found, and how it was found. */
export interface WorkspaceProject {
  /** Absolute path of the `.ap17` file. */
  readonly path: string
  /** `index` = the engineering-context index; `scan` = one project under `tia/`. */
  readonly via: 'index' | 'scan'
}

/**
 * Reads the project the engineering-context tool saved into this workspace.
 *
 * Only `project.savedAs` is used: `project.path` is the **source** project the
 * workspace was created from, and a slash command must never open (and let TIA
 * write into) that one.
 *
 * @param workspaceRoot - the session working directory.
 * @returns the recorded saved path, or null when there is no usable index.
 */
async function recordedWorkspaceProject(workspaceRoot: string): Promise<string | null> {
  try {
    const raw = await readFile(join(workspaceRoot, 'source', '_dsh-engineering-context.json'), 'utf8')
    const parsed = JSON.parse(raw) as { project?: { savedAs?: unknown } }
    const savedAs = parsed.project?.savedAs
    return typeof savedAs === 'string' && savedAs.trim().length > 0 ? savedAs : null
  } catch {
    return null
  }
}

/**
 * Locates the TIA project this workspace owns.
 *
 * The index wins (it records the exact path TIA produced after the save-as),
 * and a scan of `tia/<name>/<name>.ap17` is the fallback for a workspace whose
 * index is missing or stale. Ambiguity is reported, never guessed.
 *
 * @param workspaceRoot - the session working directory.
 * @returns the project, or a human-readable reason it cannot be determined.
 */
export async function resolveWorkspaceProject(workspaceRoot: string): Promise<WorkspaceProject | { error: string }> {
  const recorded = await recordedWorkspaceProject(workspaceRoot)
  if (recorded !== null && existsSync(recorded)) return { path: recorded, via: 'index' }

  const tiaRoot = join(workspaceRoot, 'tia')
  let entries: Dirent[] = []
  try {
    entries = await readdir(tiaRoot, { withFileTypes: true })
  } catch {
    entries = []
  }

  const found: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(tiaRoot, entry.name)
    let files: Dirent[] = []
    try {
      files = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (file.isFile() && file.name.toLowerCase().endsWith('.ap17')) found.push(join(directory, file.name))
    }
  }

  if (found.length === 1 && found[0] !== undefined) return { path: found[0], via: 'scan' }
  if (found.length === 0) {
    return {
      error:
        `No TIA project under ${tiaRoot}. /tia-open only opens the project this workspace already owns; ` +
        'create one with create_engineering_project first.',
    }
  }
  return {
    error:
      `Several TIA projects under ${tiaRoot}:\n${found.map((file) => `  ${file}`).join('\n')}\n` +
      'Keep one, or open a specific project through the model with open_project.',
  }
}

/** The session working directory, which is the workspace root of every command. */
function sessionCwd(invocation: DshCommandInvocation): string | undefined {
  const cwd = invocation.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined
}

// ------------------------------------------------------------------- handlers

const USAGE_OPEN = 'Usage: /tia-open (no arguments — opens the project this workspace owns, in a visible TIA Portal)'
const USAGE_SAVE = 'Usage: /tia-save (no arguments — saves the open project in place)'
const USAGE_COMPILE = 'Usage: /tia-compile (no arguments — compiles the PLC software of the open project)'
const USAGE_STATUS = 'Usage: /tia-status (no arguments)'
const USAGE_CLOSE = 'Usage: /tia-close [--discard] [--portal] [--dry]'
const USAGE_INFO = 'Usage: /tia-info [attributes] [comment] [languages] [history] [products] [devices] [software] [settings]'
const USAGE_FIND = 'Usage: /tia-find [<substring>] [--blocks] [--types] [--tables] [--units] [--fp]'

/** Opens the workspace project in a **visible** TIA Portal instance. */
async function handleOpen(dependencies: ToolDependencies, invocation: DshCommandInvocation): Promise<DshCommandResult> {
  const parsed = parseInput(invocation.rawInput)
  if (parsed.flags.size > 0 || parsed.positionals.length > 0) return noArguments('tia-open', USAGE_OPEN)

  const workspaceRoot = sessionCwd(invocation)
  if (workspaceRoot === undefined) {
    return { kind: 'error', text: 'This session has no working directory, so the workspace project cannot be located.' }
  }
  const target = await resolveWorkspaceProject(workspaceRoot)
  if ('error' in target) return { kind: 'error', text: target.error }

  const outcome = await runOperation(
    dependencies,
    'OpenProject',
    { project_path: target.path, with_window: true },
    invocation.signal,
  )
  if (!outcome.ok) return refused(outcome, dependencies.verbose)

  const data = outcome.data ?? {}
  const software = record(data['plcSoftware'])
  const items = list(software?.['items'])
  const blocks = items.reduce<number>((total, item) => total + (numberOf(field(record(item), 'blockCount')) ?? 0), 0)
  const name = text(data['projectName']) ?? basename(target.path, '.ap17')
  const window = data['withUserInterface'] === true ? 'visible TIA Portal' : 'headless TIA Portal'
  return accepted(
    outcome,
    `Opened ${name} — ${items.length} PLC software, ${blocks} block(s), ${window}`,
    dependencies.verbose,
  )
}

/** Saves the open project in place. */
async function handleSave(dependencies: ToolDependencies, invocation: DshCommandInvocation): Promise<DshCommandResult> {
  const parsed = parseInput(invocation.rawInput)
  if (parsed.flags.size > 0 || parsed.positionals.length > 0) return noArguments('tia-save', USAGE_SAVE)

  const outcome = await runOperation(dependencies, 'SaveProject', {}, invocation.signal)
  if (!outcome.ok) return refused(outcome, dependencies.verbose)

  const data = outcome.data ?? {}
  const name = text(data['projectName']) ?? 'the open project'
  const modified = data['isModifiedBeforeSave'] === true ? 'yes' : 'no'
  return accepted(outcome, `Saved ${name} in place (modified before save: ${modified})`, dependencies.verbose)
}

/** Compiles the PLC software and reports the compiler result as data. */
async function handleCompile(dependencies: ToolDependencies, invocation: DshCommandInvocation): Promise<DshCommandResult> {
  const parsed = parseInput(invocation.rawInput)
  if (parsed.flags.size > 0 || parsed.positionals.length > 0) return noArguments('tia-compile', USAGE_COMPILE)

  const outcome = await runOperation(dependencies, 'CompilePlc', { max_messages: 50 }, invocation.signal)
  if (!outcome.ok) return refused(outcome, dependencies.verbose)

  const data = outcome.data ?? {}
  const errors = numberOf(data['errorCount']) ?? 0
  const warnings = numberOf(data['warningCount']) ?? 0
  const device = text(data['device'])
  const subject = device === undefined ? 'Compile' : `Compile ${device}`
  const headline =
    errors === 0
      ? `${subject}: no errors (${warnings} warning(s))`
      : `${subject}: ${errors} error(s), ${warnings} warning(s)`
  return accepted(outcome, headline, dependencies.verbose)
}

/**
 * Closes the open project.
 *
 * The tool defaults to a dry run because a model may not know whether the
 * project is saved; a human typing `/tia-close` does. Saving first is therefore
 * the default, `--discard` opts into the lossy variant, and `--dry` asks for the
 * report instead.
 */
async function handleClose(dependencies: ToolDependencies, invocation: DshCommandInvocation): Promise<DshCommandResult> {
  const parsed = parseInput(invocation.rawInput)
  if (parsed.positionals.length > 0) return usageError(USAGE_CLOSE)
  const invalid = unknownOptions(parsed, ['discard', 'save', 'portal', 'dry'], USAGE_CLOSE)
  if (invalid !== null) return invalid

  const discard = parsed.flags.has('discard')
  const save = parsed.flags.has('save')
  if (discard && save) return usageError('--discard and --save contradict each other.\n' + USAGE_CLOSE)
  const dry = parsed.flags.has('dry')
  if (dry && parsed.flags.has('portal')) return usageError('--dry cannot be combined with --portal.\n' + USAGE_CLOSE)

  const outcome = await runOperation(
    dependencies,
    'CloseProject',
    { save: !discard, close_portal: parsed.flags.has('portal'), dry_run: dry },
    invocation.signal,
  )
  if (!outcome.ok) return refused(outcome, dependencies.verbose)

  const data = outcome.data ?? {}
  const name = text(data['projectName']) ?? 'the open project'
  if (dry) {
    const wouldSave = data['wouldSave'] === true ? 'save and ' : ''
    const wouldPortal = data['wouldClosePortal'] === true ? ' and shut TIA Portal down' : ''
    return accepted(outcome, `Dry run: would ${wouldSave}close ${name}${wouldPortal}`, dependencies.verbose)
  }
  const saved = data['saved'] === true ? 'saved' : 'unsaved changes discarded'
  const portal = data['portalClosed'] === true ? '; TIA Portal shut down' : ''
  return accepted(outcome, `Closed ${name} — ${saved}${portal}`, dependencies.verbose)
}

/** The project-info sections a command may ask for. */
const INFO_SECTIONS = [
  'attributes',
  'comment',
  'languages',
  'history',
  'products',
  'devices',
  'software',
  'settings',
] as const

/** Reports the open project's metadata, compact enough to read in a card. */
async function handleInfo(dependencies: ToolDependencies, invocation: DshCommandInvocation): Promise<DshCommandResult> {
  const parsed = parseInput(invocation.rawInput)
  if (parsed.flags.size > 0) return usageError(USAGE_INFO)

  const requested = parsed.positionals.map((section) => section.toLowerCase())
  for (const section of requested) {
    if (!(INFO_SECTIONS as readonly string[]).includes(section)) {
      return usageError(`Unknown section "${section}".\n${USAGE_INFO}`)
    }
  }
  if (new Set(requested).size !== requested.length) return usageError(`A section was named twice.\n${USAGE_INFO}`)

  const sections = requested.length === 0 ? ['attributes', 'comment', 'software'] : requested
  const outcome = await runOperation(
    dependencies,
    'ProjectInfo',
    { sections, history_limit: 10, max_objects: 50, include_attribute_infos: false },
    invocation.signal,
  )
  if (!outcome.ok) return refused(outcome, dependencies.verbose)

  const data = outcome.data ?? {}
  const attributes = record(data['attributes'])
  const devices = record(data['devices'])
  const software = record(data['software'])
  const name = text(attributes?.['name']) ?? 'the open project'
  const modified = attributes?.['isModified'] === true ? 'modified' : 'not modified'
  const softwareCount = numberOf(software?.['count']) ?? 0
  const deviceCount = numberOf(devices?.['deviceCount'])
  const headline =
    `Project ${name} — ${softwareCount} PLC software, ${modified}` +
    (deviceCount === undefined ? '' : `, ${deviceCount} device(s)`)
  return accepted(outcome, headline, dependencies.verbose)
}

/** Maps a `list_plc_objects` category to its key in `data.counts`. */
const CATEGORY_COUNT_KEY: Readonly<Record<string, string>> = {
  blocks: 'blocks',
  types: 'types',
  tag_tables: 'tagTables',
  units: 'units',
}

/** Finds blocks, PLC types, tag tables or units by name. */
async function handleFind(dependencies: ToolDependencies, invocation: DshCommandInvocation): Promise<DshCommandResult> {
  const parsed = parseInput(invocation.rawInput)
  const invalid = unknownOptions(parsed, ['blocks', 'types', 'tables', 'units', 'fp'], USAGE_FIND)
  if (invalid !== null) return invalid

  const selected: string[] = []
  if (parsed.flags.has('blocks')) selected.push('blocks')
  if (parsed.flags.has('types')) selected.push('types')
  if (parsed.flags.has('tables')) selected.push('tag_tables')
  if (parsed.flags.has('units')) selected.push('units')
  const categories = selected.length === 0 ? ['blocks', 'types', 'tag_tables'] : selected
  const filter = parsed.positionals.join(' ').trim()

  const params: JsonRecord = {
    categories,
    recursive: true,
    include_tags: false,
    include_constants: false,
    include_attributes: false,
    include_fingerprints: parsed.flags.has('fp'),
    max_items: 50,
  }
  if (filter.length > 0) params['name_filter'] = filter

  const outcome = await runOperation(dependencies, 'ListPlcObjects', params, invocation.signal)
  if (!outcome.ok) return refused(outcome, dependencies.verbose)

  const data = outcome.data ?? {}
  const counts = record(data['counts']) ?? {}
  const total = categories.reduce((sum, category) => sum + (numberOf(counts[CATEGORY_COUNT_KEY[category] ?? category]) ?? 0), 0)
  const breakdown = ['blocks', 'types', 'tagTables', 'units']
    .filter((key) => (numberOf(counts[key]) ?? 0) > 0)
    .map((key) => `${numberOf(counts[key])} ${key}`)
  const truncated = data['truncated'] === true ? ' (truncated to max_items)' : ''
  const headline =
    `${total} object(s)` +
    (filter.length === 0 ? '' : ` matching "${filter}"`) +
    (breakdown.length === 0 ? '' : ` — ${breakdown.join(', ')}`) +
    truncated
  return accepted(outcome, headline, dependencies.verbose)
}

/** Reports the controller state without starting TIA Portal. */
async function handleStatus(dependencies: ToolDependencies, invocation: DshCommandInvocation): Promise<DshCommandResult> {
  const parsed = parseInput(invocation.rawInput)
  if (parsed.flags.size > 0 || parsed.positionals.length > 0) return noArguments('tia-status', USAGE_STATUS)
  const outcome = controllerStatusOutcome(dependencies, false)
  const state = text((outcome.data as JsonRecord | null)?.['state'])
  // A broken controller makes the card red; every other state is a report,
  // including "stopped", which is a legitimate state before the first call.
  return { kind: state === 'failed' ? 'error' : 'success', text: outcome.summary }
}

// --------------------------------------------------------------- registration

/**
 * Registers every `/tia-…` command on `ctx.commands`.
 *
 * The registrations live in one `ctx.effect`, so unloading the row unregisters
 * them exactly as the tool row's registrations disappear with its fiber.
 *
 * @param ctx - the command row's context; it must carry `commands`.
 * @param dependencies - the host row's controller seam.
 * @returns the registered command names, in registration order.
 */
export function registerCommands(ctx: Context, dependencies: ToolDependencies): string[] {
  const definitions: DshCommandDefinition[] = [
    {
      name: 'tia-open',
      description: '打开本工作区的 TIA 项目（可见窗口）',
      handler: (invocation) => guard(() => handleOpen(dependencies, invocation), invocation),
    },
    {
      name: 'tia-save',
      description: '保存当前打开的 TIA 项目',
      handler: (invocation) => guard(() => handleSave(dependencies, invocation), invocation),
    },
    {
      name: 'tia-compile',
      description: '编译当前 PLC，报告错误与警告',
      handler: (invocation) => guard(() => handleCompile(dependencies, invocation), invocation),
    },
    {
      name: 'tia-close',
      description: '保存并关闭当前项目（--discard 不保存，--portal 同时关闭 TIA）',
      input: { hint: '[--discard] [--portal] [--dry]' },
      handler: (invocation) => guard(() => handleClose(dependencies, invocation), invocation),
    },
    {
      name: 'tia-info',
      description: '查看当前项目概要（属主、版本、设备、PLC 软件）',
      input: { hint: '[attributes] [comment] [languages] [history] [products] [devices] [software] [settings]' },
      handler: (invocation) => guard(() => handleInfo(dependencies, invocation), invocation),
    },
    {
      name: 'tia-find',
      description: '按名称查找块 / PLC 类型 / 变量表',
      input: { hint: '<substring> [--blocks] [--types] [--tables] [--units] [--fp]' },
      handler: (invocation) => guard(() => handleFind(dependencies, invocation), invocation),
    },
    {
      name: 'tia-status',
      description: '查看 TIA Openness 控制器状态（不启动 TIA）',
      handler: (invocation) => guard(() => handleStatus(dependencies, invocation), invocation),
    },
  ]

  ctx.effect(
    () => definitions.map((definition) => ctx.commands.register(definition)),
    'tia-openness-v17-min: slash commands',
  )

  return definitions.map((definition) => definition.name)
}
