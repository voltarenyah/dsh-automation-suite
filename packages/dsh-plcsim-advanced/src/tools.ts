/**
 * The four model-facing tools of the runtime MVP:
 *
 *   simulation_status    read-only availability/licence/instances
 *   simulation_instance  create / power on / power off / remove / list
 *   simulation_run       RUN / STOP / memory reset / state
 *   simulation_tags      list / read / write PLC tags
 *
 * Program *loading* is not a tool here. On TIA V17 Openness there is no PLCSIM
 * download API (see docs/simulation-plcsim-advanced.md §10), so the controller
 * deliberately does not pretend to load a program: use a PLCSIM instance that
 * already contains a program, or wait for the V20 / manual-download decision.
 *
 * @module dsh-plcsim-advanced/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type InferValue, type JsonValue } from '@deepseek-ai/dsh-tools'

import type { LogSink } from './controller.js'
import type { JsonRecord, ResultFrame } from './protocol.js'

export interface ToolDependencies {
  request(operation: string, params: JsonRecord, options: { signal?: AbortSignal }): Promise<ResultFrame>
  status(): JsonRecord
  verbose: boolean
  log: LogSink
}

export interface ToolOutcome {
  ok: boolean
  operation: string
  dryRun: boolean
  summary: string
  data: JsonRecord | null
  changes: readonly JsonRecord[]
  diagnostics: readonly JsonRecord[]
  error: { code: string; message: string; details?: unknown } | null
  durationMs: number
}

const OUTCOME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Structured outcome of one PLCSIM Advanced operation.',
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

type OutcomeValue = InferValue<typeof OUTCOME_SCHEMA>

function record(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue
}

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
    changes: outcome.changes.map(asJson),
    diagnostics: outcome.diagnostics.map(asJson),
    error: asJson(outcome.error),
    durationMs: outcome.durationMs,
  }
}

function failure(operation: string, code: string, message: string): ToolOutcome {
  return {
    ok: false,
    operation,
    dryRun: true,
    summary: message,
    data: null,
    changes: [],
    diagnostics: [],
    error: { code, message },
    durationMs: 0,
  }
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
    dryRun: false,
    summary: frame.ok
      ? `${operation} completed${frame.durationMs === undefined ? '' : ` in ${frame.durationMs} ms`}.`
      : (frame.error?.message ?? 'the controller reported a failure'),
    data: record(frame.data),
    changes: [],
    diagnostics: [],
    error: frame.ok
      ? null
      : (frame.error ?? { code: 'unknown_failure', message: 'The controller reported no error detail.' }),
    durationMs: frame.durationMs ?? 0,
  }
}

function renderValue(value: OutcomeValue, verbose: boolean): string {
  const outcome = value as unknown as ToolOutcome
  const lines = [outcome.ok ? `${outcome.operation} succeeded.` : `${outcome.operation} FAILED.`, outcome.summary]
  if (outcome.error !== null) {
    lines.push(`Error code: ${outcome.error.code}`, `Reason: ${outcome.error.message}`)
  }
  if (verbose && outcome.data !== null) lines.push(`Controller payload:\n${JSON.stringify(outcome.data, null, 2)}`)
  return lines.filter((line) => line.length > 0).join('\n')
}

const INPUT_HINT =
  'PLCSIM Advanced runtime tools manage a local simulation: instance lifecycle, RUN/STOP, and tag I/O. They do not ' +
  'load a program; the TIA plugin downloads into the instance. Proven workflow: TIA online_targets -> create a ' +
  'tcpip instance with the same CPU/IP -> power_on -> TIA adopt_open_project / online_disconnect(force) / download ' +
  '-> read tags. The first connection needs the self-signed certificate accepted once in the TIA UI.'

export function registerTools(ctx: Context, dependencies: ToolDependencies): string[] {
  const { verbose } = dependencies
  const registered: string[] = []
  const register = (definition: { name: string }): void => {
    ctx.tools.register(definition as never)
    registered.push(definition.name)
  }

  register(
    defineTool({
      name: 'simulation_status',
      description:
        'Report the PLCSIM Advanced runtime installation (API and Runtime versions), the licence status of the ' +
        'managed instances, their names/states, and the controller state. Read-only and safe to call at any time; ' +
        'it starts the controller only if it is not running. ' + INPUT_HINT,
      parameters: {},
      output: {
        schema: OUTCOME_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
      },
      async execute(_args, exec) {
        return asJsonOutcome(await runOperation(dependencies, 'Status', {}, exec.signal))
      },
    }),
  )

  register(
    defineTool({
      name: 'simulation_instance',
      description:
        'Manage PLCSIM Advanced instances: list (default), create, power_on, power_off, remove, snapshot, restore or ' +
        'resume. Creating an instance registers it, picks the CPU family and communication interface, and starts the ' +
        'Control Panel (configurable). power_on starts the simulated CPU; when ip is given, the instance IP suite is ' +
        'applied after power-on. Use communication="tcpip" + the project IP for the Openness download workflow (the ' +
        'proven path); Softbus only exists in TIA V20 (V17 exposes TCP/IP only). snapshot archives the program/' +
        'hardware/retentive data as a ZIP plus a fast storage copy under snapshotRoot (the instance is briefly ' +
        'stopped if needed); restore recreates from a snapshot; resume is the non-first-run fast path: it attaches ' +
        'to a still-running instance, otherwise restores the fast storage copy (ZIP fallback) and powers it on. ' +
        'power_off and remove require confirm=true. list returns the coordinates the TIA side needs: name, ' +
        'communication, ip, state, CPU and licence. Instances stay running when the plugin unloads by default ' +
        '(keepInstancesOnUnload); remove explicitly cleans up. ' + INPUT_HINT,
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'power_on', 'power_off', 'remove', 'snapshot', 'restore', 'resume'],
          description: "Action to perform; defaults to 'list'.",
        },
        name: { type: 'string', description: 'Instance name (required for everything except list). Convention: the CPU PROFINET device name.' },
        cpu_type: {
          type: 'string',
          enum: ['unspecified', '1511', '1513', '1515', '1516', '1517', '1518'],
          description: 'CPU family for create/restore; must match the project CPU (e.g. 1511) for a download.',
        },
        communication: {
          type: 'string',
          enum: ['softbus', 'tcpip'],
          description: "Communication interface for create/restore; defaults to the plugin's networkMode. Use 'tcpip' for the Openness download workflow.",
        },
        ip: { type: 'string', description: 'IPv4 address for the instance (TCP/IP). Pass the project CPU IP read from online_targets.' },
        subnet_mask: { type: 'string', description: 'Subnet mask for ip (default 255.255.255.0).' },
        gateway: { type: 'string', description: 'Default gateway for ip (default 0.0.0.0).' },
        snapshot: { type: 'string', description: 'Snapshot name (under snapshotRoot) for snapshot, or a name/absolute ZIP path for restore/resume.' },
        overwrite: { type: 'boolean', description: 'True to replace an existing snapshot with the same name (default false).' },
        run: { type: 'boolean', description: 'For restore/resume: true to switch the instance to RUN after power-on (default false for restore, true for resume).' },
        fast: { type: 'boolean', description: 'For restore: prefer the snapshot storage copy (fast) over the ZIP; default true, falls back to the ZIP.' },
        confirm: { type: 'boolean', description: 'Must be true for power_off and remove.' },
      },
      output: {
        schema: OUTCOME_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
      },
      async execute(args, exec) {
        const action = args.action ?? 'list'
        if ((action === 'power_off' || action === 'remove') && args.confirm !== true) {
          return asJsonOutcome(
            failure('Instance', 'confirmation_required', `The '${action}' action needs confirm=true.`),
          )
        }
        const params: JsonRecord = { action }
        if (args.name !== undefined) params['name'] = args.name
        if (args.cpu_type !== undefined) params['cpu_type'] = args.cpu_type
        if (args.communication !== undefined) params['communication'] = args.communication
        if (args.ip !== undefined) params['ip'] = args.ip
        if (args.subnet_mask !== undefined) params['subnet_mask'] = args.subnet_mask
        if (args.gateway !== undefined) params['gateway'] = args.gateway
        if (args.snapshot !== undefined) params['snapshot'] = args.snapshot
        if (args.overwrite !== undefined) params['overwrite'] = args.overwrite
        if (args.run !== undefined) params['run'] = args.run
        if (args.fast !== undefined) params['fast'] = args.fast
        return asJsonOutcome(await runOperation(dependencies, 'Instance', params, exec.signal))
      },
    }),
  )

  register(
    defineTool({
      name: 'simulation_run',
      description:
        'Read or change the operating state of a PLCSIM Advanced instance: state (default), run, stop or reset ' +
        '(memory reset). run/stop/reset require confirm=true. A program must already be loaded; a fresh instance ' +
        'returns program_not_loaded (PLCSIM IsEmpty) until a download has happened. ' + INPUT_HINT,
      parameters: {
        action: {
          type: 'string',
          enum: ['state', 'run', 'stop', 'reset'],
          description: "Action to perform; defaults to 'state'.",
        },
        name: { type: 'string', description: 'Instance name (required).' },
        confirm: { type: 'boolean', description: 'Must be true for run, stop and reset.' },
      },
      output: {
        schema: OUTCOME_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
      },
      async execute(args, exec) {
        const action = args.action ?? 'state'
        if (action !== 'state' && args.confirm !== true) {
          return asJsonOutcome(
            failure('Run', 'confirmation_required', `The '${action}' action needs confirm=true.`),
          )
        }
        return asJsonOutcome(
          await runOperation(dependencies, 'Run', { action, name: args.name }, exec.signal),
        )
      },
    }),
  )

  register(
    defineTool({
      name: 'simulation_tags',
      description:
        'List, read or write tags of a PLCSIM Advanced instance by tag name. list is capped (default 200 rows); ' +
        'read/write need tag=; write needs value= and confirm=true. The tag list is refreshed before every call. ' +
        'Supported writes in this MVP: Bool, integer families, Real/LReal. ' + INPUT_HINT,
      parameters: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'write'],
          description: "Action to perform; defaults to 'list'.",
        },
        name: { type: 'string', description: 'Instance name (required).' },
        tag: { type: 'string', description: 'Tag name for read/write, e.g. "\\"DB_CylinderHMI\\".cylinder1.btn_forward".' },
        value: { type: 'json', description: 'Value to write (Bool/number), required for write.' },
        max: { type: 'integer', description: 'Maximum rows returned by list (default 200).' },
        confirm: { type: 'boolean', description: 'Must be true for write.' },
      },
      output: {
        schema: OUTCOME_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
      },
      async execute(args, exec) {
        const action = args.action ?? 'list'
        if (action === 'write' && args.confirm !== true) {
          return asJsonOutcome(
            failure('Tags', 'confirmation_required', "The 'write' action needs confirm=true."),
          )
        }
        const params: JsonRecord = { action, name: args.name }
        if (args.tag !== undefined) params['tag'] = args.tag
        if (args.value !== undefined) params['value'] = args.value
        if (args.max !== undefined) params['max'] = args.max
        return asJsonOutcome(await runOperation(dependencies, 'Tags', params, exec.signal))
      },
    }),
  )

  return registered
}
