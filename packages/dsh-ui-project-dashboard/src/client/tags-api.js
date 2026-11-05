/**
 * The tag endpoint client: one GET when the page opens, one POST per user edit.
 *
 * There is no polling and no background refresh. The route is same-origin, so a
 * plain `fetch` is enough; failures carry the host's stable `code` so the UI can
 * distinguish "storage failed" from "another window changed it".
 *
 * @module dsh-ui-project-dashboard/client/tags-api
 */

/** Where the host serves the tag document. */
export const TAGS_URL = '/project-dashboard/api/tags'

/** Where the host reports and removes the shell's first-use workspace. */
export const DEFAULT_WORKSPACE_URL = '/project-dashboard/api/default-workspace'

/** A failure with the host's code (and HTTP status). */
export class TagApiError extends Error {
  /**
   * @param {string} code - host code, or `network`.
   * @param {number} status - HTTP status, or 0 for a transport failure.
   * @param {number | undefined} revision - current revision on a conflict.
   */
  constructor(code, status, revision) {
    super(code)
    this.name = 'TagApiError'
    this.code = code
    this.status = status
    this.revision = revision
  }
}

/**
 * Read the whole document.
 *
 * @param {AbortSignal | undefined} signal - aborts when the page unmounts.
 * @returns {Promise<{ revision: number, corrupt: boolean, workspaces: Record<string, { path: string, tags: string[], updatedAt: string }> }>}
 */
export async function loadTags(signal) {
  let response
  try {
    response = await fetch(TAGS_URL, { signal, headers: { accept: 'application/json' }, cache: 'no-store' })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new TagApiError('network', 0, undefined)
  }
  const body = await readJson(response)
  if (!response.ok || body?.ok !== true) {
    throw new TagApiError(typeof body?.code === 'string' ? body.code : 'http', response.status, body?.revision)
  }
  return { revision: body.revision, corrupt: body.corrupt === true, workspaces: body.workspaces ?? {} }
}

/**
 * Apply one add / remove / set.
 *
 * @param {{ workspaceId: string, op: 'add'|'remove', tag: string, expectedRevision: number } | { workspaceId: string, op: 'set', tags: string[], expectedRevision: number }} input - request.
 * @param {AbortSignal | undefined} signal - aborts when the page unmounts.
 * @returns {Promise<{ revision: number, workspaces: Record<string, any> }>}
 */
export async function mutateTags(input, signal) {
  let response
  try {
    response = await fetch(TAGS_URL, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new TagApiError('network', 0, undefined)
  }
  const body = await readJson(response)
  if (!response.ok || body?.ok !== true) {
    throw new TagApiError(typeof body?.code === 'string' ? body.code : 'http', response.status, body?.revision)
  }
  return { revision: body.revision, workspaces: body.workspaces ?? {} }
}

/**
 * Parse a JSON response without throwing on an empty or malformed body.
 *
 * @param {Response} response - fetch response.
 * @returns {Promise<any>} the parsed body, or null.
 */
async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Read whether the shell's first-use workspace still exists.
 *
 * @param {AbortSignal | undefined} signal - aborts when the page unmounts.
 * @returns {Promise<{ id: string | null, registered: boolean }>}
 */
export async function loadDefaultWorkspace(signal) {
  let response
  try {
    response = await fetch(DEFAULT_WORKSPACE_URL, { signal, headers: { accept: 'application/json' }, cache: 'no-store' })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new TagApiError('network', 0, undefined)
  }
  const body = await readJson(response)
  if (!response.ok || body?.ok !== true) throw new TagApiError(typeof body?.code === 'string' ? body.code : 'http', response.status, undefined)
  return { id: typeof body.id === 'string' ? body.id : null, registered: body.registered === true }
}

/**
 * Unregister the first-use workspace (files and sessions stay).
 *
 * @param {AbortSignal | undefined} signal - aborts when the page unmounts.
 * @returns {Promise<{ deleted: boolean, reason?: string }>}
 */
export async function pruneDefaultWorkspace(signal) {
  let response
  try {
    response = await fetch(DEFAULT_WORKSPACE_URL, { method: 'POST', signal, headers: { accept: 'application/json' } })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new TagApiError('network', 0, undefined)
  }
  const body = await readJson(response)
  if (!response.ok || body?.ok !== true) throw new TagApiError(typeof body?.code === 'string' ? body.code : 'http', response.status, undefined)
  return { deleted: body.deleted === true, reason: typeof body.reason === 'string' ? body.reason : undefined }
}
