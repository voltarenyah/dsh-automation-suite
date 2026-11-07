/**
 * DeepSeek Harness plugin: keeps TIA and version-workflow operations visible in
 * the session's todo list.
 *
 * The model owns the list when it writes one. This plugin only acts as a safety
 * net: when an operation starts and the turn has no list (or the list was
 * created by this plugin), it appends one `in_progress` item; when the tool
 * result arrives it marks that item `completed` (with a `（失败）` suffix on
 * failure). It never edits a list the model authored.
 *
 * The item format `TIA · <tool> · <object>` matches the distribution persona, so
 * a bridge list and a model list read the same way.
 *
 * @module @voltarenyah/dsh-tia-todo-bridge
 */
import { randomUUID } from 'node:crypto';
import { appendTodos, callKey, planComplete, planStart, stateFromLog, readTodos, isTracked, } from './bridge.js';
/** Plugin identity; the loader uses it as the entry id in the profile tree. */
export const name = 'tia-todo-bridge';
/** Time a run of `fn`, swallowing a bridge failure so it never affects a tool. */
function guarded(ctx, label, fn) {
    try {
        fn();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`tia-todo-bridge: ${label} failed: ${message}`);
    }
}
/**
 * A model-visible nudge used only when the model owns the list and its matching
 * item is still not settled. It rides `additionalContexts`, so the tool result
 * itself is not rewritten.
 * @param text - the notice body.
 * @param summary - the one-line source label.
 * @returns an identified user-role message the loop can inject.
 */
function notice(text, summary) {
    return {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'tia-todo-bridge', form: 'notice', summary },
    };
}
/**
 * Build the settlement reminder for a model-authored list. A compliant model
 * already marked the item completed, in which case this returns undefined and
 * no extra message is added.
 * @param state - current bridge state.
 * @param exec - the operation that just finished.
 * @param isError - whether the tool result failed.
 * @returns the reminder message, or undefined.
 */
function reminderFor(state, exec, isError) {
    if (state.owner !== 'model' || !isTracked(exec.name))
        return undefined;
    const marker = `TIA · ${exec.name}`;
    const item = state.todos.find((todo) => todo.content.includes(marker));
    if (item?.status === 'completed')
        return undefined;
    const outcome = isError ? '失败' : '已完成';
    const where = item === undefined
        ? '清单里没有与它对应的任务。'
        : `清单里的对应项（"${item.content}"）仍是 ${item.status === 'in_progress' ? '进行中' : '待处理'}。`;
    return notice(`TIA 操作 \`${exec.name}\` ${outcome}。${where} 请立即调用 \`todo_write\` 提交完整清单，把该项标为 \`completed\`（只有仍在重试时才保留 \`in_progress\`；放弃时在内容里加 \`（失败）\` 后缀）。`, `${exec.name} · todo`);
}
/**
 * Mount the bridge on one host context.
 *
 * The plugin registers no tools and no services: it listens to the tool
 * pipeline and the session event feed, so it is safe to mount globally and it
 * is inert on sessions that have no `todos` projection.
 *
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
    /** Per-session state. Session objects live as long as their agent. */
    const states = new WeakMap();
    /** @param session - a live session. @returns its bridge state, reconstructed once. */
    function stateFor(session) {
        let state = states.get(session);
        if (state === undefined) {
            state = stateFromLog(session.log);
            states.set(session, state);
        }
        return state;
    }
    ctx.on('session/event', (session, event) => {
        if (event.type !== 'turn/start' && event.type !== 'todo/write')
            return;
        const state = stateFor(session);
        if (event.type === 'turn/start') {
            state.owner = 'none';
            state.todos = [];
            state.pending.clear();
            return;
        }
        // A write from this plugin is already adopted by `appendTodos`; anything
        // else is the model's list and from now on the bridge leaves it alone.
        if (state.writing)
            return;
        const todos = readTodos(event.data);
        if (todos === null)
            return;
        state.todos = todos;
        state.owner = 'model';
    });
    ctx.on('tools/execute', async (exec, next) => {
        const session = exec.agent?.session;
        const state = session === undefined ? undefined : stateFor(session);
        if (session !== undefined && state !== undefined) {
            guarded(ctx, 'start', () => {
                const plan = planStart(state, exec);
                if (plan === null)
                    return;
                appendTodos(session, state, plan.todos);
                state.pending.set(plan.key, plan.content);
            });
        }
        try {
            return await next();
        }
        catch (error) {
            if (session !== undefined && state !== undefined) {
                guarded(ctx, 'abort', () => {
                    const plan = planComplete(state, callKey(exec), true);
                    if (plan !== null)
                        appendTodos(session, state, plan.todos);
                });
            }
            throw error;
        }
    });
    ctx.on('tools/post-execute', async (exec, result, next) => {
        const session = exec.agent?.session;
        const state = session === undefined ? undefined : stateFor(session);
        const isError = result?.isError === true;
        if (session !== undefined && state !== undefined) {
            guarded(ctx, 'settle', () => {
                const plan = planComplete(state, callKey(exec), isError);
                if (plan !== null)
                    appendTodos(session, state, plan.todos);
            });
        }
        const reminder = state === undefined ? undefined : reminderFor(state, exec, isError);
        const downstream = await next();
        if (reminder === undefined)
            return downstream;
        const decision = downstream;
        const contexts = [reminder, ...(decision?.additionalContexts ?? [])];
        if (decision?.kind === 'block') {
            return { kind: 'block', feedback: decision.feedback, additionalContexts: contexts };
        }
        return { ...decision, additionalContexts: contexts };
    });
}
