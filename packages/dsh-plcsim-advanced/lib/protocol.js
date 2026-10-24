/**
 * Wire types shared by the controller process manager and the model-facing
 * tools. The controller speaks one JSON object per line, exactly like the TIA
 * plugin: a `ready` frame once, then one `result` frame per request.
 *
 * @module dsh-plcsim-advanced/protocol
 */
export const PROTOCOL_VERSION = 1;
export function parseFrame(line) {
    const value = JSON.parse(line);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('the controller sent a frame that is not a JSON object');
    }
    return value;
}
export function isReadyFrame(value) {
    return value['type'] === 'ready' && value['protocol'] === PROTOCOL_VERSION;
}
export function isResultFrame(value) {
    return value['type'] === 'result' && value['protocol'] === PROTOCOL_VERSION;
}
/** The four operations the controller accepts; anything else is refused. */
export const OPERATIONS = ['Status', 'Instance', 'Run', 'Tags'];
export function isOperation(value) {
    return OPERATIONS.includes(value);
}
