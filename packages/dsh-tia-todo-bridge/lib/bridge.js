/**
 * Pure planning half of the TIA todo bridge.
 *
 * The bridge is a safety net for the session's visible todo list: when a TIA
 * (or version-workflow) operation starts and the model has not created a list
 * for the turn, it creates one item for the operation and settles that item when
 * the tool result arrives. A list the model wrote is never edited — the model
 * remains the owner of its own plan.
 *
 * Everything here is pure and unit-testable; `index.ts` owns the event wiring.
 *
 * @module @voltarenyah/dsh-tia-todo-bridge/bridge
 */
/**
 * Operations that change TIA state or take long enough to need a visible item.
 * Pure queries (`project_info`, `list_plc_objects`, `controller_status`, …) are
 * deliberately absent: a task that completes in one second is noise, and their
 * status already belongs to the TIA console.
 */
export const TRACKED_TOOLS = new Set([
    'open_project',
    'create_project',
    'save_project',
    'archive_project',
    'close_project',
    'export_blocks',
    'import_blocks',
    'compile_plc',
    'update_project',
    'create_plc_objects',
    'delete_plc_objects',
    'write_tags',
    'set_block_attributes',
    'protect_blocks',
    'generate_source',
    'watch_and_force_tables',
    'show_blocks_in_editor',
    'download',
    'online_connect',
    'online_disconnect',
    'export_hardware_config',
    'adopt_open_project',
    'create_engineering_project',
    'project_sync',
    'project_diff',
    'project_commit',
    'project_translate',
    'project_version_reindex',
    'project_version_verify',
    'project_doc_index',
    'knowledge_ingest',
    'knowledge_update',
]);
/** Argument keys that name the object an operation is about, most specific first. */
const HINT_KEYS = {
    open_project: ['project_path', 'project', 'path'],
    create_project: ['project_path', 'project'],
    archive_project: ['project_path', 'archive_path', 'project'],
    save_project: ['project_path', 'project'],
    close_project: ['project'],
    export_blocks: ['device', 'block', 'block_name', 'group'],
    import_blocks: ['device', 'block', 'block_name', 'group'],
    compile_plc: ['device', 'plc', 'device_name'],
    update_project: ['device', 'project'],
    create_plc_objects: ['device', 'plc'],
    delete_plc_objects: ['device', 'plc'],
    write_tags: ['device', 'table', 'tag_table'],
    set_block_attributes: ['device', 'block', 'block_name'],
    protect_blocks: ['device', 'block', 'block_name'],
    generate_source: ['device', 'block', 'block_name'],
    watch_and_force_tables: ['device', 'table'],
    show_blocks_in_editor: ['device', 'block', 'block_name'],
    download: ['device', 'plc', 'device_name'],
    online_connect: ['device', 'plc', 'device_name'],
    online_disconnect: ['device', 'plc', 'device_name'],
    export_hardware_config: ['device'],
    adopt_open_project: ['project'],
    create_engineering_project: ['source_project', 'project'],
    project_sync: ['device'],
    project_diff: ['device'],
    project_commit: ['device'],
    project_translate: ['device', 'scope'],
    project_version_reindex: ['device'],
    project_version_verify: ['device'],
    project_doc_index: ['device'],
    knowledge_ingest: ['device'],
    knowledge_update: ['device'],
};
/** Keys tried for a tracked tool without a table entry. */
const GENERIC_HINT_KEYS = ['device', 'plc', 'project', 'block', 'name'];
/** The maximum object hint length; the todo row is one line. */
const MAX_HINT_CHARS = 48;
/** @returns the initial, empty bridge state for one session. */
export function emptyState() {
    return { owner: 'none', todos: [], pending: new Map(), writing: false };
}
/** @param value - any value. @returns whether it is a non-array object. */
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** @param value - a candidate todo status. @returns whether the projection accepts it. */
function isStatus(value) {
    return value === 'pending' || value === 'in_progress' || value === 'completed';
}
/**
 * Read the `todos` payload of one `todo/write` event.
 * @param data - the event payload.
 * @returns a validated copy, or null when the payload is not a todo write.
 */
export function readTodos(data) {
    if (!isRecord(data) || !Array.isArray(data.todos))
        return null;
    const todos = [];
    for (const raw of data.todos) {
        if (!isRecord(raw) || typeof raw.content !== 'string' || !isStatus(raw.status))
            return null;
        todos.push({ content: raw.content, status: raw.status });
    }
    return todos;
}
/**
 * Reconstruct the bridge state from a session's log. A `turn/start` resets the
 * standing plan (the `todos` projection does the same); the latest later
 * `todo/write` is the current list. A resumed list is treated as model-owned:
 * after a restart the bridge cannot prove it wrote the snapshot, and skipping a
 * list is safer than editing one it does not own.
 * @param log - the session event log.
 * @returns the reconstructed state.
 */
export function stateFromLog(log) {
    const state = emptyState();
    for (const event of log) {
        if (event.type === 'turn/start') {
            state.owner = 'none';
            state.todos = [];
            state.pending.clear();
            continue;
        }
        if (event.type !== 'todo/write')
            continue;
        const todos = readTodos(event.data);
        if (todos === null)
            continue;
        state.todos = todos;
        state.owner = 'model';
    }
    return state;
}
/** @param value - a string candidate. @returns the first line, trimmed, or null. */
function firstLine(value) {
    const text = value.trim().split(/\r?\n/u)[0]?.trim() ?? '';
    return text.length > 0 ? text : null;
}
/** @param value - a path. @returns its last segment, for either separator. */
function baseName(value) {
    const segments = value.split(/[\\/]/u).filter((segment) => segment.length > 0);
    return segments.at(-1) ?? value;
}
/**
 * Derive a short, human-readable object hint from a tool call's arguments.
 * @param toolName - the tool name, used to choose the most specific key.
 * @param args - the frozen call arguments.
 * @returns the hint, or null when the call carries no usable object name.
 */
export function objectHint(toolName, args) {
    if (!isRecord(args))
        return null;
    const keys = HINT_KEYS[toolName] ?? GENERIC_HINT_KEYS;
    for (const key of keys) {
        const value = args[key];
        if (typeof value !== 'string')
            continue;
        const text = firstLine(value);
        if (text === null)
            continue;
        const hint = key.endsWith('_path') || key === 'path' ? baseName(text) : text;
        return hint.length > MAX_HINT_CHARS ? `${hint.slice(0, MAX_HINT_CHARS - 1)}…` : hint;
    }
    return null;
}
/**
 * The one-line task content for an operation. The `TIA · <tool>` prefix is the
 * contract the persona asks the model to use too, so model-authored and
 * bridge-authored lists read the same way.
 * @param toolName - the operation name.
 * @param args - the frozen call arguments.
 * @param existing - contents already in the list, for uniqueness.
 * @returns a unique, one-line task content.
 */
export function taskContent(toolName, args, existing) {
    const hint = objectHint(toolName, args);
    const base = hint === null ? `TIA · ${toolName}` : `TIA · ${toolName} · ${hint}`;
    if (!existing.includes(base))
        return base;
    let counter = 2;
    while (existing.includes(`${base} · ${counter}`))
        counter += 1;
    return `${base} · ${counter}`;
}
/** @param exec - one execution. @returns the stable key used to pair start and settle. */
export function callKey(exec) {
    return exec.callId ?? exec.token ?? exec.name;
}
/** @param state - bridge state. @param toolName - operation name. @returns whether it is tracked. */
export function isTracked(toolName) {
    return TRACKED_TOOLS.has(toolName);
}
/**
 * Plan the start of one operation. A model-owned list is returned untouched; an
 * absent or bridge-owned list gets a new `in_progress` item.
 * @param state - current bridge state.
 * @param exec - the execution that is about to run.
 * @returns the next list to append, or null when nothing should change.
 */
export function planStart(state, exec) {
    if (state.owner === 'model' || !isTracked(exec.name))
        return null;
    const key = callKey(exec);
    if (state.pending.has(key))
        return null;
    const content = taskContent(exec.name, exec.arguments, state.todos.map((item) => item.content));
    return {
        todos: [...state.todos, { content, status: 'in_progress' }],
        content,
        key,
    };
}
/**
 * Plan the settlement of one operation. Only an item the bridge created is
 * touched; a failure keeps the row visible with a `（失败）` suffix and a
 * `completed` state so nothing spins after the tool returned.
 * @param state - current bridge state.
 * @param key - the call key recorded at start.
 * @param isError - whether the tool result failed.
 * @returns the next list to append, or null when nothing should change.
 */
export function planComplete(state, key, isError) {
    if (state.owner !== 'bridge') {
        state.pending.delete(key);
        return null;
    }
    const content = state.pending.get(key);
    if (content === undefined)
        return null;
    const settled = isError && !content.endsWith('（失败）') ? `${content}（失败）` : content;
    const todos = state.todos.map((item) => item.content === content ? { content: settled, status: 'completed' } : item);
    return { todos, content: settled };
}
/**
 * Append one `todo/write` snapshot and adopt it as bridge-owned. The synchronous
 * `session/event` listener sees `writing` and leaves ownership to this function.
 * @param session - the owning session.
 * @param state - current bridge state.
 * @param todos - the replacement list.
 */
export function appendTodos(session, state, todos) {
    state.writing = true;
    try {
        session.append('todo/write', { todos });
    }
    finally {
        state.writing = false;
    }
    state.todos = todos;
    state.owner = 'bridge';
}
