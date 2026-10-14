/**
 * The `engineeringAccess` service: the seam the engineering-context plugin
 * (family 2) uses to ask this plugin for project data.
 *
 * Why it exists: fingerprints — the only hard evidence that an engineering
 * object changed (decision D6) — can only be read with a project open, and
 * **this** is the plugin that is allowed to talk to TIA Portal. Family 2 must
 * therefore ask, not do (docs/ARCHITECTURE.md §5.3 in that package, and the
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
import { runOperation } from './tools.js';
/** The service name family 2 looks up. It is not an import, by design (D10). */
export const ENGINEERING_ACCESS_SERVICE = 'engineeringAccess';
/**
 * The per-family cap `listObjects` asks for by default.
 *
 * The controller only ever **truncates**: its `max_items` has no offset
 * companion (`controller/OpennessHost.Plc.cs:152,166` keeps counting `total` but
 * stops adding items), so "fetch the next page" does not exist. Raising the cap
 * and reporting `truncated` honestly is the only correct behaviour; family 2
 * retries with a larger value when it sees one.
 */
export const DEFAULT_LIST_MAX_ITEMS = 1000;
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
}
