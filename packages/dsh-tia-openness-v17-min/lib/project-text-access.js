/**
 * The `projectTextAccess` service: the write seam for project texts.
 *
 * `engineeringAccess` is deliberately read-mostly (D12): it exports blocks and
 * reads fingerprints, but it does not import project texts, activate languages,
 * archive or save the project. The translation workflow in
 * `@voltarenyah/dsh-engineering-context` needs exactly those writes, so they live
 * here instead of widening the read seam.
 *
 * Everything in this file goes through `runOperation`, the same path the
 * model-facing `project_texts` / `project_languages` tools use, so the service
 * and the tools cannot disagree about parameters or error shapes.
 *
 * The import is **not transactional** (the Openness manual forbids ProjectText
 * import inside a transaction). Callers must archive/roll back on failure; this
 * service only reports the controller's `state` and log path.
 *
 * @module dsh-tia-openness-v17-min/project-text-access
 */
import { Service } from '@deepseek-ai/cordis';
import { toCallResult } from './access.js';
import { runOperation } from './tools.js';
/** The service name the engineering-context translation workflow looks up. */
export const PROJECT_TEXT_ACCESS_SERVICE = 'projectTextAccess';
/**
 * The `projectTextAccess` service.
 *
 * Construct it inside the host row's `apply` next to `EngineeringAccess`, so its
 * lifetime is tied to the plugin fiber.
 */
export class ProjectTextAccess extends Service {
    dependencies;
    /**
     * @param ctx - the plugin context the service is registered on.
     * @param dependencies - the controller seam.
     */
    constructor(ctx, dependencies) {
        super(ctx, PROJECT_TEXT_ACCESS_SERVICE);
        this.dependencies = dependencies;
    }
    /**
     * Export project texts to an XLSX file.
     *
     * @param file - absolute path of the XLSX to write.
     * @param sourceLanguage - culture name of the source column.
     * @param targetLanguage - culture name of the target column.
     * @param signal - optional abort signal.
     */
    async exportTexts(file, sourceLanguage, targetLanguage, options = {}) {
        return toCallResult(await runOperation(this.dependencies, 'ProjectTexts', { action: 'export', file, source_language: sourceLanguage, target_language: targetLanguage }, options.signal));
    }
    /**
     * Import an XLSX file into the open project.
     *
     * **Not transactional.** The caller is responsible for archiving first and for
     * handling `state`/`resultPath` when TIA reports a warning or error.
     *
     * @param file - absolute path of the XLSX to read.
     * @param updateSourceLanguage - true also overwrites the source-language column.
     * @param signal - optional abort signal.
     */
    async importTexts(file, updateSourceLanguage = false, options = {}) {
        return toCallResult(await runOperation(this.dependencies, 'ProjectTexts', { action: 'import', file, update_source_language: updateSourceLanguage }, options.signal));
    }
    /**
     * Read the supported/active languages plus the editing and reference language.
     *
     * @param options - optional abort signal.
     */
    async readLanguages(options = {}) {
        return toCallResult(await runOperation(this.dependencies, 'ProjectLanguages', { action: 'list' }, options.signal));
    }
    /**
     * Activate/deactivate languages and/or set the editing/reference language.
     *
     * This is a project write. The caller must obtain the user's permission before
     * calling it; the controller applies the list one entry at a time and the
     * operation is not atomic.
     *
     * @param request - what to change.
     */
    async setLanguages(request) {
        const params = { action: 'set' };
        if (request.activeLanguages !== undefined)
            params['active_languages'] = [...request.activeLanguages];
        if (request.activeMode !== undefined)
            params['active_mode'] = request.activeMode;
        if (request.editingLanguage !== undefined)
            params['editing_language'] = request.editingLanguage;
        if (request.referenceLanguage !== undefined)
            params['reference_language'] = request.referenceLanguage;
        return toCallResult(await runOperation(this.dependencies, 'ProjectLanguages', params, request.signal));
    }
    /**
     * Archive the open project before a non-transactional text import.
     *
     * @param request - target directory/name and archive mode.
     */
    async archiveProject(request) {
        return toCallResult(await runOperation(this.dependencies, 'ArchiveProject', {
            action: 'archive',
            target_dir: request.targetDir,
            target_name: request.targetName,
            mode: request.mode ?? 'compressed',
        }, request.signal));
    }
    /**
     * List PLC blocks with their attributes.
     *
     * The translation workflow needs `ProgrammingLanguage` to exclude F blocks
     * (`F_LAD`/`F_FBD`/`F_DB`...). Group names are user-defined and must not be
     * used for that decision.
     *
     * @param options - max items and abort signal.
     */
    async listBlocks(options = {}) {
        return toCallResult(await runOperation(this.dependencies, 'ListPlcObjects', {
            categories: ['blocks'],
            include_attributes: true,
            include_fingerprints: false,
            max_items: options.maxItems ?? 5000,
        }, options.signal));
    }
    /**
     * Save the project in place, or Save-As into a directory.
     *
     * @param request - optional `saveAsDir`.
     */
    async saveProject(request = {}) {
        const params = {};
        if (request.saveAsDir !== undefined)
            params['save_as_dir'] = request.saveAsDir;
        return toCallResult(await runOperation(this.dependencies, 'SaveProject', params, request.signal));
    }
}
