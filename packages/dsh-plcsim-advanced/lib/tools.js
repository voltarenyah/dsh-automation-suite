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
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveSnapshotRoot, sessionWorkspaceRoot } from './workspace.js';
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
};
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}
function text(value) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return undefined;
}
function asJson(value) {
    return value;
}
function asJsonOutcome(outcome) {
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
    };
}
function failure(operation, code, message) {
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
    };
}
async function runOperation(dependencies, operation, params, signal) {
    const frame = await dependencies.request(operation, params, signal === undefined ? {} : { signal });
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
    };
}
/**
 * The snapshot root for one call.
 *
 * It comes from the session workspace; an explicit configuration pins the root
 * instead. The caller adds it to `params` as `snapshot_root` so the controller
 * never has to guess a workspace from the host process cwd.
 */
function snapshotScope(dependencies, exec) {
    const root = resolveSnapshotRoot(dependencies.configuredSnapshotRoot ?? '', sessionWorkspaceRoot(exec));
    return { root, params: root === undefined ? {} : { snapshot_root: root } };
}
const FACT_KEYS = ['name', 'state', 'cpuType', 'comm', 'ip', 'networkMode', 'snapshot'];
/**
 * The few facts the model always needs back, rendered even when `verbose` is
 * off. The 0.2.4 acceptance session lost 20 minutes because a successful
 * `create` rendered only "succeeded": the model could not see the instance name,
 * state or CPU it had just made, distrusted the empty answer and went probing.
 */
function renderFacts(data) {
    if (data === null)
        return [];
    const facts = [];
    for (const key of FACT_KEYS) {
        const value = data[key];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            facts.push(`${key}=${String(value)}`);
        }
    }
    const snapshots = data['snapshots'];
    if (Array.isArray(snapshots) && snapshots.length > 0) {
        const names = snapshots
            .map((row) => (typeof row === 'object' && row !== null ? row['snapshot'] : undefined))
            .filter((name) => typeof name === 'string');
        if (names.length > 0)
            facts.push(`snapshots=${names.join(',')}`);
    }
    const instances = data['registeredInstances'];
    if (Array.isArray(instances) && instances.length > 0) {
        const names = instances
            .map((row) => (typeof row === 'object' && row !== null ? row['name'] : undefined))
            .filter((name) => typeof name === 'string');
        if (names.length > 0)
            facts.push(`live=${names.join(',')}`);
    }
    return facts.length === 0 ? [] : [`Key facts: ${facts.join(' ')}`];
}
function renderValue(value, verbose) {
    const outcome = value;
    const lines = [outcome.ok ? `${outcome.operation} succeeded.` : `${outcome.operation} FAILED.`, outcome.summary];
    if (outcome.error !== null) {
        lines.push(`Error code: ${outcome.error.code}`, `Reason: ${outcome.error.message}`);
    }
    lines.push(...renderFacts(outcome.data));
    if (verbose && outcome.data !== null)
        lines.push(`Controller payload:\n${JSON.stringify(outcome.data, null, 2)}`);
    return lines.filter((line) => line.length > 0).join('\n');
}
const CERTIFICATE_RULE = 'Certificate rule: the self-signed certificate is trusted per VIRTUAL DEVICE, so a brand-new instance needs the ' +
    'user to click Connect once in the TIA Portal UI on its first CONNECT/download (Openness cannot answer that ' +
    'dialog), while a resumed/restored snapshot keeps the original identity and needs no acceptance and no download. ' +
    'So before starting a simulation, scan first: simulation_instance(action="snapshots") lists this workspace\'s ' +
    'saved snapshots and the instances still registered, then ask the user whether to resume one of them or create a ' +
    'new instance.';
const INPUT_HINT = 'PLCSIM Advanced runtime tools manage a local simulation: instance lifecycle, RUN/STOP, and tag I/O. They do not ' +
    'load a program; the TIA plugin downloads into the instance. Proven workflow: TIA online_targets -> create a ' +
    'tcpip instance with the same CPU/IP -> power_on -> TIA adopt_open_project / online_disconnect(force) / download ' +
    '-> read tags. ' +
    CERTIFICATE_RULE +
    ' Snapshots live under the session workspace at <workspace>/.dsh/simulation/<snapshot>/, so they survive a host ' +
    'restart and are part of the workspace the user backs up. ' +
    'F-CPU (fail-safe) projects: the virtual CPU must match the project CPU; a standard family cannot take F project ' +
    'data. Create the matching F type (cpu_type="1515F") or, better, pass cpu_model with the project order number/' +
    'type name from hardware_inventory; "unspecified" also works (the first TIA download initializes the type). Tell ' +
    'the user V17 Openness cannot download an F-activated PLC - the download must be done in the TIA Portal UI.';
export function registerTools(ctx, dependencies) {
    const { verbose } = dependencies;
    const registered = [];
    const register = (definition) => {
        ctx.tools.register(definition);
        registered.push(definition.name);
    };
    register(defineTool({
        name: 'simulation_status',
        description: 'Report the PLCSIM Advanced runtime installation (API and Runtime versions), the licence status of the ' +
            'managed instances, their names/states, and the controller state. Read-only and safe to call at any time; ' +
            'it starts the controller only if it is not running. It also reports this workspace\'s snapshot root, the ' +
            'snapshots saved there, and the instances the Runtime Manager still holds, so a first call already tells ' +
            'you whether anything can be resumed. ' + INPUT_HINT,
        parameters: {},
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(_args, exec) {
            const scope = snapshotScope(dependencies, exec);
            return asJsonOutcome(await runOperation(dependencies, 'Status', scope.params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'simulation_instance',
        description: 'Manage PLCSIM Advanced instances: list (default), snapshots (what this workspace already saved), create, ' +
            'power_on, power_off, remove, snapshot, restore or resume. Start with list or snapshots whenever the user ' +
            'asks to run a simulation, and let them choose between a new instance and an existing snapshot before you ' +
            'create anything. Creating an instance registers it, picks the CPU family and communication interface, and ' +
            'starts the Control Panel (configurable); it makes a NEW virtual device with a new self-signed certificate, ' +
            'so the first TIA CONNECT/download needs one manual Connect click in the TIA Portal UI (say so before ' +
            'creating). power_on starts the simulated CPU; when ip is given, the instance IP suite is applied after ' +
            'power-on. Use communication="tcpip" + the project IP for the Openness download workflow (the proven ' +
            'path); Softbus only exists in TIA V20 (V17 exposes TCP/IP only). snapshot archives the program/hardware/' +
            'retentive data as a ZIP plus a fast storage copy under <workspace>/.dsh/simulation (the instance is ' +
            'briefly stopped if needed); restore recreates from a snapshot; resume is the non-first-run fast path: it ' +
            'attaches to a still-running instance, otherwise restores the fast storage copy (ZIP fallback) and powers ' +
            'it on - it keeps the original device identity, so no certificate acceptance and no TIA download are ' +
            'needed. power_off and remove require confirm=true; create needs confirm_new=true once this workspace holds ' +
            'any snapshot, otherwise it refuses with snapshots_available and names them so the user chooses first. ' +
            'list returns the coordinates the TIA side needs: name, ' +
            'communication, ip, state, CPU and licence, plus the snapshots and the already-registered instances. ' +
            'Instances stay running when the plugin unloads by default (keepInstancesOnUnload); remove explicitly ' +
            'cleans up. ' +
            'F-CPU (fail-safe) projects: PLCSIM Advanced V7 supports them, but the virtual CPU must match the project ' +
            'CPU - a standard family instance cannot accept F project data (TIA: "virtual PLC model does not match the ' +
            'project PLC model"; V7 manual §7.4). Pass the matching F family (cpu_type="1515F") or, better, cpu_model ' +
            'with the project CPU order number/type name from hardware_inventory (e.g. "6ES7 515-2FM01-0AB0" or ' +
            '"CPU 1515F-2 PN"); "unspecified" also works (the first TIA download initializes the type). V17 Openness ' +
            'cannot download to an F-activated PLC (download_unavailable), so tell the user up front that the suite ' +
            'cannot finish the download automatically and that it must be done in the TIA Portal UI. ' + INPUT_HINT,
        parameters: {
            action: {
                type: 'string',
                enum: ['list', 'snapshots', 'create', 'power_on', 'power_off', 'remove', 'snapshot', 'restore', 'resume'],
                description: "Action to perform; defaults to 'list'. 'snapshots' lists the snapshot root of this workspace plus the " +
                    'instances the Runtime Manager still holds, without starting anything.',
            },
            name: { type: 'string', description: 'Instance name (required for everything except list). Convention: the CPU PROFINET device name.' },
            cpu_type: {
                type: 'string',
                enum: [
                    'unspecified',
                    '1511',
                    '1513',
                    '1515',
                    '1516',
                    '1517',
                    '1518',
                    '1511F',
                    '1513F',
                    '1515F',
                    '1516F',
                    '1517F',
                    '1518F',
                ],
                description: 'CPU family for create/restore; must match the project CPU. Standard families: 1511/1513/1515/1516/' +
                    '1517/1518; fail-safe families append F (1515F, ...). For an F-CPU project a standard family is rejected ' +
                    'as "virtual PLC model does not match the project PLC model"; prefer cpu_model with the order number, or ' +
                    '"unspecified" (the first TIA download initializes the type).',
            },
            cpu_model: {
                type: 'string',
                description: 'Exact project CPU model/order number from hardware_inventory (e.g. "6ES7 515-2FM01-0AB0" or ' +
                    '"CPU 1515F-2 PN"). The controller derives the PLCSIM instance CPU type from it (F included); it wins ' +
                    'over cpu_type="unspecified" and must agree with a specific cpu_type (otherwise cpu_type_mismatch).',
            },
            communication: {
                type: 'string',
                enum: ['softbus', 'tcpip'],
                description: "Communication interface for create/restore; defaults to the plugin's networkMode. Use 'tcpip' for the Openness download workflow.",
            },
            ip: { type: 'string', description: 'IPv4 address for the instance (TCP/IP). Pass the project CPU IP read from online_targets.' },
            subnet_mask: { type: 'string', description: 'Subnet mask for ip (default 255.255.255.0).' },
            gateway: { type: 'string', description: 'Default gateway for ip (default 0.0.0.0).' },
            snapshot: { type: 'string', description: 'Snapshot name (under the workspace snapshot root) for snapshot, or a name/absolute ZIP path for restore/resume.' },
            overwrite: { type: 'boolean', description: 'True to replace an existing snapshot with the same name (default false).' },
            run: { type: 'boolean', description: 'For restore/resume: true to switch the instance to RUN after power-on (default false for restore, true for resume).' },
            fast: { type: 'boolean', description: 'For restore: prefer the snapshot storage copy (fast) over the ZIP; default true, falls back to the ZIP.' },
            confirm_new: {
                type: 'boolean',
                description: 'Required for create once this workspace already holds snapshots: true states that the user chose a NEW ' +
                    'instance (new device, manual certificate once) over resuming one of them.',
            },
            confirm: { type: 'boolean', description: 'Must be true for power_off and remove.' },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const action = args.action ?? 'list';
            if ((action === 'power_off' || action === 'remove') && args.confirm !== true) {
                return asJsonOutcome(failure('Instance', 'confirmation_required', `The '${action}' action needs confirm=true.`));
            }
            const scope = snapshotScope(dependencies, exec);
            const params = { action, ...scope.params };
            if (args.name !== undefined)
                params['name'] = args.name;
            if (args.cpu_type !== undefined)
                params['cpu_type'] = args.cpu_type;
            if (args.cpu_model !== undefined)
                params['cpu_model'] = args.cpu_model;
            if (args.communication !== undefined)
                params['communication'] = args.communication;
            if (args.ip !== undefined)
                params['ip'] = args.ip;
            if (args.subnet_mask !== undefined)
                params['subnet_mask'] = args.subnet_mask;
            if (args.gateway !== undefined)
                params['gateway'] = args.gateway;
            if (args.snapshot !== undefined)
                params['snapshot'] = args.snapshot;
            if (args.overwrite !== undefined)
                params['overwrite'] = args.overwrite;
            if (args.run !== undefined)
                params['run'] = args.run;
            if (args.fast !== undefined)
                params['fast'] = args.fast;
            if (args.confirm_new !== undefined)
                params['confirm_new'] = args.confirm_new;
            return asJsonOutcome(await runOperation(dependencies, 'Instance', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'simulation_run',
        description: 'Read or change the operating state of a PLCSIM Advanced instance: state (default), run, stop or reset ' +
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
            const action = args.action ?? 'state';
            if (action !== 'state' && args.confirm !== true) {
                return asJsonOutcome(failure('Run', 'confirmation_required', `The '${action}' action needs confirm=true.`));
            }
            return asJsonOutcome(await runOperation(dependencies, 'Run', { action, name: args.name }, exec.signal));
        },
    }));
    register(defineTool({
        name: 'simulation_tags',
        description: 'List, read or write tags of a PLCSIM Advanced instance by tag name. list is capped (default 200 rows); ' +
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
            const action = args.action ?? 'list';
            if (action === 'write' && args.confirm !== true) {
                return asJsonOutcome(failure('Tags', 'confirmation_required', "The 'write' action needs confirm=true."));
            }
            const params = { action, name: args.name };
            if (args.tag !== undefined)
                params['tag'] = args.tag;
            if (args.value !== undefined)
                params['value'] = args.value;
            if (args.max !== undefined)
                params['max'] = args.max;
            return asJsonOutcome(await runOperation(dependencies, 'Tags', params, exec.signal));
        },
    }));
    return registered;
}
