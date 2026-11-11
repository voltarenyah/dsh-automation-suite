/**
 * Where this plugin keeps its local state, per session.
 *
 * The snapshot root must follow the **session workspace**, not the host process
 * working directory: a snapshot saved under the host cwd is invisible to the
 * next session in the same workspace, is not part of that workspace's backups,
 * and silently disappears when the host restarts somewhere else. The session
 * working directory (`exec.agent.session.header.cwd`) is the one fact that ties
 * a conversation to an engineering workspace, so every snapshot path is derived
 * from it (the same rule the engineering plugins use for `tia/` and `source/`).
 *
 * @module dsh-plcsim-advanced/workspace
 */
import { join } from 'node:path';
/** Directory, relative to the workspace root, that holds the snapshots. */
export const SNAPSHOT_DIRECTORY = '.dsh/simulation';
/**
 * The session working directory, which is the workspace root of every
 * workspace-relative path this plugin writes.
 *
 * @param exec - the per-call execution context.
 * @returns the recorded cwd, or undefined when the harness supplied none.
 */
export function sessionWorkspaceRoot(exec) {
    const cwd = exec?.agent?.session?.header?.cwd;
    return typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined;
}
/**
 * Resolve the snapshot root for one call.
 *
 * An explicitly configured `snapshotRoot` always wins (a profile may pin a
 * shared folder). Otherwise the root is `<workspace>/.dsh/simulation`; when the
 * harness supplied no session cwd there is no honest answer, so the caller keeps
 * whatever default the controller was launched with rather than inventing a
 * path from the host process cwd.
 *
 * @param configured - the plugin's configured root; empty means "derive".
 * @param workspaceRoot - the session workspace root, when known.
 * @returns the absolute root, or undefined when it cannot be derived.
 */
export function resolveSnapshotRoot(configured, workspaceRoot) {
    const override = configured.trim();
    if (override.length > 0)
        return override;
    if (workspaceRoot === undefined)
        return undefined;
    return join(workspaceRoot, '.dsh', 'simulation');
}
