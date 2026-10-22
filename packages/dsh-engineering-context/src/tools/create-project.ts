/**
 * `create_engineering_project` — bring the project TIA currently has open into
 * this workspace, and rebuild its source tree.
 *
 * This is the whole workflow in one call, on purpose (docs/ARCHITECTURE.md §6):
 * "which directory, then save, then export" is an auditable orchestration, not
 * something the model should assemble out of primitives. Three facts shape it:
 *
 *   1. **This plugin never talks to TIA.** Every TIA action goes through the
 *      interface plugin's `engineeringAccess` service (docs/decisions.md D12);
 *      a composition without that plugin gets `tia_access_unavailable`, not a
 *      half-done workspace.
 *   2. **TIA decides the project's name and path.** Save-as takes only a
 *      directory and a project keeps its own name, so the folder is derived from
 *      the name TIA reports and the path TIA reports back is what the result
 *      carries — never what this tool asked for (interface-plugin D20/D21).
 *   3. **Adding is immediate, moving is not.** The save-as relocates the project
 *      TIA has open, which is the one hard-to-undo act in this plugin, so the
 *      whole call is a `dry_run` plan until the caller says otherwise
 *      (docs/decisions.md P0-4).
 *
 * @module dsh-engineering-context/tools/create-project
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { InferArgs, ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  engineeringAccess,
  normalizeOpen,
  normalizeRebuild,
  normalizeSave,
  normalizeSession,
  type OpenResult,
  type RebuildResult,
} from '../access.js'
import {
  knowledgeIgnoreRule,
  KNOWLEDGE_DIR_NAME,
  projectDirectoryPath,
  sourceDirectoryPath,
  sourceIndexPath,
  stateIgnoreRule,
  tiaIgnoreRule,
  type PluginConfig,
} from '../config.js'
import { EngineeringContextError } from '../errors.js'
import { ingestKnowledgeGraph, type KnowledgeIngestReport } from '../knowledge-graph.js'
import { canonicalizeLoose, folderName, isInside, toPortable } from '../paths.js'
import { assertInsideWith, describePath, resolveScope, type ResolvedScope } from '../scope.js'
import type { ToolDependencies } from './deps.js'
import { cappedList, defineOutcomeTool, failedOutcome, okOutcome, type EngineeringOutcome } from './outcome.js'

/** The tool name, in one place because tests and the registrar both match on it. */
export const CREATE_PROJECT_TOOL = 'create_engineering_project'

const CREATE_PARAMETERS = {
  source_project: {
    type: 'string',
    description:
      'Absolute path of the .ap17 to open, for example C:\\Projects\\Line1\\Line1.ap17. Required only when TIA has no project ' +
      'open — a project that is already open is used as it is. If you do not know the path, ask the user for it: never search ' +
      'the disk for project files.',
  },
  with_window: {
    type: 'boolean',
    description:
      'Default TRUE when this tool opens a project: attach to a visible TIA Portal instance the operator can watch (and see the ' +
      'export happen in). Pass false for a headless instance no operator can interact with.',
  },
  allow_upgrade: {
    type: 'boolean',
    description:
      'Default false. True lets TIA Portal upgrade and rewrite a project created by an older version — that MODIFIES the project ' +
      'file irreversibly, so only pass it when the user explicitly asked for it.',
  },
  dry_run: {
    type: 'boolean',
    description:
      'Default TRUE — report the plan and write nothing (it does not even open the project). Pass false to open/save the project ' +
      'and rebuild its source tree. The save-as is the irreversible half: TIA moves the project it has open to the workspace copy.',
  },
  overwrite: {
    type: 'boolean',
    description:
      'Default false — files that already exist in the source tree are skipped and counted in the result. Pass true to replace them, ' +
      'which is how a tree written by an earlier run is refreshed.',
  },
} as const

type CreateArgs = InferArgs<typeof CREATE_PARAMETERS>

/** One `.gitignore` rule this plugin needs, plus why it needs it. */
interface IgnoreRuleSpec {
  rule: string
  /** The comment line written above the rule when this plugin has to add it. */
  purpose: string
}

/** One rule, as the workspace `.gitignore` currently answers for it. */
interface IgnoreRuleState extends IgnoreRuleSpec {
  state: 'present' | 'absent'
}

/** What the `.gitignore` of the workspace currently says about the rules this plugin needs. */
interface IgnoreFile {
  /** Absolute path of the workspace `.gitignore`. */
  file: string
  /** Portable spelling, for the result. */
  port: string
  /** False when the file does not exist yet. */
  exists: boolean
  /** The rules this plugin needs, with their current state. */
  rules: IgnoreRuleState[]
  /** The file's current text, or empty when it does not exist. */
  raw: string
}

/** What applying the rules did. */
interface IgnoreAction {
  action: 'created' | 'appended' | 'unchanged'
  /** The rules this run added. */
  added: string[]
}

/**
 * The project's name, as TIA reports it, or an explicit failure.
 *
 * The name no longer decides any directory (one workspace manages one project),
 * but it is the identity recorded in the index and compared before writing.
 */
function projectNameOf(reportedName: string | null, projectPath: string | null): string {
  const reported = reportedName?.trim()
  if (reported !== undefined && reported.length > 0) return reported
  if (projectPath !== null) {
    const base = basename(projectPath).replace(/\.[^.]+$/u, '').trim()
    if (base.length > 0) return base
  }
  throw new EngineeringContextError(
    'project_name_unavailable',
    'TIA reports a project but no usable project name and no path to fall back on, so this tool cannot tell which project it is about. Save it in TIA Portal first.',
    { projectPath },
  )
}

/** Whether two spellings point at the same project file (Windows is case-insensitive). */
async function samePath(left: string, right: string | null): Promise<boolean> {
  if (right === null) return false
  try {
    const [a, b] = await Promise.all([canonicalizeLoose(left), canonicalizeLoose(right)])
    return a.toLowerCase() === b.toLowerCase()
  } catch {
    return left.trim().toLowerCase() === right.trim().toLowerCase()
  }
}

/** What the tool recorded about the source tree of this workspace. */
interface SourceIndex {
  /** The project name it belongs to, or null when the file is there but unusable. */
  project: string | null
  /** The project file the run recorded, or null. */
  savedAs: string | null
  /** The project that was open when the run recorded it, or null. */
  path: string | null
}

/**
 * Read the index this tool writes into the source directory.
 *
 * `null` means "no index at all" — a workspace this tool has never written to —
 * while `{ project: null }` means the file exists but cannot be used. The two are
 * different, and only the first may be read as "belongs to nobody yet".
 */
async function readSourceIndex(file: string): Promise<SourceIndex | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { project: null, savedAs: null, path: null }
  }
  try {
    const parsed = JSON.parse(raw) as { project?: { name?: unknown; savedAs?: unknown; path?: unknown } }
    const name = parsed.project?.name
    return {
      project: typeof name === 'string' && name.length > 0 ? name : null,
      savedAs: typeof parsed.project?.savedAs === 'string' ? parsed.project.savedAs : null,
      path: typeof parsed.project?.path === 'string' ? parsed.project.path : null,
    }
  } catch {
    return { project: null, savedAs: null, path: null }
  }
}

/**
 * Whether the project in play is the one the index recorded.
 *
 * The **recorded path** decides, not the name: TIA names the project it saves into
 * a directory after that directory, so after the first run the copy is called
 * `tia` while the recorded name is still the source project's. Refusing on the
 * name alone would make the tool reject the very project it wrote (found in a live
 * session).
 */
async function isRecordedProject(recorded: SourceIndex, projectPath: string | null): Promise<boolean> {
  for (const value of [recorded.savedAs, recorded.path]) {
    if (value !== null && value.length > 0 && (await samePath(value, projectPath))) return true
  }
  return false
}

/** The index document, as it is written to disk. */
interface SourceIndexDocument {
  schemaVersion: number
  project: { name: string; path: string | null; savedAs: string | null; directory: string; sourceRoot: string }
  exportedAt: string
  devices: Array<{
    device: string
    software: string
    directory: string
    manifest: string | null
    exported: { blocks: number; types: number; tagTables: number }
    skipped: number
  }>
  totals: { planned: number; written: number; skipped: number; refused: number; verificationFailed: number }
}

/** Write the index, creating the source directory when the export wrote nothing. */
async function writeSourceIndex(file: string, document: SourceIndexDocument): Promise<'written' | 'created'> {
  await mkdir(dirname(file), { recursive: true })
  const existed = (await readSourceIndex(file)) !== null
  await writeFile(file, `${JSON.stringify(document, undefined, 2)}\n`, 'utf8')
  return existed ? 'written' : 'created'
}

/** Whether the open project already lives inside the directory this tool targets. */
async function alreadyInside(projectPath: string | null, targetDirectory: string): Promise<boolean> {
  if (projectPath === null) return false
  try {
    return isInside(targetDirectory, await canonicalizeLoose(projectPath))
  } catch {
    return false
  }
}

/**
 * The rules this plugin keeps in the workspace `.gitignore`.
 *
 * Both are about **binary rebuildables** the workflow puts beside the source
 * tree: the TIA project TIA itself owns, and the per-device knowledge databases
 * the engineering-graph plugin derives from that tree. The text artifact that
 * belongs in version control is `source/` alone.
 */
function ignoreRules(config: PluginConfig): IgnoreRuleSpec[] {
  return [
    {
      rule: tiaIgnoreRule(config),
      purpose: 'Saved TIA projects: binary, edited in TIA, not versioned here.',
    },
    {
      rule: knowledgeIgnoreRule(),
      purpose: 'Generated knowledge databases: rebuilt from source/, binary, not versioned here.',
    },
    {
      rule: stateIgnoreRule(config),
      purpose: 'Local sync state (lock and STAGE): temporary, per machine, never committed.',
    },
  ]
}

/** One rule spelled as a quoted token, for a model-facing line. */
function quoted(rules: readonly string[]): string {
  return rules.map((rule) => `"${rule}"`).join(' and ')
}

/**
 * Read the workspace `.gitignore` and decide what it needs.
 *
 * A missing file and a file without a rule are different actions (create vs
 * append), and an existing rule is left exactly as the user wrote it — this
 * plugin appends rules and never rewrites a file it did not author. A rule counts
 * as present in any of the spellings a user may have written it in (`tia/`,
 * `/tia/`, `tia`).
 */
async function readIgnoreFile(root: string, rules: readonly IgnoreRuleSpec[]): Promise<IgnoreFile> {
  const file = join(root, '.gitignore')
  const port = toPortable(root, file)
  let raw: string
  let exists = true
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    raw = ''
    exists = false
  }
  const lines = new Set(raw.split(/\r?\n/u).map((line) => line.trim()))
  return {
    file,
    port,
    exists,
    raw,
    rules: rules.map((spec) => ({
      ...spec,
      state: [spec.rule, `/${spec.rule}`, spec.rule.replace(/\/$/u, '')].some((spelling) => lines.has(spelling))
        ? 'present'
        : 'absent',
    })),
  }
}

/** Write the missing rules, preserving everything the user already had. */
async function applyIgnoreRules(ignore: IgnoreFile): Promise<IgnoreAction> {
  const missing = ignore.rules.filter((rule) => rule.state === 'absent')
  if (missing.length === 0) return { action: 'unchanged', added: [] }
  const added = missing.map((rule) => rule.rule)

  if (!ignore.exists) {
    const header = [
      '# Written by @voltarenyah/dsh-engineering-context (create_engineering_project).',
      '# The TIA project directory holds the projects this workspace saved into it: binary, and',
      '# edited in TIA Portal rather than here, so it is not versioned. The rebuilt source tree',
      '# beside it is the text artifact that belongs in version control.',
      '# knowledge/**/*.db* holds the knowledge databases the engineering-graph plugin',
      '# rebuilds from that source tree: binary, large and derived, so not versioned either',
      '# (the trailing * also covers SQLite -wal / -shm / -journal side files).',
      '# .dsh/local/ holds this plugin\'s lock and STAGE directory: local runtime state that a',
      '# sync writes and deletes, never a versioned artifact.',
      ...added,
      '',
    ].join('\n')
    await writeFile(ignore.file, header, 'utf8')
    return { action: 'created', added }
  }

  const block = missing.map((rule) => `# ${rule.purpose}\n${rule.rule}`).join('\n')
  const prefix = ignore.raw.length === 0 || ignore.raw.endsWith('\n') ? ignore.raw : `${ignore.raw}\n`
  await writeFile(ignore.file, `${prefix}${prefix.length === 0 ? '' : '\n'}${block}\n`, 'utf8')
  return { action: 'appended', added }
}

/** A trimmed string, or undefined when nothing usable was given. */
function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const result = value.trim()
  return result.length === 0 ? undefined : result
}

/** One line per device, for the model-facing detail block. */
function deviceLines(devices: readonly { device: string; software: string }[]): string[] {
  return devices.map((entry) => `${entry.device} / ${entry.software}`)
}

/** What the plan says about the `.gitignore`, before anything is written. */
function describeIgnorePlan(ignore: IgnoreFile): string {
  const all = ignore.rules.map((rule) => rule.rule)
  if (!ignore.exists) {
    return (
      `Ignore rules: ${ignore.port} does not exist yet; it will be created with ${quoted(all)} ` +
      '(generated binaries and local runtime state: the saved projects, the knowledge databases, and the sync stage).'
    )
  }
  const missing = ignore.rules.filter((rule) => rule.state === 'absent').map((rule) => rule.rule)
  if (missing.length === 0) {
    return `Ignore rules: ${quoted(all)} already in ${ignore.port} — left untouched.`
  }
  return (
    `Ignore rules: ${ignore.port} exists; ${quoted(missing)} will be appended to it` +
    `${missing.length === all.length ? '' : ` (${quoted(all.filter((rule) => !missing.includes(rule)))} already there)`}.`
  )
}

/** The structured `ignore` payload: what is in the file, and what this run changed. */
function ignorePayload(ignore: IgnoreFile, action: string, added: readonly string[]): {
  file: string
  action: string
  added: string[]
  rules: Array<{ rule: string; present: boolean }>
} {
  return {
    file: ignore.port,
    action,
    added: [...added],
    rules: ignore.rules.map((rule) => ({ rule: rule.rule, present: rule.state === 'present' })),
  }
}

/** What happened to the `.gitignore`, in one line for the result. */
function describeIgnoreAction(ignore: IgnoreFile, applied: IgnoreAction): string {
  if (applied.action === 'unchanged') {
    return `Ignore rules: ${quoted(ignore.rules.map((rule) => rule.rule))} already in ${ignore.port} — left untouched.`
  }
  return `Ignore rules: ${applied.action} ${ignore.port} (added ${quoted(applied.added)}).`
}

/** The knowledge-graph step in one clause, appended to the run's summary. */
function describeKnowledgeSummary(report: KnowledgeIngestReport): string {
  switch (report.state) {
    case 'ingested':
      return (
        ` Rebuilt the knowledge graph for ${report.totals.devices} device(s): ` +
        `${report.totals.nodes} node(s), ${report.totals.edges} edge(s).`
      )
    case 'partial':
      return ` The knowledge graph was rebuilt for ${report.totals.ok} of ${report.totals.devices} device(s).`
    case 'failed':
      return ` The knowledge graph was not built for any of ${report.totals.devices} device(s).`
    case 'empty':
      return ' There was no device directory to build a knowledge graph from.'
    case 'absent':
    case 'unavailable':
      return ' The knowledge graph was not built.'
  }
}

/**
 * Run one service call, converting a transport failure into a coded error.
 *
 * The service returns operation-level failures as data and throws transport ones
 * (controller missing, timeout, protocol mismatch); both end up as `ok: false`
 * for the model, but with different codes so it can tell them apart.
 */
async function callService<T>(what: string, body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new EngineeringContextError(
      'tia_unreachable',
      `The ${what} call to the TIA interface plugin failed: ${message}`,
      { cause: message },
    )
  }
}

/**
 * Build the `create_engineering_project` tool.
 * @param dependencies - the plugin dependencies.
 */
export function createProjectTool(dependencies: ToolDependencies): ToolDefinition {
  return defineOutcomeTool({
    name: CREATE_PROJECT_TOOL,
    description:
      'Bring an engineering project into this workspace: open it in TIA Portal when it is not open yet, save it into the workspace ' +
      'copy, and rebuild its source tree, so the conversation has a project on disk to talk about. Name the project with ' +
      'source_project (the absolute .ap17 path) when TIA has none open — if you do not know the path, ASK THE USER; never search the ' +
      'disk for project files and never guess which project was meant. The target directories are derived from the workspace root ' +
      '(the session working directory) and the configured directory names, so this tool takes no target path. Defaults to a plan ' +
      '(`dry_run: true`), which opens nothing at all: the save-as moves the project TIA has open, so pass `dry_run: false` ' +
      'deliberately. **This deployment manages one TIA instance with one project**: if TIA already has a project open that is not the one the call named, the call stops immediately with one instruction — have the user close it (the interface plugin\'s close_project also works) and call again — and it never investigates process lists, lock files or the filesystem, and never works around it. **It acts on whatever project TIA has open when the call does not name one** — so if the user asked for a ' +
      'specific project, either pass its source_project or confirm with them which project is open; do not assume the open one is ' +
      'the one they meant. One workspace manages one project: if it already holds another project\'s source tree this refuses ' +
      'instead of mixing them. It never deletes anything and never modifies the user\'s original project files; if the project is ' +
      'already inside the workspace it skips the save-as and only refreshes the source tree. After the tree is written it also ' +
      'rebuilds every device\'s knowledge database through the engineering-graph plugin (one FULL rebuild per device, into ' +
      'knowledge/<device>/<device>_knowledge.db) — that is the only way the graph is ever refreshed, it adds real time on a large ' +
      'project, and it never fails this call: when that plugin or its engine is absent (or the engine cannot be reached) the result ' +
      'says the knowledge graph was not built and the source tree is unaffected. TIA refusals are reported per object, ' +
      'never dropped.',
    parameters: CREATE_PARAMETERS,
    async execute(args: CreateArgs, exec): Promise<EngineeringOutcome> {
      let scope: ResolvedScope | null = null
      try {
        scope = await resolveScope(dependencies.ctx, exec, dependencies.config)
        const root = scope.workspace.path
        const config = scope.config
        const dryRun = args.dry_run !== false

        const service = engineeringAccess(dependencies.ctx)
        if (service === undefined) {
          throw new EngineeringContextError(
            'tia_access_unavailable',
            'This composition has no engineeringAccess service, so TIA Portal cannot be reached. Install the TIA interface plugin ' +
              '(dsh-tia-openness-v17-min) in this profile — this plugin never talks to TIA itself.',
            { service: 'engineeringAccess' },
          )
        }

        const session = normalizeSession(
          await callService('readTiaSession', () => service.readTiaSession({ signal: exec.signal })),
        )
        const requested = trimmed(args.source_project)

        // Which project are we about to act on? Either TIA already has one open, or
        // the caller named one to open. A different project must never be acted on
        // silently, and — because this deployment manages ONE TIA instance with ONE
        // project — a project someone else opened is a **stop-the-call** condition:
        // the answer is "have the user close it", not an investigation.
        let opened: OpenResult | null = null
        if (!session.projectOpen) {
          if (requested === undefined) {
            throw new EngineeringContextError(
              'source_project_required',
              (session.running
                ? 'TIA Portal has no project open. '
                : `No TIA Openness controller is running, so no project is open. ${session.reason ?? ''}`) +
                'Pass source_project (the absolute .ap17 path) and this tool will open it — ask the user for the path rather than ' +
                'searching the disk for project files.',
              { reason: session.reason },
            )
          }
          // A plan opens nothing: opening is a real action, and it is exactly what
          // provokes the interface plugin's own refusal below. Nothing in a plan
          // needs the open — the target directories no longer depend on the
          // project's name (it carries the workspace's name instead).
          if (!dryRun) {
            opened = normalizeOpen(
              await callService('openProject', () =>
                service.openProject(requested, {
                  withWindow: args.with_window !== false,
                  allowUpgrade: args.allow_upgrade === true,
                  signal: exec.signal,
                }),
              ),
              requested,
            )
          }
          if (opened !== null && !opened.ok) {
            if (opened.error?.code === 'project_already_open') {
              throw new EngineeringContextError(
                'project_already_open',
                `TIA Portal already has a project open, so ${requested} cannot be opened. This deployment manages one TIA instance ` +
                  'with one project at a time. Tell the user to close the project that is open in TIA Portal (the interface plugin\'s ' +
                  'close_project tool does it too), wait for them to do it, and then call this tool again. Do not investigate process ' +
                  'lists, lock files or the filesystem, and do not try to work around it.',
                { requestedPath: requested, code: opened.error.code, openProject: session.projectPath },
              )
            }
            throw new EngineeringContextError(
              'open_failed',
              `TIA Portal refused to open ${requested}: ${opened.error?.message ?? (opened.summary || 'no reason reported')}. ` +
                (args.allow_upgrade === true
                  ? 'Nothing was written by this plugin.'
                  : 'If the project was created by an older TIA version it needs allow_upgrade — but that REWRITES the project to ' +
                    'V17 irreversibly, so ask the user before passing it.'),
              { requestedPath: requested, code: opened.error?.code ?? null },
            )
          }
        } else if (requested !== undefined && !(await samePath(requested, session.projectPath))) {
          throw new EngineeringContextError(
            'project_already_open',
            `TIA Portal already has a different project open (${session.projectPath ?? session.projectName ?? 'unknown'}), so ` +
              `${requested} was not opened. This deployment manages one TIA instance with one project at a time: tell the user to ` +
              'close that project in TIA Portal (or use the interface plugin\'s close_project) and call this tool again once it is ' +
              'closed — or omit source_project if the open project is the one they mean.',
            { openProject: session.projectPath, requested },
          )
        }

        let projectPath = opened?.projectPath ?? session.projectPath
        // A plan with nothing open cannot know the project's name: TIA reports it
        // when the project is opened, and a plan never opens anything.
        const name =
          dryRun && !session.projectOpen
            ? null
            : projectNameOf(opened?.projectName ?? session.projectName, projectPath)
        const software = opened === null ? session.software : opened.software
        // The project the run started from, recorded before the save-as moves it.
        const openedFrom = projectPath

        // TIA names a project after the directory it is saved into (measured on a
        // live project), so the target directory carries the WORKSPACE's name: the
        // saved project's name is then stable, predictable, and known before
        // anything is opened — `tia/<workspace name>/<workspace name>.ap17`.
        const workspaceName = folderName((scope.workspace.title ?? '').trim() || basename(root))

        const projectDir = await canonicalizeLoose(projectDirectoryPath(config, root, workspaceName))
        const sourceRoot = await canonicalizeLoose(sourceDirectoryPath(config, root))
        assertInsideWith(config, root, projectDir, 'The project directory')
        assertInsideWith(config, root, sourceRoot, 'The source tree root')

        // One workspace manages one project: the index the tool writes beside the
        // tree is what makes that checkable instead of aspirational.
        const indexFile = sourceIndexPath(config, root)
        const recorded = await readSourceIndex(indexFile)
        const recordedNameMatches =
          name !== null && recorded !== null && recorded.project !== null && recorded.project.toLowerCase() === name.toLowerCase()
        const recordedArtifactMatches = recorded === null ? false : await isRecordedProject(recorded, projectPath)
        if (name !== null && recorded !== null && recorded.project !== null && !recordedNameMatches && !recordedArtifactMatches) {
          throw new EngineeringContextError(
            'source_belongs_to_another_project',
            `This workspace's ${toPortable(root, sourceRoot)}/ belongs to the project ${recorded.project}, but the project in play ` +
              `is ${name}. One workspace manages one project — use a different workspace, or remove that directory deliberately and ` +
              'call again.',
            { sourceTree: toPortable(root, sourceRoot), recorded: recorded.project, current: name },
          )
        }

        const skipSave = await alreadyInside(projectPath, projectDir)
        const ignore = await readIgnoreFile(root, ignoreRules(config))
        const projectDirStatus = await describePath(root, projectDir)
        const sourceStatus = await describePath(root, sourceRoot)

        const warnings = [...scope.view.warnings]
        if (session.isModified === true && opened === null) {
          warnings.push(
            'TIA reports the open project as modified; the save-as writes those unsaved changes into the workspace copy.',
          )
        }
        if (opened !== null && opened.upgraded) {
          warnings.push(
            `TIA Portal upgraded ${name} to V17 while opening it — the project file was rewritten and this cannot be undone.`,
          )
        }
        if (opened === null && requested === undefined) {
          // A live session's failure mode: the model assumed the project TIA had
          // open (one it had just created, and the user had already deleted) was
          // the project meant, and only found out by asking later.
          warnings.push(
            `Nobody named a project in this call, so it acts on whatever TIA has open: ${name} (${projectPath ?? 'path unknown'}). ` +
              'Confirm that this is the project the user means before acting on the result; if not, ask them for its .ap17 path and ' +
              'pass source_project (or close the open project first).',
          )
        }
        if (recorded !== null && recorded.project === null) {
          warnings.push(
            `The index ${toPortable(root, indexFile)} could not be read, so this tool cannot tell which project the existing source ` +
              'tree came from; existing files are skipped rather than replaced.',
          )
        } else if (recorded !== null && !recordedNameMatches && recordedArtifactMatches && name !== null) {
          warnings.push(
            `The index records the project ${recorded.project}, but TIA reports ${name} for the same project file — TIA names the ` +
              'project it saves into a directory after that directory, so the name changes when it is saved into the workspace. The ' +
              'identity follows the recorded path, and the index is refreshed with the new name.',
          )
        } else if (name === null && recorded !== null && recorded.project !== null) {
          warnings.push(
            `The index records the project ${recorded.project}; this plan cannot compare it because nothing is open yet — the check ` +
              'runs when the plan is executed.',
          )
        }
        if (!skipSave && projectDirStatus.kind !== 'missing') {
          warnings.push(
            `The directory ${projectDirStatus.port}/ already exists, so TIA may refuse the save-as or write beside what is there. ` +
              'Nothing is deleted either way.',
          )
        }
        if (sourceStatus.kind !== 'missing' && args.overwrite !== true) {
          warnings.push(
            `The source tree ${sourceStatus.port}/ already exists; files that are already there are skipped and counted. ` +
              'Pass overwrite=true to replace them.',
          )
        }

        const ignoreLine = describeIgnorePlan(ignore)

        const windowFlag = args.with_window !== false ? 'yes' : 'no'
        const projectLine =
          opened !== null
            ? `Project: ${requested} → opened as ${name} (visible TIA window: ${windowFlag})`
            : !session.projectOpen
              ? `Project: will open ${requested} (visible TIA window: ${windowFlag}); TIA reports the project name after opening.`
              : requested === undefined
                ? `Project: ${name} (already open in TIA at ${projectPath ?? '?'}) — NOBODY named this project in this call; confirm it is the one the user means.`
                : `Project: ${name} (already open in TIA at ${projectPath ?? '?'})`
        const deviceLine =
          software.length > 0
            ? `${software.length} PLC software (${deviceLines(software).join(', ')})`
            : !session.projectOpen
              ? 'the device list comes from TIA after opening'
              : 'none'

        const plan = [
          projectLine,
          `Project directory: ${projectDirStatus.port}/ (named after this workspace, so TIA names the saved project ${workspaceName})`,
          skipSave
            ? `Save-as: not needed — TIA already has this project at ${projectPath ?? '?'}, inside that directory.`
            : `Save-as: TIA will save the open project into ${projectDirStatus.port}/ (currently ${projectPath ?? 'unknown'}; its files there are not touched).`,
          `Source tree: ${sourceStatus.port}/ ← ${deviceLine}`,
          'Layout below the source root is written by the interface plugin: <device>/blocks|types|tag_tables/, one manifest per device covering all three.',
          `Knowledge graph: after the export, one full rebuild per device through the engineering-graph plugin ` +
            `(${KNOWLEDGE_DIR_NAME}/<device>/<device>_knowledge.db); skipped, and reported as not built, when that plugin or its engine is absent.`,
          ignoreLine,
        ]

        if (dryRun) {
          return okOutcome(
            CREATE_PROJECT_TOOL,
            scope.view,
            !session.projectOpen
              ? `Dry run: would open ${requested} and save it into ${projectDirStatus.port}/ (TIA reports the project name after opening). Pass dry_run=false to do it.`
              : `Dry run: would ${skipSave ? 'refresh the source tree of' : 'save'} ${name ?? 'the open project'} in ${projectDirStatus.port}/ (${software.length} device(s)). Pass dry_run=false to do it.`,
            {
              plan: {
                name,
                open: opened === null ? null : { requestedPath: opened.requestedPath, withWindow: args.with_window !== false, allowUpgrade: args.allow_upgrade === true },
                projectDirectory: projectDirStatus,
                sourceRoot: sourceStatus,
                skipSave,
                projectPath,
                devices: software,
              },
              ignore: ignorePayload(ignore, 'none (dry run)', []),
              rebuild: null,
              knowledge: null,
            },
            { details: plan, warnings, dryRun: true },
          )
        }

        // ---- the real run -------------------------------------------------

        let savedAs: string | null = null
        if (!skipSave) {
          const save = normalizeSave(
            await callService('saveProjectAs', () => service.saveProjectAs(projectDir, { signal: exec.signal })),
            projectDir,
          )
          if (!save.ok) {
            throw new EngineeringContextError(
              'save_failed',
              `TIA refused to save the project into ${projectDir}: ${save.error?.message ?? (save.summary || 'no reason reported')}. ` +
                'Nothing was written by this plugin, and the project TIA has open is unchanged.',
              { requestedSaveAsDir: save.requestedSaveAsDir, code: save.error?.code ?? null },
            )
          }
          savedAs = save.savedAs
          projectPath = save.projectPath ?? projectPath
          if (save.projectName !== null && save.projectName !== name) {
            warnings.push(
              `TIA named the workspace copy ${save.projectName} — it names a project after the directory it is saved into, so the copy ` +
                `is not called ${name}. The source project is untouched.`,
            )
          }
        }

        // Before the (slow) export: the moment `tia/` holds a project, the ignore
        // rules have to be there, or the next `git add -A` stages a binary project
        // (and, one step later, a multi-hundred-megabyte knowledge database).
        const ignoreAction = await applyIgnoreRules(ignore)

        const rebuilt: RebuildResult = normalizeRebuild(
          await callService('rebuildSource', () =>
            service.rebuildSource(sourceRoot, { overwrite: args.overwrite === true, signal: exec.signal }),
          ),
          sourceRoot,
        )

        // The controller reports "every file already existed, so nothing was
        // written" as `export_failed` with the message "Openness refused all N
        // object(s)" (`controller/Operations.cs:346` does not separate the two).
        // That is not a refusal and nothing is broken: the files and manifests on
        // disk are the ones this run found. Reporting it as a hard failure would
        // make the ordinary re-run — the whole point of the skip-save path — look
        // like a TIA error, so it is reported for what it is, with the staleness
        // spelled out.
        const nothingWritten =
          !rebuilt.ok && rebuilt.totals.written === 0 && rebuilt.totals.skipped > 0 && rebuilt.totals.refused === 0
        if (!rebuilt.ok && !nothingWritten) {
          throw new EngineeringContextError(
            'rebuild_failed',
            `The source tree could not be rebuilt: ${rebuilt.error?.message ?? (rebuilt.summary || 'no reason reported')}. ` +
              `The project itself is saved (${toPortable(root, projectDir)}/) and the ignore rule is in place, so calling this tool again only redoes the export.`,
            {
              code: rebuilt.error?.code ?? null,
              devices: rebuilt.devices.length,
              failures: rebuilt.failures.slice(0, 10),
              totals: rebuilt.totals,
            },
          )
        }

        // The knowledge graph step, deliberately last and deliberately soft: it is
        // a full rebuild of one database per device, it is minutes of work on a
        // real project, and nothing about the source tree depends on it. An absent
        // plugin, a missing engine or an engine that refuses/dead-times all come
        // back as data with the graph reported as not built — the workflow itself
        // stays a success, because the saved project and the exported tree are what
        // it promised.
        const knowledge = await ingestKnowledgeGraph({
          ctx: dependencies.ctx,
          log: dependencies.log,
          root,
          devices: rebuilt.devices,
          signal: exec.signal,
        })

        const totals = rebuilt.totals
        const details = [
          ...plan,
          skipSave
            ? `Save-as: skipped — the project was already inside ${projectDirStatus.port}/.`
            : `Saved by TIA as: ${savedAs ?? projectPath ?? 'unknown'} (requested directory: ${projectDirStatus.port}/)`,
          describeIgnoreAction(ignore, ignoreAction),
          `Source rebuild: ${totals.planned} object(s) planned — ${totals.written} written, ${totals.skipped} already present, ` +
            `${totals.refused} refused by TIA${totals.verificationFailed === 0 ? '' : `, ${totals.verificationFailed} written but unreadable`}.`,
          ...deviceLines(rebuilt.devices).map(
            (line, index) =>
              `${line}: blocks ${rebuilt.devices[index]?.blocks.exported ?? 0}, types ${rebuilt.devices[index]?.types.exported ?? 0}, ` +
              `tag tables ${rebuilt.devices[index]?.tagTables.exported ?? 0} (planned; ${rebuilt.devices[index]?.skipped ?? 0} skipped)` +
              `${rebuilt.devices[index]?.blocks.manifest === null ? '' : `, manifest ${rebuilt.devices[index]?.blocks.manifest}`}`,
          ),
          ...cappedList(rebuilt.failures, (failure) => `Refused: ${failure.device}/${failure.category}/${failure.name} — ${failure.code}: ${failure.message}`),
        ]
        if (rebuilt.missingDevices.length > 0) {
          details.push(`Devices that were asked for but not found: ${rebuilt.missingDevices.join(', ')}`)
        }
        if (nothingWritten) {
          warnings.push(
            `Nothing was written: every file the export reached was already present, so the source tree is exactly what it was and may be stale. ` +
              'Pass overwrite=true to replace the existing files.',
          )
          const reached = rebuilt.devices.length
          if (reached < software.length) {
            warnings.push(
              `The interface plugin stops at the first device it cannot finish, so ${software.length - reached} of ` +
                `${software.length} device(s) were not examined at all — its numbers and device list describe only the ones before that point.`,
            )
          }
        }
        if (totals.refused > 0) {
          warnings.push(
            `${totals.refused} object(s) were refused by TIA; they are listed in the result and in each export call's manifest. The export did not abort because of them.`,
          )
        }
        // The graph step's own lines and warnings. `details` is appended whole;
        // `warnings` only ever gains the ones that are the caller's business (the
        // manifest refusals the engine re-reported land here too, prefixed).
        details.push(...knowledge.details)
        warnings.push(...knowledge.warnings)

        // Re-describe the two directories: the payload has to say what is on disk
        // *after* the run, while the plan lines above state what was there before.
        const projectDirNow = await describePath(root, projectDir)
        const sourceNow = await describePath(root, sourceRoot)

        // The index is what makes "one workspace, one project" checkable next time,
        // and it doubles as the workspace-level summary of what is on disk (the
        // controller writes one manifest per device; this is the entry point that
        // says which project they belong to).
        const indexAction = await writeSourceIndex(indexFile, {
          schemaVersion: 1,
          project: {
            // The real run always has a name (it opened or adopted a project).
            name: name ?? 'unknown',
            path: openedFrom,
            savedAs,
            directory: toPortable(root, projectDir),
            sourceRoot: toPortable(root, sourceRoot),
          },
          exportedAt: new Date().toISOString(),
          devices: rebuilt.devices.map((device) => ({
            device: device.device,
            software: device.software,
            directory: device.directory,
            manifest: device.blocks.manifest,
            exported: {
              blocks: device.blocks.exported,
              types: device.types.exported,
              tagTables: device.tagTables.exported,
            },
            skipped: device.skipped,
          })),
          totals,
        })
        details.push(
          `Index: ${indexAction} ${toPortable(root, indexFile)} — which project this tree belongs to, and what the last export produced.`,
        )

        return okOutcome(
          CREATE_PROJECT_TOOL,
          scope.view,
          (nothingWritten
            ? `Nothing was written: all ${totals.skipped} file(s) the export reached were already present. ${name} is in ${toPortable(root, projectDir)}/; pass overwrite=true to refresh the source tree.`
            : `Saved ${name} into ${toPortable(root, projectDir)}/ and wrote ${totals.written} object(s) into ${toPortable(root, sourceRoot)}/` +
              `${totals.skipped === 0 ? '' : `, ${totals.skipped} already present`}${totals.refused === 0 ? '' : `, ${totals.refused} refused by TIA`}.`) +
            describeKnowledgeSummary(knowledge),
          {
            project: {
              name,
              directory: projectDirNow,
              sourceRoot: sourceNow,
              skipSave,
              requestedSaveAsDir: projectDirStatus.port,
              savedAs,
              projectPath,
            },
            index: { file: toPortable(root, indexFile), action: indexAction },
            ignore: ignorePayload(ignore, ignoreAction.action, ignoreAction.added),
            rebuild: {
              sourceRoot: rebuilt.sourceRoot,
              devices: rebuilt.devices,
              failures: rebuilt.failures,
              missingDevices: rebuilt.missingDevices,
              totals,
              nothingWritten,
            },
            knowledge: {
              state: knowledge.state,
              available: knowledge.available,
              reason: knowledge.reason,
              enginePath: knowledge.enginePath,
              databaseConvention: knowledge.databaseConvention,
              devices: knowledge.devices,
              notAttempted: knowledge.notAttempted,
              totals: knowledge.totals,
            },
          },
          { details, warnings, dryRun: false },
        )
      } catch (error) {
        return failedOutcome(CREATE_PROJECT_TOOL, scope?.view ?? null, error, scope?.view.warnings ?? [])
      }
    },
  })
}
