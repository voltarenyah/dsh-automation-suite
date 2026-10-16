/**
 * The model-facing tools.
 *
 * Every tool returns the same canonical envelope (`ToolOutcome`), so a model
 * always sees `ok`, a one-line `summary`, the controller's structured `data`,
 * the list of `changes` the operation made, the controller `diagnostics`, and a
 * structured `error` when the operation reported a failure.
 *
 * Every operation of `OPERATIONS` (see `protocol.ts`) has exactly one tool here,
 * in the same order: the original block read/write surface, then the project and
 * project-data operations, then the PLC-device operations, then F-related
 * Openness. `controller_status` is answered by the plugin itself and never
 * touches TIA Portal.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { changesOf, diagnosticsOf } from './protocol.js';
/** The controller payload is JSON by construction; this only satisfies the type system. */
function asJson(value) {
    return value;
}
const MAX_LISTED = 20;
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}
function list(value) {
    return Array.isArray(value) ? value : [];
}
function text(value) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return undefined;
}
function numberOf(value) {
    return typeof value === 'number' ? value : undefined;
}
/**
 * Reads a list of labels out of a payload list that may hold plain strings or
 * records: the controllers use `{name}` for objects and `{culture}` for
 * languages, so the caller names the key it expects.
 */
function labels(value, key = 'name') {
    return list(value).map((item) => text(item) ?? text(field(record(item), key)) ?? '?');
}
/** Reads `data[key]`, falling back to a nested `data.a.b` path when asked. */
function field(data, ...path) {
    let current = data;
    for (const key of path) {
        const container = record(current);
        if (container === null)
            return undefined;
        current = container[key];
    }
    return current;
}
// ------------------------------------------------------------------ rendering
function renderError(error) {
    if (error === null)
        return '';
    const lines = [`Error code: ${error.code}`, `Reason: ${error.message}`];
    const details = record(error.details);
    if (details !== null) {
        const hint = text(details['hint']);
        if (hint !== undefined)
            lines.push(`Hint: ${hint}`);
        for (const [key, value] of Object.entries(details)) {
            if (key === 'hint')
                continue;
            const rendered = JSON.stringify(value);
            if (rendered === undefined)
                continue;
            lines.push(`  ${key}: ${rendered.length > 400 ? `${rendered.slice(0, 400)}…` : rendered}`);
        }
    }
    return lines.join('\n');
}
function renderDiagnostics(diagnostics) {
    if (diagnostics.length === 0)
        return '';
    const interesting = diagnostics.filter((entry) => entry.level === 'error' || entry.level === 'warning');
    const chosen = interesting.length > 0 ? interesting : diagnostics;
    const lines = chosen.slice(0, MAX_LISTED).map((entry) => {
        const source = entry.source === undefined ? '' : ` (${entry.source})`;
        return `  [${entry.level ?? 'info'}]${source} ${entry.message ?? ''}`;
    });
    if (chosen.length > MAX_LISTED)
        lines.push(`  … ${chosen.length - MAX_LISTED} more`);
    return `Diagnostics:\n${lines.join('\n')}`;
}
function renderChanges(changes) {
    if (changes.length === 0)
        return '';
    const lines = changes.slice(0, MAX_LISTED).map((change) => {
        const detail = change.detail === undefined ? '' : ` — ${change.detail}`;
        return `  ${change.kind ?? 'change'} ${change.action ?? 'changed'}: ${change.target ?? ''}${detail}`;
    });
    if (changes.length > MAX_LISTED)
        lines.push(`  … ${changes.length - MAX_LISTED} more`);
    return `Applied changes:\n${lines.join('\n')}`;
}
/** Operation-specific detail lines; unknown payloads fall back to raw JSON. */
function renderData(operation, data, verbose) {
    if (data === null)
        return '';
    const lines = [];
    switch (operation) {
        case 'OpenProject': {
            lines.push(`Project: ${text(data['projectName']) ?? '?'} (${text(data['projectPath']) ?? '?'})`);
            if (data['upgraded'] === true)
                lines.push('The project was upgraded to TIA Portal V17 and rewritten.');
            lines.push(`User interface: ${data['withUserInterface'] === true ? 'visible' : 'headless'}`);
            lines.push(`PLC software instances: ${numberOf(field(data, 'plcSoftware', 'count')) ?? 0}`);
            for (const item of list(field(data, 'plcSoftware', 'items')).slice(0, MAX_LISTED)) {
                const entry = record(item);
                if (entry === null)
                    continue;
                lines.push(`  - ${text(entry['device']) ?? '?'} / ${text(entry['software']) ?? '?'} (${numberOf(entry['blockCount']) ?? 0} blocks)`);
            }
            break;
        }
        case 'ExportBlocks': {
            lines.push(`Output directory: ${text(data['outputDir']) ?? '?'}`);
            const categoryCounts = record(data['counts']);
            if (categoryCounts !== null) {
                lines.push(`Categories: blocks=${numberOf(categoryCounts['blocks']) ?? 0}, types=${numberOf(categoryCounts['types']) ?? 0}, tagTables=${numberOf(categoryCounts['tagTables']) ?? 0}`);
            }
            lines.push(`Exported ${numberOf(field(data, 'summary', 'exported')) ?? 0}, skipped ${numberOf(field(data, 'summary', 'skipped')) ?? 0}, ` +
                `refused by Openness ${numberOf(field(data, 'summary', 'failed')) ?? 0}, unreadable after writing ${numberOf(field(data, 'summary', 'verificationFailed')) ?? 0}`);
            const refused = list(data['failures']);
            if (refused.length > 0) {
                lines.push('Openness cannot export these blocks at all (no Simatic ML representation):');
                for (const item of refused.slice(0, MAX_LISTED)) {
                    const entry = record(item);
                    if (entry === null)
                        continue;
                    const reason = text(entry['message']) ?? '';
                    lines.push(`  ${text(entry['name']) ?? '?'}: ${reason.length > 200 ? `${reason.slice(0, 200)}…` : reason}`);
                }
            }
            for (const item of list(data['files']).slice(0, MAX_LISTED)) {
                const entry = record(item);
                if (entry === null)
                    continue;
                const verified = entry['verified'] === true ? 'verified' : 'NOT VERIFIED';
                lines.push(`  ${text(entry['name']) ?? '?'} -> ${text(entry['file']) ?? '?'} [${verified}, ${numberOf(entry['bytes']) ?? 0} bytes]`);
            }
            const manifest = text(data['manifest']);
            if (manifest !== undefined)
                lines.push(`Manifest: ${manifest}`);
            break;
        }
        case 'ImportBlocks': {
            lines.push(`Files: ${numberOf(data['fileCount']) ?? 0}, import options: ${text(data['importOptions']) ?? 'none'}`);
            const conflicts = list(data['conflicts']);
            if (conflicts.length > 0) {
                lines.push(`Conflicts with existing blocks: ${conflicts.map((item) => text(item) ?? '?').join(', ')}`);
                lines.push("Pass import_options 'override' to replace them, or import different block names.");
            }
            if (data['dryRun'] === true) {
                lines.push(`Ready to import: ${data['ready'] === true ? 'yes' : 'no'}`);
            }
            for (const item of list(data['plan']).slice(0, MAX_LISTED)) {
                const entry = record(item);
                if (entry === null)
                    continue;
                lines.push(`  ${text(entry['action']) ?? '?'} ${text(entry['blockName']) ?? text(entry['file']) ?? '?'}` +
                    ` (${text(entry['format']) ?? '?'}, exists: ${entry['existsInProject'] === true ? 'yes' : 'no'})`);
            }
            if (data['dryRun'] !== true) {
                lines.push(`Committed: ${data['committed'] === true ? 'yes' : 'no'}`);
            }
            const verification = record(data['verification']);
            if (verification !== null) {
                lines.push(`Read-back verification: ${verification['passed'] === true ? 'passed' : 'FAILED'} ` +
                    `(${numberOf(verification['confirmedCount']) ?? 0}/${numberOf(verification['checked']) ?? 0} confirmed)`);
                const missing = list(verification['missing']);
                if (missing.length > 0)
                    lines.push(`  Missing after import: ${missing.map((item) => text(item) ?? '?').join(', ')}`);
                const advisory = list(verification['advisoryNotConfirmed']);
                if (advisory.length > 0) {
                    lines.push(`  Not confirmed (external source names): ${advisory.map((item) => text(item) ?? '?').join(', ')}`);
                }
            }
            break;
        }
        case 'CompilePlc': {
            lines.push(`Compile state: ${text(data['state']) ?? '?'}, errors: ${numberOf(data['errorCount']) ?? 0}, ` +
                `warnings: ${numberOf(data['warningCount']) ?? 0}, messages: ${numberOf(data['messageCount']) ?? 0}`);
            for (const item of list(data['messages']).slice(0, MAX_LISTED)) {
                const entry = record(item);
                if (entry === null)
                    continue;
                lines.push(`  [${text(entry['level']) ?? '?'}] ${text(entry['description']) ?? ''} ${text(entry['path']) ?? ''}`.trimEnd());
            }
            if (data['messagesTruncated'] === true)
                lines.push('  … message list truncated');
            break;
        }
        case 'CloseProject': {
            lines.push(`Project: ${text(data['projectName']) ?? '?'}`);
            if (data['dryRun'] === true) {
                lines.push(`Would save: ${data['wouldSave'] === true ? 'yes' : 'no'}, would close the TIA Portal instance: ${data['wouldClosePortal'] === true ? 'yes' : 'no'}`);
                break;
            }
            lines.push(`Saved: ${data['saved'] === true ? 'yes' : 'no'}, closed: ${data['closed'] === true ? 'yes' : 'no'}, TIA Portal closed: ${data['portalClosed'] === true ? 'yes' : 'no'}`);
            break;
        }
        case 'CreateProject': {
            lines.push(`Project: ${text(data['projectName']) ?? '?'} in ${text(data['projectDir']) ?? '?'}`);
            const targetPath = text(data['targetPath']) ?? text(data['projectPath']);
            if (targetPath !== undefined)
                lines.push(`Target path: ${targetPath}`);
            lines.push(`Created: ${data['created'] === true ? 'yes' : 'no'}, user interface: ${data['withUserInterface'] === true ? 'visible' : 'headless'}`);
            const author = text(data['author']);
            if (author !== undefined)
                lines.push(`Author: ${author}`);
            const comment = text(data['comment']);
            if (comment !== undefined)
                lines.push(`Comment: ${comment}`);
            const software = record(data['plcSoftware']);
            if (software !== null)
                lines.push(`PLC software instances: ${numberOf(software['count']) ?? list(software['items']).length}`);
            break;
        }
        case 'SaveProject': {
            lines.push(`Project: ${text(data['projectName']) ?? '?'} (${text(data['projectPath']) ?? '?'})`);
            lines.push(`Saved: ${data['saved'] === true ? 'yes' : 'no'}, modified before saving: ${data['isModifiedBeforeSave'] === true ? 'yes' : 'no'}, ` +
                `modified now: ${data['isModified'] === true ? 'yes' : 'no'}`);
            const savedAs = text(data['savedAs']);
            if (savedAs !== undefined) {
                const requested = text(data['requestedSaveAsDir']);
                lines.push(`Saved as: ${savedAs}`);
                if (requested !== undefined && requested !== savedAs) {
                    // TIA decides the layout below the requested directory and the project
                    // name is not changeable, so the two legitimately differ.
                    lines.push(`Requested directory: ${requested} (TIA chose the path above; the project name is unchanged)`);
                }
                if (data['locationChanged'] === false) {
                    lines.push('The persistence location did not change.');
                }
            }
            break;
        }
        case 'ArchiveProject': {
            if ((text(data['action']) ?? 'archive') === 'retrieve') {
                lines.push(`Retrieve archive: ${text(data['archivePath']) ?? '?'} -> ${text(data['targetDir']) ?? '?'}`);
                lines.push(`Project open mode: ${text(data['projectOpenMode']) ?? 'primary'}, upgrade: ${data['upgraded'] === true ? 'yes' : 'no'}`);
                lines.push(`Project: ${text(data['projectName']) ?? '?'} (${text(data['projectPath']) ?? '?'})`);
                const software = record(data['plcSoftware']);
                if (software !== null)
                    lines.push(`PLC software instances: ${numberOf(software['count']) ?? list(software['items']).length}`);
                break;
            }
            lines.push(`Archive project: ${text(data['projectName']) ?? '?'} (${text(data['projectPath']) ?? '?'})`);
            lines.push(`Target: ${text(data['targetDir']) ?? '?'} / ${text(data['targetName']) ?? '?'} (mode ${text(data['mode']) ?? 'compressed'})`);
            const archivedPath = text(data['archivedPath']);
            if (archivedPath !== undefined)
                lines.push(`Archive: ${archivedPath}`);
            lines.push(`Modified before archiving: ${data['isModifiedBeforeArchive'] === true ? 'yes' : 'no'}`);
            break;
        }
        case 'ProjectInfo': {
            const attributes = record(data['attributes']);
            if (attributes !== null) {
                lines.push(`Project: ${text(attributes['name']) ?? '?'} (${text(attributes['path']) ?? '?'})`);
                lines.push(`Author: ${text(attributes['author']) ?? '?'}, family: ${text(attributes['family']) ?? '?'}, ` +
                    `version: ${text(attributes['version']) ?? '?'}, size: ${numberOf(attributes['sizeKB']) ?? 0} KB`);
                lines.push(`Modified: ${attributes['isModified'] === true ? 'yes' : 'no'}, last modified ${text(attributes['lastModified']) ?? '?'} ` +
                    `by ${text(attributes['lastModifiedBy']) ?? '?'}`);
                const infos = list(attributes['attributeInfos']);
                if (infos.length > 0) {
                    lines.push(`Attribute infos: ${infos.length}`);
                    for (const item of infos.slice(0, MAX_LISTED)) {
                        const entry = record(item);
                        if (entry === null)
                            continue;
                        lines.push(`  - ${text(entry['name']) ?? '?'} (${text(entry['accessMode']) ?? '?'})`);
                    }
                }
            }
            const comment = record(data['comment']);
            if (comment !== null) {
                const entries = list(comment['languages']);
                lines.push(`Comment languages: ${entries.length}`);
                for (const item of entries.slice(0, MAX_LISTED)) {
                    const entry = record(item);
                    if (entry === null)
                        continue;
                    const body = text(entry['text']) ?? '';
                    lines.push(`  - ${text(entry['culture']) ?? '?'}: ${body.length > 120 ? `${body.slice(0, 120)}…` : body}`);
                }
            }
            const languages = record(data['languages']);
            if (languages !== null) {
                const active = labels(languages['activeLanguages'], 'culture');
                lines.push(`Languages: ${numberOf(languages['activeCount']) ?? active.length} active of ${numberOf(languages['supportedCount']) ?? 0} supported`);
                if (active.length > 0)
                    lines.push(`  Active: ${active.slice(0, MAX_LISTED).join(', ')}`);
            }
            const history = record(data['history']);
            if (history !== null) {
                lines.push(`History entries: ${numberOf(history['count']) ?? 0}${history['truncated'] === true ? ' (truncated)' : ''}`);
                for (const item of list(history['entries']).slice(0, MAX_LISTED)) {
                    const entry = record(item);
                    if (entry === null)
                        continue;
                    lines.push(`  - ${text(entry['dateTime']) ?? '?'} ${text(entry['text']) ?? ''}`.trimEnd());
                }
            }
            const products = record(data['products']);
            if (products !== null) {
                lines.push(`Products: ${numberOf(products['count']) ?? 0}`);
                for (const item of list(products['items']).slice(0, MAX_LISTED)) {
                    const entry = record(item);
                    if (entry === null)
                        continue;
                    lines.push(`  - ${text(entry['name']) ?? '?'} ${text(entry['version']) ?? ''}`.trimEnd());
                }
            }
            const devices = record(data['devices']);
            if (devices !== null) {
                lines.push(`Devices: ${numberOf(devices['deviceCount']) ?? 0} in ${numberOf(devices['deviceGroupCount']) ?? 0} group(s)`);
                const names = labels(devices['devices']);
                if (names.length > 0) {
                    lines.push(`  ${names.slice(0, MAX_LISTED).join(', ')}${names.length > MAX_LISTED ? ` … ${names.length - MAX_LISTED} more` : ''}`);
                }
            }
            const softwareItems = record(data['software']);
            if (softwareItems !== null) {
                lines.push(`PLC software: ${numberOf(softwareItems['count']) ?? 0}`);
                for (const item of list(softwareItems['items']).slice(0, MAX_LISTED)) {
                    const entry = record(item);
                    if (entry === null)
                        continue;
                    lines.push(`  - ${text(entry['device']) ?? '?'} / ${text(entry['software']) ?? '?'} (${numberOf(entry['blockCount']) ?? 0} blocks)`);
                }
            }
            const settings = record(data['settings']);
            if (settings !== null)
                lines.push(`Portal setting folders: ${numberOf(settings['folderCount']) ?? 0}`);
            break;
        }
        case 'ProjectLanguages': {
            const added = labels(data['added'], 'culture');
            const removed = labels(data['removed'], 'culture');
            if (added.length > 0 || removed.length > 0) {
                lines.push(`Added: ${added.join(', ') || 'none'}`);
                lines.push(`Removed: ${removed.join(', ') || 'none'}`);
            }
            const active = labels(data['activeLanguages'], 'culture');
            lines.push(`Active languages (${numberOf(data['activeCount']) ?? active.length}): ${active.slice(0, MAX_LISTED).join(', ') || 'none'}`);
            const supported = numberOf(data['supportedCount']);
            if (supported !== undefined)
                lines.push(`Supported languages: ${supported}`);
            const editing = text(data['editingLanguage']);
            if (editing !== undefined)
                lines.push(`Editing language: ${editing}`);
            const reference = text(data['referenceLanguage']);
            if (reference !== undefined)
                lines.push(`Reference language: ${reference}`);
            const supportedList = list(data['supportedLanguages']);
            if (supportedList.length > 0) {
                lines.push('Supported language catalog:');
                for (const item of supportedList.slice(0, MAX_LISTED)) {
                    const entry = record(item);
                    if (entry === null)
                        continue;
                    lines.push(`  - ${text(entry['culture']) ?? '?'} ${text(entry['displayName']) ?? text(entry['name']) ?? ''}`.trimEnd());
                }
            }
            break;
        }
        case 'ProjectTexts': {
            const action = text(data['action']) ?? 'export';
            lines.push(`Project texts ${action}: ${text(data['file']) ?? '?'}`);
            if (action === 'export') {
                lines.push(`Source language: ${text(data['sourceLanguage']) ?? '?'}, target language: ${text(data['targetLanguage']) ?? '?'}`);
                lines.push(`Written: ${numberOf(data['bytes']) ?? 0} bytes, sha256 ${text(data['sha256']) ?? '?'}`);
                break;
            }
            lines.push(`Update source language: ${data['updateSourceLanguage'] === true ? 'yes' : 'no'}, state: ${text(data['state']) ?? '?'}`);
            const resultPath = text(data['resultPath']);
            if (resultPath !== undefined)
                lines.push(`Result: ${resultPath}`);
            break;
        }
        case 'UpdateProject': {
            const simulation = record(data['simulationDuringBlockCompilation']);
            if (simulation !== null) {
                lines.push(`Simulation during block compilation: ${simulation['before'] === true ? 'yes' : 'no'} -> ${simulation['after'] === true ? 'yes' : 'no'}` +
                    `${simulation['changed'] === true ? ' (changed)' : ' (unchanged)'}`);
            }
            const comment = record(data['comment']);
            if (comment !== null) {
                lines.push(`Comment (${text(comment['language']) ?? '?'}): ${text(comment['before']) ?? ''} -> ${text(comment['after']) ?? ''}` +
                    `${comment['changed'] === true ? ' (changed)' : ' (unchanged)'}`);
            }
            break;
        }
        case 'PortalSettings': {
            const folders = list(data['folders']);
            if (folders.length > 0) {
                lines.push(`Setting folders: ${numberOf(data['folderCount']) ?? folders.length}`);
                for (const item of folders.slice(0, MAX_LISTED)) {
                    const folder = record(item);
                    if (folder === null)
                        continue;
                    const settings = list(folder['settings']);
                    lines.push(`  ${text(folder['name']) ?? '?'} (${settings.length} setting(s))`);
                    for (const entry of settings.slice(0, MAX_LISTED)) {
                        const setting = record(entry);
                        if (setting === null)
                            continue;
                        lines.push(`    - ${text(setting['name']) ?? '?'} [${text(setting['valueType']) ?? '?'}] = ${text(setting['value']) ?? '?'}` +
                            `${setting['writeable'] === true ? '' : ' (read-only)'}`);
                    }
                }
            }
            const folder = text(data['folder']);
            const setting = text(data['setting']);
            if (folder !== undefined && setting !== undefined) {
                lines.push(`Setting ${folder} / ${setting} [${text(data['valueType']) ?? 'auto'}]: ${text(data['before']) ?? '?'} -> ${text(data['after']) ?? '?'}` +
                    `${data['changed'] === true ? ' (changed)' : ' (unchanged)'}`);
            }
            break;
        }
        case 'ListPlcObjects': {
            lines.push(`PLC software: ${text(data['device']) ?? '?'} / ${text(data['software']) ?? '?'}`);
            const counts = record(data['counts']);
            if (counts !== null) {
                lines.push(`Counts: ${Object.entries(counts).map(([key, value]) => `${key}=${numberOf(value) ?? 0}`).join(', ')}`);
            }
            if (data['truncated'] === true)
                lines.push('The listing was truncated by max_items.');
            for (const [key, heading] of [
                ['blockGroups', 'Block groups'],
                ['typeGroups', 'Type groups'],
                ['tagTableGroups', 'Tag table groups'],
            ]) {
                const groups = list(data[key]);
                if (groups.length > 0)
                    lines.push(`${heading}: ${groups.length}`);
            }
            for (const [key, heading] of [
                ['blocks', 'Blocks'],
                ['types', 'Types'],
                ['tagTables', 'Tag tables'],
                ['externalSources', 'External sources'],
                ['watchTables', 'Watch tables'],
                ['forceTables', 'Force tables'],
                ['units', 'Software units'],
            ]) {
                // Each family arrives as the controller's `{count, items, truncated}`
                // envelope (OperationsPlc.ListPlcObjects), never as a bare array, so the
                // objects sit one level down. Reading the envelope as the list makes
                // `list()` return [] and silently drops every row.
                const entries = list(field(data, key, 'items'));
                if (entries.length === 0)
                    continue;
                const total = numberOf(field(data, key, 'count')) ?? entries.length;
                const names = entries.slice(0, MAX_LISTED).map((item) => text(field(record(item), 'name')) ?? '?');
                const hidden = total - names.length;
                lines.push(`${heading}: ${total} — ${names.join(', ')}${hidden > 0 ? ` … ${hidden} more` : ''}`);
            }
            // Fingerprints are the point of a change-detection call, so an explicitly
            // requested fingerprint list is reported per object instead of being left
            // to the verbose payload.
            const fingerprintRows = [];
            let fingerprintObjects = 0;
            for (const [key, heading] of [
                ['blocks', 'block'],
                ['types', 'type'],
            ]) {
                // Same envelope as above: the fingerprints live on the objects inside
                // `items`, which is the whole point of asking for them.
                for (const item of list(field(data, key, 'items'))) {
                    const entry = record(item);
                    if (entry === null)
                        continue;
                    const fingerprints = list(entry['fingerprints']);
                    if (fingerprints.length === 0)
                        continue;
                    fingerprintObjects += 1;
                    // Every object counts, but only the page is rendered, so the header
                    // reports the objects the page left out instead of under-reporting.
                    if (fingerprintRows.length >= MAX_LISTED)
                        continue;
                    const rendered = fingerprints
                        .map((fingerprint) => {
                        const pair = record(fingerprint);
                        if (pair === null)
                            return '?';
                        const error = text(pair['error']);
                        if (error !== undefined)
                            return `error: ${error}`;
                        return `${text(pair['id']) ?? '?'}=${text(pair['value']) ?? '?'}`;
                    })
                        .join(' ');
                    fingerprintRows.push(`  ${heading} ${text(entry['name']) ?? '?'}: ${rendered}`);
                }
            }
            if (fingerprintObjects > 0) {
                lines.push(`Fingerprints (${fingerprintObjects} object(s)):`);
                lines.push(...fingerprintRows);
                if (fingerprintObjects > MAX_LISTED)
                    lines.push(`  … ${fingerprintObjects - MAX_LISTED} more`);
            }
            const missing = record(data['missing']);
            if (missing !== null) {
                for (const [family, names] of Object.entries(missing)) {
                    lines.push(`Not found in ${family}: ${list(names).map((name) => text(name) ?? '?').join(', ')}`);
                }
            }
            break;
        }
        case 'CreatePlcObjects': {
            lines.push(`${text(data['kind']) ?? '?'}: ${text(data['name']) ?? text(data['fullPath']) ?? '?'}`);
            const groupPath = text(data['groupPath']);
            if (groupPath !== undefined)
                lines.push(`Parent group: ${groupPath}`);
            const fullPath = text(data['fullPath']);
            if (fullPath !== undefined)
                lines.push(`Full path: ${fullPath}`);
            lines.push(`Created: ${data['created'] === true ? 'yes' : 'no'}`);
            break;
        }
        case 'DeletePlcObjects': {
            const planned = list(data['planned']);
            const deleted = list(data['deleted']);
            const missing = labels(data['missing']);
            lines.push(`Planned: ${planned.length}, deleted: ${deleted.length}, missing: ${missing.length}`);
            const counts = record(data['counts']);
            if (counts !== null) {
                lines.push(`Counts: ${Object.entries(counts).map(([key, value]) => `${key}=${numberOf(value) ?? 0}`).join(', ')}`);
            }
            for (const item of planned.slice(0, MAX_LISTED)) {
                const entry = record(item);
                if (entry === null)
                    continue;
                const group = text(entry['group']);
                lines.push(`  ${text(entry['kind']) ?? '?'} ${text(entry['name']) ?? '?'}${group === undefined ? '' : ` in ${group}`} (exists: ${entry['exists'] === true ? 'yes' : 'no'})`);
            }
            if (missing.length > 0)
                lines.push(`Missing: ${missing.slice(0, MAX_LISTED).join(', ')}`);
            break;
        }
        case 'WriteTags': {
            const groupPath = text(data['groupPath']);
            lines.push(`Tag table: ${text(data['tagTable']) ?? '?'}${groupPath === undefined ? '' : ` (group ${groupPath})`}`);
            for (const [key, heading] of [
                ['tags', 'Tags'],
                ['constants', 'Constants'],
            ]) {
                const entries = list(data[key]);
                if (entries.length === 0)
                    continue;
                lines.push(`${heading}: ${entries.length}`);
                for (const item of entries.slice(0, MAX_LISTED)) {
                    const entry = record(item);
                    if (entry === null)
                        continue;
                    const changes = list(entry['changes']).map((change) => {
                        const changeEntry = record(change);
                        if (changeEntry === null)
                            return '?';
                        return `${text(changeEntry['attribute']) ?? '?'} ${text(changeEntry['before']) ?? '?'} -> ${text(changeEntry['after']) ?? '?'}`;
                    });
                    lines.push(`  ${text(entry['name']) ?? '?'}: ${text(entry['action']) ?? '?'}${changes.length === 0 ? '' : ` (${changes.join('; ')})`}`);
                }
            }
            const deletedTags = labels(data['deletedTags']);
            if (deletedTags.length > 0)
                lines.push(`Deleted tags: ${deletedTags.slice(0, MAX_LISTED).join(', ')}`);
            const deletedConstants = labels(data['deletedConstants']);
            if (deletedConstants.length > 0)
                lines.push(`Deleted constants: ${deletedConstants.slice(0, MAX_LISTED).join(', ')}`);
            break;
        }
        case 'SetBlockAttributes': {
            const attributes = record(data['attributes']);
            lines.push(`Target: ${text(data['target']) ?? 'block'}, attributes requested: ${attributes === null ? 0 : Object.keys(attributes).length}`);
            if (attributes !== null) {
                for (const [name, value] of Object.entries(attributes))
                    lines.push(`  ${name} = ${text(value) ?? JSON.stringify(value) ?? ''}`);
            }
            for (const item of list(data['applied']).slice(0, MAX_LISTED)) {
                const entry = record(item);
                if (entry === null)
                    continue;
                const changes = list(entry['changes']).map((change) => {
                    const changeEntry = record(change);
                    if (changeEntry === null)
                        return '?';
                    return `${text(changeEntry['attribute']) ?? '?'} ${text(changeEntry['before']) ?? '?'} -> ${text(changeEntry['after']) ?? '?'}`;
                });
                const group = text(entry['group']);
                lines.push(`  ${text(entry['name']) ?? '?'}${group === undefined ? '' : ` (${group})`}: ${changes.length === 0 ? 'unchanged' : changes.join('; ')}`);
            }
            break;
        }
        case 'ProtectBlocks': {
            const counts = record(data['counts']);
            lines.push(`Action: ${text(data['action']) ?? '?'}${counts === null ? '' : `, protected ${numberOf(counts['protected']) ?? 0}, failed ${numberOf(counts['failed']) ?? 0}`}`);
            const protectedBlocks = labels(data['protected']);
            if (protectedBlocks.length > 0)
                lines.push(`Protected: ${protectedBlocks.slice(0, MAX_LISTED).join(', ')}`);
            for (const item of list(data['failed']).slice(0, MAX_LISTED)) {
                const entry = record(item);
                if (entry === null)
                    continue;
                lines.push(`  FAILED ${text(entry['name']) ?? '?'}: ${text(entry['code']) ?? '?'} — ${text(entry['message']) ?? ''}`.trimEnd());
            }
            break;
        }
        case 'GenerateSource': {
            lines.push(`Source file: ${text(data['outputFile']) ?? '?'} (${text(data['extension']) ?? '?'})`);
            lines.push(`Blocks: ${numberOf(data['blockCount']) ?? 0}, types: ${numberOf(data['typeCount']) ?? 0}, ` +
                `with dependencies: ${data['withDependencies'] === true ? 'yes' : 'no'}`);
            lines.push(`Written: ${numberOf(data['bytes']) ?? 0} bytes, sha256 ${text(data['sha256']) ?? '?'}`);
            break;
        }
        case 'WatchAndForceTables': {
            const action = text(data['action']) ?? '?';
            lines.push(`Action: ${action}, kind: ${text(data['kind']) ?? 'watch'}`);
            const table = [text(data['name']), text(data['group'])].filter((part) => part !== undefined).join(' / ');
            if (table.length > 0)
                lines.push(`Table: ${table}`);
            if (action === 'import') {
                const imported = list(data['imported']);
                lines.push(`Imported: ${imported.length}, committed: ${data['committed'] === true ? 'yes' : 'no'}`);
                for (const item of imported.slice(0, MAX_LISTED)) {
                    const entry = record(item);
                    if (entry === null)
                        continue;
                    lines.push(`  ${text(entry['name']) ?? '?'} <- ${text(entry['file']) ?? '?'}`);
                }
                break;
            }
            if (action === 'export') {
                lines.push(`File: ${text(data['file']) ?? '?'} (${numberOf(data['bytes']) ?? 0} bytes, sha256 ${text(data['sha256']) ?? '?'})`);
                break;
            }
            lines.push(`${action === 'create' ? 'Created' : 'Deleted'}: ${data[action === 'create' ? 'created' : 'deleted'] === true ? 'yes' : 'no'}`);
            break;
        }
        case 'SoftwareUnits': {
            const units = list(data['units']);
            if (units.length > 0 || data['available'] !== undefined) {
                lines.push(`Software units available: ${data['available'] === true ? 'yes' : 'no'}, count: ${numberOf(data['unitCount']) ?? units.length}`);
            }
            for (const item of units.slice(0, MAX_LISTED)) {
                const entry = record(item);
                if (entry === null)
                    continue;
                lines.push(`  ${text(entry['name']) ?? '?'}: ${numberOf(entry['blockCount']) ?? 0} blocks, ${numberOf(entry['typeCount']) ?? 0} types, ` +
                    `${numberOf(entry['tagTableCount']) ?? 0} tag tables, ${numberOf(entry['externalSourceCount']) ?? 0} external sources, ` +
                    `${list(entry['relations']).length} relation(s)`);
            }
            const action = text(data['action']);
            const name = text(data['name']);
            if (action !== undefined && name !== undefined) {
                const related = text(data['relatedObject']);
                const relationType = text(data['relationType']);
                lines.push(`${action}: ${name}${related === undefined ? '' : ` -> ${related}`}${relationType === undefined ? '' : ` (${relationType})`}` +
                    `${data['created'] !== undefined ? `, created: ${data['created'] === true ? 'yes' : 'no'}` : ''}` +
                    `${data['deleted'] !== undefined ? `, deleted: ${data['deleted'] === true ? 'yes' : 'no'}` : ''}`);
            }
            break;
        }
        case 'SafetyStatus': {
            const globalSettings = record(data['globalSettings']);
            if (globalSettings !== null) {
                const reason = text(globalSettings['reason']);
                lines.push(`Global settings: ${globalSettings['available'] === true ? 'available' : 'NOT AVAILABLE'}${reason === undefined ? '' : ` (${reason})`}`);
                if (globalSettings['available'] === true) {
                    lines.push(`  Safety modifications possible: ${globalSettings['safetyModificationsPossible'] === true ? 'yes' : 'no'}, ` +
                        `F-change history user: ${text(globalSettings['usernameForFChangeHistory']) ?? '?'}`);
                }
            }
            const settings = record(data['settings']);
            if (settings !== null) {
                const reason = text(settings['reason']);
                lines.push(`Safety settings: ${settings['available'] === true ? 'available' : 'NOT AVAILABLE'}${reason === undefined ? '' : ` (${reason})`}`);
                if (settings['available'] === true) {
                    lines.push(`  Safety mode can be disabled: ${settings['safetyModeCanBeDisabled'] === true ? 'yes' : 'no'}, ` +
                        `system version: ${text(settings['safetySystemVersion']) ?? '?'}`);
                }
            }
            const administration = record(data['administration']);
            if (administration !== null) {
                const reason = text(administration['reason']);
                lines.push(`Safety administration: ${administration['available'] === true ? 'available' : 'NOT AVAILABLE'}${reason === undefined ? '' : ` (${reason})`}`);
                if (administration['available'] === true) {
                    lines.push(`  Logged on to safety offline program: ${administration['isLoggedOnToSafetyOfflineProgram'] === true ? 'yes' : 'no'}, ` +
                        `password set: ${administration['isSafetyOfflineProgramPasswordSet'] === true ? 'yes' : 'no'}`);
                }
            }
            const runtimeGroups = list(data['runtimeGroups']);
            if (runtimeGroups.length > 0) {
                lines.push(`Runtime groups: ${runtimeGroups.length}`);
                for (const item of runtimeGroups.slice(0, MAX_LISTED)) {
                    const entry = record(item);
                    if (entry === null)
                        continue;
                    lines.push(`  ${text(entry['name']) ?? '?'} (FOB ${text(entry['fobName']) ?? '?'}, main safety block ${text(entry['mainSafetyBlockName']) ?? '?'})`);
                }
            }
            break;
        }
        case 'SetSafetySettings': {
            const modifications = record(data['safetyModificationsPossible']);
            if (modifications !== null) {
                lines.push(`Safety modifications possible: ${modifications['before'] === true ? 'yes' : 'no'} -> ${modifications['after'] === true ? 'yes' : 'no'}` +
                    `${modifications['changed'] === true ? ' (changed)' : ' (unchanged)'}`);
            }
            const username = record(data['usernameForFChangeHistory']);
            if (username !== null) {
                lines.push(`F-change history user: ${text(username['before']) ?? '?'} -> ${text(username['after']) ?? '?'}` +
                    `${username['changed'] === true ? ' (changed)' : ' (unchanged)'}`);
            }
            break;
        }
        case 'SafetySignatures': {
            lines.push(`PLC software: ${text(data['device']) ?? '?'} / ${text(data['software']) ?? '?'}`);
            lines.push(`Signature type: ${text(data['signatureType']) ?? 'block_offline_signature'}, ` +
                `F blocks: ${numberOf(data['fBlockCount']) ?? 0}, non-F blocks: ${numberOf(data['nonFBlockCount']) ?? 0}`);
            for (const item of list(data['blocks']).slice(0, MAX_LISTED)) {
                const entry = record(item);
                if (entry === null || entry['isFBlock'] !== true)
                    continue;
                const group = text(entry['group']);
                lines.push(`  ${text(entry['name']) ?? '?'}${group === undefined ? '' : ` (${group})`}: signature ${text(entry['value']) ?? 0}`);
            }
            break;
        }
        case 'ControllerStatus': {
            // The status tool already renders every line into the summary.
            break;
        }
        default: {
            lines.push(JSON.stringify(data, null, 2));
            break;
        }
    }
    if (verbose)
        lines.push(`Controller payload:\n${JSON.stringify(data, null, 2)}`);
    return lines.join('\n');
}
/** Bridges the inferred schema value back to the envelope the renderer reads. */
function renderValue(value, verbose) {
    return renderOutcome(value, verbose);
}
/** The single place that turns a controller frame into the model-facing text. */
export function renderOutcome(outcome, verbose) {
    const header = outcome.ok
        ? `${outcome.operation} succeeded${outcome.dryRun ? ' (dry run — nothing was written)' : ''}.`
        : `${outcome.operation} FAILED.`;
    const parts = [header, outcome.summary];
    const detail = renderData(outcome.operation, outcome.data, verbose);
    if (detail.length > 0)
        parts.push(detail);
    const error = renderError(outcome.error);
    if (error.length > 0)
        parts.push(error);
    const changes = renderChanges(outcome.changes);
    if (changes.length > 0)
        parts.push(changes);
    const diagnostics = renderDiagnostics(outcome.diagnostics);
    if (diagnostics.length > 0)
        parts.push(diagnostics);
    if (outcome.durationMs > 0)
        parts.push(`(${outcome.durationMs} ms in the controller)`);
    return parts.filter((part) => part.length > 0).join('\n');
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
};
function summarize(operation, frame) {
    if (frame.ok) {
        if (frame.dryRun === true)
            return `${operation} was validated in dry-run mode; pass dry_run=false to execute it.`;
        return `${operation} completed${frame.durationMs === undefined ? '' : ` in ${frame.durationMs} ms`}.`;
    }
    const message = frame.error?.message ?? 'the controller reported a failure';
    const details = record(frame.error?.details);
    const hint = details === null ? undefined : text(details['hint']);
    return hint === undefined ? message : `${message} ${hint}`;
}
async function runOperation(dependencies, operation, params, signal) {
    const frame = await dependencies.request(operation, params, signal === undefined ? {} : { signal });
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
    };
}
/**
 * Appended to every tool description of this plugin.
 *
 * The knowledge base ships as a bundled skill (`skills.ts`), and a skill is
 * only useful if the model connects it to the work at hand. The session catalog
 * already lists it, but the tool list is the one surface the model always reads
 * immediately before calling these tools, and the package's own
 * `AGENTS.md` never reaches an agent working in somebody else's project. Hence
 * one short pointer here rather than a paragraph in a file nobody loads.
 */
const KNOWLEDGE_HINT = 'Troubleshooting: load the bundled `tia-openness` skill (Openness symptom→reference index) instead of guessing.';
/**
 * Registers every tool of this plugin on `ctx.tools`. The framework owns the
 * registrations, so their disposers are not managed here.
 *
 * @returns the registered tool names, in registration order.
 */
export function registerTools(ctx, dependencies) {
    const { verbose } = dependencies;
    const registered = [];
    const register = (definition) => {
        ctx.tools.register({ ...definition, description: `${definition.description} ${KNOWLEDGE_HINT}` });
        registered.push(definition.name);
    };
    register(defineTool({
        name: 'open_project',
        description: 'Open a TIA Portal V17 project for the PLC block tools (export/import/compile). Starts a headless TIA Portal ' +
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
                description: 'True to attach to an already running TIA Portal or start a visible one; false (the default) starts a ' +
                    'headless instance that no operator can interact with.',
            },
            allow_upgrade: {
                type: 'boolean',
                description: 'True to allow TIA Portal to upgrade and rewrite a project created by an older version. Off by default ' +
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
            const params = { project_path: args.project_path };
            if (args.with_window !== undefined)
                params['with_window'] = args.with_window;
            if (args.allow_upgrade !== undefined)
                params['allow_upgrade'] = args.allow_upgrade;
            if (args.dry_run !== undefined)
                params['dry_run'] = args.dry_run;
            return asJsonOutcome(await runOperation(dependencies, 'OpenProject', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'export_blocks',
        description: 'Export PLC program objects of the open project to Simatic ML XML files, one file per object: program blocks ' +
            '(the default, including data blocks), PLC types (UDTs) and tag tables, selected with categories. The ' +
            'user-group folder layout is preserved, and each family gets its own folder below output_dir ' +
            '(blocks/ , types/ , tag_tables/), so the families never collide. ' +
            'Read-only for the project: it never modifies the project, only writes the files. ' +
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
                description: "Which object families to export: 'blocks' (default, includes data blocks), 'types' (PLC data types / " +
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
                description: 'Names of the blocks to export. Omit to export every block of the PLC. An unknown name fails the call ' +
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
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {
                output_dir: args.output_dir,
                categories: args.categories ?? ['blocks'],
                recursive: args.recursive ?? true,
                overwrite: args.overwrite ?? false,
                export_options: args.export_options ?? 'with_defaults',
                write_manifest: args.write_manifest ?? true,
            };
            if (args.block_names !== undefined)
                params['block_names'] = args.block_names;
            if (args.type_names !== undefined)
                params['type_names'] = args.type_names;
            if (args.tag_table_names !== undefined)
                params['tag_table_names'] = args.tag_table_names;
            if (args.device_name !== undefined)
                params['device_name'] = args.device_name;
            if (args.software_name !== undefined)
                params['software_name'] = args.software_name;
            return asJsonOutcome(await runOperation(dependencies, 'ExportBlocks', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'import_blocks',
        description: 'Import PLC blocks into the open project from Simatic ML XML files or from SCL/STL external sources. ' +
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
                description: "'auto' (default) treats *.xml as Simatic ML and every other supported extension as an external source; the " +
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
                description: "User-group path to import into, for example '999_Kautex' or 'A/B'. This matters: import evaluates block " +
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
                description: 'True (default) to derive each file\'s target group from its subdirectory when a directory is imported, ' +
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
            const params = {
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
            };
            if (args.target_group !== undefined)
                params['target_group'] = args.target_group;
            if (args.sw_import_options !== undefined)
                params['sw_import_options'] = args.sw_import_options;
            if (args.device_name !== undefined)
                params['device_name'] = args.device_name;
            if (args.software_name !== undefined)
                params['software_name'] = args.software_name;
            return asJsonOutcome(await runOperation(dependencies, 'ImportBlocks', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'compile_plc',
        description: 'Compile the PLC software of the open project and report the compiler result (state, error count, warning ' +
            'count and the individual messages). Use it to verify that imported blocks really are consistent. ' +
            'Compiling changes the project compile state. ' +
            'Compile errors are reported as data (state "Error", errorCount > 0) and are not an error of this tool. ' +
            'Fails with project_not_open, plc_software_not_found, plc_software_ambiguous, compile_provider_unavailable ' +
            'or compile_failed.',
        parameters: {
            device_name: { type: 'string', description: 'Device that owns the PLC software. Only needed when the project has several PLCs.' },
            software_name: { type: 'string', description: 'PLC software name. Only needed when one device holds several PLC software instances.' },
            max_messages: { type: 'integer', description: 'Maximum number of compiler messages to return (default 200).' },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {};
            if (args.device_name !== undefined)
                params['device_name'] = args.device_name;
            if (args.software_name !== undefined)
                params['software_name'] = args.software_name;
            if (args.max_messages !== undefined)
                params['max_messages'] = args.max_messages;
            return asJsonOutcome(await runOperation(dependencies, 'CompilePlc', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'close_project',
        description: 'Close the TIA Portal project held by the controller and optionally save it first or shut the TIA Portal ' +
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
            const params = {
                save: args.save ?? false,
                close_portal: args.close_portal ?? false,
                dry_run: args.dry_run ?? true,
            };
            return asJsonOutcome(await runOperation(dependencies, 'CloseProject', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'create_project',
        description: 'Create a new TIA Portal V17 project: make the project folder and .ap17 file below project_dir and open it ' +
            'in the TIA Portal instance the controller holds, so the other project tools can work on it immediately. ' +
            'author and comment are the optional creation parameters, and with_window=true creates the project in a ' +
            'visible TIA Portal instead of the default headless instance. Maps to the ' +
            'CreateProject operation. Fails with project_already_open, project_create_failed or invalid_params.',
        parameters: {
            project_dir: {
                type: 'string',
                required: true,
                description: 'Absolute directory the new project folder is created in, for example C:\\Projects\\Line1.',
            },
            project_name: {
                type: 'string',
                required: true,
                description: 'Name of the new project. It is also the name of the project folder created below project_dir.',
            },
            author: { type: 'string', description: 'Optional author stored in the new project.' },
            comment: { type: 'string', description: 'Optional project comment stored in the new project.' },
            with_window: {
                type: 'boolean',
                description: 'True to create the project in a visible TIA Portal instance; false (the default) uses a headless instance.',
            },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {
                project_dir: args.project_dir,
                project_name: args.project_name,
                with_window: args.with_window ?? false,
            };
            if (args.author !== undefined)
                params['author'] = args.author;
            if (args.comment !== undefined)
                params['comment'] = args.comment;
            return asJsonOutcome(await runOperation(dependencies, 'CreateProject', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'save_project',
        description: 'Save the open TIA Portal project, optionally as a copy: save_as_dir saves the project into a different ' +
            'location. WRITES the project file. Two things about save_as_dir matter: ' +
            '(1) TIA moves the persistence location of the currently open project there, exactly like the UI\'s ' +
            '"Save as" — the original folder keeps its files but stops being the project the controller holds, so later ' +
            'saves and close_project(save=true) write to the new location. (2) SaveAs takes only a target directory: ' +
            'Openness cannot rename a project (Project.Name is read-only and there is no SaveAs(folder, newName) ' +
            'overload), so TIA decides the folder/file layout below that directory and the project name stays as it is. ' +
            'The result therefore reports requestedSaveAsDir, the path TIA actually produced (savedAs / projectPath) and ' +
            'locationChanged — read them instead of assuming the given directory is where the .ap17 lands. The result ' +
            'also reports isModifiedBeforeSave and isModified, which is how you confirm that changes really reached disk ' +
            'before closing. Maps to the SaveProject operation. Fails with project_not_open or project_save_failed.',
        parameters: {
            save_as_dir: {
                type: 'string',
                description: 'Absolute target directory for "save as". Omit to save the project in place. TIA places the project ' +
                    'folder below it and keeps the project name, so the resulting .ap17 path is reported back rather than ' +
                    'assumed.',
            },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {};
            if (args.save_as_dir !== undefined)
                params['save_as_dir'] = args.save_as_dir;
            return asJsonOutcome(await runOperation(dependencies, 'SaveProject', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'archive_project',
        description: 'Archive the open project into a .zap17 archive, or retrieve an archive into a new project. action=archive ' +
            '(the default) writes target_dir/target_name using mode none, compressed (the default), ' +
            'discard_restorable_data or discard_restorable_data_and_compressed. action=retrieve reads archive_path into ' +
            'target_dir, optionally upgrading the project (upgrade) and opening it in a visible TIA Portal instance ' +
            '(with_window) with project_open_mode primary or secondary. Archiving writes the archive file; ' +
            'retrieving opens a project. Maps to the ArchiveProject operation. Fails with project_not_open, project_not_saved ' +
            '(unsaved changes), archive_failed, project_already_open, archive_not_found or retrieve_failed.',
        parameters: {
            action: {
                type: 'string',
                enum: ['archive', 'retrieve'],
                description: "'archive' (the default) writes an archive of the open project; 'retrieve' creates a project from an archive.",
            },
            target_dir: {
                type: 'string',
                required: true,
                description: 'For archive: directory the archive is written to. For retrieve: directory the retrieved project folder is created in.',
            },
            target_name: { type: 'string', description: 'File name of the archive to write. Required for action archive.' },
            mode: {
                type: 'string',
                enum: ['none', 'compressed', 'discard_restorable_data', 'discard_restorable_data_and_compressed'],
                description: "Archive mode, default 'compressed'. 'discard_restorable_data' variants shrink the archive but drop restorable data.",
            },
            archive_path: { type: 'string', description: 'Absolute path of the .zap17 archive to retrieve. Required for action retrieve.' },
            upgrade: { type: 'boolean', description: 'Retrieve only: true upgrades the retrieved project to V17. Defaults to false.' },
            project_open_mode: {
                type: 'string',
                enum: ['primary', 'secondary'],
                description: "Retrieve only: open the retrieved project as 'primary' (the default) or 'secondary'.",
            },
            with_window: {
                type: 'boolean',
                description: 'Retrieve only: true opens the retrieved project in a visible TIA Portal instance. Defaults to false.',
            },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const action = args.action ?? 'archive';
            const params = { action };
            if (args.target_dir !== undefined)
                params['target_dir'] = args.target_dir;
            if (action === 'archive') {
                if (args.target_name !== undefined)
                    params['target_name'] = args.target_name;
                params['mode'] = args.mode ?? 'compressed';
            }
            else {
                if (args.archive_path !== undefined)
                    params['archive_path'] = args.archive_path;
                params['upgrade'] = args.upgrade ?? false;
                params['project_open_mode'] = args.project_open_mode ?? 'primary';
                params['with_window'] = args.with_window ?? false;
            }
            return asJsonOutcome(await runOperation(dependencies, 'ArchiveProject', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'project_info',
        description: 'Read the metadata of the open project: attributes, comment, languages, history, installed products, ' +
            'device list, PLC software composition and TIA Portal settings, selected with sections (default: ' +
            'attributes, comment, languages, products, software). Read-only — it never modifies the project and has no ' +
            'dry_run. history_limit caps the history entries (default 50) and max_objects caps the device and software ' +
            'listings (default 200); include_attribute_infos adds the attribute name/accessMode pairs. Maps to the ' +
            'ProjectInfo operation. Fails with project_not_open.',
        parameters: {
            sections: {
                type: 'array',
                items: {
                    type: 'string',
                    enum: ['attributes', 'comment', 'languages', 'history', 'products', 'devices', 'software', 'settings'],
                },
                description: "Which sections to return. Defaults to ['attributes', 'comment', 'languages', 'products', 'software']; add 'history', 'devices' or 'settings' when needed.",
            },
            history_limit: { type: 'integer', description: 'Maximum number of project history entries to return (default 50).' },
            max_objects: { type: 'integer', description: 'Maximum number of devices and software items to list (default 200).' },
            include_attribute_infos: {
                type: 'boolean',
                description: 'True to add the attribute name/accessMode pairs of the project and of every device (default false).',
            },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {
                sections: args.sections ?? ['attributes', 'comment', 'languages', 'products', 'software'],
                history_limit: args.history_limit ?? 50,
                max_objects: args.max_objects ?? 200,
                include_attribute_infos: args.include_attribute_infos ?? false,
            };
            return asJsonOutcome(await runOperation(dependencies, 'ProjectInfo', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'project_languages',
        description: 'List or change the languages of the open project. action=list (the default) reports the supported ' +
            'language catalog plus the active, editing and reference language; action=set adds or removes ' +
            'active_languages (active_mode add, the default, or remove) and sets editing_language and/or ' +
            'reference_language. Only action=set writes to the project. Maps to the ProjectLanguages operation. Fails with project_not_open, ' +
            'language_not_found (details.available lists the supported cultures) or invalid_params.',
        parameters: {
            action: {
                type: 'string',
                enum: ['list', 'set'],
                description: "'list' (the default) reports the languages; 'set' changes them.",
            },
            active_languages: {
                type: 'array',
                items: { type: 'string' },
                description: "Culture names to add to or remove from the active languages in action=set, for example 'de-DE'.",
            },
            active_mode: {
                type: 'string',
                enum: ['add', 'remove'],
                description: "How active_languages is applied in action=set: 'add' (the default) or 'remove'.",
            },
            editing_language: { type: 'string', description: "Culture name to set as the project's editing language in action=set." },
            reference_language: { type: 'string', description: "Culture name to set as the project's reference language in action=set." },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {
                action: args.action ?? 'list',
                active_mode: args.active_mode ?? 'add',
            };
            if (args.active_languages !== undefined)
                params['active_languages'] = args.active_languages;
            if (args.editing_language !== undefined)
                params['editing_language'] = args.editing_language;
            if (args.reference_language !== undefined)
                params['reference_language'] = args.reference_language;
            return asJsonOutcome(await runOperation(dependencies, 'ProjectLanguages', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'project_texts',
        description: 'Export the project texts of the open project into an XLSX file, or import them back from one. ' +
            'action=export needs source_language and target_language and writes file; it writes only that file, not the ' +
            'project. action=import reads file into the project and is NOT wrapped in a transaction (the Openness manual ' +
            'forbids ProjectText import inside one), so it cannot be rolled back; update_source_language=true also updates the source language column, and the ' +
            'result reports the import state (Info, Warning or Error) and the result path. Maps to the ProjectTexts ' +
            'operation. Fails with project_not_open, project_text_export_failed, project_text_import_failed or ' +
            'invalid_params.',
        parameters: {
            action: {
                type: 'string',
                required: true,
                enum: ['export', 'import'],
                description: "'export' writes the project texts to file; 'import' reads them back from file.",
            },
            file: { type: 'string', required: true, description: 'Absolute path of the XLSX file to write (export) or to read (import).' },
            source_language: { type: 'string', description: "Culture name of the source language column. Required for action=export, for example 'en-US'." },
            target_language: { type: 'string', description: "Culture name of the target language column. Required for action=export, for example 'de-DE'." },
            update_source_language: {
                type: 'boolean',
                description: 'Import only: true also updates the source language column from the file. Defaults to false.',
            },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const action = args.action;
            const params = {
                action,
                file: args.file,
            };
            if (args.source_language !== undefined)
                params['source_language'] = args.source_language;
            if (args.target_language !== undefined)
                params['target_language'] = args.target_language;
            if (action === 'import')
                params['update_source_language'] = args.update_source_language ?? false;
            return asJsonOutcome(await runOperation(dependencies, 'ProjectTexts', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'update_project',
        description: "Change project-level settings of the open project: simulation_during_block_compilation and, per " +
            'language, the project comment (comment_language plus comment_text). WRITES to the project; the result reports the before and after value of every item and whether it changed. At ' +
            'least one writable item is required. Maps to the UpdateProject operation. Fails with project_not_open, ' +
            'project_update_failed, language_not_found or invalid_params.',
        parameters: {
            simulation_during_block_compilation: {
                type: 'boolean',
                description: 'New value for the "simulation during block compilation" project setting.',
            },
            comment_language: { type: 'string', description: "Culture name of the project comment to change, for example 'en-US'." },
            comment_text: { type: 'string', description: 'New project comment text for comment_language.' },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {};
            if (args.simulation_during_block_compilation !== undefined) {
                params['simulation_during_block_compilation'] = args.simulation_during_block_compilation;
            }
            if (args.comment_language !== undefined)
                params['comment_language'] = args.comment_language;
            if (args.comment_text !== undefined)
                params['comment_text'] = args.comment_text;
            return asJsonOutcome(await runOperation(dependencies, 'UpdateProject', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'portal_settings',
        description: 'Read or change TIA Portal settings, which live outside the project. action=list (the default) reports ' +
            'every setting folder and its settings with valueType, value and writeable; action=set changes the single ' +
            'setting named by setting in folder (default General) to value, which the controller converts according to ' +
            'value_type (auto, string, boolean, integer or culture). Only action=set writes; with_window=true uses a visible TIA Portal instance, which some settings require. Maps to the ' +
            'PortalSettings operation. Fails with setting_not_found (details.availableFolders / ' +
            'details.availableSettings), setting_change_failed or invalid_params.',
        parameters: {
            action: {
                type: 'string',
                enum: ['list', 'set'],
                description: "'list' (the default) reports the settings; 'set' changes one of them.",
            },
            folder: { type: 'string', description: "Setting folder to read or write. Defaults to 'General'." },
            setting: { type: 'string', description: 'Name of the setting to change. Required for action=set.' },
            value: {
                type: 'json',
                description: 'New value for action=set. It may be a string, number or boolean: the controller converts it according to value_type, ' +
                    'which is why it is not declared as one JSON type here.',
            },
            value_type: {
                type: 'string',
                enum: ['auto', 'string', 'boolean', 'integer', 'culture'],
                description: "How value is converted: 'auto' (the default) lets the controller pick the setting's own type.",
            },
            with_window: {
                type: 'boolean',
                description: 'True to use a visible TIA Portal instance; false (the default) uses the headless one. Some settings only exist with a window.',
            },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {
                action: args.action ?? 'list',
                folder: args.folder ?? 'General',
                value_type: args.value_type ?? 'auto',
                with_window: args.with_window ?? false,
            };
            if (args.setting !== undefined)
                params['setting'] = args.setting;
            if (args.value !== undefined)
                params['value'] = args.value;
            return asJsonOutcome(await runOperation(dependencies, 'PortalSettings', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'list_plc_objects',
        description: 'List the objects of one PLC software of the open project: program blocks, PLC types (UDTs), tag tables, ' +
            'external sources, watch tables, force tables and software units, selected with categories (default: ' +
            'blocks, types, tag_tables). Read-only — it never modifies the project and has no dry_run. recursive ' +
            'defaults to true, name_filter is a case-insensitive substring match on the names, block_names/type_names/' +
            'tag_table_names select exact names instead (a name that matches nothing is reported under data.missing ' +
            'rather than failing), include_tags and include_constants extend the tag tables, include_attributes and ' +
            'include_fingerprints add the attribute and fingerprint lists, and max_items caps the listing (default ' +
            '200, reported through truncated). This is the only way to read block/UDT fingerprints offline: ' +
            'include_fingerprints returns the per-object FingerprintProvider list (id = Code / Interface / Properties / ' +
            'Comments / LibraryType / Texts / … , value = the opaque string to compare), which is what detects changes ' +
            'between two versions of a project. Maps to the ListPlcObjects operation. Fails with project_not_open, ' +
            'plc_software_not_found or plc_software_ambiguous.',
        parameters: {
            categories: {
                type: 'array',
                items: {
                    type: 'string',
                    enum: ['blocks', 'types', 'tag_tables', 'external_sources', 'watch_tables', 'force_tables', 'units'],
                },
                description: "Object families to list. Omit it to get ['blocks', 'types', 'tag_tables'], or — when block_names/type_names/tag_table_names are given — only the families those names select. Add 'external_sources', 'watch_tables', 'force_tables' or 'units' explicitly when needed.",
            },
            device_name: { type: 'string', description: 'Device that owns the PLC software. Only needed when the project has several PLCs.' },
            software_name: { type: 'string', description: 'PLC software name. Only needed when one device holds several PLC software instances.' },
            recursive: { type: 'boolean', description: 'True (the default) to include objects in user groups.' },
            name_filter: { type: 'string', description: 'Case-insensitive substring that an object name must contain to be listed. Ignored for a family for which exact names were given.' },
            block_names: {
                type: 'array',
                items: { type: 'string' },
                description: 'Exact block names to list (searched across all user groups). A name that matches nothing appears under data.missing.blocks.',
            },
            type_names: {
                type: 'array',
                items: { type: 'string' },
                description: 'Exact PLC type (UDT) names to list. A name that matches nothing appears under data.missing.types.',
            },
            tag_table_names: {
                type: 'array',
                items: { type: 'string' },
                description: 'Exact tag table names to list. A name that matches nothing appears under data.missing.tagTables.',
            },
            include_tags: { type: 'boolean', description: 'True to list the tags of every listed tag table (default false).' },
            include_constants: { type: 'boolean', description: 'True to list the user and system constants of every listed tag table (default false).' },
            include_attributes: { type: 'boolean', description: 'True to add the attribute name/accessMode/value list of every listed object (default false).' },
            include_fingerprints: {
                type: 'boolean',
                description: 'True to add the fingerprint id/value list of every listed block and PLC type (default false). Tag tables have no fingerprints. A block that is not consistent reports an entry with an error instead of failing the call.',
            },
            max_items: { type: 'integer', description: 'Maximum number of objects to return per family (default 200). Truncation is reported as data.truncated.' },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {
                recursive: args.recursive ?? true,
                include_tags: args.include_tags ?? false,
                include_constants: args.include_constants ?? false,
                include_attributes: args.include_attributes ?? false,
                include_fingerprints: args.include_fingerprints ?? false,
                max_items: args.max_items ?? 200,
            };
            // categories is deliberately left out when the caller did not name any:
            // the controller then lists exactly the families that block_names /
            // type_names / tag_table_names selected (and all three when nothing was
            // selected at all). Sending a default here would defeat that.
            if (args.categories !== undefined)
                params['categories'] = args.categories;
            if (args.device_name !== undefined)
                params['device_name'] = args.device_name;
            if (args.software_name !== undefined)
                params['software_name'] = args.software_name;
            if (args.name_filter !== undefined)
                params['name_filter'] = args.name_filter;
            if (args.block_names !== undefined)
                params['block_names'] = args.block_names;
            if (args.type_names !== undefined)
                params['type_names'] = args.type_names;
            if (args.tag_table_names !== undefined)
                params['tag_table_names'] = args.tag_table_names;
            return asJsonOutcome(await runOperation(dependencies, 'ListPlcObjects', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'create_plc_objects',
        description: 'Create one object in the PLC software of the open project. kind selects a block group, type group, tag ' +
            'table group, tag table, watch table, software unit or instance DB; name is required for everything except ' +
            'the three group kinds, where group_path is the path of the group to create instead. For the other kinds ' +
            'group_path is the parent group, and create_parents=true creates the missing groups on the way. An ' +
            'instance_db also needs instance_of (the function block it instantiates) and takes auto_number and number ' +
            'for its DB number. WRITES to the project. Maps to the CreatePlcObjects ' +
            'operation. Fails with invalid_params, group_not_found, group_create_failed, object_already_exists, ' +
            'object_create_failed or unit_provider_unavailable.',
        parameters: {
            kind: {
                type: 'string',
                required: true,
                enum: ['block_group', 'type_group', 'tag_table_group', 'tag_table', 'watch_table', 'unit', 'instance_db'],
                description: 'Kind of object to create. The three *_group kinds create a group, the others create an object inside a group.',
            },
            name: {
                type: 'string',
                description: 'Name of the object to create. Required for every kind except block_group, type_group and tag_table_group.',
            },
            group_path: {
                type: 'string',
                description: 'For the *_group kinds: path of the group to create. For the other kinds: parent group the object is created in.',
            },
            create_parents: {
                type: 'boolean',
                description: 'True to create the missing groups of group_path instead of failing with group_not_found. Defaults to false.',
            },
            instance_of: { type: 'string', description: 'Name of the function block the new instance DB instantiates. Required for kind instance_db.' },
            auto_number: { type: 'boolean', description: 'instance_db only: true (the default) lets TIA assign the DB number, so number is ignored.' },
            number: { type: 'integer', description: 'instance_db only: DB number to use when auto_number is false. Defaults to 0.' },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const kind = args.kind;
            const params = {
                kind,
                create_parents: args.create_parents ?? false,
            };
            if (args.name !== undefined)
                params['name'] = args.name;
            if (args.group_path !== undefined)
                params['group_path'] = args.group_path;
            if (args.instance_of !== undefined)
                params['instance_of'] = args.instance_of;
            if (kind === 'instance_db') {
                params['auto_number'] = args.auto_number ?? true;
                params['number'] = args.number ?? 0;
            }
            return asJsonOutcome(await runOperation(dependencies, 'CreatePlcObjects', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'delete_plc_objects',
        description: 'Delete PLC objects of the open project: program blocks, PLC types, tag tables, watch tables and software ' +
            'units by name, whole groups through block_group_paths, type_group_paths and tag_table_group_paths, and ' +
            'individual tags or constants inside the table named by tag_table (otherwise give them as Table.Name). ' +
            'group_path is the parent group the names are looked up in. WRITES to the project, so dry_run defaults to ' +
            'true; the dry run reports every planned object with whether it exists. strict_missing (the default) fails ' +
            'when a name does not exist; false skips it. Maps to the DeletePlcObjects operation. Fails with ' +
            'object_not_found (details.missing / details.available), delete_failed, group_not_empty or ' +
            'project_not_open.',
        parameters: {
            block_names: { type: 'array', items: { type: 'string' }, description: 'Names of the program blocks to delete.' },
            type_names: { type: 'array', items: { type: 'string' }, description: 'Names of the PLC types (UDTs) to delete.' },
            tag_table_names: { type: 'array', items: { type: 'string' }, description: 'Names of the tag tables to delete.' },
            watch_table_names: { type: 'array', items: { type: 'string' }, description: 'Names of the watch tables to delete.' },
            unit_names: { type: 'array', items: { type: 'string' }, description: 'Names of the software units to delete.' },
            block_group_paths: { type: 'array', items: { type: 'string' }, description: 'Paths of the block groups to delete, for example A/B.' },
            type_group_paths: { type: 'array', items: { type: 'string' }, description: 'Paths of the PLC type groups to delete.' },
            tag_table_group_paths: { type: 'array', items: { type: 'string' }, description: 'Paths of the tag table groups to delete.' },
            group_path: { type: 'string', description: 'Parent group the *_names and *_group_paths are resolved in.' },
            tag_table: { type: 'string', description: 'Tag table that tag_names and constant_names belong to. Omit to give them as Table.Name.' },
            tag_names: { type: 'array', items: { type: 'string' }, description: 'Names of the tags to delete, either inside tag_table or as Table.Name.' },
            constant_names: { type: 'array', items: { type: 'string' }, description: 'Names of the user constants to delete, either inside tag_table or as Table.Name.' },
            strict_missing: {
                type: 'boolean',
                description: 'True (the default) fails with object_not_found when one of the names does not exist; false reports it in data.missing and deletes the rest.',
            },
            dry_run: {
                type: 'boolean',
                description: 'Defaults to true because this tool deletes from the project. Set false to delete.',
            },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {
                strict_missing: args.strict_missing ?? true,
                dry_run: args.dry_run ?? true,
            };
            if (args.block_names !== undefined)
                params['block_names'] = args.block_names;
            if (args.type_names !== undefined)
                params['type_names'] = args.type_names;
            if (args.tag_table_names !== undefined)
                params['tag_table_names'] = args.tag_table_names;
            if (args.watch_table_names !== undefined)
                params['watch_table_names'] = args.watch_table_names;
            if (args.unit_names !== undefined)
                params['unit_names'] = args.unit_names;
            if (args.block_group_paths !== undefined)
                params['block_group_paths'] = args.block_group_paths;
            if (args.type_group_paths !== undefined)
                params['type_group_paths'] = args.type_group_paths;
            if (args.tag_table_group_paths !== undefined)
                params['tag_table_group_paths'] = args.tag_table_group_paths;
            if (args.group_path !== undefined)
                params['group_path'] = args.group_path;
            if (args.tag_table !== undefined)
                params['tag_table'] = args.tag_table;
            if (args.tag_names !== undefined)
                params['tag_names'] = args.tag_names;
            if (args.constant_names !== undefined)
                params['constant_names'] = args.constant_names;
            return asJsonOutcome(await runOperation(dependencies, 'DeletePlcObjects', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'write_tags',
        description: 'Create, update or delete tags and user constants of one tag table in the open project. Every entry of ' +
            'tags carries name plus the optional data_type, logical_address, comment and ' +
            'external_accessible/external_visible/external_writable flags; entries of constants carry name plus ' +
            'data_type, value and comment. In both lists create and update decide whether a missing object is created ' +
            'or an existing one is updated, and delete_tags/delete_constants remove names. WRITES to the project, so ' +
            'dry_run defaults to true; the result reports the action (created, updated, unchanged, skipped or ' +
            'deleted) and the before/after value of every changed attribute. Maps to the WriteTags operation. Fails ' +
            'with tag_table_not_found, tag_not_found, tag_create_failed, tag_update_failed, constant_create_failed, ' +
            'constant_update_failed or invalid_params.',
        parameters: {
            tag_table: { type: 'string', required: true, description: 'Name of the tag table to write to.' },
            group_path: { type: 'string', description: 'Group path of the tag table when it does not live in the root group.' },
            tags: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        name: { type: 'string', required: true, description: 'Tag name.' },
                        data_type: { type: 'string', description: "Data type of the tag, for example 'Bool' or 'Int'." },
                        logical_address: { type: 'string', description: "Logical address of the tag, for example '%I0.0'." },
                        comment: { type: 'string', description: 'Comment of the tag.' },
                        external_accessible: { type: 'boolean', description: 'External accessibility flag of the tag.' },
                        external_visible: { type: 'boolean', description: 'External visibility flag of the tag.' },
                        external_writable: { type: 'boolean', description: 'External writability flag of the tag.' },
                        create: { type: 'boolean', description: 'True to create the tag when it does not exist; false to skip it.' },
                        update: { type: 'boolean', description: 'True to update an existing tag; false to leave it unchanged.' },
                    },
                },
                description: 'Tags to create or update. Each entry needs name; the other fields are only written when given.',
            },
            constants: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        name: { type: 'string', required: true, description: 'Constant name.' },
                        data_type: { type: 'string', description: "Data type of the constant, for example 'Int'." },
                        value: { type: 'json', description: 'Value of the constant: a string, number or boolean, converted to the data type.' },
                        comment: { type: 'string', description: 'Comment of the constant.' },
                        create: { type: 'boolean', description: 'True to create the constant when it does not exist; false to skip it.' },
                        update: { type: 'boolean', description: 'True to update an existing constant; false to leave it unchanged.' },
                    },
                },
                description: 'User constants to create or update. Each entry needs name; the other fields are only written when given.',
            },
            delete_tags: { type: 'array', items: { type: 'string' }, description: 'Names of the tags to delete from the tag table.' },
            delete_constants: { type: 'array', items: { type: 'string' }, description: 'Names of the user constants to delete from the tag table.' },
            dry_run: {
                type: 'boolean',
                description: 'Defaults to true because this tool writes to the project. Set false to write the tags and constants.',
            },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {
                tag_table: args.tag_table,
                dry_run: args.dry_run ?? true,
            };
            if (args.group_path !== undefined)
                params['group_path'] = args.group_path;
            if (args.tags !== undefined)
                params['tags'] = args.tags;
            if (args.constants !== undefined)
                params['constants'] = args.constants;
            if (args.delete_tags !== undefined)
                params['delete_tags'] = args.delete_tags;
            if (args.delete_constants !== undefined)
                params['delete_constants'] = args.delete_constants;
            return asJsonOutcome(await runOperation(dependencies, 'WriteTags', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'set_block_attributes',
        description: 'Write Openness attributes of existing blocks (target block, the default) or PLC types (target type) in ' +
            'the open project: names lists the objects, attributes maps an attribute name to its new value, and ' +
            'value_types optionally maps an attribute name to auto, string, boolean or integer for the conversion. ' +
            'group_path restricts the lookup to one group; omit it to search recursively. WRITES to the project, so ' +
            'dry_run defaults to true and the result reports every before/after pair. Maps to the SetBlockAttributes ' +
            'operation. Fails with block_not_found, type_not_found, attribute_not_writeable, attribute_write_failed ' +
            'or invalid_params.',
        parameters: {
            target: {
                type: 'string',
                enum: ['block', 'type'],
                description: "Object family names refers to: 'block' (the default) or 'type' (PLC types / UDTs).",
            },
            names: { type: 'array', required: true, items: { type: 'string' }, description: 'Names of the blocks or PLC types to change.' },
            group_path: { type: 'string', description: 'Group path the names are looked up in. Omit to search recursively.' },
            attributes: {
                type: 'object',
                required: true,
                additionalProperties: true,
                description: 'Attribute name to new value. Every value is passed through as given, converted according to value_types.',
            },
            value_types: {
                type: 'object',
                additionalProperties: true,
                description: "Optional attribute name to conversion ('auto', 'string', 'boolean' or 'integer'). Attributes without an entry use 'auto'.",
            },
            dry_run: {
                type: 'boolean',
                description: 'Defaults to true because this tool writes to the project. Set false to apply the attributes.',
            },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {
                target: args.target ?? 'block',
                names: args.names,
                attributes: args.attributes,
                dry_run: args.dry_run ?? true,
            };
            if (args.group_path !== undefined)
                params['group_path'] = args.group_path;
            if (args.value_types !== undefined)
                params['value_types'] = args.value_types;
            return asJsonOutcome(await runOperation(dependencies, 'SetBlockAttributes', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'protect_blocks',
        description: 'Protect blocks with a know-how password (action protect) or remove that protection again (action ' +
            'unprotect), applied to every name in block_names and optionally restricted to group_path. The password ' +
            'is handed to Openness as a SecureString and is never echoed back in the result. WRITES to the project, ' +
            'so dry_run defaults to true. The result lists the blocks whose protection changed and, per block, the ' +
            'code and message of the ones that failed, so one bad block does not hide the rest. Maps to the ' +
            'ProtectBlocks operation. Fails with block_not_found, protection_unavailable (the block offers no ' +
            'protection service), protect_failed, unprotect_failed or invalid_params.',
        parameters: {
            block_names: { type: 'array', required: true, items: { type: 'string' }, description: 'Names of the blocks to protect or unprotect.' },
            action: {
                type: 'string',
                required: true,
                enum: ['protect', 'unprotect'],
                description: "'protect' sets the know-how protection; 'unprotect' removes it again.",
            },
            password: {
                type: 'string',
                required: true,
                description: 'Know-how password. It is passed to Openness as a SecureString and is never returned in the result.',
            },
            group_path: { type: 'string', description: 'Group path the block names are looked up in. Omit to search recursively.' },
            dry_run: {
                type: 'boolean',
                description: 'Defaults to true because this tool changes block protection. Set false to protect or unprotect.',
            },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {
                block_names: args.block_names,
                action: args.action,
                password: args.password,
                dry_run: args.dry_run ?? true,
            };
            if (args.group_path !== undefined)
                params['group_path'] = args.group_path;
            return asJsonOutcome(await runOperation(dependencies, 'ProtectBlocks', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'generate_source',
        description: 'Generate SCL/STL source from blocks and PLC types of the open project into one output_file: block_names ' +
            'selects blocks (the extension follows the language — .scl for SCL, .awl for STL, .db for data blocks) ' +
            'and type_names selects PLC types (extension .udt is required); with_dependencies also writes the objects ' +
            'those blocks depend on. Only the file system is written; overwrite=true is ' +
            'required to replace an existing file. Maps to the GenerateSource operation. Fails with invalid_params, ' +
            'object_not_found, file_exists or generate_source_failed.',
        parameters: {
            output_file: { type: 'string', required: true, description: 'Absolute path of the source file to write.' },
            block_names: { type: 'array', items: { type: 'string' }, description: 'Names of the blocks to generate source from.' },
            type_names: { type: 'array', items: { type: 'string' }, description: 'Names of the PLC types to generate; output_file must end in .udt.' },
            with_dependencies: { type: 'boolean', description: 'True to also generate the objects the selected blocks depend on. Defaults to false.' },
            overwrite: { type: 'boolean', description: 'True to replace an existing output_file; false (the default) fails with file_exists.' },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {
                output_file: args.output_file,
                with_dependencies: args.with_dependencies ?? false,
                overwrite: args.overwrite ?? false,
            };
            if (args.block_names !== undefined)
                params['block_names'] = args.block_names;
            if (args.type_names !== undefined)
                params['type_names'] = args.type_names;
            return asJsonOutcome(await runOperation(dependencies, 'GenerateSource', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'watch_and_force_tables',
        description: 'Manage watch and force tables of the open project: action create, delete, export or import, with kind ' +
            'watch (the default) or force. create, delete and export need name; export also needs output_file, and ' +
            'import needs import_paths together with import_options none (the default) or override. create_group=true ' +
            'creates a missing group_path and overwrite=true allows replacing an exported file. create/delete change the ' +
            'project and export writes a file; import reports the imported tables and whether the transaction committed. Maps to the ' +
            'WatchAndForceTables operation. Fails with watch_table_not_found, force_table_not_found, ' +
            'table_create_failed, table_delete_failed, export_failed, import_failed or invalid_params.',
        parameters: {
            action: {
                type: 'string',
                required: true,
                enum: ['create', 'delete', 'export', 'import'],
                description: 'Operation to perform on the watch or force table.',
            },
            kind: {
                type: 'string',
                enum: ['watch', 'force'],
                description: "Table family: 'watch' (the default) or 'force'.",
            },
            group_path: { type: 'string', description: 'Group path the table lives in, or the parent group a created table goes into.' },
            name: { type: 'string', description: 'Name of the table. Required for action create, delete and export.' },
            output_file: { type: 'string', description: 'Absolute file the table is exported to. Required for action export.' },
            import_paths: { type: 'array', items: { type: 'string' }, description: 'Files to import. Required for action import.' },
            import_options: {
                type: 'string',
                enum: ['none', 'override'],
                description: "Import only: 'none' (the default) fails when a table already exists, 'override' replaces it.",
            },
            create_group: { type: 'boolean', description: 'True to create a missing group_path when creating a table. Defaults to false.' },
            overwrite: { type: 'boolean', description: 'True to replace an existing export file. Defaults to false.' },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {
                action: args.action,
                kind: args.kind ?? 'watch',
                import_options: args.import_options ?? 'none',
                create_group: args.create_group ?? false,
                overwrite: args.overwrite ?? false,
            };
            if (args.group_path !== undefined)
                params['group_path'] = args.group_path;
            if (args.name !== undefined)
                params['name'] = args.name;
            if (args.output_file !== undefined)
                params['output_file'] = args.output_file;
            if (args.import_paths !== undefined)
                params['import_paths'] = args.import_paths;
            return asJsonOutcome(await runOperation(dependencies, 'WatchAndForceTables', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'software_units',
        description: 'List and change the software units of the PLC software of the open project. action=list (the default) ' +
            'reports every unit with its object counts and its relations; create and delete add or remove the unit ' +
            'named by name, and relation_create/relation_delete change the relation of that unit to related_object ' +
            'with relation_type software_unit (the default), non_unit_db or to_db. Everything except list writes to the project. Maps to the SoftwareUnits operation. Fails with unit_provider_unavailable ' +
            '(software units are not enabled for this software), unit_not_found, unit_exists, unit_create_failed, ' +
            'unit_delete_failed, relation_create_failed or invalid_params.',
        parameters: {
            action: {
                type: 'string',
                enum: ['list', 'create', 'delete', 'relation_create', 'relation_delete'],
                description: "What to do: 'list' (the default), 'create', 'delete', 'relation_create' or 'relation_delete'.",
            },
            name: { type: 'string', description: 'Name of the software unit. Required for every action except list.' },
            related_object: { type: 'string', description: 'Name of the object the unit is related to. Required for action relation_create.' },
            relation_type: {
                type: 'string',
                enum: ['software_unit', 'non_unit_db', 'to_db'],
                description: "Kind of relation for the relation_* actions: 'software_unit' (the default), 'non_unit_db' or 'to_db'.",
            },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {
                action: args.action ?? 'list',
                relation_type: args.relation_type ?? 'software_unit',
            };
            if (args.name !== undefined)
                params['name'] = args.name;
            if (args.related_object !== undefined)
                params['related_object'] = args.related_object;
            return asJsonOutcome(await runOperation(dependencies, 'SoftwareUnits', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'safety_status',
        description: 'Report the F-related Openness state of the open project and of one PLC software: the global settings, ' +
            'the safety settings and the safety administration, plus every runtime group when ' +
            'include_runtime_groups is true (the default). A PLC that does not support F is not an error — the ' +
            'affected section reports available=false with a reason. Read-only, with no dry_run; with_window=true ' +
            'reads through a visible TIA Portal instance. Maps to the SafetyStatus operation. Fails with ' +
            'project_not_open or openness_unavailable.',
        parameters: {
            include_runtime_groups: { type: 'boolean', description: 'True (the default) to include the F runtime groups with their FOB and cycle times.' },
            include_settings: { type: 'boolean', description: 'True (the default) to include the safety settings section.' },
            with_window: { type: 'boolean', description: 'True to read through a visible TIA Portal instance; false (the default) uses the headless one.' },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {
                include_runtime_groups: args.include_runtime_groups ?? true,
                include_settings: args.include_settings ?? true,
                with_window: args.with_window ?? false,
            };
            return asJsonOutcome(await runOperation(dependencies, 'SafetyStatus', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'set_safety_settings',
        description: 'Change the global safety settings of the TIA Portal instance: safety_modifications_possible and ' +
            'username_for_f_change_history, at least one of which is required. WRITES to those settings; the result reports the before and after value of every item and whether it changed. ' +
            'Maps to the SetSafetySettings operation. Fails with global_settings_unavailable, safety_setting_failed ' +
            'or invalid_params.',
        parameters: {
            safety_modifications_possible: {
                type: 'boolean',
                description: 'New value for whether safety modifications are possible in this TIA Portal installation.',
            },
            username_for_f_change_history: {
                type: 'string',
                description: 'New user name recorded in the F-change history.',
            },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = {};
            if (args.safety_modifications_possible !== undefined) {
                params['safety_modifications_possible'] = args.safety_modifications_possible;
            }
            if (args.username_for_f_change_history !== undefined) {
                params['username_for_f_change_history'] = args.username_for_f_change_history;
            }
            return asJsonOutcome(await runOperation(dependencies, 'SetSafetySettings', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'safety_signatures',
        description: 'Read the safety signatures of the F blocks of one PLC software in the open project: block_names and ' +
            'type_names select the objects (omit both for all blocks) and group_path restricts the lookup. Read-only, ' +
            'with no dry_run. Blocks that are not F blocks are counted but have no signature, and a signature that ' +
            'does not exist or is no longer valid is reported as 0. signature_type is block_offline_signature. Maps ' +
            'to the SafetySignatures operation. Fails with block_not_found, signature_read_failed or ' +
            'project_not_open.',
        parameters: {
            block_names: { type: 'array', items: { type: 'string' }, description: 'Names of the blocks to read signatures from. Omit to read every block.' },
            type_names: { type: 'array', items: { type: 'string' }, description: 'Names of the PLC types to read signatures from.' },
            group_path: { type: 'string', description: 'Group path the names are looked up in. Omit to search recursively.' },
            signature_type: {
                type: 'string',
                enum: ['block_offline_signature'],
                description: "Kind of signature to read. Only 'block_offline_signature' exists, and it is the default.",
            },
        },
        output: {
            schema: OUTCOME_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: renderValue(value, verbose) }],
        },
        async execute(args, exec) {
            const params = { signature_type: args.signature_type ?? 'block_offline_signature' };
            if (args.block_names !== undefined)
                params['block_names'] = args.block_names;
            if (args.type_names !== undefined)
                params['type_names'] = args.type_names;
            if (args.group_path !== undefined)
                params['group_path'] = args.group_path;
            return asJsonOutcome(await runOperation(dependencies, 'SafetySignatures', params, exec.signal));
        },
    }));
    register(defineTool({
        name: 'controller_status',
        description: 'Report the state of the C# Openness controller subprocess: whether it is running, its process id, the ' +
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
            const status = dependencies.status();
            const verboseStatus = { ...status };
            if (args.include_controller_output !== true) {
                delete verboseStatus['stderrTail'];
                delete verboseStatus['unexpectedOutput'];
            }
            const ready = record(status['ready']);
            const openness = ready === null ? null : record(ready['openness']);
            const userGroup = ready === null ? null : record(ready['opennessUserGroup']);
            const parts = [
                `Controller state: ${text(status['state']) ?? 'unknown'}`,
                `Executable: ${text(status['exePath']) ?? '?'} (exists: ${status['exeExists'] === true ? 'yes' : 'no'})`,
            ];
            if (status['pid'] !== null && status['pid'] !== undefined)
                parts.push(`Process id: ${text(status['pid'])}`);
            if (openness !== null) {
                parts.push(`Openness: ${openness['available'] === true ? 'available' : 'NOT AVAILABLE'} at ${text(openness['assemblyPath']) ?? '?'}` +
                    (text(openness['fileVersion']) === undefined ? '' : ` (file version ${text(openness['fileVersion'])})`));
                const reason = text(openness['message']);
                if (reason !== undefined && openness['available'] !== true)
                    parts.push(reason);
            }
            else {
                parts.push('The controller has not been started yet, so Openness has not been probed.');
            }
            if (userGroup !== null) {
                const member = userGroup['isMember'];
                parts.push(`"${text(userGroup['group']) ?? 'Siemens TIA Openness'}" membership: ${member === null || member === undefined ? 'unknown' : member === true ? 'yes' : 'NO'}`);
                const message = text(userGroup['message']);
                if (message !== undefined)
                    parts.push(message);
            }
            parts.push(`Requests served: ${numberOf(status['requestsServed']) ?? 0}, restarts: ${numberOf(status['restarts']) ?? 0}, queued: ${numberOf(status['queueDepth']) ?? 0}`);
            const lastError = record(status['lastError']);
            if (lastError !== null)
                parts.push(`Last error: ${text(lastError['code']) ?? '?'} — ${text(lastError['message']) ?? '?'}`);
            const outcome = {
                ok: true,
                operation: 'ControllerStatus',
                dryRun: true,
                summary: parts.join('\n'),
                data: verboseStatus,
                changes: [],
                diagnostics: [],
                error: null,
                durationMs: 0,
            };
            return asJsonOutcome(outcome);
        },
    }));
    return registered;
}
/**
 * The registry validates the canonical value against the declared schema and
 * rejects anything that is not lossless JSON, so the envelope is converted once
 * here instead of at every return site.
 */
function asJsonOutcome(outcome) {
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
    };
}
/** Re-exported for the tests, which drive the tool bodies directly. */
export { runOperation };
