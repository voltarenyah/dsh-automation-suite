/**
 * Wire types of the controller protocol.
 *
 * The controller speaks newline-delimited JSON on stdin/stdout: one request per
 * line, one `result` frame per request, plus `ready`, `progress` and `log`
 * frames. `docs/PROTOCOL.md` is the authoritative description; this module is the
 * TypeScript view of it plus the tolerant readers used to validate frames that
 * arrive from the child process.
 */
/** Protocol revision implemented by both sides. */
export const PROTOCOL_VERSION = 1;
/**
 * The complete operation whitelist, mirroring the C# `OperationCatalog`.
 *
 * This list is duplicated on purpose: the plugin refuses to send anything else,
 * and the controller independently refuses to execute anything else. Neither side
 * trusts the other's validation. The order is part of the contract too:
 * `scripts/coverage/build-matrix.mjs` compares it entry by entry with the C#
 * catalog, which prints it in the ready frame and in `--help`.
 */
export const OPERATIONS = [
    'OpenProject',
    'ExportBlocks',
    'ImportBlocks',
    'CompilePlc',
    'CloseProject',
    'CreateProject',
    'SaveProject',
    'ArchiveProject',
    'ProjectInfo',
    'ProjectLanguages',
    'ProjectTexts',
    'UpdateProject',
    'PortalSettings',
    'ListPlcObjects',
    'CreatePlcObjects',
    'DeletePlcObjects',
    'WriteTags',
    'SetBlockAttributes',
    'ProtectBlocks',
    'GenerateSource',
    'WatchAndForceTables',
    'SoftwareUnits',
    'SafetyStatus',
    'SetSafetySettings',
    'SafetySignatures',
];
export const OPERATION_SET = new Set(OPERATIONS);
export function isOperation(value) {
    return OPERATION_SET.has(value);
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
/**
 * Parses one line of controller output. Returns `null` for anything that is not
 * a JSON object, which is how stray output from the .NET runtime is tolerated
 * instead of breaking the channel.
 */
export function parseFrame(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{'))
        return null;
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        return null;
    }
    if (!isRecord(parsed))
        return null;
    const type = parsed['type'];
    if (type !== 'ready' && type !== 'result' && type !== 'progress' && type !== 'log')
        return null;
    return parsed;
}
export function isResultFrame(frame) {
    return frame.type === 'result';
}
export function isReadyFrame(frame) {
    return frame.type === 'ready';
}
export function isProgressFrame(frame) {
    return frame.type === 'progress';
}
/**
 * Normalizes the change and diagnostic lists so a renderer never has to defend
 * against a malformed frame.
 */
export function changesOf(frame) {
    return asArray(frame.changes).filter(isRecord);
}
export function diagnosticsOf(frame) {
    return asArray(frame.diagnostics).filter(isRecord);
}
/** Builds the canonical outcome of a failed request that never reached Openness. */
export function localFailure(operation, code, message, details) {
    return {
        ok: false,
        operation,
        dryRun: false,
        summary: `${operation} was not executed: ${message}`,
        data: null,
        changes: [],
        diagnostics: [],
        error: details === undefined ? { code, message } : { code, message, details },
        durationMs: 0,
    };
}
