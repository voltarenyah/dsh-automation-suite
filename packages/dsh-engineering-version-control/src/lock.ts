/**
 * One writer per workspace.
 *
 * TIA Portal is a single-session resource and the stage/commit sequence is not
 * reentrant, so two agent turns must never interleave. This is a plain lock file
 * with a TTL: a crash leaves it behind, and a later call may reclaim it once it
 * is old enough. It is **not** a correctness check against a human editing TIA;
 * that is the per-block fingerprint check in `apply` (S3).
 *
 * @module dsh-engineering-context/lock
 */

import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { EngineeringContextError } from './errors.js'

/** How long a lock may sit before a later call may reclaim it. */
export const LOCK_TTL_MS = 15 * 60 * 1000

/** What a lock file records. */
export interface LockInfo {
  pid: number
  operation: string
  startedAt: string
}

/** The lock file path of one workspace. */
export function lockFilePath(root: string, stateDirName = '.dsh'): string {
  return join(root, stateDirName, 'local', 'lock.json')
}

/**
 * Read the current lock without creating one.
 *
 * @param root - the workspace root.
 * @param stateDirName - the configured local-state directory name.
 * @returns the lock, or null when there is none.
 */
export async function readLock(root: string, stateDirName = '.dsh'): Promise<LockInfo | null> {
  try {
    const raw = await readFile(lockFilePath(root, stateDirName), 'utf8')
    const parsed = JSON.parse(raw) as Partial<LockInfo>
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      operation: typeof parsed.operation === 'string' ? parsed.operation : 'unknown',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : new Date(0).toISOString(),
    }
  } catch {
    return null
  }
}

async function acquire(file: string, operation: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx')
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, operation, startedAt: new Date().toISOString() }, null, 2)}\n`,
          'utf8',
        )
      } finally {
        await handle.close()
      }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new EngineeringContextError('lock_held', `The workspace lock ${file} could not be created.`, {
          file,
          cause: error instanceof Error ? error.message : String(error),
        })
      }

      let ageMs = 0
      try {
        const info = await stat(file)
        ageMs = Date.now() - info.mtimeMs
      } catch {
        continue
      }
      if (ageMs < LOCK_TTL_MS) {
        const held = await readLockFile(file)
        throw new EngineeringContextError(
          'lock_held',
          `${file} is held by another operation${held === null ? '' : ` (${held.operation}, pid ${held.pid})`}. Wait for it to finish, or remove the file if the process is gone.`,
          { file, lock: held, ageMs },
        )
      }
      await unlink(file).catch(() => undefined)
    }
  }
  throw new EngineeringContextError('lock_held', `The workspace lock ${file} could not be acquired.`, { file })
}

async function readLockFile(file: string): Promise<LockInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<LockInfo>
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      operation: typeof parsed.operation === 'string' ? parsed.operation : 'unknown',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : new Date(0).toISOString(),
    }
  } catch {
    return null
  }
}

/**
 * Run one operation under the workspace lock.
 *
 * @param root - the workspace root.
 * @param operation - a short label written into the lock file.
 * @param body - what to run while the lock is held.
 * @param stateDirName - the configured local-state directory name.
 * @returns whatever the body returns.
 */
export async function withLock<T>(
  root: string,
  operation: string,
  body: () => Promise<T>,
  stateDirName = '.dsh',
): Promise<T> {
  const file = lockFilePath(root, stateDirName)
  await mkdir(join(root, stateDirName, 'local'), { recursive: true })
  await acquire(file, operation)
  try {
    return await body()
  } finally {
    await unlink(file).catch(() => undefined)
  }
}