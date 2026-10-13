/**
 * The model-facing tools.
 *
 * Every tool returns the same canonical envelope (`ToolOutcome`), so a model
 * always sees `ok`, a one-line `summary`, the controller's structured `data`,
 * the list of `changes` the operation made, the controller `diagnostics`, and a
 * structured `error` when the operation reported a failure.
 *
 * Only `OpenProject`, `ExportBlocks`, `ImportBlocks`, `CompilePlc` and
 * `CloseProject` are ever sent to the controller; `controller_status` is
 * answered by the plugin itself and never touches TIA Portal.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type InferValue, type JsonValue } from '@deepseek-ai/dsh-tools'

import type { LogSink } from './controller.js'
import type { ChangeRecord, DiagnosticRecord, JsonRecord, ResultFrame, ToolOutcome } from './protocol.js'
import { changesOf, diagnosticsOf } from './protocol.js'

/** Dependencies every tool body needs. */
export interface ToolDependencies {
  request(operation: string, params: JsonRecord, options: { signal?: AbortSignal }): Promise<ResultFrame>
  status(): JsonRecord
  verbose: boolean
  log: LogSink
}

/** The controller payload is JSON by construction; this only satisfies the type system. */
function asJson(value: unknown): JsonValue {
  return value as JsonValue
}

const MAX_LISTED = 20

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

/** Reads `data[key]`, falling back to a nested `data.a.b` path when asked. */
function field(data: JsonRecord | null, ...path: string[]): unknown {
  let current: unknown = data
  for (const key of path) {
    const container = record(current)
    if (container === null) return undefined
    current = container[key]
  }
  return current
}

// ------------------------------------------------------------------ rendering

function renderError(error: ToolOutcome['error']): string {
  if (error === null) return ''
  const lines = [`Error code: ${error.code}`, `Reason: ${error.message}`]
  const details = record(error.details)
  if (details !== null) {
    const hint = text(details['hint'])
    if (hint !== undefined) lines.push(`Hint: ${hint}`)
    for (const [key, value] of Object.entries(details)) {
      if (key === 'hint') continue
      const rendered = JSON.stringify(value)
      if (rendered === undefined) continue
      lines.push(`  ${key}: ${rendered.length > 400 ? `${rendered.slice(0, 400)}…` : rendered}`)
    }
  }
  return lines.join('\n')
}

function renderDiagnostics(diagnostics: readonly DiagnosticRecord[]): string {
  if (diagnostics.length === 0) return ''
  const interesting = diagnostics.filter((entry) => entry.level === 'error' || entry.level === 'warning')
  const chosen = interesting.length > 0 ? interesting : diagnostics
  const lines = chosen.slice(0, MAX_LISTED).map((entry) => {
    const source = entry.source === undefined ? '' : ` (${entry.source})`
    return `  [${entry.level ?? 'info'}]${source} ${entry.message ?? ''}`
  })
  if (chosen.length > MAX_LISTED) lines.push(`  … ${chosen.length - MAX_LISTED} more`)
  return `Diagnostics:\n${lines.join('\n')}`
}

function renderChanges(changes: readonly ChangeRecord[]): string {
  if (changes.length === 0) return ''
  const lines = changes.slice(0, MAX_LISTED).map((change) => {
    const detail = change.detail === undefined ? '' : ` — ${change.detail}`
    return `  ${change.kind ?? 'change'} ${change.action ?? 'changed'}: ${change.target ?? ''}${detail}`
  })
  if (changes.length > MAX_LISTED) lines.push(`  … ${changes.length - MAX_LISTED} more`)
  return `Applied changes:\n${lines.join('\n')}`
}

/** Operation-specific detail lines; unknown payloads fall back to raw JSON. */
function renderData(operation: string, data: JsonRecord | null, verbose: boolean): string {
  if (data === null) return ''
  const lines: string[] = []

  switch (operation) {
    case 'OpenProject': {
      lines.push(`Project: ${text(data['projectName']) ?? '?'} (${text(data['projectPath']) ?? '?'})`)
      if (data['upgraded'] === true) lines.push('The project was upgraded to TIA Portal V17 and rewritten.')
      lines.push(`User interface: ${data['withUserInterface'] === true ? 'visible' : 'headless'}`)
      lines.push(`PLC software instances: ${numberOf(field(data, 'plcSoftware', 'count')) ?? 0}`)
      for (const item of list(field(data, 'plcSoftware', 'items')).slice(0, MAX_LISTED)) {
        const entry = record(item)
        if (entry === null) continue
        lines.push(`  - ${text(entry['device']) ?? '?'} / ${text(entry['software']) ?? '?'} (${numberOf(entry['blockCount']) ?? 0} blocks)`)
      }
      break
    }
    case 'ExportBlocks': {
      lines.push(`Output directory: ${text(data['outputDir']) ?? '?'}`)
      const categoryCounts = record(data['counts'])
      if (categoryCounts !== null) {
        lines.push(
          `Categories: blocks=${numberOf(categoryCounts['blocks']) ?? 0}, types=${numberOf(categoryCounts['types']) ?? 0}, tagTables=${numberOf(categoryCounts['tagTables']) ?? 0}`,
        )
      }
      if (data['dryRun'] === true) {
        lines.push(`Would export ${numberOf(data['blockCount']) ?? 0} block(s):`)
        for (const item of list(data['files']).slice(0, MAX_LISTED)) {
          const entry = record(item)
          if (entry === null) continue
          lines.push(`  ${text(entry['action']) ?? 'write'} ${text(entry['file']) ?? '?'} (${text(entry['name']) ?? '?'})`)
        }
        break
      }
      lines.push(
        `Exported ${numberOf(field(data, 'summary', 'exported')) ?? 0}, skipped ${numberOf(field(data, 'summary', 'skipped')) ?? 0}, ` +
          `refused by Openness ${numberOf(field(data, 'summary', 'failed')) ?? 0}, unreadable after writing ${numberOf(field(data, 'summary', 'verificationFailed')) ?? 0}`,
      )
      const refused = list(data['failures'])
      if (refused.length > 0) {
        lines.push('Openness cannot export these blocks at all (no Simatic ML representation):')
        for (const item of refused.slice(0, MAX_LISTED)) {
          const entry = record(item)
          if (entry === null) continue
          const reason = text(entry['message']) ?? ''
          lines.push(`  ${text(entry['name']) ?? '?'}: ${reason.length > 200 ? `${reason.slice(0, 200)}…` : reason}`)
        }
      }
      for (const item of list(data['files']).slice(0, MAX_LISTED)) {
        const entry = record(item)
        if (entry === null) continue
        const verified = entry['verified'] === true ? 'verified' : 'NOT VERIFIED'
        lines.push(`  ${text(entry['name']) ?? '?'} -> ${text(entry['file']) ?? '?'} [${verified}, ${numberOf(entry['bytes']) ?? 0} bytes]`)
      }
      const manifest = text(data['manifest'])
      if (manifest !== undefined) lines.push(`Manifest: ${manifest}`)
      break
    }
    case 'ImportBlocks': {
      lines.push(`Files: ${numberOf(data['fileCount']) ?? 0}, import options: ${text(data['importOptions']) ?? 'none'}`)
      const conflicts = list(data['conflicts'])
      if (conflicts.length > 0) {
        lines.push(`Conflicts with existing blocks: ${conflicts.map((item) => text(item) ?? '?').join(', ')}`)
        lines.push("Pass import_options 'override' to replace them, or import different block names.")
      }
      if (data['dryRun'] === true) {
        lines.push(`Ready to import: ${data['ready'] === true ? 'yes' : 'no'}`)
      }
      for (const item of list(data['plan']).slice(0, MAX_LISTED)) {
        const entry = record(item)
        if (entry === null) continue
        lines.push(
          `  ${text(entry['action']) ?? '?'} ${text(entry['blockName']) ?? text(entry['file']) ?? '?'}` +
            ` (${text(entry['format']) ?? '?'}, exists: ${entry['existsInProject'] === true ? 'yes' : 'no'})`,
        )
      }
      if (data['dryRun'] !== true) {
        lines.push(`Committed: ${data['committed'] === true ? 'yes' : 'no'}`)
      }
      const verification = record(data['verification'])
      if (verification !== null) {
        lines.push(
          `Read-back verification: ${verification['passed'] === true ? 'passed' : 'FAILED'} ` +
            `(${numberOf(verification['confirmedCount']) ?? 0}/${numberOf(verification['checked']) ?? 0} confirmed)`,
        )
        const missing = list(verification['missing'])
        if (missing.length > 0) lines.push(`  Missing after import: ${missing.map((item) => text(item) ?? '?').join(', ')}`)
        const advisory = list(verification['advisoryNotConfirmed'])
        if (advisory.length > 0) {
          lines.push(`  Not confirmed (external source names): ${advisory.map((item) => text(item) ?? '?').join(', ')}`)
        }
      }
      break
    }
    case 'CompilePlc': {
      if (data['dryRun'] === true) {
        lines.push(`Would compile ${numberOf(data['blockCount']) ?? 0} block(s) of ${text(data['device']) ?? '?'} / ${text(data['software']) ?? '?'}.`)
        break
      }
      lines.push(
        `Compile state: ${text(data['state']) ?? '?'}, errors: ${numberOf(data['errorCount']) ?? 0}, ` +
          `warnings: ${numberOf(data['warningCount']) ?? 0}, messages: ${numberOf(data['messageCount']) ?? 0}`,
      )
      for (const item of list(data['messages']).slice(0, MAX_LISTED)) {
        const entry = record(item)
        if (entry === null) continue
        lines.push(`  [${text(entry['level']) ?? '?'}] ${text(entry['description']) ?? ''} ${text(entry['path']) ?? ''}`.trimEnd())
      }
      if (data['messagesTruncated'] === true) lines.push('  … message list truncated')
      break
    }
    case 'CloseProject': {
      lines.push(`Project: ${text(data['projectName']) ?? '?'}`)
      if (data['dryRun'] === true) {
        lines.push(`Would save: ${data['wouldSave'] === true ? 'yes' : 'no'}, would close the TIA Portal instance: ${data['wouldClosePortal'] === true ? 'yes' : 'no'}`)
        break
      }
      lines.push(`Saved: ${data['saved'] === true ? 'yes' : 'no'}, closed: ${data['closed'] === true ? 'yes' : 'no'}, TIA Portal closed: ${data['portalClosed'] === true ? 'yes' : 'no'}`)
      break
    }
    case 'ControllerStatus': {
      // The status tool already renders every line into the summary.
      break
    }
    default: {
      lines.push(JSON.stringify(data, null, 2))
      break
    }
  }

  if (verbose) lines.push(`Controller payload:\n${JSON.stringify(data, null, 2)}`)
  return lines.join('\n')
}

/** The value shape inferred from {@link OUTCOME_SCHEMA}. */
type OutcomeValue = InferValue<typeof OUTCOME_SCHEMA>

/** Bridges the inferred schema value back to the envelope the renderer reads. */
function renderValue(value: OutcomeValue, verbose: boolean): string {
  return renderOutcome(value as unknown as ToolOutcome, verbose)
}

/** The single place that turns a controller frame into the model-facing text. */
export function renderOutcome(outcome: ToolOutcome, verbose: boolean): string {
  const header = outcome.ok
    ? `${outcome.operation} succeeded${outcome.dryRun ? ' (dry run — nothing was written)' : ''}.`
    : `${outcome.operation} FAILED.`
  const parts = [header, outcome.summary]
  const detail = renderData(outcome.operation, outcome.data, verbose)
  if (detail.length > 0) parts.push(detail)
  const error = renderError(outcome.error)
  if (error.length > 0) parts.push(error)
  const changes = renderChanges(outcome.changes)
  if (changes.length > 0) parts.push(changes)
  const diagnostics = renderDiagnostics(outcome.diagnostics)
  if (diagnostics.length > 0) parts.push(diagnostics)
  if (outcome.durationMs > 0) parts.push(`(${outcome.durationMs} ms in the controller)`)
  return parts.filter((part) => part.length > 0).join('\n')
}

// ----------------------------------------------------------------- the tools

/** The canonical output envelope every tool declares. */
const OUTCOME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Structured outcome of one TIA Portal V17 Openness operation.',
  properties: {
    ok: { type: 'boolean', required: true, description: 'True when the operation itself succeeded.' },
    operation: { type: 'string', required: true, description: 'The controller operation that ran.' },
    dryRun: { type: 'boolean', required: true, description: 'True when nothing was written.' },
    summary: { type: 'string', required: true, description: 'One-line human readable result.' },
    data: { type: 'json', description: 'The controller payload for this operation.' },
    changes: { type: 'array', required: true, items: { type: 'json' }, description: 'What the operation changed.' },
    diagnostics: { type: 'array', required: true, items: { type: 'json' }, description: 'Controller diagnostics.' },
    error: { type: 'json', description: 'Structured failure: code, message and details.' },
    durationMs: { type: 'number', required: true, description: 'Time the controller spent on the operation.' },
  },
} as const

function summarize(operation: string, frame: ResultFrame): string {
  if (frame.ok) {
    if (frame.dryRun === true) return `${operation} was validated in dry-run mode; pass dry_run=false to execute it.`
    return `${operation} completed${frame.durationMs === undefined ? '' : ` in ${frame.durationMs} ms`}.`
  }
  const message = frame.error?.message ?? 'the controller reported a failure'
  const details = record(frame.error?.details)
  const hint = details === null ? undefined : text(details['hint'])
  return hint === undefined ? message : `${message} ${hint}`
}

async function runOperation(
  dependencies: ToolDependencies,
  operation: string,
  params: JsonRecord,
  signal: AbortSignal | undefined,
): Promise<ToolOutcome> {
  const frame = await dependencies.request(operation, params, signal === undefined ? {} : { signal })
  return {
    ok: frame.ok,
    operation,
    dryRun: frame.dryRun === true,
    summary: summarize(operation, frame),
    data: record(frame.data),
    changes: changesOf(frame),
    diagnostics: diagnosticsOf(frame),
    error: frame.ok ? null : (frame.error ?? { code: 'unknown_failure', message: 'The controller reported no error detail.' }),
    durationMs: frame.durationMs ?? 0,
  }
}

/**
 * Registers every tool of this plugin on `ctx.tools`. The framework owns the
 * registrations, so their disposers are not managed here.
 *
 * @returns the registered tool names, in registration order.
 */
export function registerTools(ctx: Context, dependencies: ToolDependencies): string[] {
  const { verbose } = dependencies
  const registered: string[] = []

  const register = (definition: { name: string }): void => {
    ctx.tools.register(definition as never)
    registered.push(definition.name)
  }

  register(
    defineTool({
      name: 'open_project',
      description:
        'Open a TIA Portal V17 project for the PLC block tools (export/import/compile). Starts a headless TIA Portal ' +
        'instance or attaches to a running one, and keeps the project open until close_project is called. This is the ' +
        'first call of every workflow that touches a project. ' +
        'Writing: opening never modifies the project unless allow_upgrade is set, which rewrites an older project to ' +
        'V17; that is the explicit opt-in for the only write this tool can perform. dry_run validates the path and ' +
        'reports what would happen without opening anything. ' +
        'Fails with project_not_found, project_already_open, project_open_failed, openness_unavailable or ' +
        'openness_load_failed.',
      parameters: {
        project_path: {
          type: 'string',
          required: true,
          description: 'Absolute path of the TIA Portal project file, for example C:\\Projects\\Line1\\Line1.ap17.',
        },
        with_window: {
          type: 'boolean',
          description:
            'True to attach to an already running TIA Portal or start a visible one; false (the default) starts a ' +
            'headless instance that no operator can interact with.',
        },
        allow_upgrade: {
          type: 'boolean',
          description:
            'True to allow TIA Portal to upgrade and rewrite a project created by an older version. Off by default ' +
            'because it modifies the project file irreversibly.',
        },
        dry_run: {
          type: 'boolean',
          description: 'True to validate the request and report what would happen without opening the project.',
        },
      },
      output: {
        schema: OUTCOME_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
      },
      async execute(args, exec) {
        const params: JsonRecord = { project_path: args.project_path }
        if (args.with_window !== undefined) params['with_window'] = args.with_window
        if (args.allow_upgrade !== undefined) params['allow_upgrade'] = args.allow_upgrade
        if (args.dry_run !== undefined) params['dry_run'] = args.dry_run
        return asJsonOutcome(await runOperation(dependencies, 'OpenProject', params, exec.signal))
      },
    }),
  )

  register(
    defineTool({
      name: 'export_blocks',
      description:
        'Export PLC program objects of the open project to Simatic ML XML files, one file per object: program blocks ' +
        '(the default, including data blocks), PLC types (UDTs) and tag tables, selected with categories. The ' +
        'user-group folder layout is preserved; types are written below output_dir/types/ and tag tables below ' +
        'output_dir/tag_tables/, so the families never collide. ' +
        'user-group folder layout. Read-only for the project: it never modifies the project, only writes the files. ' +
        'Every written file is read back, parsed and compared with the expected block name, and a manifest with the ' +
        'SHA-256 of each file is written next to the exports so an import can be audited. ' +
        "Some blocks have no Simatic ML representation at all — TIA's own ProDiag blocks report the programming " +
        "language 'ProDiag_OB' as unsupported for import and export. Such blocks are reported per block in " +
        'data.failures and the remaining blocks are still exported; the call fails with export_failed only when ' +
        'nothing could be exported, or when a block named in block_names was refused. ' +
        'Requires an open project (open_project first). Fails with block_not_found (listing the available blocks), ' +
        'project_not_open, export_failed or verification_failed.',
      parameters: {
        output_dir: {
          type: 'string',
          required: true,
          description: 'Absolute directory the XML files are written to. It is created when missing.',
        },
        categories: {
          type: 'array',
          items: { type: 'string', enum: ['blocks', 'types', 'tag_tables'] },
          description:
            "Which object families to export: 'blocks' (default, includes data blocks), 'types' (PLC data types / " +
            "UDTs) and 'tag_tables'. Blocks are written as <output_dir>/<user group path>/<name>.xml, types under " +
            '<output_dir>/types/... and tag tables under <output_dir>/tag_tables/..., so the three families never collide.',
        },
        type_names: {
          type: 'array',
          items: { type: 'string' },
          description: "PLC type names to export when 'types' is selected. Omit to export every PLC type.",
        },
        tag_table_names: {
          type: 'array',
          items: { type: 'string' },
          description: "Tag table names to export when 'tag_tables' is selected. Omit to export every tag table.",
        },
        block_names: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Names of the blocks to export. Omit to export every block of the PLC. An unknown name fails the call ' +
            'with block_not_found and lists what the project contains.',
        },
        device_name: { type: 'string', description: 'Device that owns the PLC software. Only needed when the project has several PLCs.' },
        software_name: { type: 'string', description: 'PLC software name. Only needed when one device holds several PLC software instances.' },
        recursive: { type: 'boolean', description: 'True (default) to include blocks in user groups.' },
        overwrite: { type: 'boolean', description: 'True to replace existing files; false (default) skips them and reports it.' },
        export_options: {
          type: 'string',
          enum: ['none', 'with_defaults', 'with_read_only'],
          description: "TIA's ExportOptions: 'with_defaults' (default) exports default values, 'with_read_only' adds read-only information.",
        },
        write_manifest: { type: 'boolean', description: 'True (default) to write _tia-openness-manifest.json with sizes and SHA-256 hashes.' },
        dry_run: { type: 'boolean', description: 'True to list the files that would be written without writing anything.' },
      },
      output: {
        schema: OUTCOME_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
      },
      async execute(args, exec) {
        const params: JsonRecord = {
          output_dir: args.output_dir,
          categories: args.categories ?? ['blocks'],
          recursive: args.recursive ?? true,
          overwrite: args.overwrite ?? false,
          export_options: args.export_options ?? 'with_defaults',
          write_manifest: args.write_manifest ?? true,
          dry_run: args.dry_run ?? false,
        }
        if (args.block_names !== undefined) params['block_names'] = args.block_names
        if (args.type_names !== undefined) params['type_names'] = args.type_names
        if (args.tag_table_names !== undefined) params['tag_table_names'] = args.tag_table_names
        if (args.device_name !== undefined) params['device_name'] = args.device_name
        if (args.software_name !== undefined) params['software_name'] = args.software_name
        return asJsonOutcome(await runOperation(dependencies, 'ExportBlocks', params, exec.signal))
      },
    }),
  )

  register(
    defineTool({
      name: 'import_blocks',
      description:
        'Import PLC blocks into the open project from Simatic ML XML files or from SCL/STL external sources. ' +
        'WRITES to the project, and therefore defaults to dry_run: the call validates every file, resolves the target ' +
        'block names, reports whether each one already exists, and lists conflicts — without changing anything. Pass ' +
        'dry_run=false to actually import. ' +
        "The object family of every Simatic ML file is detected from its XML element (SW.Blocks.* = program block, " +
        "SW.Types.* = PLC type, SW.Tags.PlcTagTable = tag table), so the three families can be imported in one call; " +
        "categories narrows that. The import runs inside one TIA Portal exclusive-access transaction. If any file fails, the transaction is " +
        'rolled back and the project is left unchanged. After the transaction commits, the plugin reads the block ' +
        'composition back from the project and reports a verification block; when an expected block is missing the ' +
        'operation fails with verification_failed even though the write happened. ' +
        "Use import_options 'override' to replace blocks that already exist (TIA refuses duplicates with 'none'). " +
        'Fails with invalid_params, invalid_file, block_not_found, import_failed, verification_failed or project_not_open.',
      parameters: {
        import_paths: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'Files or directories to import. Directories are scanned for *.xml, *.scl, *.stl, *.db, *.udt, *.txt and *.src.',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'simatic_ml', 'external_source'],
          description:
            "'auto' (default) treats *.xml as Simatic ML and every other supported extension as an external source; the " +
            'other two values force one interpretation.',
        },
        import_options: {
          type: 'string',
          enum: ['none', 'override'],
          description: "'none' (default) fails when a block already exists; 'override' replaces the existing block.",
        },
        sw_import_options: {
          type: 'array',
          items: { type: 'string', enum: ['ignore_structural_changes', 'ignore_missing_referenced_objects', 'ignore_unit_attributes'] },
          description: "TIA's SWImportOptions flags, applied together. Omit for strict importing.",
        },
        generate_option: {
          type: 'string',
          enum: ['none', 'keep_on_error'],
          description: "For external sources: 'none' (default) stops at the first error, 'keep_on_error' generates the blocks that compile.",
        },
        target_group: {
          type: 'string',
          description:
            "User-group path to import into, for example '999_Kautex' or 'A/B'. This matters: import evaluates block " +
            'name and number collisions across the whole PLC, so a block that lives in a user group has to be imported ' +
            'back into that same group — ImportOptions.Override alone cannot overwrite it from the root group ' +
            '("An object with this name or this number already exists"). Omit it to import into the root block group, ' +
            'or, for a directory input, to mirror the directory layout.',
        },
        create_group: {
          type: 'boolean',
          description: 'True to create a missing target group instead of failing with group_not_found. Defaults to false.',
        },
        mirror_groups: {
          type: 'boolean',
          description:
            'True (default) to derive each file\'s target group from its subdirectory when a directory is imported, ' +
            'which restores the layout an export wrote. A group that does not exist falls back to the root group with a warning.',
        },
        device_name: { type: 'string', description: 'Device that owns the PLC software. Only needed when the project has several PLCs.' },
        software_name: { type: 'string', description: 'PLC software name. Only needed when one device holds several PLC software instances.' },
        recursive: { type: 'boolean', description: 'True (default) to scan directories recursively.' },
        verify: { type: 'boolean', description: 'True (default) to read the block composition back after committing.' },
        keep_source: { type: 'boolean', description: 'True to keep an imported external source in the project (TIA keeps it by default); false (default) deletes it after generating the blocks.' },
        dry_run: { type: 'boolean', description: 'Defaults to true: validate and report only. Set false to write to the project.' },
      },
      output: {
        schema: OUTCOME_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
      },
      async execute(args, exec) {
        const params: JsonRecord = {
          import_paths: args.import_paths,
          mode: args.mode ?? 'auto',
          import_options: args.import_options ?? 'none',
          generate_option: args.generate_option ?? 'none',
          create_group: args.create_group ?? false,
          mirror_groups: args.mirror_groups ?? true,
          recursive: args.recursive ?? true,
          verify: args.verify ?? true,
          keep_source: args.keep_source ?? false,
          dry_run: args.dry_run ?? true,
        }
        if (args.target_group !== undefined) params['target_group'] = args.target_group
        if (args.sw_import_options !== undefined) params['sw_import_options'] = args.sw_import_options
        if (args.device_name !== undefined) params['device_name'] = args.device_name
        if (args.software_name !== undefined) params['software_name'] = args.software_name
        return asJsonOutcome(await runOperation(dependencies, 'ImportBlocks', params, exec.signal))
      },
    }),
  )

  register(
    defineTool({
      name: 'compile_plc',
      description:
        'Compile the PLC software of the open project and report the compiler result (state, error count, warning ' +
        'count and the individual messages). Use it to verify that imported blocks really are consistent. ' +
        'Compiling changes the project compile state, so it defaults to dry_run: the call lists the blocks that would ' +
        'be compiled. Pass dry_run=false to compile. ' +
        'Compile errors are reported as data (state "Error", errorCount > 0) and are not an error of this tool. ' +
        'Fails with project_not_open, plc_software_not_found, plc_software_ambiguous, compile_provider_unavailable ' +
        'or compile_failed.',
      parameters: {
        device_name: { type: 'string', description: 'Device that owns the PLC software. Only needed when the project has several PLCs.' },
        software_name: { type: 'string', description: 'PLC software name. Only needed when one device holds several PLC software instances.' },
        max_messages: { type: 'integer', description: 'Maximum number of compiler messages to return (default 200).' },
        dry_run: { type: 'boolean', description: 'Defaults to true: list what would be compiled. Set false to compile.' },
      },
      output: {
        schema: OUTCOME_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
      },
      async execute(args, exec) {
        const params: JsonRecord = { dry_run: args.dry_run ?? true }
        if (args.device_name !== undefined) params['device_name'] = args.device_name
        if (args.software_name !== undefined) params['software_name'] = args.software_name
        if (args.max_messages !== undefined) params['max_messages'] = args.max_messages
        return asJsonOutcome(await runOperation(dependencies, 'CompilePlc', params, exec.signal))
      },
    }),
  )

  register(
    defineTool({
      name: 'close_project',
      description:
        'Close the TIA Portal project held by the controller and optionally save it first or shut the TIA Portal ' +
        'instance down. Defaults to dry_run because saving or closing a TIA Portal instance is a write to the session; ' +
        'pass dry_run=false to do it. Closing without saving discards unsaved changes, so call compile_plc and inspect ' +
        'its result before closing when you imported blocks. ' +
        'Fails with project_not_open or project_close_failed.',
      parameters: {
        save: { type: 'boolean', description: 'True to save the project before closing it. Defaults to false, which discards unsaved changes.' },
        close_portal: { type: 'boolean', description: 'True to shut down the TIA Portal instance the controller started. Defaults to false.' },
        dry_run: { type: 'boolean', description: 'Defaults to true: report what would happen. Set false to close the project.' },
      },
      output: {
        schema: OUTCOME_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
      },
      async execute(args, exec) {
        const params: JsonRecord = {
          save: args.save ?? false,
          close_portal: args.close_portal ?? false,
          dry_run: args.dry_run ?? true,
        }
        return asJsonOutcome(await runOperation(dependencies, 'CloseProject', params, exec.signal))
      },
    }),
  )

  register(
    defineTool({
      name: 'controller_status',
      description:
        'Report the state of the C# Openness controller subprocess: whether it is running, its process id, the ' +
        'resolved executable path, whether the Openness installation was found, whether the current Windows user is in ' +
        'the "Siemens TIA Openness" local group, how many requests it served, and the last error. ' +
        'Call this first when another TIA tool fails unexpectedly or appears to hang. It never starts a controller, ' +
        'never talks to TIA Portal and never writes anything.',
      parameters: {
        include_controller_output: {
          type: 'boolean',
          description: 'True to include the captured controller stdout/stderr tails in the result (default false).',
        },
      },
      output: {
        schema: OUTCOME_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
      },
      async execute(args) {
        const status = dependencies.status()
        const verboseStatus: JsonRecord = { ...status }
        if (args.include_controller_output !== true) {
          delete verboseStatus['stderrTail']
          delete verboseStatus['unexpectedOutput']
        }

        const ready = record(status['ready'])
        const openness = ready === null ? null : record(ready['openness'])
        const userGroup = ready === null ? null : record(ready['opennessUserGroup'])
        const parts = [
          `Controller state: ${text(status['state']) ?? 'unknown'}`,
          `Executable: ${text(status['exePath']) ?? '?'} (exists: ${status['exeExists'] === true ? 'yes' : 'no'})`,
        ]
        if (status['pid'] !== null && status['pid'] !== undefined) parts.push(`Process id: ${text(status['pid'])}`)
        if (openness !== null) {
          parts.push(
            `Openness: ${openness['available'] === true ? 'available' : 'NOT AVAILABLE'} at ${text(openness['assemblyPath']) ?? '?'}` +
              (text(openness['fileVersion']) === undefined ? '' : ` (file version ${text(openness['fileVersion'])})`),
          )
          const reason = text(openness['message'])
          if (reason !== undefined && openness['available'] !== true) parts.push(reason)
        } else {
          parts.push('The controller has not been started yet, so Openness has not been probed.')
        }
        if (userGroup !== null) {
          const member = userGroup['isMember']
          parts.push(`"${text(userGroup['group']) ?? 'Siemens TIA Openness'}" membership: ${member === null || member === undefined ? 'unknown' : member === true ? 'yes' : 'NO'}`)
          const message = text(userGroup['message'])
          if (message !== undefined) parts.push(message)
        }
        parts.push(`Requests served: ${numberOf(status['requestsServed']) ?? 0}, restarts: ${numberOf(status['restarts']) ?? 0}, queued: ${numberOf(status['queueDepth']) ?? 0}`)
        const lastError = record(status['lastError'])
        if (lastError !== null) parts.push(`Last error: ${text(lastError['code']) ?? '?'} — ${text(lastError['message']) ?? '?'}`)

        const outcome: ToolOutcome = {
          ok: true,
          operation: 'ControllerStatus',
          dryRun: true,
          summary: parts.join('\n'),
          data: verboseStatus,
          changes: [],
          diagnostics: [],
          error: null,
          durationMs: 0,
        }
        return asJsonOutcome(outcome)
      },
    }),
  )

  return registered
}

/**
 * The registry validates the canonical value against the declared schema and
 * rejects anything that is not lossless JSON, so the envelope is converted once
 * here instead of at every return site.
 */
function asJsonOutcome(outcome: ToolOutcome): {
  ok: boolean
  operation: string
  dryRun: boolean
  summary: string
  data: JsonValue
  changes: JsonValue[]
  diagnostics: JsonValue[]
  error: JsonValue
  durationMs: number
} {
  return {
    ok: outcome.ok,
    operation: outcome.operation,
    dryRun: outcome.dryRun,
    summary: outcome.summary,
    data: asJson(outcome.data),
    changes: outcome.changes.map((change) => asJson(change)),
    diagnostics: outcome.diagnostics.map((entry) => asJson(entry)),
    error: asJson(outcome.error),
    durationMs: outcome.durationMs,
  }
}

/** Re-exported for the tests, which drive the tool bodies directly. */
export { runOperation }
