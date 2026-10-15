/**
 * The `engineeringAccess` service: the seam the engineering-context plugin
 * uses to ask this plugin for project data.
 *
 * Why it exists: fingerprints — the only hard evidence that an engineering
 * object changed (decision D6) — can only be read with a project open, and
 * **this** is the plugin that is allowed to talk to TIA Portal. The
 * engineering-context plugin must therefore ask, not do
 * (docs/ARCHITECTURE.md §5.3 in that package, and the
 * "seam A" decision D12 in `docs/decisions.md`).
 *
 * Three properties matter more than the method list:
 *
 *   1. **It goes through the same code path as the tools.** Every method builds
 *      the same controller operation and parameters the corresponding model-facing
 *      tool builds, and reuses `runOperation`, so the two surfaces can never
 *      disagree about defaults or error shapes.
 *   2. **It never starts anything on its own**, and it keeps the tools'
 *      convention about failures: an operation-level failure (TIA refused, the
 *      block is missing) comes back as `ok: false` plus a coded `error`, while a
 *      transport failure (controller missing, timeout, protocol mismatch) is
 *      thrown — the caller decides how loudly to report that.
 *   3. **Reads are what it is for.** The only write it can perform on a project
 *      is `openProject` with `allowUpgrade` (off by default), exactly like the
 *      tool. Everything else writes files (an export) or closes a session, and
 *      `closeProject` deliberately makes the caller state `dryRun` explicitly.
 *
 * @module dsh-tia-openness-v17-min/access
 */
import { Service } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import { runOperation } from './tools.js';
/** The service name the engineering-context plugin looks up. It is not an import, by design (D10). */
export const ENGINEERING_ACCESS_SERVICE = 'engineeringAccess';
/**
 * The per-family cap `listObjects` asks for by default.
 *
 * The controller only ever **truncates**: its `max_items` has no offset
 * companion (`controller/OpennessHost.Plc.cs:152,166` keeps counting `total` but
 * stops adding items), so "fetch the next page" does not exist. Raising the cap
 * and reporting `truncated` honestly is the only correct behaviour; the engineering-context plugin
 * retries with a larger value when it sees one.
 */
export const DEFAULT_LIST_MAX_ITEMS = 1000;
/**
 * One path segment safe for the source tree.
 *
 * TIA device names may contain characters a filesystem rejects, and two names may
 * collapse onto the same segment. This mirrors what the controller's own exporter
 * does to object names, so the two never disagree about a folder.
 *
 * @param name - the raw name (usually a device name).
 * @returns a segment that can be created on disk.
 */
function sanitizeSegment(name) {
    const cleaned = name
        // eslint-disable-next-line no-control-regex
        .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_')
        .replace(/^[. ]+|[. ]+$/gu, '');
    if (cleaned.length === 0)
        return '_';
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(cleaned.split('.')[0] ?? cleaned))
        return `_${cleaned}`;
    return cleaned;
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function list(value) {
    return Array.isArray(value) ? value : [];
}
function text(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function numberOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** The three families this service flattens, and the category each maps to. */
const FAMILIES = [
    ['blocks', 'blocks'],
    ['types', 'types'],
    ['tagTables', 'tag_tables'],
];
/**
 * Turn one controller outcome into the shape this service promises.
 *
 * @param outcome - the result of `runOperation`.
 * @returns the call result, with the error flattened and `details` kept.
 */
function toCallResult(outcome) {
    const error = outcome.error;
    return {
        ok: outcome.ok,
        operation: outcome.operation,
        dryRun: outcome.dryRun,
        summary: outcome.summary,
        error: error === null
            ? null
            : { code: error.code, message: error.message, details: record(error.details) ?? null },
        data: outcome.data,
        durationMs: outcome.durationMs,
        changes: outcome.changes,
        diagnostics: outcome.diagnostics,
    };
}
function fingerprintsOf(item) {
    const raw = item['fingerprints'];
    if (!Array.isArray(raw))
        return null;
    const result = [];
    for (const entry of raw) {
        const pair = record(entry);
        if (pair === null)
            continue;
        result.push({
            id: text(pair['id']) ?? '?',
            value: text(pair['value']) ?? null,
            error: text(pair['error']) ?? null,
        });
    }
    return result;
}
/**
 * The `engineeringAccess` service.
 *
 * Construct it inside `apply` so the runtime ties its lifetime to this plugin's
 * fiber: `Service`'s constructor registers it with
 * `ctx.reflect.provide(name, this, …)`, whose disposer runs when the plugin
 * unloads.
 */
export class EngineeringAccess extends Service {
    dependencies;
    /**
     * @param ctx - the plugin context the service is registered on.
     * @param dependencies - the controller seam the tools use, reused as-is.
     */
    constructor(ctx, dependencies) {
        super(ctx, ENGINEERING_ACCESS_SERVICE);
        this.dependencies = dependencies;
    }
    /**
     * Report whether a TIA operation is worth attempting. Never starts anything.
     *
     * @returns the availability snapshot described by {@link AccessStatus}.
     */
    status() {
        const snapshot = this.dependencies.status();
        const ready = record(snapshot['ready']);
        const openness = ready === null ? null : record(ready['openness']);
        const probed = ready !== null;
        const exeExists = snapshot['exeExists'] === true;
        const opennessAvailable = openness === null ? null : openness['available'] === true;
        const available = exeExists && opennessAvailable !== false;
        const reason = !exeExists
            ? 'the controller executable is missing; build it with build:controller or point controllerPath at it'
            : opennessAvailable === false
                ? (text(openness?.['message']) ?? 'the Openness installation is not available to this user')
                : probed
                    ? null
                    : 'the controller has not been started yet, so Openness has not been probed';
        return {
            available,
            reason,
            state: text(snapshot['state']) ?? 'unknown',
            exePath: text(snapshot['exePath']) ?? '',
            exeExists,
            probed,
            controller: snapshot,
        };
    }
    /**
     * Open (or attach to) a project and keep it open for later calls.
     *
     * @param projectPath - absolute path of the `.ap17`.
     * @param options - window, upgrade consent, dry run and cancellation.
     */
    async openProject(projectPath, options = {}) {
        if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
            throw new TypeError('openProject needs a non-empty project path');
        }
        const params = { project_path: projectPath };
        if (options.withWindow !== undefined)
            params['with_window'] = options.withWindow;
        if (options.allowUpgrade !== undefined)
            params['allow_upgrade'] = options.allowUpgrade;
        if (options.dryRun !== undefined)
            params['dry_run'] = options.dryRun;
        return toCallResult(await runOperation(this.dependencies, 'OpenProject', params, options.signal));
    }
    /**
     * Close the project the controller holds.
     *
     * @param options - `dryRun` is required; see {@link CloseProjectOptions}.
     */
    async closeProject(options) {
        if (options === undefined || typeof options.dryRun !== 'boolean') {
            throw new TypeError('closeProject needs an explicit dryRun: true (plan) or false (close)');
        }
        const params = {
            save: options.save ?? false,
            close_portal: options.closePortal ?? false,
            dry_run: options.dryRun,
        };
        return toCallResult(await runOperation(this.dependencies, 'CloseProject', params, options.signal));
    }
    /**
     * List engineering objects, flattened across families, with fingerprints when
     * asked for.
     *
     * The defaults mirror the `list_plc_objects` tool exactly, except for the cap:
     * this asks for {@link DEFAULT_LIST_MAX_ITEMS} instead of the controller's 200,
     * because there is no way to fetch a second page.
     *
     * @param query - families, names, detail flags and the cap.
     */
    async listObjects(query = {}) {
        const params = {
            recursive: query.recursive ?? true,
            include_tags: query.includeTags ?? false,
            include_constants: query.includeConstants ?? false,
            include_attributes: query.includeAttributes ?? false,
            include_fingerprints: query.includeFingerprints ?? false,
            max_items: query.maxItems ?? DEFAULT_LIST_MAX_ITEMS,
        };
        // Left out when the caller named no family: the controller then lists exactly
        // the families the requested names select. Sending a default would defeat it.
        if (query.categories !== undefined)
            params['categories'] = [...query.categories];
        if (query.deviceName !== undefined)
            params['device_name'] = query.deviceName;
        if (query.softwareName !== undefined)
            params['software_name'] = query.softwareName;
        if (query.nameFilter !== undefined)
            params['name_filter'] = query.nameFilter;
        if (query.blockNames !== undefined)
            params['block_names'] = [...query.blockNames];
        if (query.typeNames !== undefined)
            params['type_names'] = [...query.typeNames];
        if (query.tagTableNames !== undefined)
            params['tag_table_names'] = [...query.tagTableNames];
        const outcome = await runOperation(this.dependencies, 'ListPlcObjects', params, query.signal);
        const base = toCallResult(outcome);
        const data = outcome.data;
        const objects = [];
        const families = {};
        let truncated = false;
        if (data !== null) {
            for (const [key, category] of FAMILIES) {
                const envelope = record(data[key]);
                if (envelope === null)
                    continue;
                const items = list(envelope['items']);
                const count = numberOf(envelope['count']) ?? items.length;
                const familyTruncated = envelope['truncated'] === true;
                if (familyTruncated)
                    truncated = true;
                families[category] = { count, returned: items.length, truncated: familyTruncated };
                for (const entry of items) {
                    const item = record(entry);
                    if (item === null)
                        continue;
                    objects.push({
                        category,
                        name: text(item['name']) ?? '?',
                        group: text(item['group']) ?? null,
                        attributes: item['attributes'] ?? null,
                        fingerprints: fingerprintsOf(item),
                    });
                }
            }
        }
        return {
            ...base,
            objects,
            families,
            // The top-level flag exists too; either source reporting truncation is
            // enough for the caller to retry with a larger cap.
            truncated: truncated || data?.['truncated'] === true,
            missing: data?.['missing'] ?? null,
        };
    }
    /**
     * Export objects as Simatic ML into a directory.
     *
     * Writes files only; it never modifies the project.
     *
     * @param query - target directory, families, name selection and options.
     */
    async exportObjects(query) {
        if (typeof query.outputDir !== 'string' || query.outputDir.trim().length === 0) {
            throw new TypeError('exportObjects needs a non-empty outputDir');
        }
        const params = {
            output_dir: query.outputDir,
            categories: query.categories === undefined ? ['blocks'] : [...query.categories],
            recursive: query.recursive ?? true,
            overwrite: query.overwrite ?? false,
            export_options: query.exportOptions ?? 'with_defaults',
            write_manifest: query.writeManifest ?? true,
            dry_run: query.dryRun ?? false,
        };
        if (query.blockNames !== undefined)
            params['block_names'] = [...query.blockNames];
        if (query.typeNames !== undefined)
            params['type_names'] = [...query.typeNames];
        if (query.tagTableNames !== undefined)
            params['tag_table_names'] = [...query.tagTableNames];
        if (query.deviceName !== undefined)
            params['device_name'] = query.deviceName;
        if (query.softwareName !== undefined)
            params['software_name'] = query.softwareName;
        return toCallResult(await runOperation(this.dependencies, 'ExportBlocks', params, query.signal));
    }
    /**
     * Save the open project into another directory ("save as").
     *
     * The directory is the caller's decision — this method knows nothing about
     * workspaces or projects. Two TIA facts the caller must live with, both from the
     * `save_project` tool's verified behaviour: SaveAs takes **only a directory**, and
     * the project **keeps its own name** (`Project.Name` is read-only and there is no
     * `SaveAs(folder, newName)` overload). So the requested directory and the path TIA
     * actually produces can differ, and the caller must record what came back
     * (`savedAs` / `projectPath`), never what it asked for.
     *
     * @param directory - target directory; TIA decides the layout below it.
     * @param options - dry run and cancellation.
     */
    async saveProjectAs(directory, options = {}) {
        if (typeof directory !== 'string' || directory.trim().length === 0) {
            throw new TypeError('saveProjectAs needs a non-empty target directory');
        }
        const params = { save_as_dir: directory };
        if (options.dryRun !== undefined)
            params['dry_run'] = options.dryRun;
        const outcome = await runOperation(this.dependencies, 'SaveProject', params, options.signal);
        const result = toCallResult(outcome);
        const data = outcome.data;
        return {
            ...result,
            // Surfaced explicitly: these are the two facts a caller must not guess at.
            data: data === null
                ? null
                : {
                    ...data,
                    savedAs: data['savedAs'] ?? null,
                    requestedSaveAsDir: data['requestedSaveAsDir'] ?? directory,
                    projectPath: data['projectPath'] ?? null,
                },
        };
    }
    /**
     * Report what the controller and TIA currently have open.
     *
     * Never starts anything: a stopped controller is reported as `running: false`.
     * When the controller is running but TIA holds no project, that comes back as
     * `projectOpen: false` with a reason — the `project_not_open` failure the
     * controller reports is a **state**, not an error to throw.
     *
     * @param options - cancellation.
     */
    async readTiaSession(options = {}) {
        const snapshot = this.dependencies.status();
        const state = text(snapshot['state']) ?? 'unknown';
        const pid = snapshot['pid'];
        const running = state !== 'stopped' && pid !== null && pid !== undefined;
        const empty = {
            running,
            projectOpen: false,
            projectName: null,
            projectPath: null,
            isModified: null,
            software: [],
            reason: running ? null : 'the controller is not running, so no TIA session is open',
        };
        if (!running)
            return empty;
        const outcome = await runOperation(this.dependencies, 'ProjectInfo', { sections: ['attributes', 'software'], max_objects: 500 }, options.signal);
        if (!outcome.ok) {
            const code = outcome.error?.code ?? 'unknown';
            return {
                ...empty,
                reason: code === 'project_not_open' ? 'the controller is running but no project is open' : (outcome.error?.message ?? code),
            };
        }
        const data = outcome.data;
        const attributes = record(data?.['attributes']);
        const software = record(data?.['software']);
        const items = [];
        for (const entry of list(software?.['items'])) {
            const item = record(entry);
            if (item === null)
                continue;
            items.push({
                device: text(item['device']) ?? '?',
                software: text(item['software']) ?? '?',
                blockCount: numberOf(item['blockCount']) ?? 0,
            });
        }
        return {
            running: true,
            projectOpen: true,
            projectName: text(attributes?.['name']) ?? null,
            projectPath: text(attributes?.['path']) ?? null,
            isModified: typeof attributes?.['isModified'] === 'boolean' ? attributes['isModified'] : null,
            software: items,
            reason: null,
        };
    }
    /**
     * Materialize the **complete** source tree of every PLC software into one root.
     *
     * This is the operation that owns the `source/` layout, which is why the layout
     * lives here in code and not in a prompt: callers pass only the root, and
     * everything below it is decided by this method (and documented in
     * `docs/decisions.md` D21). Two export calls per device produce it, because the
     * controller has no "layout" option and TIA writes blocks at the root of whatever
     * `output_dir` it is given:
     *
     *   <sourceRoot>/<device>/blocks/<group>/<name>.xml
     *   <sourceRoot>/<device>/types/<group>/<name>.xml
     *   <sourceRoot>/<device>/tag_tables/<name>.xml
     *
     * Each call writes its own `_tia-openness-manifest.json` beside what it wrote, so
     * a device with blocks and types has two manifests — each describing exactly its
     * own files, which is what a consumer should read instead of reconstructing paths.
     *
     * A device that TIA refuses blocks on is **not** skipped silently: its failures
     * come back in `failures`, one entry per object.
     *
     * @param sourceRoot - directory to build the tree under (created by TIA's export).
     * @param options - overwrite, dry run, device filter and cancellation.
     */
    async rebuildSource(sourceRoot, options = {}) {
        if (typeof sourceRoot !== 'string' || sourceRoot.trim().length === 0) {
            throw new TypeError('rebuildSource needs a non-empty source root');
        }
        const session = await this.readTiaSession({ signal: options.signal });
        if (!session.running) {
            return {
                ok: false,
                operation: 'ExportBlocks',
                dryRun: true,
                summary: 'Nothing was exported: the controller is not running, so no project is open.',
                error: { code: 'controller_not_running', message: session.reason ?? 'the controller is not running', details: null },
                data: null,
                durationMs: 0,
                changes: [],
                diagnostics: [],
                sourceRoot,
                devices: [],
                failures: [],
                missingDevices: [],
            };
        }
        if (!session.projectOpen) {
            return {
                ok: false,
                operation: 'ExportBlocks',
                dryRun: true,
                summary: 'Nothing was exported: the controller has no project open.',
                error: { code: 'project_not_open', message: session.reason ?? 'no project is open', details: null },
                data: null,
                durationMs: 0,
                changes: [],
                diagnostics: [],
                sourceRoot,
                devices: [],
                failures: [],
                missingDevices: [],
            };
        }
        const devices = session.software;
        const wanted = options.deviceNames;
        const selected = wanted === undefined ? devices : devices.filter((entry) => wanted.includes(entry.device));
        const missingDevices = wanted === undefined ? [] : wanted.filter((name) => !devices.some((entry) => entry.device === name));
        const failures = [];
        const rebuilt = [];
        const used = new Set();
        for (const entry of selected) {
            let folder = sanitizeSegment(entry.device);
            // Two device names can collapse onto one folder; make the second distinct
            // instead of letting one overwrite the other.
            if (used.has(folder.toLowerCase())) {
                let index = 2;
                while (used.has(`${folder}~${index}`.toLowerCase()))
                    index += 1;
                folder = `${folder}~${index}`;
            }
            used.add(folder.toLowerCase());
            const deviceDirectory = join(sourceRoot, folder);
            const emptyFamily = (directory) => ({
                exported: 0,
                failed: 0,
                directory,
                manifest: null,
            });
            // Blocks go to <device>/blocks so the tree is type-first; the controller
            // writes them at the root of whatever directory it is handed.
            const blocksFamily = emptyFamily(join(deviceDirectory, 'blocks'));
            const typesFamily = emptyFamily(join(deviceDirectory, 'types'));
            const tagTablesFamily = emptyFamily(join(deviceDirectory, 'tag_tables'));
            const blocksOutcome = await runOperation(this.dependencies, 'ExportBlocks', {
                output_dir: blocksFamily.directory,
                categories: ['blocks'],
                recursive: true,
                overwrite: options.overwrite ?? false,
                export_options: 'with_defaults',
                write_manifest: true,
                dry_run: options.dryRun ?? false,
                device_name: entry.device,
                software_name: entry.software,
            }, options.signal);
            if (!blocksOutcome.ok) {
                return {
                    ...toCallResult(blocksOutcome),
                    sourceRoot,
                    devices: rebuilt,
                    failures,
                    missingDevices,
                };
            }
            applyFamily(blocksFamily, blocksOutcome.data, entry.device, failures);
            const restOutcome = await runOperation(this.dependencies, 'ExportBlocks', {
                output_dir: deviceDirectory,
                categories: ['types', 'tag_tables'],
                recursive: true,
                overwrite: options.overwrite ?? false,
                export_options: 'with_defaults',
                write_manifest: true,
                dry_run: options.dryRun ?? false,
                device_name: entry.device,
                software_name: entry.software,
            }, options.signal);
            if (!restOutcome.ok) {
                return {
                    ...toCallResult(restOutcome),
                    sourceRoot,
                    devices: rebuilt,
                    failures,
                    missingDevices,
                };
            }
            applyFamily(typesFamily, restOutcome.data, entry.device, failures, 'types');
            applyFamily(tagTablesFamily, restOutcome.data, entry.device, failures, 'tagTables');
            rebuilt.push({
                device: entry.device,
                software: entry.software,
                directory: deviceDirectory,
                blockCount: entry.blockCount,
                ...callTotals(blocksOutcome.data, restOutcome.data),
                blocks: blocksFamily,
                types: typesFamily,
                tagTables: tagTablesFamily,
            });
        }
        const exported = rebuilt.reduce((total, device) => total + device.blocks.exported + device.types.exported + device.tagTables.exported, 0);
        const failed = rebuilt.reduce((total, device) => total + device.blocks.failed + device.types.failed + device.tagTables.failed, 0);
        return {
            ok: true,
            operation: 'ExportBlocks',
            dryRun: options.dryRun ?? false,
            summary: selected.length === 0
                ? 'No PLC software was selected, so nothing was exported.'
                : `Rebuilt the source tree of ${selected.length} device(s) under ${sourceRoot}: ${exported} object(s) exported, ${failed} refused by TIA.`,
            error: null,
            data: { sourceRoot, devices: rebuilt, failures, missingDevices },
            durationMs: 0,
            changes: [],
            diagnostics: [],
            sourceRoot,
            devices: rebuilt,
            failures,
            missingDevices,
        };
    }
}
/**
 * Fold one export call's payload into the family it produced.
 *
 * Only exactly attributable numbers are taken: `exported` from `counts[family]`,
 * `failed` from the `failures` entries whose `category` matches, and the manifest
 * path the controller wrote. Call-level totals (`skipped`, `verificationFailed`)
 * are summed by {@link callTotals} instead, because they cannot honestly be split
 * across families.
 *
 * @param family - the family record to fill in (mutated).
 * @param data - the controller payload of one `ExportBlocks` call.
 * @param device - device name, used to label the failures.
 * @param failures - the run's failure list (appended to).
 * @param countKey - which key of `counts` this call populates.
 */
function applyFamily(family, data, device, failures, countKey = 'blocks') {
    const counts = record(data?.['counts']);
    family.exported = numberOf(counts?.[countKey]) ?? 0;
    family.manifest = text(data?.['manifest']) ?? null;
    const wantedCategory = countKey === 'blocks' ? 'blocks' : countKey === 'types' ? 'types' : 'tag_tables';
    for (const entry of list(data?.['failures'])) {
        const item = record(entry);
        if (item === null)
            continue;
        const category = text(item['category']) ?? '';
        if (category !== wantedCategory)
            continue;
        family.failed += 1;
        failures.push({
            device,
            category,
            name: text(item['name']) ?? '?',
            code: text(item['code']) ?? 'export_failed',
            message: text(item['message']) ?? '',
        });
    }
}
/**
 * The call-level totals of two export calls, which are the only numbers that
 * cannot be attributed to one family.
 *
 * @param payloads - the controller payloads to sum over.
 */
function callTotals(...payloads) {
    let skipped = 0;
    let verificationFailed = 0;
    for (const payload of payloads) {
        const summary = record(payload?.['summary']);
        skipped += numberOf(summary?.['skipped']) ?? 0;
        verificationFailed += numberOf(summary?.['verificationFailed']) ?? 0;
    }
    return { skipped, verificationFailed };
}
