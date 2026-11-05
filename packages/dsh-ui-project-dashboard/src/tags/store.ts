/**
 * The durable tag file: `<DSH_HOME>/storages/project-dashboard/tags.json`.
 *
 * Why a hand-written JSON file rather than the host's `storageDomain` (decided
 * 2026-11-05): the file must live at a path the user picked, be trivially
 * inspectable/backup-able, and require no backend/domain/version machinery from
 * the host. The trade-off is that **this module owns atomicity and recovery**:
 *
 *  - every mutation re-reads the file (a second DSH process may have written it),
 *    applies the operation, then writes a sibling temp file and renames it over
 *    the original, so a crash leaves either the old or the new file;
 *  - the previous good file is kept as `tags.json.bak`;
 *  - an unparseable file is preserved as `tags.json.corrupt-<ts>` before the next
 *    write replaces it, and reads report `corrupt` so the UI can say so;
 *  - operations are serialized inside this process;
 *  - a caller that supplies `expectedRevision` gets `TagConflictError` when the
 *    file moved on, which the route turns into a 409.
 *
 * @module dsh-ui-project-dashboard/tags/store
 */

import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  applyOperation,
  emptyDocument,
  parseDocument,
  TagConflictError,
  type TagDocument,
  type TagEntry,
  type TagOperation,
} from './model.js'

/** What one read produced. */
export interface TagSnapshot {
  doc: TagDocument
  /** True when the file existed but could not be parsed as a v1 document. */
  corrupt: boolean
}

/** One successful mutation. */
export interface TagMutationResult {
  doc: TagDocument
  entry: TagEntry
}

/**
 * Owns one tag file. Construct it with the absolute file path; the directory is
 * created on the first write.
 */
export class TagStore {
  /** Serializes mutations inside this process. */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * @param file - absolute path of `tags.json`.
   * @param now - clock override for tests.
   */
  constructor(
    private readonly file: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** @returns the file this store owns (for logs and the route's GET). */
  get path(): string {
    return this.file
  }

  /**
   * Read the document. A missing file is an empty document, not an error.
   *
   * @returns the snapshot.
   * @throws {Error} on IO failures other than absence, and on parse failures.
   */
  async snapshot(): Promise<TagSnapshot> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (isAbsent(error)) return { doc: emptyDocument(), corrupt: false }
      throw error
    }
    try {
      return { doc: parseDocument(text), corrupt: false }
    } catch {
      return { doc: emptyDocument(), corrupt: true }
    }
  }

  /**
   * Apply one operation and persist it.
   *
   * @param operation - add / remove / set for one workspace.
   * @param path - canonical directory from the registry, or `''` when unknown.
   * @param expectedRevision - when supplied, refuse a stale write.
   * @returns the new document and the touched entry.
   * @throws {TagConflictError} when `expectedRevision` no longer matches.
   */
  async mutate(operation: TagOperation, path: string, expectedRevision?: number): Promise<TagMutationResult> {
    return this.enqueue(async () => {
      const snapshot = await this.snapshot()
      if (snapshot.corrupt) await this.preserveCorrupt()
      if (
        expectedRevision !== undefined &&
        Number.isFinite(expectedRevision) &&
        expectedRevision !== snapshot.doc.revision &&
        !snapshot.corrupt
      ) {
        throw new TagConflictError(expectedRevision, snapshot.doc.revision)
      }
      const { doc, entry, changed } = applyOperation(snapshot.doc, operation, path, this.now())
      if (changed) await this.write(doc)
      return { doc, entry }
    })
  }

  /** @returns the queued task's result, keeping the queue alive after failures. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Write atomically: temp file in the same directory, backup, then rename. */
  private async write(doc: TagDocument): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = join(dirname(this.file), `${this.basename()}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
    const text = `${JSON.stringify(doc, null, 2)}\n`
    try {
      await writeFile(temp, text, 'utf8')
      if (await exists(this.file)) {
        try {
          await copyFile(this.file, `${this.file}.bak`)
        } catch {
          /* a backup failure must not block the write */
        }
      }
      await rename(temp, this.file)
    } catch (error) {
      try {
        await unlink(temp)
      } catch {
        /* the temp file may never have been created */
      }
      throw error
    }
  }

  /** Keep an unparseable file for inspection before the next write replaces it. */
  private async preserveCorrupt(): Promise<void> {
    if (!(await exists(this.file))) return
    try {
      await copyFile(this.file, `${this.file}.corrupt-${Date.now()}`)
    } catch {
      /* best effort; the following write still proceeds */
    }
  }

  /** @returns the file name, used in temp file names. */
  private basename(): string {
    const parts = this.file.split(/[\\/]/)
    return parts[parts.length - 1] ?? 'tags.json'
  }
}

/** @returns true when the error is an absent file. */
function isAbsent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/** @returns true when the path exists (any entry type). */
async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch (error) {
    return !isAbsent(error)
  }
}
