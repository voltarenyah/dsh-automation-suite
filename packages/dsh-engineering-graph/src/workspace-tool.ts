/**
 * `knowledge_workspace`: the one local tool of this plugin — it answers "what
 * engineering project does this workspace hold, and which knowledge databases
 * exist?" without touching the engine.
 *
 * It exists because `knowledge_query` needs an absolute `db_path` and the model
 * has no way to learn one: the layout convention (D20) is a distribution
 * contract, not a fact the model can read (docs/decisions.md **D24**). This tool
 * turns the convention plus the files on disk into a report the model can act on
 * — including the `device_dir` that `knowledge_ingest` takes, so a missing
 * database is a next step rather than a dead end.
 *
 * **It declares its own output envelope, not the engine one.** The canonical
 * envelope of this plugin carries `operation` (the engine operation that ran) and
 * `durationMs` (time spent in the engine); neither exists here, and inventing an
 * `operation` for a call the engine never saw is exactly the kind of small lie
 * this package's documents forbid (compare `knowledge_ingest` refusing to expose
 * a `dry_run` the engine does not have). The shape below mirrors the sibling
 * plugin's local-tool envelope (`dsh-engineering-context`'s `outcome.ts`):
 * `ok` / `tool` / `summary` / `details` / `data` / `warnings` / `error`.
 *
 * @module dsh-engineering-graph/workspace-tool
 */

import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  discoverWorkspace,
  portablePath,
  renderBytes,
  SOURCE_DIR_NAME,
  SOURCE_INDEX_FILE,
  type WorkspaceReport,
} from './workspace.js'

/** The tool name; the `knowledge_` prefix is deliberate (D19). */
export const WORKSPACE_TOOL = 'knowledge_workspace'

/** Caps on the rendered lists, mirroring the engine tools' `MAX_LISTED`. */
const MAX_DEVICES = 20
const MAX_WARNINGS = 10

/** One local tool result, before it is converted to the wire envelope. */
export interface WorkspaceOutcome {
  ok: boolean
  tool: string
  summary: string
  details: string[]
  data: JsonValue
  warnings: string[]
  error: { code: string; message: string; remediation: string | null } | null
}

/** The declared output schema of {@link WORKSPACE_TOOL}. */
export const WORKSPACE_OUTCOME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description:
    'Outcome of one workspace discovery: the project this session works in, one entry per device and its knowledge ' +
    'database, and any failure as data. No engine operation ran.',
  properties: {
    ok: { type: 'boolean', required: true, description: 'True when the workspace could be inspected.' },
    tool: { type: 'string', required: true, description: 'Always knowledge_workspace.' },
    summary: { type: 'string', required: true, description: 'One-line result.' },
    details: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'Bounded, human-readable lines: the project, one line per device, and the next step.',
    },
    data: { type: 'json', description: 'The structured report: workspaceRoot, project and devices[].' },
    warnings: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'Conditions worth knowing even though the call succeeded (a stale index, a stray database file).',
    },
    error: { type: 'json', description: 'Structured failure: code, message and remediation.' },
  },
} as const

/** The report member of {@link WorkspaceOutcome.data}. */
export interface WorkspaceData {
  workspaceRoot: string
  project: {
    name: string | null
    savedAs: string | null
    exportedAt: string | null
    sourceIndex: string | null
  } | null
  devices: Array<{
    device: string
    deviceDir: string | null
    database: string | null
    databaseExists: boolean
    bytes: number | null
    modifiedAt: string | null
    origin: string
  }>
}

/**
 * Renders the outcome: one header, the bounded details, the warnings and the
 * failure. The structured report stays in `data`, but nothing the model *needs*
 * to act on lives only there — the framework delivers `render` text and never the
 * canonical value.
 */
export function renderWorkspaceOutcome(outcome: WorkspaceOutcome): string {
  const lines = [`${outcome.tool}: ${outcome.summary}`]
  lines.push(...outcome.details)
  if (outcome.warnings.length > 0) {
    lines.push(`Warnings (${outcome.warnings.length}):`)
    for (const warning of outcome.warnings.slice(0, MAX_WARNINGS)) lines.push(`  - ${warning}`)
    if (outcome.warnings.length > MAX_WARNINGS) {
      lines.push(`  … ${outcome.warnings.length - MAX_WARNINGS} more warning(s) in data`)
    }
  }
  if (outcome.error !== null) {
    lines.push(`Error code: ${outcome.error.code}`, `Reason: ${outcome.error.message}`)
    if (outcome.error.remediation !== null) lines.push(`Remediation: ${outcome.error.remediation}`)
  }
  return lines.join('\n')
}

/**
 * Build the successful outcome for one report.
 *
 * @param workspaceRoot - the session working directory.
 * @param report - the discovery result.
 */
export function workspaceSuccess(workspaceRoot: string, report: WorkspaceReport): WorkspaceOutcome {
  const existing = report.devices.filter((device) => device.exists && device.database !== null)
  const project = report.project
  const details: string[] = [`Workspace: ${workspaceRoot}`]

  if (project === null) {
    const indexPath = join(workspaceRoot, SOURCE_DIR_NAME, SOURCE_INDEX_FILE)
    details.push(`Project: no readable ${portablePath(workspaceRoot, indexPath)} in this workspace.`)
  } else {
    const name = project.name ?? '(unnamed)'
    const savedAs = project.savedAs === null ? '' : `, saved as ${portablePath(workspaceRoot, project.savedAs)}`
    const exportedAt = project.exportedAt === null ? '' : `, last exported ${project.exportedAt}`
    details.push(`Project: ${name}${savedAs}${exportedAt}`)
  }

  if (report.devices.length === 0) {
    details.push('Devices: none. This workspace holds no engineering project yet (no source/, no knowledge/).')
    details.push('Next step: run create_engineering_project to create one, or pass db_path explicitly to knowledge_query.')
  } else {
    details.push(`Devices (${report.devices.length}):`)
    for (const device of report.devices.slice(0, MAX_DEVICES)) {
      const database = device.database === null ? '(no database path)' : portablePath(workspaceRoot, device.database)
      const source = device.deviceDir === null ? 'source folder unknown' : portablePath(workspaceRoot, device.deviceDir)
      if (device.exists) {
        const size = renderBytes(device.bytes) ?? 'unknown size'
        const modified = device.modifiedAt ?? 'unknown mtime'
        details.push(`  - ${device.device}: ${database} — ${size}, modified ${modified} (source: ${source})`)
      } else {
        details.push(`  - ${device.device}: NO DATABASE YET (expected ${database}; source: ${source})`)
      }
    }
    if (report.devices.length > MAX_DEVICES) {
      details.push(`  … ${report.devices.length - MAX_DEVICES} more device(s) in data.devices`)
    }

    if (existing.length === 1) {
      details.push(`Next step: knowledge_query resolves db_path to this database when you omit it, or pass '${existing[0]!.database}'.`)
    } else if (existing.length === 0) {
      details.push('Next step: no database exists yet. Build one with knowledge_ingest (device_dir above), or ask the agent that owns this project.')
    } else {
      details.push(`Next step: ${existing.length} devices have a database, so knowledge_query needs an explicit db_path.`)
    }
  }

  return {
    ok: true,
    tool: WORKSPACE_TOOL,
    summary:
      project === null
        ? `No engineering project is recorded in ${workspaceRoot}; ${report.devices.length} database folder(s) found.`
        : `${project.name ?? '(unnamed project)'}: ${report.devices.length} device(s), ${existing.length} with a knowledge database.`,
    details,
    data: asJson(workspaceData(workspaceRoot, report)),
    warnings: report.warnings,
    error: null,
  }
}

/** The structured payload, with every path spelled portably. */
function workspaceData(workspaceRoot: string, report: WorkspaceReport): WorkspaceData {
  return {
    workspaceRoot,
    project:
      report.project === null
        ? null
        : {
            name: report.project.name,
            savedAs: report.project.savedAs === null ? null : portablePath(workspaceRoot, report.project.savedAs),
            exportedAt: report.project.exportedAt,
            sourceIndex: portablePath(workspaceRoot, report.project.sourceIndex),
          },
    devices: report.devices.map((device) => ({
      device: device.device,
      deviceDir: device.deviceDir === null ? null : portablePath(workspaceRoot, device.deviceDir),
      database: device.database === null ? null : portablePath(workspaceRoot, device.database),
      databaseExists: device.exists,
      bytes: device.bytes,
      modifiedAt: device.modifiedAt,
      origin: device.origin,
    })),
  }
}

/** Build the failure outcome for a workspace this tool cannot inspect at all. */
export function workspaceFailure(code: string, message: string, remediation: string | null): WorkspaceOutcome {
  return {
    ok: false,
    tool: WORKSPACE_TOOL,
    summary: message,
    details: [],
    data: null,
    warnings: [],
    error: { code, message, remediation },
  }
}

/** Bridges the report types into the lossless-JSON envelope the registry wants. */
function asJson(value: unknown): JsonValue {
  return value as JsonValue
}

function asWireOutcome(outcome: WorkspaceOutcome): {
  ok: boolean
  tool: string
  summary: string
  details: string[]
  data: JsonValue
  warnings: string[]
  error: JsonValue
} {
  return {
    ok: outcome.ok,
    tool: outcome.tool,
    summary: outcome.summary,
    details: [...outcome.details],
    data: outcome.data,
    warnings: [...outcome.warnings],
    error: asJson(outcome.error),
  }
}

/**
 * The registered definition of `knowledge_workspace`.
 *
 * It is exported as a definition rather than registered here so `registerTools`
 * stays the single place that decides the model-facing surface and its order.
 */
export const workspaceToolDefinition: ToolDefinition = defineTool({
  name: WORKSPACE_TOOL,
  description:
    "Report the engineering project this session's workspace holds and where its knowledge databases are, so that a " +
    'knowledge_query can be pointed at a real db_path. It reads the session working directory: ' +
    'source/_dsh-engineering-context.json names the project and one device per PLC, and ' +
    'knowledge/<device>/<device>_knowledge.db is the database each device gets (with its size and last write time). ' +
    'It also returns the device_dir each database is built from, so a missing database is one knowledge_ingest call ' +
    'away. Read-only, no engine needed, and cheap: call it first in a session that may have a knowledge database, ' +
    'and again after an export or an ingest. It never decides whether the database is up to date.',
  parameters: {},
  output: {
    schema: WORKSPACE_OUTCOME_SCHEMA,
    render: (_args, value) => [{ type: 'text', text: renderWorkspaceOutcome(value as unknown as WorkspaceOutcome) }],
  },
  presentCall: (args) => ({
    card: 'generic',
    title: 'Engineering knowledge databases',
    kind: 'read',
    rawInput: args,
  }),
  async execute(_args, exec) {
    const cwd = exec.agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.trim().length === 0) {
      return asWireOutcome(
        workspaceFailure(
          'workspace_unavailable',
          'The harness supplied no session working directory, so this workspace cannot be inspected.',
          'Run this tool from a session that has a working directory.',
        ),
      )
    }

    const report = await discoverWorkspace(cwd)
    return asWireOutcome(workspaceSuccess(cwd, report))
  },
})

/** Register the tool on a context; kept next to the definition it registers. */
export function registerWorkspaceTool(ctx: Context): string {
  ctx.tools.register(workspaceToolDefinition)
  return workspaceToolDefinition.name
}
